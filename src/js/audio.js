// Audio mixer engine: every channel is  source → gain (fader/mute) → analysers (meters) → mix bus.
// The mix bus is a MediaStream that the recorder adds as its audio track.
import { state } from './store.js';
import { dbToGain } from './util.js';

let ctx = null;
let dest = null;
const channels = new Map(); // id -> { cfg, stream, gain, splitter, an:[L,R], buf, hold:[,], status, error }

// AudioWorklet that taps the final mix as interleaved 48 kHz stereo float32 in 20 ms blocks (for live streaming).
const TAP_CODE = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.buf = new Float32Array(960 * 2);
    this.n = 0;
    this.port.onmessage = (e) => { this.active = !!e.data; this.n = 0; };
  }
  process(inputs) {
    if (!this.active) return true;
    const inp = inputs[0];
    if (!inp || !inp[0]) return true;
    const L = inp[0];
    const R = inp[1] || inp[0];
    for (let i = 0; i < L.length; i++) {
      this.buf[this.n++] = L[i];
      this.buf[this.n++] = R[i];
      if (this.n === this.buf.length) {
        const out = this.buf.slice();
        this.port.postMessage(out.buffer, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);`;

let tap = null;
let pcmCb = null;
let tapBus = null; // gain node every channel also feeds, which goes to the tap

export function init() {
  ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  dest.channelCountMode = 'explicit';
  tapBus = ctx.createGain();
  tapBus.channelCount = 2;
  tapBus.channelCountMode = 'explicit';
  // A silent oscillator keeps the bus producing samples even with every channel muted.
  const osc = ctx.createOscillator();
  const z = ctx.createGain();
  z.gain.value = 0;
  osc.connect(z).connect(dest);
  z.connect(tapBus);
  osc.start();
  resume();
  document.addEventListener('pointerdown', resume, { once: true });
  initTap();
  let t = null;
  navigator.mediaDevices.addEventListener('devicechange', () => {
    clearTimeout(t);
    t = setTimeout(recoverChannels, 1000);
  });
}

async function initTap() {
  try {
    const url = URL.createObjectURL(new Blob([TAP_CODE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    tap = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    tap.port.onmessage = (e) => { if (pcmCb) pcmCb(e.data); };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    tapBus.connect(tap);
    tap.connect(mute).connect(ctx.destination); // must reach the destination for the worklet to be pulled
    tap.port.postMessage(!!pcmCb);
  } catch (err) {
    console.error('Audio tap unavailable (streaming audio disabled):', err);
  }
}

/** Receive the mixed audio as Float32 PCM ArrayBuffers (pass null to stop). */
export function setPcmListener(cb) {
  pcmCb = cb;
  if (tap) tap.port.postMessage(!!cb);
}
export const tapReady = () => !!tap;

/** Channels whose device vanished (or loopback after the default output changed) are re-opened. */
function recoverChannels() {
  for (const cfg of state.audio) {
    const ch = channels.get(cfg.id);
    if (cfg.kind === 'desktop' || !ch || ch.status === 'error') startChannel(cfg);
  }
}

/* ---- source selection: one dropdown value per channel ---- */
export const SYSTEM_AUDIO = '__system';
export const sourceValue = (cfg) => (cfg.kind === 'desktop' ? SYSTEM_AUDIO : (cfg.deviceId || 'default'));
export function setSource(cfg, value) {
  if (value === SYSTEM_AUDIO) { cfg.kind = 'desktop'; return; }
  cfg.kind = 'input';
  cfg.deviceId = value;
}
export async function sourceOptions() {
  const inputs = await listInputs();
  return [
    { value: SYSTEM_AUDIO, label: 'System audio — everything you hear (loopback)' },
    { value: 'default', label: 'Default microphone' },
    ...inputs.filter((d) => d.id !== 'default').map((d) => ({ value: d.id, label: d.label })),
  ];
}

const resume = () => { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); };

export const mixStream = () => dest.stream;
export const getStatus = (id) => channels.get(id) || null;

export async function listInputs() {
  let devs = await navigator.mediaDevices.enumerateDevices();
  if (devs.some((d) => d.kind === 'audioinput' && !d.label)) {
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch { /* denied / none */ }
    devs = await navigator.mediaDevices.enumerateDevices();
  }
  return devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

async function getStream(cfg) {
  if (cfg.kind === 'desktop') {
    // Windows system-audio loopback: needs a (throw-away) screen video track alongside it.
    const screens = await window.api.listSources({ types: ['screen'], thumb: 2 });
    if (!screens.length) throw new Error('No display for audio loopback');
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: screens[0].id, maxWidth: 64, maxHeight: 64, maxFrameRate: 1 } },
    });
    s.getVideoTracks().forEach((t) => { t.stop(); s.removeTrack(t); });
    if (!s.getAudioTracks().length) throw new Error('No audio track');
    return s;
  }
  const audio = {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: !!cfg.noiseSuppression,
    channelCount: 2,
  };
  if (cfg.deviceId && cfg.deviceId !== 'default') audio.deviceId = { exact: cfg.deviceId };
  return navigator.mediaDevices.getUserMedia({ audio, video: false });
}

export async function startChannel(cfg) {
  stopChannel(cfg.id);
  const ch = { cfg, stream: null, gain: null, splitter: null, an: [], buf: new Float32Array(1024), hold: [-Infinity, -Infinity], holdAt: [0, 0], status: 'loading', error: '' };
  channels.set(cfg.id, ch);
  try {
    const stream = await getStream(cfg);
    if (channels.get(cfg.id) !== ch) { stream.getTracks().forEach((t) => t.stop()); return; }
    ch.stream = stream;
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.channelCount = 2;
    gain.channelCountMode = 'explicit';
    gain.channelInterpretation = 'speakers';
    gain.gain.value = cfg.muted ? 0 : dbToGain(cfg.volumeDb);
    src.connect(gain);
    gain.connect(dest);
    gain.connect(tapBus);
    const splitter = ctx.createChannelSplitter(2);
    gain.connect(splitter);
    ch.an = [0, 1].map((i) => {
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      a.smoothingTimeConstant = 0;
      splitter.connect(a, i);
      return a;
    });
    ch.gain = gain;
    ch.src = src;
    ch.splitter = splitter;
    ch.status = 'ok';
    stream.getAudioTracks()[0].addEventListener('ended', () => { ch.status = 'error'; ch.error = 'Device disconnected'; });
  } catch (err) {
    ch.status = 'error';
    ch.error = (err && (err.message || err.name)) || 'Unavailable';
  }
}

export function stopChannel(id) {
  const ch = channels.get(id);
  if (!ch) return;
  channels.delete(id);
  try { if (ch.stream) ch.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  try { if (ch.src) ch.src.disconnect(); if (ch.gain) ch.gain.disconnect(); if (ch.splitter) ch.splitter.disconnect(); } catch { /* ignore */ }
}

export function applyGain(cfg) {
  const ch = channels.get(cfg.id);
  if (ch && ch.gain) ch.gain.gain.setTargetAtTime(cfg.muted ? 0 : dbToGain(cfg.volumeDb), ctx.currentTime, 0.015);
}

export function syncChannels() {
  for (const cfg of state.audio) if (!channels.has(cfg.id)) startChannel(cfg);
  for (const id of [...channels.keys()]) if (!state.audio.some((c) => c.id === id)) stopChannel(id);
}

/** Peak levels in dBFS for L/R plus a decaying peak-hold marker. */
export function levels(id) {
  const ch = channels.get(id);
  const out = { peak: [-Infinity, -Infinity], hold: [-Infinity, -Infinity], ok: false };
  if (!ch || ch.status !== 'ok') return out;
  out.ok = true;
  const now = performance.now();
  for (let i = 0; i < 2; i++) {
    ch.an[i].getFloatTimeDomainData(ch.buf);
    let m = 0;
    for (let k = 0; k < ch.buf.length; k++) { const v = Math.abs(ch.buf[k]); if (v > m) m = v; }
    const db = m > 0.00001 ? 20 * Math.log10(m) : -Infinity;
    out.peak[i] = db;
    if (db >= ch.hold[i] || now - ch.holdAt[i] > 1200) { ch.hold[i] = db; ch.holdAt[i] = now; }
    out.hold[i] = ch.hold[i];
  }
  return out;
}
