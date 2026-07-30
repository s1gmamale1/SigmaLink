// Regression tests for scripts/verify-packaged-deps.cjs, the electron-builder
// `afterPack` gate that asserts every `node_modules/<pkg>` keep-list entry
// actually landed in the packed output.
//
// Placed under src/main/__tests__ for the same reason as adhoc-sign.test.ts:
// vitest.config.ts does not sweep scripts/, and tsconfig.main.json only
// typechecks src/main — here the file sits inside BOTH gates.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type VerifyModule = {
  keepListModules: (files: unknown) => string[];
  listAsarNodeModules: (archive: string) => Set<string>;
  listAsarNodeModulesViaHeader: (archive: string) => Set<string>;
  listAsarNodeModulePaths: (archive: string) => Set<string>;
  splitPackagePath: (packagePath: string) => { ownerPath: string | null; name: string };
  findMissingModules: (resourcesDir: string, modules: string[]) => string[];
};

const requireCJS = createRequire(import.meta.url);
const verify = requireCJS('../../../scripts/verify-packaged-deps.cjs') as VerifyModule;

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const tempRoots: string[] = [];

function makeTempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-packaged-deps-'));
  tempRoots.push(root);
  return root;
}

/** Materialise `<resources>/<child>/node_modules/<pkg>/package.json`. */
function makePackedModule(resourcesDir: string, child: string, pkg: string): void {
  const dir = path.join(resourcesDir, child, 'node_modules', pkg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg }));
}

/**
 * Materialise `<resources>/<child>/node_modules/<owner>/node_modules/<pkg>`,
 * with `<owner>`'s manifest either declaring `<pkg>` (a genuine transitive dep —
 * the real `@sigmalink/voice-whisper` → `node-gyp-build` shape) or not (a
 * vendored fixture that merely shares the name and is unreachable from anywhere).
 */
function makeNestedPackedModule(
  resourcesDir: string,
  child: string,
  owner: string,
  pkg: string,
  opts: { declared: boolean },
): void {
  const ownerDir = path.join(resourcesDir, child, 'node_modules', owner);
  const nested = path.join(ownerDir, 'node_modules', pkg);
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(
    path.join(ownerDir, 'package.json'),
    JSON.stringify({
      name: owner,
      ...(opts.declared ? { dependencies: { [pkg]: '^4.0.0' } } : {}),
    }),
  );
  fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: pkg }));
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('keepListModules', () => {
  it('extracts plain and scoped packages, skipping negations and non-modules', () => {
    const files = [
      'dist/**/*',
      'electron-dist/**/*',
      'package.json',
      '!node_modules/**/*',
      'node_modules/better-sqlite3/**/*',
      'node_modules/@sigmalink/voice-whisper/**/*',
      'node_modules/node-gyp-build/**/*',
    ];

    expect(verify.keepListModules(files).sort()).toEqual([
      '@sigmalink/voice-whisper',
      'better-sqlite3',
      'node-gyp-build',
    ]);
  });

  it('ignores a wildcard package segment, which names no concrete package', () => {
    expect(verify.keepListModules(['node_modules/**/*'])).toEqual([]);
  });

  it('deduplicates repeated entries for the same package', () => {
    expect(
      verify.keepListModules(['node_modules/node-pty/**/*', 'node_modules/node-pty/build/**']),
    ).toEqual(['node-pty']);
  });

  it('reads a FileSet filter but ignores one rooted elsewhere via `from`', () => {
    expect(verify.keepListModules([{ filter: ['node_modules/bindings/**/*'] }])).toEqual([
      'bindings',
    ]);
    expect(
      verify.keepListModules([{ from: '../elsewhere', filter: ['node_modules/ghost/**/*'] }]),
    ).toEqual([]);
  });

  it('covers every node_modules keep-list line in the live electron-builder.yml', () => {
    // Parity guard: the hook must actually see the real config's keep-list, not
    // just a hand-written fixture. Reads the yml as text so no YAML parser is
    // pulled into the test.
    const yml = fs.readFileSync(path.join(appRoot, 'electron-builder.yml'), 'utf8');
    // Negated entries (`!node_modules/**/*`) never match — the `'?` is followed
    // by a required literal `node_modules`, and `!` is not it.
    const declared = [...yml.matchAll(/^\s*-\s*'?(node_modules\/[^'\s]+)'?\s*$/gm)].map(
      (match) => match[1],
    );

    const extracted = verify.keepListModules(declared);

    expect(declared.length).toBeGreaterThan(0);
    expect(extracted).toContain('better-sqlite3');
    expect(extracted).toContain('node-pty');
    expect(extracted).toContain('@sigmalink/voice-whisper');
    // Every declared concrete entry must resolve to a package name.
    for (const pattern of declared) {
      if (pattern.startsWith('node_modules/**')) continue;
      const name = pattern.replace(/^node_modules\//, '').split('/**')[0];
      expect(extracted).toContain(name);
    }
  });
});

