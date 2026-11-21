'use strict';
const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, dialog,
  globalShortcut, shell, screen, Menu, safeStorage,
} = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const SELFTEST = process.argv.includes('--selftest');

// Keep rendering / timers alive while the window is minimised or covered —
// essential for a recorder that composites in the renderer.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns');

if (!app.requestSingleInstanceLock() && !SELFTEST) {
  app.quit();
}

let win = null;
const recs = new Map(); // id -> { stream, path, bytes, start }
let recSeq = 0;

function ffmpegPath() {
  try {
    let p = require('ffmpeg-static');
    if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

function defaultRecDir() {
  try { return path.join(app.getPath('videos'), 'RecScreen'); }
  catch { return path.join(os.homedir(), 'Videos', 'RecScreen'); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#16171a',
    title: 'RecScreen',
    icon: path.join(__dirname, 'src', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1b1c20', symbolColor: '#c9ccd3', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // If a recording is running, let the renderer finalise the file before the window goes away.
  win.on('close', (e) => {
    if (busy && !forceQuit) { e.preventDefault(); win.webContents.send('request-close'); }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Allow camera / microphone / capture without prompting.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'audioCapture', 'videoCapture', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler(() => true);
  createWindow();
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  for (const r of recs.values()) { try { r.stream.end(); } catch { /* ignore */ } }
  for (const s of streams.values()) { try { s.closed = true; if (s.proc) s.proc.kill(); } catch { /* ignore */ } }
});

/* ------------------------------------------------------------------ */
/* App info                                                            */
/* ------------------------------------------------------------------ */
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  defaultRecDir: defaultRecDir(),
  ffmpeg: !!ffmpegPath(),
  selftest: SELFTEST,
  outDir: SELFTEST && process.env.RECSCREEN_OUT ? process.env.RECSCREEN_OUT : null,
  cores: os.cpus().length,
  platform: process.platform,
}));

/* ------------------------------------------------------------------ */
/* Capture source enumeration                                          */
/* ------------------------------------------------------------------ */
ipcMain.handle('sources:list', async (_e, opts = {}) => {
  const types = opts.types || ['screen', 'window'];
  const w = opts.thumb || 320;
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: w, height: Math.round(w * 9 / 16) },
    fetchWindowIcons: true,
  });
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const ownId = win ? win.getMediaSourceId() : null;
  let screenIdx = 0;
  const out = [];
  for (const s of sources) {
    if (s.id === ownId) continue;
    const isScreen = s.id.startsWith('screen:');
    let name = s.name;
    let meta = '';
    if (isScreen) {
      screenIdx += 1;
      const d = displays.find((x) => String(x.id) === String(s.display_id));
      if (d) {
        const pw = Math.round(d.size.width * d.scaleFactor);
        const ph = Math.round(d.size.height * d.scaleFactor);
        name = `Display ${screenIdx}`;
        meta = `${pw}×${ph} @ ${d.bounds.x},${d.bounds.y}${d.id === primaryId ? ' · Primary' : ''}`;
      }
    } else if (!s.name || !s.name.trim()) {
      continue;
    }
    out.push({
      id: s.id,
      type: isScreen ? 'screen' : 'window',
      name,
      meta,
      thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
    });
  }
  return out;
});

