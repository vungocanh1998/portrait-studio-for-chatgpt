import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditorSessions } from '../server/editor-state.mjs';
import Engine from '../ui/engine.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = mkdtempSync(join(root, '.editor-state-test-'));
assert.ok(resolve(tempDir).startsWith(root + sep));

try {
  const filePath = join(tempDir, 'sessions.json');
  let sessions = new EditorSessions({ filePath });
  const opened = sessions.create();
  assert.equal(opened.revision, 0);
  assert.equal(opened.source, null);
  assert.equal(opened.preview.status, 'awaiting_source');

  const source = {
    fileName: 'synthetic.png',
    mimeType: 'image/png',
    width: 32,
    height: 32,
    byteSize: 128,
    sha256: 'a'.repeat(64)
  };
  const bound = sessions.bindSource(opened.sessionId, 0, source);
  assert.equal(bound.revision, 1);
  assert.equal(bound.source.sha256, source.sha256);

  const adjusted = sessions.setColorAdjustments(opened.sessionId, 1, {
    exposureEV: 0.3,
    highlights: -20
  });
  assert.equal(adjusted.revision, 2);
  assert.equal(adjusted.adjustments.exposureEV, 0.3);
  assert.equal(adjusted.adjustments.highlights, -20);

  const stale = sessions.setColorAdjustments(opened.sessionId, 1, { exposureEV: -1 });
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.revision, 2);
  assert.equal(stale.adjustments.exposureEV, 0.3);

  const resetHighlight = sessions.resetAdjustments(opened.sessionId, 2, ['highlights']);
  assert.equal(resetHighlight.revision, 3);
  assert.equal(resetHighlight.adjustments.highlights, 0);
  assert.equal(resetHighlight.adjustments.exposureEV, 0.3, 'resetting one named field must retain other color adjustments');

  const cropped = sessions.setCrop(opened.sessionId, 3, { aspectRatio: '4:5' });
  const pixels = Engine.cropPixels(source.width, source.height, cropped.crop);
  assert.equal(cropped.crop.aspectRatio, '4:5');
  assert.ok(Math.abs(pixels.width / pixels.height - 0.8) <= 1 / pixels.height);

  const reset = sessions.resetAdjustments(opened.sessionId, 4, ['color']);
  assert.equal(reset.revision, 5);
  assert.deepEqual(reset.adjustments, Engine.DEFAULT_ADJUSTMENTS);
  assert.deepEqual(reset.crop, cropped.crop, 'resetting color must keep the crop');

  const undone = sessions.undo(opened.sessionId, 5);
  assert.equal(undone.revision, 6);
  assert.equal(undone.adjustments.exposureEV, 0.3);
  assert.equal(undone.crop.aspectRatio, '4:5');
  const redone = sessions.redo(opened.sessionId, 6);
  assert.equal(redone.revision, 7);
  assert.deepEqual(redone.adjustments, Engine.DEFAULT_ADJUSTMENTS);

  const cropPixels = Engine.cropPixels(source.width, source.height, redone.crop);
  const rendered = sessions.confirmPreview(
    opened.sessionId,
    7,
    'b0000000-0000-4000-8000-000000000000',
    source.sha256,
    cropPixels.width,
    cropPixels.height,
    'c'.repeat(64)
  );
  assert.equal(rendered.preview.status, 'confirmed');
  assert.equal(rendered.preview.revision, 7);
  assert.deepEqual(
    sessions.prepareExport(opened.sessionId, 7, 'b0000000-0000-4000-8000-000000000000', cropPixels.width, cropPixels.height),
    { sessionId: opened.sessionId, revision: 7, width: cropPixels.width, height: cropPixels.height }
  );
  const saved = sessions.recordExport(opened.sessionId, 7, 'b0000000-0000-4000-8000-000000000000', {
    path: join(tempDir, 'edited.png'),
    fileName: 'edited.png',
    width: cropPixels.width,
    height: cropPixels.height,
    bytes: 128,
    sha256: 'd'.repeat(64),
    pixelSha256: 'e'.repeat(64)
  });
  assert.equal(saved.export.status, 'saved');
  assert.equal(saved.export.revision, 7);

  const resumed = sessions.resume(opened.sessionId);
  assert.equal(resumed.revision, 7, 'resume must preserve the edit revision');
  assert.equal(resumed.preview.status, 'confirmed', 'resume must preserve a valid confirmation for the unchanged revision');
  assert.equal(resumed.preview.rendererId, 'b0000000-0000-4000-8000-000000000000');
  assert.equal(resumed.export.status, 'saved', 'resume must preserve a verified export');

  const restored = new EditorSessions({ filePath }).getState(opened.sessionId);
  assert.equal(restored.revision, 7);
  assert.equal(restored.source.sha256, source.sha256);
  assert.equal(restored.adjustments.exposureEV, 0);
  assert.equal(restored.export.sha256, 'd'.repeat(64));
  const listed = sessions.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sessionId, opened.sessionId);
  assert.equal(JSON.stringify(listed).includes('imageBytes'), false);

  assert.throws(() => sessions.setColorAdjustments(opened.sessionId, 7, { exposureEV: 6 }), /exposureEV/);
  assert.throws(() => sessions.bindSource(opened.sessionId, 7, { ...source, sha256: 'bad' }), /SHA-256/);
  const stalePreview = sessions.confirmPreview(opened.sessionId, 5, 'b0000000-0000-4000-8000-000000000000', source.sha256, 1, 1, 'c'.repeat(64));
  assert.equal(stalePreview.status, 'conflict');
} finally {
  assert.ok(resolve(tempDir).startsWith(root + sep));
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('Portrait Studio editor-session checks passed.');

