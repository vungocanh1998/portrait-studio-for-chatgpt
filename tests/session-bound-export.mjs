import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { EditorSessions } from '../server/editor-state.mjs';
import { readV1Store } from '../server/edit-document.mjs';
import { inspectPng } from '../server/png-integrity.mjs';
import { exportSessionBoundPng } from '../server/session-bound-export.mjs';
import {
  registerRenderer, isCurrentRenderer, withCurrentRenderer
} from '../server/renderer-authority.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'portrait-studio-pr5-synthetic-'));
const dataRoot = join(scratch, 'data');
const outputDirectory = join(scratch, 'output');
const hostileRoot = join(scratch, 'hostile-parent');
const hostileSentinel = join(hostileRoot, 'sentinel.txt');
const sentinelBytes = Buffer.from('Synthetic hostile parent directory — do not touch');
const sessionStorePath = join(dataRoot, 'sessions.json');
const sourceBytes = Buffer.from('Synthetic image source identifier; original pixels stay outside the store');
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
const sourceBuildHash = 'b'.repeat(64);
const previewSha256 = 'c'.repeat(64);
const pipelineId = 'm1-pr5-synthetic-png';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const table = Uint32Array.from({ length: 256 }, (_, v) => {
  let c = v;
  for (let k = 0; k < 8; k++)
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes)
    c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, payload) {
  const kind = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([kind, payload])));
  return Buffer.concat([length, kind, payload, crc]);
}
function pngFixture(width, height, rgba) {
  const stride = width * 4;
  assert.equal(rgba.length, stride * height);
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++)
    rgba.copy(rows, (stride + 1) * y + 1, stride * y, stride * (y + 1));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
function expectCode(fn, code) {
  assert.throws(fn, e => e?.code === code, 'Expected fail-closed code ' + code);
}
function assertEmpty(directory) {
  assert.deepEqual(readdirSync(directory), [], 'rejection must not create PNG or sidecar files');
}
function childRegister(storePath, inputs, expected = 'success') {
  const home = join(scratch, 'child-home');
  mkdirSync(home, { recursive: true });
  const moduleUrl = pathToFileURL(join(root, 'server/renderer-authority.mjs')).href;
  const program = [
    'import { registerRenderer } from ' + JSON.stringify(moduleUrl) + ';',
    'try { const token = registerRenderer(' + JSON.stringify({ storePath, ...inputs }) + ');',
    '  console.log(JSON.stringify({ status: "success", token }));',
    '} catch (error) { console.log(JSON.stringify({ status: error.code || "error" })); }'
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
    env: {
      ...process.env, PORTRAIT_STUDIO_DATA_DIR: hostileRoot,
      HOME: home, USERPROFILE: home,
      LOCALAPPDATA: join(home, 'Local'), APPDATA: join(home, 'Roaming')
    }
  });
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout.trim());
  assert.equal(value.status, expected);
  return value.token;
}

