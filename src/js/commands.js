// High-level commands shared by buttons, menus and global hotkeys.
import { state } from './store.js';
import { formatName, fmtBytes, fmtTime } from './util.js';
import * as recorder from './recorder.js';
import * as compositor from './compositor.js';
import { toast } from './widgets.js';
import * as stream from './stream.js';
import { openSettings } from './settings.js';

export async function startRecording() {
  if (recorder.rec.phase !== 'idle') return;
  const r = await recorder.start();
  if (!r.ok) toast(`Could not start recording: ${r.error}`, { kind: 'error', timeout: 8000 });
  else if (r.notice) toast(r.notice, { kind: 'warn', timeout: 8000 });
}

export async function stopRecording() {
  if (!recorder.isActive()) return;
  const r = await recorder.stop();
  if (!r) return;
  if (!r.ok) {
    toast(`Recording failed: ${r.error}${r.path ? `\nWhat was captured is saved at ${r.path}` : ''}`, { kind: 'error', timeout: 12000 });
    return;
  }
  const name = r.path.split(/[\\/]/).pop();
  const drop = r.dropped > Math.max(4, (r.durationMs / 1000) * state.settings.fps * 0.01) ?`\nEncoder skipped ${r.dropped} frame(s) — try a faster NVENC preset or lower resolution/fps.` : '';
  toast(`Saved ${name} · ${fmtTime(r.durationMs)} · ${fmtBytes(r.bytes)}${r.warning ? `\n${r.warning}` : ''}${drop}`, {
    kind: r.warning ? 'warn' : 'success',
    timeout: 12000,
    actions: [
      { label: 'Show in folder', onClick: () => window.api.showInFolder(r.path) },
      { label: 'Play', onClick: () => window.api.openFile(r.path) },
    ],
  });
}

export async function toggleRecording() {
  if (recorder.rec.phase === 'idle') await startRecording();
  else if (recorder.isActive()) await stopRecording();
}

export const togglePause = () => recorder.togglePause();

export async function takeScreenshot() {
  const blob = await compositor.screenshotBlob();
  if (!blob) { toast('Screenshot failed.', { kind: 'error' }); return; }
  const data = await blob.arrayBuffer();
  const file = await window.api.saveShot({ dir: state.settings.recPath, name: `${formatName(state.settings.filename)}.png`, data });
  toast(`Screenshot saved: ${file.split(/[\\/]/).pop()}`, {
    kind: 'success',
    actions: [{ label: 'Show in folder', onClick: () => window.api.showInFolder(file) }],
  });
}

export async function toggleStreaming() {
  if (stream.st.phase === 'stopping') return;
  if (stream.st.phase !== 'idle') { await stream.stop(); return; }
  const r = await stream.start();
  if (!r.ok) {
    toast(r.error, {
      kind: 'error',
      timeout: 9000,
      actions: r.needsSetup ? [{ label: 'Open Settings', onClick: openSettings }] : [],
    });
  }
}

export async function quitApp() {
  if (recorder.rec.phase === 'processing') {
    toast('Finishing your recording — RecScreen will be ready to close in a moment.', { kind: 'warn' });
    return;
  }
  if (stream.isActive()) await stream.stop();
  if (recorder.isActive()) await stopRecording();
  window.api.quit();
}

export const openRecordings =() => window.api.openDir(state.settings.recPath);
