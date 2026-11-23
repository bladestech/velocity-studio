// Scene compositor: draws the active scene onto a canvas at a fixed rate and exposes
// the canvas as a video track for the recorder. Timer runs in a Worker so it is not
// throttled when the window is minimised or hidden behind other windows.
import { state, activeScene, BASE_W, BASE_H } from './store.js';
import { getRes } from './resources.js';

export const canvas = document.getElementById('program');
let ctx = null;
let stream = null;
export let videoTrack = null;

let worker = null;
let lastDraw = 0;
let fpsFrames = 0;
let fpsStamp = performance.now();
let measuredFps = 0;
let recordingFlag = false;

let frameHook = null;
/** Called after every composited frame (used by the hardware-encoder recording path). */
export const setFrameHook = (fn) => { frameHook = fn; };
export const setRecordingFlag = (v) => { recordingFlag = v; };
export const getFps = () => measuredFps;
export const getSize = () => ({ w: canvas.width, h: canvas.height });

export function applySize() {
  const h = state.settings.outputHeight;
  const w = Math.round((h * BASE_W / BASE_H) / 2) * 2;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

export function init() {
  applySize();
  stream = canvas.captureStream(0);
  videoTrack = stream.getVideoTracks()[0];
  const code = `
    let gen = 0;
    onmessage = (e) => {
      const g = ++gen;
      const fps = e.data;
      if (!(fps > 0)) return;
      const iv = 1000 / fps;
      let target = performance.now() + iv;
      const tick = () => {
        if (g !== gen) return;
        postMessage(0);
        target += iv;
        let d = target - performance.now();
        if (d < -iv * 3) { target = performance.now() + iv; d = iv; }
        setTimeout(tick, Math.max(0, d));
      };
      setTimeout(tick, iv);
    };`;
  worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  worker.onmessage = onTick;
  setRate(state.settings.fps);
}

export function setRate(fps) {
  worker.postMessage(fps);
}

function onTick() {
  const now = performance.now();
  const iv = 1000 / state.settings.fps;
  if (now - lastDraw < iv * 0.55) return; // coalesce bursts after a stall
  lastDraw = now;
  draw();
  fpsFrames++;
  if (now - fpsStamp >= 1000) {
    measuredFps = (fpsFrames * 1000) / (now - fpsStamp);
    fpsFrames = 0;
    fpsStamp = now;
  }
}

function draw() {
  const sx = canvas.width / BASE_W;
  const sy = canvas.height / BASE_H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  const sc = activeScene();
  if (sc) for (const item of sc.items) if (item.visible) drawItem(item);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (videoTrack && videoTrack.requestFrame) videoTrack.requestFrame();
  if (frameHook) frameHook();
}

function drawItem(item) {
  ctx.globalAlpha = item.opacity;
  if (item.kind === 'color') {
    ctx.fillStyle = item.props.color || '#000';
    ctx.fillRect(item.x, item.y, item.w, item.h);
    ctx.globalAlpha = 1;
    return;
  }
  const res = getRes(item);
  const ready = res && res.status === 'ok' && res.el && (res.el.tagName !== 'VIDEO' || res.el.readyState >= 2);
  if (!ready) {
    if (!recordingFlag) placeholder(item, res);
    ctx.globalAlpha = 1;
    return;
  }
  const c = item.crop;
  const sw = res.width; const sh = res.height;
  const srcX = c.l * sw; const srcY = c.t * sh;
  const srcW = Math.max(1, sw * (1 - c.l - c.r));
  const srcH = Math.max(1, sh * (1 - c.t - c.b));
  if (item.flipX || item.flipY) {
    ctx.save();
    ctx.translate(item.x + (item.flipX ? item.w : 0), item.y + (item.flipY ? item.h : 0));
    ctx.scale(item.flipX ? -1 : 1, item.flipY ? -1 : 1);
    ctx.drawImage(res.el, srcX, srcY, srcW, srcH, 0, 0, item.w, item.h);
    ctx.restore();
  } else {
    ctx.drawImage(res.el, srcX, srcY, srcW, srcH, item.x, item.y, item.w, item.h);
  }
  ctx.globalAlpha = 1;
}

function placeholder(item, res) {
  ctx.fillStyle = '#0b151a';
  ctx.fillRect(item.x, item.y, item.w, item.h);
  ctx.strokeStyle = '#20404b';
  ctx.lineWidth = 2;
  ctx.strokeRect(item.x + 1, item.y + 1, item.w - 2, item.h - 2);
  ctx.fillStyle = res && res.status === 'error' ? '#ff7a7a' : '#8da8b1';
  ctx.font = '600 28px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const msg = res && res.status === 'error' ? (res.error || 'Source unavailable') : 'Loading…';
  ctx.fillText(msg, item.x + item.w / 2, item.y + item.h / 2, item.w - 24);
  ctx.textAlign = 'left';
}

export async function screenshotBlob() {
  draw();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
