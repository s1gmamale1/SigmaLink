// BridgeVoice — ad-hoc codesign sweep (electron-builder afterSign hook).
//
// Mirrors app/scripts/adhoc-sign.cjs exactly.  Separated into bridge-voice's
// own scripts/ so that the bridge-voice electron-builder config is
// self-contained and does not reach outside its own app directory.
//
// See app/scripts/adhoc-sign.cjs for the detailed rationale.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const productName = context.packager.appInfo.productFilename; // "BridgeVoice"
  const appPath = path.join(context.appOutDir, `${productName}.app`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`[adhoc-sign] expected .app at ${appPath} not found`);
  }

  // Restore +x on POSIX spawn helpers stripped during the pnpm extract /
  // electron-builder pack pipeline.  Must happen before codesign.
  const appRoot = path.join(appPath, 'Contents', 'Resources', 'app');
  const nodeModulesRoot = path.join(appRoot, 'node_modules');

  const chmoddedSet = new Set();
  const fixHelper = (helper) => {
    if (chmoddedSet.has(helper)) return;
    fs.chmodSync(helper, 0o755);
    chmoddedSet.add(helper);
    console.log(`[adhoc-sign] chmod 0755 ${path.relative(appPath, helper)}`);
  };

  // node-pty prebuilds (present if voice-mac uses it as a transitive dep).
  const nodePtyPrebuilds = path.join(nodeModulesRoot, 'node-pty', 'prebuilds');
  if (fs.existsSync(nodePtyPrebuilds)) {
    for (const entry of fs.readdirSync(nodePtyPrebuilds, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('darwin-')) continue;
      const helper = path.join(nodePtyPrebuilds, entry.name, 'spawn-helper');
      if (fs.existsSync(helper)) fixHelper(helper);
    }
  }

  // Recursive sweep for any other dep shipping a spawn-helper.
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'spawn-helper') fixHelper(full);
    }
  }
  if (fs.existsSync(nodeModulesRoot)) walk(nodeModulesRoot);

  console.log(`[adhoc-sign] codesigning ${appPath} ad-hoc`);
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' },
  );

  console.log(`[adhoc-sign] verifying ${appPath}`);
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' },
  );

  console.log(`[adhoc-sign] ${appPath} signed + verified`);
};
