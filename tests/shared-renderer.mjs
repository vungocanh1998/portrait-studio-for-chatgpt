import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readV1Store, reduceEditDocument } from '../server/edit-document.mjs';
import { registerRenderer, isCurrentRenderer, assertCurrentRenderer } from '../server/renderer-authority.mjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Engine = require('../ui/engine.js');
const renderer = require('../ui/shared-renderer.js');
const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/m1-g2-pr1.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const testRoot = mkdtempSync(join(tmpdir(), 'portrait-studio-pr4-synthetic-'));
const hostile = join(testRoot, 'hostile-parent');
const sentinel = join(hostile, 'sentinel.bin');
const sentinelBytes = Buffer.from('synthetic-only shared renderer sentinel');
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const srcSha = 'a'.repeat(64);
const buildSha = 'b'.repeat(64);
const identity = { sessionId, sourceSha256: srcSha, revision: 7, pipelineId: 'm1-synthetic-renderer', sourceBuildHash: buildSha };

function expectCode(fn, code) {
  assert.throws(fn, error => error?.code === code, 'Expected safety failure ' + code);
}

function cropFixturePixels() {
  const { x, y, width, height } = fixture.crop.bounds;
  const result = [];
  for (let row = y; row < y + height; row++) {
    const start = (row * fixture.source.width + x) * 4;
    result.push(...fixture.source.rgba8.slice(start, start + width * 4));
  }
  return Uint8ClampedArray.from(result);
}

function testRasterParity() {
  const full = Uint8ClampedArray.from(fixture.source.rgba8);
  const snapshot = Uint8ClampedArray.from(full);
  const legacy = Uint8ClampedArray.from(full);
  Engine.applyColorAdjustments(legacy, fixture.legacy.adjustments);
  const shared = renderer.renderRgba8(full, fixture.source.width, fixture.source.height, {
    adjustments: fixture.legacy.adjustments, gains: [1, 1, 1]
  });
  assert.deepEqual(shared, legacy, 'neutral M1 must match exact legacy native pixel bytes');
  assert.equal(sha256(Buffer.from(shared)), fixture.legacy.rgba8Sha256);
  const native = cropFixturePixels();
  const nativeShared = renderer.renderRgba8(native, fixture.crop.bounds.width, fixture.crop.bounds.height, {
    adjustments: fixture.legacy.adjustments
  });
  assert.deepEqual(Array.from(nativeShared), fixture.crop.legacyRgba8,
    'native crop passed through legacy stage must be byte exact');
  assert.equal(sha256(Buffer.from(nativeShared)), fixture.crop.legacyRgba8Sha256);
  const neutralUnadjusted = renderer.renderRgba8(full, fixture.source.width, fixture.source.height);
  assert.deepEqual(neutralUnadjusted, full);
  assert.deepEqual(full, snapshot, 'source pixels remain immutable');
  assert.deepEqual(legacy.map((v, i) => i % 4 === 3 ? v : 0),
    shared.map((v, i) => i % 4 === 3 ? v : 0), 'alpha unchanged');

  const clipped = Uint8ClampedArray.from([255, 30, 10, 200, 0, 150, 240, 0]);
  const active = renderer.renderRgba8(clipped, 2, 1, { gains: [0.6, 1.4, 2] });
  assert.equal(active[3], 200);
  assert.equal(active[7], 0);
  assert.notDeepEqual(active, clipped);
  assert.ok(active[0] >= 200 && active[0] <= 206,
    'clipped legacy red cannot be recovered from 8-bit output');
  const layer = {
    rgba8: Uint8ClampedArray.from([50, 100, 200, 255, 250, 200, 120, 255]),
    mask: new Float64Array([1, 0]),
    opacity: 1
  };
  const layered = renderer.renderRgba8(clipped, 2, 1, { layers: [layer] });
  assert.deepEqual(Array.from(layered.slice(0, 4)), [50, 100, 200, 200]);
  assert.deepEqual(Array.from(layered.slice(4)), Array.from(clipped.slice(4)));
  assert.deepEqual(clipped, Uint8ClampedArray.from([255, 30, 10, 200, 0, 150, 240, 0]));

  assert.throws(() => renderer.renderRgba8(full, 2, 2), TypeError);
  assert.throws(() => renderer.renderRgba8(full, 4, 3, { gains: [0.1, 1, 1] }), TypeError);
  assert.throws(() => renderer.renderRgba8(full, 4, 3, { gains: [NaN, 1, 1] }), TypeError);
  assert.throws(() => renderer.renderRgba8(full, 4, 3, { layers: [{ rgba8: full, mask: [0], opacity: 1 }] }), TypeError);
}

