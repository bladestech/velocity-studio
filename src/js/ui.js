// Docks (scenes / sources / mixer / controls), menu bar and status bar.
import { state, on, activeScene, selectedItem } from './store.js';
import { $, h, fmtTime, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { contextMenu, closeMenu } from './widgets.js';
import { KINDS, kindInfo } from './source-dialog.js';
import * as A from './actions.js';
import * as audio from './audio.js';
import * as recorder from './recorder.js';
import * as compositor from './compositor.js';
import * as cmd from './commands.js';
import * as stream from './stream.js';
import { getRes } from './resources.js';
import { openSettings, openShortcuts, openAbout } from './settings.js';

/* ===================== Scenes dock ===================== */
function renderScenes() {
  const list = $('#scene-list');
  list.replaceChildren();
  for (const sc of state.scenes) {
    const row = h('div', {
      class: `row-item ${sc.id === state.activeSceneId ? 'active' : ''}`,
      tabindex: 0,
      onclick: () => A.activateScene(sc.id),
      ondblclick: () => A.renameScene(sc),
      oncontextmenu: (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Rename', icon: 'edit', onClick: () => A.renameScene(sc) },
          { label: 'Duplicate', icon: 'copy', onClick: () => A.duplicateScene(sc) },
          { separator: true },
          { label: 'Remove', onClick: () => A.removeScene(sc) },
        ]);
      },
    }, h('span', { class: 'row-label' }, sc.name), h('span', { class: 'row-badge' }, String(sc.items.length)));
    list.append(row);
  }
}

/* ===================== Sources dock ===================== */
function renderSources() {
  const list = $('#source-list');
  const sc = activeScene();
  list.replaceChildren();
  if (!sc || !sc.items.length) {
    list.append(h('div', { class: 'empty-hint' }, h('div', { html: icon('plus', 22) }), h('div', {}, 'No sources'), h('small', {}, 'Click + below to add a display, window or webcam.')));
    return;
  }
  for (const it of [...sc.items].reverse()) {
    const res = getRes(it);
    const err = res && res.status === 'error';
    const row = h('div', {
      class: `row-item source-row ${it.id === state.selectedItemId ? 'active' : ''} ${it.visible ? '' : 'dim'}`,
      dataset: { id: it.id },
      tabindex: 0,
      onclick: () => A.selectItem(it.id),
      ondblclick: () => A.editSource(it),
      oncontextmenu: (e) => { e.preventDefault(); A.selectItem(it.id); itemMenu(it, e.clientX, e.clientY); },
    },
    h('span', { class: 'row-icon', html: icon(kindInfo(it.kind).icon, 15) }),
    h('span', { class: 'row-label', title: err ? res.error : it.name }, it.name),
    err ? h('span', { class: 'row-warn', title: res.error, html: '!' }) : null,
    h('button', { class: `mini-btn ${it.visible ? '' : 'off'}`, title: it.visible ? 'Hide' : 'Show', html: icon(it.visible ? 'eye' : 'eyeoff', 15), onclick: (e) => { e.stopPropagation(); A.toggleVisible(it); } }),
    h('button', { class: `mini-btn ${it.locked ? 'on' : 'off'}`, title: it.locked ? 'Unlock' : 'Lock', html: icon(it.locked ? 'lock' : 'unlock', 15), onclick: (e) => { e.stopPropagation(); A.toggleLock(it); } }));
    list.append(row);
  }
}

function highlightSelection() {
  document.querySelectorAll('#source-list .source-row').forEach((r) => r.classList.toggle('active', r.dataset.id === state.selectedItemId));
}

