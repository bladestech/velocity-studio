export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const deepClone = (o) => JSON.parse(JSON.stringify(o));

export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}

export const dbToGain = (db) => (db <= -60 ? 0 : 10 ** (db / 20));
export const gainToDb = (g) => (g <= 0.000001 ? -Infinity : 20 * Math.log10(g));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function formatName(pattern, date = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return pattern
    .replace(/%CCYY/g, date.getFullYear())
    .replace(/%YY/g, String(date.getFullYear()).slice(-2))
    .replace(/%MM/g, p2(date.getMonth() + 1))
    .replace(/%DD/g, p2(date.getDate()))
    .replace(/%hh/g, p2(date.getHours()))
    .replace(/%mm/g, p2(date.getMinutes()))
    .replace(/%ss/g, p2(date.getSeconds()));
}

/** Turn a KeyboardEvent into an Electron accelerator string (or null if only modifiers). */
export function eventToAccelerator(e) {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  let key = k;
  const map = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', '+': 'Plus' };
  if (map[k]) key = map[k];
  else if (k.length === 1) key = k.toUpperCase();
  else if (/^F\d{1,2}$/.test(k)) key = k;
  else if (['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Backspace', 'Enter'].includes(k)) key = k;
  else return null;
  parts.push(key);
  return parts.join('+');
}

export const prettyAccel = (a) => (a ? a.replace('CommandOrControl', 'Ctrl').replace('Super', 'Win') : '');