function makePatch(color, width = 7, height = 7) {
  return Uint8ClampedArray.from(Array.from({ length: width * height }, () => color).flat());
}

function testWhiteBalanceSampling() {
  const gray = makePatch([128, 128, 128, 255]);
  const neutral = renderer.estimateWhiteBalance(gray, 7, 7, { x: 0.5, y: 0.5 });
  assert.deepEqual(neutral.gains, [1, 1, 1]);
  assert.equal(neutral.validPixels, 25);
  const cast = makePatch([160, 128, 100, 255]);
  const sourceHash = sha256(Buffer.from(cast));
  const sample = renderer.estimateWhiteBalance(cast, 7, 7, { x: 0.5, y: 0.5 });
  assert.ok(sample.gains[0] < 1 && sample.gains[2] > 1);
  assert.ok(sample.gains.every(value => value >= 0.5 && value <= 2));
  const corrected = renderer.renderRgba8(cast, 7, 7, { gains: [...sample.gains] });
  assert.ok(Math.abs(corrected[0] - corrected[1]) <= 2);
  assert.ok(Math.abs(corrected[1] - corrected[2]) <= 2);
  assert.equal(sha256(Buffer.from(cast)), sourceHash, 'source samples must never be mutated');
  assert.throws(() => renderer.estimateWhiteBalance(gray, 7, 7, { x: 1.1, y: 0 }), TypeError);
  assert.throws(() => renderer.estimateWhiteBalance(makePatch([5, 5, 5, 255]), 7, 7, { x: 0.5, y: 0.5 }), RangeError);
  assert.throws(() => renderer.estimateWhiteBalance(makePatch([255, 128, 128, 255]), 7, 7, { x: 0.5, y: 0.5 }), RangeError);
  assert.throws(() => renderer.estimateWhiteBalance(makePatch([120, 120, 120, 127]), 7, 7, { x: 0.5, y: 0.5 }), RangeError);
  assert.throws(() => renderer.estimateWhiteBalance(makePatch([220, 75, 50, 255]), 7, 7, { x: 0.5, y: 0.5 }), RangeError);
  const edge = makePatch([120, 120, 120, 255]);
  const grays = [60, 90, 120, 180, 220, 60, 90];
  for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) {
    const i = (y * 7 + x) * 4;
    edge[i] = grays[x]; edge[i + 1] = grays[x]; edge[i + 2] = grays[x];
  }
  assert.throws(() => renderer.estimateWhiteBalance(edge, 7, 7, { x: 0.5, y: 0.5 }), RangeError);
  assert.equal(renderer.estimateWhiteBalance(gray, 7, 7, { x: 0, y: 0 }).validPixels, 9,
    'a clipped 5x5 window at the source corner retains exactly nine valid pixels');
}

