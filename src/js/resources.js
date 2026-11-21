// Live media resources (screen / window / camera streams, decoded images, rendered text).
// Resources are shared by key and released a few seconds after nothing needs them.
import { state, activeScene } from './store.js';
import { sleep } from './util.js';

const live = new Map(); // key -> res
const RELEASE_DELAY = 6000;

let host = null;
function hostEl() {
  if (!host) {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none';
    document.body.appendChild(host);
  }
  return host;
}

export function keyFor(item) {
  const p = item.props || {};
  switch (item.kind) {
    case 'display': return `display:${p.sourceId}`;
    case 'window': return `window:${p.title || ''}:${p.sourceId}`;
    case 'camera': return `camera:${p.deviceId || 'default'}:${p.res || 'auto'}`;
    case 'image': return `image:${item.id}`;
    case 'text': return `text:${item.id}`;
    default: return null;
  }
}

export function getRes(item) {
  const k = keyFor(item);
  return k ? live.get(k) || null : null;
}

/* ---------- acquisition ---------- */
export function acquire(item) {
  const key = keyFor(item);
  if (!key) return Promise.resolve(null);
  let res = live.get(key);
  if (res) {
    clearTimeout(res.releaseTimer);
    res.releaseTimer = null;
    return res.ready;
  }
  res = { key, kind: item.kind, status: 'loading', error: '', el: null, width: 0, height: 0, stream: null, releaseTimer: null };
  live.set(key, res);
  res.ready = (async () => {
    try {
      await open(res, item);
      if (live.get(key) !== res) { dispose(res); return res; } // released while opening
      res.status = 'ok';
    } catch (err) {
      res.status = 'error';
      res.error = (err && (err.message || err.name)) || String(err);
    }
    return res;
  })();
  return res.ready;
}

async function open(res, item) {
  const p = item.props;
  switch (item.kind) {
    case 'display':
    case 'window': {
      let id = p.sourceId;
      if (item.kind === 'window') id = await resolveWindow(item);
      if (!id) throw new Error('Window not found');
      const fps = state.settings.fps;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: id,
            maxWidth: 7680, maxHeight: 4320,
            minFrameRate: Math.min(15, fps), maxFrameRate: fps,
          },
        },
      });
      await attachVideo(res, stream);
      break;
    }
    case 'camera': {
      const fps = Math.min(60, state.settings.fps);
      const video = { frameRate: { ideal: fps } };
      if (p.deviceId && p.deviceId !== 'default') video.deviceId = { exact: p.deviceId };
      const dims = { '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160], '480p': [640, 480] }[p.res];
      if (dims) { video.width = { ideal: dims[0] }; video.height = { ideal: dims[1] }; }
      else { video.width = { ideal: 1920 }; video.height = { ideal: 1080 }; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      await attachVideo(res, stream);
      break;
    }
    case 'image': {
      const bytes = await window.api.readFile(p.path);
      const ext = (p.path.split('.').pop() || '').toLowerCase();
      const type = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'image/png';
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const img = new Image();
      img.src = url;
      await img.decode();
      hostEl().appendChild(img); // keeps animated GIFs ticking
      res.el = img;
      res.width = img.naturalWidth || 512;
      res.height = img.naturalHeight || 512;
      res.dispose = () => { URL.revokeObjectURL(url); img.remove(); };
      break;
    }
    case 'text': {
      const c = renderText(p);
      res.el = c;
      res.width = c.width;
      res.height = c.height;
      break;
    }
    default: break;
  }
}

async function attachVideo(res, stream) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  hostEl().appendChild(video);
  await video.play().catch(() => {});
  const t0 = performance.now();
  while ((!video.videoWidth || video.readyState < 2) && performance.now() - t0 < 6000) await sleep(30);
  if (!video.videoWidth) { stream.getTracks().forEach((t) => t.stop()); video.remove(); throw new Error('No video received'); }
  res.stream = stream;
  res.el = video;
  res.width = video.videoWidth;
  res.height = video.videoHeight;
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => { res.status = 'error'; res.error = 'Source ended (closed or disconnected)'; });
  video.addEventListener('resize', () => { res.width = video.videoWidth; res.height = video.videoHeight; });
  res.dispose = () => { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; video.remove(); };
}

