// @sigmalink/voice-whisper — runtime entrypoint.
//
// On darwin (macOS), loads the prebuilt or freshly-built N-API binary via
// `node-gyp-build`. On every other platform — and on darwin builds where
// the binary is missing (e.g. Xcode not installed, CI prebuild not yet
// produced) — exports a stub whose `transcribe()` rejects with a clear
// `'whisper-unavailable'` error so callers can gracefully fall back to
// Apple Speech.framework.
//
// The stub does NOT throw synchronously; it returns a rejecting Promise so
// the caller never needs to special-case the platform branch in a try/catch.

'use strict';

const path = require('node:path');

/** No-op stub returned on non-mac or missing binary. */
function buildStub() {
  return {
    transcribe() {
      const err = new Error('voice-whisper: native binary not available on this platform/build');
      err.code = 'whisper-unavailable';
      return Promise.reject(err);
    },
  };
}

let mod;

try {
  const loader = require('node-gyp-build');
  const native = loader(path.join(__dirname));
  if (native && typeof native.transcribe === 'function') {
    mod = native;
  } else {
    mod = buildStub();
  }
} catch (_err) {
  // Binary missing — most likely whisper.cpp submodule not initialised yet,
  // or node-gyp rebuild hasn't run in this environment.
  mod = buildStub();
}

module.exports = mod;
module.exports.default = mod;
