// v1.1.5 — ad-hoc codesign sweep run as electron-builder's `afterSign` hook.
//
// Why this exists: v1.1.0..v1.1.4 shipped DMGs whose .app had only the
// linker-injected ad-hoc signature ld(1) stamps into a Mach-O; the bundle
// had no `Contents/_CodeSignature/CodeResources` seal. macOS Gatekeeper
// rejects quarantined downloads in that state with the "is damaged and
// can't be opened" dialog instead of the gentler "unidentified developer"
// right-click-to-open prompt.
//
// What this does: walks the packaged .app and runs
//   codesign --force --deep --sign - --timestamp=none "<App>"
// which (a) writes a real `_CodeSignature/CodeResources` resource seal,
// (b) re-signs every nested Mach-O including native .node modules and
// helper apps, and (c) leaves the signature ad-hoc (no Developer ID, no
// notarisation). The resulting bundle is still NOT trusted by Gatekeeper,
// but it passes `codesign --verify --deep --strict` and surfaces as the
// recoverable "unidentified developer" prompt rather than "damaged".
//
// Inputs from electron-builder afterSign contract:
//   context.appOutDir   absolute path to the directory containing <App>.app
//   context.packager    the platform-specific packager (we only act on mac)
//   context.electronPlatformName  e.g. "darwin"
//
// On failure we throw so the build aborts loudly — a silent failure here
// reproduces exactly the v1.1.4 ship-with-broken-sig bug.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

// Where the app's `node_modules` lands inside the packed bundle, most-current
// layout first. electron-builder emits ONE of these, never both:
//
//   asar: true   -> Contents/Resources/app.asar          (the packed app)
//                   Contents/Resources/app.asar.unpacked (asarUnpack'd trees;
//                                                         node-pty lives here)
//   asar: false  -> Contents/Resources/app               (the legacy flat tree)
//
// PR #247 flipped `asar: false` -> `asar: true`. This script had the legacy
// path hardcoded, and both chmod passes were `fs.existsSync`-guarded, so from
// that commit on the hook logged "no spawn-helper found … (skipping)" and let
// the build go green with the safety net switched off. That is the exact
// silent-failure mode this file's header forbids.
const RESOURCE_LAYOUTS = ['app.asar.unpacked', 'app'];

function nodeModulesCandidates(appPath) {
  return RESOURCE_LAYOUTS.map((child) =>
    path.join(appPath, 'Contents', 'Resources', child, 'node_modules'),
  );
}

/**
 * Resolve the packaged `node_modules` root, preferring the asar-unpacked
 * layout. Throws if neither layout is present — a pack-shape change must abort
 * the build rather than silently disable the chmod pass below.
 */
function resolveNodeModulesRoot(appPath) {
  const candidates = nodeModulesCandidates(appPath);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `[adhoc-sign] no packaged node_modules root found — the electron-builder ` +
      `pack shape changed and the spawn-helper chmod pass cannot run. Tried:\n` +
      candidates.map((candidate) => `  - ${candidate}`).join('\n'),
  );
}

/**
 * v1.2.4 hotfix — restore +x on POSIX spawn helpers stripped during the pnpm
 * extract / electron-builder pack pipeline. node-pty (and any other dep
 * shipping a `spawn-helper` binary) needs mode 0755 so the runtime
 * `posix_spawn(spawn-helper, …)` call doesn't EACCES; without it EVERY
 * terminal pane fails to open.
 *
 * Callers MUST run this before the codesign sweep — codesign seals the
 * binary's metadata bits, so chmod'ing afterwards invalidates the signature.
 *
 * Returns the absolute paths of every helper it fixed. Throws when the pack
 * ships no helper at all, because that means the pack shape changed again.
 */
