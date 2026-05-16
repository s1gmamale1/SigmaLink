// Unit tests for the cross-platform spawn helper (buildSpawnArgs).
//
// spawnExecutable itself is a thin wrapper around buildSpawnArgs + Node's
// child_process.spawn; the interesting branching logic is fully in
// buildSpawnArgs, which we test directly.
//
// A Windows-only integration test (real .cmd stub from a temp dir) is
// provided at the bottom, gated with it.skipIf(process.platform !== 'win32').

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

afterEach(() => {
  // Restore the real platform so other test files are unaffected.
  Object.defineProperty(process, 'platform', {
    value: 'darwin', // reset to host; actual value doesn't matter for unit tests
    configurable: true,
  });
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ── buildSpawnArgs: Windows path ───────────────────────────────────────────

describe('buildSpawnArgs — Windows', () => {
  it('wraps a .cmd shim through cmd.exe /d /s /c', async () => {
    // Arrange: stub process.platform and mock resolveWindowsCommand to return
    // a .cmd path (simulating what `where claude` returns on Windows).
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    // Mock local-pty so resolveWindowsCommand returns a fixed .cmd path without
    // needing the real filesystem.
    vi.doMock('../pty/local-pty', () => ({
      resolveWindowsCommand: () =>
        'C:\\Users\\user\\AppData\\Roaming\\npm\\claude.cmd',
    }));

    const { buildSpawnArgs } = await import('./spawn-cross-platform');
    const originalArgs = ['-p', 'hello world', '--output-format', 'stream-json'];
    const { bin, argv } = buildSpawnArgs('claude', originalArgs);

    expect(bin).toBe('cmd.exe');
    expect(argv[0]).toBe('/d');
    expect(argv[1]).toBe('/s');
    expect(argv[2]).toBe('/c');
    expect(argv[3]).toBe('C:\\Users\\user\\AppData\\Roaming\\npm\\claude.cmd');
    // Original args follow the resolved shim path verbatim.
    expect(argv.slice(4)).toEqual(originalArgs);
  });

  it('wraps a .bat file through cmd.exe /d /s /c', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    vi.doMock('../pty/local-pty', () => ({
      resolveWindowsCommand: () => 'C:\\tools\\run.bat',
    }));

    const { buildSpawnArgs } = await import('./spawn-cross-platform');
    const { bin, argv } = buildSpawnArgs('run', ['--flag']);

    expect(bin).toBe('cmd.exe');
    expect(argv).toEqual(['/d', '/s', '/c', 'C:\\tools\\run.bat', '--flag']);
  });

  it('wraps a .ps1 file through powershell.exe -NoProfile -ExecutionPolicy Bypass -File', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    vi.doMock('../pty/local-pty', () => ({
      resolveWindowsCommand: () => 'C:\\scripts\\tool.ps1',
    }));

    const { buildSpawnArgs } = await import('./spawn-cross-platform');
    const { bin, argv } = buildSpawnArgs('tool', ['arg1']);

    expect(bin).toBe('powershell.exe');
    expect(argv).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\scripts\\tool.ps1',
      'arg1',
    ]);
  });

  it('spawns a .exe directly without a wrapper', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    vi.doMock('../pty/local-pty', () => ({
      resolveWindowsCommand: () => 'C:\\Program Files\\Git\\cmd\\git.exe',
    }));

    const { buildSpawnArgs } = await import('./spawn-cross-platform');
    const { bin, argv } = buildSpawnArgs('git', ['status']);

    expect(bin).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(argv).toEqual(['status']);
  });

  it('falls back to the literal cmd when resolveWindowsCommand returns null', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    vi.doMock('../pty/local-pty', () => ({
      resolveWindowsCommand: () => null,
    }));

    const { buildSpawnArgs } = await import('./spawn-cross-platform');
    const { bin, argv } = buildSpawnArgs('unknown-tool', ['--help']);

    // With null resolution and no extension the kind is null — direct spawn.
    expect(bin).toBe('unknown-tool');
    expect(argv).toEqual(['--help']);
  });
});

// ── buildSpawnArgs: POSIX pass-through ────────────────────────────────────

describe('buildSpawnArgs — POSIX (pass-through)', () => {
  it('returns cmd and args unchanged on darwin', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    // resolveWindowsCommand should NOT be called on POSIX — we do not mock it,
    // so any call would hit the real implementation which may fail in CI.
    const { buildSpawnArgs } = await import('./spawn-cross-platform');
    const args = ['-p', 'hello', '--output-format', 'stream-json'];
    const { bin, argv } = buildSpawnArgs('/usr/local/bin/claude', args);

    expect(bin).toBe('/usr/local/bin/claude');
    expect(argv).toEqual(args);
  });

  it('returns cmd and args unchanged on linux', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const { buildSpawnArgs } = await import('./spawn-cross-platform');
    const { bin, argv } = buildSpawnArgs('/usr/bin/claude', ['--version']);

    expect(bin).toBe('/usr/bin/claude');
    expect(argv).toEqual(['--version']);
  });
});

// ── Windows-only integration test (real .cmd stub) ─────────────────────────

describe.skipIf(process.platform !== 'win32')('spawn-cross-platform Windows integration', () => {
  it('executes a real .cmd stub and captures its output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-xp-test-'));
    const shimPath = path.join(tmpDir, 'echo-hello.cmd');
    // A minimal cmd script that echoes a known string to stdout.
    fs.writeFileSync(shimPath, '@echo hello-from-cmd\r\n', 'utf8');

    try {
      // Use the real module (platform IS win32 here).
      const { spawnExecutable } = await import('./spawn-cross-platform');
      const child = spawnExecutable('echo-hello', [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${tmpDir};${process.env.PATH ?? ''}` },
      });

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (d: Buffer) => chunks.push(d));
        child.on('close', resolve);
        child.on('error', reject);
      });

      const output = Buffer.concat(chunks).toString('utf8').trim();
      expect(output).toBe('hello-from-cmd');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
