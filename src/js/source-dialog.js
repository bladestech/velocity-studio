// Add / edit source dialog for every source kind.
import { state } from './store.js';
import { h } from './util.js';
import { icon } from './icons.js';
import { modal, field, select, checkbox, numberInput, toast } from './widgets.js';
import { listCameras, renderText } from './resources.js';

export const KINDS = [
  { kind: 'display', label: 'Display Capture', icon: 'display', base: 'Display Capture' },
  { kind: 'window', label: 'Window Capture', icon: 'window', base: 'Window Capture' },
  { kind: 'camera', label: 'Video Capture Device', icon: 'camera', base: 'Webcam' },
  { kind: 'image', label: 'Image', icon: 'image', base: 'Image' },
  { kind: 'text', label: 'Text', icon: 'text', base: 'Text' },
  { kind: 'color', label: 'Color Source', icon: 'color', base: 'Color Source' },
];
export const kindInfo = (k) => KINDS.find((x) => x.kind === k) || KINDS[0];

export function uniqueName(base) {
  const names = new Set(state.scenes.flatMap((s) => s.items.map((i) => i.name)));
  if (!names.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  return base;
}

const FONTS = ['Segoe UI', 'Arial', 'Calibri', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Comic Sans MS'];

export async function sourceDialog(kind, item = null) {
  const info = kindInfo(kind);
  const draft = {
    name: item ? item.name : uniqueName(info.base),
    props: item ? JSON.parse(JSON.stringify(item.props)) : defaultProps(kind),
  };
  const nameInput = h('input', { type: 'text', class: 'text-input', value: draft.name });
  const body = h('div', { class: 'source-dialog' });
  body.append(field('Name', nameInput));
  let validate = () => true;

  if (kind === 'display' || kind === 'window') {
    const isDisplay = kind === 'display';
    const grid = h('div', { class: 'source-grid' }, h('div', { class: 'grid-empty' }, 'Looking for sources…'));
    const load = async () => {
      grid.replaceChildren(h('div', { class: 'grid-empty' }, 'Looking for sources…'));
      const list = await window.api.listSources({ types: [kind === 'display' ? 'screen' : 'window'], thumb: 360 });
      grid.replaceChildren();
      if (!list.length) grid.append(h('div', { class: 'grid-empty' }, isDisplay ? 'No displays found.' : 'No windows found. Open the window you want to capture first.'));
      for (const s of list) {
        const sel = isDisplay ? draft.props.sourceId === s.id : (draft.props.title === s.name || draft.props.sourceId === s.id);
        const card = h('button', { class: `src-card ${sel ? 'selected' : ''}`, type: 'button' },
          h('div', { class: 'src-thumb' }, s.thumb ? h('img', { src: s.thumb, alt: '' }) : h('div', { class: 'no-thumb', html: icon(kind, 28) })),
          h('div', { class: 'src-meta' },
            s.icon ? h('img', { class: 'src-icon', src: s.icon, alt: '' }) : null,
            h('div', { class: 'src-text' }, h('div', { class: 'src-name', title: s.name }, s.name), s.meta ? h('div', { class: 'src-sub' }, s.meta) : null)));
        card.addEventListener('click', () => {
          grid.querySelectorAll('.src-card').forEach((c) => c.classList.remove('selected'));
          card.classList.add('selected');
          draft.props.sourceId = s.id;
          if (isDisplay) draft.props.label = `${s.name} (${s.meta.split(' @')[0]})`;
          else draft.props.title = s.name;
          if (!item || nameInput.dataset.touched !== '1') {
            if (!item) nameInput.value = uniqueName(isDisplay ? s.name === 'Display 1' ? 'Display Capture' : `Capture ${s.name}` : `Window: ${s.name.slice(0, 40)}`);
          }
        });
        grid.append(card);
      }
    };
    nameInput.addEventListener('input', () => { nameInput.dataset.touched = '1'; });
    body.append(
      h('div', { class: 'grid-head' }, h('span', { class: 'field-label' }, isDisplay ? 'Display' : 'Window'),
        h('button', { class: 'btn small', type: 'button', html: `${icon('refresh', 14)} Refresh`, onclick: load })),
      grid,
    );
    load();
    validate = () => {
      if (!draft.props.sourceId) { toast(`Pick a ${isDisplay ? 'display' : 'window'} first.`, { kind: 'warn' }); return false; }
      return true;
    };
  }

  if (kind === 'camera') {
    const camSel = select([{ value: '', label: 'Searching for cameras…' }], '');
    const resSel = select([
      { value: 'auto', label: 'Auto (1080p preferred)' }, { value: '480p', label: '640 × 480' },
      { value: '720p', label: '1280 × 720' }, { value: '1080p', label: '1920 × 1080' }, { value: '4k', label: '3840 × 2160' },
    ], draft.props.res || 'auto', (v) => { draft.props.res = v; });
    listCameras().then((cams) => {
      camSel.replaceChildren();
      if (!cams.length) { camSel.append(h('option', { value: '' }, 'No camera found')); return; }
      for (const c of cams) {
        const o = h('option', { value: c.id }, c.label);
        if (c.id === draft.props.deviceId) o.selected = true;
        camSel.append(o);
      }
      if (!draft.props.deviceId || !cams.some((c) => c.id === draft.props.deviceId)) draft.props.deviceId = cams[0].id;
      camSel.value = draft.props.deviceId;
    });
    camSel.addEventListener('change', () => { draft.props.deviceId = camSel.value; });
    body.append(field('Device', camSel), field('Resolution', resSel));
    validate = () => { if (!draft.props.deviceId) { toast('No camera selected.', { kind: 'warn' }); return false; } return true; };
  }

  if (kind === 'image') {
    const path = h('input', { type: 'text', class: 'text-input', readonly: true, value: draft.props.path || '', placeholder: 'Choose an image file…' });
    const browse = async () => {
      const p = await window.api.pickImage();
      if (p) { draft.props.path = p; path.value = p; if (!item) nameInput.value = uniqueName(p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')); }
    };
    path.addEventListener('click', browse);
    body.append(field('Image file', h('div', { class: 'row' }, path, h('button', { class: 'btn', type: 'button', onclick: browse }, 'Browse…'))));
    validate = () => { if (!draft.props.path) { toast('Choose an image file first.', { kind: 'warn' }); return false; } return true; };
  }

  if (kind === 'text') {
    const p = draft.props;
    const preview = h('div', { class: 'text-preview' });
    const redraw = () => {
      const c = renderText(p);
      c.style.maxWidth = '100%';
      c.style.maxHeight = '120px';
      preview.replaceChildren(c);
    };
    const ta = h('textarea', { class: 'text-input', rows: 3 }, p.text);
    ta.addEventListener('input', () => { p.text = ta.value; redraw(); });
    const bind = (el, key, conv = (v) => v, ev = 'input') => { el.addEventListener(ev, () => { p[key] = conv(el.value); redraw(); }); return el; };
    const colorIn = (key) => bind(h('input', { type: 'color', class: 'color-input', value: p[key] }), key);
    const bold = checkbox('Bold', p.bold, (v) => { p.bold = v; redraw(); });
    const italic = checkbox('Italic', p.italic, (v) => { p.italic = v; redraw(); });
    const bg = checkbox('Background', p.bg, (v) => { p.bg = v; redraw(); });
    const outline = checkbox('Outline', p.outline, (v) => { p.outline = v; redraw(); });
    body.append(
      field('Text', ta),
      h('div', { class: 'grid2' },
        field('Font', bind(select(FONTS.map((f) => ({ value: f, label: f })), p.fontFamily), 'fontFamily', (v) => v, 'change')),
        field('Size', bind(numberInput(p.fontSize, { min: 8, max: 600 }), 'fontSize', (v) => Math.max(8, v || 8)))),
      h('div', { class: 'grid2' },
        field('Text color', colorIn('color')),
        field('Align', bind(select([{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }], p.align), 'align', (v) => v, 'change'))),
      h('div', { class: 'row wrap' }, bold, italic),
      h('div', { class: 'row' }, bg, colorIn('bgColor'), outline, colorIn('outlineColor')),
      field('Preview', preview),
    );
    redraw();
  }

  if (kind === 'color') {
    const c = h('input', { type: 'color', class: 'color-input big', value: draft.props.color });
    c.addEventListener('input', () => { draft.props.color = c.value; });
    body.append(field('Color', c));
  }

  const r = await modal({
    title: item ? `Properties for '${item.name}'` : `Add ${info.label}`,
    width: kind === 'display' || kind === 'window' ? 720 : 520,
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: item ? 'Apply' : 'Add', primary: true, value: 'ok', onClick: () => validate() },
    ],
  });
  if (r !== 'ok') return null;
  draft.name = nameInput.value.trim() || info.base;
  return draft;
}

function defaultProps(kind) {
  switch (kind) {
    case 'display': return { sourceId: '', label: '' };
    case 'window': return { sourceId: '', title: '' };
    case 'camera': return { deviceId: '', res: 'auto' };
    case 'image': return { path: '' };
    case 'text': return { text: 'Hello, world!', fontFamily: 'Segoe UI', fontSize: 72, color: '#ffffff', bold: true, italic: false, align: 'left', bg: false, bgColor: '#000000', outline: false, outlineColor: '#000000' };
    case 'color': return { color: '#3a6df0' };
    default: return {};
  }
}
