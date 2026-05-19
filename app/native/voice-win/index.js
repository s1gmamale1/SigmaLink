// @sigmalink/voice-win — runtime entrypoint.
//
// On win32, loads the prebuilt or freshly-built N-API binary via
// `node-gyp-build`. On every other platform — and on win32 builds where
// `node-gyp-build` cannot resolve a binary (MSVS toolchain missing, prebuilds
// not committed yet) — exports a stub whose `isAvailable()` returns `false`
// so the adapter can transparently fall back to renderer Web Speech.
//
// The stub does NOT throw on `start`/`stop`/`requestPermission` calls; it
// resolves to a "no-op" payload so callers do not have to special-case the
// platform branch. The voice adapter checks `isAvailable()` first anyway,
// but defending the contract end-to-end keeps unit tests boring on macOS CI.

'use strict';

const path = require('node:path');

/** Build the no-op stub used on non-win32 platforms or load failures. */
function buildStub() {
  const noop = () => () => {};
  return {
    isAvailable() {
      return false;
    },
    requestPermission() {
      return Promise.resolve('not-determined');
    },
    getAuthStatus() {
      return 'not-determined';
    },
    start() {
      const err = new Error('voice-win unavailable on this platform');
      err.code = 'unsupported';
      return Promise.reject(err);
    },
    stop() {
      return Promise.resolve();
    },
    onPartial: noop,
    onFinal: noop,
    onError: noop,
    onState: noop,
  };
}

let mod;

if (process.platform !== 'win32') {
  mod = buildStub();
} else {
  try {
    // `node-gyp-build` walks `prebuilds/<platform>-<arch>/` first, then
    // falls back to `build/Release/<target>.node` if a fresh `node-gyp
    // rebuild` was just run during development. This lets dev installs
    // and packaged installs share the same loader.
    const loader = require('node-gyp-build');
    const native = loader(path.join(__dirname));
    if (native && typeof native.start === 'function') {
      mod = native;
    } else {
      mod = buildStub();
    }
  } catch (_err) {
    // Native binary missing — most likely MSVS Build Tools not installed and
    // CI has not yet produced a prebuild. Stay silent here; the wrapper
    // in `app/src/main/core/voice/native-win.ts` logs once at startup.
    mod = buildStub();
  }
}

module.exports = mod;
module.exports.default = mod;