async function resolveWindow(item) {
  const p = item.props;
  const list = await window.api.listSources({ types: ['window'], thumb: 2 });
  let m = list.find((s) => s.id === p.sourceId && (!p.title || s.name === p.title));
  if (!m && p.title) m = list.find((s) => s.name === p.title) || list.find((s) => s.name.includes(p.title) || p.title.includes(s.name));
  if (m) { p.sourceId = m.id; return m.id; }
  return null;
}

/* ---------- lifecycle ---------- */
function dispose(res) {
  try { if (res.dispose) res.dispose(); } catch { /* ignore */ }
}

function release(res) {
  clearTimeout(res.releaseTimer);
  if (live.get(res.key) === res) live.delete(res.key);
  dispose(res);
}

export function invalidate(item) {
  const k = keyFor(item);
  const res = k && live.get(k);
  if (res) release(res);
}

/** Make sure everything the active scene needs is running; release the rest after a grace period. */
export function sync() {
  const sc = activeScene();
  const needed = new Map();
  if (sc) {
    for (const it of sc.items) {
      const k = keyFor(it);
      if (k && it.visible) needed.set(k, it);
    }
  }
  for (const it of needed.values()) acquire(it);
  for (const [k, res] of live) {
    if (needed.has(k)) {
      clearTimeout(res.releaseTimer);
      res.releaseTimer = null;
    } else if (!res.releaseTimer) {
      res.releaseTimer = setTimeout(() => release(res), RELEASE_DELAY);
    }
  }
}

/** Drop every live resource (used when capture settings such as fps change). */
export function resetAll() {
  for (const res of [...live.values()]) release(res);
}

/* ---------- retry for sources that failed ---------- */
export function retryFailed() {
  for (const res of [...live.values()]) if (res.status === 'error') release(res);
  sync();
}

/* ---------- devices ---------- */
export async function listCameras() {
  let devs = await navigator.mediaDevices.enumerateDevices();
  if (devs.some((d) => d.kind === 'videoinput' && !d.label)) {
    try { (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop()); } catch { /* no permission / no camera */ }
    devs = await navigator.mediaDevices.enumerateDevices();
  }
  return devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/* ---------- text rendering ---------- */
export function renderText(p) {
  const size = Math.max(6, p.fontSize || 64);
  const font = `${p.italic ? 'italic ' : ''}${p.bold ? '700 ' : '400 '}${size}px "${p.fontFamily || 'Segoe UI'}", sans-serif`;
  const lines = String(p.text ?? '').split('\n');
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const lh = Math.round(size * 1.22);
  const pad = p.bg ? Math.round(size * 0.3) : Math.round(size * 0.1) + (p.outline ? Math.ceil(size * 0.06) : 0);
  let maxW = 0;
  for (const l of lines) maxW = Math.max(maxW, measure.measureText(l || ' ').width);
  const w = Math.max(8, Math.ceil(maxW + pad * 2));
  const h = Math.max(8, lh * lines.length + pad * 2);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (p.bg) { g.fillStyle = p.bgColor || '#000000'; g.fillRect(0, 0, w, h); }
  g.font = font;
  g.textBaseline = 'middle';
  g.fillStyle = p.color || '#ffffff';
  g.lineJoin = 'round';
  lines.forEach((l, i) => {
    const y = pad + lh * i + lh / 2;
    const align = p.align || 'left';
    const lw = g.measureText(l).width;
    const x = align === 'center' ? (w - lw) / 2 : align === 'right' ? w - pad - lw : pad;
    if (p.outline) {
      g.lineWidth = Math.max(2, size * 0.12);
      g.strokeStyle = p.outlineColor || '#000000';
      g.strokeText(l, x, y);
    }
    g.fillText(l, x, y);
  });
  return c;
}
