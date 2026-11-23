// Recording controller. Two backends:
//   native  - canvas video + mixed audio -> MediaRecorder (Chromium encoders) -> disk
//   ffmpeg  - canvas -> GPU NV12 -> ffmpeg (NVENC / AMF / QSV hardware, or x264 / x265 software)
//             + Opus audio file -> muxed on stop
import { state, emit } from './store.js';
import { formatName } from './util.js';
import * as compositor from './compositor.js';
import * as audio from './audio.js';
import * as frames from './frames.js';

/** Encoder families: how each one is tuned (presets are listed best quality last). */
export const FAMILIES = {
  nvenc: {
    name: 'NVIDIA NVENC', kind: 'hardware',
    presets: [['p1', 'P1 (fastest)'], ['p2', 'P2'], ['p3', 'P3'], ['p4', 'P4 (balanced)'], ['p5', 'P5 (high quality)'], ['p6', 'P6'], ['p7', 'P7 (best quality)']],
  },
  amf: {
    name: 'AMD AMF', kind: 'hardware',
    presets: [['speed', 'Speed (lowest GPU load)'], ['balanced', 'Balanced'], ['quality', 'Quality']],
  },
  qsv: {
    name: 'Intel Quick Sync', kind: 'hardware',
    presets: [['veryfast', 'Very fast'], ['faster', 'Faster'], ['fast', 'Fast'], ['medium', 'Medium'], ['slow', 'Slow'], ['slower', 'Slower'], ['veryslow', 'Very slow (best quality)']],
  },
  x264: {
    name: 'x264', kind: 'software',
    presets: [['ultrafast', 'Ultrafast'], ['superfast', 'Superfast'], ['veryfast', 'Very fast'], ['faster', 'Faster'], ['fast', 'Fast'], ['medium', 'Medium'], ['slow', 'Slow (best quality)']],
  },
  x265: {
    name: 'x265', kind: 'software',
    presets: [['ultrafast', 'Ultrafast'], ['superfast', 'Superfast'], ['veryfast', 'Very fast'], ['faster', 'Faster'], ['fast', 'Fast'], ['medium', 'Medium (best quality)']],
  },
};