/* ------------------------------------------------------------------ */
/* Files & dialogs                                                     */
/* ------------------------------------------------------------------ */
ipcMain.handle('dialog:folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: current || undefined });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:image', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('file:read', async (_e, p) => {
  const buf = await fs.promises.readFile(p);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});
ipcMain.handle('shell:show', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
ipcMain.handle('shell:openDir', async (_e, p) => {
  try { await fs.promises.mkdir(p, { recursive: true }); } catch { /* ignore */ }
  return shell.openPath(p);
});
ipcMain.handle('shell:openFile', (_e, p) => shell.openPath(p));

ipcMain.handle('shot:save', async (_e, { dir, name, data }) => {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = uniquePath(path.join(dir, name));
  await fs.promises.writeFile(file, Buffer.from(data));
  return file;
});

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; i < 10000; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Recording sink                                                      */
/* ------------------------------------------------------------------ */
ipcMain.handle('rec:open', async (_e, { dir, name, ext }) => {
  await fs.promises.mkdir(dir, { recursive: true });
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'recording';
  const file = uniquePath(path.join(dir, `${safe}.${ext}`));
  const stream = fs.createWriteStream(file);
  const id = ++recSeq;
  const entry = { stream, path: file, bytes: 0, error: null };
  stream.on('error', (err) => { entry.error = err; });
  recs.set(id, entry);
  return { id, path: file };
});

ipcMain.on('rec:write', (_e, id, data) => {
  const r = recs.get(id);
  if (!r || r.error) return;
  const buf = Buffer.from(data);
  r.bytes += buf.length;
  r.stream.write(buf);
});

ipcMain.handle('rec:size', (_e, id) => (recs.get(id) ? recs.get(id).bytes : 0));

ipcMain.handle('rec:close', async (_e, id, opts = {}) => {
  const r = recs.get(id);
  if (!r) return { ok: false, error: 'Unknown recording' };
  await new Promise((resolve) => r.stream.end(resolve));
  recs.delete(id);
  if (r.error) return { ok: false, error: String(r.error.message || r.error), path: r.path };

  const nativeExt = path.extname(r.path).slice(1).toLowerCase();
  const target = (opts.target || nativeExt).toLowerCase();
  const needsProcess = nativeExt !== target || (nativeExt === 'webm' && opts.fixDuration !== false);
  if (!needsProcess) return { ok: true, path: r.path, bytes: r.bytes };

  const ff = ffmpegPath();
  if (!ff) return { ok: true, path: r.path, bytes: r.bytes, warning: 'ffmpeg not available — saved in the native format.' };

  const finalPath = nativeExt === target ? r.path : uniquePath(r.path.replace(/\.[^.]+$/, `.${target}`));
  const out = r.path.replace(/\.[^.]+$/, `.processing.${target}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-fflags', '+genpts', '-i', r.path];
  const aBr = `${opts.audioBitrate || 192}k`;
  if (target === 'mp4') {
    if (opts.codec === 'h264') args.push('-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac', '-b:a', aBr, '-movflags', '+faststart');
  } else {
    args.push('-c', 'copy');
  }
  args.push('-progress', 'pipe:1', out);

  const durMs = Math.max(1, opts.durationMs || 1);
  const result = await new Promise((resolve) => {
    const p = spawn(ff, args, { windowsHide: true });
    let errTxt = '';
    p.stderr.on('data', (d) => { errTxt += d.toString(); });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      const m = [...buf.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (m && win) {
        const pct = Math.min(99, Math.round((Number(m[1]) / 1000) / durMs * 100));
        win.webContents.send('rec:progress', { id, pct });
      }
      if (buf.length > 4096) buf = buf.slice(-1024);
    });
    p.on('error', (err) => resolve({ ok: false, error: err.message }));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: errTxt.trim().split('\n').pop() || `ffmpeg exited with ${code}` }));
  });

  if (result.ok && fs.existsSync(out)) {
    try { await fs.promises.unlink(r.path); } catch { /* keep both if we cannot delete */ }
    let done = out;
    try { await fs.promises.rename(out, finalPath); done = finalPath; } catch { /* keep .processing name */ }
    const st = await fs.promises.stat(done);
    return { ok: true, path: done, bytes: st.size };
  }
  try { if (fs.existsSync(out)) await fs.promises.unlink(out); } catch { /* ignore */ }
  return { ok: true, path: r.path, bytes: r.bytes, warning: `Post-processing failed (${result.error}). Original kept.` };
});

/* ------------------------------------------------------------------ */
/* Hardware encoding (NVENC via ffmpeg)                                */
/*                                                                     */
/* The renderer composites the scene, converts it to NV12 on the GPU    */
/* and streams raw frames here. They are piped into ffmpeg (NVENC) and */
/* the mixed audio arrives as a separate Opus file; both are muxed into */
/* the final container when recording stops.                           */
/* ------------------------------------------------------------------ */
const encs = new Map(); // id -> session
let encSeq = 0;
let probeCache = null;

function runFfmpegProbe(ff, codec) {
  return new Promise((resolve) => {
    const p = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30', '-frames:v', '3', '-c:v', codec, '-f', 'null', '-'], { windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(false); }, 10000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}

ipcMain.handle('enc:probe', async () => {
  if (probeCache) return probeCache;
  const ff = ffmpegPath();
  const res = { nvenc: { h264: false, hevc: false, av1: false } };
  if (ff) {
    const [h264, hevc, av1] = await Promise.all(['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'].map((c) => runFfmpegProbe(ff, c)));
    res.nvenc = { h264, hevc, av1 };
  }
  probeCache = res;
  return res;
});

function nvencArgs(o) {
  const n = o.nvenc || {};
  const br = Math.max(1000, Math.round(o.bitrate || 16000));
  const preset = /^p[1-7]$/.test(n.preset) ? n.preset : 'p5';
  const args = ['-preset', preset, '-tune', 'hq', '-spatial-aq', '1', '-rc-lookahead', '16', '-g', String(Math.max(1, Math.round(o.fps * 2)))];
  if (o.ffCodec === 'h264_nvenc') args.push('-profile:v', 'high', '-bf', '2');
  else if (o.ffCodec === 'hevc_nvenc') args.push('-profile:v', 'main', '-bf', '2');
  if (n.rc === 'cbr') args.push('-rc', 'cbr', '-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${br * 2}k`);
  else if (n.rc === 'cq') args.push('-rc', 'vbr', '-cq', String(Math.min(51, Math.max(1, Math.round(n.cq || 21)))), '-b:v', '0');
  else args.push('-rc', 'vbr', '-b:v', `${br}k`, '-maxrate', `${Math.round(br * 1.5)}k`, '-bufsize', `${br * 2}k`);
  return args;
}

const toBuf = (d) => (Buffer.isBuffer(d) ? d : d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(d.buffer, d.byteOffset, d.byteLength));

ipcMain.handle('enc:start', async (_e, o) => {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg is not available.' };
  await fs.promises.mkdir(o.dir, { recursive: true });
  const safe = o.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'recording';
  const finalPath = uniquePath(path.join(o.dir, `${safe}.${o.target}`));
  const base = finalPath.replace(/\.[^.]+$/, '');
  const vPath = `${base}.video.tmp.mkv`;
  const aPath = `${base}.audio.tmp.webm`;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'nv12', '-video_size', `${o.w}x${o.h}`, '-framerate', String(o.fps), '-i', 'pipe:0',
    '-c:v', o.ffCodec, ...nvencArgs(o),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-f', 'matroska', vPath,
  ];
  const proc = spawn(ff, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const id = ++encSeq;
  const s = {
    id, proc, vPath, aPath, finalPath, base,
    frameSize: (o.w * o.h * 3) / 2,
    nextIdx: 0, last: null, dropped: 0, closed: false, err: '', failed: false,
    audio: fs.createWriteStream(aPath),
    exited: null,
  };
  proc.stderr.on('data', (d) => { s.err += d.toString(); if (s.err.length > 4000) s.err = s.err.slice(-2000); });
  proc.stdin.on('error', () => { s.failed = true; });
  s.exited = new Promise((resolve) => {
    proc.on('error', (err) => { s.err += err.message; s.failed = true; resolve(-1); });
    proc.on('close', (code) => {
      s.failed = s.failed || code !== 0;
      if (!s.closed && win) win.webContents.send('enc:died', { id, error: s.err.trim().split('\n').pop() || `ffmpeg exited with ${code}` });
      resolve(code);
    });
  });
  // Detect immediate failures (e.g. no NVENC session available) before declaring success.
  const alive = await Promise.race([new Promise((r) => setTimeout(() => r(true), 450)), s.exited.then(() => false)]);
  if (!alive) {
    try { s.audio.destroy(); fs.unlink(aPath, () => {}); fs.unlink(vPath, () => {}); } catch { /* ignore */ }
    return { ok: false, error: s.err.trim().split('\n').pop() || 'Encoder failed to start.' };
  }
  encs.set(id, s);
  return { ok: true, id, path: finalPath };
});

ipcMain.on('enc:frame', (_e, id, idx, data) => {
  const s = encs.get(id);
  if (!s || s.closed || s.failed) return;
  const buf = toBuf(data);
  if (buf.length !== s.frameSize) return;
  if (idx < s.nextIdx) { s.dropped++; return; }
  const stdin = s.proc.stdin;
  // Recording prefers buffering (~96 MB) over dropping; a stalled encoder still can't grow memory without bound.
  if (stdin.writableLength > Math.max(8, Math.floor(96e6 / s.frameSize)) * s.frameSize) { s.dropped++; return; }
  for (; s.nextIdx < idx; s.nextIdx++) stdin.write(s.last || buf); // fill gaps so timing stays constant-rate
  stdin.write(buf);
  s.last = buf;
  s.nextIdx = idx + 1;
});

ipcMain.on('enc:audio', (_e, id, data) => {
  const s = encs.get(id);
  if (s && !s.closed) s.audio.write(toBuf(data));
});

ipcMain.handle('enc:size', (_e, id) => {
  const s = encs.get(id);
  if (!s) return null;
  let bytes = 0;
  try { bytes = fs.statSync(s.vPath).size + s.audio.bytesWritten; } catch { /* file not flushed yet */ }
  return { bytes, dropped: s.dropped };
});

function runMux(ff, args) {
  return new Promise((resolve) => {
    const p = spawn(ff, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim().split('\n').pop() || `ffmpeg exited with ${code}` }));
  });
}

ipcMain.handle('enc:stop', async (_e, id, o = {}) => {
  const s = encs.get(id);
  if (!s) return { ok: false, error: 'Unknown recording' };
  s.closed = true;
  try { s.proc.stdin.end(); } catch { /* already closed */ }
  const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('timeout'), 60000))]);
  if (code === 'timeout') { try { s.proc.kill(); } catch { /* ignore */ } }
  await new Promise((r) => s.audio.end(r));
  encs.delete(id);

  const rm = (p) => { try { fs.unlinkSync(p); } catch { /* ignore */ } };
  if (code !== 0 || !fs.existsSync(s.vPath) || fs.statSync(s.vPath).size === 0) {
    rm(s.aPath);
    const keep = fs.existsSync(s.vPath) && fs.statSync(s.vPath).size > 0;
    const salvage = keep ? uniquePath(`${s.base}.mkv`) : null;
    if (keep) { try { fs.renameSync(s.vPath, salvage); } catch { /* ignore */ } }
    return { ok: false, error: s.err.trim().split('\n').pop() || 'The hardware encoder stopped unexpectedly.', path: salvage };
  }

  const ff = ffmpegPath();
  const hasAudio = fs.existsSync(s.aPath) && fs.statSync(s.aPath).size > 0;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  const off = (o.audioOffsetMs || 0) / 1000;
  if (hasAudio) {
    if (off < 0) args.push('-itsoffset', String(-off), '-i', s.vPath, '-i', s.aPath);
    else args.push('-i', s.vPath, '-itsoffset', String(off), '-i', s.aPath);
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-i', s.vPath, '-map', '0:v:0');
  }
  args.push('-c:v', 'copy');
  if (hasAudio) {
    if (o.target === 'mp4') args.push('-c:a', 'aac', '-b:a', `${o.audioBitrate || 192}k`);
    else args.push('-c:a', 'copy');
  }
  if (o.target === 'mp4') {
    args.push('-movflags', '+faststart');
    if (o.codec === 'hevc') args.push('-tag:v', 'hvc1');
  }
  args.push(s.finalPath);
  const r = await runMux(ff, args);
  if (r.ok && fs.existsSync(s.finalPath)) {
    rm(s.vPath); rm(s.aPath);
    return { ok: true, path: s.finalPath, bytes: fs.statSync(s.finalPath).size, dropped: s.dropped };
  }
  // Muxing failed: keep the (video-only) encode rather than lose the recording.
  rm(s.finalPath); rm(s.aPath);
  const salvage = uniquePath(`${s.base}.mkv`);
  try { fs.renameSync(s.vPath, salvage); } catch { /* ignore */ }
  return { ok: true, path: salvage, bytes: fs.existsSync(salvage) ? fs.statSync(salvage).size : 0, dropped: s.dropped, warning: `Could not mux audio (${r.error}). Saved the video track only.` };
});

