/**
 * Generates extension icons (16/32/48/128) without dependencies.
 * Design: YouTube-red rounded square, white play triangle, subtitle bars.
 * Run: node scripts/gen-icons.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- minimal PNG encoder -------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- shape helpers (normalized 0..1 coords) ------------------------------
function insideRoundedRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2;
  const hh = (y1 - y0) / 2;
  const dx = Math.max(Math.abs(px - cx) - (hw - r), 0);
  const dy = Math.max(Math.abs(py - cy) - (hh - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
}

// ---- icon design ----------------------------------------------------------
/** @returns {[number, number, number, number]} RGBA sample at a normalized point */
function sample(px, py) {
  const inBg = insideRoundedRect(px, py, 0.02, 0.02, 0.98, 0.98, 0.22);
  if (!inBg) return [0, 0, 0, 0];

  const inPlay = insideTriangle(px, py, 0.38, 0.24, 0.38, 0.60, 0.74, 0.42);
  const inBar1 = insideRoundedRect(px, py, 0.20, 0.70, 0.52, 0.80, 0.03);
  const inBar2 = insideRoundedRect(px, py, 0.58, 0.70, 0.80, 0.80, 0.03);

  if (inPlay || inBar1 || inBar2) return [255, 255, 255, 255];
  return [255, 0, 0, 255]; // YouTube red
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // supersamples per axis
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          const [sr, sg, sb, sa] = sample(px, py);
          const a = sa / 255;
          cov += a;
          r += sr * a;
          g += sg * a;
          b += sb * a;
        }
      }
      const i = (y * size + x) * 4;
      if (cov > 0) {
        rgba[i] = Math.round(r / cov);
        rgba[i + 1] = Math.round(g / cov);
        rgba[i + 2] = Math.round(b / cov);
      }
      rgba[i + 3] = Math.round((cov / (SS * SS)) * 255);
    }
  }
  return rgba;
}

// ---- main ------------------------------------------------------------------
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, size, render(size));
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log('wrote', file, `(${png.length} bytes)`);
}
