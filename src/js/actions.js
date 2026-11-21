// State-changing operations on scenes, sources and audio channels.
import { state, emit, save, activeScene, selectedItem, newItem, newScene, newAudioChannel, BASE_W, BASE_H } from './store.js';
import { uid, deepClone, clamp } from './util.js';
import { acquire, invalidate, sync, getRes } from './resources.js';
import * as audio from './audio.js';
import { sourceDialog, uniqueName, kindInfo } from './source-dialog.js';
import { toast, promptBox, confirmBox, modal, field, select } from './widgets.js';
import { h } from './util.js';

const changed = (...names) => { names.forEach((n) => emit(n)); save(); };

/* ---------------- Scenes ---------------- */
export function activateScene(id) {
  if (state.activeSceneId === id) return;
  state.activeSceneId = id;
  state.selectedItemId = null;
  sync();
  changed('scenes', 'items', 'selection');
}

export async function addScene() {
  const name = await promptBox('Add Scene', 'Scene name', `Scene ${state.scenes.length + 1}`, 'Add');
  if (!name) return;
  const sc = newScene(name);
  state.scenes.push(sc);
  activateScene(sc.id);
  changed('scenes');
}

export async function renameScene(sc) {
  const name = await promptBox('Rename Scene', 'Scene name', sc.name, 'Rename');
  if (!name) return;
  sc.name = name;
  changed('scenes');
}

export function duplicateScene(sc) {
  const copy = deepClone(sc);
  copy.id = uid();
  copy.name = `${sc.name} (copy)`;
  copy.items.forEach((i) => { i.id = uid(); });
  state.scenes.splice(state.scenes.indexOf(sc) + 1, 0, copy);
  activateScene(copy.id);
  changed('scenes');
}

export async function removeScene(sc) {
  if (state.scenes.length <= 1) { toast('At least one scene is required.', { kind: 'warn' }); return; }
  if (!(await confirmBox('Remove Scene', `Remove “${sc.name}” and its ${sc.items.length} source(s)?`, 'Remove', true))) return;
  const idx = state.scenes.indexOf(sc);
  state.scenes.splice(idx, 1);
  if (state.activeSceneId === sc.id) {
    state.activeSceneId = state.scenes[Math.max(0, idx - 1)].id;
    state.selectedItemId = null;
    sync();
  }
  changed('scenes', 'items', 'selection');
}

export function moveScene(sc, dir) {
  const i = state.scenes.indexOf(sc);
  const j = i + dir;
  if (j < 0 || j >= state.scenes.length) return;
  state.scenes.splice(i, 1);
  state.scenes.splice(j, 0, sc);
  changed('scenes');
}

/* ---------------- Sources ---------------- */
export function selectItem(id) {
  if (state.selectedItemId === id) return;
  state.selectedItemId = id;
  emit('selection');
}

function placeItem(item, res) {
  const cw = res.width * (1 - item.crop.l - item.crop.r);
  const ch = res.height * (1 - item.crop.t - item.crop.b);
  if (!cw || !ch) return;
  if (item.kind === 'text') {
    const cx = item.x + item.w / 2; const cy = item.y + item.h / 2;
    item.w = res.width; item.h = res.height;
    item.x = Math.round(clamp(cx - item.w / 2, -item.w + 20, BASE_W - 20));
    item.y = Math.round(clamp(cy - item.h / 2, -item.h + 20, BASE_H - 20));
    return;
  }
  if (item.kind === 'camera') {
    const w = 480; const h = Math.round(w * ch / cw);
    Object.assign(item, { w, h, x: BASE_W - w - 32, y: BASE_H - h - 32 });
    return;
  }
  let s = Math.min(BASE_W / cw, BASE_H / ch);
  if (item.kind !== 'display') s = Math.min(s, 1);
  const w = Math.round(cw * s); const h = Math.round(ch * s);
  Object.assign(item, { w, h, x: Math.round((BASE_W - w) / 2), y: Math.round((BASE_H - h) / 2) });
}

/** Acquire a freshly created item's stream, then size/position it sensibly. */
export async function fitWhenReady(item) {
  const res = await acquire(item);
  if (res && res.status === 'ok') placeItem(item, res);
  changed('items');
}

