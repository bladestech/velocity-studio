# Velocity Studio

An OBS-style screen recorder and live streamer for Windows, built on Electron.

**Run:** double-click `VelocityStudio.bat` (or `npm start`).

## Features
- **Scenes & sources** - display, window, webcam, image, text and colour sources; drag / resize / crop (Alt+drag) / snap in the live preview; per-source opacity, flip, lock, visibility, z-order, undo on delete.
- **Audio mixer** - System audio (Windows loopback) + any number of microphones / capture devices / virtual cables, stereo peak meters, faders (-60..+12 dB), mute. Switch each channel's source from the gear button or Settings -> Audio; channels recover automatically when devices change.
- **Live streaming** - Twitch, YouTube Live, Facebook Live, Kick, Restream, or any custom RTMP/RTMPS ingest (TikTok, Instagram, X, Rumble...). Encodes with NVENC (or x264 on the CPU), CBR with 2 s keyframes, optional downscale / lower fps, auto-reconnect. Stream keys are encrypted with Windows DPAPI and never written to the settings file. Streaming and recording can run at once.
- **NVIDIA NVENC** - H.264, HEVC and AV1 hardware encoding (auto-detected; used automatically when available) with preset, VBR / CBR / constant-quality controls. Frames are converted to NV12 on the GPU and piped to ffmpeg's NVENC encoder.
- **Recording** - also Chromium's H.264, VP9, VP8 and AV1 encoders; 720p-4K at 24-60 fps; MP4 / MKV / WebM; bitrate control; pause/resume; streamed straight to disk.
- **Global hotkeys** - F9 start/stop recording, F10 pause, F11 screenshot, plus an optional start/stop streaming key (all rebindable in Settings).
- **Hides itself** from captures (no infinite mirror), optional minimise-on-record.
- Keeps recording while minimised or covered by other windows.

Recordings go to `Videos\Velocity Studio` by default (Settings -> Output).

## Building the installer
Builds a Windows NSIS installer (`dist\Velocity Studio Setup <version>.exe`) from the current working folder.

1. Install dependencies (first time only): `npm install`
2. Bump the version - the installer name and version come from `package.json`, and the build never changes it:
   ```powershell
   npm version patch --no-git-tag-version
   ```
   (use `minor` or `major` instead of `patch` as needed)
3. Build:
   ```powershell
   npm run dist
   ```

The installer is a one-click, per-user install (no admin rights needed) and is **unsigned**, so Windows SmartScreen may warn about an unknown publisher. `dist/` is gitignored and previous installers are not cleaned up, so delete old ones by hand if you don't want them.

## License
[MIT](LICENSE). Velocity Studio bundles Electron (MIT) and an ffmpeg build via `ffmpeg-static`; ffmpeg is licensed separately (GPL for the bundled build) - see the ffmpeg project's licensing terms if you redistribute the installer.

## Notes
- `npm run selftest` records a 5 s clip and exits (used to verify the capture pipeline).
- After a fresh `npm install`, npm may skip install scripts; if `node_modules\electron\dist` is missing run `node node_modules\electron\install.js`.