/* ------------------------------------------------------------------ */
/* Live streaming (RTMP / RTMPS via ffmpeg)                            */
/*                                                                     */
/* Frames (NV12) arrive over IPC and are piped into ffmpeg's stdin;    */
/* mixed audio arrives as 48 kHz stereo float PCM and is fed to ffmpeg */
/* over a loopback TCP socket (Windows has no extra stdio pipes).      */
/* Both inputs are timestamped on arrival so A/V stay in sync.         */
/* ------------------------------------------------------------------ */
const streams = new Map();
let streamSeq = 0;

const scrub = (s, key) => {
  let t = String(s || '');
  if (key) t = t.split(key).join('••••');
  return t.replace(/(rtmps?:\/\/[^\s/]+\/[^\s/]+\/)\S+/gi, '$1••••').trim();
};

function streamStatus(s, phase, extra = {}) {
  s.phase = phase;
  if (win) win.webContents.send('stream:status', { id: s.id, phase, ...extra });
}

function streamArgs(s) {
  const o = s.o;
  const br = Math.max(500, Math.round(o.bitrate));
  const gop = String(Math.max(1, Math.round(o.outFps * 2))); // 2 s keyframe interval (Twitch/YouTube/Kick requirement)
  const a = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    '-use_wallclock_as_timestamps', '1', '-thread_queue_size', '64',
    '-f', 'rawvideo', '-pix_fmt', 'nv12', '-video_size', `${o.w}x${o.h}`, '-framerate', String(o.fps), '-i', 'pipe:0',
    '-use_wallclock_as_timestamps', '1', '-thread_queue_size', '512',
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', `tcp://127.0.0.1:${s.port}`,
    '-map', '0:v:0', '-map', '1:a:0',
  ];
  const filters = [];
  if (o.outW !== o.w || o.outH !== o.h) filters.push(`scale=${o.outW}:${o.outH}:flags=bilinear`);
  if (filters.length) a.push('-vf', filters.join(','));
  a.push('-fps_mode', 'cfr', '-r', String(o.outFps));
  if (o.encoder === 'nvenc') {
    a.push('-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'cbr', '-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${br * 2}k`,
      '-g', gop, '-bf', '2', '-profile:v', 'high', '-spatial-aq', '1', '-forced-idr', '1');
  } else {
    a.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${br * 2}k`,
      '-g', gop, '-keyint_min', gop, '-sc_threshold', '0', '-profile:v', 'high', '-pix_fmt', 'yuv420p');
  }
  a.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
  a.push('-af', 'aresample=async=1000', '-c:a', 'aac', '-b:a', `${Math.round(o.audioBitrate)}k`, '-ar', '48000', '-ac', '2');
  a.push('-f', 'flv', '-flvflags', 'no_duration_filesize', '-progress', 'pipe:1', '-stats_period', '1', s.url);
  return a;
}

