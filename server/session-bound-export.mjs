import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { EditorSessions } from './editor-state.mjs';
import { inspectPng } from './png-integrity.mjs';
import { withCurrentRenderer } from './renderer-authority.mjs';

// M1-G2-PR5 CODE ONLY: intentionally NOT imported by server/index.mjs or
// ui/studio.html. Never call against a real session store before owner-approved
// integration/activation and additional browser/PNG acceptance.
const hashPattern = /^[a-f0-9]{64}$/;
const maxExportBytes = 256 * 1024 * 1024;

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requireCanonicalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) ||
      realpathSync(path) !== resolve(path))
    refuse('invalid_export_directory', 'An existing canonical absolute output directory is required.');
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    refuse('invalid_export_directory', 'Output directory must be a non-symlink directory.');
  return path;
}

function newFile(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  let complete = false;
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete)
      unlinkSync(path);
  }
}

function failClosedPngValidation(bytes, expectedWidth, expectedHeight, expectedPixelSha256) {
  const actual = inspectPng(bytes, expectedWidth, expectedHeight);
  if (actual.pixelSha256 !== expectedPixelSha256)
    refuse('export_pixels_mismatch', 'Decoded PNG pixels do not match the renderer output hash.');
  return actual;
}

function validateInput(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => ![
        'sessions', 'storePath', 'token', 'pngBytes', 'width', 'height',
        'expectedPixelSha256', 'expectedPreviewSha256', 'outputDirectory',
        'baseName'
      ].includes(key)))
    refuse('invalid_export_request', 'Unknown or missing PR5 export request fields.');
  const { sessions, storePath, token, pngBytes, width, height,
    expectedPixelSha256, expectedPreviewSha256, outputDirectory, baseName } = options;
  if (!(sessions instanceof EditorSessions) ||
      typeof storePath !== 'string' || !isAbsolute(storePath) ||
      resolve(storePath) !== resolve(sessions.filePath) ||
      basename(storePath) !== 'sessions.json' ||
      !Buffer.isBuffer(pngBytes) || pngBytes.length < 57 ||
      pngBytes.length > maxExportBytes ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width * height > 80_000_000 ||
      typeof expectedPixelSha256 !== 'string' || !hashPattern.test(expectedPixelSha256) ||
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
  const { directory, safeName } = validateInput(options);
  const { sessions, storePath, token, width, height,
    expectedPreviewSha256, expectedPixelSha256 } = options;

  // Copy the caller-provided PNG so asynchronous UI mutations after this call
  // cannot change bytes that were verified but not yet persisted.
  const bytes = Buffer.from(options.pngBytes);
  const preflight = failClosedPngValidation(bytes, width, height, expectedPixelSha256);
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
        state.preview.confirmedBy?.sourceBuildHash !== current.sourceBuildHash)
      refuse('export_provenance_conflict',
        'Preview, source, revision, renderer or source build is stale or unconfirmed.');
    sessions.prepareExport(current.sessionId, current.revision, current.rendererId, width, height);

    let outputPath, provenancePath, fileName;
    for (let suffix = 0; suffix < 10000; suffix++) {
      const name = safeName + '-portrait-studio' + (suffix ? ' (' + suffix + ')' : '') + '.png';
      const candidate = join(directory, name);
      if (!existsSync(candidate) && !existsSync(candidate + '.provenance.json')) {
        outputPath = candidate;
        provenancePath = candidate + '.provenance.json';
        fileName = name;
        break;
      }
    }
    if (!outputPath)
      refuse('export_name_exhausted', 'No non-overwriting filename is available.');

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
      fileName, width, height, bytes: bytes.length,
      pngSha256: preflight.sha256,
      pixelSha256: preflight.pixelSha256
    });
    const recordBytes = Buffer.from(JSON.stringify(provenance) + '\n');
    let imageCreated = false, proofCreated = false;
    try {
      newFile(outputPath, bytes);
      imageCreated = true;
      newFile(provenancePath, recordBytes);
      proofCreated = true;
      const written = readFileSync(outputPath);
      if (!written.equals(bytes) ||
          !readFileSync(provenancePath).equals(recordBytes))
        refuse('export_readback_mismatch', 'PNG or provenance readback did not match source bytes.');
      const readback = failClosedPngValidation(written, width, height, expectedPixelSha256);
      if (readback.sha256 !== preflight.sha256 || written.length !== bytes.length)
        refuse('export_png_hash_mismatch', 'PNG readback failed byte integrity.');
      // This is the original V1-compatible export record. No new fields are
      // written into the PRIVATE-compatible V1 sessions.json schema.
      sessions.recordExport(current.sessionId, current.revision, current.rendererId, {
        path: outputPath, fileName, width, height, bytes: bytes.length,
        sha256: preflight.sha256, pixelSha256: preflight.pixelSha256
      });
    } catch (error) {
      // Only remove files we created exclusively in this invocation. No
      // preexisting file, source image or original session is overwritten.
      if (proofCreated)
        unlinkSync(provenancePath);
      if (imageCreated)
        unlinkSync(outputPath);
      throw error;
    }
    return Object.freeze({
      saved: true, sessionId: current.sessionId, revision: current.revision,
      path: outputPath, provenancePath,
      fileName, width, height, bytes: bytes.length,
      sha256: preflight.sha256, pixelSha256: preflight.pixelSha256,
      provenance, provenanceSha256: createHash('sha256').update(recordBytes).digest('hex')
    });
  }));
}