describe('findMissingModules', () => {
  it('accepts modules unpacked beside the asar', () => {
    const resources = makeTempDir();
    makePackedModule(resources, 'app.asar.unpacked', 'better-sqlite3');

    expect(verify.findMissingModules(resources, ['better-sqlite3'])).toEqual([]);
  });

  it('accepts modules in the legacy unpacked app tree', () => {
    const resources = makeTempDir();
    makePackedModule(resources, 'app', 'node-pty');

    expect(verify.findMissingModules(resources, ['node-pty'])).toEqual([]);
  });

  it('accepts scoped modules', () => {
    const resources = makeTempDir();
    makePackedModule(resources, 'app.asar.unpacked', '@sigmalink/voice-whisper');

    expect(verify.findMissingModules(resources, ['@sigmalink/voice-whisper'])).toEqual([]);
  });

  it('reports every module absent from the packed output', () => {
    const resources = makeTempDir();
    makePackedModule(resources, 'app.asar.unpacked', 'better-sqlite3');

    expect(
      verify.findMissingModules(resources, ['better-sqlite3', 'bindings', 'node-gyp-build']).sort(),
    ).toEqual(['bindings', 'node-gyp-build']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C-064 — presence-by-name is not resolvability.
//
// Node resolves UPWARD only, so `node_modules/A` requiring `foo` never finds
// `node_modules/B/node_modules/foo`. The old guard accepted a hit at ANY depth,
// so a top-level copy vanishing while an unrelated nested one remained — or a
// shipped package carrying a test fixture directory named after a keep-list
// entry — read as present, and the app threw "Cannot find module" at the user's
// first call. That is a false-PASS: the guard could mask a genuinely missing
// module.
//
// The counterweight is that this hook aborts release builds, so it must never
// false-FAIL: a legitimately nested transitive dep of a workspace package (the
// real `@sigmalink/voice-whisper` → `node-gyp-build` shape) has to keep passing.
// ─────────────────────────────────────────────────────────────────────────────

describe('findMissingModules — resolvability, not presence-by-name (C-064)', () => {
  it('reports MISSING when only a nested copy exists and its owner does not declare it', () => {
    const resources = makeTempDir();
    // `some-vendor` ships a fixture directory that happens to be called
    // `node_modules/node-gyp-build`. Nothing can require it. The genuine
    // top-level copy is gone.
    makeNestedPackedModule(resources, 'app.asar.unpacked', 'some-vendor', 'node-gyp-build', {
      declared: false,
    });

    expect(verify.findMissingModules(resources, ['node-gyp-build'])).toEqual(['node-gyp-build']);
  });

  it('PASSES a genuine nested transitive dep of a workspace package', () => {
    const resources = makeTempDir();
    // The real shape: voice-whisper declares node-gyp-build, and pnpm packed it
    // nested — precisely where voice-whisper/index.js resolves it from.
    makeNestedPackedModule(
      resources,
      'app.asar.unpacked',
      '@sigmalink/voice-whisper',
      'node-gyp-build',
      { declared: true },
    );

    expect(
      verify.findMissingModules(resources, ['@sigmalink/voice-whisper', 'node-gyp-build']),
    ).toEqual([]);
  });

  it('PASSES a top-level copy even when an undeclared nested namesake also exists', () => {
    const resources = makeTempDir();
    makePackedModule(resources, 'app.asar.unpacked', 'node-gyp-build');
    makeNestedPackedModule(resources, 'app.asar.unpacked', 'some-vendor', 'node-gyp-build', {
      declared: false,
    });

    expect(verify.findMissingModules(resources, ['node-gyp-build'])).toEqual([]);
  });

  it('PASSES a declared dep nested two owners deep', () => {
    const resources = makeTempDir();
    // node_modules/a/node_modules/b/node_modules/c, with b declaring c.
    const root = path.join(resources, 'app.asar.unpacked', 'node_modules');
    const bDir = path.join(root, 'a', 'node_modules', 'b');
    fs.mkdirSync(path.join(bDir, 'node_modules', 'c'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'package.json'), JSON.stringify({ name: 'a' }));
    fs.writeFileSync(
      path.join(bDir, 'package.json'),
      JSON.stringify({ name: 'b', dependencies: { c: '^1.0.0' } }),
    );
    fs.writeFileSync(path.join(bDir, 'node_modules', 'c', 'package.json'), JSON.stringify({ name: 'c' }));

    expect(verify.findMissingModules(resources, ['c'])).toEqual([]);
  });

  it('accepts a nested copy whose owner manifest is unreadable — the guard must never false-FAIL', () => {
    const resources = makeTempDir();
    const ownerDir = path.join(resources, 'app.asar.unpacked', 'node_modules', 'weird-owner');
    fs.mkdirSync(path.join(ownerDir, 'node_modules', 'node-gyp-build'), { recursive: true });
    // No owner package.json at all: we cannot prove the nested copy is
    // unreachable, so we must not abort a release over it.

    expect(verify.findMissingModules(resources, ['node-gyp-build'])).toEqual([]);
  });
});

describe('asar inspection', () => {
  /**
   * Build a real app.asar with @electron/asar, resolved via electron-builder.
   *
   * `packages` entries may be nested paths (`@scope/owner/node_modules/dep`).
   * `manifests` optionally supplies each package's package.json, keyed by the
   * same string — needed by the C-064 owner-declaration checks.
   */
  async function buildAsar(
    resourcesDir: string,
    packages: string[],
    manifests: Record<string, unknown> = {},
  ): Promise<string> {
    const builder = requireCJS.resolve('electron-builder/package.json');
    const lib = requireCJS.resolve('app-builder-lib/package.json', {
      paths: [path.dirname(builder)],
    });
    const asar = requireCJS(
      requireCJS.resolve('@electron/asar', { paths: [path.dirname(lib)] }),
    ) as { createPackage: (src: string, dest: string) => Promise<void> };

    const src = path.join(resourcesDir, 'src');
    for (const pkg of packages) {
      const dir = path.join(src, 'node_modules', pkg);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};');
      const manifest = manifests[pkg];
      if (manifest) {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
      }
    }
    fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(src, 'dist', 'index.html'), '<html></html>');

    const archive = path.join(resourcesDir, 'app.asar');
    await asar.createPackage(src, archive);
    return archive;
  }

  it('finds plain and scoped packages inside a real asar', async () => {
    const resources = makeTempDir();
    const archive = await buildAsar(resources, ['bindings', '@sigmalink/voice-whisper']);

    const found = verify.listAsarNodeModules(archive);

    expect(found.has('bindings')).toBe(true);
    expect(found.has('@sigmalink/voice-whisper')).toBe(true);
    expect(found.has('dist')).toBe(false);
  });

  // A transitive dep of a WORKSPACE package is packed nested, at
  // node_modules/@scope/owner/node_modules/dep — precisely where Node's
  // resolver finds it. Every other asar test here builds a FLAT archive, so
  // nesting was never exercised and a regex that shadowed the nested package
  // behind its parent passed the whole suite (and a real pack, which found the
  // module via the on-disk walk instead). This is the case that catches it.
  it('finds a package nested inside another package inside a real asar', async () => {
    const resources = makeTempDir();
    const archive = await buildAsar(resources, [
      '@sigmalink/voice-whisper',
      '@sigmalink/voice-whisper/node_modules/node-gyp-build',
    ]);

    const found = verify.listAsarNodeModules(archive);

    expect(found.has('@sigmalink/voice-whisper')).toBe(true);
    // The parent must NOT shadow the nested package.
    expect(found.has('node-gyp-build')).toBe(true);
  });

  it('the header fallback also sees a nested package', async () => {
    const resources = makeTempDir();
    const archive = await buildAsar(resources, [
      '@sigmalink/voice-whisper',
      '@sigmalink/voice-whisper/node_modules/node-gyp-build',
    ]);

    expect([...verify.listAsarNodeModulesViaHeader(archive)].sort()).toEqual(
      [...verify.listAsarNodeModules(archive)].sort(),
    );
    expect(verify.listAsarNodeModulesViaHeader(archive).has('node-gyp-build')).toBe(true);
  });

  it('the dependency-free header fallback agrees with the library path', async () => {
    const resources = makeTempDir();
    const archive = await buildAsar(resources, ['bindings', '@sigmalink/voice-whisper']);

    expect([...verify.listAsarNodeModulesViaHeader(archive)].sort()).toEqual(
      [...verify.listAsarNodeModules(archive)].sort(),
    );
  });

  it('counts asar-internal packages as present, so pure-JS deps do not false-fail', async () => {
    const resources = makeTempDir();
    await buildAsar(resources, ['bindings', 'file-uri-to-path']);
    makePackedModule(resources, 'app.asar.unpacked', 'node-pty');

    expect(
      verify.findMissingModules(resources, ['bindings', 'file-uri-to-path', 'node-pty']),
    ).toEqual([]);
  });

  it('still reports a module that is in neither the asar nor on disk', async () => {
    const resources = makeTempDir();
    await buildAsar(resources, ['bindings']);

    expect(verify.findMissingModules(resources, ['bindings', 'node-gyp-build'])).toEqual([
      'node-gyp-build',
    ]);
  });

  it('treats a missing asar as simply empty, not an error', () => {
    const resources = makeTempDir();

    expect(verify.listAsarNodeModules(path.join(resources, 'app.asar')).size).toBe(0);
  });

  // C-064 — the flat name Set cannot say WHERE a package sits, and position is
  // the whole question. The path surface keeps that information.
  it('reports package PATHS, so top level and nested are distinguishable', async () => {
    const resources = makeTempDir();
    const archive = await buildAsar(resources, [
      'bindings',
      '@sigmalink/voice-whisper',
      '@sigmalink/voice-whisper/node_modules/node-gyp-build',
    ]);

    expect([...verify.listAsarNodeModulePaths(archive)].sort()).toEqual([
      'node_modules/@sigmalink/voice-whisper',
      'node_modules/@sigmalink/voice-whisper/node_modules/node-gyp-build',
      'node_modules/bindings',
    ]);
    expect(verify.splitPackagePath('node_modules/bindings')).toEqual({
      ownerPath: null,
      name: 'bindings',
    });
    expect(
      verify.splitPackagePath('node_modules/@sigmalink/voice-whisper/node_modules/node-gyp-build'),
    ).toEqual({
      ownerPath: 'node_modules/@sigmalink/voice-whisper',
      name: 'node-gyp-build',
    });
  });

  it('reports MISSING an asar-nested copy whose owner does not declare it', async () => {
    const resources = makeTempDir();
    await buildAsar(
      resources,
      ['some-vendor', 'some-vendor/node_modules/node-gyp-build'],
      { 'some-vendor': { name: 'some-vendor' } },
    );

    expect(verify.findMissingModules(resources, ['node-gyp-build'])).toEqual(['node-gyp-build']);
  });

  it('PASSES an asar-nested copy whose owner declares it', async () => {
    const resources = makeTempDir();
    await buildAsar(
      resources,
      ['@sigmalink/voice-whisper', '@sigmalink/voice-whisper/node_modules/node-gyp-build'],
      {
        '@sigmalink/voice-whisper': {
          name: '@sigmalink/voice-whisper',
          dependencies: { 'node-gyp-build': '^4.8.0' },
        },
      },
    );

    expect(
      verify.findMissingModules(resources, ['@sigmalink/voice-whisper', 'node-gyp-build']),
    ).toEqual([]);
  });
});
