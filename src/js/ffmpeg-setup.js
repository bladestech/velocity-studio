// ffmpeg first-launch setup. ffmpeg isn't shipped in the installer; on first launch the splash pauses with the
// logo on screen and asks to download it. While it downloads, the V fills up (vloader.js); then the app launches
// as usual. "Not now" keeps the built-in (Chromium) encoders, and Settings -> Output offers the download later.
//
// After the main build is installed the encoders are probed. If any GPU's hardware encoder (NVENC, AMF or
// Quick Sync) won't start on it - typically an older driver - the V refills for the smaller compatibility build
// (6.1.1), which main.js then uses for those encoders only. If it doesn't rescue any encoder, it is removed.
import { state, save } from './store.js';
import { h } from './util.js';
import { icon } from './icons.js';
import { modal, toast } from './widgets.js';
import { createVLoader } from './vloader.js';
import * as recorder from './recorder.js';
import { introDone } from './splash.js';

const MB = (b) => (b / 1048576).toFixed(b >= 10 * 1048576 ? 0 : 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download + verify + unpack the main build, re-probe, and fetch the compatibility build if NVENC needs it.
 * ui: { loader, status(title, detail), onCancelable(fn|null) }. Resolves { ok, cancelled, error }.
 */
async function installFlow(ui) {
  const st = await window.api.ffmpegStatus();
  const run = async (which, title) => {
    const build = st.builds[which];
    let lastT = 0, lastB = 0, speed = 0;
    ui.loader.setBusy(false);
    ui.status(title, `0 of ${MB(build.size)} MB`);
    ui.progress?.(0);
    const off = window.api.onFfmpegProgress((d) => {
      if (d.which !== which) return;
      if (d.phase === 'download') {
        const total = d.total || build.size;
        ui.loader.setProgress(d.got / total);
        ui.progress?.(d.got / total);
        const now = performance.now();
        if (lastT && now - lastT > 400) { const s = ((d.got - lastB) / (now - lastT)) * 1000; speed = speed ? speed * 0.7 + s * 0.3 : s; lastT = now; lastB = d.got; }
        if (!lastT) { lastT = now; lastB = d.got; }
        ui.status(title, `${MB(d.got)} of ${MB(total)} MB${speed ? ` · ${MB(speed)} MB/s` : ''}`);
      } else if (d.phase === 'verify') {
        ui.loader.setProgress(1); ui.progress?.(1); ui.loader.setBusy(true); ui.onCancelable(null);
        ui.status('Verifying the download…', 'Checking it matches the published checksum');
      } else if (d.phase === 'extract') {
        ui.status('Unpacking…', build.label);
      }
    });
    ui.onCancelable(() => window.api.ffmpegCancel());
    try { return await window.api.ffmpegInstall(which); } finally { off(); ui.onCancelable(null); }
  };

  if (!st.main) {
    const r = await run('main', `Downloading ${st.builds.main.label}`);
    if (!r.ok) return r;
  }
  ui.loader.setProgress(1); ui.loader.setBusy(true);
  ui.status('Checking your encoders…', 'Testing which ones work on this PC');
  await recorder.probeHardware();

  // A GPU whose hardware encoder didn't start (usually an older driver): try the compatibility build.
  const gpu = await window.api.gpuInfo().catch(() => null);
  if (recorder.gpusMissingEncoder(gpu).length && !st.legacy) {
    ui.loader.setBusy(false);
    ui.loader.setProgress(0); // drain, then refill for the second download
    ui.progress?.(0);
    await sleep(700);
    const r = await run('legacy', 'Getting the compatibility build for your graphics driver');
    if (r.ok) {
      ui.loader.setProgress(1); ui.loader.setBusy(true);
      ui.status('Checking your encoders…', 'Testing which ones work on this PC');
      await recorder.probeHardware();
      // It didn't rescue anything (the driver is the problem): don't keep 30 MB around for nothing.
      if (!recorder.usesLegacy()) { await window.api.ffmpegRemove('legacy'); await recorder.probeHardware(); }
    } else if (r.cancelled) return r;
    // A failed compatibility download isn't fatal: everything else already works.
  }
  ui.loader.setBusy(false);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Startup: the splash turns into the setup screen                     */
/* ------------------------------------------------------------------ */

/** Run on first launch while the splash is up. Resolves once the app may launch (installed or skipped). */
export async function setupOnStartup() {
  const root = document.getElementById('splash');
  if (!root) return;
  await introDone();
  const stage = root.querySelector('.splash-stage');
  const loader = createVLoader({ className: 'splash-vl' });
  stage.append(loader);
  loader.jumpTo(1);
  loader.start();
  const panel = h('div', { class: 'setup-panel' });
  root.append(panel);
  // Next frame: slide the logo up, swap the solid V for the loader and drain it, bring in the panel.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  root.classList.add('setup-on');
  await sleep(250);
  loader.setProgress(0);

  const show = (...children) => {
    const step = h('div', { class: 'setup-step' }, ...children);
    const old = panel.firstChild;
    if (old) { old.classList.add('out'); setTimeout(() => old.remove(), 180); }
    panel.append(step);
    requestAnimationFrame(() => requestAnimationFrame(() => step.classList.add('in')));
    return step;
  };
  const title = h('div', { class: 'setup-title' });
  const detail = h('div', { class: 'setup-detail' });
  const bar = h('div', { class: 'setup-progress' }, h('span'));
  const setBar = (p) => { bar.firstChild.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`; };
  const cancelBtn = h('button', { class: 'setup-link', type: 'button' }, 'Cancel');
  let cancelFn = null;
  cancelBtn.onclick = () => { if (cancelFn) cancelFn(); };

  const sizeMB = MB((await window.api.ffmpegStatus()).builds.main.size);
  for (;;) {
    const choice = await new Promise((resolve) => {
      show(
        h('div', { class: 'setup-kicker' }, h('span', { class: 'setup-kicker-ic', html: icon('refresh', 12) }), 'Setup'),
        h('div', { class: 'setup-title' }, 'One last step'),
        h('p', { class: 'setup-text' }, 'Velocity Studio uses ffmpeg, the free open-source video toolkit, to record and stream with your graphics card. It’s a one-time download.'),
        h('div', { class: 'setup-actions' },
          h('button', { class: 'btn primary big', type: 'button', onclick: () => resolve('go') }, `Download ffmpeg · ${sizeMB} MB`),
          h('button', { class: 'setup-link', type: 'button', onclick: () => resolve('skip') }, 'Not now')),
        h('div', { class: 'setup-fine' }, 'Verified against a published checksum before use · GPL v3'));
    });
    if (choice === 'skip') {
      state.settings.ffmpegDeclined = true;
      save();
      break;
    }
    show(title, detail, bar, h('div', { class: 'setup-actions' }, cancelBtn));
    const r = await installFlow({
      loader,
      status: (t, d) => { title.textContent = t; detail.textContent = d || ''; },
      progress: setBar,
      onCancelable: (fn) => { cancelFn = fn; cancelBtn.style.visibility = fn ? 'visible' : 'hidden'; },
    });
    if (r.ok) {
      show(h('div', { class: 'setup-title ok' }, 'All set'), h('div', { class: 'setup-detail' }, 'Opening Velocity Studio…'));
      state.settings.ffmpegDeclined = false;
      save();
      await sleep(900);
      break;
    }
    loader.setBusy(false);
    loader.setProgress(0);
    if (r.cancelled) continue;
    const again = await new Promise((resolve) => {
      show(
        h('div', { class: 'setup-title err' }, 'The download didn’t finish'),
        h('p', { class: 'setup-text' }, r.error || 'Something went wrong.'),
        h('div', { class: 'setup-actions' },
          h('button', { class: 'btn primary big', type: 'button', onclick: () => resolve(true) }, 'Try again'),
          h('button', { class: 'setup-link', type: 'button', onclick: () => resolve(false) }, 'Not now')));
    });
    if (!again) break;
  }

  // Hand back to the splash: the solid V returns, the logo re-centres, and the normal launch plays.
  root.classList.remove('setup-on');
  panel.classList.add('gone');
  await sleep(560);
  loader.stop();
  loader.remove();
  panel.remove();
  if (state.settings.ffmpegDeclined) {
    toast('Recording with the built-in encoder for now. You can download ffmpeg any time in Settings → Output.', { timeout: 9000 });
  }
}

/* ------------------------------------------------------------------ */
/* From Settings: the same loader in a dialog                          */
/* ------------------------------------------------------------------ */

/** Download ffmpeg from a dialog. Resolves true when installed. */
export function installFromSettings() {
  const loader = createVLoader({ className: 'dialog-vl' });
  const title = h('div', { class: 'setup-title' }, 'Preparing…');
  const detail = h('div', { class: 'setup-detail' });
  const bar = h('div', { class: 'setup-progress' }, h('span'));
  const body = h('div', { class: 'ff-dialog' }, h('div', { class: 'ff-dialog-logo' }, loader), title, detail, bar);
  let ok = false;
  return modal({
    title: 'Download ffmpeg',
    width: 440,
    dismissible: false,
    body,
    buttons: [{ label: 'Cancel', value: null }],
    onOpen: async ({ close, foot }) => {
      loader.start();
      const cancel = foot.querySelector('.btn');
      cancel.onclick = () => { if (cancel.dataset.fn) window.api.ffmpegCancel(); else close(null); };
      const r = await installFlow({
        loader,
        status: (t, d) => { title.textContent = t; detail.textContent = d || ''; },
        progress: (p) => { bar.firstChild.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`; },
        onCancelable: (fn) => { cancel.dataset.fn = fn ? '1' : ''; cancel.disabled = !fn; },
      });
      cancel.disabled = false;
      cancel.dataset.fn = '';
      if (r.ok) {
        ok = true;
        state.settings.ffmpegDeclined = false;
        save();
        title.textContent = 'All set';
        title.classList.add('ok');
        detail.textContent = 'GPU and CPU encoders are ready.';
        cancel.textContent = 'Done';
        cancel.classList.add('primary');
      } else {
        title.textContent = r.cancelled ? 'Download cancelled' : 'The download didn’t finish';
        title.classList.add('err');
        detail.textContent = r.cancelled ? '' : r.error;
        cancel.textContent = 'Close';
      }
      loader.setBusy(false);
      cancel.onclick = () => close(ok ? 'ok' : null);
    },
  }).then(() => { loader.stop(); return ok; });
}