function restoreSpawnHelperPermissions(appPath) {
  const nodeModulesRoot = resolveNodeModulesRoot(appPath);

  // Track helpers we've already fixed so the two passes don't double-log.
  const chmodded = [];
  const chmoddedSet = new Set();
  const fixHelper = (helper) => {
    if (chmoddedSet.has(helper)) {
      return;
    }
    fs.chmodSync(helper, 0o755);
    chmoddedSet.add(helper);
    chmodded.push(helper);
    console.log(`[adhoc-sign] chmod 0755 ${path.relative(appPath, helper)}`);
  };

  // (1) Hardcoded node-pty prebuilds — the known offender.
  const nodePtyPrebuilds = path.join(nodeModulesRoot, 'node-pty', 'prebuilds');
  if (fs.existsSync(nodePtyPrebuilds)) {
    const darwinDirs = fs
      .readdirSync(nodePtyPrebuilds, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('darwin-'));
    for (const entry of darwinDirs) {
      const helper = path.join(nodePtyPrebuilds, entry.name, 'spawn-helper');
      if (fs.existsSync(helper)) {
        fixHelper(helper);
      }
    }
    // NO throw here. An empty `prebuilds/` is not proof of a broken pack: a
    // from-source node-pty (npmRebuild: true) puts its helper at
    // build/Release/spawn-helper, which pass 2 below finds. Throwing here would
    // abort a perfectly valid release build. The aggregate check after the
    // recursive sweep is the real gate — it fires only when NO helper exists
    // anywhere, which is the condition we actually care about.
  }

  // (2) Future-proof recursive sweep — any other dep shipping a spawn-helper
  // (including a from-source node-pty, whose helper lands in build/Release
  // rather than prebuilds/). We walk node_modules and chmod every file named
  // `spawn-helper` we find. Symlinks are intentionally ignored to avoid
  // escaping the bundle.
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === 'spawn-helper') {
        fixHelper(full);
      }
    }
  }
  walk(nodeModulesRoot);

  if (chmodded.length === 0) {
    throw new Error(
      `[adhoc-sign] no spawn-helper found anywhere under ${nodeModulesRoot}. ` +
        `A macOS pack MUST ship node-pty's spawn-helper or every terminal pane ` +
        `fails to open with EACCES. Check the electron-builder files/asarUnpack ` +
        `keep-list before shipping.`,
    );
  }

  console.log(`[adhoc-sign] restored +x on ${chmodded.length} spawn-helper(s)`);
  return chmodded;
}

async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const productName = context.packager.appInfo.productFilename; // "SigmaLink"
  const appPath = path.join(context.appOutDir, `${productName}.app`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`[adhoc-sign] expected .app at ${appPath} not found`);
  }

  // MUST precede the codesign sweep below — see the doc comment.
  restoreSpawnHelperPermissions(appPath);

  // The deep, recursive ad-hoc sign. --timestamp=none skips the Apple TSA
  // dial-out (we don't need a trusted timestamp for ad-hoc). Entitlements
  // are intentionally omitted — they only take effect with a trusted
  // identity, and including them here would invite TCC drift.
  //
  // SIGMALINK_SIGN_IDENTITY overrides the ad-hoc "-" for local packaging on
  // a machine that has the self-signed cert from scripts/macos-stable-sign.sh
  // — a stable identity keeps macOS TCC grants (Screen Recording /
  // Accessibility) valid across rebuilds, where ad-hoc pins them to one
  // build's cdhash. CI leaves it unset → ad-hoc, unchanged.
  const identity = process.env.SIGMALINK_SIGN_IDENTITY || '-';
  console.log(
    `[adhoc-sign] codesigning ${appPath} with identity ${
      identity === '-' ? 'ad-hoc' : `"${identity}"`
    }`,
  );
  execFileSync(
    'codesign',
    [
      '--force',
      '--deep',
      '--sign', identity,
      '--timestamp=none',
      appPath,
    ],
    { stdio: 'inherit' },
  );

  // Verify the result. If this fails we want the build to fail.
  console.log(`[adhoc-sign] verifying ${appPath}`);
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' },
  );

  console.log(`[adhoc-sign] ${appPath} signed + verified`);
}

module.exports = adhocSign;
// Named exports for the packaging regression tests
// (src/main/__tests__/adhoc-sign.test.ts) — they exercise root resolution and
// the chmod pass against throwaway bundle fixtures, without running codesign.
module.exports.resolveNodeModulesRoot = resolveNodeModulesRoot;
module.exports.restoreSpawnHelperPermissions = restoreSpawnHelperPermissions;
