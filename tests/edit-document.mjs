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

  // Real V1 fixed-ratio writer math is not necessarily idempotent after
  // rounding its stored percentage coordinates to four decimals.
  const writerCrop = Engine.normalizeCrop(
    { x: 10, y: 0, width: 80, height: 100, aspectRatio: '4:5' }, 301, 201
  );
  assert.deepEqual(writerCrop, {
    x: 23.289, y: 0, width: 53.4219, height: 100, aspectRatio: '4:5'
  });
  assert.notDeepEqual(Engine.normalizeCrop(writerCrop, 301, 201), writerCrop,
    'this synthetic writer fixture must reproduce the old double-normalization bug');
  const fixedStore = structuredClone(store);
  fixedStore.sessions[0].source = { ...source, width: 301, height: 201 };
  fixedStore.sessions[0].crop = { ...writerCrop };
  fixedStore.sessions[0].history = fixedStore.sessions[0].history.map((entry) => ({
    ...entry, crop: { ...writerCrop }
  }));
  const fixedBytes = Buffer.from(JSON.stringify(fixedStore));
  const fixedPath = join(tempRoot, 'fixed-ratio-synthetic.json');
  writeFileSync(fixedPath, fixedBytes, { flag: 'wx' });
  const fixedHash = digest(fixedBytes);
  const fixedDocument = readV1Store(readFileSync(fixedPath))[0];
  assert.deepEqual(fixedDocument.crop, writerCrop,
    'the adapter must not alter persisted fixed-ratio percentages');
  assert.deepEqual(fixedDocument.history.map((item) => item.crop),
    fixedStore.sessions[0].history.map((item) => item.crop),
    'the adapter must preserve all fixed-ratio history crop coordinates');
  assert.equal(fixedDocument.historyIndex, historyIndex);
  assert.equal(fixedDocument.revision, 42);
  assert.ok(Object.isFrozen(fixedDocument.history[0].crop));
  assert.deepEqual(readFileSync(fixedPath), fixedBytes);
  assert.equal(digest(readFileSync(fixedPath)), fixedHash,
    'fixed-ratio adaptation must never mutate original V1 store bytes');

  // Regression: V1 writer-generated fixed-ratio coordinates must survive
  // every state operation, not just the read-only adapter. A second
  // Engine.normalizeCrop pass would drift the stored height from 100.
  const fixedIdentity = {
    ...identity,
    width: fixedStore.sessions[0].source.width,
    height: fixedStore.sessions[0].source.height
  };
  const fixedNoOpRequest = {
    type: 'setState',
    expectedRevision: fixedDocument.revision,
    expectedSource: fixedIdentity,
    timestamp: '2026-11-01T10:11:00.000Z',
    state: {
      adjustments: fixedDocument.adjustments,
      preset: fixedDocument.preset,
      crop: { ...fixedDocument.crop }
    }
  };
  const normalizedFixedNoOp = normalizeEditOperation(fixedDocument, fixedNoOpRequest);
  assert.deepEqual(normalizedFixedNoOp.state.crop, writerCrop,
    'operation normalization must not drift a trusted unchanged V1 crop');
  const fixedNoOp = reduceEditDocument(fixedDocument, fixedNoOpRequest);
  assert.equal(fixedNoOp.status, 'unchanged');
  assert.strictEqual(fixedNoOp.document, fixedDocument,
    'exact-state setState must not change revision, history, or preview');
  assert.equal(fixedNoOp.document.revision, 42);
  assert.equal(fixedNoOp.document.history.length, 50);
  assert.equal(fixedNoOp.document.historyIndex, historyIndex);
  assert.equal(getPreviewStatus(fixedNoOp.document), 'confirmed');
  assert.deepEqual(fixedNoOp.document.preview, fixedStore.sessions[0].preview);
  assert.strictEqual(reduceEditDocument(fixedDocument, normalizedFixedNoOp).document, fixedDocument,
    'already normalized exact-state operation must also remain a no-op');

  const fixedColorRequest = {
    ...fixedNoOpRequest,
    timestamp: '2026-11-01T10:12:00.000Z',
    state: {
      adjustments: { ...fixedDocument.adjustments, exposureEV: 1.25 },
      preset: null,
      crop: { ...writerCrop }
    }
  };
  const fixedColorNormalized = normalizeEditOperation(fixedDocument, fixedColorRequest);
  assert.deepEqual(fixedColorNormalized.state.crop, writerCrop);
  const fixedColor = reduceEditDocument(fixedDocument, fixedColorRequest);
  assert.equal(fixedColor.status, 'applied');
  assert.equal(fixedColor.document.revision, 43);
  assert.deepEqual(fixedColor.document.crop, writerCrop,
    'color-only setState must preserve exact current crop bytes');
  assert.deepEqual(fixedColor.document.history.at(-1).crop, writerCrop,
    'color-only setState must preserve exact crop in newly appended history');
  assert.equal(fixedColor.document.history.length, historyIndex + 2);
  assert.equal(fixedColor.document.historyIndex, historyIndex + 1);
  assert.equal(getPreviewStatus(fixedColor.document), 'pending');
  assert.deepEqual(fixedDocument.crop, writerCrop,
    'the frozen V1-adapted document must remain unchanged');
  const fixedColorFromNormalized = reduceEditDocument(fixedDocument, fixedColorNormalized);
  assert.deepEqual(fixedColorFromNormalized.document, fixedColor.document,
    'normalizing an operation before reduction must have identical results');

  const fixedUndo = reduceEditDocument(fixedColor.document, {
    type: 'undo', expectedRevision: 43, expectedSource: fixedIdentity,
    timestamp: '2026-11-01T10:13:00.000Z'
  });
  assert.equal(fixedUndo.status, 'applied');
  assert.equal(fixedUndo.document.revision, 44);
  assert.deepEqual(fixedUndo.document.crop, writerCrop);
  assert.equal(fixedUndo.document.historyIndex, historyIndex);
  const fixedRedo = reduceEditDocument(fixedUndo.document, {
    type: 'redo', expectedRevision: 44, expectedSource: fixedIdentity,
    timestamp: '2026-11-01T10:14:00.000Z'
  });
  assert.equal(fixedRedo.status, 'applied');
  assert.equal(fixedRedo.document.revision, 45);
  assert.deepEqual(fixedRedo.document.crop, writerCrop);
  assert.equal(fixedRedo.document.historyIndex, historyIndex + 1);

  // A genuinely new crop still enters the V0.2.8 normalizer exactly once.
  // A second normalization is not guaranteed to be idempotent on fixed ratios.
  const freshCropInput = {
    x: 12, y: 8, width: 60, height: 60, aspectRatio: '4:5'
  };
  const expectedNewCrop = Engine.normalizeCrop(freshCropInput, 301, 201);
  assert.notDeepEqual(expectedNewCrop, writerCrop);
  const newCropRequest = {
    ...fixedNoOpRequest,
    timestamp: '2026-11-01T10:15:00.000Z',
    state: {
      adjustments: fixedDocument.adjustments,
      preset: fixedDocument.preset,
      crop: freshCropInput
    }
  };
  const normalizedNewCrop = normalizeEditOperation(fixedDocument, newCropRequest);
  assert.deepEqual(normalizedNewCrop.state.crop, expectedNewCrop,
    'new crop must use the existing V1 engine geometry once');
  const newCrop = reduceEditDocument(fixedDocument, newCropRequest);
  assert.equal(newCrop.status, 'applied');
  assert.deepEqual(newCrop.document.crop, expectedNewCrop);
  assert.deepEqual(newCrop.document.history.at(-1).crop, expectedNewCrop);
  const preNormalizedNewCrop = reduceEditDocument(fixedDocument, normalizedNewCrop);
  assert.deepEqual(preNormalizedNewCrop.document.crop, expectedNewCrop,
    'already normalized new crop must not drift during reduction');
  assert.deepEqual(preNormalizedNewCrop.document, newCrop.document);
  assert.deepEqual(newCrop.document.source, fixedDocument.source);
  assert.deepEqual(fixedDocument.history[historyIndex].crop, writerCrop);

  // Source/revision conflicts must remain inert, including for the fixed
  // aspect-ratio fixture; invalid input cannot bypass strict operation checks.
  const staleFixed = reduceEditDocument(fixedDocument, {
    ...fixedColorRequest, expectedRevision: 41
  });
  const wrongFixedSource = reduceEditDocument(fixedDocument, {
    ...fixedColorRequest,
    expectedSource: { ...fixedIdentity, sha256: 'f'.repeat(64) }
  });
  for (const conflict of [staleFixed, wrongFixedSource]) {
    assert.equal(conflict.status, 'conflict');
    assert.strictEqual(conflict.document, fixedDocument);
  }
  assert.throws(() => reduceEditDocument(fixedDocument, {
    ...fixedColorRequest, state: {
      ...fixedColorRequest.state, crop: { ...writerCrop, aspectRatio: '7:11' }
    }
  }), TypeError);
  assert.throws(() => reduceEditDocument(fixedDocument, {
    ...fixedColorRequest, state: {
      ...fixedColorRequest.state, crop: { ...writerCrop, width: Number.NaN }
    }
  }), TypeError);
  assert.throws(() => normalizeEditOperation(fixedDocument, {
    ...fixedColorRequest, state: {
      ...fixedColorRequest.state, crop: { ...writerCrop, future: true }
    }
  }), /unknown or missing fields/);
  assert.equal(digest(readFileSync(fixedPath)), fixedHash,
    'all pure operations must leave the original V1 store unchanged');

  // At the largest V1-accepted revision, an operation that does not
  // change state/history must not be rejected by the overflow guard.
  const maxRevision = Number.MAX_SAFE_INTEGER;
  function maxRevisionDocument(historyCursor, revisionValue = maxRevision) {
    const synthetic = structuredClone(store);
    const raw = synthetic.sessions[0];
    raw.revision = revisionValue;
    raw.historyIndex = historyCursor;
    raw.adjustments = structuredClone(raw.history[historyCursor].adjustments);
    raw.preset = structuredClone(raw.history[historyCursor].preset);
    raw.crop = structuredClone(raw.history[historyCursor].crop);
    raw.preview.revision = revisionValue;
    raw.export.revision = revisionValue;
    return readV1Store(JSON.stringify(synthetic))[0];
  }
  const maxMiddle = maxRevisionDocument(historyIndex);
  const maxExactState = {
    ...operation,
    expectedRevision: maxRevision,
    state: {
      adjustments: maxMiddle.adjustments,
      preset: maxMiddle.preset,
      crop: maxMiddle.crop
    }
  };
  const maxNoOp = reduceEditDocument(maxMiddle, maxExactState);
  assert.equal(maxNoOp.status, 'unchanged');
  assert.strictEqual(maxNoOp.document, maxMiddle,
    'exact-state operation at MAX_SAFE_INTEGER must preserve document identity');
  assert.equal(maxNoOp.document.revision, maxRevision);
  assert.equal(maxNoOp.document.historyIndex, historyIndex);
  assert.equal(maxNoOp.document.history.length, 50);
  assert.equal(getPreviewStatus(maxNoOp.document), 'confirmed');
  assert.equal(getExportStatus(maxNoOp.document), 'saved');
  assert.deepEqual(maxNoOp.document.preview, maxMiddle.preview);
  assert.deepEqual(maxNoOp.document.export, maxMiddle.export);

  const maxFirst = maxRevisionDocument(0);
  const maxLast = maxRevisionDocument(49);
  const maxUndoBoundary = {
    type: 'undo', expectedRevision: maxRevision, expectedSource: identity,
    timestamp: '2026-11-01T10:16:00.000Z'
  };
  const maxRedoBoundary = {
    ...maxUndoBoundary, type: 'redo'
  };
  const boundaryUndo = reduceEditDocument(maxFirst, maxUndoBoundary);
  const boundaryRedo = reduceEditDocument(maxLast, maxRedoBoundary);
  for (const [noOp, original] of [[boundaryUndo, maxFirst], [boundaryRedo, maxLast]]) {
    assert.equal(noOp.status, 'unchanged',
      'history boundary at maximum revision must be an inert no-op');
    assert.strictEqual(noOp.document, original);
    assert.equal(noOp.document.revision, maxRevision);
    assert.deepEqual(noOp.document.history, original.history);
    assert.deepEqual(noOp.document.preview, original.preview);
    assert.deepEqual(noOp.document.export, original.export);
  }

  // Real mutations must still fail closed at the maximum (no overflow).
  assert.throws(() => reduceEditDocument(maxMiddle, {
    ...operation, expectedRevision: maxRevision
  }), /revision cannot be incremented safely/);
  assert.throws(() => reduceEditDocument(maxMiddle, maxUndoBoundary),
    /revision cannot be incremented safely/);
  assert.throws(() => reduceEditDocument(maxMiddle, maxRedoBoundary),
    /revision cannot be incremented safely/);
  const maxConflict = reduceEditDocument(maxMiddle, {
    ...operation, expectedRevision: maxRevision - 1
  });
  assert.equal(maxConflict.status, 'conflict');
  assert.strictEqual(maxConflict.document, maxMiddle);
  assert.equal(maxMiddle.revision, maxRevision);
  assert.equal(maxMiddle.history.length, 50);

  // MAX-1 can still perform one legitimate edit to MAX and then no-op.
  const almostMax = maxRevisionDocument(historyIndex, maxRevision - 1);
  const lastSafeEdit = reduceEditDocument(almostMax, {
    ...operation, expectedRevision: maxRevision - 1
  });
  assert.equal(lastSafeEdit.status, 'applied');
  assert.equal(lastSafeEdit.document.revision, maxRevision);
  const lastSafeNoOp = reduceEditDocument(lastSafeEdit.document, {
    type: 'setState', expectedRevision: maxRevision, expectedSource: identity,
    timestamp: '2026-11-01T10:17:00.000Z',
    state: {
      adjustments: lastSafeEdit.document.adjustments,
      preset: lastSafeEdit.document.preset,
      crop: lastSafeEdit.document.crop
    }
  });
  assert.equal(lastSafeNoOp.status, 'unchanged');
  assert.strictEqual(lastSafeNoOp.document, lastSafeEdit.document);

  // V1 fixed-aspect crops are safe at the limit too: no second normalization.
  const fixedMaxSource = structuredClone(fixedStore);
  fixedMaxSource.sessions[0].revision = maxRevision;
  fixedMaxSource.sessions[0].preview.revision = maxRevision;
  fixedMaxSource.sessions[0].export.revision = maxRevision;
  const fixedMaxDocument = readV1Store(JSON.stringify(fixedMaxSource))[0];
  const fixedMaxNoOp = reduceEditDocument(fixedMaxDocument, {
    ...fixedNoOpRequest, expectedRevision: maxRevision
  });
  assert.equal(fixedMaxNoOp.status, 'unchanged');
  assert.strictEqual(fixedMaxNoOp.document, fixedMaxDocument);
  assert.deepEqual(fixedMaxNoOp.document.crop, writerCrop);
  assert.equal(digest(readFileSync(filePath)), originalHash,
    'max-revision pure operations must never write to V1 store');

  const invalidFreeCrop = (crop) => {
    const invalid = structuredClone(store);
    invalid.sessions[0].crop = { ...crop };
    invalid.sessions[0].history[historyIndex].crop = { ...crop };
    assert.throws(() => readV1Store(JSON.stringify(invalid)), TypeError);
  };
  invalidFreeCrop({ ...history[historyIndex].crop, x: 0, width: 100.0001 });
  invalidFreeCrop({ ...history[historyIndex].crop, x: 0, width: 0.2499 });

  const invalidFixedCrop = (crop) => {
    const invalid = structuredClone(fixedStore);
    invalid.sessions[0].crop = { ...crop };
    invalid.sessions[0].history[historyIndex].crop = { ...crop };
    assert.throws(() => readV1Store(JSON.stringify(invalid)), TypeError);
  };
  invalidFixedCrop({ ...writerCrop, width: 54.5 }); // ratio mismatch
  invalidFixedCrop({ ...writerCrop, x: 60 }); // beyond right image boundary
  invalidFixedCrop({ ...writerCrop, y: -0.01 }); // negative coordinate
  invalidFixedCrop({ ...writerCrop, width: 0.1 }); // too small for source
  invalidFixedCrop({ ...writerCrop, width: Number.NaN }); // non-finite
  invalidFixedCrop({ ...writerCrop, x: 23.28901 }); // noncanonical precision
  invalidFixedCrop({ ...writerCrop, aspectRatio: '7:11' }); // unsupported
  invalidFixedCrop({ ...writerCrop, unknown: 123 }); // unknown field

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
