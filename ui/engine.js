'use strict';

const PortraitStudioEngine = (() => {
  const MAX_INPUT_BYTES = 60 * 1024 * 1024;
  const MAX_PIXELS = 80_000_000;
  const MAX_PREVIEW_EDGE = 1400;
  const DEFAULT_ADJUSTMENTS = Object.freeze({ exposureEV: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, vibrance: 0, saturation: 0 });
  const adjustmentRanges = Object.freeze({ exposureEV: [-5, 5], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100], temperature: [-100, 100], tint: [-100, 100], vibrance: [-100, 100], saturation: [-100, 100] });
  const presets = Object.freeze({
    natural: { contrast: 8, vibrance: 12, saturation: 3 },
    warm: { temperature: 22, tint: 2, vibrance: 8 },
    cool: { temperature: -18, tint: -2, vibrance: 8 },
    monochrome: { contrast: 8, saturation: -100 }
  });
  const aspectRatios = Object.freeze({ free: null, '1:1': 1, '4:5': 4 / 5, '5:4': 5 / 4, '3:2': 3 / 2, '2:3': 2 / 3, '16:9': 16 / 9, '9:16': 9 / 16, '3:4': 3 / 4, '4:3': 4 / 3 });

  function finite(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number))
      throw new TypeError(name + ' must be a finite number.');
    return number;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizeAdjustments(patch, base = DEFAULT_ADJUSTMENTS) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new TypeError('Color adjustments must be an object.');
    if (Object.keys(patch).some((key) => !Object.hasOwn(adjustmentRanges, key)))
      throw new TypeError('Unknown color adjustment.');
    const result = { ...DEFAULT_ADJUSTMENTS, ...base };
    for (const [key, value] of Object.entries(patch)) {
      const number = finite(value, key);
      const [minimum, maximum] = adjustmentRanges[key];
      if (number < minimum || number > maximum)
        throw new RangeError(key + ' must be between ' + minimum + ' and ' + maximum + '.');
      result[key] = Number(number.toFixed(key === 'exposureEV' ? 2 : 1));
    }
    return result;
  }

  function presetAdjustments(name, intensity = 100) {
    if (!Object.hasOwn(presets, name))
      throw new TypeError('Unknown color preset.');
    const amount = finite(intensity, 'intensity');
    if (amount < 0 || amount > 100)
      throw new RangeError('Intensity must be between 0 and 100.');
    const scale = amount / 100;
    return normalizeAdjustments(Object.fromEntries(Object.entries(presets[name]).map(([key, value]) => [key, value * scale])));
  }

  function normalizeCrop(selection, imageWidth, imageHeight) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection))
      throw new TypeError('Crop settings are required.');
    const hasDimensions = imageWidth !== undefined || imageHeight !== undefined;
    if (hasDimensions && (!Number.isSafeInteger(imageWidth) || imageWidth < 1 || !Number.isSafeInteger(imageHeight) || imageHeight < 1))
      throw new RangeError('Image dimensions must be positive integers.');
    const aspectRatio = selection.aspectRatio || 'free';
    if (!Object.hasOwn(aspectRatios, aspectRatio))
      throw new TypeError('Unknown crop aspect ratio.');
    if (aspectRatios[aspectRatio] !== null && !hasDimensions)
      throw new TypeError('Image dimensions are required for a fixed crop ratio.');
    const minimumWidth = hasDimensions ? 100 / imageWidth : 5;
    const minimumHeight = hasDimensions ? 100 / imageHeight : 5;
    let x = clamp(finite(selection.x, 'x'), 0, 100 - minimumWidth);
    let y = clamp(finite(selection.y, 'y'), 0, 100 - minimumHeight);
    let width = clamp(finite(selection.width, 'width'), minimumWidth, 100 - x);
    let height = clamp(finite(selection.height, 'height'), minimumHeight, 100 - y);
    if (aspectRatios[aspectRatio] !== null) {
      const target = aspectRatios[aspectRatio];
      const current = width * imageWidth / (height * imageHeight);
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      if (current > target)
        width = height * imageHeight * target / imageWidth;
      else
        height = width * imageWidth / target / imageHeight;
      if (width < minimumWidth || height < minimumHeight)
        throw new RangeError('The requested crop ratio cannot fit inside this image.');
      x = clamp(centerX - width / 2, 0, 100 - width);
      y = clamp(centerY - height / 2, 0, 100 - height);
    }
    return { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)), width: Number(width.toFixed(4)), height: Number(height.toFixed(4)), aspectRatio };
  }

  function cropPixels(imageWidth, imageHeight, selection) {
    if (!Number.isSafeInteger(imageWidth) || imageWidth < 1 ||
        !Number.isSafeInteger(imageHeight) || imageHeight < 1)
      throw new RangeError('Image dimensions must be positive integers.');
    const crop = normalizeCrop(selection, imageWidth, imageHeight);
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

  function applyColorAdjustments(pixels, values) {
    if (!(pixels instanceof Uint8ClampedArray) || pixels.length % 4 !== 0)
      throw new TypeError('RGBA pixel data is required.');
    const adjustments = normalizeAdjustments(values);
    const exposure = 2 ** adjustments.exposureEV;
    const contrast = 1 + adjustments.contrast / 100;
    const saturation = 1 + adjustments.saturation / 100;
    const vibrance = adjustments.vibrance / 100;
    const temperature = adjustments.temperature * 0.3;
    const tint = adjustments.tint * 0.12;
    for (let i = 0; i < pixels.length; i += 4) {
      let red = 127.5 + (pixels[i] * exposure - 127.5) * contrast;
      let green = 127.5 + (pixels[i + 1] * exposure - 127.5) * contrast;
      let blue = 127.5 + (pixels[i + 2] * exposure - 127.5) * contrast;
      const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
      const tonal = (1 - luminance) ** 2 * adjustments.shadows * 0.8 + luminance ** 2 * adjustments.highlights * 0.8;
      red += tonal + temperature + tint;
      green += tonal - tint * 2;
      blue += tonal - temperature + tint;
      const range = Math.max(red, green, blue) - Math.min(red, green, blue);
      const factor = saturation * (1 + vibrance * (1 - range / 255));
      const adjustedLuminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      pixels[i] = adjustedLuminance + (red - adjustedLuminance) * factor;
      pixels[i + 1] = adjustedLuminance + (green - adjustedLuminance) * factor;
      pixels[i + 2] = adjustedLuminance + (blue - adjustedLuminance) * factor;
    }
    return pixels;
  }

  return Object.freeze({
    MAX_INPUT_BYTES,
    MAX_PIXELS,
    MAX_PREVIEW_EDGE,
    DEFAULT_ADJUSTMENTS,
    adjustmentRanges,
    presetNames: Object.freeze(Object.keys(presets)),
    aspectRatioNames: Object.freeze(Object.keys(aspectRatios)),
    normalizeAdjustments,
    presetAdjustments,
    normalizeCrop,
    cropPixels,
    applyColorAdjustments
  });
})();

if (typeof module !== 'undefined' && module.exports)
  module.exports = PortraitStudioEngine;
if (typeof window !== 'undefined')
  window.PortraitStudioEngine = PortraitStudioEngine;
