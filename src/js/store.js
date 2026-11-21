import { uid, debounce, deepClone } from './util.js';

export const BASE_W = 1920;
export const BASE_H = 1080;
const KEY = 'recscreen.state.v1';

export const DEFAULT_SETTINGS = {
  recPath: '',
  filename: '%CCYY-%MM-%DD %hh-%mm-%ss',
  container: 'mp4',
  encoder: 'auto',
  videoBitrate: 16000,
  audioBitrate: 192,
  fps: 60,
  outputHeight: 1080,
  minimizeOnRecord: false,
  hideFromCapture: true,
  hotkeys: { record: 'F9', pause: 'F10', screenshot: 'F11' },
  nvenc: { preset: 'p5', rc: 'vbr', cq: 21 },
};

export const state = {
  settings: deepClone(DEFAULT_SETTINGS),
  scenes: [],
  activeSceneId: null,
  selectedItemId: null,
  audio: [],
  firstRun: true,
};

const bus = new EventTarget();
export const on = (name, fn) => bus.addEventListener(name, fn);
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export const activeScene = () => state.scenes.find((s) => s.id === state.activeSceneId) || state.scenes[0] || null;
export const selectedItem = () => {
  const sc = activeScene();
  return sc ? sc.items.find((i) => i.id === state.selectedItemId) || null : null;
};

const persist = debounce(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      settings: state.settings,
      scenes: state.scenes,
      activeSceneId: state.activeSceneId,
      audio: state.audio,
    }));
  } catch { /* storage unavailable */ }
}, 250);

export const save = () => persist();

export function newScene(name) {
  return { id: uid(), name, items: [] };
}

export function newAudioChannel(kind, name, deviceId = 'default') {
  return { id: uid(), kind, name, deviceId, volumeDb: 0, muted: false, noiseSuppression: false };
}

export function newItem(kind, name, props, w, h) {
  return {
    id: uid(),
    kind,
    name,
    visible: true,
    locked: false,
    x: Math.round((1920 - w) / 2),
    y: Math.round((1080 - h) / 2),
    w, h,
    crop: { l: 0, t: 0, r: 0, b: 0 },
    opacity: 1,
    flipX: false,
    flipY: false,
    props,
  };
}

export function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
  if (saved && Array.isArray(saved.scenes) && saved.scenes.length) {
    state.firstRun = false;
    state.settings = { ...deepClone(DEFAULT_SETTINGS), ...saved.settings, hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...(saved.settings || {}).hotkeys }, nvenc: { ...DEFAULT_SETTINGS.nvenc, ...(saved.settings || {}).nvenc } };
    state.scenes = saved.scenes;
    state.activeSceneId = saved.activeSceneId && saved.scenes.some((s) => s.id === saved.activeSceneId) ? saved.activeSceneId : saved.scenes[0].id;
    state.audio = Array.isArray(saved.audio) && saved.audio.length ? saved.audio : defaultAudio();
  } else {
    state.scenes = [newScene('Scene')];
    state.activeSceneId = state.scenes[0].id;
    state.audio = defaultAudio();
  }
}

function defaultAudio() {
  return [newAudioChannel('desktop', 'Desktop Audio'), newAudioChannel('input', 'Mic/Aux')];
}