function spawnStream(s) {
  const ff = ffmpegPath();
  s.prog = {};
  s.err = '';
  s.backlogDrops = 0;
  const proc = spawn(ff, streamArgs(s), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  s.proc = proc;
  streamStatus(s, s.attempts > 0 ? 'reconnecting' : 'connecting', { attempt: s.attempts });
  proc.stdin.on('error', () => { /* ffmpeg exited; close handler deals with it */ });
  proc.stderr.on('data', (d) => { s.err += d.toString(); if (s.err.length > 4000) s.err = s.err.slice(-2000); });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      s.prog[line.slice(0, eq)] = line.slice(eq + 1);
      if (line.startsWith('progress=')) {
        const p = s.prog;
        if (Number(p.frame) > 0) {
          if (s.phase !== 'live') { s.everLive = true; s.attempts = 0; }
          streamStatus(s, 'live', {
            kbps: parseFloat(p.bitrate) || 0,
            fps: parseFloat(p.fps) || 0,
            speed: p.speed || '',
            dropped: (Number(p.drop_frames) || 0) + s.backlogDrops + s.totalBacklogDrops,
          });
        }
      }
    }
  });
  const onEnd = (code) => {
    if (s.proc !== proc) return;
    s.proc = null;
    if (s.closed) return;
    const msg = scrub(s.err.trim().split('\n').filter(Boolean).slice(-2).join(' — ') || `ffmpeg exited with code ${code}`, s.key);
    s.totalBacklogDrops += s.backlogDrops;
    const giveUp = !s.o.reconnect || s.attempts >= 10 || (!s.everLive && s.attempts >= 1);
    if (giveUp) {
      streamStatus(s, 'error', { error: msg });
      teardownStream(s);
    } else {
      s.attempts += 1;
      streamStatus(s, 'reconnecting', { attempt: s.attempts, error: msg });
      s.timer = setTimeout(() => { if (!s.closed) spawnStream(s); }, 3000);
    }
  };
  proc.on('error', (err) => { s.err += err.message; onEnd(-1); });
  proc.on('close', onEnd);
}

