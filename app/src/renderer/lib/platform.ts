// v1.2.0 Windows port — renderer-side platform detection.
//
// The preload bundle (electron/preload.ts) exposes `process.platform` as a
// static field on `window.sigma` so the renderer — which has no Node globals
// under contextIsolation — can branch on the OS without an IPC round trip.
//
// This module is the single mockable surface every renderer feature should
// import from. Tests stub `window.sigma = { platform: 'win32', ... }` and the
// rest of the renderer reads through `getPlatform()` / `IS_WIN32`.
//
// Fallback rules:
//   - In production the preload always runs first, so `window.sigma.platform`
//     is always a `NodeJS.Platform` string.
//   - In dev (vitest's jsdom environment, Storybook, plain vite preview) the
//     preload bridge is absent. We default to 'darwin' because (a) the
//     historical SigmaLink code paths assumed darwin and (b) the lead's dev
//     boxes are all macOS — keeping the default there avoids surprising layout
//     regressions in tests that don't explicitly stub the platform.

export function getPlatform(): NodeJS.Platform {
  return (typeof window !== 'undefined' && window.sigma?.platform) || 'darwin';
}

export const IS_WIN32: boolean = getPlatform() === 'win32';
