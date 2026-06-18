// src/main/core/control/control-wiring.test.ts
//
// Lifecycle test for the ControlMcpHost singleton as it would be wired in
// rpc-router: start → N clients connect + disconnect → stop → liveCount===0.
// Also asserts the control module does NOT import node:child_process (leak guard).

import { describe, it, expect, vi } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ControlMcpHost } from './control-mcp-host';
import { ExternalEscalator } from './escalation';

function tmpSock(): string {
  return path.join(os.tmpdir(), `sl-ctl-wiring-${Math.floor(Math.random() * 1e9)}.sock`);
}

/** Open a raw TCP/Unix connection and wait until the OS confirms it is writable. */
function openClient(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** Close a socket and wait for the 'close' event. */
function closeClient(s: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    s.once('close', () => resolve());
    s.destroy();
  });
}

/** Poll until predicate returns true or timeout elapses. */
async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('ControlMcpHost — lifecycle (wiring test)', () => {
  it('start() makes the socket reachable and stop() cleans up', async () => {
    const socketPath = tmpSock();
    const controlEscalator = new ExternalEscalator({ notify: () => {} });
    const fakeInvoker = vi.fn().mockResolvedValue({ ok: true, result: null });

    const host = new ControlMcpHost({
      socketPath,
      getToken: () => 'test-bearer-token',
      isFrozen: () => false,
      resolveInvoker: () => fakeInvoker,
      escalate: (toolName, summary, label) => controlEscalator.confirm(toolName, summary, label),
    });

    // Before start: socket file must not exist.
    expect(fs.existsSync(socketPath)).toBe(false);

    await host.start();

    // After start: socket file exists (Unix sockets only; skip check on win32).
    if (process.platform !== 'win32') {
      expect(fs.existsSync(socketPath)).toBe(true);
    }

    expect(host.liveConnectionCount()).toBe(0);

    // Open 3 clients and let the server register them.
    const N = 3;
    const clients = await Promise.all(Array.from({ length: N }, () => openClient(socketPath)));

    // Give the server event loop a tick to register sockets.
    await waitUntil(() => host.liveConnectionCount() === N);
    expect(host.liveConnectionCount()).toBe(N);

    // Close all clients.
    await Promise.all(clients.map((c) => closeClient(c)));

    // Give the server event loop ticks to evict the sockets.
    await waitUntil(() => host.liveConnectionCount() === 0);
    expect(host.liveConnectionCount()).toBe(0);

    host.stop();
    controlEscalator.cancelAll();
  });
});

describe('ControlMcpHost — no child_process leak', () => {
  it('control-mcp-host.ts does not import node:child_process', () => {
    // Read the source file and assert it contains no child_process import.
    // This guards against MAIN accidentally spawning a per-client process.
    const src = fs.readFileSync(
      path.join(__dirname, 'control-mcp-host.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/child_process/);
  });
});
