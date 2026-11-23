'use strict';
// Taskbar overlay badges (the small icon drawn over the app's taskbar button).
// Drawn procedurally (anti-aliased) so no image assets are needed.
const { nativeImage } = require('electron');

const SIZE = 32; // shown at 16 px; 32 keeps it crisp on HiDPI taskbars

const COLORS = {
  red: [229, 72, 63],
  amber: [230, 183, 58],
  cyan: [51, 197, 232],
  white: [255, 255, 255],
  dark: [20, 24, 28],
};

function draw({ fill, ring, bars }) {
  const buf = Buffer.alloc(SIZE * SIZE * 4); // BGRA, premultiplied
  const c = (SIZE - 1) / 2;
  const SS = 4;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - 0.5;
          const py = y + (sy + 0.5) / SS - 0.5;
          const d = Math.hypot(px - c, py - c);
          let col = null;
          if (d <= 15.5) {
            col = d > 12.4 ? ring : fill;
            if (bars && d <= 12.4) {
              const bx = Math.abs(px - c);
              if (bx >= 2.2 && bx <= 5.6 && Math.abs(py - c) <= 6.2) col = COLORS.dark;
            }
          }
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }
      const n = SS * SS;
      const o = (y * SIZE + x) * 4;
      const alpha = a / n;
      // premultiplied BGRA
      buf[o] = a ? (b / a) * alpha : 0;
      buf[o + 1] = a ? (g / a) * alpha : 0;
      buf[o + 2] = a ? (r / a) * alpha : 0;
      buf[o + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE });
}

/**
 * rec:  'idle' | 'recording' | 'paused' | 'processing'
 * live: boolean (streaming)
 * Returns { icon, description } or null when nothing should be shown.
 */
function overlayFor(rec, live) {
  if (rec === 'recording') {
    return { icon: draw({ fill: COLORS.red, ring: live ? COLORS.cyan : COLORS.white }), description: live ? 'Recording and live' : 'Recording' };
  }
  if (rec === 'paused') {
    return { icon: draw({ fill: COLORS.amber, ring: live ? COLORS.cyan : COLORS.white, bars: true }), description: live ? 'Recording paused, live' : 'Recording paused' };
  }
  if (live) return { icon: draw({ fill: COLORS.cyan, ring: COLORS.white }), description: 'Live' };
  return null;
}

module.exports = { overlayFor };
