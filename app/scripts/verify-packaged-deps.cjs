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
 * Resolve `@electron/asar` through electron-builder's own dependency chain.
 *
 * Under pnpm's strict layout that package is not hoisted into
 * `app/node_modules`, so it cannot be required by bare name. Returns null when
 * the chain has changed shape — every caller then degrades to a path that
 * cannot false-FAIL.
 */
let asarLib;
function resolveAsarLib() {
  if (asarLib !== undefined) return asarLib;
  try {
    const builder = require.resolve('electron-builder/package.json', { paths: [__dirname] });
    const lib = require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builder)] });
    asarLib = require(require.resolve('@electron/asar', { paths: [path.dirname(lib)] }));
  } catch {
    asarLib = null;
  }
  return asarLib;
}

/**
 * Every package RESOLUTION PATH contained in one archive entry path.
 *
 * `node_modules/@sigmalink/voice-whisper/node_modules/node-gyp-build/index.js`
 * yields both `node_modules/@sigmalink/voice-whisper` and the full nested
 * `…/node_modules/node-gyp-build` — the position matters, because Node resolves
 * upward only and a nested copy is reachable from its owner alone (C-064).
 *
 * The terminator MUST be a lookahead. A consuming `(?:\/|$)` eats the separator
 * that the next iteration's `(?:^|\/)` needs, so matchAll yields only the
 * outermost package and the nested one stays shadowed.
 *
 * @param {string} entryPath forward-slashed, un-rooted archive entry path
 * @returns {string[]} package paths, outermost first
 */
function packagePathsIn(entryPath) {
  const found = [];
  for (const match of entryPath.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?=\/|$)/g)) {
    // listPackage enumerates directories too, so a scope root arrives on its
    // own as `node_modules/@scope`. That is not a package — skip it.
    if (match[1].startsWith('@') && !match[1].includes('/')) {
      continue;
    }
    found.push(entryPath.slice(0, match.index + match[0].length).replace(/^\//, ''));
  }
  return found;
}

/**
 * Split a package path into its owning package (null at top level) and name.
 *
 * @param {string} packagePath e.g. `node_modules/@a/b/node_modules/c`
 * @returns {{ ownerPath: string | null, name: string }}
 */
function splitPackagePath(packagePath) {
  const marker = '/node_modules/';
  const idx = packagePath.lastIndexOf(marker);
  if (idx < 0) {
    return { ownerPath: null, name: packagePath.slice('node_modules/'.length) };
  }
  return {
    ownerPath: packagePath.slice(0, idx),
    name: packagePath.slice(idx + marker.length),
  };
}

/**
 * Read every package resolution path out of an asar archive.
 *
 * Prefers `@electron/asar` (authoritative); falls back to reading the archive's
 * header directly — an asar is an 8-byte size prologue followed by a JSON
 * directory, so this stays dependency-free and cannot silently degrade into a
 * blind pass.
 *
 * @param {string} archive absolute path to app.asar
 * @returns {Set<string>} package paths (empty when the archive is absent — an
 *   unpacked `asar: false` build)
 */
function listAsarNodeModulePaths(archive) {
  if (!fs.existsSync(archive)) {
    return new Set();
  }
  const viaLibrary = listAsarNodeModulePathsViaLibrary(archive);
  if (viaLibrary) {
    return viaLibrary;
  }
  return listAsarNodeModulePathsViaHeader(archive);
}

function listAsarNodeModulePathsViaLibrary(archive) {
  const asar = resolveAsarLib();
  if (!asar) return null;
  try {
    const paths = new Set();
    for (const entry of asar.listPackage(archive)) {
      const normalised = String(entry).replace(/\\/g, '/').replace(/^\//, '');
      for (const packagePath of packagePathsIn(normalised)) {
        paths.add(packagePath);
      }
    }
    return paths;
  } catch {
    return null;
  }
}

function listAsarNodeModulePathsViaHeader(archive) {
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

    const paths = new Set();
    // Recurse: a transitive dep of a workspace package is packed NESTED, at
    // node_modules/<owner>/node_modules/<pkg>, which is precisely where Node's
    // resolver finds it. A top-level-only walk reports it missing and would
    // fail every release build on a false alarm.
    const collect = (dirEntry, prefix) => {
      const nodeModules = dirEntry?.files?.node_modules?.files;
      for (const name of Object.keys(nodeModules ?? {})) {
        const child = nodeModules[name];
        if (name.startsWith('@')) {
          for (const scoped of Object.keys(child?.files ?? {})) {
            const packagePath = `${prefix}node_modules/${name}/${scoped}`;
            paths.add(packagePath);
            collect(child.files[scoped], `${packagePath}/`);
          }
        } else {
          const packagePath = `${prefix}node_modules/${name}`;
          paths.add(packagePath);
          collect(child, `${packagePath}/`);
        }
      }
    };
    collect(parsed, '');
    return paths;
  } finally {
    fs.closeSync(fd);
  }
}

/** Package NAMES at any depth. Kept for the existing public surface. */
function namesFromPackagePaths(paths) {
  const names = new Set();
  for (const packagePath of paths) {
    names.add(splitPackagePath(packagePath).name);
  }
  return names;
}

function listAsarNodeModules(archive) {
  return namesFromPackagePaths(listAsarNodeModulePaths(archive));
}

function listAsarNodeModulesViaHeader(archive) {
  return namesFromPackagePaths(listAsarNodeModulePathsViaHeader(archive));
}

/**
 * True when `manifest` declares `name` in any dependency bucket.
 *
 * All four buckets count. The threat this guards against (C-064) is a NESTED
 * directory that merely SHARES a keep-list name — a vendored test fixture,
 * a leftover — and such a directory is declared nowhere. Being generous about
 * which bucket counts therefore costs nothing and keeps the guard away from
 * false-failing a release on an unusual-but-real layout.
 */
function declaresDependency(manifest, name) {
  if (!manifest || typeof manifest !== 'object') return false;
  for (const bucket of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ]) {
    const deps = manifest[bucket];
    if (deps && typeof deps === 'object' && Object.prototype.hasOwnProperty.call(deps, name)) {
      return true;
    }
  }
  return false;
}

