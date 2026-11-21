// Recording controller. Two backends:
//   native  - canvas video + mixed audio -> MediaRecorder (Chromium encoders) -> disk
//   ffmpeg  - canvas -> GPU NV12 -> ffmpeg (NVIDIA NVENC) + Opus audio file -> muxed on stop
import { state, emit } from './store.js';
import { formatName } from './util.js';
import * as compositor from './compositor.js';
import * as audio from './audio.js';
import { Nv12Converter } from './nv12.js';

export const ENCODERS = [
  { key: 'nvenc-h264', label: 'NVIDIA NVENC H.264 (GPU)', short: 'NVENC H.264', backend: 'ffmpeg', ffCodec: 'h264_nvenc', codec: 'h264' },
  { key: 'nvenc-hevc', label: 'NVIDIA NVENC HEVC / H.265 (GPU)', short: 'NVENC HEVC', backend: 'ffmpeg', ffCodec: 'hevc_nvenc', codec: 'hevc' },
  { key: 'nvenc-av1', label: 'NVIDIA NVENC AV1 (GPU, RTX 40-series)', short: 'NVENC AV1', backend: 'ffmpeg', ffCodec: 'av1_nvenc', codec: 'av1' },
  { key: 'h264-mp4', label: 'H.264 (Chromium, MP4)', short: 'H.264', mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4', codec: 'h264' },
  { key: 'h264-webm', label: 'H.264 (Chromium, WebM container)', short: 'H.264', mime: 'video/webm;codecs=h264,opus', ext: 'webm', codec: 'h264' },
  { key: 'vp9', label: 'VP9 (WebM)', short: 'VP9', mime: 'video/webm;codecs=vp9,opus', ext: 'webm', codec: 'vp9' },
  { key: 'vp8', label: 'VP8 (WebM)', short: 'VP8', mime: 'video/webm;codecs=vp8,opus', ext: 'webm', codec: 'vp8' },
  { key: 'av1', label: 'AV1 (Chromium, very high CPU)', short: 'AV1', mime: 'video/webm;codecs=av1,opus', ext: 'webm', codec: 'av1' },
];

/** Which hardware encoders the bundled ffmpeg can actually initialise on this machine. */
const hw = { 'nvenc-h264': false, 'nvenc-hevc': false, 'nvenc-av1': false };
export async function probeHardware() {
  try {
    const r = await window.api.probeEncoders();
    hw['nvenc-h264'] = !!r.nvenc.h264;
    hw['nvenc-hevc'] = !!r.nvenc.hevc;
    hw['nvenc-av1'] = !!r.nvenc.av1;
  } catch { /* leave all false */ }
  emit('settings');
}
export const hasNvenc = () => hw['nvenc-h264'] || hw['nvenc-hevc'] || hw['nvenc-av1'];

export const supportedEncoders = () => ENCODERS.filter((e) => (e.backend === 'ffmpeg' ? hw[e.key] : MediaRecorder.isTypeSupported(e.mime)));

export function chooseEncoder(pref = state.settings.encoder, container = state.settings.container, { nativeOnly = false } = {}) {
  const sup = supportedEncoders().filter((e) => !nativeOnly || e.backend !== 'ffmpeg');
  if (pref && pref !== 'auto') {
    const e = sup.find((x) => x.key === pref);
    if (e) return e;
  }
  const order = {
    mp4: ['nvenc-h264', 'h264-mp4', 'h264-webm', 'vp9', 'vp8'],
    mkv: ['nvenc-h264', 'h264-mp4', 'h264-webm', 'vp9', 'vp8'],
    webm: ['vp9', 'vp8', 'av1'],
  }[container] || ['h264-mp4', 'vp9', 'vp8'];
  for (const k of order) { const e = sup.find((x) => x.key === k); if (e) return e; }
  return sup[0];
}

const resolveTarget = (enc, container) => (container === 'webm' && !['vp8', 'vp9', 'av1'].includes(enc.codec) ? 'mkv' : container);

export const rec = {
  phase: 'idle', // idle | recording | paused | processing
  id: 0,
  path: '',
  bytes: 0,
  dropped: 0,
  startedAt: 0,
  pauseStart: 0,
  pausedTotal: 0,
  mr: null,
  amr: null,
  chain: Promise.resolve(),
  encoder: null,
  ff: false,
  error: null,
};

export const isActive = () => rec.phase === 'recording' || rec.phase === 'paused';

export function elapsed() {
  if (!isActive()) return 0;
  const end = rec.phase === 'paused' ? rec.pauseStart : performance.now();
  return Math.max(0, end - rec.startedAt - rec.pausedTotal);
}

function setPhase(p, extra = {}) {
  rec.phase = p;
  emit('recording', { phase: p, ...extra });
}

function resetRec(enc) {
  rec.encoder = enc;
  rec.bytes = 0;
  rec.dropped = 0;
  rec.chain = Promise.resolve();
  rec.error = null;
  rec.pausedTotal = 0;
}

/* ------------------------------ start ------------------------------ */
export async function start() {
  if (rec.phase !== 'idle') return { ok: false, error: 'Busy' };
  const enc = chooseEncoder();
  if (!enc) return { ok: false, error: 'No supported video encoder found.' };
  if (enc.backend === 'ffmpeg') {
    const r = await startFfmpeg(enc);
    if (r.ok || state.settings.encoder !== 'auto') return r;
    // Automatic mode: fall back to the Chromium encoder rather than refuse to record.
    const fb = chooseEncoder('auto', state.settings.container, { nativeOnly: true });
    if (!fb) return r;
    const r2 = await startNative(fb);
    return r2.ok ? { ...r2, notice: `NVENC unavailable (${r.error}) — recording with ${fb.short} instead.` } : r;
  }
  return startNative(enc);
}

async function startNative(enc) {
  const s = state.settings;
  const open = await window.api.recOpen({ dir: s.recPath, name: formatName(s.filename), ext: enc.ext });
  const aTrack = audio.mixStream().getAudioTracks()[0];
  const tracks = [compositor.videoTrack];
  if (aTrack) tracks.push(aTrack);
  let mr;
  try {
    mr = new MediaRecorder(new MediaStream(tracks), {
      mimeType: enc.mime,
      videoBitsPerSecond: s.videoBitrate * 1000,
      audioBitsPerSecond: s.audioBitrate * 1000,
    });
  } catch (err) {
    await window.api.recClose(open.id, { target: enc.ext, fixDuration: false });
    return { ok: false, error: `Could not start encoder: ${err.message}` };
  }
  resetRec(enc);
  rec.ff = false;
  rec.id = open.id;
  rec.path = open.path;
  rec.mr = mr;
  mr.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    rec.chain = rec.chain.then(async () => {
      const buf = await e.data.arrayBuffer();
      window.api.recWrite(rec.id, buf);
      rec.bytes += buf.byteLength;
    }).catch(() => {});
  };
  mr.onerror = (e) => { rec.error = (e.error && e.error.message) || 'Encoder error'; stop(); };
  compositor.setRecordingFlag(true);
  mr.start(1000);
  rec.startedAt = performance.now();
  setPhase('recording');
  if (s.minimizeOnRecord) window.api.minimize();
  return { ok: true, path: open.path };
}

