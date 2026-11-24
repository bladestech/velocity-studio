import { state, load, save, on, activeScene, newItem, emit, BASE_W, BASE_H } from './store.js';
import { sleep } from './util.js';
import * as compositor from './compositor.js';
import * as audio from './audio.js';
import * as resources from './resources.js';
import * as preview from './preview.js';
import * as ui from './ui.js';
import * as recorder from './recorder.js';
import * as cmd from './commands.js';
import * as stream from './stream.js';
import { fitWhenReady } from './actions.js';
import { setAppInfo, applyHotkeys } from './settings.js';
import { toast } from './widgets.js';
import * as splash from './splash.js';
import { maybeRunOnStartup } from './benchmark.js';
import { setupOnStartup } from './ffmpeg-setup.js';

/** Taskbar badge (red = recording, amber = paused, cyan = live) and a matching window title. */
function reportActivity() {
  const rec = recorder.rec.phase;
  const live = stream.st.phase === 'live' || stream.st.phase === 'reconnecting';
  window.api.setActivity({ rec, live });
  const tags = [];
  if (rec === 'recording') tags.push('● REC');
  else if (rec === 'paused') tags.push('❚❚ Paused');
  else if (rec === 'processing') tags.push('Saving…');
  if (live) tags.push('LIVE');
  document.title = tags.length ? `${tags.join(' · ')} · Velocity Studio` : 'Velocity Studio';
}

async function boot() {
  const info = await window.api.info();
  setAppInfo(info);
  load();
  if (!state.settings.recPath) state.settings.recPath = info.defaultRecDir;
  if (info.outDir) state.settings.recPath = info.outDir; // selftest only

  compositor.init();
  audio.init();
  preview.init();
  ui.init();
  preview.bindEvents(on);

  if (state.firstRun) {
    try {
      const screens = await window.api.listSources({ types: ['screen'], thumb: 2 });
      if (screens[0]) {
        const item = newItem('display', 'Display Capture', { sourceId: screens[0].id, label: screens[0].name }, BASE_W, BASE_H);
        activeScene().items.push(item);
        state.selectedItemId = item.id;
        emit('items');
        fitWhenReady(item);
      }
    } catch { /* no displays available */ }
    save();
  }

  resources.sync();
  audio.syncChannels();
  emit('scenes'); emit('items'); emit('audio');
  window.api.protect(state.settings.hideFromCapture);
  applyHotkeys();

  window.api.onHotkey((a) => {
    if (a === 'record') cmd.toggleRecording();
    else if (a === 'pause') cmd.togglePause();
    else if (a === 'screenshot') cmd.takeScreenshot();
    else if (a === 'stream') cmd.toggleStreaming();
  });
  window.api.onStreamStatus((d) => stream.handleStatus(d));
  let announcedReconnect = false;
  on('streaming', (e) => {
    const d = e.detail;
    if (d.phase === 'idle' && d.error) toast(`Stream stopped: ${d.error}`, { kind: 'error', timeout: 12000 });
    if (d.phase === 'reconnecting' && !announcedReconnect) { announcedReconnect = true; toast('Lost the connection to the streaming server. Trying to reconnect…', { kind: 'warn', timeout: 6000 }); }
    if (d.phase === 'live' || d.phase === 'idle') announcedReconnect = false;
    window.api.setBusy(recorder.rec.phase !== 'idle' || d.phase !== 'idle');
    reportActivity();
  });
  window.api.onRequestClose(() => cmd.quitApp());
  window.api.onEncDied((d) => {
    if (recorder.rec.ff && recorder.rec.id === d.id && recorder.isActive()) {
      toast(`The hardware encoder stopped: ${d.error}`, { kind: 'error', timeout: 10000 });
      cmd.stopRecording();
    }
  });
  recorder.probeHardware();
  on('recording', (e) => { window.api.setBusy(e.detail.phase !== 'idle' || stream.isActive()); reportActivity(); });

  if (!recorder.supportedEncoders().length) toast('No supported video encoder found in this build.', { kind: 'error', timeout: 0 });
  // ffmpeg is downloaded on first launch (ffmpeg-setup.js) rather than shipped in the installer.
  // (Linux uses the system ffmpeg, so there is nothing to download there.)
  const needSetup = info.platform === 'win32' && !info.ffmpeg && !info.selftest && !state.settings.ffmpegDeclined;

  // First launch (or a new graphics card): offer the encoder benchmark once the intro has played.
  (needSetup ? setupOnStartup() : Promise.resolve())
    .then(() => splash.finish({ instant: !!info.selftest }))
    .then(() => maybeRunOnStartup())
    .catch((err) => { console.error(err); splash.finish({ instant: true }); });
  if (info.selftest) runSelfTest();
}

async function runSelfTest() {
  const result = { steps: [] };
  const step = (s) => result.steps.push(s);
  try {
    await sleep(3500);
    const item = activeScene().items[0];
    const res = item && resources.getRes(item);
    step(`source status: ${res ? res.status : 'none'} ${res ? `${res.width}x${res.height}` : ''} ${res && res.error ? res.error : ''}`);
    await window.api.selftestShot('selftest-idle.png');
    await cmd.startRecording();
    step(`phase after start: ${recorder.rec.phase}`);
    await sleep(2500);
    await window.api.selftestShot('selftest-recording.png');
    await sleep(2500);
    step(`measured fps: ${compositor.getFps().toFixed(1)}`);
    const out = await recorder.stop();
    result.output = out;
  } catch (err) {
    result.error = String(err && err.stack || err);
  }
  await window.api.selftestDone(result);
}

boot().catch((err) => {
  console.error(err);
  splash.finish({ instant: true });
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:40px;color:#ff8a80;background:#000;padding:16px;overflow:auto">Startup error:\n${String(err && err.stack || err)}</pre>`);
});
