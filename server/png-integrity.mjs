import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

// PR5 inactive PNG byte/pixel verifier. Mirrors the supported V0.2.8 8-bit
// truecolor/RGBA export path without importing or changing server/index.mjs.
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxBytes = 256 * 1024 * 1024;
const maxPixels = 80_000_000;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function invalid(message) {
  throw new TypeError('Invalid PR5 PNG: ' + message);
}

export function inspectPng(bytes, expectedWidth, expectedHeight) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(expectedWidth) ||
      !Number.isSafeInteger(expectedHeight) || expectedWidth < 1 ||
      expectedHeight < 1 || expectedWidth * expectedHeight > maxPixels ||
      bytes.length < 57 || bytes.length > maxBytes ||
      !bytes.subarray(0, 8).equals(signature))
    invalid('invalid input, dimensions or signature.');
  let offset = 8, header = null, seenIdat = false, idatEnded = false, ended = false;
  const fragments = [];
  let compressedBytes = 0;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length)
      invalid('truncated chunk.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(end - 4))
      invalid('CRC mismatch.');
    if (!header && type !== 'IHDR')
      invalid('missing IHDR.');
    if (type === 'IHDR') {
      if (header || offset !== 8 || length !== 13)
        invalid('duplicate or malformed IHDR.');
      const width = payload.readUInt32BE(0), height = payload.readUInt32BE(4);
      if (width !== expectedWidth || height !== expectedHeight ||
          payload[8] !== 8 || ![2, 6].includes(payload[9]) ||
          payload[10] !== 0 || payload[11] !== 0 || payload[12] !== 0)
        invalid('unsupported pixel dimensions, format or interlace.');
      header = { width, height, channels: payload[9] === 6 ? 4 : 3 };
    } else if (type === 'IDAT') {
      if (idatEnded)
        invalid('noncontiguous IDAT.');
      seenIdat = true;
      compressedBytes += length;
      if (compressedBytes > maxBytes)
        invalid('compressed data too large.');
      fragments.push(payload);
    } else if (type === 'IEND') {
      if (!seenIdat || length !== 0)
        invalid('bad IEND.');
      ended = true;
      offset = end;
      break;
    } else {
      if (seenIdat)
        idatEnded = true;
      // Reject unrecognized critical chunks and transparency that would
      // make a truecolor RGB pixel hash silently drop alpha semantics.
      if ((type.charCodeAt(0) & 32) === 0 || type === 'tRNS')
        invalid('unsupported PNG chunk.');
    }
    offset = end;
  }
  if (!ended || offset !== bytes.length || !header)
    invalid('missing end marker or trailing bytes.');
  const rowBytes = header.width * header.channels;
  const inflatedLength = (rowBytes + 1) * header.height;
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(fragments, compressedBytes),
      { maxOutputLength: inflatedLength });
  } catch {
    invalid('invalid compressed pixel data.');
  }
  if (decoded.length !== inflatedLength)
    invalid('unexpected decoded pixel length.');
  const pixels = createHash('sha256');
  let previous = Buffer.alloc(rowBytes), current = Buffer.alloc(rowBytes);
  const rgbaRow = header.channels === 4 ? null : Buffer.alloc(header.width * 4);
  for (let row = 0; row < header.height; row++) {
    const start = row * (rowBytes + 1);
    const filter = decoded[start];
    if (filter > 4)
      invalid('unsupported row filter.');
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= header.channels ? current[i - header.channels] : 0;
      const above = row ? previous[i] : 0;
      const upperLeft = row && i >= header.channels ? previous[i - header.channels] : 0;
      const estimate = left + above - upperLeft;
      const da = Math.abs(estimate - left);
      const db = Math.abs(estimate - above);
      const dc = Math.abs(estimate - upperLeft);
      const predictor = filter === 1 ? left : filter === 2 ? above :
        filter === 3 ? Math.floor((left + above) / 2) :
          filter === 4 ? (da <= db && da <= dc ? left : db <= dc ? above : upperLeft) : 0;
      current[i] = (decoded[start + i + 1] + predictor) & 255;
    }
    if (header.channels === 4) {
      pixels.update(current);
    } else {
      for (let x = 0; x < header.width; x++) {
        rgbaRow[x * 4] = current[x * 3];
        rgbaRow[x * 4 + 1] = current[x * 3 + 1];
        rgbaRow[x * 4 + 2] = current[x * 3 + 2];
        rgbaRow[x * 4 + 3] = 255;
      }
      pixels.update(rgbaRow);
    }
    [previous, current] = [current, previous];
  }
  return Object.freeze({
    width: header.width, height: header.height,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pixelSha256: pixels.digest('hex')
  });
}
