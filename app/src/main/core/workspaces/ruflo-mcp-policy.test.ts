import { describe, expect, it, vi } from 'vitest';
import { ensureRufloMcpForPane } from './ruflo-mcp-policy';

function rawDb(valueByKey: Record<string, string | undefined>) {
  return {
    prepare: vi.fn(() => ({
      get: vi.fn((key: string) => ({ value: valueByKey[key] })),
    })),
  } as never;
}

describe('ensureRufloMcpForPane', () => {
  it('starts the workspace HTTP daemon and writes an HTTP Ruflo entry', async () => {
    const spawn = vi.fn().mockResolvedValue({ port: 4567 });
    const write = vi.fn().mockReturnValue({ claude: '/cwd/.mcp.json', trusted: true });

    const result = await ensureRufloMcpForPane({
      cwd: '/cwd',
      workspaceId: 'ws1',
      workspaceRoot: '/workspace',
      runtimeProfileId: 'ruflo-core',
      rawDb: rawDb({}),
      daemon: { spawn, port: vi.fn(() => null) },
      writeRuflo: write,
      httpDaemonEnabled: true,
    });

    expect(spawn).toHaveBeenCalledWith('ws1', '/workspace');
    expect(write).toHaveBeenCalledWith('/cwd', { port: 4567, trust: true });
    expect(result.transport).toBe('http');
  });

  it('does NOT spawn the daemon when httpDaemonEnabled is false (default) — straight to stdio', async () => {
    // B4 / Windows lag fix: with the HTTP daemon disabled, the per-pane policy
    // must skip daemon.spawn() entirely (no ~10s health-wait stall) and write a
    // stdio entry. This is the default when callers omit the flag.
    const spawn = vi.fn();
    const write = vi.fn().mockReturnValue({ claude: '/cwd/.mcp.json', trusted: true });

    const result = await ensureRufloMcpForPane({
      cwd: '/cwd',
      workspaceId: 'ws1',
      workspaceRoot: '/workspace',
      runtimeProfileId: 'ruflo-core',
      rawDb: rawDb({}),
      daemon: { spawn, port: vi.fn(() => null) },
      writeRuflo: write,
      // httpDaemonEnabled omitted -> defaults to disabled
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('/cwd', { port: undefined, trust: true });
    expect(result.transport).toBe('stdio');
  });

  it('reuses an already running daemon port without spawning', async () => {
    const spawn = vi.fn();
    const write = vi.fn().mockReturnValue({ claude: '/cwd/.mcp.json', trusted: true });

    const result = await ensureRufloMcpForPane({
      cwd: '/cwd',
      workspaceId: 'ws1',
      workspaceRoot: '/workspace',
      runtimeProfileId: 'ruflo-core',
      rawDb: rawDb({}),
      daemon: { spawn, port: vi.fn(() => 7777) },
      writeRuflo: write,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('/cwd', { port: 7777, trust: true });
    expect(result.transport).toBe('http');
  });

  it('falls back to stdio when daemon start returns null', async () => {
    const write = vi.fn().mockReturnValue({ claude: '/cwd/.mcp.json', trusted: true });

    const result = await ensureRufloMcpForPane({
      cwd: '/cwd',
      workspaceId: 'ws1',
      workspaceRoot: '/workspace',
      runtimeProfileId: 'ruflo-core',
      rawDb: rawDb({}),
      daemon: { spawn: vi.fn().mockResolvedValue(null), port: vi.fn(() => null) },
      writeRuflo: write,
      httpDaemonEnabled: true,
    });

    expect(write).toHaveBeenCalledWith('/cwd', { port: undefined, trust: true });
    expect(result.transport).toBe('stdio');
  });

  it('does nothing when Ruflo autowrite is disabled', async () => {
    const write = vi.fn();

    const result = await ensureRufloMcpForPane({
      cwd: '/cwd',
      workspaceId: 'ws1',
      workspaceRoot: '/workspace',
      runtimeProfileId: 'ruflo-core',
      rawDb: rawDb({ 'ruflo.autowriteMcp': '0' }),
      daemon: { spawn: vi.fn(), port: vi.fn(() => null) },
      writeRuflo: write,
    });

    expect(write).not.toHaveBeenCalled();
    expect(result.transport).toBe('skipped');
  });

  it('honors the auto-trust opt-out while still writing Ruflo config', async () => {
    const write = vi.fn().mockReturnValue({ claude: '/cwd/.mcp.json', trusted: false });

    await ensureRufloMcpForPane({
      cwd: '/cwd',
      workspaceId: 'ws1',
      workspaceRoot: '/workspace',
      runtimeProfileId: 'ruflo-core',
      rawDb: rawDb({ 'ruflo.autoTrustMcp': '0' }),
      daemon: { spawn: vi.fn(), port: vi.fn(() => 7777) },
      writeRuflo: write,
    });

    expect(write).toHaveBeenCalledWith('/cwd', { port: 7777, trust: false });
  });
});