let grabbing = null;
let conv = null;
let frameBuf = null;
let lastIdx = -1;
let sizePoll = null;

async function startFfmpeg(enc) {
  const s = state.settings;
  const { w, h } = compositor.getSize();
  let converter;
  try { converter = new Nv12Converter(w, h); } catch (err) { return { ok: false, error: `GPU converter: ${err.message}` }; }
  const target = resolveTarget(enc, s.container);
  const r = await window.api.encStart({
    dir: s.recPath, name: formatName(s.filename), target,
    ffCodec: enc.ffCodec, codec: enc.codec, w, h, fps: s.fps, bitrate: s.videoBitrate, nvenc: s.nvenc,
  });
  if (!r.ok) { converter.dispose(); return r; }

  resetRec(enc);
  rec.ff = true;
  rec.id = r.id;
  rec.path = r.path;
  rec.target = target;
  conv = converter;
  frameBuf = new Uint8Array(conv.size);
  lastIdx = -1;

  // Audio goes to its own Opus file (cheap), muxed with the NVENC video when recording stops.
  rec.amr = null;
  rec.audioStartAt = 0;
  const aTrack = audio.mixStream().getAudioTracks()[0];
  if (aTrack) {
    try {
      const amr = new MediaRecorder(new MediaStream([aTrack]), { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256000 });
      amr.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        rec.chain = rec.chain.then(async () => { window.api.encAudio(rec.id, await e.data.arrayBuffer()); }).catch(() => {});
      };
      amr.onstart = () => { rec.audioStartAt = performance.now(); };
      rec.amr = amr;
    } catch { rec.amr = null; }
  }

  compositor.setRecordingFlag(true);
  rec.startedAt = performance.now();
  if (rec.amr) rec.amr.start(500);
  compositor.setFrameHook(onFrame);
  sizePoll = setInterval(async () => {
    const st = await window.api.encSize(rec.id);
    if (st) { rec.bytes = st.bytes; rec.dropped = st.dropped; }
  }, 1000);
  setPhase('recording');
  if (s.minimizeOnRecord) window.api.minimize();
  return { ok: true, path: r.path };
}

