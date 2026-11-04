import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, fstatSync, fsyncSync, lstatSync, openSync,
  readSync, realpathSync, statSync, unlinkSync, writeSync
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditorSessions } from './editor-state.mjs';
import { inspectPng } from './png-integrity.mjs';
import { withCurrentRenderer } from './renderer-authority.mjs';

// M1-G2-PR5 CODE ONLY: intentionally NOT imported by server/index.mjs or
// ui/studio.html. Never call against a real session store before owner-approved
// integration/activation and additional browser/PNG acceptance.
const hashPattern = /^[a-f0-9]{64}$/;
const maxExportBytes = 256 * 1024 * 1024;
const workerFlag = '--pr5-output-worker';

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sameIdentity(stat, identity) {
  return stat.isDirectory() && stat.ino !== 0n &&
    stat.dev === BigInt(identity.dev) && stat.ino === BigInt(identity.ino);
}

function identityOf(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function samePathDirectory(path, identity) {
  try { return sameIdentity(statSync(path, { bigint: true }), identity); }
  catch { return false; }
}

function requireCanonicalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) ||
      realpathSync(path) !== resolve(path))
    refuse('invalid_export_directory', 'An existing canonical absolute output directory is required.');
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    refuse('invalid_export_directory', 'Output directory must be a non-symlink directory.');
  if (stat.ino === 0n)
    refuse('invalid_export_directory', 'Output directory identity is unavailable.');
  return { path, identity: identityOf(stat) };
}

function writeAll(fd, bytes, offset = 0, length = bytes.length - offset) {
  let written = 0;
  while (written < length) {
    const count = writeSync(fd, bytes, offset + written, length - written);
    if (!count)
      throw Object.assign(new Error('Output write made no progress.'), { code: 'EIO' });
    written += count;
  }
}

async function readPngToFile(fd, length, workerInput) {
  const digest = createHash('sha256');
  let total = 0;
  while (total < length) {
    const { value: chunk, done } = await workerInput.next();
    if (done || total + chunk.length > length)
      throw Object.assign(new Error('PNG input ended or exceeded its declared length.'), { code: 'invalid_worker_input' });
    digest.update(chunk);
    writeAll(fd, chunk);
    total += chunk.length;
  }
  return digest.digest('hex');
}

function descriptorHash(fd, length) {
  if (fstatSync(fd, { bigint: true }).size !== BigInt(length))
    return null;
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, length - offset), offset);
    if (!count)
      return null;
    digest.update(buffer.subarray(0, count));
    offset += count;
  }
  return digest.digest('hex');
}

function removeOwnedFile(path, fd) {
  if (fd === null)
    return;
  const current = lstatSync(path, { bigint: true });
  const owned = fstatSync(fd, { bigint: true });
  if (current.isFile() && current.dev === owned.dev && current.ino === owned.ino)
    unlinkSync(path);
}

function closeQuietly(fd) {
  if (fd !== null)
    try { closeSync(fd); } catch {}
}

function workerResponse(value) {
  writeSync(1, Buffer.from(JSON.stringify(value) + '\n'));
}

