// Live streaming controller (RTMP / RTMPS). Video: shared GPU NV12 frames -> ffmpeg (NVENC, AMF, QSV or x264).
// Audio: mixer output tapped as PCM. Keys live in memory + DPAPI-encrypted storage, never in settings.
import { state, emit } from './store.js';
import * as compositor from './compositor.js';
import * as audio from './audio.js';
import * as frames from './frames.js';
import { hasNvencH264, hasAmfH264, hasQsvH264 } from './recorder.js';

export const SERVICES = [
  { id: 'twitch', name: 'Twitch', server: 'rtmp://live.twitch.tv/app', hint: 'Key: dashboard.twitch.tv → Settings → Stream. Twitch recommends up to 6000 kbps.' },
  { id: 'youtube', name: 'YouTube Live', server: 'rtmp://a.rtmp.youtube.com/live2', hint: 'Key: YouTube Studio → Go live → Stream. For encrypted ingest use rtmps://a.rtmps.youtube.com:443/live2' },
  { id: 'facebook', name: 'Facebook Live', server: 'rtmps://live-api-s.facebook.com:443/rtmp/', hint: 'Live Producer shows the server URL and stream key (keys are often single-use). Use the URL it gives you if it differs.' },
  { id: 'kick', name: 'Kick', server: '', hint: 'Creator Dashboard → Channel → Stream URL and Key. Paste the rtmps:// URL shown there (it is assigned per account).' },
  { id: 'restream', name: 'Restream (multi-platform)', server: 'rtmp://live.restream.io/live', hint: 'Send once to Restream and let it fan out to your other platforms. Key: Restream dashboard → Stream key.' },
  { id: 'custom', name: 'Custom RTMP / RTMPS', server: '', hint: 'Works with TikTok, Instagram, X, Rumble, Trovo and any RTMP(S) ingest: paste the server URL and stream key from the service.' },
];

export const serviceById = (id) => SERVICES.find((s) => s.id === id) || SERVICES[0];

/** Keys typed this session when encrypted storage is unavailable (or "remember" is off). */
export const memoryKeys = {};

export const keyName = (serviceId) => `streamkey:${serviceId}`;
export async function getKey(serviceId) {
  if (memoryKeys[serviceId]) return memoryKeys[serviceId];
  try { return (await window.api.secretGet(keyName(serviceId))) || ''; } catch { return ''; }
}

export const st = {
  phase: 'idle', // idle | connecting | live | reconnecting | stopping
  id: 0,
  startedAt: 0,
  kbps: 0,
  fps: 0,
  dropped: 0,
  attempt: 0,
  error: '',
  serviceName: '',
};

export const isActive = () => st.phase !== 'idle';
export const elapsed = () => (st.phase === 'live' && st.startedAt ? performance.now() - st.startedAt : 0);

let sink = null;
let wasLive = false;

function setPhase(p, extra = {}) {
  st.phase = p;
  emit('streaming', { phase: p, ...extra });
}

export function currentServer() {
  const s = state.settings.stream;
  const svc = serviceById(s.service);
  return (s.servers && s.servers[svc.id] != null ? s.servers[svc.id] : svc.server) || '';
}

export function chooseEncoder() {
  const e = state.settings.stream.encoder;
  const hw = { nvenc: hasNvencH264(), amf: hasAmfH264(), qsv: hasQsvH264() };
  if (e === 'x264') return 'x264';
  if (hw[e]) return e;
  if (e in hw) return 'x264'; // chosen GPU encoder isn't available on this PC
  return hw.nvenc ? 'nvenc' : hw.amf ? 'amf' : hw.qsv ? 'qsv' : 'x264';
}

export async function start() {
  if (st.phase !== 'idle') return { ok: false, error: 'Already streaming.' };
  const cfg = state.settings.stream;
  const svc = serviceById(cfg.service);
  const server = currentServer();
  const key = await getKey(svc.id);
  if (!server) return { ok: false, needsSetup: true, error: `Enter the ${svc.name} server URL in Settings → Stream.` };
  if (!key) return { ok: false, needsSetup: true, error: `Enter your ${svc.name} stream key in Settings → Stream.` };
  if (!audio.tapReady()) return { ok: false, error: 'Audio capture for streaming is unavailable.' };

  const { w, h } = compositor.getSize();
  const canvasFps = state.settings.fps;
  const outH = Math.min(h, cfg.height || h);
  const outW = Math.round(((outH * 16) / 9) / 2) * 2;
  const outFps = Math.min(canvasFps, cfg.fps || canvasFps);
  try { frames.prepare(); } catch (err) { return { ok: false, error: `GPU converter: ${err.message}` }; }

  st.error = '';
  st.kbps = 0; st.fps = 0; st.dropped = 0; st.attempt = 0; st.startedAt = 0;
  st.serviceName = svc.name;
  setPhase('connecting');
  const r = await window.api.streamStart({
    server, key, w, h, fps: canvasFps, outW, outH, outFps,
    bitrate: cfg.bitrate, audioBitrate: cfg.audioBitrate, encoder: chooseEncoder(), preset: cfg.preset, reconnect: cfg.reconnect,
  });
  if (!r.ok) { setPhase('idle'); return r; }
  st.id = r.id;
  wasLive = false;

  let last = 0;
  const interval = 1000 / outFps;
  sink = {
    due: (now) => {
      if (st.phase === 'idle' || st.phase === 'stopping') return null;
      if (now - last < interval - 3) return null;
      last = now;
      return true;
    },
    send: (buf) => { if (st.id) window.api.streamFrame(st.id, buf); },
  };
  frames.addSink(sink);
  audio.setPcmListener((pcm) => { if (st.id) window.api.streamAudio(st.id, pcm); });
  return { ok: true };
}

export async function stop() {
  if (st.phase === 'idle' || st.phase === 'stopping') return;
  const id = st.id;
  setPhase('stopping');
  cleanupSinks();
  await frames.whenIdle();
  await window.api.streamStop(id);
  st.id = 0;
  st.startedAt = 0;
  setPhase('idle');
}

function cleanupSinks() {
  audio.setPcmListener(null);
  if (sink) { frames.removeSink(sink); sink = null; }
}

/** Status events from the main process (connect, live stats, reconnects, errors). */
export function handleStatus(d) {
  if (d.id !== st.id || st.phase === 'stopping' || st.phase === 'idle') return;
  if (d.phase === 'error') {
    cleanupSinks();
    st.error = d.error || 'Stream ended unexpectedly.';
    st.id = 0;
    st.startedAt = 0;
    setPhase('idle', { error: st.error });
    return;
  }
  if (d.phase === 'live') {
    if (!wasLive) { wasLive = true; st.startedAt = performance.now(); }
    st.kbps = d.kbps; st.fps = d.fps; st.dropped = d.dropped;
  }
  if (d.phase === 'reconnecting') { st.attempt = d.attempt; st.error = d.error || ''; }
  setPhase(d.phase, d);
}
