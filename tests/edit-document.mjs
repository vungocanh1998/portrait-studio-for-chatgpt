import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Engine from '../ui/engine.js';
import { getExportStatus, getPreviewStatus, normalizeEditOperation, readV1Store, reduceEditDocument } from '../server/edit-document.mjs';

const tempRoot = mkdtempSync(join(tmpdir(), 'portrait-studio-edit-document-'));
const resolvedTempRoot = resolve(tempRoot);

function isWithin(base, target) {
  const fromBase = resolve(base);
  const fromTarget = resolve(target);
  const rel = relative(fromBase, fromTarget);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

assert.ok(isWithin(tmpdir(), resolvedTempRoot), 'synthetic store test must stay under the OS temp root');
const testDataRoot = process.env.PORTRAIT_STUDIO_DATA_DIR;
if (testDataRoot) {
  assert.ok(isWithin(tmpdir(), testDataRoot), 'the check runner must replace inherited data paths with a temporary child path');
  assert.doesNotMatch(basename(resolve(testDataRoot)), /^hostile-parent-/);
}

const sessionId = 'b0000000-0000-4000-8000-000000000000';
const source = {
  fileName: 'synthetic-source.png',
  mimeType: 'image/png',
  width: 400,
  height: 300,
  byteSize: 4096,
  sha256: 'a'.repeat(64)
};
const history = Array.from({ length: 50 }, (_, index) => ({
  adjustments: { ...Engine.DEFAULT_ADJUSTMENTS, exposureEV: Number(((index - 25) / 10).toFixed(1)) },
  preset: index % 2 ? { name: 'warm', intensity: 50 } : null,
  crop: {
    x: Number((index * 0.25).toFixed(4)),
    y: Number((index * 0.125).toFixed(4)),
    width: 70,
    height: 80,
    aspectRatio: 'free'
  }
}));
const historyIndex = 35;
const confirmedBy = {
  serverVersion: '0.2.8',
  sourceBuildHash: 'd'.repeat(64),
  pid: 1234,
  instanceId: 'c0000000-0000-4000-8000-000000000000',
  executablePath: 'synthetic/bin/portrait-studio',
  scriptPath: 'synthetic/server/index.mjs',
  pluginRoot: 'synthetic/plugin',
  sessionStorePath: 'synthetic/sessions.json',
  confirmedAt: '2026-11-01T09:30:33.000Z'
};
const session = {
  sessionId,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:30:33.000Z',
  revision: 42,
  source,
  ...history[historyIndex],
  history,
  historyIndex,
  preview: {
    revision: 42,
    rendererId: sessionId,
    width: 240,
    height: 180,
    sha256: 'b'.repeat(64),
    confirmedBy
  },
  export: {
    revision: 40,
    path: 'synthetic/edited.png',
    fileName: 'edited.png',
    width: 240,
    height: 180,
    bytes: 2048,
    sha256: 'c'.repeat(64),
    pixelSha256: 'e'.repeat(64)
  }
};
const store = { version: 1, sessions: [session] };
const storeCopy = structuredClone(store);
const originalBytes = Buffer.from(JSON.stringify(store));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalHash = digest(originalBytes);
const filePath = join(tempRoot, 'sessions.json');

try {
  writeFileSync(filePath, originalBytes, { flag: 'wx' });
  const empty = readV1Store(Buffer.from('{"version":1,"sessions":[]}'));
  assert.deepEqual(empty, []);

  const documents = readV1Store(readFileSync(filePath));
  assert.deepEqual(store, storeCopy, 'the adapter must not mutate its input data');
  assert.equal(digest(readFileSync(filePath)), originalHash, 'the adapter must leave original V1 bytes unchanged');
  assert.deepEqual(readFileSync(filePath), originalBytes);
  assert.equal(documents.length, 1);

  const document = documents[0];
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.sessionId, sessionId);
  assert.equal(document.createdAt, session.createdAt);
  assert.equal(document.updatedAt, session.updatedAt);
  assert.equal(document.revision, 42);
  assert.deepEqual(document.source, source);
  assert.deepEqual(document.crop, session.crop);
  assert.deepEqual(document.adjustments, session.adjustments);
  assert.deepEqual(document.preset, session.preset);
  assert.deepEqual(document.history, history, 'all 50 V1 history snapshots and the branch cursor must be preserved');
  assert.equal(document.history.length, 50);
  assert.equal(document.historyIndex, historyIndex);
  assert.deepEqual(document.preview, session.preview);
  assert.deepEqual(document.export, session.export);
  assert.equal(getPreviewStatus(document), 'confirmed');
  assert.equal(getExportStatus(document), 'stale');
  assert.equal(JSON.stringify(document).includes('rgba8'), false);
  assert.ok(Object.isFrozen(documents));
  assert.ok(Object.isFrozen(document));
  assert.ok(Object.isFrozen(document.history));
  assert.ok(Object.isFrozen(document.history[0].crop));
  assert.throws(() => { document.history[0].crop.x = 99; }, TypeError);

  const identity = {
    mimeType: source.mimeType,
    width: source.width,
    height: source.height,
    byteSize: source.byteSize,
    sha256: source.sha256
  };
  const operation = {
    type: 'setState',
    expectedRevision: document.revision,
    expectedSource: identity,
    timestamp: '2026-11-01T10:00:00.000Z',
    state: {
      adjustments: { ...document.adjustments, exposureEV: 1.25 },
      preset: null,
      crop: { x: 20, y: 10, width: 60, height: 75, aspectRatio: 'free' }
    }
  };
  const normalized = normalizeEditOperation(document, operation);
  assert.equal(normalized.state.adjustments.exposureEV, 1.25);
  assert.ok(Object.isFrozen(normalized));
  const applied = reduceEditDocument(document, normalized);
  assert.equal(applied.status, 'applied');
  assert.equal(document.revision, 42, 'the prior document must remain immutable');
  assert.equal(applied.document.revision, 43);
  assert.equal(applied.document.updatedAt, operation.timestamp);
  assert.equal(applied.document.history.length, historyIndex + 2, 'a new operation must truncate the redo branch before appending');
  assert.equal(applied.document.historyIndex, historyIndex + 1);
  assert.deepEqual(applied.document.history.slice(0, historyIndex + 1), history.slice(0, historyIndex + 1));
  assert.deepEqual(applied.document.preview, document.preview, 'preview metadata remains available as historical data');
  assert.deepEqual(applied.document.export, document.export, 'export metadata remains available as historical data');
  assert.equal(getPreviewStatus(applied.document), 'pending');
  assert.equal(getExportStatus(applied.document), 'stale');

  const stale = reduceEditDocument(document, { ...operation, expectedRevision: 41 });
  assert.equal(stale.status, 'conflict');
  assert.strictEqual(stale.document, document, 'a stale revision must have no state or history effect');
  const wrongSource = reduceEditDocument(document, {
    ...operation,
    expectedSource: { ...identity, sha256: 'f'.repeat(64) }
  });
  assert.equal(wrongSource.status, 'conflict');
  assert.strictEqual(wrongSource.document, document, 'a source mismatch must have no state or history effect');

  const unchanged = reduceEditDocument(document, {
    ...operation,
    state: { adjustments: document.adjustments, preset: document.preset, crop: document.crop }
  });
  assert.equal(unchanged.status, 'unchanged');
  assert.strictEqual(unchanged.document, document);

  const undone = reduceEditDocument(applied.document, {
    type: 'undo',
    expectedRevision: 43,
    expectedSource: identity,
    timestamp: '2026-11-01T10:01:00.000Z'
  });
  assert.equal(undone.status, 'applied');
  assert.equal(undone.document.revision, 44);
  assert.equal(undone.document.historyIndex, historyIndex);
  assert.deepEqual(undone.document.adjustments, document.history[historyIndex].adjustments);

  const redone = reduceEditDocument(undone.document, {
    type: 'redo',
    expectedRevision: 44,
    expectedSource: identity,
    timestamp: '2026-11-01T10:02:00.000Z'
  });
  assert.equal(redone.status, 'applied');
  assert.equal(redone.document.revision, 45);
  assert.equal(redone.document.historyIndex, historyIndex + 1);
  assert.deepEqual(redone.document.adjustments, applied.document.adjustments);

  const fullHistory = structuredClone(store);
  fullHistory.sessions[0].historyIndex = 49;
  fullHistory.sessions[0].adjustments = fullHistory.sessions[0].history[49].adjustments;
  fullHistory.sessions[0].preset = fullHistory.sessions[0].history[49].preset;
  fullHistory.sessions[0].crop = fullHistory.sessions[0].history[49].crop;
  fullHistory.sessions[0].revision = 49;
  fullHistory.sessions[0].preview.revision = 49;
  fullHistory.sessions[0].export.revision = 49;
  const fullDocument = readV1Store(JSON.stringify(fullHistory))[0];
  const atLimit = reduceEditDocument(fullDocument, { ...operation, expectedRevision: 49 });
  assert.equal(atLimit.document.history.length, 50, 'history remains capped at the V1 limit');
  assert.equal(atLimit.document.historyIndex, 49);

  assert.throws(() => readV1Store(Buffer.from('{')), SyntaxError);
  assert.throws(() => readV1Store(Buffer.from('{"version":2,"sessions":[]}')), /Unsupported or invalid V1/);
  assert.throws(() => readV1Store(Buffer.from('{"version":1,"sessions":[],"future":true}')), /unknown or missing fields/);
  const unknownSession = structuredClone(store);
  unknownSession.sessions[0].future = true;
  assert.throws(() => readV1Store(JSON.stringify(unknownSession)), /unknown or missing fields/);
  assert.throws(() => normalizeEditOperation(document, { ...operation, extra: true }), /unknown or missing fields/);
} finally {
  assert.ok(isWithin(tmpdir(), resolvedTempRoot), 'refuse to clean outside the generated temp root');
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('Portrait Studio EditDocument checks passed.');
