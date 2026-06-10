// Wave-1 H-5 — unit tests for the central path-containment keystone.
//
// Pure node env: real dirs under os.tmpdir + a real symlink. No DB, no
// better-sqlite3, no Electron — the module is dependency-free by design.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assertAllowedPath, isInsideRoot, isInsideAnyRoot } from './path-guard';

let root: string;
let outside: string;

beforeEach(() => {
  // realpath the temp roots so containment survives the macOS
  // /var/folders → /private/var/folders symlink that mkdtemp returns.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-pg-root-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-pg-out-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('assertAllowedPath', () => {
  it('allows a contained existing path and returns its realpath', () => {
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'hi');
    expect(assertAllowedPath(file, [root])).toBe(file);
  });

  it('allows the root directory itself', () => {
    expect(assertAllowedPath(root, [root])).toBe(root);
  });

  it('rejects a `..` traversal that escapes the root', () => {
    const target = path.join(root, '..', 'escape.txt');
    expect(() => assertAllowedPath(target, [root])).toThrow('path outside workspace');
  });

  it('rejects an absolute path outside the roots', () => {
    const target = path.join(outside, 'secret.txt');
    fs.writeFileSync(target, 'nope');
    expect(() => assertAllowedPath(target, [root])).toThrow('path outside workspace');
  });

  it('rejects empty roots (fail-closed / deny-all)', () => {
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'hi');
    expect(() => assertAllowedPath(file, [])).toThrow('path outside workspace');
  });

  it('rejects an in-tree symlink whose REAL target is outside the roots', () => {
    // Plant `<root>/link` → `<outside>/secret.txt`. Lexically the symlink lives
    // inside the allowed root, but realpath resolves it to the outside target,
    // which MUST be rejected.
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'id_rsa');
    const link = path.join(root, 'link');
    fs.symlinkSync(secret, link);
    expect(() => assertAllowedPath(link, [root])).toThrow('path outside workspace');
  });

  it('allows an in-tree symlink whose REAL target is also inside the roots', () => {
    const real = path.join(root, 'real.txt');
    fs.writeFileSync(real, 'ok');
    const link = path.join(root, 'alias.txt');
    fs.symlinkSync(real, link);
    // Resolves to the real in-tree file → allowed (returns the real path).
    expect(assertAllowedPath(link, [root])).toBe(real);
  });

  it('allows a not-yet-existing write target whose parent is inside the roots', () => {
    const target = path.join(root, 'new-file.txt');
    expect(fs.existsSync(target)).toBe(false);
    expect(assertAllowedPath(target, [root])).toBe(target);
  });

  it('allows a not-yet-existing target nested under a not-yet-existing dir inside the roots', () => {
    const target = path.join(root, 'pending', 'deep', 'new-file.txt');
    expect(assertAllowedPath(target, [root])).toBe(target);
  });

  it('rejects a not-yet-existing target whose parent symlinks outside the roots', () => {
    // `<root>/escape-dir` → `<outside>`, then a new file under it must reject by
    // its parent's REAL location.
    const linkedDir = path.join(root, 'escape-dir');
    fs.symlinkSync(outside, linkedDir);
    const target = path.join(linkedDir, 'planted.txt');
    expect(() => assertAllowedPath(target, [root])).toThrow('path outside workspace');
  });

  it('matches any of several allowed roots', () => {
    const file = path.join(outside, 'b.txt');
    fs.writeFileSync(file, 'hi');
    // `outside` is allowed in this call, so the same path now passes.
    expect(assertAllowedPath(file, [root, outside])).toBe(file);
  });

  it('rejects an empty target', () => {
    expect(() => assertAllowedPath('', [root])).toThrow('path outside workspace');
  });
});

describe('isInsideRoot', () => {
  it('treats the root itself as inside', () => {
    expect(isInsideRoot('/a/b', '/a/b')).toBe(true);
  });

  it('treats a descendant as inside', () => {
    expect(isInsideRoot('/a/b/c', '/a/b')).toBe(true);
  });

  it('does NOT treat a sibling sharing a name prefix as inside', () => {
    // The classic naive-`startsWith` bug: `/a/bc` is NOT inside `/a/b`.
    expect(isInsideRoot('/a/bc', '/a/b')).toBe(false);
  });

  it('treats a parent as outside', () => {
    expect(isInsideRoot('/a', '/a/b')).toBe(false);
  });
});

describe('isInsideAnyRoot (lexical containment, pathImpl-injectable)', () => {
  it('win32: accepts a target whose drive-letter casing differs from the root', () => {
    expect(isInsideAnyRoot('c:\\Repo\\sub\\file.ts', ['C:\\Repo'], path.win32)).toBe(true);
  });

  it('win32: accepts the root itself regardless of casing', () => {
    expect(isInsideAnyRoot('C:\\Repo', ['c:\\repo'], path.win32)).toBe(true);
  });

  it('win32: rejects the prefix trap C:\\RepoEvil vs C:\\Repo', () => {
    expect(isInsideAnyRoot('C:\\RepoEvil\\x', ['C:\\Repo'], path.win32)).toBe(false);
  });

  it('win32: rejects a different drive', () => {
    expect(isInsideAnyRoot('D:\\Repo\\x', ['C:\\Repo'], path.win32)).toBe(false);
  });

  it('posix: rejects the prefix trap /a/bc vs /a/b', () => {
    expect(isInsideAnyRoot('/a/bc/file', ['/a/b'], path.posix)).toBe(false);
  });

  it('posix: accepts a nested target under any of several roots', () => {
    expect(isInsideAnyRoot('/w/two/x', ['/w/one', '/w/two'], path.posix)).toBe(true);
  });

  it('empty roots ⇒ false (fail-closed)', () => {
    expect(isInsideAnyRoot('/a/b', [], path.posix)).toBe(false);
  });

  it('empty-string roots are skipped, not treated as filesystem root', () => {
    expect(isInsideAnyRoot('/a/b', [''], path.posix)).toBe(false);
  });
});
