'use strict';

// Renders a "sync" glyph (two circular arrows, the universal refresh/sync
// symbol) as a solid-color PNG -- pure pixel math + Node's built-in zlib,
// no image/canvas library. Supersampled 4x then box-downsampled for
// anti-aliased edges at tray-icon size.

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(pixels, size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixels[y * size + x];
      const o = rowStart + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit depth, RGBA color type
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function angleDelta(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// One arc of the sync glyph: a ring segment from `start` to `end` degrees,
// with a triangular arrowhead at the `end`.
function arcCoverage(px, py, cx, cy, radius, thickness, start, end, arrowSize) {
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;

  const within = (a, s, e) => {
    const span = ((e - s) % 360 + 360) % 360;
    const rel = ((a - s) % 360 + 360) % 360;
    return rel <= span;
  };

  if (within(angle, start, end) && Math.abs(dist - radius) <= thickness / 2) return true;

  // arrowhead: a triangle centered on `end`, widening as it nears the tip radius
  const tipDelta = angleDelta(angle, end);
  const arrowAngularWidth = (arrowSize / radius) * (180 / Math.PI) * 1.8;
  if (tipDelta <= arrowAngularWidth) {
    const taper = 1 - tipDelta / arrowAngularWidth;
    const halfBand = (thickness / 2) + arrowSize * taper;
    if (Math.abs(dist - radius) <= halfBand) return true;
  }
  return false;
}

function renderSyncGlyph(rgb, size) {
  const SS = 4; // supersampling factor
  const big = size * SS;
  const cx = big / 2;
  const cy = big / 2;
  const radius = big * 0.32;
  const thickness = big * 0.11;
  const arrowSize = big * 0.09;

  const bigPixels = new Array(big * big);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const hit = arcCoverage(x, y, cx, cy, radius, thickness, 15, 165, arrowSize)
        || arcCoverage(x, y, cx, cy, radius, thickness, 195, 345, arrowSize);
      bigPixels[y * big + x] = hit ? [...rgb, 255] : [0, 0, 0, 0];
    }
  }

  // box downsample for anti-aliasing
  const pixels = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = bigPixels[(y * SS + sy) * big + (x * SS + sx)];
          r += p[0]; g += p[1]; b += p[2]; a += p[3];
        }
      }
      const n = SS * SS;
      pixels[y * size + x] = [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];
    }
  }
  return encodePng(pixels, size);
}

function dataUrl(rgb) {
  return `data:image/png;base64,${renderSyncGlyph(rgb, 32).toString('base64')}`;
}

module.exports = {
  green: dataUrl([48, 209, 88]),
  yellow: dataUrl([255, 190, 10]),
  gray: dataUrl([142, 142, 147]),
};
