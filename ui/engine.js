'use strict';

const PortraitStudioEngine = (() => {
  const MAX_INPUT_BYTES = 60 * 1024 * 1024;
  const MAX_PIXELS = 80_000_000;
  const MAX_PREVIEW_EDGE = 1400;

  function finite(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number))
      throw new TypeError(name + ' must be a finite number.');
    return number;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizeCrop(selection) {
    if (!selection || typeof selection !== 'object')
      throw new TypeError('Crop settings are required.');
    const x = clamp(finite(selection.x, 'x'), 0, 95);
    const y = clamp(finite(selection.y, 'y'), 0, 95);
    const width = clamp(finite(selection.width, 'width'), 5, 100 - x);
    const height = clamp(finite(selection.height, 'height'), 5, 100 - y);
    return {
      x: Number(x.toFixed(1)),
      y: Number(y.toFixed(1)),
      width: Number(width.toFixed(1)),
      height: Number(height.toFixed(1))
    };
  }

  function cropPixels(imageWidth, imageHeight, selection) {
    if (!Number.isSafeInteger(imageWidth) || imageWidth < 1 ||
        !Number.isSafeInteger(imageHeight) || imageHeight < 1)
      throw new RangeError('Image dimensions must be positive integers.');
    const crop = normalizeCrop(selection);
    const x = Math.min(imageWidth - 1, Math.round(crop.x * imageWidth / 100));
    const y = Math.min(imageHeight - 1, Math.round(crop.y * imageHeight / 100));
    const right = Math.min(imageWidth, Math.round((crop.x + crop.width) * imageWidth / 100));
    const bottom = Math.min(imageHeight, Math.round((crop.y + crop.height) * imageHeight / 100));
    return {
      x,
      y,
      width: Math.max(1, right - x),
      height: Math.max(1, bottom - y)
    };
  }

  function colorFilter(mode, intensity) {
    const amount = clamp(finite(intensity, 'intensity'), 0, 100) / 100;
    if (mode === 'mono')
      return 'grayscale(' + amount.toFixed(2) + ')';
    if (mode !== 'natural' && mode !== 'warm' && mode !== 'cool')
      throw new TypeError('Unknown color preset.');
    const saturation = mode === 'natural' ? 0.4 : 0.3;
    const contrast = mode === 'natural' ? 0.05 : 0;
    const brightness = mode === 'warm' ? 0.025 : 0;
    return 'saturate(' + (1 + saturation * amount).toFixed(2) + ')' +
      (contrast ? ' contrast(' + (1 + contrast * amount).toFixed(2) + ')' : '') +
      (brightness ? ' brightness(' + (1 + brightness * amount).toFixed(2) + ')' : '');
  }

  function colorOverlay(mode, intensity) {
    const amount = clamp(finite(intensity, 'intensity'), 0, 100) / 100;
    if (mode === 'warm')
      return { color: '255, 177, 112', alpha: Number((0.16 * amount).toFixed(3)) };
    if (mode === 'cool')
      return { color: '104, 160, 255', alpha: Number((0.13 * amount).toFixed(3)) };
    return null;
  }

  return Object.freeze({
    MAX_INPUT_BYTES,
    MAX_PIXELS,
    MAX_PREVIEW_EDGE,
    normalizeCrop,
    cropPixels,
    colorFilter,
    colorOverlay
  });
})();

if (typeof module !== 'undefined' && module.exports)
  module.exports = PortraitStudioEngine;
if (typeof window !== 'undefined')
  window.PortraitStudioEngine = PortraitStudioEngine;
