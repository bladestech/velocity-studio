// Encoder benchmark + recommendation wizard.
//
// Works on any PC: it only tests the encoders that actually initialise here (NVIDIA NVENC, AMD AMF, Intel
// Quick Sync, x264 / x265 on the CPU), times real encodes at the user's output resolution and frame rate,
// and finds the best-quality preset each one sustains in real time with headroom. From those numbers it
// recommends a recording profile and a streaming encoder, which the user can review and apply.
// Runs automatically on first launch (and again if the graphics card changes); also available in Settings.
import { state, save, emit } from './store.js';
import { h } from './util.js';
import { icon } from './icons.js';
import { modal, toast } from './widgets.js';
import * as recorder from './recorder.js';
import * as compositor from './compositor.js';

const { ENCODERS, FAMILIES } = recorder;

// Minimum speed (x real time) to count as "keeps up". Hardware encoders run on a dedicated chip; software ones
// share the CPU with whatever is being recorded, so they need more headroom.
const TARGET = { hardware: 1.25, software: 1.6 };
const CODEC_RANK = { av1: 3, hevc: 2, h264: 1 };
const FAMILY_RANK = { nvenc: 3, amf: 2, qsv: 1, x264: 0, x265: 0 };
const CODEC_NAME = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };

const presetsBestFirst = (fam) => FAMILIES[fam].presets.map(([v]) => v).reverse();
const presetLabel = (fam, v) => (FAMILIES[fam].presets.find(([p]) => p === v) || [v, v])[1].replace(/ \(.*\)$/, '');

/** Bitrate (kbps) that gives clean results for a codec at a given pixel rate. */
export function suggestBitrate(codec, w, h, fps) {
  const rate = (w * h * fps) / (1920 * 1080 * 60);
  const base = 16000 * rate ** 0.75;
  const k = { h264: 1, hevc: 0.7, av1: 0.6 }[codec] || 1;
  return Math.min(80000, Math.max(4000, Math.round((base * k) / 500) * 500));
}

/** Pick the recording + streaming setup from benchmark results. */
export function recommend(results) {
  const rows = Object.entries(results).map(([key, r]) => ({ enc: ENCODERS.find((e) => e.key === key), r })).filter((x) => x.enc && x.r && !x.r.stream);
  const score = ({ enc, r }) => (r.ok ? 1000 : 0) + (recorder.kindOf(enc) === 'hardware' ? 100 : 0) + CODEC_RANK[enc.codec] * 10 + FAMILY_RANK[enc.family];
  const ranked = rows.filter((x) => x.r.tried.some((t) => t.speed > 0)).sort((a, b) => score(b) - score(a));
  const rec = ranked.find((x) => x.r.ok) || null;

  // Streaming: Twitch/YouTube/Kick want H.264. A hardware H.264 encoder that keeps up is ideal; otherwise x264.
  const hwH264 = rows.filter((x) => recorder.kindOf(x.enc) === 'hardware' && x.enc.codec === 'h264' && x.r.ok)
    .sort((a, b) => FAMILY_RANK[b.enc.family] - FAMILY_RANK[a.enc.family])[0];
  const x264s = results['stream-x264'];
  let streamPick = null;
  if (hwH264) streamPick = { encoder: hwH264.enc.family, label: hwH264.enc.short, speed: hwH264.r.speed };
  else if (x264s && x264s.tried.some((t) => t.speed > 0)) streamPick = { encoder: 'x264', preset: x264s.preset, label: `x264 · ${presetLabel('x264', x264s.preset)}`, speed: x264s.speed, ok: x264s.ok };
  return { ranked, rec, streamPick };
}

function buildJobs() {
  const sup = recorder.supportedEncoders().filter((e) => e.backend === 'ffmpeg');
  const hasHwHevc = sup.some((e) => recorder.kindOf(e) === 'hardware' && e.codec === 'hevc');
  const jobs = [];
  for (const e of sup) {
    const kind = recorder.kindOf(e);
    // x265 on the CPU is only worth timing when there is no hardware HEVC to use instead.
    if (e.family === 'x265' && hasHwHevc) continue;
    jobs.push({ id: e.key, ffCodec: e.ffCodec, presets: presetsBestFirst(e.family), target: TARGET[kind] });
  }
  // Order: hardware first so the most likely recommendation shows up early.
  jobs.sort((a, b) => (TARGET.hardware === b.target) - (TARGET.hardware === a.target));
  const hwH264 = sup.some((e) => recorder.kindOf(e) === 'hardware' && e.codec === 'h264');
  if (!hwH264 && sup.some((e) => e.family === 'x264')) {
    // Streams are encoded at the stream resolution with CBR; time x264 for that separately.
    jobs.push({ id: 'stream-x264', ffCodec: 'libx264', presets: presetsBestFirst('x264'), target: TARGET.software, live: true });
  }
  return jobs;
}

