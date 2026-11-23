// Path to the bundled ffmpeg for build scripts (fetched by scripts/fetch-ffmpeg.js).
const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');
if (!fs.existsSync(p)) throw new Error('vendor/ffmpeg/ffmpeg.exe is missing - run `node scripts/fetch-ffmpeg.js` (or `npm install`).');
module.exports = p;
