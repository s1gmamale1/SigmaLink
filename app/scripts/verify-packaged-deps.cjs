// Post-pack keep-list verification, run as electron-builder's `afterPack` hook.
//
// Why this exists: `app/pnpm-lock.yaml` is gitignored and every release
// workflow installs with `--no-frozen-lockfile`, so each release resolves its
// dependency tree fresh. Before PR #247 that was harmless — `asar: false`
// shipped the whole resolved `node_modules`, so whatever a transitive bump
// pulled in came along for the ride.
//
// PR #247 replaced that with `'!node_modules/**/*'` plus an explicit
// per-package keep-list. The keep-list is now a hand-maintained mirror of the
// real native-module graph, and nothing checks the two still agree. A patch
// bump that swaps a native helper (the classic case: `bindings` giving way to
// `node-gyp-build`) drops it from the package silently; electron-builder is
// happy, CI is green, and the app throws `Cannot find module` at the user's
// first `new Database()`.
//
// What this does: for every `node_modules/<pkg>/**` entry in the resolved
// electron-builder `files:` keep-list, assert the package actually landed in
// the packed output — either unpacked on disk (`app.asar.unpacked/`, the
// legacy `app/` tree) or inside `app.asar`. Any miss throws, which aborts the
// build. It deliberately verifies the OUTPUT rather than the input config: the
// keep-list saying `node_modules/bindings/**/*` proves nothing if `bindings`
// is no longer in the tree to be matched.
//
// Inputs from electron-builder's afterPack contract:
//   context.appOutDir   absolute path to the packed app directory
//   context.packager    platform packager (gives us resources dir + config)
//
// Runs on every platform — Windows and Linux packaged native resolution is
// exactly the surface the 2026-07-28 package audit left unverified.

const path = require('node:path');
const fs = require('node:fs');

/**
 * Extract the concrete `node_modules/<pkg>` keep-list from an electron-builder
 * `files:` array.
 *
 * Skips negations (`!node_modules/**` — the prune that makes the keep-list
 * necessary), non-node_modules entries, and wildcard package segments
 * (`node_modules/**\/*`), none of which name a package we can assert on.
 * Handles scoped packages.
 *
 * @param {unknown} files resolved electron-builder `files` config
 * @returns {string[]} unique package names, e.g. ['better-sqlite3', '@scope/x']
 */
