const fs = require('fs');
const path = require('path');

const from = path.join('electron-dist', 'preload.js');
const to = path.join('electron-dist', 'preload.cjs');

if (fs.existsSync(to)) fs.rmSync(to);
if (fs.existsSync(from)) fs.renameSync(from, to);
