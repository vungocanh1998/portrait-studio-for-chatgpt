'use strict';

const { Document } = require('/document.js');

function read(getter, fallback = 'Unavailable') {
  try {
    const value = getter();
    return value == null || value === '' ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function formatBitDepth(format) {
  if (/RGBAUF|floating/i.test(format))
    return 'floating-point (inferred from format token)';
  if (/(?:RGBA|IA|LABA|CMYKA|M)16|16bpc/i.test(format))
    return '16-bit (inferred from format token)';
  if (/(?:RGBA|IA|CMYKA|M)8|8bpc/i.test(format))
    return '8-bit (inferred from format token)';
  return 'Unknown — verify in Document Setup';
}

function main() {
  const doc = Document.current;
  if (!doc) {
    alert('No open document.');
    return;
  }

  const path = String(read(() => doc.path, ''));
  const fileName = path ? path.split(/[\\/]/).pop() : 'Unsaved document';
  const extension = (fileName.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const format = String(read(() => doc.format));
  const dpi = String(read(() => doc.dpi));
  const profile = String(read(() => doc.colourProfile.name));
  const dirty = String(read(() => doc.isDirty));
  const bounds = read(() => doc.currentSpread.getSpreadBaseBox(), null);
  const dimensions = bounds
    ? `${Math.round(bounds.width)} × ${Math.round(bounds.height)} document units`
    : 'Unavailable';

  const lines = [
    'APS Quality Guard (read-only)',
    `File: ${fileName}`,
    `Format: ${format}`,
    `Bit depth: ${formatBitDepth(format)}`,
    `ICC/profile: ${profile}`,
    `DPI: ${dpi}`,
    `Canvas bounds: ${dimensions}`,
    `Unsaved changes: ${dirty}`
  ];

  if (extension === '.cr3')
    lines.push('RAW source detected: this check made no changes. Use a separate .afphoto working copy for edits.');
  if (extension !== '.afphoto' && extension !== '.cr3')
    lines.push('For editing scripts, save a separate .afphoto working copy first.');

  const report = lines.join('\n');
  console.log(report);
  alert(report);
}

main();
