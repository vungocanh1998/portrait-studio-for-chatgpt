import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = require(resolve(root, 'ui/engine.js'));
const fixture = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/m1-g2-pr1.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

assert.deepEqual(engine.normalizeCrop({ x: 0, y: 0, width: 100, height: 100 }), {
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  aspectRatio: 'free'
});
assert.deepEqual(engine.cropPixels(4000, 3000, { x: 10, y: 20, width: 50, height: 40 }), {
  x: 400,
  y: 600,
  width: 2000,
  height: 1200
});
assert.deepEqual(engine.normalizeCrop({ x: 99, y: 99, width: 0, height: 0 }), {
  x: 95,
  y: 95,
  width: 5,
  height: 5,
  aspectRatio: 'free'
});
assert.deepEqual(engine.normalizeAdjustments({ exposureEV: 0.3 }), {
  exposureEV: 0.3,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0
});
const exposed = new Uint8ClampedArray([100, 80, 60, 77]);
engine.applyColorAdjustments(exposed, { ...engine.DEFAULT_ADJUSTMENTS, exposureEV: 1 });
assert.deepEqual(Array.from(exposed), [200, 160, 120, 77]);
const unchanged = new Uint8ClampedArray([100, 80, 60, 77]);
engine.applyColorAdjustments(unchanged, engine.DEFAULT_ADJUSTMENTS);
assert.deepEqual(Array.from(unchanged), [100, 80, 60, 77]);
const warm = engine.presetAdjustments('warm', 50);
assert.equal(warm.temperature, 11);
assert.throws(() => engine.normalizeAdjustments({ exposureEV: 5.1 }), RangeError);
assert.throws(() => engine.normalizeAdjustments({ mystery: 1 }), TypeError);
const ratioCrop = engine.normalizeCrop({ x: 0, y: 0, width: 100, height: 100, aspectRatio: '4:5' }, 400, 500);
assert.deepEqual(engine.cropPixels(400, 500, ratioCrop), { x: 0, y: 0, width: 400, height: 500 });
assert.throws(() => engine.cropPixels(0, 3000, { x: 0, y: 0, width: 100, height: 100 }), RangeError);
assert.throws(() => engine.normalizeCrop({ x: Number.NaN, y: 0, width: 100, height: 100 }), TypeError);

const sourcePixels = Buffer.from(fixture.source.rgba8);
const sourceHash = sha256(sourcePixels);
assert.equal(sourceHash, fixture.source.rgba8Sha256);
const nativeCrop = engine.cropPixels(fixture.source.width, fixture.source.height, fixture.crop.selection);
assert.deepEqual(nativeCrop, fixture.crop.bounds);
const croppedPixels = [];
for (let y = nativeCrop.y; y < nativeCrop.y + nativeCrop.height; y++) {
  const start = (y * fixture.source.width + nativeCrop.x) * 4;
  const end = start + nativeCrop.width * 4;
  croppedPixels.push(...fixture.source.rgba8.slice(start, end));
}
assert.deepEqual(croppedPixels, fixture.crop.rgba8);
assert.equal(sha256(Buffer.from(croppedPixels)), fixture.crop.rgba8Sha256);
const nativeCropLegacyPixels = Uint8ClampedArray.from(croppedPixels);
engine.applyColorAdjustments(nativeCropLegacyPixels, fixture.legacy.adjustments);
assert.deepEqual(Array.from(nativeCropLegacyPixels), fixture.crop.legacyRgba8);
assert.equal(sha256(Buffer.from(nativeCropLegacyPixels)), fixture.crop.legacyRgba8Sha256);

const legacyPixels = Uint8ClampedArray.from(sourcePixels);
engine.applyColorAdjustments(legacyPixels, fixture.legacy.adjustments);
assert.deepEqual(Array.from(legacyPixels), fixture.legacy.rgba8);
assert.equal(sha256(Buffer.from(legacyPixels)), fixture.legacy.rgba8Sha256);
assert.equal(sha256(sourcePixels), sourceHash, 'legacy rendering must leave synthetic source RGBA8 bytes unchanged');

assert.equal(fixture.futureWhiteBalanceContract.implemented, false);
assert.equal(fixture.futureWhiteBalanceContract.neutralInputSha256, fixture.crop.legacyRgba8Sha256);
assert.equal(fixture.futureWhiteBalanceContract.neutralOutputSha256, fixture.crop.legacyRgba8Sha256);
assert.equal(fixture.futureRendererContract.implemented, false);
assert.deepEqual(
  [...Object.keys(fixture.futureRendererContract.accepted)].sort(),
  [...fixture.futureRendererContract.requiredIdentityFields].sort()
);
for (const stale of fixture.futureRendererContract.staleVariants) {
  assert.ok(fixture.futureRendererContract.requiredIdentityFields.includes(stale.field));
  assert.notEqual(stale.value, fixture.futureRendererContract.accepted[stale.field]);
}
assert.deepEqual(
  [...fixture.futureRendererContract.staleVariants.map(({ field }) => field)].sort(),
  [...fixture.futureRendererContract.requiredIdentityFields].sort()
);

console.log('Portrait image-engine checks passed.');
