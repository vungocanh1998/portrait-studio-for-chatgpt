import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { EditorSessions } from '../server/editor-state.mjs';
import { inspectPng } from '../server/png-integrity.mjs';
import { inspectExportRecovery } from '../server/export-recovery.mjs';
import { readV1Store } from '../server/edit-document.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const root = mkdtempSync(join(tmpdir(), 'portrait-studio-pr2-recovery-'));
const dataRoot = join(root, 'data');
const outputDirectory = join(root, 'output');
const hostileRoot = join(root, 'hostile-root');
const sentinelPath = join(hostileRoot, 'sentinel.txt');
const sentinel = Buffer.from('synthetic recovery sentinel: not an export');
const storePath = join(dataRoot, 'sessions.json');
const pngName = 'recorded-portrait-studio.png';
const uuid = randomUUID();

function expectCode(fn, code) {
  assert.throws(fn, error => error?.code === code, 'Expected refusal ' + code);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, v) => {
  let c = v;
  for (let j = 0; j < 8; j++)
    c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes)
    c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(name, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const kind = Buffer.from(name);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([kind, payload])));
  return Buffer.concat([len, kind, payload, crc]);
}
function makePng(width, height, rgba) {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    rgba.copy(rows, (width * 4 + 1) * y + 1, y * width * 4, (y + 1) * width * 4);
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

function find(inventory, name) {
  return inventory.entries.find(row => row.fileName === name);
}

try {
  mkdirSync(dataRoot);
  mkdirSync(outputDirectory);
  mkdirSync(hostileRoot);
  writeFileSync(sentinelPath, sentinel, { flag: 'wx' });
  const imageSource = Buffer.from('synthetic unmodified image source identifier');
  const sourceSha = sha(imageSource);
  const rgba = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255,
    70, 80, 90, 255, 100, 110, 120, 255]);
  const png = makePng(2, 2, rgba);
  const pngInfo = inspectPng(png, 2, 2);
  assert.equal(pngInfo.pixelSha256, sha(rgba));
  const sessions = new EditorSessions({ filePath: storePath });
  const opened = sessions.withStoreLock(() => sessions.create());
  const bound = sessions.withStoreLock(() => sessions.bindSource(opened.sessionId, 0, {
    fileName: 'synthetic-original.png', mimeType: 'image/png',
    width: 2, height: 2, byteSize: imageSource.length, sha256: sourceSha
  }));
  assert.equal(bound.revision, 1);
  const rendererId = randomUUID();
  const previewSha256 = 'd'.repeat(64);
  sessions.withStoreLock(() => sessions.confirmPreview(
    opened.sessionId, 1, rendererId, sourceSha, 2, 2, previewSha256, null
  ));
  assert.doesNotThrow(() => readV1Store(readFileSync(storePath)));

  const provenance = {
    schemaVersion: 1,
    sessionId: opened.sessionId,
    revision: 1,
    sourceSha256: sourceSha,
    rendererId,
    rendererEpoch: 1,
    pipelineId: 'm1-recovery-synthetic',
    sourceBuildHash: 'a'.repeat(64),
    previewSha256,
    width: 2, height: 2, bytes: png.length,
    pngSha256: pngInfo.sha256,
    pixelSha256: pngInfo.pixelSha256,
    fileName: pngName
  };
  function pair(name, values = {}) {
    writeFileSync(join(outputDirectory, name), png, { flag: 'wx' });
    writeFileSync(join(outputDirectory, name + '.provenance.json'),
      JSON.stringify({ ...provenance, ...values, fileName: name }) + '\n', { flag: 'wx' });
  }
  pair(pngName);

  expectCode(() => inspectExportRecovery(), 'recovery_invalid_store_path');
  let inventory = inspectExportRecovery({ storePath, outputDirectory });
  assert.equal(inventory.mode, 'read_only_inventory');
  assert.equal(inventory.safeToAutoRecover, false);
  assert.equal(inventory.safeToAutoDelete, false);
  assert.equal(inventory.sessionStoreSha256, sha(readFileSync(storePath)));
  assert.equal(find(inventory, pngName).status, 'unreferenced_verified');
  assert.equal(inventory.counts.unreferenced_verified, 1);
  assert.equal(sessions.withStoreLock(() => sessions.getState(opened.sessionId)).export.status, 'none');

  sessions.withStoreLock(() => sessions.recordExport(opened.sessionId, 1, rendererId, {
    path: join(outputDirectory, pngName), fileName: pngName,
    width: 2, height: 2, bytes: png.length,
    sha256: pngInfo.sha256, pixelSha256: pngInfo.pixelSha256
  }));
  inventory = inspectExportRecovery({ storePath, outputDirectory });
  assert.equal(find(inventory, pngName).status, 'recorded_verified');
  assert.equal(inventory.counts.recorded_verified, 1);

  const oldExport = 'earlier-portrait-studio.png';
  pair(oldExport);
  inventory = inspectExportRecovery({ storePath, outputDirectory });
  assert.equal(find(inventory, oldExport).status, 'unreferenced_verified',
    'V1 only stores latest export: older legitimate pairs must not be auto-deleted');

  const partial = 'partial-portrait-studio.png';
  writeFileSync(join(outputDirectory, partial), png, { flag: 'wx' });
  const proofOnly = 'proofonly-portrait-studio.png';
  writeFileSync(join(outputDirectory, proofOnly + '.provenance.json'),
    JSON.stringify({ ...provenance, fileName: proofOnly }) + '\n', { flag: 'wx' });
  inventory = inspectExportRecovery({ storePath, outputDirectory });
  assert.equal(find(inventory, partial).status, 'incomplete_pair');
  assert.equal(find(inventory, proofOnly).status, 'incomplete_pair');
  assert.equal(inventory.counts.incomplete_pair, 2);

  const corruptName = 'corrupt-portrait-studio.png';
  pair(corruptName, { pixelSha256: 'f'.repeat(64) });
  inventory = inspectExportRecovery({ storePath, outputDirectory });
  assert.equal(find(inventory, corruptName).status, 'invalid_pair');
  const corruptedPng = 'changed-portrait-studio.png';
  pair(corruptedPng);
  const corruptBytes = Buffer.from(png);
  corruptBytes[42] ^= 1; // invalidate CRC, never touch source data
  writeFileSync(join(outputDirectory, corruptedPng), corruptBytes);
  inventory = inspectExportRecovery({ storePath, outputDirectory });
  assert.equal(find(inventory, corruptedPng).status, 'invalid_pair');
  assert.equal(find(inventory, pngName).status, 'recorded_verified');

  const movedFile = join(root, 'recorded-artifact-moved');
  renameSync(join(outputDirectory, pngName), movedFile);
  inventory = inspectExportRecovery({ storePath, outputDirectory });
  assert.equal(find(inventory, pngName).status, 'incomplete_pair');
  assert.notEqual(inventory.counts.recorded_verified, 1);
  renameSync(movedFile, join(outputDirectory, pngName));

  const noPairOut = join(root, 'missing-recorded');
  mkdirSync(noPairOut);
  // Record path belongs to the first output directory, so this *other*
  // directory cannot claim it as a missing export.
  const unrelated = inspectExportRecovery({ storePath, outputDirectory: noPairOut });
  assert.equal(unrelated.counts.recorded_missing_pair, 0);

  const outputSnapshot = readdirSync(outputDirectory).sort();
  const savedSessionBytes = readFileSync(storePath);
  const pngSavedBytes = readFileSync(join(outputDirectory, pngName));
  const proofSavedBytes = readFileSync(join(outputDirectory, pngName + '.provenance.json'));
  const again = inspectExportRecovery({ storePath, outputDirectory });
  assert.equal(find(again, pngName).status, 'recorded_verified');
  assert.deepEqual(readFileSync(storePath), savedSessionBytes);
  assert.deepEqual(readFileSync(join(outputDirectory, pngName)), pngSavedBytes);
  assert.deepEqual(readFileSync(join(outputDirectory, pngName + '.provenance.json')), proofSavedBytes);
  assert.deepEqual(readdirSync(outputDirectory).sort(), outputSnapshot);

  writeFileSync(storePath + '.lock', 'synthetic locked sentinel', { flag: 'wx' });
  expectCode(() => inspectExportRecovery({ storePath, outputDirectory }), 'recovery_store_busy');
  unlinkSync(storePath + '.lock');
  assert.deepEqual(readFileSync(storePath), savedSessionBytes);

  if (process.platform !== 'win32') {
    const unsafeAlias = join(root, 'output-alias');
    symlinkSync(outputDirectory, unsafeAlias, 'dir');
    expectCode(() => inspectExportRecovery({ storePath, outputDirectory: unsafeAlias }),
      'recovery_noncanonical_path');
    const aliasFile = join(outputDirectory, 'alias-portrait-studio.png');
    symlinkSync(join(outputDirectory, pngName), aliasFile);
    expectCode(() => inspectExportRecovery({ storePath, outputDirectory }), 'recovery_unsafe_entry');
    unlinkSync(aliasFile);
  }

  const hostileEntries = readdirSync(hostileRoot).sort();
  assert.deepEqual(hostileEntries, ['sentinel.txt']);
  assert.deepEqual(readFileSync(sentinelPath), sentinel);
  assert.equal(sha(imageSource), sourceSha);
  assert.equal(sha(png), pngInfo.sha256);
  console.log('M1-AR-PR2 read-only recovery inventory, uncertain orphans, V1 preservation and hostile path guards passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