function streamSize() {
  const { w, h } = compositor.getSize();
  const cfg = state.settings.stream;
  const outH = Math.min(h, cfg.height || h);
  return { w: Math.round(((outH * 16) / 9) / 2) * 2, h: outH, fps: Math.min(state.settings.fps, cfg.fps || state.settings.fps) };
}

/* ------------------------------------------------------------------ */

let running = false;

/**
 * Open the benchmark wizard.
 * reason: 'first-run' | 'gpu-changed' | 'manual'. Resolves true if the user applied new settings.
 */
export async function openBenchmark({ reason = 'manual' } = {}) {
  if (running) return false;
  running = true;
  try {
    if (!recorder.isProbed()) await recorder.probeHardware();
    const gpu = await window.api.gpuInfo().catch(() => ({ name: 'Unknown GPU' }));
    return await wizard(reason, gpu);
  } finally {
    running = false;
  }
}

function wizard(reason, gpu) {
  const { w: outW, h: outH } = compositor.getSize();
  const fps = state.settings.fps;
  const ss = streamSize();
  const jobs = buildJobs();
  const swOnly = !recorder.hasHardware();

  const title = { 'first-run': 'Find your best recording settings', 'gpu-changed': 'New graphics card detected', manual: 'Encoder benchmark' }[reason];
  const stage = h('div', { class: 'bench-stage' });
  let api = null;
  let applied = false;
  let cur = null;

  const swap = (node, foot) => {
    // Cross-fade between wizard steps while the dialog smoothly resizes to the new step's height.
    const from = stage.offsetHeight;
    const next = h('div', { class: 'bench-view enter' }, node);
    if (cur) cur.remove();
    stage.append(next);
    cur = next;
    if (from) {
      stage.style.height = `${from}px`;
      const to = next.offsetHeight;
      requestAnimationFrame(() => { stage.style.height = `${to}px`; });
      clearTimeout(stage.t);
      stage.t = setTimeout(() => { stage.style.height = ''; }, 340);
    }
    requestAnimationFrame(() => requestAnimationFrame(() => next.classList.remove('enter')));
    api.foot.replaceChildren(...foot);
  };
  const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, type: 'button', onclick }, label);

  /* ---- step 1: intro ---- */
  const chip = (ic, label, value) => h('div', { class: 'bench-chip' }, h('span', { class: 'bench-chip-ic', html: icon(ic, 16) }), h('div', {}, h('div', { class: 'bench-chip-label' }, label), h('div', { class: 'bench-chip-value' }, value)));
  const intro = h('div', { class: 'bench-intro' },
    h('p', { class: 'bench-lead' }, reason === 'gpu-changed'
      ? `Velocity Studio is now running on a different graphics card. A quick benchmark re-tunes your encoder settings for it.`
      : 'Velocity Studio will test every encoder your PC supports at your output resolution and frame rate, then pick the best quality that still records smoothly.'),
    h('div', { class: 'bench-chips' },
      chip('display', 'Graphics card', gpu.name || 'Unknown GPU'),
      chip('record', 'Output', `${outW}×${outH} · ${fps} fps`),
      chip('gear', 'Encoders', String(jobs.filter((j) => !j.live).length))),
    swOnly ? h('p', { class: 'note warn' }, 'No hardware encoder was found on this PC, so software (CPU) encoders will be tested. Updating your graphics driver may enable GPU encoding.') : null,
    h('p', { class: 'note' }, 'Takes about 15–60 seconds. For accurate results, close games and other heavy apps first. Nothing is recorded or uploaded.'));

  const later = () => {
    if (reason !== 'manual') { state.settings.benchmark = { gpu: gpu.name, skipped: true, at: Date.now() }; save(); }
    api.close(null);
  };

  /* ---- step 2: running ---- */
  const rows = new Map();
  const runList = h('div', { class: 'bench-list' });
  const addRow = (job) => {
    const enc = ENCODERS.find((e) => e.key === job.id);
    const name = job.live ? `x264 for streaming (${ss.w}×${ss.h})` : enc.label;
    const kind = job.live ? 'software' : recorder.kindOf(enc);
    const bar = h('div', { class: 'bench-bar' }, h('span'));
    const status = h('span', { class: 'bench-status' }, 'Waiting');
    const row = h('div', { class: 'bench-row pending' },
      h('div', { class: 'bench-row-top' }, h('span', { class: `bench-kind ${kind}` }, kind === 'hardware' ? 'GPU' : 'CPU'), h('span', { class: 'bench-name' }, name), status),
      bar);
    rows.set(job.id, { row, bar: bar.firstChild, status, job });
    runList.append(row);
  };
  jobs.forEach(addRow);
  const progress = h('div', { class: 'bench-progress' }, h('span'));
  const phaseText = h('div', { class: 'bench-phase' }, 'Preparing test footage…');
  const runView = h('div', { class: 'bench-running' }, h('div', { class: 'bench-progress-wrap' }, phaseText, progress), runList);

  const famOf = (job) => (job.live ? 'x264' : ENCODERS.find((e) => e.key === job.id).family);
  const showSpeed = (x, speed, ok) => {
    const pct = Math.min(100, (speed / 3) * 100);
    x.bar.style.transform = `scaleX(${pct / 100})`;
    x.bar.parentElement.classList.toggle('ok', ok);
    x.bar.parentElement.classList.toggle('slow', !ok);
  };

  let cancelled = false;
  async function start() {
    swap(runView, [btn('Cancel', async () => { cancelled = true; await window.api.benchCancel(); api.close(null); })]);
    const off = window.api.onBenchProgress((d) => {
      if (d.total) progress.firstChild.style.transform = `scaleX(${Math.min(1, d.done / d.total)})`;
      const x = d.id && rows.get(d.id);
      if (d.phase === 'encode' && x) {
        x.row.className = 'bench-row active';
        x.status.textContent = `Testing ${presetLabel(famOf(x.job), d.preset)}…`;
        phaseText.textContent = `Testing ${x.row.querySelector('.bench-name').textContent}`;
      } else if (d.phase === 'result' && x) {
        const r = d.result;
        const failed = !r.tried.some((t) => t.speed > 0);
        x.row.className = `bench-row done ${failed ? 'failed' : r.ok ? 'ok' : 'slow'}`;
        x.status.textContent = failed ? 'Not usable' : `${presetLabel(famOf(x.job), r.preset)} · ${r.speed.toFixed(1)}× real time`;
        if (!failed) showSpeed(x, r.speed, r.ok);
      }
    });
    const recJobs = jobs.filter((j) => !j.live);
    const liveJobs = jobs.filter((j) => j.live);
    let res = { ok: true, results: {} };
    try {
      if (recJobs.length) {
        const r = await window.api.benchRun({ w: outW, h: outH, fps, bitrate: state.settings.videoBitrate, jobs: recJobs });
        if (!r.ok) res = r; else Object.assign(res.results, r.results);
      }
      if (res.ok && liveJobs.length && !cancelled) {
        const r = await window.api.benchRun({ w: ss.w, h: ss.h, fps: ss.fps, bitrate: state.settings.stream.bitrate, jobs: liveJobs });
        if (r.ok) for (const [k, v] of Object.entries(r.results)) res.results[k] = { ...v, stream: true };
      }
    } finally { off(); }
    if (cancelled) return;
    if (!res.ok) {
      toast(`Benchmark failed: ${res.error}`, { kind: 'error', timeout: 9000 });
      api.close(null);
      return;
    }
    progress.firstChild.style.transform = 'scaleX(1)';
    setTimeout(() => showResults(res.results), 450);
  }

  /* ---- step 3: results ---- */
  function showResults(results) {
    const { ranked, rec, streamPick } = recommend(results);
    let choice = rec ? rec.enc.key : (ranked[0] && ranked[0].enc.key) || null;
    const list = h('div', { class: 'bench-choices' });
    const bitrateFor = (enc) => suggestBitrate(enc.codec, outW, outH, fps);

    if (!ranked.length) {
      list.append(h('p', { class: 'note warn' }, 'None of the GPU/CPU encoders could keep up at this resolution and frame rate. Velocity Studio will keep using its built-in encoder. Try a lower output resolution or frame rate in Settings → Video, then run the benchmark again.'));
    }
    for (const { enc, r } of ranked) {
      const kind = recorder.kindOf(enc);
      const radio = h('input', { type: 'radio', name: 'bench-choice', value: enc.key });
      radio.checked = enc.key === choice;
      radio.addEventListener('change', () => { choice = enc.key; });
      const tags = [];
      if (rec && enc.key === rec.enc.key) tags.push(h('span', { class: 'tag accent' }, 'Recommended'));
      if (!r.ok) tags.push(h('span', { class: 'tag warn' }, 'May drop frames'));
      list.append(h('label', { class: `bench-choice ${r.ok ? '' : 'slow'}` },
        radio,
        h('div', { class: 'bench-choice-main' },
          h('div', { class: 'bench-choice-title' }, enc.label, ...tags),
          h('div', { class: 'bench-choice-sub' }, `${kind === 'hardware' ? 'GPU' : 'CPU'} · ${presetLabel(enc.family, r.preset)} preset · ${(bitrateFor(enc) / 1000).toFixed(1)} Mbps`)),
        h('div', { class: 'bench-choice-speed' }, h('b', {}, `${r.speed.toFixed(1)}×`), h('span', {}, 'real time'))));
    }

    const why = rec
      ? `${rec.enc.label} at the ${presetLabel(rec.enc.family, rec.r.preset)} preset records ${outW}×${outH} at ${fps} fps ${rec.r.speed.toFixed(1)}× faster than real time${recorder.kindOf(rec.enc) === 'hardware' ? ' on your GPU’s dedicated encoder, so it won’t slow down games' : ''}.`
      : 'No encoder kept up with real time here; the fastest one is selected, but recordings may drop frames.';
    const codecNote = rec && rec.enc.codec !== 'h264'
      ? h('p', { class: 'note' }, `${CODEC_NAME[rec.enc.codec]} gives smaller files than H.264 at the same quality. If an older editor or player can’t open your recordings, pick an H.264 option instead.`)
      : null;
    const streamLine = streamPick
      ? h('div', { class: 'bench-stream' }, h('span', { html: icon('stream', 16) }), h('div', {}, h('b', {}, 'Streaming: '), streamPick.label, streamPick.ok === false ? ' (may struggle at this stream resolution; consider 720p)' : ''))
      : null;

    const node = h('div', { class: 'bench-results' },
      h('div', { class: 'bench-hero' }, h('span', { class: 'bench-hero-ic', html: icon('check', 20) }), h('div', {},
        h('div', { class: 'bench-hero-title' }, rec ? 'Your best recording setup' : 'Benchmark finished'),
        h('div', { class: 'bench-hero-sub' }, why))),
      list, codecNote, streamLine,
      h('p', { class: 'note' }, 'You can change any of this later in Settings → Output, or run the benchmark again from there.'));

    const apply = () => {
      const s = state.settings;
      const pickRow = ranked.find((x) => x.enc.key === choice);
      if (pickRow) {
        s.encoder = pickRow.enc.key;
        s.tuning[pickRow.enc.family] = { ...s.tuning[pickRow.enc.family], preset: pickRow.r.preset, rc: 'vbr' };
        s.videoBitrate = bitrateFor(pickRow.enc);
        if (s.container === 'webm') s.container = 'mkv';
      }
      if (streamPick) { s.stream.encoder = streamPick.encoder; if (streamPick.preset) s.stream.preset = streamPick.preset; }
      s.benchmark = {
        gpu: gpu.name, at: Date.now(), w: outW, h: outH, fps,
        results: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { preset: r.preset, speed: Math.round(r.speed * 100) / 100, ok: r.ok }])),
      };
      save();
      emit('settings');
      applied = true;
      toast(pickRow ? `Recording with ${pickRow.enc.short} · ${presetLabel(pickRow.enc.family, pickRow.r.preset)} preset.` : 'Benchmark saved.', { kind: 'success' });
      api.close('ok');
    };
    swap(node, [btn(reason === 'manual' ? 'Close' : 'Keep current settings', () => {
      if (reason !== 'manual') { state.settings.benchmark = { gpu: gpu.name, at: Date.now(), kept: true }; save(); }
      api.close(null);
    }), btn('Apply settings', apply, 'primary')]);
  }

  return modal({
    title,
    width: 600,
    className: 'bench-modal',
    dismissible: reason === 'manual',
    body: stage,
    buttons: [{ label: 'x', value: null }], // placeholder so the footer exists; replaced in onOpen
    onOpen: (a) => {
      api = a;
      const go = btn(jobs.length ? 'Start benchmark' : 'No encoders to test', start, 'primary');
      go.disabled = !jobs.length;
      swap(intro, [btn(reason === 'manual' ? 'Cancel' : 'Not now', later), go]);
    },
  }).then(() => applied);
}

/** On startup: run the wizard the first time, or when the graphics card has changed since the last run. */
export async function maybeRunOnStartup() {
  const info = await window.api.info();
  if (info.selftest || !info.ffmpeg) return;
  const gpu = await window.api.gpuInfo().catch(() => null);
  const b = state.settings.benchmark;
  let reason = null;
  if (!b) reason = 'first-run';
  else if (gpu && b.gpu && gpu.name !== b.gpu) reason = 'gpu-changed';
  if (reason) openBenchmark({ reason });
}
