'use strict';

// M1-G2-PR4: isolated deterministic RGBA8 stage. The PRIVATE V0.2.8
// browser renderer does not import this module and remains unchanged.
const SharedRenderer = (() => {
  const Engine = typeof module !== 'undefined' && module.exports
    ? require('./engine.js') : window.PortraitStudioEngine;
  const identityGains = Object.freeze([1, 1, 1]);

  function assertPixels(pixels, width, height) {
    if (!(pixels instanceof Uint8ClampedArray) || !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        width * height > Engine.MAX_PIXELS || pixels.length !== width * height * 4)
      throw new TypeError('A full-sized Uint8ClampedArray RGBA8 raster is required.');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function linear(channel) {
    const x = channel / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }

  function srgb(value) {
    const x = clamp(value, 0, 1);
    return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  }

  function validateGains(gains) {
    if (!Array.isArray(gains) || gains.length !== 3 ||
        !gains.every(value => typeof value === 'number' && Number.isFinite(value) &&
          value >= 0.5 && value <= 2))
      throw new TypeError('White Balance gains must be three finite values in [0.5, 2].');
    return gains;
  }

  function median(values) {
    const ordered = [...values].sort((a, b) => a - b);
    const mid = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
  }

  function estimateWhiteBalance(source, width, height, point) {
    // point is the normalized location in the ORIGINAL decoded source,
    // not in a cropped, zoomed, preview or adjusted raster.
    assertPixels(source, width, height);
    if (!point || typeof point !== 'object' ||
        typeof point.x !== 'number' || typeof point.y !== 'number' ||
        !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)
      throw new TypeError('Eyedropper point must be normalized to [0, 1].');
    const centerX = Math.min(width - 1, Math.floor(point.x * width));
    const centerY = Math.min(height - 1, Math.floor(point.y * height));
    const samples = [[], [], []];
    let valid = 0;
    for (let y = Math.max(0, centerY - 2); y <= Math.min(height - 1, centerY + 2); y++) {
      for (let x = Math.max(0, centerX - 2); x <= Math.min(width - 1, centerX + 2); x++) {
        const i = (y * width + x) * 4;
        if (source[i + 3] < 128 || source[i] === 0 || source[i] === 255 ||
            source[i + 1] === 0 || source[i + 1] === 255 ||
            source[i + 2] === 0 || source[i + 2] === 255)
          continue;
        const rgb = [linear(source[i]), linear(source[i + 1]), linear(source[i + 2])];
        const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        if (luminance < 0.02 || luminance > 0.98)
          continue;
        rgb.forEach((value, channel) => samples[channel].push(value));
        valid++;
      }
    }
    if (valid < 9)
      throw new RangeError('Eyedropper requires at least nine safe source samples.');
    const medians = samples.map(median);
    const mad = samples.map((values, channel) =>
      median(values.map(value => Math.abs(value - medians[channel]))));
    if (mad.some(value => value > 0.04) || Math.min(...medians) <= 0 ||
        Math.max(...medians) / Math.min(...medians) > 4)
      throw new RangeError('Eyedropper sample is mixed-edge or chromatically unreliable.');
    const neutral = (medians[0] * medians[1] * medians[2]) ** (1 / 3);
    const gains = medians.map(value => clamp(neutral / value, 0.5, 2));
    if (!gains.every(Number.isFinite))
      throw new RangeError('Eyedropper produced invalid gains.');
    return Object.freeze({
      gains: Object.freeze(gains),
      point: Object.freeze({ x: point.x, y: point.y }),
      validPixels: valid
    });
  }

  function validateLayers(layers, size) {
    if (!Array.isArray(layers) || layers.length > 32)
      throw new TypeError('Layers must be an array of at most 32 raster layers.');
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object' ||
          !(layer.rgba8 instanceof Uint8ClampedArray) ||
          layer.rgba8.length !== size * 4 ||
          !Array.isArray(layer.mask) && !(layer.mask instanceof Float64Array) ||
          layer.mask.length !== size ||
          !layer.mask.every(value => typeof value === 'number' && Number.isFinite(value) &&
            value >= 0 && value <= 1) ||
          typeof layer.opacity !== 'number' || !Number.isFinite(layer.opacity) ||
          layer.opacity < 0 || layer.opacity > 1)
        throw new TypeError('A layer needs same-sized RGBA8, normalized mask and opacity.');
    }
  }

  function renderRgba8(postCanvasPixels, width, height, options = {}) {
    // Caller provides crop/scale Canvas RGBA8. Legacy adjustment uses exactly
    // one existing V0.2.8 operation; clone strokes are caller-owned and must
    // already be applied if WB/layers follow the clone stage.
    assertPixels(postCanvasPixels, width, height);
    const gains = validateGains(options.gains ?? identityGains);
    const layers = options.layers ?? [];
    validateLayers(layers, width * height);
    const result = Uint8ClampedArray.from(postCanvasPixels);
    Engine.applyColorAdjustments(result, options.adjustments ?? Engine.DEFAULT_ADJUSTMENTS);
    // Neutral M1 controls must not add a Canvas round-trip or one more byte
    // quantization pass: this branch is exactly the old legacy byte path.
    if (layers.length === 0 && gains.every(value => value === 1))
      return result;
    for (let i = 0; i < result.length; i += 4) {
      const current = [linear(result[i]) * gains[0],
        linear(result[i + 1]) * gains[1], linear(result[i + 2]) * gains[2]];
      for (const layer of layers) {
        const pixel = i / 4;
        const weight = layer.opacity * layer.mask[pixel] * (layer.rgba8[i + 3] / 255);
        if (weight === 0)
          continue;
        for (let channel = 0; channel < 3; channel++)
          current[channel] = current[channel] * (1 - weight) +
            linear(layer.rgba8[i + channel]) * weight;
      }
      // Only this final assignment rounds an active M1 operation to RGBA8.
      for (let channel = 0; channel < 3; channel++)
        result[i + channel] = srgb(current[channel]);
      // Existing alpha remains untouched by M1 white balance and layers.
    }
    return result;
  }

  return Object.freeze({ identityGains, estimateWhiteBalance, renderRgba8 });
})();

if (typeof module !== 'undefined' && module.exports)
  module.exports = SharedRenderer;
if (typeof window !== 'undefined')
  window.PortraitStudioSharedRenderer = SharedRenderer;
