// Development helper: fetches the same ffmpeg builds the app downloads on first launch (ffmpeg-builds.js) into
// vendor/ffmpeg and vendor/ffmpeg-legacy, so `npm start` and the build scripts work without the in-app setup.
// The app prefers its own downloaded copy and falls back to vendor/ when running from source.
//
//   npm run ffmpeg              fetch what's missing
//   npm run ffmpeg -- --force   re-download
const path = require('path');
const builds = require('../ffmpeg-builds');
const { installBuild, isInstalled } = require('../ffmpeg-setup');

const root = path.join(__dirname, '..');
const targets = [[builds.main, path.join(root, 'vendor', 'ffmpeg')], [builds.legacy, path.join(root, 'vendor', 'ffmpeg-legacy')]];

(async () => {
  if (process.platform !== 'win32') { console.log('[ffmpeg] skipped: Windows builds only'); return; }
  const force = process.argv.includes('--force');
  for (const [build, dir] of targets) {
    if (!force && isInstalled(build, dir)) { console.log(`[ffmpeg] ${build.label}: already present`); continue; }
    let last = -25;
    await installBuild(build, dir, {
      onPhase: (phase, i) => {
        if (phase === 'download' && i.total) {
          const pct = Math.floor((i.got / i.total) * 100);
          if (pct >= last + 25) { last = pct; console.log(`[ffmpeg] ${build.label}: downloading ${pct}%`); }
        } else if (phase !== 'download') console.log(`[ffmpeg] ${build.label}: ${phase}`);
      },
    });
  }
})().catch((err) => { console.error(`[ffmpeg] ${err.message}`); process.exit(1); });
