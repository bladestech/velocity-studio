// Downloads, verifies and unpacks one ffmpeg build (see ffmpeg-builds.js) into a folder.
// Used by the app on first launch (main.js, with Electron's net.fetch so system proxies work) and by
// scripts/fetch-ffmpeg.js for development (global fetch).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

/** Folder layout: <dir>/ffmpeg.exe, <dir>/LICENSE.txt, <dir>/VERSION (build sha, so a re-pin re-downloads). */
function isInstalled(build, dir) {
  try {
    return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() === build.sha256 && fs.existsSync(path.join(dir, 'ffmpeg.exe'));
  } catch { return false; }
}

class Cancelled extends Error { constructor() { super('cancelled'); this.cancelled = true; } }

async function download(fetchImpl, url, file, { onProgress, signal, total: expected } = {}) {
  const res = await fetchImpl(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || expected || 0;
  const out = fs.createWriteStream(file);
  // Keep an error listener for the stream's whole life: a write still in flight when a download is cancelled
  // must not surface as an uncaught exception in the main process.
  let writeErr = null;
  out.on('error', (e) => { writeErr = writeErr || e; });
  const closed = new Promise((r) => out.once('close', r));
  const hash = crypto.createHash('sha256');
  let got = 0;
  try {
    for await (const chunk of res.body) {
      if (signal && signal.aborted) throw new Cancelled();
      if (writeErr) throw writeErr;
      const buf = Buffer.from(chunk);
      hash.update(buf);
      got += buf.length;
      if (!out.write(buf)) {
        await new Promise((r) => {
          const done = () => { out.off('drain', done); out.off('close', done); r(); };
          out.on('drain', done);
          out.on('close', done);
        });
      }
      if (onProgress) onProgress(got, total);
    }
  } catch (err) {
    // Let pending writes settle and the file handle close before the caller deletes the temp folder.
    out.end();
    await closed;
    throw signal && signal.aborted ? new Cancelled() : err;
  }
  out.end();
  await closed;
  if (writeErr) throw writeErr;
  return hash.digest('hex');
}

function extractZip(zip, into, entries) {
  // Windows 10+ ships bsdtar as System32\tar.exe, which reads zip files.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    const p = spawn(tar, ['-xf', zip, '-C', into, ...entries], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`could not unpack ffmpeg (${err.trim() || `tar exited with ${code}`})`))));
  });
}

/**
 * Install `build` into `dir`. onPhase(phase, info): 'download' {got,total} | 'verify' | 'extract' | 'done'.
 * Throws an Error with .cancelled when aborted through `signal`.
 */
async function installBuild(build, dir, { fetchImpl = fetch, onPhase = () => {}, signal } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'velocity-ffmpeg-'));
  const stage = `${dir}.partial`;
  try {
    const file = path.join(tmp, `download.${build.format}`);
    onPhase('download', { got: 0, total: build.size });
    const sum = await download(fetchImpl, build.url, file, { signal, total: build.size, onProgress: (got, total) => onPhase('download', { got, total }) });
    onPhase('verify');
    if (sum !== build.sha256) throw new Error('the download was corrupted or tampered with (checksum mismatch). Please try again.');
    if (signal && signal.aborted) throw new Cancelled();

    onPhase('extract');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    if (build.format === 'zip') {
      await extractZip(file, tmp, [build.exe, build.licenseEntry]);
      fs.copyFileSync(path.join(tmp, build.exe), path.join(stage, 'ffmpeg.exe'));
      fs.copyFileSync(path.join(tmp, build.licenseEntry), path.join(stage, 'LICENSE.txt'));
    } else {
      await pipeline(fs.createReadStream(file), zlib.createGunzip(), fs.createWriteStream(path.join(stage, 'ffmpeg.exe')));
      if (build.license) {
        const lsum = await download(fetchImpl, build.license.url, path.join(stage, 'LICENSE.txt'), { signal });
        if (lsum !== build.license.sha256) throw new Error('license file checksum mismatch');
      }
    }
    fs.writeFileSync(path.join(stage, 'VERSION'), `${build.sha256}\n`);
    // Swap in atomically so a half-finished install is never picked up.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(stage, dir);
    onPhase('done');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { installBuild, isInstalled };