async function runOutputWorker(request, workerInput) {
  let imageFd = null, proofFd = null;
  let imageName = null, proofName = null;
  try {
    const identity = request.directoryIdentity;
    const held = fstatSync(3, { bigint: true });
    if (!sameIdentity(held, identity) || !sameIdentity(statSync('.', { bigint: true }), identity) ||
        !samePathDirectory(request.directory, identity))
      return { ok: false, code: 'export_directory_changed' };
    writeSync(1, Buffer.from('READY\n'));

    if (request.operation === 'cleanup') {
      for (const file of request.files) {
        const current = lstatSync(file.name, { bigint: true });
        if (current.isFile() && current.dev === BigInt(file.identity.dev) &&
            current.ino === BigInt(file.identity.ino))
          unlinkSync(file.name);
      }
      return { ok: true };
    }

    if (request.operation !== 'write' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(request.safeName) ||
        !Number.isSafeInteger(request.width) || !Number.isSafeInteger(request.height) ||
        !Number.isSafeInteger(request.bytes) || request.bytes < 57 || request.bytes > maxExportBytes ||
        !hashPattern.test(request.pngSha256) || !hashPattern.test(request.pixelSha256))
      return { ok: false, code: 'invalid_worker_request' };

    for (let suffix = 0; suffix < 10000; suffix++) {
      const fileName = request.safeName + '-portrait-studio' + (suffix ? ' (' + suffix + ')' : '') + '.png';
      imageName = fileName;
      proofName = fileName + '.provenance.json';
      try { imageFd = openSync(imageName, 'wx+', 0o600); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      try { proofFd = openSync(proofName, 'wx+', 0o600); }
      catch (error) {
        removeOwnedFile(imageName, imageFd);
        closeQuietly(imageFd);
        imageFd = null;
        if (error.code === 'EEXIST') continue;
        throw error;
      }

      const inputHash = await readPngToFile(imageFd, request.bytes, workerInput);
      if (inputHash !== request.pngSha256)
        throw Object.assign(new Error('PNG input hash changed in transit.'), { code: 'export_png_hash_mismatch' });
      fsyncSync(imageFd);
      if (descriptorHash(imageFd, request.bytes) !== request.pngSha256)
        throw Object.assign(new Error('PNG output readback did not match.'), { code: 'export_readback_mismatch' });
      const provenance = Object.freeze({
        ...request.provenance, fileName, width: request.width, height: request.height,
        bytes: request.bytes, pngSha256: request.pngSha256, pixelSha256: request.pixelSha256
      });
      const recordBytes = Buffer.from(JSON.stringify(provenance) + '\n');
      writeAll(proofFd, recordBytes);
      fsyncSync(proofFd);
      const provenanceSha256 = descriptorHash(proofFd, recordBytes.length);
      if (provenanceSha256 !== createHash('sha256').update(recordBytes).digest('hex'))
        throw Object.assign(new Error('Provenance output readback did not match.'), { code: 'export_readback_mismatch' });

      if (request.pauseBeforeCommit) {
        writeSync(1, Buffer.from('FILES_READY\n'));
        const commit = Buffer.alloc(1);
        const { value: marker, done } = await workerInput.next();
        if (done || !marker?.length || marker[0] !== 1)
          throw Object.assign(new Error('Export commit acknowledgement is missing.'), { code: 'invalid_worker_input' });
      }
      if (!samePathDirectory(request.directory, identity))
        throw Object.assign(new Error('Output directory changed during export.'), { code: 'export_directory_changed' });
      const imageIdentity = identityOf(fstatSync(imageFd, { bigint: true }));
      const proofIdentity = identityOf(fstatSync(proofFd, { bigint: true }));
      if (!sameFileIdentity(lstatSync(imageName, { bigint: true }), imageIdentity) ||
          !sameFileIdentity(lstatSync(proofName, { bigint: true }), proofIdentity))
        throw Object.assign(new Error('Output entry changed during export.'), { code: 'export_output_changed' });
      return { ok: true, fileName, provenance, provenanceSha256, imageIdentity, proofIdentity };
    }
    return { ok: false, code: 'export_name_exhausted' };
  } catch (error) {
    try { removeOwnedFile(proofName, proofFd); } catch {}
    try { removeOwnedFile(imageName, imageFd); } catch {}
    return { ok: false, code: error.code || 'export_output_failed' };
  } finally {
    closeQuietly(proofFd);
    closeQuietly(imageFd);
  }
}

function sameFileIdentity(stat, identity) {
  return stat.isFile() && stat.ino !== 0n &&
    stat.dev === BigInt(identity.dev) && stat.ino === BigInt(identity.ino);
}

function runWorker(directory, directoryIdentity, directoryFd, request, input = Buffer.alloc(0)) {
  if (!sameIdentity(fstatSync(directoryFd, { bigint: true }), directoryIdentity) ||
      !samePathDirectory(directory, directoryIdentity))
    refuse('export_directory_changed', 'The output directory changed before export.');
  const child = spawnSync(process.execPath, [
    fileURLToPath(import.meta.url), workerFlag,
    Buffer.from(JSON.stringify({ ...request, directory, directoryIdentity })).toString('base64')
  ], {
    cwd: directory, input, encoding: 'utf8', maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe', directoryFd],
    env: process.platform === 'win32'
      ? Object.fromEntries(['SystemRoot', 'WINDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
      : {},
    windowsHide: true
  });
  if (child.error || child.status !== 0)
    refuse('export_output_failed', 'The output worker did not complete.');
  let result;
  try { result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)); }
  catch { refuse('export_output_failed', 'The output worker returned an invalid result.'); }
  if (!result.ok)
    refuse(result.code || 'export_output_failed', 'The output worker refused the export.');
  return result;
}

if (process.argv[2] === workerFlag) {
  const workerInput = process.stdin[Symbol.asyncIterator]();
  try {
    const request = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
    if (request.pauseBeforeCommit !== undefined && typeof request.pauseBeforeCommit !== 'boolean') {
      workerResponse({ ok: false, code: 'invalid_worker_request' });
      process.stdin.destroy();
    } else {
      runOutputWorker(request, workerInput).then(workerResponse, error =>
        workerResponse({ ok: false, code: error.code || 'invalid_worker_request' })).finally(() => process.stdin.destroy());
    }
  } catch (error) {
    workerResponse({ ok: false, code: error.code || 'invalid_worker_request' });
    process.stdin.destroy();
  }
}

function validateInput(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => ![
        'sessions', 'storePath', 'token', 'pngBytes', 'width', 'height',
        'expectedPreviewSha256', 'outputDirectory',
        'baseName'
      ].includes(key)))
    refuse('invalid_export_request', 'Unknown or missing PR5 export request fields.');
  const { sessions, storePath, token, pngBytes, width, height,
    expectedPreviewSha256, outputDirectory, baseName } = options;
  if (!(sessions instanceof EditorSessions) ||
      typeof storePath !== 'string' || !isAbsolute(storePath) ||
      resolve(storePath) !== resolve(sessions.filePath) ||
      basename(storePath) !== 'sessions.json' ||
      !Buffer.isBuffer(pngBytes) || pngBytes.length < 57 ||
      pngBytes.length > maxExportBytes ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width * height > 80_000_000 ||
      typeof expectedPreviewSha256 !== 'string' || !hashPattern.test(expectedPreviewSha256) ||
      typeof baseName !== 'string' || !baseName.length || baseName.length > 200)
    refuse('invalid_export_request', 'Invalid session, size, renderer or SHA-256 binding.');
  const directory = requireCanonicalDirectory(outputDirectory);
  const safeName = baseName.normalize('NFKC').replace(/\.(?:png|jpe?g)$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'portrait';
  if (typeof token !== 'object' || !token)
    refuse('invalid_export_request', 'Missing renderer token.');
  return { directory, safeName };
}

