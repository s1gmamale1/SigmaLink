'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor', 'whisper.cpp');

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

const prebuild = run(process.execPath, [require.resolve('node-gyp-build/bin.js')]);
if (prebuild.status === 0) process.exit(0);

if (!fs.existsSync(path.join(vendor, 'src', 'whisper.cpp'))) {
  console.warn('[voice-whisper] vendor sources absent; installing JS stub only');
  process.exit(0);
}

const rebuild = run(process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp', ['rebuild']);
process.exit(rebuild.status ?? 1);