/** Per composited frame: GPU-convert to NV12 and hand it to the encoder process. */
function onFrame() {
  if (rec.phase !== 'recording' || !rec.ff || grabbing) return;
  const idx = Math.floor((elapsed() * state.settings.fps) / 1000);
  if (idx <= lastIdx) return;
  lastIdx = idx;
  const id = rec.id;
  grabbing = conv.convert(compositor.canvas, frameBuf)
    .then((buf) => { if (rec.id === id && rec.ff && isActive()) window.api.encFrame(id, idx, buf); })
    .catch((err) => { rec.error = err.message; })
    .finally(() => { grabbing = null; });
}

/* ------------------------------ pause / stop ------------------------------ */
export function togglePause() {
  const mr = rec.ff ? rec.amr : rec.mr;
  if (rec.phase === 'recording') {
    if (mr && mr.state === 'recording') mr.pause();
    rec.pauseStart = performance.now();
    setPhase('paused');
  } else if (rec.phase === 'paused') {
    if (mr && mr.state === 'paused') mr.resume();
    rec.pausedTotal += performance.now() - rec.pauseStart;
    setPhase('recording');
  }
}

export async function stop() {
  if (!isActive()) return null;
  const durationMs = elapsed();
  const { mr, encoder } = rec;
  setPhase('processing', { pct: 0 });
  compositor.setRecordingFlag(false);
  let result;
  if (rec.ff) {
    compositor.setFrameHook(null);
    clearInterval(sizePoll);
    if (grabbing) await grabbing;
    if (rec.amr && rec.amr.state !== 'inactive') {
      await new Promise((resolve) => { rec.amr.onstop = resolve; try { rec.amr.stop(); } catch { resolve(); } });
    }
    await rec.chain;
    if (conv) { conv.dispose(); conv = null; }
    const audioOffsetMs = rec.amr && rec.audioStartAt ? rec.audioStartAt - rec.startedAt : 0;
    result = await window.api.encStop(rec.id, {
      target: rec.target, codec: encoder.codec, audioBitrate: state.settings.audioBitrate, audioOffsetMs, durationMs,
    });
    rec.ff = false;
    rec.amr = null;
  } else {
    await new Promise((resolve) => { mr.onstop = resolve; try { mr.stop(); } catch { resolve(); } });
    await rec.chain;
    result = await window.api.recClose(rec.id, {
      target: resolveTarget(encoder, state.settings.container),
      codec: encoder.codec,
      durationMs,
      audioBitrate: state.settings.audioBitrate,
    });
  }
  const out = { ...result, durationMs };
  setPhase('idle', { result: out });
  if (state.settings.minimizeOnRecord) window.api.restore();
  return out;
}
