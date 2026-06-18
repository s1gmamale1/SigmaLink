// Unit + integration tests for the SigmaLink Control stdio MCP bridge.
//
// Unit layer: exercises the pure mappers (mapCatalogueToMcpTools, wrapInvokeResult)
//   and the handleControlMcpLine request handler with an injected fake client.
//
// Integration layer: starts a real ControlMcpHost on a temp unix socket with a
//   fake invoker, then drives handleControlMcpLine wired to a real ControlClient
//   (with handshake) and asserts the full round-trip — including that the host
//   receives origin:'external'.

import { describe, it, expect, vi } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  mapCatalogueToMcpTools,
  wrapInvokeResult,
  handleControlMcpLine,
  ControlClient,
  type ControlServerDeps,
  type HostToolEntry,
  type InvokeOut,
} from './mcp-sigma-control-server';

import { ControlMcpHost } from '../core/control/control-mcp-host';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempSock(): string {
  return path.join(os.tmpdir(), `sl-ctrl-test-${Math.floor(Math.random() * 1e9)}.sock`);
}

/** Capture written lines and parse them as JSON. */
function makeTestDeps(
  toolsList: () => Promise<unknown> = async () => ({ tools: [] }),
  toolsInvoke: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({ ok: true, result: null }),
): { deps: ControlServerDeps; responses: () => Array<Record<string, unknown>> } {
  const written: string[] = [];
  const deps: ControlServerDeps = {
    client: {
      toolsList,
      toolsInvoke,
    },
    write: (line: string) => { written.push(line); },
  };
  return {
    deps,
    responses: () =>
      written
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------
// Unit: mapCatalogueToMcpTools
// ---------------------------------------------------------------------------

describe('mapCatalogueToMcpTools', () => {
  it('maps name, description, and inputSchema', () => {
    const entries: HostToolEntry[] = [
      {
        name: 'read_pane',
        description: 'Read terminal pane output',
        inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
      },
      {
        name: 'list_active_sessions',
        description: 'List sessions',
        inputSchema: { type: 'object' },
      },
    ];
    const tools = mapCatalogueToMcpTools(entries);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('read_pane');
    expect(tools[0].description).toBe('Read terminal pane output');
    expect(tools[0].inputSchema.type).toBe('object');
    expect(tools[1].name).toBe('list_active_sessions');
  });

  it('returns empty array for empty input', () => {
    expect(mapCatalogueToMcpTools([])).toEqual([]);
  });

  it('always sets inputSchema.type to "object" even if missing from entry', () => {
    const tools = mapCatalogueToMcpTools([
      { name: 'x', description: 'y', inputSchema: {} as HostToolEntry['inputSchema'] },
    ]);
    expect(tools[0].inputSchema.type).toBe('object');
  });

  it('preserves properties and required from the entry inputSchema', () => {
    const tools = mapCatalogueToMcpTools([
      {
        name: 'launch_pane',
        description: 'Launch a new pane',
        inputSchema: {
          type: 'object',
          properties: { workspaceId: { type: 'string' }, command: { type: 'string' } },
          required: ['workspaceId'],
        },
      },
    ]);
    expect(tools[0].inputSchema.properties).toEqual({
      workspaceId: { type: 'string' },
      command: { type: 'string' },
    });
    expect(tools[0].inputSchema.required).toEqual(['workspaceId']);
  });
});

// ---------------------------------------------------------------------------
// Unit: wrapInvokeResult
// ---------------------------------------------------------------------------

describe('wrapInvokeResult', () => {
  it('wraps a successful result in a text content block with isError=false', () => {
    const out: InvokeOut = { ok: true, result: { screen: 'hello world' } };
    const wrapped = wrapInvokeResult(out);
    expect(wrapped.isError).toBe(false);
    expect(wrapped.content).toHaveLength(1);
    expect(wrapped.content[0].type).toBe('text');
    expect(JSON.parse(wrapped.content[0].text)).toEqual({ screen: 'hello world' });
  });

  it('sets isError=true for a failed result and includes error in the payload', () => {
    const out: InvokeOut = { ok: false, result: null, error: 'pane not found' };
    const wrapped = wrapInvokeResult(out);
    expect(wrapped.isError).toBe(true);
    expect(JSON.parse(wrapped.content[0].text)).toMatchObject({ error: 'pane not found' });
  });

  it('uses a default error message when error field is absent and ok is false', () => {
    const out: InvokeOut = { ok: false, result: null };
    const wrapped = wrapInvokeResult(out);
    expect(wrapped.isError).toBe(true);
    expect(wrapped.content[0].text).toContain('unknown error');
  });

  it('emits string result verbatim (no double-encode)', () => {
    const out: InvokeOut = { ok: true, result: 'plain text response' };
    const wrapped = wrapInvokeResult(out);
    expect(wrapped.content[0].text).toBe('plain text response');
  });

  it('serialises a null result to "null"', () => {
    const out: InvokeOut = { ok: true, result: null };
    const wrapped = wrapInvokeResult(out);
    expect(wrapped.content[0].text).toBe('null');
  });
});

// ---------------------------------------------------------------------------
// Unit: handleControlMcpLine — MCP protocol handling
// ---------------------------------------------------------------------------

describe('handleControlMcpLine', () => {
  it('answers initialize with sigmalink-control server info', async () => {
    const { deps, responses } = makeTestDeps();
    await handleControlMcpLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      deps,
    );
    const out = responses();
    expect(out).toHaveLength(1);
    const result = out[0].result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: { tools: Record<string, unknown> };
    };
    expect(result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.serverInfo.name).toBe('sigmalink-control');
    expect(result.serverInfo.version).toBe('0.1.0');
    expect(result.capabilities.tools).toBeDefined();
  });

  it('answers ping with an empty object result', async () => {
    const { deps, responses } = makeTestDeps();
    await handleControlMcpLine(JSON.stringify({ jsonrpc: '2.0', id: 'p', method: 'ping' }), deps);
    expect(responses()[0].result).toEqual({});
  });

  it('ignores initialized notification without emitting a response', async () => {
    const { deps, responses } = makeTestDeps();
    await handleControlMcpLine(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      deps,
    );
    expect(responses()).toHaveLength(0);
  });

  it('ignores empty / whitespace-only lines', async () => {
    const { deps, responses } = makeTestDeps();
    await handleControlMcpLine('', deps);
    await handleControlMcpLine('   ', deps);
    expect(responses()).toHaveLength(0);
  });

  it('emits parse error (-32700) on malformed JSON', async () => {
    const { deps, responses } = makeTestDeps();
    await handleControlMcpLine('{not json', deps);
    const e = responses()[0].error as { code: number; message: string };
    expect(e.code).toBe(-32700);
  });

  it('emits Method not found (-32601) for unknown methods', async () => {
    const { deps, responses } = makeTestDeps();
    await handleControlMcpLine(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'totally/unknown' }),
      deps,
    );
    const e = responses()[0].error as { code: number; message: string };
    expect(e.code).toBe(-32601);
    expect(e.message).toMatch(/Method not found/);
  });

  it('tools/list calls client.toolsList and maps the catalogue to MCP descriptors', async () => {
    const fakeCatalogue: HostToolEntry[] = [
      {
        name: 'read_pane',
        description: 'Read pane',
        inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } } },
      },
    ];
    const listSpy = vi.fn(async () => ({ tools: fakeCatalogue }));
    const { deps, responses } = makeTestDeps(listSpy);
    await handleControlMcpLine(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      deps,
    );
    expect(listSpy).toHaveBeenCalledOnce();
    const result = responses()[0].result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('read_pane');
  });

  it('tools/call forwards to client.toolsInvoke and wraps the result', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { deps, responses } = makeTestDeps(
      async () => ({ tools: [] }),
      async (name, args) => {
        calls.push({ name, args });
        return { ok: true, result: { screen: 'hello' } };
      },
    );
    await handleControlMcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_pane', arguments: { sessionId: 's1' } },
      }),
      deps,
    );
    expect(calls).toEqual([{ name: 'read_pane', args: { sessionId: 's1' } }]);
    const result = responses()[0].result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ screen: 'hello' });
  });

  it('tools/call sets isError=true when the invoker returns ok:false', async () => {
    const { deps, responses } = makeTestDeps(
      async () => ({ tools: [] }),
      async () => ({ ok: false, result: null, error: 'pane gone' }),
    );
    await handleControlMcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'close_pane', arguments: { sessionId: 's2' } },
      }),
      deps,
    );
    const result = responses()[0].result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'pane gone' });
  });

  it('tools/call emits -32602 when name is missing', async () => {
    const { deps, responses } = makeTestDeps();
    await handleControlMcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { arguments: {} },
      }),
      deps,
    );
    const e = responses()[0].error as { code: number; message: string };
    expect(e.code).toBe(-32602);
    expect(e.message).toMatch(/name/);
  });
});

