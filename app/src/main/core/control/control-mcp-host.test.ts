import { describe, it, expect, vi } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ControlMcpHost } from './control-mcp-host';

const sock = () => path.join(os.tmpdir(), `sl-ctl-${Math.floor(Math.random() * 1e9)}.sock`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rpc(socket: net.Socket, obj: unknown): Promise<any> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (c: Buffer) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) { socket.off('data', onData); resolve(JSON.parse(buf.slice(0, nl))); }
    };
    socket.on('data', onData);
    socket.write(JSON.stringify(obj) + '\n');
  });
}

describe('ControlMcpHost', () => {
  it('rejects tools.invoke before a valid handshake', async () => {
    const socketPath = sock();
    const invoke = vi.fn();
    const host = new ControlMcpHost({
      socketPath, getToken: () => 'secret', isFrozen: () => false,
      resolveInvoker: () => invoke, escalate: async () => true,
    });
    await host.start();
    const c = net.connect(socketPath);
    const res = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'tools.invoke', params: { name: 'read_pane', args: {} } });
    expect(res.error.message).toMatch(/handshake|unauthorized/i);
    expect(invoke).not.toHaveBeenCalled();
    c.destroy(); host.stop();
  });

  it('bad token is rejected and the socket is closed', async () => {
    const socketPath = sock();
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => vi.fn(), escalate: async () => true });
    await host.start();
    const c = net.connect(socketPath);
    const res = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'control.hello', params: { token: 'WRONG', label: 'x' } });
    expect(res.error.message).toMatch(/unauthorized/i);
    host.stop();
  });

  it('after handshake, forwards tools.invoke with origin:external forced', async () => {
    const socketPath = sock();
    const invoke = vi.fn(async () => ({ ok: true, result: { screen: 'hi' } }));
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => invoke, escalate: async () => true });
    await host.start();
    const c = net.connect(socketPath);
    const hi = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'control.hello', params: { token: 'secret', label: 'hermes' } });
    expect(hi.result.ok).toBe(true);
    const res = await rpc(c, { jsonrpc: '2.0', id: 2, method: 'tools.invoke', params: { name: 'read_pane', args: { sessionId: 's1' } } });
    expect(res.result).toEqual({ ok: true, result: { screen: 'hi' } });
    const call = (invoke.mock.calls as unknown as Array<Array<{ origin: string; confirmDangerous: unknown }>>)[0]?.[0];
    expect(call?.origin).toBe('external');
    expect(typeof call?.confirmDangerous).toBe('function');
    c.destroy(); host.stop();
  });

  it('frozen host rejects authenticated calls', async () => {
    const socketPath = sock();
    let frozen = false;
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => frozen, resolveInvoker: () => vi.fn(async () => ({ ok: true, result: 1 })), escalate: async () => true });
    await host.start();
    const c = net.connect(socketPath);
    await rpc(c, { jsonrpc: '2.0', id: 1, method: 'control.hello', params: { token: 'secret', label: 'x' } });
    frozen = true;
    const res = await rpc(c, { jsonrpc: '2.0', id: 2, method: 'tools.invoke', params: { name: 'read_pane', args: {} } });
    expect(res.error.message).toMatch(/frozen/i);
    c.destroy(); host.stop();
  });

  it('tracks live connections and drops to zero after stop (no orphan)', async () => {
    const socketPath = sock();
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => vi.fn(), escalate: async () => true });
    await host.start();
    const c1 = net.connect(socketPath); const c2 = net.connect(socketPath);
    await new Promise((r) => setTimeout(r, 30));
    expect(host.liveConnectionCount()).toBe(2);
    host.stop();
    expect(host.liveConnectionCount()).toBe(0);
    c1.destroy(); c2.destroy();
  });

  it('destroys a socket that never completes the handshake (timeout)', async () => {
    const socketPath = sock();
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => vi.fn(), escalate: async () => true, handshakeTimeoutMs: 50 });
    await host.start();
    const c = net.connect(socketPath);
    await new Promise((r) => setTimeout(r, 140));
    expect(host.liveConnectionCount()).toBe(0);
    c.destroy(); host.stop();
  });

  it('drops a connection that overflows the pre-newline buffer cap', async () => {
    const socketPath = sock();
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => vi.fn(), escalate: async () => true, maxLineBytes: 1000 });
    await host.start();
    const c = net.connect(socketPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const got = await new Promise<any>((resolve) => {
      let b = '';
      c.on('data', (d: Buffer) => {
        b += d.toString('utf8');
        const nl = b.indexOf('\n');
        if (nl !== -1) resolve(JSON.parse(b.slice(0, nl)));
      });
      c.write('x'.repeat(1500)); // no newline, exceeds the 1000-byte cap
    });
    expect(got.error.message).toMatch(/too large/i);
    c.destroy(); host.stop();
  });

  // Task 6(a) — protocol range validation
  it('rejects control.hello with protocol > MAX (v2) with error code -32003 and closes the socket', async () => {
    const socketPath = sock();
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => vi.fn(), escalate: async () => true });
    await host.start();
    const c = net.connect(socketPath);
    const res = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'control.hello', params: { token: 'secret', label: 'x', protocol: 2 } });
    expect(res.error.code).toBe(-32003);
    expect(res.error.message).toMatch(/unsupported/i);
    // socket should be destroyed after rejection
    await new Promise<void>((resolve) => { c.once('close', () => resolve()); setTimeout(resolve, 500); });
    c.destroy(); host.stop();
  });

  it('accepts control.hello with protocol 1 (exact MAX)', async () => {
    const socketPath = sock();
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => vi.fn(), escalate: async () => true });
    await host.start();
    const c = net.connect(socketPath);
    const res = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'control.hello', params: { token: 'secret', label: 'x', protocol: 1 } });
    expect(res.result.ok).toBe(true);
    c.destroy(); host.stop();
  });

  it('accepts control.hello with absent protocol (floor — forward-compat)', async () => {
    const socketPath = sock();
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => vi.fn(), escalate: async () => true });
    await host.start();
    const c = net.connect(socketPath);
    const res = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'control.hello', params: { token: 'secret', label: 'x' } });
    expect(res.result.ok).toBe(true);
    c.destroy(); host.stop();
  });
});