function keepListModules(files) {
  const entries = Array.isArray(files) ? files : [files];
  const found = new Set();

  for (const entry of entries) {
    /** @type {string[]} */
    let patterns = [];
    if (typeof entry === 'string') {
      patterns = [entry];
    } else if (entry && typeof entry === 'object' && !entry.from) {
      // A FileSet with no `from` is still rooted at the app dir. One with a
      // `from` points somewhere else entirely, so its paths are not the app's
      // node_modules and must not be asserted here.
      const filter = entry.filter;
      patterns = typeof filter === 'string' ? [filter] : Array.isArray(filter) ? filter : [];
    }

    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || pattern.startsWith('!')) {
        continue;
      }
      const match = /^node_modules\/((?:@[^/*]+\/)?[^/*]+)(?:\/|$)/.exec(pattern.trim());
      if (match) {
        found.add(match[1]);
      }
    }
  }

  return [...found];
}

/**
 * Read the top-level `node_modules/*` entries out of an asar archive.
 *
 * Prefers `@electron/asar` (authoritative). Under pnpm's strict layout that
 * package is not hoisted into `app/node_modules`, so it is resolved through
 * electron-builder's own dependency chain rather than by bare name. If that
 * chain ever changes shape we fall back to reading the archive's header
 * directly — an asar is a 8-byte size prologue followed by a JSON directory,
 * so this stays dependency-free and cannot silently degrade into a blind pass.
 *
 * @param {string} archive absolute path to app.asar
 * @returns {Set<string>} package names present under node_modules (empty when
 *   the archive is absent — an unpacked `asar: false` build)
 */
function listAsarNodeModules(archive) {
  if (!fs.existsSync(archive)) {
    return new Set();
  }

  const viaLibrary = listAsarNodeModulesViaLibrary(archive);
  if (viaLibrary) {
    return viaLibrary;
  }
  return listAsarNodeModulesViaHeader(archive);
}

function listAsarNodeModulesViaLibrary(archive) {
  let asar;
  try {
    const builder = require.resolve('electron-builder/package.json', { paths: [__dirname] });
    const lib = require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builder)] });
    asar = require(require.resolve('@electron/asar', { paths: [path.dirname(lib)] }));
  } catch {
    return null;
  }

  try {
    const names = new Set();
    for (const entry of asar.listPackage(archive)) {
      const normalised = String(entry).replace(/\\/g, '/').replace(/^\//, '');
      // Match a package at ANY depth, not just top level. A transitive dep of a
      // workspace package is packed NESTED — e.g. node-gyp-build lands at
      // node_modules/@sigmalink/voice-whisper/node_modules/node-gyp-build, which
      // is exactly where Node's resolver finds it when voice-whisper/index.js
      // calls require('node-gyp-build'). Anchoring to ^node_modules/ reported
      // that as missing and would have failed every release build on a false
      // alarm.
      // ALL matches, not just the first: in
      // node_modules/@sigmalink/voice-whisper/node_modules/node-gyp-build/...
      // the leading match is the parent, and a first-match-only scan would
      // shadow the nested package we are actually looking for.
      // The terminator MUST be a lookahead. A consuming `(?:\/|$)` eats the
      // separator that the next iteration's `(?:^|\/)` needs, so matchAll
      // yields only the outermost package and the nested one stays shadowed —
      // the exact bug this loop exists to avoid. Verified by execution:
      //   consuming  → ['@sigmalink/voice-whisper']
      //   lookahead  → ['@sigmalink/voice-whisper', 'node-gyp-build']
      for (const match of normalised.matchAll(
        /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?=\/|$)/g,
      )) {
        // listPackage enumerates directories too, so a scope root arrives on
        // its own as `node_modules/@scope`. That is not a package — skip it.
        if (match[1].startsWith('@') && !match[1].includes('/')) {
          continue;
        }
        names.add(match[1]);
      }
      continue;
    }
    return names;
  } catch {
    return null;
  }
}

