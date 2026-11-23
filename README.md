<p align="center">
  <img src="src/icon.png" alt="Velocity Studio logo" width="128" height="128">
</p>

<h1 align="center">Velocity Studio</h1>

<p align="center">
  <b>An OBS-style screen recorder and live streamer for Windows.</b><br>
  Scenes, an audio mixer, NVENC hardware encoding, and one-click streaming to Twitch, YouTube, Kick and more.
</p>

<p align="center">
  <a href="https://github.com/colebolebole/velocity-studio/releases/latest"><img alt="Version" src="https://img.shields.io/badge/version-1.1.0-33c5e8?style=flat-square"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2fbf62?style=flat-square"></a>
  <img alt="Platform: Windows 10/11" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d4?style=flat-square">
  <img alt="Electron 45" src="https://img.shields.io/badge/Electron-45-47848f?style=flat-square&logo=electron&logoColor=white">
  <img alt="NVIDIA NVENC" src="https://img.shields.io/badge/NVIDIA-NVENC-76b900?style=flat-square&logo=nvidia&logoColor=white">
  <img alt="AMD AMF" src="https://img.shields.io/badge/AMD-AMF-ed1c24?style=flat-square&logo=amd&logoColor=white">
  <img alt="Intel Quick Sync" src="https://img.shields.io/badge/Intel-Quick%20Sync-0071c5?style=flat-square&logo=intel&logoColor=white">
  <img alt="Streaming: RTMP and RTMPS" src="https://img.shields.io/badge/streaming-RTMP%20%2F%20RTMPS-9146ff?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/colebolebole/velocity-studio/releases/latest"><b>Download</b></a> ·
  <a href="#features">Features</a> ·
  <a href="#building-the-installer">Build</a> ·
  <a href="#license">License</a>
</p>

---

## Download
Grab `Velocity Studio Setup <version>.exe` from the [latest release](https://github.com/colebolebole/velocity-studio/releases/latest) and run it (per-user install, no admin rights needed). The installer is **unsigned**, so Windows SmartScreen may warn about an unknown publisher.

On first launch the app offers to download **ffmpeg** (about 120 MB, one time), which it uses for GPU and x264 / x265 encoding. While it downloads, the logo's V fills up as a progress bar. Choosing "Not now" keeps the built-in encoders, and Settings -> Output offers the download later.

**Run from source:** double-click `VelocityStudio.bat` (or `npm start`).

## Features
- **Scenes & sources** - display, window, webcam, image, text and colour sources; drag / resize / crop (Alt+drag) / snap in the live preview; per-source opacity, flip, lock, visibility, z-order, undo on delete.
- **Audio mixer** - System audio (Windows loopback) + any number of microphones / capture devices / virtual cables, stereo peak meters, faders (-60..+12 dB), mute. Switch each channel's source from the gear button or Settings -> Audio; channels recover automatically when devices change.
- **Live streaming** - Twitch, YouTube Live, Facebook Live, Kick, Restream, or any custom RTMP/RTMPS ingest (TikTok, Instagram, X, Rumble...). Encodes with NVENC, AMD AMF or Intel Quick Sync (or x264 on the CPU, with a selectable preset), CBR with 2 s keyframes, optional downscale / lower fps, auto-reconnect. Stream keys are encrypted with Windows DPAPI and never written to the settings file. Streaming and recording can run at once.
- **Hardware & software encoding** - NVIDIA NVENC, AMD AMF and Intel Quick Sync (H.264, HEVC and AV1 where the GPU supports it), plus x264 / x265 on the CPU. Each encoder is auto-detected; Settings -> Output lets you pick Automatic, Hardware, Software or Built-in, then the encoder, its own presets, VBR / CBR / constant quality and the keyframe interval. Frames are converted to NV12 on the GPU and piped to the bundled ffmpeg 9.1.
  - ffmpeg 9.1's NVENC needs **NVIDIA driver 610 or newer**. On older drivers the app also downloads the smaller ffmpeg 6.1.1 compatibility build (about 30 MB) and uses it for NVENC only, so GPU encoding keeps working. Settings and the benchmark suggest a driver update when a GPU's encoder doesn't start.
- **Encoder benchmark** - on first launch (and whenever the graphics card changes) Velocity Studio times real encodes at your output resolution and frame rate with every encoder your PC supports, finds the best-quality preset each one sustains in real time, and recommends a recording profile and streaming encoder. Works on any GPU or CPU-only PC; re-run it any time from Settings -> Output.
- **Recording** - also Chromium's H.264, VP9, VP8 and AV1 encoders as a fallback; 720p-4K at 24-60 fps; MP4 / MKV / WebM; bitrate control; pause/resume; streamed straight to disk.
- **Global hotkeys** - F9 start/stop recording, F10 pause, F11 screenshot, plus an optional start/stop streaming key (all rebindable in Settings).
- **Taskbar indicator** - the taskbar button shows a red dot while recording, amber bars when paused, a cyan dot while live, and a progress bar while a recording is being saved; the window title mirrors it.
- **Hides itself** from captures (no infinite mirror), optional minimise-on-record.
- Keeps recording while minimised or covered by other windows.
- Opens with a short logo animation, and the installer launches the app when it finishes.

Recordings go to `Videos\Velocity Studio` by default (Settings -> Output).

## Building the installer
Builds a Windows NSIS installer (`dist\Velocity Studio Setup <version>.exe`) from the current working folder.

1. Install dependencies (first time only): `npm install`. Optionally run `npm run ffmpeg` so `npm start` has ffmpeg without the in-app download (see Notes).
2. Bump the version - the installer name and version come from `package.json`, and the build never changes it:
   ```powershell
   npm version patch --no-git-tag-version
   ```
   (use `minor` or `major` instead of `patch` as needed)
3. Build:
   ```powershell
   npm run dist
   ```

The installer is a one-click, per-user install and is **unsigned**. `dist/` is gitignored and previous installers are not cleaned up, so delete old ones by hand if you don't want them.

## License
[MIT](LICENSE). Velocity Studio bundles Electron (MIT). ffmpeg is not included in the installer; the app downloads ffmpeg 9.1 (gyan.dev "essentials" build) and, only if needed, ffmpeg 6.1.1, both GPL v3, with their licenses saved next to them in `%APPDATA%\Velocity Studio\ffmpeg`. See the ffmpeg project's licensing terms if you redistribute them.

## Notes
- `npm run selftest` records a 5 s clip and exits (used to verify the capture pipeline).
- `node scripts/make-splash-v.js` regenerates `src/logo-v.png` (the V used by the startup animation) from `src/icon.png`.
- **ffmpeg:** the builds are pinned (URL + SHA-256) in `ffmpeg-builds.js`. `ffmpeg-setup.js` downloads one, verifies the checksum, unpacks only `ffmpeg.exe` and its license, and swaps it in atomically. The app installs into `%APPDATA%\Velocity Studio\ffmpeg\<version>`; `npm run ffmpeg` installs the same builds into `vendor/` (gitignored) for development and the build scripts, and the app uses those when running from source. To move to a newer build, update `ffmpeg-builds.js` and re-test the encoders.
- After a fresh `npm install`, npm may skip install scripts; if `node_modules\electron\dist` is missing run `node node_modules\electron\install.js`.