export function itemMenu(item, x, y) {
  if (!item) return;
  const op = (name) => () => A.transform(item, name);
  const opac = (v) => ({ label: `${Math.round(v * 100)}%`, checked: Math.abs(item.opacity - v) < 0.01, onClick: () => A.setOpacity(item, v) });
  contextMenu(x, y, [
    { label: 'Properties…', icon: 'gear', onClick: () => A.editSource(item) },
    { label: 'Rename…', icon: 'edit', onClick: () => A.renameItem(item) },
    { separator: true },
    { label: 'Fit to screen', onClick: op('fit') },
    { label: 'Stretch to screen', onClick: op('stretch') },
    { label: 'Reset size', onClick: op('reset') },
    { label: 'Center', onClick: op('center') },
    { label: 'Center horizontally', onClick: op('centerH') },
    { label: 'Center vertically', onClick: op('centerV') },
    { label: 'Flip horizontal', checked: item.flipX, onClick: op('flipX') },
    { label: 'Flip vertical', checked: item.flipY, onClick: op('flipY') },
    { label: 'Reset crop', onClick: op('resetCrop') },
    { separator: true },
    { header: 'Opacity' }, opac(1), opac(0.75), opac(0.5), opac(0.25),
    { separator: true },
    { label: 'Move up', icon: 'up', onClick: () => A.moveItem(item, 'up') },
    { label: 'Move down', icon: 'down', onClick: () => A.moveItem(item, 'down') },
    { label: 'Move to top', onClick: () => A.moveItem(item, 'top') },
    { label: 'Move to bottom', onClick: () => A.moveItem(item, 'bottom') },
    { separator: true },
    { label: 'Duplicate', icon: 'copy', onClick: () => A.duplicateItem(item) },
    { label: 'Remove', hint: 'Del', onClick: () => A.removeItem(item) },
  ]);
}

function addSourceMenu(x, y) {
  contextMenu(x, y, KINDS.map((k) => ({ label: k.label, icon: k.icon, onClick: () => A.addSource(k.kind) })));
}

/* ===================== Mixer dock ===================== */
const meters = new Map(); // channel id -> { canvas, dbEl, row }

function renderMixer() {
  const list = $('#mixer-list');
  list.replaceChildren();
  meters.clear();
  for (const ch of state.audio) {
    const dbEl = h('span', { class: 'ch-db' }, fmtDb(ch.volumeDb));
    const canvas = h('canvas', { class: 'meter', height: 22 });
    const slider = h('input', { type: 'range', class: 'fader', min: -60, max: 12, step: 0.5, value: ch.volumeDb });
    slider.addEventListener('input', () => { A.setVolume(ch, Number(slider.value)); dbEl.textContent = fmtDb(ch.volumeDb); });
    slider.addEventListener('dblclick', () => { slider.value = 0; A.setVolume(ch, 0); dbEl.textContent = fmtDb(0); });
    const muteBtn = h('button', {
      class: `mini-btn mute ${ch.muted ? 'on' : ''}`,
      title: ch.muted ? 'Unmute' : 'Mute',
      html: icon(ch.muted ? 'mute' : (ch.kind === 'desktop' ? 'speaker' : 'mic'), 17),
      onclick: () => A.toggleMute(ch),
    });
    const gear = h('button', {
      class: 'mini-btn', title: 'Channel options', html: icon('gear', 15),
      onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        contextMenu(r.right, r.bottom + 2, [
          { label: 'Properties…', icon: 'gear', onClick: () => A.editAudioChannel(ch) },
          { label: ch.muted ? 'Unmute' : 'Mute', onClick: () => A.toggleMute(ch) },
          { separator: true },
          { label: 'Remove', onClick: () => A.removeAudioChannel(ch) },
        ], { anchorRight: true });
      },
    });
    const row = h('div', { class: `mixer-ch ${ch.muted ? 'muted' : ''}` },
      h('div', { class: 'ch-top' }, h('span', { class: 'ch-name', title: ch.name }, ch.name), dbEl),
      canvas,
      h('div', { class: 'ch-ctrl' }, muteBtn, slider, gear));
    list.append(row);
    meters.set(ch.id, { canvas, row, cfg: ch });
  }
}

const fmtDb = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
const dbPos = (db) => (db === -Infinity ? 0 : Math.max(0, Math.min(1, (db + 60) / 60)));