export async function addSource(kind) {
  const r = await sourceDialog(kind);
  if (!r) return;
  const sc = activeScene();
  const item = newItem(kind, r.name, r.props, BASE_W, BASE_H);
  if (kind === 'text') { item.w = 200; item.h = 100; item.x = 860; item.y = 490; }
  sc.items.push(item);
  state.selectedItemId = item.id;
  changed('items', 'selection');
  const res = await acquire(item);
  if (res && res.status === 'ok') placeItem(item, res);
  else if (res) toast(`${kindInfo(kind).label}: ${res.error}`, { kind: 'error' });
  changed('items');
}

export async function editSource(item) {
  const r = await sourceDialog(item.kind, item);
  if (!r) return;
  const oldW = item.w; const oldH = item.h;
  invalidate(item);
  item.name = r.name;
  item.props = r.props;
  changed('items');
  const res = await acquire(item);
  if (res && res.status === 'ok') {
    if (item.kind === 'text') placeItem(item, res);
    else {
      const ar = (res.width * (1 - item.crop.l - item.crop.r)) / (res.height * (1 - item.crop.t - item.crop.b));
      if (Math.abs(ar - oldW / oldH) > 0.02) placeItem(item, res);
    }
  } else if (res) toast(`${kindInfo(item.kind).label}: ${res.error}`, { kind: 'error' });
  sync();
  changed('items');
}

export async function renameItem(item) {
  const name = await promptBox('Rename Source', 'Source name', item.name, 'Rename');
  if (!name) return;
  item.name = name;
  changed('items');
}

export function removeItem(item) {
  const sc = activeScene();
  const idx = sc.items.indexOf(item);
  if (idx < 0) return;
  sc.items.splice(idx, 1);
  if (state.selectedItemId === item.id) state.selectedItemId = null;
  sync();
  changed('items', 'selection');
  toast(`Removed “${item.name}”`, {
    actions: [{
      label: 'Undo',
      onClick: () => {
        const s = state.scenes.find((x) => x.id === sc.id);
        if (!s) return;
        s.items.splice(Math.min(idx, s.items.length), 0, item);
        sync();
        changed('items');
      },
    }],
  });
}

export function duplicateItem(item) {
  const sc = activeScene();
  const copy = deepClone(item);
  copy.id = uid();
  copy.name = uniqueName(item.name);
  copy.x += 24; copy.y += 24;
  sc.items.splice(sc.items.indexOf(item) + 1, 0, copy);
  state.selectedItemId = copy.id;
  sync();
  changed('items', 'selection');
}

export function moveItem(item, where) {
  const items = activeScene().items;
  const i = items.indexOf(item);
  let j = i;
  if (where === 'up') j = Math.min(items.length - 1, i + 1);
  else if (where === 'down') j = Math.max(0, i - 1);
  else if (where === 'top') j = items.length - 1;
  else if (where === 'bottom') j = 0;
  if (j === i) return;
  items.splice(i, 1);
  items.splice(j, 0, item);
  changed('items');
}

export function toggleVisible(item) {
  item.visible = !item.visible;
  sync();
  changed('items');
}

export function toggleLock(item) {
  item.locked = !item.locked;
  changed('items');
}

export function transform(item, op) {
  const res = getRes(item);
  const nat = res && res.width ? { w: res.width * (1 - item.crop.l - item.crop.r), h: res.height * (1 - item.crop.t - item.crop.b) } : { w: item.w, h: item.h };
  switch (op) {
    case 'fit': {
      const s = Math.min(BASE_W / nat.w, BASE_H / nat.h);
      item.w = Math.round(nat.w * s); item.h = Math.round(nat.h * s);
      item.x = Math.round((BASE_W - item.w) / 2); item.y = Math.round((BASE_H - item.h) / 2);
      break;
    }
    case 'stretch': Object.assign(item, { x: 0, y: 0, w: BASE_W, h: BASE_H }); break;
    case 'reset': item.w = Math.round(nat.w); item.h = Math.round(nat.h); item.crop = { l: 0, t: 0, r: 0, b: 0 }; if (res && res.width) { item.w = res.width; item.h = res.height; } break;
    case 'centerH': item.x = Math.round((BASE_W - item.w) / 2); break;
    case 'centerV': item.y = Math.round((BASE_H - item.h) / 2); break;
    case 'center': item.x = Math.round((BASE_W - item.w) / 2); item.y = Math.round((BASE_H - item.h) / 2); break;
    case 'flipX': item.flipX = !item.flipX; break;
    case 'flipY': item.flipY = !item.flipY; break;
    case 'resetCrop': {
      const full = res && res.width ? { w: res.width, h: res.height } : null;
      if (full) { const k = item.w / (full.w * (1 - item.crop.l - item.crop.r)); item.w = Math.round(full.w * k); item.h = Math.round(full.h * k); }
      item.crop = { l: 0, t: 0, r: 0, b: 0 };
      break;
    }
    default: break;
  }
  changed('items');
}