// ---------------------------------------------------------------------------
// Integration: full round-trip through ControlMcpHost
// ---------------------------------------------------------------------------

describe('ControlClient + ControlMcpHost integration', () => {
  it('completes the handshake with a valid token', async () => {
    const socketPath = tempSock();
    const host = new ControlMcpHost({
      socketPath,
      getToken: () => 'secret-token',
      isFrozen: () => false,
      resolveInvoker: () => vi.fn(async () => ({ ok: true, result: null })),
      escalate: async () => true,
    });
    await host.start();

    const client = new ControlClient(socketPath);
    await expect(client.connect('secret-token', 'test-client')).resolves.not.toThrow();

    client.destroy();
    host.stop();
  });

  it('rejects a wrong token with an error', async () => {
    const socketPath = tempSock();
    const host = new ControlMcpHost({
      socketPath,
      getToken: () => 'secret-token',
      isFrozen: () => false,
      resolveInvoker: () => vi.fn(async () => ({ ok: true, result: null })),
      escalate: async () => true,
    });
    await host.start();

    const client = new ControlClient(socketPath);
    await expect(client.connect('WRONG-TOKEN', 'bad-client')).rejects.toThrow();

    client.destroy();
    host.stop();
  });

  it('forwards tools/call and the host receives origin:external', async () => {
    const socketPath = tempSock();
    const receivedCalls: Array<{
      name: string;
      args: Record<string, unknown>;
      origin: string;
    }> = [];

    const invoker = vi.fn(async (input: {
      name: string;
      args: Record<string, unknown>;
      origin: 'external';
      confirmDangerous: (n: string, s: string) => Promise<boolean>;
    }) => {
      receivedCalls.push({ name: input.name, args: input.args, origin: input.origin });
      return { ok: true, result: { screen: 'terminal output' } };
    });

    const host = new ControlMcpHost({
      socketPath,
      getToken: () => 'secret-token',
      isFrozen: () => false,
      resolveInvoker: () => invoker,
      escalate: async () => true,
    });
    await host.start();

    const client = new ControlClient(socketPath);
    await client.connect('secret-token', 'integration-test');

    // Exercise the round-trip by wiring handleControlMcpLine to the real client.
    const responses: Array<Record<string, unknown>> = [];
    const deps: ControlServerDeps = {
      client,
      write: (line: string) => {
        const trimmed = line.trim();
        if (trimmed) responses.push(JSON.parse(trimmed) as Record<string, unknown>);
      },
    };

    await handleControlMcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'int-1',
        method: 'tools/call',
        params: { name: 'read_pane', arguments: { sessionId: 'pty-42' } },
      }),
      deps,
    );

    expect(receivedCalls).toHaveLength(1);
    expect(receivedCalls[0].name).toBe('read_pane');
    expect(receivedCalls[0].args).toEqual({ sessionId: 'pty-42' });
    expect(receivedCalls[0].origin).toBe('external');

    expect(responses).toHaveLength(1);
    const result = responses[0].result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ screen: 'terminal output' });

    client.destroy();
    host.stop();
  });

  it('tools/list returns the host catalogue mapped as MCP descriptors', async () => {
    const socketPath = tempSock();
    const fakeCatalogue = [
      {
        name: 'list_active_sessions',
        description: 'List all active sessions',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      },
    ];

    const host = new ControlMcpHost({
      socketPath,
      getToken: () => 'tok',
      isFrozen: () => false,
      resolveInvoker: () => vi.fn(async () => ({ ok: true, result: null })),
      escalate: async () => true,
      getCatalogue: () => fakeCatalogue,
    });
    await host.start();

    const client = new ControlClient(socketPath);
    await client.connect('tok', 'list-test');

    const responses: Array<Record<string, unknown>> = [];
    const deps: ControlServerDeps = {
      client,
      write: (line: string) => {
        const trimmed = line.trim();
        if (trimmed) responses.push(JSON.parse(trimmed) as Record<string, unknown>);
      },
    };

    await handleControlMcpLine(
      JSON.stringify({ jsonrpc: '2.0', id: 'lst-1', method: 'tools/list' }),
      deps,
    );

    expect(responses).toHaveLength(1);
    const result = responses[0].result as { tools: Array<{ name: string; description: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('list_active_sessions');
    expect(result.tools[0].description).toBe('List all active sessions');

    client.destroy();
    host.stop();
  });

  it('handles a real net.Socket handshake directly (raw socket test)', async () => {
    const socketPath = tempSock();
    const host = new ControlMcpHost({
      socketPath,
      getToken: () => 'raw-token',
      isFrozen: () => false,
      resolveInvoker: () => vi.fn(async () => ({ ok: true, result: { data: 42 } })),
      escalate: async () => true,
    });
    await host.start();

    // Raw socket test — mirrors the ControlMcpHost unit test pattern.
    const rawRpc = (socket: net.Socket, obj: unknown): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        let buf = '';
        const onData = (c: Buffer) => {
          buf += c.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl !== -1) {
            socket.off('data', onData);
            resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
          }
        };
        socket.on('data', onData);
        socket.write(JSON.stringify(obj) + '\n');
      });

    const c = net.connect(socketPath);
    const hello = await rawRpc(c, { jsonrpc: '2.0', id: 1, method: 'control.hello', params: { token: 'raw-token', label: 'raw-test' } });
    expect((hello.result as { ok: boolean }).ok).toBe(true);

    const invoke = await rawRpc(c, { jsonrpc: '2.0', id: 2, method: 'tools.invoke', params: { name: 'read_pane', args: { sessionId: 'x' } } });
    expect((invoke.result as { ok: boolean }).ok).toBe(true);
    expect((invoke.result as { result: { data: number } }).result).toEqual({ data: 42 });

    c.destroy();
    host.stop();
  });
});