function teardownStream(s) {
  s.closed = true;
  clearTimeout(s.timer);
  try { if (s.sock) s.sock.destroy(); } catch { /* ignore */ }
  try { s.server.close(); } catch { /* ignore */ }
  streams.delete(s.id);
}

ipcMain.handle('stream:start', async (_e, o) => {
  if (streams.size) return { ok: false, error: 'Already streaming.' };
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg is not available.' };
  const server = String(o.server || '').trim().replace(/\/+$/, '');
  if (!/^rtmps?:\/\/[^\s]+$/i.test(server)) return { ok: false, error: 'The server URL must start with rtmp:// or rtmps://' };
  if (!o.key || /\s/.test(o.key)) return { ok: false, error: 'Enter your stream key in Settings → Stream.' };
  const s = {
    id: ++streamSeq, o, key: o.key, url: `${server}/${o.key}`, phase: 'connecting',
    frameSize: (o.w * o.h * 3) / 2, attempts: 0, everLive: false, closed: false,
    proc: null, sock: null, timer: null, prog: {}, err: '', backlogDrops: 0, totalBacklogDrops: 0,
  };
  s.server = net.createServer((sock) => {
    if (s.sock) s.sock.destroy();
    s.sock = sock;
    sock.setNoDelay(true);
    sock.on('error', () => {});
    sock.on('close', () => { if (s.sock === sock) s.sock = null; });
  });
  await new Promise((resolve) => s.server.listen(0, '127.0.0.1', resolve));
  s.port = s.server.address().port;
  streams.set(s.id, s);
  spawnStream(s);
  return { ok: true, id: s.id };
});