export function exportSessionBoundPng(options) {
  const { directory: output, safeName } = validateInput(options);
  const { sessions, storePath, token, width, height,
    expectedPreviewSha256 } = options;

  // Copy the caller-provided PNG so asynchronous UI mutations after this call
  // cannot change bytes that were verified but not yet persisted.
  const bytes = Buffer.from(options.pngBytes);
  const preflight = inspectPng(bytes, width, height);
  if (createHash('sha256').update(bytes).digest('hex') !== preflight.sha256)
    refuse('export_png_hash_mismatch', 'The PNG bytes changed during validation.');

  // Same lock ordering everywhere in this inactive transaction:
  // sessions.json.lock FIRST, renderer-epoch.lock SECOND. A new renderer mount
  // is refused while this transaction holds the renderer lock; a new edit is
  // blocked by the session lock through verification + status publication.
  return sessions.withStoreLock(() => withCurrentRenderer({ storePath, token }, current => {
    const state = sessions.getState(current.sessionId);
    if (state.status !== 'ok' || state.revision !== current.revision ||
        state.source?.sha256 !== current.sourceSha256 ||
        state.preview?.status !== 'confirmed' ||
        state.preview.revision !== current.revision ||
        state.preview.rendererId !== current.rendererId ||
        state.preview.sha256 !== expectedPreviewSha256 ||
        sessions.getConfirmedPreviewPixelSha256(current.sessionId) !== preflight.pixelSha256 ||
        state.preview.confirmedBy?.sourceBuildHash !== current.sourceBuildHash)
      refuse('export_provenance_conflict',
        'Preview, source, revision, renderer or source build is stale or unconfirmed.');
    sessions.prepareExport(current.sessionId, current.revision, current.rendererId, width, height);

    const provenance = Object.freeze({
      schemaVersion: 1,
      sessionId: current.sessionId,
      revision: current.revision,
      sourceSha256: current.sourceSha256,
      rendererId: current.rendererId,
      rendererEpoch: current.epoch,
      pipelineId: current.pipelineId,
      sourceBuildHash: current.sourceBuildHash,
      previewSha256: expectedPreviewSha256,
      width, height, bytes: bytes.length,
      pngSha256: preflight.sha256,
      pixelSha256: preflight.pixelSha256
    });
    const directoryFd = openSync(output.path, 'r');
    let written;
    try {
      if (!sameIdentity(fstatSync(directoryFd, { bigint: true }), output.identity) ||
          !samePathDirectory(output.path, output.identity))
        refuse('export_directory_changed', 'The output directory changed before export.');
      written = runWorker(output.path, output.identity, directoryFd, {
        operation: 'write', safeName, width, height, bytes: bytes.length,
        pngSha256: preflight.sha256, pixelSha256: preflight.pixelSha256,
        provenance
      }, bytes);
      const fileName = written.fileName;
      const outputPath = join(output.path, fileName);
      const provenancePath = outputPath + '.provenance.json';
      // This is the original V1-compatible export record. No new fields are
      // written into the PRIVATE-compatible V1 sessions.json schema.
      sessions.recordExport(current.sessionId, current.revision, current.rendererId, {
        path: outputPath, fileName, width, height, bytes: bytes.length,
        sha256: preflight.sha256, pixelSha256: preflight.pixelSha256
      });
      return Object.freeze({
        saved: true, sessionId: current.sessionId, revision: current.revision,
        path: outputPath, provenancePath, fileName, width, height, bytes: bytes.length,
        sha256: preflight.sha256, pixelSha256: preflight.pixelSha256,
        provenance: written.provenance, provenanceSha256: written.provenanceSha256
      });
    } catch (error) {
      if (written?.ok)
        try { runWorker(output.path, output.identity, directoryFd, {
          operation: 'cleanup', files: [
            { name: written.fileName, identity: written.imageIdentity },
            { name: written.fileName + '.provenance.json', identity: written.proofIdentity }
          ]
        }); } catch {}
      throw error;
    } finally {
      closeSync(directoryFd);
    }
  }));
}
