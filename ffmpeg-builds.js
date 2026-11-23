// The ffmpeg builds Velocity Studio uses. They are not shipped in the installer: the app downloads them on first
// launch (ffmpeg-setup.js), and `npm run ffmpeg` fetches the same files into vendor/ for development.
// Every download is checked against the pinned SHA-256 before anything is extracted.
'use strict';

module.exports = {
  // Used for everything.
  main: {
    version: '9.1',
    label: 'ffmpeg 9.1',
    url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.zip',
    sha256: 'b9bbbb3acece000cbeec994f856649354e52c773807841e78908374b24d658fd',
    size: 119467219,
    format: 'zip',
    // Paths inside the zip.
    exe: 'ffmpeg-9.1-essentials_build/bin/ffmpeg.exe',
    licenseEntry: 'ffmpeg-9.1-essentials_build/LICENSE',
  },
  // The build Velocity Studio shipped before (ffmpeg-static b6.1.1). Only downloaded, and only used, for a
  // GPU encoder that won't start on the main build: NVENC on NVIDIA drivers older than ffmpeg 9.1 requires (610),
  // and possibly AMF / Quick Sync on older AMD / Intel drivers. It is removed again if it rescues nothing.
  legacy: {
    version: '6.1.1',
    label: 'ffmpeg 6.1.1 (compatibility)',
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz',
    sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
    size: 29581307,
    format: 'gz',
    license: {
      url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/win32-x64.LICENSE',
      sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
    },
  },
};