ipcMain.on('stream:frame', (_e, id, data) => {
  const s = streams.get(id);
  if (!s || s.closed || !s.proc || !s.proc.stdin.writable) return;
  const buf = toBuf(data);
  if (buf.length !== s.frameSize) return;
  if (s.proc.stdin.writableLength > s.frameSize * 4) { s.backlogDrops++; return; } // encoder/network too slow: drop, never stall the app
  s.proc.stdin.write(buf);
});

ipcMain.on('stream:audio', (_e, id, data) => {
  const s = streams.get(id);
  if (!s || s.closed || !s.sock || !s.sock.writable || s.sock.writableLength > 1 << 20) return;
  s.sock.write(toBuf(data));
});

ipcMain.handle('stream:stop', async (_e, id) => {
  const s = streams.get(id);
  if (!s) return { ok: true };
  s.closed = true;
  clearTimeout(s.timer);
  const proc = s.proc;
  if (proc) {
    try { proc.stdin.end(); } catch { /* ignore */ }
    try { if (s.sock) s.sock.end(); } catch { /* ignore */ }
    await Promise.race([new Promise((r) => proc.once('close', r)), new Promise((r) => setTimeout(r, 3000))]);
    try { proc.kill(); } catch { /* already gone */ }
  }
  teardownStream(s);
  return { ok: true };
});

