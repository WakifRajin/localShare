#!/usr/bin/env node
'use strict';
/**
 * Generates the app icons (docs/icon-192.png, docs/icon-512.png) with no dependencies:
 * a green gradient square with the localShare "signal" mark, rasterised analytically.
 *   node scripts/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size * 0.66, th = size * 0.055;
  const radii = [size * 0.15, size * 0.27, size * 0.39];
  const half = (52 * Math.PI) / 180;
  const SS = 3; // supersampling
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let glyph = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      const dx = px - cx, dy = cy - py, r = Math.hypot(dx, dy), ang = Math.abs(Math.atan2(dx, dy));
      let cov = 0;
      for (const R of radii) if (ang <= half && Math.abs(r - R) <= th / 2) cov = 1;
      if (Math.hypot(px - cx, py - (cy + size * 0.1)) <= size * 0.052) cov = 1;
      glyph += cov;
    }
    glyph /= SS * SS;
    const t = (x + y) / (2 * size);                       // diagonal gradient
    const bg = [mix(0x34, 0x0d, t), mix(0xd3, 0x94, t), mix(0x99, 0x67, t)];
    const fg = [0x03, 0x14, 0x0d];
    const i = (y * size + x) * 4;
    buf[i] = mix(bg[0], fg[0], glyph); buf[i + 1] = mix(bg[1], fg[1], glyph); buf[i + 2] = mix(bg[2], fg[2], glyph); buf[i + 3] = 255;
  }
  return buf;
}

const out = path.join(__dirname, '..', 'docs');
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size, render(size)));
  console.log(`wrote docs/icon-${size}.png`);
}
