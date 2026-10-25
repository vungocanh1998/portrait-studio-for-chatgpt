import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = require(resolve(root, 'ui/engine.js'));

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

console.log('Portrait image-engine checks passed.');