function drawMeters() {
  for (const [id, m] of meters) {
    const c = m.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(c.clientWidth * dpr);
    const hh = Math.floor(c.clientHeight * dpr);
    if (!w || !hh) continue;
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, hh);
    g.fillStyle = '#0f1013';
    g.fillRect(0, 0, w, hh);
    const lv = audio.levels(id);
    const st = audio.getStatus(id);
    const barH = Math.floor((hh - 3 * dpr) / 2);
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#2fbf62');
    grad.addColorStop(0.7, '#2fbf62');
    grad.addColorStop(0.78, '#e6c93a');
    grad.addColorStop(0.9, '#e6c93a');
    grad.addColorStop(0.95, '#e5483f');
    grad.addColorStop(1, '#e5483f');
    for (let i = 0; i < 2; i++) {
      const y = Math.floor(dpr + i * (barH + dpr));
      g.fillStyle = '#1b1d22';
      g.fillRect(0, y, w, barH);
      if (lv.ok && !m.cfg.muted) {
        g.fillStyle = grad;
        g.fillRect(0, y, Math.floor(w * dbPos(lv.peak[i])), barH);
        const hx = Math.floor(w * dbPos(lv.hold[i]));
        if (hx > 2) { g.fillStyle = '#e8eaf0'; g.fillRect(hx - Math.ceil(dpr), y, Math.ceil(dpr * 1.5), barH); }
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.12)';
    for (let db = -50; db <= -5; db += 10) g.fillRect(Math.floor(w * dbPos(db)), 0, 1, hh);
    if (st && st.status === 'error') {
      g.fillStyle = 'rgba(15,16,19,0.82)';
      g.fillRect(0, 0, w, hh);
      g.fillStyle = '#ff8a80';
      g.font = `${11 * dpr}px "Segoe UI", sans-serif`;
      g.textBaseline = 'middle';
      g.fillText(`Unavailable — ${st.error}`.slice(0, 60), 8 * dpr, hh / 2);
    }
  }
  requestAnimationFrame(drawMeters);
}

/* ===================== Controls dock ===================== */
function updateControls(detail = {}) {
  const phase = recorder.rec.phase;
  const recBtn = $('#btn-record');
  const pauseBtn = $('#btn-pause');
  const busy = phase === 'processing';
  recBtn.classList.toggle('recording', phase === 'recording' || phase === 'paused');
  recBtn.disabled = busy;
  if (busy) recBtn.innerHTML = `<span class="spin"></span><span>Processing ${detail.pct != null ? `${detail.pct}%` : '…'}</span>`;
  else recBtn.innerHTML = (phase === 'idle' ? icon('record', 18) : icon('stop', 18)) + `<span>${phase === 'idle' ? 'Start Recording' : 'Stop Recording'}</span>`;
  pauseBtn.disabled = !(phase === 'recording' || phase === 'paused');
  pauseBtn.innerHTML = (phase === 'paused' ? icon('play', 16) : icon('pause', 16)) + `<span>${phase === 'paused' ? 'Resume Recording' : 'Pause Recording'}</span>`;
  $('#rec-dot').className = `rec-dot ${phase}`;
  $('#rec-label').textContent = { idle: 'Ready', recording: 'REC', paused: 'PAUSED', processing: 'Processing…' }[phase];
  document.body.classList.toggle('is-recording', phase === 'recording');
  document.body.classList.toggle('is-active-rec', phase === 'recording' || phase === 'paused');
}

