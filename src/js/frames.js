// Shared frame source for every ffmpeg-backed output (hardware-encoded recording and live streaming).
// The composited canvas is converted to NV12 on the GPU ONCE per tick, then handed to each sink that
// is due a frame — so recording + streaming together cost one conversion, not two.
import { Nv12Converter } from './nv12.js';
import * as compositor from './compositor.js';

const sinks = new Set(); // sink = { due(now) -> token|null, send(buf, token) }
let conv = null;
let buf = null;
let grabbing = null;

/** Create the converter for the current canvas size. Throws if the GPU path is unavailable. */
export function prepare() {
  const { w, h } = compositor.getSize();
  if (conv && conv.w === w && conv.h === h) return conv;
  if (conv) { conv.dispose(); conv = null; }
  conv = new Nv12Converter(w, h);
  buf = new Uint8Array(conv.size);
  return conv;
}

export function addSink(sink) {
  sinks.add(sink);
  compositor.setFrameHook(onFrame);
}

export function removeSink(sink) {
  sinks.delete(sink);
  if (sinks.size) return;
  compositor.setFrameHook(null);
  Promise.resolve(grabbing).then(() => {
    if (!sinks.size && conv) { conv.dispose(); conv = null; buf = null; }
  });
}

export const whenIdle = () => Promise.resolve(grabbing);

function onFrame() {
  if (grabbing || !sinks.size || !conv) return;
  const now = performance.now();
  const due = [];
  for (const s of sinks) {
    const token = s.due(now);
    if (token !== null && token !== undefined && token !== false) due.push([s, token]);
  }
  if (!due.length) return;
  grabbing = conv.convert(compositor.canvas, buf)
    .then((b) => { for (const [s, token] of due) if (sinks.has(s)) s.send(b, token); })
    .catch((err) => { console.error('Frame conversion failed', err); })
    .finally(() => { grabbing = null; });
}
