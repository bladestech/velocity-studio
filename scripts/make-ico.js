// Builds build/icon.ico from src/icon.png.
// Windows only reliably loads PNG-compressed icon images at 256x256, so every smaller size is stored as a
// classic 32-bit BMP (DIB) image. (electron-builder's own converter writes PNG for all sizes, which makes the
// taskbar / Apps list fall back to the generic "blank window" icon.)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ffmpeg = require('./ffmpeg-path');
const src = path.join(root, 'src', 'icon.png');
const out = path.join(root, 'build', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function scaled(size, args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', `scale=${size}:${size}:flags=lanczos,format=rgba`, ...args, '-'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${size}px: ${r.stderr}`);
  return r.stdout;
}

const images = SIZES.map((s) => {
  if (s === 256) return { size: s, data: scaled(s, ['-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png']) };
  const bgra = scaled(s, ['-pix_fmt', 'bgra', '-f', 'rawvideo']);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);        // BITMAPINFOHEADER size
  header.writeInt32LE(s, 4);          // width
  header.writeInt32LE(s * 2, 8);      // height (XOR bitmap + AND mask)
  header.writeUInt16LE(1, 12);        // planes
  header.writeUInt16LE(32, 14);       // bpp
  header.writeUInt32LE(s * s * 4, 20);
  const rows = [];
  for (let y = s - 1; y >= 0; y--) rows.push(bgra.subarray(y * s * 4, (y + 1) * s * 4)); // bottom-up
  const maskStride = Math.ceil(s / 32) * 4;
  const mask = Buffer.alloc(maskStride * s); // all zero = fully opaque; real transparency comes from alpha
  return { size: s, data: Buffer.concat([header, ...rows, mask]) };
});

const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const dir = images.map(({ size, data }) => {
  const e = Buffer.alloc(16);
  e[0] = size === 256 ? 0 : size;
  e[1] = size === 256 ? 0 : size;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([head, ...dir, ...images.map((i) => i.data)]));
console.log(`Wrote ${path.relative(root, out)} (${images.length} sizes, ${offset} bytes)`);