function updateStreamControls() {
  const phase = stream.st.phase;
  const btn = $('#btn-stream');
  const live = phase === 'live';
  const busy = phase === 'connecting' || phase === 'reconnecting' || phase === 'stopping';
  btn.classList.toggle('live', live);
  btn.classList.toggle('busy', busy);
  btn.disabled = phase === 'stopping';
  const label = {
    idle: 'Start Streaming', connecting: 'Connecting… (cancel)', live: 'Stop Streaming',
    reconnecting: `Reconnecting… (${stream.st.attempt})`, stopping: 'Stopping…',
  }[phase];
  btn.innerHTML = (phase === 'idle' || busy ? icon('stream', 18) : icon('stop', 18)) + `<span>${label}</span>`;
  $('#live-badge').hidden = phase === 'idle';
  $('#live-label').textContent = live ? 'LIVE' : phase === 'reconnecting' ? 'RECONNECTING' : phase === 'stopping' ? 'STOPPING' : 'CONNECTING';
  $('#live-dot').className = `rec-dot ${phase === 'reconnecting' ? 'reconnecting' : 'live'}`;
  document.body.classList.toggle('is-live', live);
}

/* ===================== Status bar ===================== */
let lastStats = { cpu: 0, free: null };
async function pollStats() {
  try { lastStats = await window.api.stats(state.settings.recPath); } catch { /* ignore */ }
}
function renderStatus() {
  const active = recorder.isActive();
  if (stream.st.phase !== 'idle') {
    $('#live-time').textContent = fmtTime(stream.elapsed());
    const s = stream.st;
    $('#live-info').textContent = s.phase === 'live'
      ? `${s.serviceName} · ${(s.kbps / 1000).toFixed(1)} Mbps${s.dropped ? ` · ${s.dropped} dropped` : ''}`
      : (s.phase === 'reconnecting' && s.error ? s.error.slice(0, 70) : s.serviceName);
  }
  $('#rec-time').textContent = fmtTime(recorder.elapsed());
  $('#rec-size').textContent = active ? `${fmtBytes(recorder.rec.bytes)}${recorder.rec.dropped ? ` · ${recorder.rec.dropped} dropped` : ''}` : '';
  const sz = compositor.getSize();
  $('#st-res').textContent = `${sz.w}×${sz.h} @ ${state.settings.fps}`;
  $('#st-fps').textContent = `${compositor.getFps().toFixed(1)} fps`;
  $('#st-cpu').textContent = `CPU ${lastStats.cpu.toFixed(1)}%`;
  $('#st-disk').textContent = lastStats.free != null ? `Free ${fmtBytes(lastStats.free)}` : '';
  const enc = recorder.chooseEncoder();
  const rate = state.settings.nvenc.rc === 'cq' && enc && enc.backend === 'ffmpeg' ? `CQ ${state.settings.nvenc.cq}` : `${state.settings.videoBitrate / 1000} Mbps`;
  $('#st-enc').textContent = enc ? `${enc.short} · ${rate} → ${state.settings.container.toUpperCase()}` : '';
}

/* ===================== Menu bar ===================== */
function setupMenus() {
  const menus = {
    File: () => [
      { label: 'Show Recordings', icon: 'folder', onClick: cmd.openRecordings },
      { label: 'Settings', icon: 'gear', hint: '', onClick: openSettings },
      { separator: true },
      { label: 'Exit', icon: 'exit', onClick: () => cmd.quitApp() },
    ],
    Scene: () => [
      { label: 'Add Scene…', icon: 'plus', onClick: A.addScene },
      { label: 'Rename Scene…', icon: 'edit', onClick: () => A.renameScene(activeScene()) },
      { label: 'Duplicate Scene', icon: 'copy', onClick: () => A.duplicateScene(activeScene()) },
      { label: 'Remove Scene', onClick: () => A.removeScene(activeScene()) },
    ],
    Source: () => [
      ...KINDS.map((k) => ({ label: `Add ${k.label}`, icon: k.icon, onClick: () => A.addSource(k.kind) })),
      { separator: true },
      { label: 'Source Properties…', icon: 'gear', disabled: !selectedItem(), onClick: () => selectedItem() && A.editSource(selectedItem()) },
    ],
    Tools: () => [
      { label: stream.isActive() ? 'Stop Streaming' : 'Start Streaming', icon: 'stream', hint: state.settings.hotkeys.stream, onClick: cmd.toggleStreaming },
      { label: 'Take Screenshot', icon: 'shot', hint: state.settings.hotkeys.screenshot, onClick: cmd.takeScreenshot },
      { label: 'Add Audio Channel…', icon: 'mic', onClick: A.addAudioChannel },
      { label: 'Retry Failed Sources', icon: 'refresh', onClick: () => import('./resources.js').then((m) => m.retryFailed()) },
    ],
    Help: () => [
      { label: 'Keyboard Shortcuts', onClick: openShortcuts },
      { label: 'About Velocity Studio', onClick: openAbout },
    ],
  };
  const bar = $('#menubar');
  let openName = null;
  const show = (btn, name) => {
    const r = btn.getBoundingClientRect();
    contextMenu(r.left, r.bottom, menus[name]());
    bar.querySelectorAll('button').forEach((b) => b.classList.toggle('open', b === btn));
    openName = name;
  };
  for (const name of Object.keys(menus)) {
    const b = h('button', { class: 'menu-btn', onclick: () => show(b, name), onpointerenter: () => { if (openName && openName !== name && document.querySelector('.ctx-menu')) show(b, name); } }, name);
    bar.append(b);
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.ctx-menu') && !e.target.closest('#menubar')) { openName = null; bar.querySelectorAll('button').forEach((b) => b.classList.remove('open')); }
  }, true);
}