export const ENCODERS = [
  { key: 'nvenc-h264', label: 'NVIDIA NVENC H.264', short: 'NVENC H.264', backend: 'ffmpeg', family: 'nvenc', ffCodec: 'h264_nvenc', codec: 'h264' },
  { key: 'nvenc-hevc', label: 'NVIDIA NVENC HEVC / H.265', short: 'NVENC HEVC', backend: 'ffmpeg', family: 'nvenc', ffCodec: 'hevc_nvenc', codec: 'hevc' },
  { key: 'nvenc-av1', label: 'NVIDIA NVENC AV1 (RTX 40-series+)', short: 'NVENC AV1', backend: 'ffmpeg', family: 'nvenc', ffCodec: 'av1_nvenc', codec: 'av1' },
  { key: 'amf-h264', label: 'AMD AMF H.264', short: 'AMF H.264', backend: 'ffmpeg', family: 'amf', ffCodec: 'h264_amf', codec: 'h264' },
  { key: 'amf-hevc', label: 'AMD AMF HEVC / H.265', short: 'AMF HEVC', backend: 'ffmpeg', family: 'amf', ffCodec: 'hevc_amf', codec: 'hevc' },
  { key: 'amf-av1', label: 'AMD AMF AV1 (RX 7000-series+)', short: 'AMF AV1', backend: 'ffmpeg', family: 'amf', ffCodec: 'av1_amf', codec: 'av1' },
  { key: 'qsv-h264', label: 'Intel Quick Sync H.264', short: 'QSV H.264', backend: 'ffmpeg', family: 'qsv', ffCodec: 'h264_qsv', codec: 'h264' },
  { key: 'qsv-hevc', label: 'Intel Quick Sync HEVC / H.265', short: 'QSV HEVC', backend: 'ffmpeg', family: 'qsv', ffCodec: 'hevc_qsv', codec: 'hevc' },
  { key: 'qsv-av1', label: 'Intel Quick Sync AV1 (Arc+)', short: 'QSV AV1', backend: 'ffmpeg', family: 'qsv', ffCodec: 'av1_qsv', codec: 'av1' },
  { key: 'x264', label: 'x264 H.264', short: 'x264', backend: 'ffmpeg', family: 'x264', ffCodec: 'libx264', codec: 'h264' },
  { key: 'x265', label: 'x265 HEVC / H.265', short: 'x265', backend: 'ffmpeg', family: 'x265', ffCodec: 'libx265', codec: 'hevc' },
  { key: 'h264-mp4', label: 'H.264 (Chromium, MP4)', short: 'H.264', mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4', codec: 'h264' },
  { key: 'h264-webm', label: 'H.264 (Chromium, WebM container)', short: 'H.264', mime: 'video/webm;codecs=h264,opus', ext: 'webm', codec: 'h264' },
  { key: 'vp9', label: 'VP9 (WebM)', short: 'VP9', mime: 'video/webm;codecs=vp9,opus', ext: 'webm', codec: 'vp9' },
  { key: 'vp8', label: 'VP8 (WebM)', short: 'VP8', mime: 'video/webm;codecs=vp8,opus', ext: 'webm', codec: 'vp8' },
  { key: 'av1', label: 'AV1 (Chromium, very high CPU)', short: 'AV1', mime: 'video/webm;codecs=av1,opus', ext: 'webm', codec: 'av1' },
];
/** 'hardware' | 'software' | 'builtin' (Chromium MediaRecorder) */
export const kindOf = (enc) => (!enc ? null : enc.backend === 'ffmpeg' ? FAMILIES[enc.family].kind : 'builtin');

/** Which ffmpeg encoders actually initialise on this machine (filled by probeHardware). */
const avail = {};
let probed = false;
export async function probeHardware() {
  try {
    const r = await window.api.probeEncoders();
    for (const e of ENCODERS) if (e.backend === 'ffmpeg') avail[e.key] = !!(r.enc && r.enc[e.ffCodec]);
  } catch { /* leave all unavailable */ }
  probed = true;
  emit('settings');
}
export const isProbed = () => probed;
const anyOf = (fam, codec) => ENCODERS.some((e) => e.family === fam && (!codec || e.codec === codec) && avail[e.key]);
export const hasNvencH264 = () => anyOf('nvenc', 'h264');
export const hasNvenc = () => anyOf('nvenc');
export const hasAmfH264 = () => anyOf('amf', 'h264');
export const hasAmf = () => anyOf('amf');
export const hasQsvH264 = () => anyOf('qsv', 'h264');
export const hasHardware = () => hasNvenc() || hasAmf() || anyOf('qsv');
/** Tuning ({ preset, rc, cq }) that applies to an encoder, or null for Chromium encoders. */
export const tuningFor = (enc, s = state.settings) => (!enc || enc.backend !== 'ffmpeg' ? null : s.tuning[enc.family]);

export const supportedEncoders = () => ENCODERS.filter((e) => (e.backend === 'ffmpeg' ? avail[e.key] : MediaRecorder.isTypeSupported(e.mime)));

export function chooseEncoder(pref = state.settings.encoder, container = state.settings.container, { nativeOnly = false } = {}) {
  const sup = supportedEncoders().filter((e) => !nativeOnly || e.backend !== 'ffmpeg');
  if (pref && pref !== 'auto') {
    const e = sup.find((x) => x.key === pref);
    if (e) return e;
  }
  const order = {
    mp4: ['nvenc-h264', 'amf-h264', 'qsv-h264', 'x264', 'h264-mp4', 'h264-webm', 'vp9', 'vp8'],
    mkv: ['nvenc-h264', 'amf-h264', 'qsv-h264', 'x264', 'h264-mp4', 'h264-webm', 'vp9', 'vp8'],
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
    return r2.ok ? { ...r2, notice: `${enc.short} unavailable (${r.error}), so recording with ${fb.short} instead.` } : r;
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

let lastIdx = -1;
let sizePoll = null;
let sink = null;

async function startFfmpeg(enc) {
  const s = state.settings;
  const { w, h } = compositor.getSize();
  try { frames.prepare(); } catch (err) { return { ok: false, error: `GPU converter: ${err.message}` }; }
  const target = resolveTarget(enc, s.container);
  const r = await window.api.encStart({
    dir: s.recPath, name: formatName(s.filename), target,
    ffCodec: enc.ffCodec, codec: enc.codec, w, h, fps: s.fps, bitrate: s.videoBitrate, family: enc.family, tune: tuningFor(enc), keyint: s.keyint,
  });
  if (!r.ok) return r;

  resetRec(enc);
  rec.ff = true;
  rec.id = r.id;
  rec.path = r.path;
  rec.target = target;
  lastIdx = -1;

  // Audio goes to its own Opus file (cheap), muxed with the GPU-encoded video when recording stops.
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
  sink = {
    // Frame slots are derived from active recording time, so pauses leave no gap and stalls are back-filled by the encoder process.
    due: () => {
      if (rec.phase !== 'recording' || !rec.ff) return null;
      const idx = Math.floor((elapsed() * state.settings.fps) / 1000);
      if (idx <= lastIdx) return null;
      lastIdx = idx;
      return idx;
    },
    send: (buf, idx) => { if (rec.ff && isActive()) window.api.encFrame(rec.id, idx, buf); },
  };
  frames.addSink(sink);
  sizePoll = setInterval(async () => {
    const st = await window.api.encSize(rec.id);
    if (st) { rec.bytes = st.bytes; rec.dropped = st.dropped; }
  }, 1000);
  setPhase('recording');
  if (s.minimizeOnRecord) window.api.minimize();
  return { ok: true, path: r.path };
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
    clearInterval(sizePoll);
    if (sink) { frames.removeSink(sink); sink = null; }
    await frames.whenIdle();
    if (rec.amr && rec.amr.state !== 'inactive') {
      await new Promise((resolve) => { rec.amr.onstop = resolve; try { rec.amr.stop(); } catch { resolve(); } });
    }
    await rec.chain;
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