/**
 * Does a nested copy owned by this manifest actually satisfy `name`?
 *
 * A manifest we could not read (`null`) returns TRUE. This hook runs as
 * `afterPack` on every release build, so a false-FAIL aborts a release — when
 * we cannot prove the nested copy is unreachable, we must not claim it is.
 */
function ownerCanResolve(manifest, name) {
  return manifest === null ? true : declaresDependency(manifest, name);
}

function readDiskManifest(packageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readAsarManifest(archive, packagePath) {
  const asar = resolveAsarLib();
  if (!asar || typeof asar.extractFile !== 'function') return null;
  try {
    return JSON.parse(String(asar.extractFile(archive, `${packagePath}/package.json`)));
  } catch {
    return null;
  }
}

/** Package directory names directly under a node_modules root, scopes expanded. */
function packageDirNamesIn(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      let scoped;
      try {
        scoped = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const pkg of scoped) {
        if (pkg.isDirectory()) names.push(`${entry.name}/${pkg.name}`);
      }
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

/**
 * Is `name` reachable from somewhere BELOW `root` — i.e. nested inside another
 * package's own `node_modules`?
 *
 * Node resolves UPWARD only, so `node_modules/A` requiring `foo` never sees
 * `node_modules/B/node_modules/foo`. A nested copy therefore counts only for
 * its own owner, and only when that owner declares the dep. Recurses, applying
 * the same rule at every level, so a legitimately deep transitive chain still
 * passes.
 */
function resolvableUnderOwners(root, name) {
  for (const owner of packageDirNamesIn(root)) {
    const ownerDir = path.join(root, owner);
    const nested = path.join(ownerDir, 'node_modules');
    if (!fs.existsSync(nested)) continue;
    if (
      fs.existsSync(path.join(nested, name)) &&
      ownerCanResolve(readDiskManifest(ownerDir), name)
    ) {
      return true;
    }
    if (resolvableUnderOwners(nested, name)) return true;
  }
  return false;
}

/**
 * Return the keep-list modules that are not RESOLVABLE in the packed output.
 *
 * C-064 — this used to accept a hit at any depth by name alone, which could
 * false-PASS: a top-level copy vanishing while an unrelated nested one remained,
 * or a shipped package carrying a fixture directory named after a keep-list
 * entry, both read as present. Presence is now judged the way Node's resolver
 * judges it: top level anywhere, or nested under an owner that declares the dep.
 *
 * @param {string} resourcesDir the packed app's Resources dir
 * @param {string[]} modules keep-list package names
 * @returns {string[]} unresolvable package names (empty when all present)
 */
function findMissingModules(resourcesDir, modules) {
  const diskRoots = [
    path.join(resourcesDir, 'app.asar.unpacked', 'node_modules'),
    path.join(resourcesDir, 'app', 'node_modules'),
  ];
  const archive = path.join(resourcesDir, 'app.asar');

  const asarTopLevel = new Set();
  /** @type {Map<string, Set<string>>} package name → owning package paths */
  const asarNestedOwners = new Map();
  for (const packagePath of listAsarNodeModulePaths(archive)) {
    const { ownerPath, name } = splitPackagePath(packagePath);
    if (ownerPath === null) {
      asarTopLevel.add(name);
      continue;
    }
    let owners = asarNestedOwners.get(name);
    if (!owners) {
      owners = new Set();
      asarNestedOwners.set(name, owners);
    }
    owners.add(ownerPath);
  }

  const resolvable = (name) => {
    if (asarTopLevel.has(name)) return true;
    if (diskRoots.some((root) => fs.existsSync(path.join(root, name)))) return true;
    for (const ownerPath of asarNestedOwners.get(name) ?? []) {
      if (ownerCanResolve(readAsarManifest(archive, ownerPath), name)) return true;
    }
    return diskRoots.some((root) => resolvableUnderOwners(root, name));
  };

  return modules.filter((name) => !resolvable(name));
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
    // Name exactly what was missing AND every location searched: this aborts a
    // release build, so the operator must be able to tell a genuine drift from
    // a guard that looked in the wrong place.
    const searched = [
      `  app.asar                        node_modules/<pkg>  (top level)`,
      `  app.asar                        <owner>/node_modules/<pkg>  (only when <owner>'s package.json declares it)`,
      `  app.asar.unpacked/node_modules  <pkg>  (top level)`,
      `  app.asar.unpacked/node_modules  <owner>/node_modules/<pkg>  (only when <owner>'s package.json declares it)`,
      `  app/node_modules                <pkg>  (top level, legacy unpacked tree)`,
      `  app/node_modules                <owner>/node_modules/<pkg>  (only when <owner>'s package.json declares it)`,
    ].join('\n');
    throw new Error(
      `[verify-packaged-deps] ${missing.length} keep-list module(s) are not resolvable ` +
        `in the packed app at ${resourcesDir}:\n` +
        missing.map((name) => `  - node_modules/${name}`).join('\n') +
        `\nSearched, relative to ${resourcesDir}:\n${searched}\n` +
        `A copy nested inside a package that does NOT declare it does not count — ` +
        `Node resolves upward only, so it would be unreachable at runtime.\n` +
        `The electron-builder \`files\` keep-list and the resolved dependency ` +
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
// C-064 — the position-aware surface. `listAsarNodeModules` flattens to names
// and so cannot express "top level vs nested under owner X"; the resolvability
// rule needs the paths.
module.exports.listAsarNodeModulePaths = listAsarNodeModulePaths;
module.exports.splitPackagePath = splitPackagePath;