function testDocumentHistory() {
  const state = {
    adjustments: { ...Engine.DEFAULT_ADJUSTMENTS },
    preset: null,
    crop: { x: 0, y: 0, width: 100, height: 100, aspectRatio: 'free' }
  };
  const meta = {
    fileName: 'synthetic.png', mimeType: 'image/png', width: 7, height: 7,
    byteSize: 196, sha256: srcSha
  };
  const session = {
    sessionId, createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z', revision: 7,
    source: meta, ...state, history: [state], historyIndex: 0,
    preview: null, export: null
  };
  const original = readV1Store(Buffer.from(JSON.stringify({ version: 1, sessions: [session] })))[0];
  const srcIdentity = { mimeType: meta.mimeType, width: meta.width, height: meta.height,
    byteSize: meta.byteSize, sha256: meta.sha256 };
  const timestamp = '2026-11-01T00:00:01.000Z';
  const action = (doc, type, statePatch) => reduceEditDocument(doc, {
    type, expectedRevision: doc.revision, expectedSource: srcIdentity, timestamp,
    ...(statePatch ? { state: statePatch } : {})
  });
  assert.equal(action(original, 'undo').status, 'unchanged');
  const unchanged = action(original, 'setState', state);
  assert.equal(unchanged.status, 'unchanged');
  assert.strictEqual(unchanged.document, original);
  const edits = { ...state, adjustments: { ...state.adjustments, exposureEV: 1 } };
  const modified = action(original, 'setState', edits);
  assert.equal(modified.status, 'applied');
  assert.equal(modified.document.revision, 8);
  assert.equal(modified.document.history.length, 2);
  const undone = action(modified.document, 'undo');
  assert.equal(undone.document.revision, 9);
  assert.deepEqual(undone.document.adjustments, state.adjustments);
  const redone = action(undone.document, 'redo');
  assert.equal(redone.document.revision, 10);
  assert.deepEqual(redone.document.adjustments, edits.adjustments);
  const rgba = makePatch([120, 120, 120, 255]);
  assert.deepEqual(
    renderer.renderRgba8(rgba, 7, 7, { adjustments: undone.document.adjustments }),
    renderer.renderRgba8(rgba, 7, 7, { adjustments: original.adjustments })
  );
  assert.deepEqual(
    renderer.renderRgba8(rgba, 7, 7, { adjustments: redone.document.adjustments }),
    renderer.renderRgba8(rgba, 7, 7, { adjustments: modified.document.adjustments })
  );
  assert.equal(action(original, 'setState', edits).document.revision, 8);
  assert.equal(reduceEditDocument(original, {
    type: 'undo', expectedRevision: 6, expectedSource: srcIdentity, timestamp
  }).status, 'conflict');
}

function testCrossProcessEpoch() {
  const root = join(testRoot, 'renderer-authority');
  mkdirSync(root);
  const storePath = join(root, 'sessions.json');
  const sourceBytes = Buffer.from('{"version":2,"sessions":[]}');
  writeFileSync(storePath, sourceBytes, { flag: 'wx' });
  const first = registerRenderer({ storePath, ...identity });
  assert.equal(first.epoch, 1);
  assert.equal(isCurrentRenderer({ storePath, token: first }), true);
  const childRoot = join(testRoot, 'child-home');
  mkdirSync(childRoot);
  const trustedModuleUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../server/renderer-authority.mjs')).href;
  const source = [
    "import { registerRenderer } from " + JSON.stringify(trustedModuleUrl) + ";",
    "const token = registerRenderer({ storePath: " + JSON.stringify(storePath) +
      ", sessionId: " + JSON.stringify(sessionId) + ", sourceSha256: " +
      JSON.stringify(srcSha) + ", revision: 7, pipelineId: 'm1-synthetic-renderer', sourceBuildHash: " +
      JSON.stringify(buildSha) + " });",
    "console.log(JSON.stringify(token));"
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, PORTRAIT_STUDIO_DATA_DIR: hostile,
      HOME: childRoot, USERPROFILE: childRoot,
      LOCALAPPDATA: join(childRoot, 'Local'), APPDATA: join(childRoot, 'Roaming') }
  });
  assert.equal(child.status, 0, child.stderr);
  const second = JSON.parse(child.stdout.trim());
  assert.equal(second.epoch, 2);
  assert.notEqual(second.rendererId, first.rendererId);
  assert.equal(isCurrentRenderer({ storePath, token: first }), false,
    'cross-process second mount invalidates older renderer');
  assert.equal(isCurrentRenderer({ storePath, token: second }), true);
  expectCode(() => assertCurrentRenderer({ storePath, token: first }), 'stale_renderer');
  assert.equal(assertCurrentRenderer({ storePath, token: second }), true);
  assert.equal(isCurrentRenderer({ storePath, token: { ...second, sourceBuildHash: 'c'.repeat(64) } }), false);
  assert.equal(isCurrentRenderer({ storePath, token: { ...second, revision: 8 } }), false);
  assert.equal(isCurrentRenderer({ storePath, token: { ...second, pipelineId: 'different' } }), false);
  assert.equal(isCurrentRenderer({ storePath, token: { ...second, sourceSha256: 'd'.repeat(64) } }), false);
  const lock = storePath + '.renderer-epoch.lock';
  writeFileSync(lock, 'synthetic busy lock', { flag: 'wx' });
  expectCode(() => registerRenderer({ storePath, ...identity }), 'renderer_authority_busy');
  assert.equal(readFileSync(lock, 'utf8'), 'synthetic busy lock');
  rmSync(lock);
  const third = registerRenderer({ storePath, ...identity });
  assert.equal(third.epoch, 3);
  assert.equal(isCurrentRenderer({ storePath, token: second }), false);
  assert.deepEqual(readFileSync(storePath), sourceBytes, 'session store must remain unchanged');
}


