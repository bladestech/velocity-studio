// Settings dialog, shortcuts reference and about box.
import { state, emit, save, DEFAULT_SETTINGS } from './store.js';
import { h, deepClone, formatName, eventToAccelerator, prettyAccel } from './util.js';
import { modal, field, select, checkbox, numberInput, toast } from './widgets.js';
import * as recorder from './recorder.js';
import { hasNvenc } from './recorder.js';
import * as compositor from './compositor.js';
import { resetAll, sync } from './resources.js';
import { icon } from './icons.js';
import * as audio from './audio.js';
import * as stream from './stream.js';
import { hasNvencH264 } from './recorder.js';

let appInfo = null;
export const setAppInfo = (i) => { appInfo = i; };

export async function applyHotkeys() {
  const failed = await window.api.setHotkeys(state.settings.hotkeys);
  if (failed && failed.length) {
    toast(`Could not register hotkey for: ${failed.join(', ')} (already used by another app?)`, { kind: 'warn', timeout: 8000 });
  }
}

export function openSettings() {
  const d = deepClone(state.settings);
  const locked = recorder.rec.phase !== 'idle' || stream.isActive();
  const encs = recorder.supportedEncoders();

  /* ---- Output ---- */
  const pathIn = h('input', { type: 'text', class: 'text-input', value: d.recPath, readonly: true });
  const browse = async () => { const p = await window.api.pickFolder(d.recPath); if (p) { d.recPath = p; pathIn.value = p; } };
  pathIn.addEventListener('click', browse);
  const preview = h('span', { class: 'field-hint' });
  const fname = h('input', { type: 'text', class: 'text-input', value: d.filename });
  const updPrev = () => { preview.textContent = `Example: ${formatName(fname.value || '%CCYY-%MM-%DD %hh-%mm-%ss')}.${d.container}`; };
  fname.addEventListener('input', () => { d.filename = fname.value; updPrev(); });
  const contSel = select([{ value: 'mp4', label: 'MP4 (.mp4) — plays everywhere' }, { value: 'mkv', label: 'MKV (.mkv) — crash-safe' }, { value: 'webm', label: 'WebM (.webm)' }], d.container, (v) => { d.container = v; updPrev(); });
  const encSel = select([{ value: 'auto', label: hasNvenc() ? 'Automatic (NVENC when available)' : 'Automatic (recommended)' }, ...encs.map((e) => ({ value: e.key, label: e.label }))], d.encoder, (v) => { d.encoder = v; });
  const brIn = numberInput(d.videoBitrate, { min: 1000, max: 200000, step: 500, onChange: (v) => { d.videoBitrate = v || 1000; } });
  const nv = d.nvenc;
  const cqIn = numberInput(nv.cq, { min: 1, max: 51, onChange: (v) => { nv.cq = v || 21; } });
  const presetSel = select([1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: `p${n}`, label: `P${n}${{ 1: ' — fastest', 4: ' — balanced', 5: ' — high quality (default)', 7: ' — best quality, slowest' }[n] || ''}` })), nv.preset, (v) => { nv.preset = v; });
  const rcSel = select([
    { value: 'vbr', label: 'VBR — variable bitrate (recommended)' }, { value: 'cbr', label: 'CBR — constant bitrate' },
    { value: 'cq', label: 'Constant quality (ignores the bitrate)' },
  ], nv.rc, (v) => { nv.rc = v; cqIn.disabled = v !== 'cq'; brIn.disabled = v === 'cq'; });
  cqIn.disabled = nv.rc !== 'cq';
  brIn.disabled = nv.rc === 'cq';
  const nvencBox = hasNvenc() ? h('div', { class: 'nvenc-box' },
    h('div', { class: 'box-title' }, 'NVIDIA NVENC'),
    h('div', { class: 'grid2' }, field('Preset', presetSel), field('Rate control', rcSel)),
    field('Constant-quality level (1–51, lower = better quality, bigger files)', cqIn),
    h('p', { class: 'note' }, 'Used by the NVENC encoders. Video is encoded on your GPU’s dedicated encoder chip, so it barely affects game / desktop performance.')) : null;
  const preset = select([
    { value: '', label: 'Preset…' }, { value: 6000, label: 'Small — 6 Mbps' }, { value: 12000, label: 'Balanced — 12 Mbps' },
    { value: 16000, label: 'High — 16 Mbps' }, { value: 30000, label: 'Very high — 30 Mbps' }, { value: 60000, label: 'Near-lossless — 60 Mbps' },
  ], '', (v) => { if (v) { d.videoBitrate = Number(v); brIn.value = v; preset.value = ''; } });
  const out = h('div', { class: 'pane' },
    field('Recording folder', h('div', { class: 'row' }, pathIn, h('button', { class: 'btn', type: 'button', onclick: browse }, 'Browse…'), h('button', { class: 'btn', type: 'button', onclick: () => window.api.openDir(d.recPath) }, 'Open'))),
    field('Filename format', fname, undefined), preview,
    h('div', { class: 'grid2' }, field('Container', contSel), field('Video encoder', encSel)),
    h('div', { class: 'grid2' }, field('Video bitrate (kbps)', brIn), field('Quality preset', preset)),
    nvencBox,
    h('p', { class: 'note' }, 'Tokens: %CCYY year · %MM month · %DD day · %hh hour · %mm minute · %ss second. ',
      'Choosing MP4 with a VP9/VP8 encoder re-encodes to H.264 after recording (needs extra time); MKV and WebM are remuxed instantly. NVENC recordings are muxed in a moment when you stop.'),
  );
  updPrev();

  /* ---- Video ---- */
  const resSel = select([
    { value: 720, label: '1280 × 720 (720p)' }, { value: 900, label: '1600 × 900' }, { value: 1080, label: '1920 × 1080 (1080p)' },
    { value: 1440, label: '2560 × 1440 (1440p)' }, { value: 2160, label: '3840 × 2160 (4K)' },
  ], d.outputHeight, (v) => { d.outputHeight = Number(v); });
  const fpsSel = select([24, 30, 48, 60].map((f) => ({ value: f, label: `${f} fps` })), d.fps, (v) => { d.fps = Number(v); });
  if (locked) { resSel.disabled = true; fpsSel.disabled = true; }
  const video = h('div', { class: 'pane' },
    h('div', { class: 'grid2' }, field('Output resolution', resSel), field('Frame rate', fpsSel)),
    locked ? h('p', { class: 'note warn' }, 'Stop recording and streaming to change the resolution or frame rate.') : null,
    h('p', { class: 'note' }, 'Scenes are laid out on a 16:9 canvas and scaled to the output resolution. Higher resolution and frame rate use more CPU/GPU — if the status bar shows fewer fps than selected, lower one of them or the bitrate.'),
  );

  /* ---- Audio ---- */
  const abSel = select([96, 128, 160, 192, 256, 320].map((v) => ({ value: v, label: `${v} kbps` })), d.audioBitrate, (v) => { d.audioBitrate = Number(v); });
  // One source picker per mixer channel: System audio (loopback) or any capture device / virtual cable.
  const chDraft = {};
  const chRows = h('div', { class: 'ch-rows' });
  const chSelects = state.audio.map((ch) => {
    const sel = h('select', { class: 'select' }, h('option', { value: audio.sourceValue(ch) }, 'Loading devices…'));
    chRows.append(h('div', { class: 'ch-row' }, h('div', { class: 'ch-row-name' }, ch.name), sel));
    sel.addEventListener('change', () => { chDraft[ch.id] = sel.value; });
    return { ch, sel };
  });
  audio.sourceOptions().then((opts) => {
    for (const { ch, sel } of chSelects) {
      const cur = audio.sourceValue(ch);
      const list = opts.some((o) => o.value === cur) ? opts : [...opts, { value: cur, label: `${cur} (unavailable)` }];
      sel.replaceChildren(...list.map((o) => { const el = h('option', { value: o.value }, o.label); if (o.value === cur) el.selected = true; return el; }));
    }
  }).catch(() => {});
  const audioPane = h('div', { class: 'pane' },
    h('div', { class: 'field-label strong' }, 'Mixer sources'),
    chRows,
    h('p', { class: 'note' }, 'Pick a microphone or any other capture device per channel. “System audio” records everything you hear through the Windows default output device. To capture a different output or a single app, route it through a virtual audio cable (e.g. VB-Cable or Voicemeeter) and choose that cable here as a device. Add more channels with + in the Audio Mixer.'),
    field('Recording audio bitrate', abSel),
  );

  /* ---- Hotkeys ---- */
  const hkRows = [['record', 'Start / Stop Recording'], ['pause', 'Pause / Resume Recording'], ['stream', 'Start / Stop Streaming'], ['screenshot', 'Take Screenshot']].map(([key, label]) => {
    const btn = h('button', { class: 'hotkey-btn', type: 'button' }, prettyAccel(d.hotkeys[key]) || 'Not set');
    const clear = h('button', { class: 'btn small', type: 'button', onclick: () => { d.hotkeys[key] = ''; btn.textContent = 'Not set'; } }, 'Clear');
    btn.addEventListener('click', () => {
      btn.textContent = 'Press a key combination…';
      btn.classList.add('listening');
      const handler = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { finish(); return; }
        const acc = eventToAccelerator(e);
        if (!acc) return;
        d.hotkeys[key] = acc;
        finish();
      };
      const finish = () => {
        document.removeEventListener('keydown', handler, true);
        btn.classList.remove('listening');
        btn.textContent = prettyAccel(d.hotkeys[key]) || 'Not set';
      };
      document.addEventListener('keydown', handler, true);
    });
    return h('div', { class: 'hk-row' }, h('span', {}, label), btn, clear);
  });
  const hotkeys = h('div', { class: 'pane' }, ...hkRows,
    h('p', { class: 'note' }, 'Hotkeys work globally, even while RecScreen is minimized or another app has focus.'));

  /* ---- General ---- */
  const general = h('div', { class: 'pane' },
    checkbox('Hide RecScreen from screen captures', d.hideFromCapture, (v) => { d.hideFromCapture = v; }),
    h('p', { class: 'note' }, 'Excludes this window from display/window capture so it never shows up in your recordings (no infinite-mirror effect).'),
    checkbox('Minimize RecScreen when recording starts', d.minimizeOnRecord, (v) => { d.minimizeOnRecord = v; }),
    h('p', { class: 'note' }, 'Use the Start/Stop hotkey to control recording while minimized.'),
    h('div', { class: 'row' }, h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => { Object.assign(d, deepClone(DEFAULT_SETTINGS), { recPath: d.recPath }); toast('Settings reset — press Apply to keep.', { kind: 'warn' }); },
    }, 'Reset to defaults')),
  );

  /* ---- Stream ---- */
  const sc = d.stream;
  const streaming = stream.isActive();
  const keyDraft = {}; // service id -> key typed in this dialog
  let remember = true;
  let secretOk = true;
  const hint = h('p', { class: 'note' });
  const serverIn = h('input', { type: 'text', class: 'text-input', placeholder: 'rtmp://… or rtmps://…', spellcheck: false });
  const keyIn = h('input', { type: 'password', class: 'text-input', placeholder: 'Paste your stream key', autocomplete: 'off', spellcheck: false });
  const showBtn = h('button', { class: 'btn', type: 'button' }, 'Show');
  showBtn.addEventListener('click', () => { keyIn.type = keyIn.type === 'password' ? 'text' : 'password'; showBtn.textContent = keyIn.type === 'password' ? 'Show' : 'Hide'; });
  serverIn.addEventListener('input', () => { sc.servers[sc.service] = serverIn.value.trim(); });
  keyIn.addEventListener('input', () => { keyDraft[sc.service] = keyIn.value.trim(); });
  const refreshService = async () => {
    const svc = stream.serviceById(sc.service);
    serverIn.value = sc.servers[svc.id] != null ? sc.servers[svc.id] : svc.server;
    hint.textContent = svc.hint;
    if (keyDraft[svc.id] !== undefined) { keyIn.value = keyDraft[svc.id]; return; }
    keyIn.value = '';
    keyIn.placeholder = 'Loading…';
    const k = await stream.getKey(svc.id);
    if (sc.service === svc.id && keyDraft[svc.id] === undefined) { keyIn.value = k; keyIn.placeholder = 'Paste your stream key'; }
  };
  const svcSel = select(stream.SERVICES.map((s) => ({ value: s.id, label: s.name })), sc.service, (v) => { sc.service = v; refreshService(); });
  const secretNote = h('p', { class: 'note' }, 'Your stream key is stored encrypted with Windows (DPAPI) on this PC and never written to the settings file. Anyone with your key can stream to your channel — keep it private and reset it if it leaks.');
  const rememberCb = checkbox('Remember stream keys on this PC', true, (v) => { remember = v; });
  window.api.secretAvailable().then((ok) => {
    secretOk = ok;
    if (!ok) { rememberCb.input.checked = false; rememberCb.input.disabled = true; remember = false; secretNote.textContent = 'Encrypted storage is not available on this system, so your key is kept in memory only and must be re-entered after restarting RecScreen.'; }
  });
  const sBitrate = numberInput(sc.bitrate, { min: 500, max: 60000, step: 250, onChange: (v) => { sc.bitrate = v || 6000; } });
  const sAudio = select([96, 128, 160, 192, 256].map((v) => ({ value: v, label: `${v} kbps` })), sc.audioBitrate, (v) => { sc.audioBitrate = Number(v); });
  const sHeight = select([{ value: 0, label: 'Same as canvas' }, { value: 1080, label: '1920 × 1080' }, { value: 900, label: '1600 × 900' }, { value: 720, label: '1280 × 720' }, { value: 540, label: '960 × 540' }], sc.height, (v) => { sc.height = Number(v); });
  const sFps = select([{ value: 0, label: 'Same as canvas' }, { value: 60, label: '60 fps' }, { value: 48, label: '48 fps' }, { value: 30, label: '30 fps' }, { value: 24, label: '24 fps' }], sc.fps, (v) => { sc.fps = Number(v); });
  const sEnc = select([
    { value: 'auto', label: hasNvencH264() ? 'Automatic (NVIDIA NVENC)' : 'Automatic (x264, CPU)' },
    ...(hasNvencH264() ? [{ value: 'nvenc', label: 'NVIDIA NVENC H.264 (GPU)' }] : []),
    { value: 'x264', label: 'x264 (CPU, veryfast)' },
  ], sc.encoder, (v) => { sc.encoder = v; });
  if (streaming) [sBitrate, sAudio, sHeight, sFps, sEnc].forEach((el) => { el.disabled = true; });
  const streamPane = h('div', { class: 'pane' },
    field('Service', svcSel),
    hint,
    field('Server', serverIn),
    field('Stream key', h('div', { class: 'row' }, keyIn, showBtn)),
    rememberCb, secretNote,
    h('div', { class: 'grid2' }, field('Video bitrate (kbps, CBR)', sBitrate), field('Audio bitrate', sAudio)),
    h('div', { class: 'grid2' }, field('Stream resolution', sHeight), field('Stream frame rate', sFps)),
    h('div', { class: 'grid2' }, field('Encoder', sEnc), h('div', {}, h('div', { class: 'field-label' }, 'Connection'), checkbox('Reconnect automatically', sc.reconnect, (v) => { sc.reconnect = v; }))),
    streaming ? h('p', { class: 'note warn' }, 'Stop streaming to change bitrate, resolution or encoder.') : null,
    h('p', { class: 'note' }, 'Keyframes are sent every 2 seconds, as Twitch, YouTube and Kick require. Streaming and recording can run at the same time; with NVENC both share one GPU conversion.'),
  );
  refreshService();

  const tabs = [['Output', out], ['Video', video], ['Audio', audioPane], ['Stream', streamPane], ['Hotkeys', hotkeys], ['General', general]];
  const nav = h('div', { class: 'tabs-nav' });
  const content = h('div', { class: 'tabs-content' });
  const buttons = [];
  tabs.forEach(([name, pane], i) => {
    const b = h('button', { class: `tab-btn ${i === 0 ? 'active' : ''}`, type: 'button', onclick: () => {
      buttons.forEach((x) => x.classList.remove('active')); b.classList.add('active');
      tabs.forEach(([, p]) => { p.style.display = 'none'; }); pane.style.display = '';
    } }, name);
    buttons.push(b); nav.append(b);
    pane.style.display = i === 0 ? '' : 'none';
    content.append(pane);
  });

  modal({
    title: 'Settings',
    width: 760,
    body: h('div', { class: 'settings-layout' }, nav, content),
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Apply',
        primary: true,
        value: 'ok',
        onClick: async () => {
          applySettings(d);
          // audio source changes
          let audioChanged = false;
          for (const [id, value] of Object.entries(chDraft)) {
            const ch = state.audio.find((c) => c.id === id);
            if (ch && value !== audio.sourceValue(ch)) { audio.setSource(ch, value); audio.startChannel(ch); audioChanged = true; }
          }
          if (audioChanged) { emit('audio'); save(); }
          // stream keys
          for (const [id, key] of Object.entries(keyDraft)) {
            if (remember && secretOk) { await window.api.secretSet(stream.keyName(id), key); delete stream.memoryKeys[id]; }
            else { stream.memoryKeys[id] = key; if (secretOk) await window.api.secretSet(stream.keyName(id), ''); }
            if (!key) delete stream.memoryKeys[id];
          }
        },
      },
    ],
  });
}