/* ===================== Init ===================== */
export function init() {
  // static button wiring
  $('#btn-add-scene').onclick = () => A.addScene();
  $('#btn-del-scene').onclick = () => A.removeScene(activeScene());
  $('#btn-up-scene').onclick = () => A.moveScene(activeScene(), -1);
  $('#btn-down-scene').onclick = () => A.moveScene(activeScene(), 1);
  $('#btn-add-source').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); addSourceMenu(r.left, r.top - 4); };
  $('#btn-del-source').onclick = () => { const it = selectedItem(); if (it) A.removeItem(it); };
  $('#btn-props-source').onclick = () => { const it = selectedItem(); if (it) A.editSource(it); };
  $('#btn-up-source').onclick = () => { const it = selectedItem(); if (it) A.moveItem(it, 'up'); };
  $('#btn-down-source').onclick = () => { const it = selectedItem(); if (it) A.moveItem(it, 'down'); };
  $('#btn-add-audio').onclick = () => A.addAudioChannel();
  $('#btn-stream').onclick = () => cmd.toggleStreaming();
  $('#btn-record').onclick = () => cmd.toggleRecording();
  $('#btn-pause').onclick = () => cmd.togglePause();
  $('#btn-shot').onclick = () => cmd.takeScreenshot();
  $('#btn-folder').onclick = () => cmd.openRecordings();
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-exit').onclick = () => cmd.quitApp();
  document.querySelectorAll('[data-icon]').forEach((el) => { el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, Number(el.dataset.size) || 16)); });

  on('scenes', renderScenes);
  on('items', () => { renderSources(); renderScenes(); });
  on('selection', highlightSelection);
  on('audio', renderMixer);
  on('recording', (e) => updateControls(e.detail));
  on('streaming', updateStreamControls);
  window.api.onRecProgress((d) => updateControls({ pct: d.pct }));
  on('itemmenu', (e) => itemMenu(e.detail.item, e.detail.x, e.detail.y));

  renderScenes(); renderSources(); renderMixer(); updateControls(); updateStreamControls();
  setupMenus();
  requestAnimationFrame(drawMeters);
  pollStats();
  setInterval(pollStats, 1500);
  setInterval(renderStatus, 250);
  renderStatus();
  // refresh source rows when a stream fails or recovers
  const sig = () => (activeScene() ? activeScene().items.map((i) => `${i.id}:${(getRes(i) || {}).status || ''}`).join('|') : '');
  let lastSig = sig();
  setInterval(() => {
    const s = sig();
    if (s !== lastSig) { lastSig = s; renderSources(); }
  }, 1000);
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
}