function testRendererCapacity() {
  const directory = join(testRoot, 'renderer-capacity');
  mkdirSync(directory);
  const storePath = join(directory, 'sessions.json');
  const original = Buffer.from('{"version":2,"sessions":[]}');
  writeFileSync(storePath, original, { flag: 'wx' });
  const identityAt = i => ({ ...identity, sessionId:
    '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0') });
  const existing = Array.from({ length: 20 }, (_, i) =>
    registerRenderer({ storePath, ...identityAt(i) }));
  const sidecar = storePath + '.renderer-epoch.json';
  const bytes = readFileSync(sidecar);
  const digest = sha256(bytes);
  const entries = readdirSync(directory).sort();
  expectCode(() => registerRenderer({ storePath, ...identityAt(20) }),
    'renderer_capacity');
  assert.deepEqual(readFileSync(sidecar), bytes);
  assert.equal(sha256(readFileSync(sidecar)), digest);
  assert.deepEqual(readdirSync(directory).sort(), entries);
  for (const token of existing)
    assert.equal(isCurrentRenderer({ storePath, token }), true);

  const replacement = registerRenderer({ storePath, ...identityAt(6) });
  assert.equal(replacement.epoch, existing[6].epoch + 1);
  assert.equal(isCurrentRenderer({ storePath, token: existing[6] }), false);
  assert.equal(isCurrentRenderer({ storePath, token: replacement }), true);
  const before = JSON.parse(bytes.toString('utf8')).sessions;
  const after = JSON.parse(readFileSync(sidecar, 'utf8')).sessions;
  assert.equal(Object.keys(after).length, 20);
  for (let i = 0; i < existing.length; i++) {
    if (i === 6) continue;
    assert.deepEqual(after[existing[i].sessionId], before[existing[i].sessionId]);
    assert.equal(isCurrentRenderer({ storePath, token: existing[i] }), true);
  }
  assert.deepEqual(readFileSync(storePath), original);

  const invalidDirectory = join(testRoot, 'renderer-overcapacity');
  mkdirSync(invalidDirectory);
  const invalidStore = join(invalidDirectory, 'sessions.json');
  writeFileSync(invalidStore, original, { flag: 'wx' });
  const invalidPath = invalidStore + '.renderer-epoch.json';
  const overCapacity = JSON.parse(bytes.toString('utf8'));
  overCapacity.sessions[identityAt(20).sessionId] = {
    ...existing[0], sessionId: identityAt(20).sessionId
  };
  const malformedBytes = Buffer.from(JSON.stringify(overCapacity));
  writeFileSync(invalidPath, malformedBytes, { flag: 'wx' });
  expectCode(() => registerRenderer({ storePath: invalidStore, ...identityAt(0) }),
    'renderer_capacity');
  assert.deepEqual(readFileSync(invalidPath), malformedBytes);
  assert.deepEqual(readFileSync(invalidStore), original);
}

try {
  mkdirSync(hostile);
  writeFileSync(sentinel, sentinelBytes, { flag: 'wx' });
  testRasterParity();
  testWhiteBalanceSampling();
  testDocumentHistory();
  testCrossProcessEpoch();
  testRendererCapacity();
  assert.deepEqual(readFileSync(sentinel), sentinelBytes);
  assert.deepEqual(readdirSync(hostile), ['sentinel.bin']);
  assert.doesNotMatch(readFileSync(join(root, 'server/index.mjs'), 'utf8'), /renderer-authority|shared-renderer/);
  assert.doesNotMatch(readFileSync(join(root, 'server/editor-state.mjs'), 'utf8'), /renderer-authority|shared-renderer/);
  assert.doesNotMatch(readFileSync(join(root, 'ui/studio.html'), 'utf8'), /shared-renderer/);
  console.log('M1-G2-PR4 neutral pixel, White Balance, history and cross-process renderer epoch tests passed.');
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
