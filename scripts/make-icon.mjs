// Generates the app icon (build/icon.png + build/icon.ico) with no dependencies: a rounded ink square with
// an amber "C" and a small waveform. Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const AMBER = [244, 183, 64];
const AMBER_LIGHT = [255, 217, 138];
const INK_TOP = [22, 27, 38];
const INK_BOTTOM = [10, 12, 17];
const EDGE = [42, 50, 68];

const len = (x, y) => Math.hypot(x, y);

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundedRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Colour of the artwork at unit coordinates (u, v), or null when transparent. */
function sample(u, v) {
  const d = roundedRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.22);
  if (d > 0) return null;

  // "C": a thick ring open towards the right, with round caps.
  const dx = u - 0.5;
  const dy = v - 0.5;
  const rho = len(dx, dy);
  const gap = (38 * Math.PI) / 180;
  const theta = Math.atan2(dy, dx);
  const rMid = 0.245;
  const half = 0.058;
  if (Math.abs(rho - rMid) <= half && Math.abs(theta) > gap) return AMBER;
  for (const s of [-1, 1]) {
    const cx = 0.5 + rMid * Math.cos(gap) ;
    const cy = 0.5 + s * rMid * Math.sin(gap);
    if (len(u - cx, v - cy) <= half) return AMBER;
  }

  // Three rounded bars: a tiny voice waveform inside the C.
  for (const [bx, h] of [[0.43, 0.13], [0.5, 0.26], [0.57, 0.13]]) {
    const bd = roundedRect(u, v, bx, 0.5, 0.019, h / 2, 0.019);
    if (bd <= 0) return AMBER_LIGHT;
  }

  if (d > -0.012) return EDGE;
  const t = v;
  return INK_TOP.map((c, i) => Math.round(c + (INK_BOTTOM[i] - c) * t));
}

/** Render at `size` px with 4x4 supersampling; returns non-premultiplied RGBA. */
function render(size) {
  const k = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < k; sy++) {
        for (let sx = 0; sx < k; sx++) {
          const c = sample((x + (sx + 0.5) / k) / size, (y + (sy + 0.5) / k) / size);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 1;
          }
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        buf[o] = Math.round(r / a);
        buf[o + 1] = Math.round(g / a);
        buf[o + 2] = Math.round(b / a);
        buf[o + 3] = Math.round((a / (k * k)) * 255);
      }
    }
  }
  return buf;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...images.map((i) => i.data)]);
}

mkdirSync(OUT, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, data: png(size, render(size)) }));
writeFileSync(join(OUT, 'icon.ico'), ico(images));
writeFileSync(join(OUT, 'icon.png'), png(512, render(512)));
console.log('wrote build/icon.ico (%s) and build/icon.png (512x512)', sizes.join(', '));
