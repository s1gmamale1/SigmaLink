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
if (rebuild.status !== 0) {
  // The from-source whisper.cpp build is not yet green on all platforms (the
  // binding.gyp source list vs the pinned ggml submodule layout → unresolved
  // ggml_* symbols on win, CXX failure on mac). A failed compile must NEVER abort
  // the release: index.js already falls back to a JS stub when whisper_bridge.node
  // is absent (callers degrade to Apple Speech.framework) — exactly what shipped
  // through v2.7.1. Warn and exit 0 so electron-builder's npmRebuild and
  // @electron/rebuild don't fail packaging. Real cross-platform whisper
  // compilation is tracked as a separate follow-up.
  console.warn(
    `[voice-whisper] from-source rebuild failed (status=${rebuild.status ?? 'null'}); ` +
      'falling back to the JS stub — whisper STT is disabled in this build.',
  );
}
process.exit(0);