function listAsarNodeModulesViaHeader(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    // asar wraps its header in two Chromium "pickle" frames. Each frame is
    // [UInt32LE payloadSize][payload], and a pickled string is itself
    // [UInt32LE length][bytes][padding to 4]. So:
    //   bytes 0..3  outer payload size (always 4)
    //   bytes 4..7  size of the header frame that follows
    //   header 0..3 header payload size
    //   header 4..7 JSON byte length
    //   header 8..  the JSON directory
    const prologue = Buffer.alloc(8);
    fs.readSync(fd, prologue, 0, 8, 0);
    const headerSize = prologue.readUInt32LE(4);
    const header = Buffer.alloc(headerSize);
    fs.readSync(fd, header, 0, headerSize, 8);
    const jsonLength = header.readUInt32LE(4);
    const parsed = JSON.parse(header.toString('utf8', 8, 8 + jsonLength));

    const names = new Set();
    // Recurse: a transitive dep of a workspace package is packed NESTED, at
    // node_modules/<owner>/node_modules/<pkg>, which is precisely where Node's
    // resolver finds it. A top-level-only walk reports it missing and would
    // fail every release build on a false alarm.
    const collect = (dirEntry) => {
      const nodeModules = dirEntry?.files?.node_modules?.files;
      for (const name of Object.keys(nodeModules ?? {})) {
        const child = nodeModules[name];
        if (name.startsWith('@')) {
          for (const scoped of Object.keys(child?.files ?? {})) {
            names.add(`${name}/${scoped}`);
            collect(child.files[scoped]);
          }
        } else {
          names.add(name);
          collect(child);
        }
      }
    };
    collect(parsed);
    return names;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Return the keep-list modules that did NOT make it into the packed output.
 *
 * @param {string} resourcesDir the packed app's Resources dir
 * @param {string[]} modules keep-list package names
 * @returns {string[]} missing package names (empty when all present)
 */
function findMissingModules(resourcesDir, modules) {
  const diskRoots = [
    path.join(resourcesDir, 'app.asar.unpacked', 'node_modules'),
    path.join(resourcesDir, 'app', 'node_modules'),
  ];
  const inAsar = listAsarNodeModules(path.join(resourcesDir, 'app.asar'));

  /** True when `name` exists under `root` at ANY depth — top level, or nested
   *  inside another package's own node_modules (where Node resolves a
   *  workspace package's transitive deps from). */
  const onDiskAnyDepth = (root, name) => {
    if (fs.existsSync(path.join(root, name))) {
      return true;
    }
    let owners;
    try {
      owners = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const owner of owners) {
      if (!owner.isDirectory()) continue;
      const nested = owner.name.startsWith('@')
        ? path.join(root, owner.name)
        : path.join(root, owner.name, 'node_modules');
      if (owner.name.startsWith('@')) {
        // Scope dir: descend one more level to each scoped package.
        let scoped;
        try {
          scoped = fs.readdirSync(nested, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const pkg of scoped) {
          if (!pkg.isDirectory()) continue;
          if (onDiskAnyDepth(path.join(nested, pkg.name, 'node_modules'), name)) {
            return true;
          }
        }
        continue;
      }
      if (fs.existsSync(nested) && onDiskAnyDepth(nested, name)) {
        return true;
      }
    }
    return false;
  };

  return modules.filter((name) => {
    if (inAsar.has(name)) {
      return false;
    }
    return !diskRoots.some((root) => onDiskAnyDepth(root, name));
  });
}

/** Resolve the packed Resources dir, tolerating a packager without the helper. */
function resolveResourcesDir(context) {
  const { appOutDir, packager } = context;
  if (packager && typeof packager.getResourcesDir === 'function') {
    return packager.getResourcesDir(appOutDir);
  }
  // Fallback mirrors app-builder-lib: mac nests under the .app, others don't.
  const productFilename = packager?.appInfo?.productFilename;
  if (context.electronPlatformName === 'darwin' && productFilename) {
    return path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

async function verifyPackagedDeps(context) {
  const resourcesDir = resolveResourcesDir(context);
  const files = context.packager?.config?.files;
  const modules = keepListModules(files);

  if (modules.length === 0) {
    throw new Error(
      `[verify-packaged-deps] resolved no node_modules keep-list from the ` +
        `electron-builder \`files\` config, so nothing could be verified. ` +
        `Either the keep-list was removed or this hook can no longer read the ` +
        `config — both leave the pack unguarded. Refusing to pass silently.`,
    );
  }

  const missing = findMissingModules(resourcesDir, modules);
  if (missing.length > 0) {
    throw new Error(
      `[verify-packaged-deps] ${missing.length} keep-list module(s) are missing ` +
        `from the packed app at ${resourcesDir}:\n` +
        missing.map((name) => `  - node_modules/${name}`).join('\n') +
        `\nThe electron-builder \`files\` keep-list and the resolved dependency ` +
        `tree have drifted (installs run with --no-frozen-lockfile). The app ` +
        `would throw "Cannot find module" at runtime. Update the keep-list in ` +
        `electron-builder.yml to match the current tree.`,
    );
  }

  console.log(
    `[verify-packaged-deps] ${modules.length} keep-list module(s) present in ${resourcesDir}`,
  );
}

module.exports = verifyPackagedDeps;
// Named exports for scripts' regression tests
// (src/main/__tests__/verify-packaged-deps.test.ts).
module.exports.keepListModules = keepListModules;
module.exports.listAsarNodeModules = listAsarNodeModules;
module.exports.findMissingModules = findMissingModules;
// Exported so the dependency-free fallback is covered too — an untested
// fallback is how a gate quietly becomes a blind pass.
module.exports.listAsarNodeModulesViaHeader = listAsarNodeModulesViaHeader;
