// Small UI toolkit: modal dialogs, toasts, context menus, form helpers.
import { h, $ } from './util.js';
import { icon } from './icons.js';

/* ---------------- Modal ---------------- */
export function modal({ title, body, buttons, width = 560, onClose }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const overlay = h('div', { class: 'modal-overlay' });
    const box = h('div', { class: 'modal', style: { width: `${width}px` }, role: 'dialog', 'aria-label': title });
    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (onClose) onClose();
      resolve(val);
    };
    const head = h('div', { class: 'modal-head' }, h('span', {}, title),
      h('button', { class: 'icon-btn', title: 'Close', html: icon('close'), onclick: () => close(null) }));
    const foot = h('div', { class: 'modal-foot' });
    for (const b of buttons || []) {
      const btn = h('button', {
        class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
        onclick: async () => {
          if (b.onClick) { const keep = await b.onClick(box); if (keep === false) return; }
          close(b.value ?? b.label);
        },
      }, b.label);
      foot.append(btn);
    }
    box.append(head, h('div', { class: 'modal-body' }, body), foot);
    overlay.append(box);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(null); });
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT') {
        const p = foot.querySelector('.btn.primary');
        if (p) { e.preventDefault(); p.click(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    root.append(overlay);
    const first = box.querySelector('input:not([type=checkbox]):not([type=color]), textarea, select');
    if (first) { first.focus(); if (first.select && first.tagName === 'INPUT') first.select(); }
  });
}

export async function confirmBox(title, message, okLabel = 'OK', danger = false) {
  const r = await modal({
    title,
    width: 420,
    body: h('p', { class: 'confirm-text' }, message),
    buttons: [{ label: 'Cancel', value: false }, { label: okLabel, primary: true, danger, value: true }],
  });
  return r === true;
}

export async function promptBox(title, label, value = '', okLabel = 'OK') {
  const input = h('input', { type: 'text', value, class: 'text-input' });
  const r = await modal({
    title,
    width: 400,
    body: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input),
    buttons: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, value: 'ok' }],
  });
  return r === 'ok' ? input.value.trim() : null;
}

/* ---------------- Toast ---------------- */
export function toast(message, { kind = 'info', actions = [], timeout = 5000 } = {}) {
  const root = $('#toast-root');
  const el = h('div', { class: `toast ${kind}` }, h('span', { class: 'toast-msg' }, message));
  for (const a of actions) {
    el.append(h('button', { class: 'toast-act', onclick: () => { a.onClick(); remove(); } }, a.label));
  }
  el.append(h('button', { class: 'toast-x', html: icon('close', 14), onclick: () => remove() }));
  let timer = null;
  const remove = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  root.append(el);
  if (timeout) timer = setTimeout(remove, timeout);
  return remove;
}

/* ---------------- Context menu ---------------- */
let ctxEl = null;
export function closeMenu() {
  if (ctxEl) { ctxEl.remove(); ctxEl = null; }
}

export function contextMenu(x, y, items, { anchorRight = false } = {}) {
  closeMenu();
  const el = h('div', { class: 'ctx-menu', role: 'menu' });
  for (const it of items) {
    if (it.separator) { el.append(h('div', { class: 'ctx-sep' })); continue; }
    if (it.header) { el.append(h('div', { class: 'ctx-header' }, it.header)); continue; }
    const row = h('div', {
      class: `ctx-item ${it.disabled ? 'disabled' : ''}`,
      role: 'menuitem',
      onclick: (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        closeMenu();
        if (it.onClick) it.onClick();
      },
    },
    h('span', { class: 'ctx-check', html: it.checked ? icon('check', 14) : (it.icon ? icon(it.icon, 14) : '') }),
    h('span', { class: 'ctx-label' }, it.label),
    h('span', { class: 'ctx-hint' }, it.hint || ''));
    el.append(row);
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  let px = anchorRight ? x - r.width : x;
  let py = y;
  if (px + r.width > innerWidth - 6) px = innerWidth - r.width - 6;
  if (py + r.height > innerHeight - 6) py = Math.max(6, y - r.height);
  el.style.left = `${Math.max(6, px)}px`;
  el.style.top = `${py}px`;
  ctxEl = el;
  setTimeout(() => {
    const off = (e) => { if (!el.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
  });
}

/* ---------------- Form helpers ---------------- */
export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function select(options, value, onChange) {
  const el = h('select', { class: 'select' });
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (String(o.value) === String(value)) opt.selected = true;
    el.append(opt);
  }
  if (onChange) el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function checkbox(label, checked, onChange) {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = !!checked;
  if (onChange) cb.addEventListener('change', () => onChange(cb.checked));
  const wrap = h('label', { class: 'check' }, cb, h('span', {}, label));
  wrap.input = cb;
  return wrap;
}

export function numberInput(value, { min, max, step = 1, onChange } = {}) {
  const el = h('input', { type: 'number', class: 'text-input', value, min, max, step });
  if (onChange) el.addEventListener('input', () => onChange(Number(el.value)));
  return el;
}