function startOutputWorker(directory, directoryFd, header) {
  const child = spawn(process.execPath, [
    join(root, 'server/session-bound-export.mjs'), '--pr5-output-worker',
    Buffer.from(JSON.stringify(header)).toString('base64')
  ], {
    cwd: directory,
    stdio: ['pipe', 'pipe', 'pipe', directoryFd],
    env: process.platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
      : {},
    windowsHide: true
  });
  let stdout = '', stderr = '', announceReady, announceFilesReady;
  const ready = new Promise(resolve => { announceReady = resolve; });
  const filesReady = new Promise(resolve => { announceFilesReady = resolve; });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8');
    if (stdout.includes('READY\n'))
      announceReady();
    if (stdout.includes('FILES_READY\n'))
      announceFilesReady();
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.stdin.on('error', () => {});
  return { child, ready, filesReady, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitForOutputWorker(worker, signal = 'ready') {
  let timer;
  try {
    await Promise.race([
      worker[signal],
      worker.closed.then(code => { throw new Error('Output worker exited before ' + signal + ': ' + code + ' ' + worker.stderr + ' ' + worker.stdout); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Output worker timed out before ' + signal + ': ' + worker.stderr + ' ' + worker.stdout)), 5000); })
    ]);
  } catch (error) {
    worker.child.kill();
    await worker.closed;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function outputWorkerResult(worker) {
  return JSON.parse(worker.stdout.trim().split(/\r?\n/).at(-1));
}

function runtimeConfirmation(rendererId) {
  return {
    serverVersion: '0.2.8', sourceBuildHash, pid: process.pid,
    instanceId: rendererId, executablePath: process.execPath,
    scriptPath: fileURLToPath(import.meta.url), pluginRoot: root,
    sessionStorePath, confirmedAt: new Date().toISOString()
  };
}

try {
  mkdirSync(dataRoot);
  mkdirSync(outputDirectory);
  mkdirSync(hostileRoot);
  writeFileSync(hostileSentinel, sentinelBytes, { flag: 'wx' });
  // No sample source pixels are written to disk, only a synthetic source hash.
  const rgba = Buffer.from(Array.from({ length: 12 }, (_, i) => [
    (i * 19 + 12) % 256, (i * 23 + 41) % 256, (i * 11 + 93) % 256,
    i % 3 ? 255 : 96
  ]).flat());
  const nativePng = pngFixture(4, 3, rgba);
  const pixelSha256 = sha(rgba);
  const baselinePngSha = sha(nativePng);
  const proof = inspectPng(nativePng, 4, 3);
  assert.equal(proof.pixelSha256, pixelSha256);
  assert.equal(proof.sha256, baselinePngSha);
  assert.equal(proof.bytes, nativePng.length);
  assert.throws(() => inspectPng(nativePng, 3, 4), /Invalid PR5 PNG/);
  const corrupt = Buffer.from(nativePng);
  corrupt[42] ^= 1;
  assert.throws(() => inspectPng(corrupt, 4, 3), /CRC mismatch/);
  assert.throws(() => inspectPng(nativePng.subarray(0, -1), 4, 3), /Invalid PR5 PNG/);
  assert.equal(sha(nativePng), baselinePngSha, 'PNG input bytes must remain untouched');

  const swapParent = join(scratch, 'directory-swap');
  const preSpawnDirectory = join(swapParent, 'pre-spawn');
  const preSpawnMoved = join(swapParent, 'pre-spawn-moved');
  const replacementDirectory = join(swapParent, 'replacement');
  const replacementSentinel = join(replacementDirectory, 'sentinel.txt');
  mkdirSync(swapParent);
  mkdirSync(preSpawnDirectory);
  mkdirSync(replacementDirectory);
  writeFileSync(replacementSentinel, sentinelBytes, { flag: 'wx' });
  const preSpawnFd = openSync(preSpawnDirectory, 'r');
  const preSpawnIdentity = fstatSync(preSpawnFd, { bigint: true });
  const preSpawnHeader = {
    directory: preSpawnDirectory,
    directoryIdentity: { dev: String(preSpawnIdentity.dev), ino: String(preSpawnIdentity.ino) },
    safeName: 'pre-spawn-swap', width: 4, height: 3,
    bytes: nativePng.length, pngSha256: baselinePngSha, pixelSha256,
    provenance: { schemaVersion: 1, sessionId: 'synthetic-session', revision: 1 }
  };
  renameSync(preSpawnDirectory, preSpawnMoved);
  if (process.platform === 'win32')
    mkdirSync(preSpawnDirectory);
  else
    symlinkSync(replacementDirectory, preSpawnDirectory, 'dir');
  const preSpawnWorker = startOutputWorker(preSpawnDirectory, preSpawnFd, preSpawnHeader);
  preSpawnWorker.child.stdin.end();
  const preSpawnCode = await preSpawnWorker.closed;
  assert.equal(preSpawnCode, 0, preSpawnWorker.stderr);
  assert.deepEqual(outputWorkerResult(preSpawnWorker), { ok: false, code: 'export_directory_changed' });
  assertEmpty(preSpawnMoved);
  assert.deepEqual(readdirSync(replacementDirectory), ['sentinel.txt']);
  assert.deepEqual(readFileSync(replacementSentinel), sentinelBytes);
  closeSync(preSpawnFd);

  const liveDirectory = join(swapParent, 'during-worker');
  const liveMoved = join(swapParent, 'during-worker-moved');
  mkdirSync(liveDirectory);
  const liveFd = openSync(liveDirectory, 'r');
  const liveIdentity = fstatSync(liveFd, { bigint: true });
  const liveWorker = startOutputWorker(liveDirectory, liveFd, {
    ...preSpawnHeader,
    directory: liveDirectory,
    directoryIdentity: { dev: String(liveIdentity.dev), ino: String(liveIdentity.ino) },
    operation: 'write', safeName: 'during-worker-swap', pauseBeforeCommit: true
  });
  liveWorker.child.stdin.write(nativePng);
  await waitForOutputWorker(liveWorker, 'filesReady');
  if (process.platform === 'win32') {
    assert.throws(() => renameSync(liveDirectory, liveMoved), error =>
      ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code));
    liveWorker.child.stdin.end(Buffer.from([1]));
    assert.equal(await liveWorker.closed, 0, liveWorker.stderr);
    const liveResult = outputWorkerResult(liveWorker);
    assert.equal(liveResult.ok, true);
    assert.deepEqual(readFileSync(join(liveDirectory, liveResult.fileName)), nativePng);
    assert.deepEqual(readdirSync(replacementDirectory), ['sentinel.txt']);
  } else {
    renameSync(liveDirectory, liveMoved);
    symlinkSync(replacementDirectory, liveDirectory, 'dir');
    liveWorker.child.stdin.end(Buffer.from([1]));
    assert.equal(await liveWorker.closed, 0, liveWorker.stderr);
    assert.deepEqual(outputWorkerResult(liveWorker), { ok: false, code: 'export_directory_changed' });
    assertEmpty(liveMoved);
    assert.deepEqual(readdirSync(replacementDirectory), ['sentinel.txt']);
    assert.deepEqual(readFileSync(replacementSentinel), sentinelBytes);
  }
  closeSync(liveFd);

  const sessions = new EditorSessions({ filePath: sessionStorePath });
  const opened = sessions.withStoreLock(() => sessions.create());
  const bound = sessions.withStoreLock(() => sessions.bindSource(opened.sessionId, 0, {
    fileName: 'synthetic-source.png', mimeType: 'image/png',
    width: 4, height: 3, byteSize: sourceBytes.length, sha256: sourceSha256
  }));
  assert.equal(bound.revision, 1);
  const rendererIdentity = {
    sessionId: opened.sessionId, sourceSha256, revision: 1,
    pipelineId, sourceBuildHash
  };
  let token = registerRenderer({ storePath: sessionStorePath, ...rendererIdentity });
  sessions.withStoreLock(() => sessions.confirmPreview(
    opened.sessionId, 1, token.rendererId, sourceSha256, 4, 3, previewSha256,
    { ...runtimeConfirmation(token.rendererId), nativePixelSha256: pixelSha256 }
  ));
  const persistedConfirmation = JSON.parse(readFileSync(sessionStorePath, 'utf8'))
    .sessions.find(session => session.sessionId === opened.sessionId).preview.confirmedBy;
  assert.equal(Object.hasOwn(persistedConfirmation, 'nativePixelSha256'), false);
  assert.doesNotThrow(() => readV1Store(readFileSync(sessionStorePath)));
  const request = () => ({
    sessions, storePath: sessionStorePath, token,
    pngBytes: nativePng, width: 4, height: 3,
    expectedPreviewSha256: previewSha256,
    outputDirectory, baseName: 'synthetic-portrait.png'
  });

  const unrelatedRgba = Buffer.from(rgba);
  unrelatedRgba[0] ^= 1;
  const unrelatedPng = pngFixture(4, 3, unrelatedRgba);
  expectCode(() => exportSessionBoundPng({
    ...request(), pngBytes: unrelatedPng
  }), 'export_provenance_conflict');
  expectCode(() => exportSessionBoundPng({
    ...request(), expectedPreviewSha256: 'a'.repeat(64)
  }), 'export_provenance_conflict');
  assert.throws(() => exportSessionBoundPng({
    ...request(), width: 3, height: 4
  }), /Invalid PR5 PNG/); // decode reject before touching the store
  // Every field of the cross-process renderer identity is checked before
  // writing output, not just the session and revision.
  for (const [field, wrong] of [
    ['sessionId', '11111111-1111-4111-8111-111111111111'],
    ['sourceSha256', 'f'.repeat(64)],
    ['revision', 2],
    ['rendererId', '11111111-1111-4111-8111-111111111111'],
    ['pipelineId', 'other-pipeline'],
    ['sourceBuildHash', 'f'.repeat(64)],
    ['epoch', token.epoch + 1]
  ]) {
    expectCode(() => exportSessionBoundPng({
      ...request(), token: { ...token, [field]: wrong }
    }), 'stale_renderer');
  }
  assert.throws(() => exportSessionBoundPng({
    ...request(), pngBytes: corrupt
  }), /Invalid PR5 PNG/);
  assertEmpty(outputDirectory);

  // Hold the shared renderer lock while a second process attempts a remount:
  // a new renderer must not supersede a prepared/committing PNG mid-export.
  sessions.withStoreLock(() => withCurrentRenderer({
    storePath: sessionStorePath, token
  }, () => {
    assert.equal(childRegister(sessionStorePath, rendererIdentity, 'renderer_authority_busy'), undefined);
    // The epoch lock remains held through the synchronous callback.
  }));
  assert.equal(isCurrentRenderer({ storePath: sessionStorePath, token }), true);

  const first = exportSessionBoundPng(request());
  assert.equal(first.saved, true);
  assert.equal(first.revision, 1);
  assert.equal(first.sessionId, opened.sessionId);
  assert.equal(first.width, 4);
  assert.equal(first.height, 3);
  assert.equal(first.sha256, baselinePngSha);
  assert.equal(first.pixelSha256, pixelSha256);
  assert.equal(first.provenance.sourceSha256, sourceSha256);
  assert.equal(first.provenance.sourceBuildHash, sourceBuildHash);
  assert.equal(first.provenance.rendererEpoch, 1);
  assert.equal(first.provenance.previewSha256, previewSha256);
  assert.equal(first.provenance.pipelineId, pipelineId);
  assert.deepEqual(readFileSync(first.path), nativePng);
  const sidecar = readFileSync(first.provenancePath);
  assert.equal(sha(sidecar), first.provenanceSha256);
  assert.deepEqual(JSON.parse(sidecar.toString('utf8')), first.provenance);
  const stateAfterSave = sessions.withStoreLock(() => sessions.getState(opened.sessionId));
  assert.equal(stateAfterSave.export.status, 'saved');
  assert.equal(stateAfterSave.export.pixelSha256, pixelSha256);
  assert.equal(stateAfterSave.export.path, first.path);
  assert.equal(JSON.parse(readFileSync(sessionStorePath, 'utf8')).version, 1,
    'V1 session-store schema must remain unchanged');

  const second = exportSessionBoundPng(request());
  assert.notEqual(second.path, first.path, 'never overwrite the first export');
  assert.deepEqual(readFileSync(first.path), nativePng);
  assert.deepEqual(readFileSync(first.provenancePath), sidecar);
  assert.deepEqual(readFileSync(second.path), nativePng);

  // A new mount in a DIFFERENT process invalidates the old renderer token.
  const successor = childRegister(sessionStorePath, rendererIdentity);
  assert.equal(successor.epoch, token.epoch + 1);
  expectCode(() => exportSessionBoundPng(request()), 'stale_renderer');
  token = successor;
  expectCode(() => exportSessionBoundPng(request()), 'export_provenance_conflict');
  sessions.withStoreLock(() => sessions.confirmPreview(
    opened.sessionId, 1, token.rendererId, sourceSha256, 4, 3, previewSha256,
    { ...runtimeConfirmation(token.rendererId), nativePixelSha256: pixelSha256 }
  ));
  const third = exportSessionBoundPng(request());
  assert.equal(third.provenance.rendererEpoch, 2);
  assert.equal(third.provenance.rendererId, token.rendererId);
  const beforeEditFiles = readdirSync(outputDirectory).sort();
  const edited = sessions.withStoreLock(() =>
    sessions.setColorAdjustments(opened.sessionId, 1, { exposureEV: 0.3 }));
  assert.equal(edited.revision, 2);
  expectCode(() => exportSessionBoundPng(request()), 'export_provenance_conflict');
  assert.deepEqual(readdirSync(outputDirectory).sort(), beforeEditFiles,
    'stale revision cannot create new output or provenance files');
  assert.equal(sessions.withStoreLock(() => sessions.getState(opened.sessionId)).export.status, 'stale');

  // Crop/native-size output is exactly 2×2, never a resized 4×3 export.
  const cropped = sessions.withStoreLock(() => sessions.setCrop(
    opened.sessionId, 2, { x: 25, y: 0, width: 50, height: 66.6667, aspectRatio: 'free' }
  ));
  assert.equal(cropped.revision, 3);
  token = registerRenderer({
    storePath: sessionStorePath, ...rendererIdentity, revision: 3
  });
  const cropPreview = 'd'.repeat(64);
  const cropRgba = Buffer.concat([rgba.subarray(4, 12), rgba.subarray(20, 28)]);
  sessions.withStoreLock(() => sessions.confirmPreview(
    opened.sessionId, 3, token.rendererId, sourceSha256, 2, 2, cropPreview,
    { ...runtimeConfirmation(token.rendererId), nativePixelSha256: sha(cropRgba) }
  ));
  const cropPng = pngFixture(2, 2, cropRgba);
  const native = exportSessionBoundPng({
    ...request(), pngBytes: cropPng, width: 2, height: 2,
    expectedPreviewSha256: cropPreview
  });
  assert.equal(native.width, 2);
  assert.equal(native.height, 2);
  assert.equal(native.pixelSha256, sha(cropRgba));
  assert.deepEqual(readFileSync(native.path), cropPng);
  assert.equal(sessions.withStoreLock(() => sessions.getState(opened.sessionId)).export.status, 'saved');
  assert.deepEqual(readFileSync(first.path), nativePng,
    'new native crop export must not alter prior PNG files');
  assert.deepEqual(readFileSync(first.provenancePath), sidecar);

  const filesBeforeUnboundPreview = readdirSync(outputDirectory).sort();
  sessions.withStoreLock(() => sessions.confirmPreview(
    opened.sessionId, 3, token.rendererId, sourceSha256, 2, 2, cropPreview,
    runtimeConfirmation(token.rendererId)
  ));
  expectCode(() => exportSessionBoundPng({
    ...request(), pngBytes: cropPng, width: 2, height: 2,
    expectedPreviewSha256: cropPreview
  }), 'export_provenance_conflict');
  assert.deepEqual(readdirSync(outputDirectory).sort(), filesBeforeUnboundPreview,
    'preview without the separate native pixel binding cannot export');

  assert.deepEqual(readFileSync(hostileSentinel), sentinelBytes,
    'the inherited hostile data root must be unchanged');
  assert.deepEqual(readdirSync(hostileRoot), ['sentinel.txt']);
  assert.equal(sha(nativePng), baselinePngSha);
  assert.equal(sha(sourceBytes), sourceSha256);
  assert.doesNotMatch(readFileSync(join(root, 'server/index.mjs'), 'utf8'),
    /session-bound-export|png-integrity|withCurrentRenderer/);
  assert.doesNotMatch(readFileSync(join(root, 'ui/studio.html'), 'utf8'),
    /session-bound-export|png-integrity/);
  console.log('M1-G2-PR5 session-bound PNG provenance, stale renderer, native pixels and detached V0.2.8 compatibility checks passed.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