export function setOpacity(item, v) { item.opacity = clamp(v, 0, 1); changed('items'); }

export function nudge(dx, dy) {
  const it = selectedItem();
  if (!it || it.locked) return;
  it.x += dx; it.y += dy;
  changed('items');
}

/* ---------------- Audio ---------------- */
export async function addAudioChannel() {
  const inputs = await audio.listInputs();
  const sel = select([{ value: '__desktop', label: 'System audio — everything you hear (loopback)' }, ...inputs.map((d) => ({ value: d.id, label: d.label }))], '__desktop');
  const name = h('input', { type: 'text', class: 'text-input', value: 'Desktop Audio 2' });
  sel.addEventListener('change', () => {
    name.value = sel.value === '__desktop' ? 'Desktop Audio 2' : (sel.options[sel.selectedIndex].text.replace(/\s*\(.*\)\s*$/, '').slice(0, 32) || 'Mic/Aux 2');
  });
  const r = await modal({
    title: 'Add Audio Channel',
    width: 440,
    body: h('div', { class: 'source-dialog' }, field('Name', name), field('Source', sel)),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add', primary: true, value: 'ok' }],
  });
  if (r !== 'ok') return;
  const ch = sel.value === '__desktop' ? newAudioChannel('desktop', name.value || 'Desktop Audio') : newAudioChannel('input', name.value || 'Mic/Aux', sel.value);
  state.audio.push(ch);
  audio.syncChannels();
  changed('audio');
}

export async function editAudioChannel(ch) {
  const opts = await audio.sourceOptions();
  const cur = audio.sourceValue(ch);
  if (!opts.some((o) => o.value === cur)) opts.push({ value: cur, label: `${cur} (unavailable)` });
  const name = h('input', { type: 'text', class: 'text-input', value: ch.name });
  const sel = select(opts, cur);
  const ns = h('input', { type: 'checkbox' });
  ns.checked = !!ch.noiseSuppression;
  const nsRow = h('label', { class: 'check' }, ns, h('span', {}, 'Noise suppression (microphones)'));
  const sync = () => { nsRow.style.display = sel.value === audio.SYSTEM_AUDIO ? 'none' : ''; };
  sel.addEventListener('change', sync);
  sync();
  const body = h('div', { class: 'source-dialog' },
    field('Name', name),
    field('Source', sel),
    nsRow,
    h('p', { class: 'field-hint' }, '“System audio” captures everything you hear through the Windows default output device. For a different output or a single app, route it through a virtual audio cable and pick the cable here.'));
  const r = await modal({
    title: `Properties for '${ch.name}'`,
    width: 440,
    body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', primary: true, value: 'ok' }],
  });
  if (r !== 'ok') return;
  ch.name = name.value.trim() || ch.name;
  audio.setSource(ch, sel.value);
  ch.noiseSuppression = ns.checked;
  audio.startChannel(ch);
  changed('audio');
}

export function removeAudioChannel(ch) {
  state.audio.splice(state.audio.indexOf(ch), 1);
  audio.syncChannels();
  changed('audio');
}

export function setVolume(ch, db) { ch.volumeDb = db; audio.applyGain(ch); save(); }
export function toggleMute(ch) { ch.muted = !ch.muted; audio.applyGain(ch); changed('audio'); }
