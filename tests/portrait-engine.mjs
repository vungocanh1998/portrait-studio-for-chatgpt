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
  height: 100
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
  height: 5
});
assert.equal(engine.colorFilter('natural', 100), 'saturate(1.40) contrast(1.05)');
assert.equal(engine.colorFilter('mono', 50), 'grayscale(0.50)');
assert.throws(() => engine.cropPixels(0, 3000, { x: 0, y: 0, width: 100, height: 100 }), RangeError);
assert.throws(() => engine.normalizeCrop({ x: Number.NaN, y: 0, width: 100, height: 100 }), TypeError);

console.log('Portrait image-engine checks passed.');
