<p align="center">
  <img src="src/icon.png" alt="Velocity Studio logo" width="128" height="128">
</p>

<h1 align="center">Velocity Studio</h1>

<p align="center">
  <b>An OBS-inspired (thank you!) screen recorder and live streamer for Windows.</b><br>
  Scenes, an audio mixer, GPU encoding (NVIDIA, AMD and Intel), and one-click streaming to Twitch, YouTube, Kick and more.
</p>

<p align="center">
  <a href="https://github.com/colebolebole/velocity-studio/releases/latest"><img alt="Version" src="https://img.shields.io/github/v/release/colebolebole/velocity-studio?label=version&color=33c5e8&style=flat-square"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2fbf62?style=flat-square"></a>
  <img alt="Platform: Windows 10/11 and Linux" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20%C2%B7%20Linux-0078d4?style=flat-square">
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
  <a href="#building-on-linux">Linux</a> ·
  <a href="#license">License</a>
</p>

---

## Download
Grab `Velocity Studio Setup <version>.exe` from the [latest release](https://github.com/colebolebole/velocity-studio/releases/latest) and run it (per-user install, no admin rights needed). The installer is **unsigned**, so Windows SmartScreen may warn about an unknown publisher.

On first launch the app offers to download **ffmpeg** (about 120 MB, one time), which it uses for GPU and x264 / x265 encoding. While it downloads, the logo's V fills up as a progress bar. Choosing "Not now" keeps the built-in encoders, and Settings -> Output offers the download later.

**Linux (new in 1.3.0):** the release also has an AppImage, `.deb`, `.rpm`, pacman package and `.tar.gz`; see [Building on Linux](#building-on-linux) for what works there. Install `ffmpeg` from your package manager for GPU / x264 encoding.

**Run from source:** double-click `VelocityStudio.bat` (or `npm start`).

## Features
- **Scenes & sources** - display, window, webcam, image, text and colour sources; drag / resize / crop (Alt+drag) / snap in the live preview; per-source opacity, flip, lock, visibility, z-order, undo on delete.
- **Audio mixer** - System audio (Windows loopback) + any number of microphones / capture devices / virtual cables, stereo peak meters, faders (-60..+12 dB), mute. Switch each channel's source from the gear button or Settings -> Audio; channels recover automatically when devices change.
- **Live streaming** - Twitch, YouTube Live, Facebook Live, Kick, Restream, or any custom RTMP/RTMPS ingest (TikTok, Instagram, X, Rumble...). Encodes with NVENC, AMD AMF or Intel Quick Sync (or x264 on the CPU, with a selectable preset), CBR with 2 s keyframes, optional downscale / lower fps, auto-reconnect. Stream keys are encrypted with Windows DPAPI and never written to the settings file. Streaming and recording can run at once.
- **Hardware & software encoding** - NVIDIA NVENC, AMD AMF and Intel Quick Sync (H.264, HEVC and AV1 where the GPU supports it), plus x264 / x265 on the CPU. Each encoder is auto-detected; Settings -> Output lets you pick Automatic, Hardware, Software or Built-in, then the encoder, its own presets, VBR / CBR / constant quality and the keyframe interval. Frames are converted to NV12 on the GPU and piped to the bundled ffmpeg 9.1.
  - ffmpeg 9.1's NVENC needs **NVIDIA driver 610 or newer**. If any GPU's encoder (NVENC, AMF or Quick Sync) won't start on ffmpeg 9.1, usually because of an older driver, the app also downloads the smaller ffmpeg 6.1.1 compatibility build (about 30 MB) and uses it for just those encoders. If it doesn't help, it's removed again. Settings and the benchmark suggest a driver update when a GPU's encoder doesn't start.
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

## Releasing (automatic)
Pushing a version tag builds and publishes everything: the workflow in `.github/workflows/release.yml` builds the Windows installer and all Linux packages (AppImage, deb, rpm, pacman, tar.gz) on GitHub's runners, checks them, and attaches them plus a `SHA256SUMS.txt` to a GitHub release for that tag.

```bash
npm version minor        # or patch / major: bumps package.json, commits, creates the tag v<version>
git push --follow-tags   # starts the build; the release appears when it finishes (about 10 minutes)
```

- The tag must match `package.json`'s version, otherwise the workflow stops before publishing.
- Write release notes in `.github/release-notes/v<version>.md` before pushing; without that file GitHub generates them from the commits. A tag with a `-` (for example `v1.4.0-beta.1`) is published as a pre-release.
- `npm run dist` and `scripts/build-linux.sh` still only build locally and never publish.
- To build without publishing, run the workflow by hand from the Actions tab; tick `draft_test` to also upload to a private draft release for testing.

## Building on Linux
`scripts/build-linux.sh` detects your distro, CPU (x64, arm64, armv7l) and package manager, installs what the build still needs (it shows the command and asks first), then builds the packages with electron-builder into `dist/`:

```bash
bash scripts/build-linux.sh            # AppImage + your distro's native package
bash scripts/build-linux.sh --check    # only show what it detected and would do
bash scripts/build-linux.sh -t all -y  # AppImage, deb, rpm, pacman and tar.gz, no prompts
```

| Distro family | Detected from `/etc/os-release` | Native package built |
| --- | --- | --- |
| Debian, Ubuntu, Mint, Pop!_OS, Kali ... | `debian` / `ubuntu` | `.deb` |
| Fedora, RHEL, Rocky, Alma, Nobara ... | `fedora` / `rhel` | `.rpm` |
| openSUSE, SLES | `suse` | `.rpm` |
| Arch, Manjaro, EndeavourOS, SteamOS ... | `arch` | `.pacman` |
| Void, Gentoo, anything else | | `.tar.gz` |

- **Node.js:** the system one is used if it is 22.12 or newer; otherwise a private, SHA-256-verified copy is downloaded into `.build-tools/` (nothing system-wide changes). `--local-node` forces the private copy.
- **Needs glibc:** Alpine (musl) and NixOS can't run Electron's prebuilt binaries; build in a Debian / Fedora container or distrobox there. On immutable systems (Silverblue, Bazzite) run it inside a toolbox.
- **arm64 / armv7l hosts:** AppImage and tar.gz work out of the box; deb / rpm / pacman need a system `fpm` (the script tries `gem install fpm`).
- **Runtime:** the Linux app uses the system `ffmpeg` (`sudo apt install ffmpeg`, `dnf install ffmpeg-free`, `pacman -S ffmpeg` ...) instead of downloading one; set `VELOCITY_FFMPEG=/path/to/ffmpeg` to pick a specific build. Without it only the built-in Chromium encoders are available.
- **Not the same as Windows:** the Linux build is new and hasn't been run on real Linux hardware yet. System-audio capture, the taskbar indicator, AMD AMF and Intel Quick Sync are Windows-only, and global hotkeys may not work on Wayland. On Ubuntu 24.04+ an AppImage may need `--no-sandbox` because of the AppArmor user-namespace restriction.

## License
[MIT](LICENSE). Velocity Studio bundles Electron (MIT). ffmpeg is not included in the installer; the app downloads ffmpeg 9.1 (gyan.dev "essentials" build) and, only if needed, ffmpeg 6.1.1, both GPL v3, with their licenses saved next to them in `%APPDATA%\Velocity Studio\ffmpeg`. See the ffmpeg project's licensing terms if you redistribute them.

## Notes
- `npm run selftest` records a 5 s clip and exits (used to verify the capture pipeline).
- `node scripts/make-splash-v.js` regenerates `src/logo-v.png` (the V used by the startup animation) from `src/icon.png`.
- **ffmpeg:** the builds are pinned (URL + SHA-256) in `ffmpeg-builds.js`. `ffmpeg-setup.js` downloads one, verifies the checksum, unpacks only `ffmpeg.exe` and its license, and swaps it in atomically. The app installs into `%APPDATA%\Velocity Studio\ffmpeg\<version>`; `npm run ffmpeg` installs the same builds into `vendor/` (gitignored) for development and the build scripts, and the app uses those when running from source. To move to a newer build, update `ffmpeg-builds.js` and re-test the encoders.
- After a fresh `npm install`, npm may skip install scripts; if `node_modules\electron\dist` is missing run `node node_modules\electron\install.js`.
