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

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const productName = context.packager.appInfo.productFilename; // "SigmaLink"
  const appPath = path.join(context.appOutDir, `${productName}.app`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`[adhoc-sign] expected .app at ${appPath} not found`);
  }

  // v1.2.4 hotfix — restore +x on POSIX spawn helpers stripped during the
  // pnpm extract / electron-builder pack pipeline. node-pty (and any other
  // dep shipping a `spawn-helper` binary) needs mode 0755 so the runtime
  // `posix_spawn(spawn-helper, …)` call doesn't EACCES. This MUST happen
  // before the codesign sweep below — codesign re-seals after the binary's
  // metadata bits, so chmod'ing after would invalidate the signature.
  const appRoot = path.join(appPath, 'Contents', 'Resources', 'app');
  const nodeModulesRoot = path.join(appRoot, 'node_modules');

  // Track helpers we've already fixed so the two passes don't double-log.
  const chmoddedSet = new Set();
  const fixHelper = (helper) => {
    if (chmoddedSet.has(helper)) {
      return;
    }
    fs.chmodSync(helper, 0o755);
    chmoddedSet.add(helper);
    console.log(`[adhoc-sign] chmod 0755 ${path.relative(appPath, helper)}`);
  };

  // (1) Hardcoded node-pty prebuilds — the known offender.
  const nodePtyPrebuilds = path.join(nodeModulesRoot, 'node-pty', 'prebuilds');
  if (fs.existsSync(nodePtyPrebuilds)) {
    for (const entry of fs.readdirSync(nodePtyPrebuilds, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('darwin-')) {
        continue;
      }
      const helper = path.join(nodePtyPrebuilds, entry.name, 'spawn-helper');
      if (fs.existsSync(helper)) {
        fixHelper(helper);
      } else {
        console.log(`[adhoc-sign] no spawn-helper found at ${helper} (skipping)`);
      }
    }
  } else {
    console.log(`[adhoc-sign] no spawn-helper found at ${nodePtyPrebuilds} (skipping)`);
  }

  // (2) Future-proof recursive sweep — any other dep shipping a spawn-helper.
  // We walk node_modules and chmod every file named `spawn-helper` we find.
  // Symlinks are intentionally ignored to avoid escaping the bundle.
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
  if (fs.existsSync(nodeModulesRoot)) {
    const before = chmoddedSet.size;
    walk(nodeModulesRoot);
    if (chmoddedSet.size === before) {
      console.log(`[adhoc-sign] no additional spawn-helper found under ${nodeModulesRoot} (skipping)`);
    }
  } else {
    console.log(`[adhoc-sign] no spawn-helper found at ${nodeModulesRoot} (skipping)`);
  }

  // The deep, recursive ad-hoc sign. --timestamp=none skips the Apple TSA
  // dial-out (we don't need a trusted timestamp for ad-hoc). Entitlements
  // are intentionally omitted — they only take effect with a trusted
  // identity, and including them here would invite TCC drift.
  console.log(`[adhoc-sign] codesigning ${appPath} ad-hoc`);
  execFileSync(
    'codesign',
    [
      '--force',
      '--deep',
      '--sign', '-',
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
};