/* ---- stream keys: encrypted at rest with Windows DPAPI via Electron safeStorage ---- */
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
const readSecrets = () => { try { return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')); } catch { return {}; } };
const validSecretName = (n) => /^streamkey:[a-z0-9_-]{1,32}$/.test(String(n));

ipcMain.handle('secret:available', () => safeStorage.isEncryptionAvailable());
ipcMain.handle('secret:set', (_e, name, value) => {
  if (!validSecretName(name) || !safeStorage.isEncryptionAvailable()) return false;
  const all = readSecrets();
  if (!value) delete all[name];
  else all[name] = safeStorage.encryptString(String(value)).toString('base64');
  fs.mkdirSync(path.dirname(secretsFile()), { recursive: true });
  fs.writeFileSync(secretsFile(), JSON.stringify(all));
  return true;
});
ipcMain.handle('secret:get', (_e, name) => {
  if (!validSecretName(name) || !safeStorage.isEncryptionAvailable()) return '';
  const v = readSecrets()[name];
  if (!v) return '';
  try { return safeStorage.decryptString(Buffer.from(v, 'base64')); } catch { return ''; }
});

/* ------------------------------------------------------------------ */
/* Hotkeys                                                             */
/* ------------------------------------------------------------------ */
ipcMain.handle('hotkeys:set', (_e, map) => {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [action, accel] of Object.entries(map || {})) {
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, () => {
        if (win) win.webContents.send('hotkey', action);
      });
      if (!ok) failed.push(action);
    } catch { failed.push(action); }
  }
  return failed;
});

/* ------------------------------------------------------------------ */
/* Window control                                                      */
/* ------------------------------------------------------------------ */
ipcMain.handle('win:protect', (_e, on) => { if (win) win.setContentProtection(!!on); });
ipcMain.handle('win:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('win:restore', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
ipcMain.handle('win:fullscreen', (_e, on) => { if (win) win.setFullScreen(!!on); });
let busy = false;
let forceQuit = false;
ipcMain.on('app:busy', (_e, b) => { busy = !!b; });
ipcMain.handle('app:quit', () => { forceQuit = true; app.quit(); });

/* ------------------------------------------------------------------ */
/* System stats                                                        */
/* ------------------------------------------------------------------ */
let lastCpu = null;
function cpuSnapshot() {
  let idle = 0; let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}
ipcMain.handle('stats', async (_e, dir) => {
  const snap = cpuSnapshot();
  let cpu = 0;
  if (lastCpu) {
    const dt = snap.total - lastCpu.total;
    const di = snap.idle - lastCpu.idle;
    cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
  }
  lastCpu = snap;
  let free = null;
  try {
    let d = dir || defaultRecDir();
    while (d && !fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; }
    const st = await fs.promises.statfs(d);
    free = st.bavail * st.bsize;
  } catch { /* ignore */ }
  return { cpu, free };
});

/* ------------------------------------------------------------------ */
/* Self test hooks (npm run selftest)                                  */
/* ------------------------------------------------------------------ */
if (SELFTEST) {
  ipcMain.handle('selftest:shot', async (_e, file) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    return true;
  });
  ipcMain.handle('selftest:done', (_e, result) => {
    fs.writeFileSync(path.join(__dirname, 'selftest-result.json'), JSON.stringify(result, null, 2));
    setTimeout(() => app.quit(), 200);
  });
}