function applySettings(d) {
  const old = state.settings;
  const videoChanged = old.outputHeight !== d.outputHeight || old.fps !== d.fps;
  state.settings = d;
  if (videoChanged) {
    compositor.applySize();
    compositor.setRate(d.fps);
    if (old.fps !== d.fps) { resetAll(); sync(); }
  }
  window.api.protect(d.hideFromCapture);
  applyHotkeys();
  save();
  emit('settings');
  emit('items');
}

export function openShortcuts() {
  const hk = state.settings.hotkeys;
  const rows = [
    ['Start / Stop recording', prettyAccel(hk.record)], ['Pause / Resume', prettyAccel(hk.pause)], ['Start / Stop streaming', prettyAccel(hk.stream)], ['Take screenshot', prettyAccel(hk.screenshot)],
    ['Move selected source', 'Arrow keys (Shift = 10 px)'], ['Remove selected source', 'Delete'],
    ['Free-aspect resize', 'Shift + drag a corner'], ['Crop source', 'Alt + drag a handle'], ['Disable snapping', 'Hold Ctrl while dragging'],
    ['Reset volume', 'Double-click a fader'], ['Source properties', 'Double-click a source'],
  ];
  modal({
    title: 'Keyboard Shortcuts',
    width: 480,
    body: h('div', { class: 'shortcuts' }, rows.map(([a, b]) => h('div', { class: 'sc-row' }, h('span', {}, a), h('kbd', {}, b || '—')))),
    buttons: [{ label: 'Close', primary: true, value: 'ok' }],
  });
}

export function openAbout() {
  modal({
    title: 'About RecScreen',
    width: 420,
    body: h('div', { class: 'about' },
      h('div', { class: 'about-logo', html: icon('record', 40) }),
      h('h2', {}, 'RecScreen'),
      h('p', {}, `Version ${appInfo ? appInfo.version : '1.0.0'}`),
      h('p', { class: 'note' }, 'An OBS-style screen recorder: scenes, multiple sources, audio mixer, hardware-accelerated H.264, global hotkeys.')),
    buttons: [{ label: 'Close', primary: true, value: 'ok' }],
  });
}
