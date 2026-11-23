// Builds src/logo-v.png — the stylized "V" from src/icon.png on a transparent background, used by the
// startup animation (the V is animated separately from the dark tile behind it).
// The V is the only saturated cyan in the logo, so its alpha is derived from how far each pixel's blue
// channel rises above the dark tile; anti-aliased edges keep their partial coverage.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ffmpeg = require('ffmpeg-static');
const src = path.join(root, 'src', 'icon.png');
const out = path.join(root, 'src', 'logo-v.png');
const S = 512;

const raw = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', `scale=${S}:${S}:flags=lanczos,format=rgba`, '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 });
if (raw.status !== 0) throw new Error(`ffmpeg decode failed: ${raw.stderr}`);
const px = raw.stdout;

const LO = 70, HI = 215; // blue-channel ramp: tile background stays below LO, the V body sits near 232
const V = [0x33, 0xc5, 0xe8];
const outBuf = Buffer.alloc(S * S * 4);
let minX = S, minY = S, maxX = 0, maxY = 0;
for (let i = 0; i < S * S; i++) {
  const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], a = px[i * 4 + 3];
  const cyan = b - Math.max(0, r - 40) * 0.5; // the teal background has some blue but also little red/green separation
  let t = Math.min(1, Math.max(0, (cyan - LO) / (HI - LO)));
  t = t * t * (3 - 2 * t);
  const alpha = Math.round(t * a);
  outBuf[i * 4] = V[0]; outBuf[i * 4 + 1] = V[1]; outBuf[i * 4 + 2] = V[2]; outBuf[i * 4 + 3] = alpha;
  if (alpha > 128) {
    const x = i % S, y = (i / S) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}

const enc = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${S}x${S}`, '-i', '-', '-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgba', out], { input: outBuf });
if (enc.status !== 0) throw new Error(`ffmpeg encode failed: ${enc.stderr}`);
console.log(`Wrote ${path.relative(root, out)} (${fs.statSync(out).size} bytes); V bounds x ${minX}-${maxX}, y ${minY}-${maxY}`);
