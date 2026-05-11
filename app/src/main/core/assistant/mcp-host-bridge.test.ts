// BUG-V1.1.2-01 — Unit tests for McpHostBridge + writeSigmaHostMcpConfig.
//
// We use real Unix sockets here because the bridge is intentionally thin
// (no abstraction over `net.Server`), and round-tripping a real connection
// gives the strongest guarantee that `tools.invoke` actually reaches the
// resolved invoker. Tests are skipped on Windows where the named-pipe
// path needs different fixtures.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpHostBridge, writeSigmaHostMcpConfig } from './mcp-host-bridge';

interface BridgeResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: { ok: boolean; result: unknown; error?: string };
  error?: { code: number; message: string };
}

function makeSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-host-bridge-'));
  // socket paths on darwin must be ≤ 104 bytes; mkdtemp under TMPDIR fits.
  return path.join(dir, 's.sock');
}

async function dialAndSend(
  socketPath: string,
  line: string,
): Promise<BridgeResponse> {
  return new Promise<BridgeResponse>((resolve, reject) => {
    const sock = net.createConnection(socketPath, () => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          const payload = buf.slice(0, nl);
          try {
            resolve(JSON.parse(payload) as BridgeResponse);
          } catch (err) {
            reject(err);
          }
          sock.end();
        }
      });
      sock.on('error', reject);
      sock.write(line + '\n');
    });
    sock.once('error', reject);
  });
}

describe.skipIf(process.platform === 'win32')('McpHostBridge', () => {
  let bridge: McpHostBridge | null = null;
  let socketPath = '';

  beforeEach(() => {
    socketPath = makeSocketPath();
  });
  afterEach(() => {
    bridge?.stop();
    bridge = null;
    try {
      fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('forwards tools.invoke to the resolved invoker and round-trips the result', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    bridge = new McpHostBridge({
      socketPath,
      resolveInvoker: () => async (input) => {
        calls.push({ name: input.name, args: input.args });
        return { ok: true, result: { sessions: [{ id: 'pty-A' }] } };
      },
    });
    await bridge.start();
    const resp = await dialAndSend(
      socketPath,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'r1',
        method: 'tools.invoke',
        params: { name: 'list_active_sessions', args: { workspaceId: 'ws-1' } },
      }),
    );
    expect(resp.id).toBe('r1');
    expect(resp.result).toEqual({
      ok: true,
      result: { sessions: [{ id: 'pty-A' }] },
    });
    expect(calls).toEqual([{ name: 'list_active_sessions', args: { workspaceId: 'ws-1' } }]);
  });

  it('returns a JSON-RPC error when no invoker is wired', async () => {
    bridge = new McpHostBridge({
      socketPath,
      resolveInvoker: () => null,
    });
    await bridge.start();
    const resp = await dialAndSend(
      socketPath,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'r2',
        method: 'tools.invoke',
        params: { name: 'list_swarms', args: {} },
      }),
    );
    expect(resp.error).toBeDefined();
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toMatch(/invoker not wired/);
  });

  it('returns Method not found for unknown methods', async () => {
    bridge = new McpHostBridge({
      socketPath,
      resolveInvoker: () => async () => ({ ok: true, result: null }),
    });
    await bridge.start();
    const resp = await dialAndSend(
      socketPath,
      JSON.stringify({ jsonrpc: '2.0', id: 'r3', method: 'not.a.method' }),
    );
    expect(resp.error?.code).toBe(-32601);
  });

  it('stop() closes the listener and unlinks the socket file', async () => {
    bridge = new McpHostBridge({
      socketPath,
      resolveInvoker: () => async () => ({ ok: true, result: null }),
    });
    await bridge.start();
    expect(fs.existsSync(socketPath)).toBe(true);
    bridge.stop();
    bridge = null;
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});

describe('writeSigmaHostMcpConfig', () => {
  let workspaceRoot = '';
  let serverEntry = '';

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-host-ws-'));
    serverEntry = path.join(workspaceRoot, 'mcp-sigma-host-server.cjs');
    fs.writeFileSync(serverEntry, '// stub\n', 'utf8');
  });
  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('writes a stdio mcpServers.sigma-host entry pointing at the bundled server', () => {
    const cfgPath = writeSigmaHostMcpConfig(
      { serverEntry, socketPath: '/tmp/x.sock', workspaceRoot },
      'conv-1',
      'ws-1',
    );
    expect(cfgPath).not.toBeNull();
    expect(cfgPath).toContain(path.join(workspaceRoot, '.claude-flow'));
    const cfg = JSON.parse(fs.readFileSync(cfgPath as string, 'utf8')) as {
      mcpServers: Record<
        string,
        { type: string; command: string; args: string[]; env: Record<string, string> }
      >;
    };
    expect(cfg.mcpServers['sigma-host'].type).toBe('stdio');
    expect(cfg.mcpServers['sigma-host'].args).toEqual([serverEntry]);
    expect(cfg.mcpServers['sigma-host'].env.SIGMA_HOST_SOCKET).toBe('/tmp/x.sock');
    expect(cfg.mcpServers['sigma-host'].env.SIGMA_CONVERSATION_ID).toBe('conv-1');
    expect(cfg.mcpServers['sigma-host'].env.SIGMA_WORKSPACE_ID).toBe('ws-1');
    expect(cfg.mcpServers['sigma-host'].env.SIGMA_HOST_AUTOBOOT).toBe('1');
    expect(cfg.mcpServers['sigma-host'].env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('falls back to the OS temp dir when no workspaceRoot is given', () => {
    const cfgPath = writeSigmaHostMcpConfig(
      { serverEntry, socketPath: '/tmp/x.sock' },
      undefined,
      undefined,
    );
    expect(cfgPath).not.toBeNull();
    expect(fs.existsSync(cfgPath as string)).toBe(true);
    // The conversation/workspace env vars should be omitted when not supplied.
    const cfg = JSON.parse(fs.readFileSync(cfgPath as string, 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(cfg.mcpServers['sigma-host'].env.SIGMA_CONVERSATION_ID).toBeUndefined();
    expect(cfg.mcpServers['sigma-host'].env.SIGMA_WORKSPACE_ID).toBeUndefined();
    // Best-effort cleanup of the temp dir.
    try {
      fs.rmSync(path.dirname(cfgPath as string), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns null when the server entry is missing on disk', () => {
    const cfgPath = writeSigmaHostMcpConfig(
      { serverEntry: '/nope/does/not/exist.cjs', socketPath: '/tmp/x.sock' },
      undefined,
      undefined,
    );
    expect(cfgPath).toBeNull();
  });
});
