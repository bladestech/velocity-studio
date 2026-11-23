// The "V is loading" animation: the logo's V, masked to its exact shape, fills with cyan liquid from its bottom
// tip up to the top as progress advances. Two offset waves roll across the surface, the empty part of the V
// shows as a faint ghost, and indeterminate work (verifying, unpacking) plays a shine sweep across a full V.
// Progress is eased every frame, so bursty download events still rise smoothly. Only transforms and opacity
// change per frame.
import { h } from './util.js';

// Where the V sits inside its 512x512 artwork (see logo-v.png): the fill runs from the bottom tip to the top.
const V_TOP = 13;    // % from the top
const V_BOTTOM = 87; // %

/**
 * Create a V loader element. Returns the element with:
 *   setProgress(p)  0..1 (determinate) - the liquid level eases towards it
 *   setBusy(on)     shine sweep on a full V (indeterminate phases)
 *   start() / stop() run / pause the per-frame easing and waves
 */
export function createVLoader({ className = '' } = {}) {
  const liquid = h('div', { class: 'vl-liquid' },
    h('div', { class: 'vl-wave back' }), h('div', { class: 'vl-wave front' }), h('div', { class: 'vl-body' }));
  const shine = h('div', { class: 'vl-shine' }, h('span'));
  const el = h('div', { class: `vloader ${className}`, 'aria-hidden': 'true' }, h('div', { class: 'vl-ghost' }), liquid, shine);

  let target = 0;
  let shown = 0;
  let raf = 0;
  let last = 0;
  const place = (p) => {
    // At 100% lift the surface a little past the top so the wave crests clear the V completely.
    const y = V_BOTTOM - p * (V_BOTTOM - V_TOP) - (p > 0.985 ? (p - 0.985) / 0.015 * 7 : 0);
    liquid.style.transform = `translateY(${y.toFixed(3)}%)`;
  };
  const tick = (now) => {
    const dt = last ? Math.min(64, now - last) : 16;
    last = now;
    // Critically-damped style easing: quick to follow, never overshoots.
    shown += (target - shown) * (1 - Math.exp(-dt / 220));
    if (Math.abs(target - shown) < 0.0005) shown = target;
    place(shown);
    raf = requestAnimationFrame(tick);
  };

  el.setProgress = (p) => { target = Math.min(1, Math.max(0, Number(p) || 0)); };
  el.jumpTo = (p) => { target = shown = Math.min(1, Math.max(0, p)); place(shown); };
  el.setBusy = (on) => el.classList.toggle('busy', !!on);
  el.start = () => { if (!raf) { last = 0; raf = requestAnimationFrame(tick); } el.classList.add('running'); };
  el.stop = () => { cancelAnimationFrame(raf); raf = 0; el.classList.remove('running'); };
  el.progress = () => shown;
  place(0);
  return el;
}
