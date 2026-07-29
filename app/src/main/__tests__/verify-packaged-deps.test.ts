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

describe('asar inspection', () => {
  /** Build a real app.asar with @electron/asar, resolved via electron-builder. */
  async function buildAsar(resourcesDir: string, packages: string[]): Promise<string> {
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
});
