# RecScreen

An OBS-style screen recorder for Windows, built on Electron.

**Run:** double-click `RecScreen.bat` (or `npm start`).

## Features
- **Scenes & sources** - display, window, webcam, image, text and colour sources; drag / resize / crop (Alt+drag) / snap in the live preview; per-source opacity, flip, lock, visibility, z-order, undo on delete.
- **Audio mixer** - Desktop Audio (system loopback) + any number of microphones, stereo peak meters, faders (-60..+12 dB), mute.
- **NVIDIA NVENC** - H.264, HEVC and AV1 hardware encoding (auto-detected; used automatically when available) with preset, VBR / CBR / constant-quality controls. Frames are converted to NV12 on the GPU and piped to ffmpeg's NVENC encoder.
- **Recording** - also Chromium's H.264, VP9, VP8 and AV1 encoders; 720p-4K at 24-60 fps; MP4 / MKV / WebM; bitrate control; pause/resume; streamed straight to disk.
- **Global hotkeys** - F9 start/stop, F10 pause, F11 screenshot (rebindable in Settings).
- **Hides itself** from captures (no infinite mirror), optional minimise-on-record.
- Keeps recording while minimised or covered by other windows.

Recordings go to `Videos\RecScreen` by default (Settings -> Output).

## Notes
- `npm run selftest` records a 5 s clip and exits (used to verify the capture pipeline).
- After a fresh `npm install`, npm may skip install scripts; if `node_modules\electron\dist` is missing run `node node_modules\electron\install.js`.

