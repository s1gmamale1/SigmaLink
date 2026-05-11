// BUG-V1.1.2-01 — Unit tests for the Sigma host stdio MCP server.
//
// The server is a thin proxy: MCP `initialize` / `tools/list` are answered
// locally, and `tools/call` is forwarded to the main process via the
// `BridgeClient`. These tests inject a fake bridge so we never touch a
// real Unix socket — the focus is on the JSON-RPC envelope shape and
// error-mapping (MCP wraps tool-call results in
// `{ content: [{type:'text', text:...}], isError: bool }`).

import { describe, it, expect } from 'vitest';
import { handleMcpLine, SIGMA_HOST_TOOLS, type McpHostServerDeps } from './mcp-host-server';

interface CapturedResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface TestHarness {
  deps: McpHostServerDeps;
  /** Read the responses written so far. NOT cached — call after handleMcpLine. */
  responses: () => CapturedResponse[];
}

function makeDeps(invoke?: McpHostServerDeps['bridge']['invoke']): TestHarness {
  const written: string[] = [];
  const deps: McpHostServerDeps = {
    bridge: {
      invoke:
        invoke ??
        (async () => ({
          ok: true,
          result: { ok: true },
        })),
    },
    conversationId: 'conv-test',
    write: (line: string) => {
      written.push(line);
    },
  };
  return {
    deps,
    responses: () =>
      written
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as CapturedResponse),
  };
}

describe('mcp-host-server / handleMcpLine', () => {
  it('answers initialize with MCP protocol version and server name', async () => {
    const h = makeDeps();
    await handleMcpLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      h.deps,
    );
    const out = h.responses();
    expect(out).toHaveLength(1);
    const r = out[0];
    expect(r.id).toBe(1);
    const result = r.result as {
      protocolVersion: string;
      serverInfo: { name: string };
      capabilities: { tools: { listChanged: boolean } };
    };
    expect(result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.serverInfo.name).toBe('sigma-host');
    expect(result.capabilities.tools.listChanged).toBe(false);
  });

  it('answers tools/list with every Sigma tool and a well-formed schema', async () => {
    const h = makeDeps();
    await handleMcpLine(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      h.deps,
    );
    const out = h.responses();
    expect(out).toHaveLength(1);
    const tools = (out[0].result as { tools: unknown[] }).tools;
    // The 13 canonical Sigma tools (see PRODUCT_SPEC §3.10).
    expect(tools.length).toBe(13);
    for (const t of tools as Array<{
      name: string;
      description: string;
      inputSchema: { type: string; properties?: Record<string, unknown> };
    }>) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema.type).toBe('object');
    }
    // Sanity: the names match the canonical registry.
    const names = (tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toContain('list_active_sessions');
    expect(names).toContain('launch_pane');
    expect(names).toContain('list_workspaces');
  });

  it('returns ping as an empty object result', async () => {
    const h = makeDeps();
    await handleMcpLine(
      JSON.stringify({ jsonrpc: '2.0', id: 'p', method: 'ping' }),
      h.deps,
    );
    const out = h.responses();
    expect(out[0].id).toBe('p');
    expect(out[0].result).toEqual({});
  });

  it('SIGMA_HOST_TOOLS shape matches the tools/list response', async () => {
    const h = makeDeps();
    await handleMcpLine(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      h.deps,
    );
    const tools = (h.responses()[0].result as { tools: unknown[] }).tools;
    expect(tools).toEqual(SIGMA_HOST_TOOLS);
  });

  it('forwards tools/call to the bridge and wraps a successful result in MCP content', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown>; convId?: string }> = [];
    const h = makeDeps(async (name, args, conversationId) => {
      calls.push({ name, args, convId: conversationId });
      return { ok: true, result: { sessions: [{ id: 'pty-1' }] } };
    });
    await handleMcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'list_active_sessions',
          arguments: { workspaceId: 'ws-1' },
        },
      }),
      h.deps,
    );
    expect(calls).toEqual([
      { name: 'list_active_sessions', args: { workspaceId: 'ws-1' }, convId: 'conv-test' },
    ]);
    const out = h.responses();
    expect(out).toHaveLength(1);
    const result = out[0].result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({ sessions: [{ id: 'pty-1' }] });
  });

  it('flags a failed bridge result with isError=true', async () => {
    const h = makeDeps(async () => ({
      ok: false,
      result: null,
      error: 'workspace not found',
    }));
    await handleMcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_swarms', arguments: { workspaceId: 'ws-x' } },
      }),
      h.deps,
    );
    const result = h.responses()[0].result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: 'workspace not found',
    });
  });

  it('emits a JSON-RPC error when tools/call is missing the name', async () => {
    const h = makeDeps();
    await handleMcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { arguments: {} },
      }),
      h.deps,
    );
    const out = h.responses();
    expect(out[0].error).toBeDefined();
    expect(out[0].error?.code).toBe(-32602);
    expect(out[0].error?.message).toMatch(/name/);
  });

  it('emits Method not found for unknown methods', async () => {
    const h = makeDeps();
    await handleMcpLine(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'totally/made/up' }),
      h.deps,
    );
    const out = h.responses();
    expect(out[0].error?.code).toBe(-32601);
    expect(out[0].error?.message).toMatch(/Method not found/);
  });

  it('emits a parse error on malformed JSON', async () => {
    const h = makeDeps();
    await handleMcpLine('{not json', h.deps);
    const out = h.responses();
    expect(out[0].error?.code).toBe(-32700);
  });

  it('ignores empty/whitespace lines without emitting a response', async () => {
    const h = makeDeps();
    await handleMcpLine('', h.deps);
    await handleMcpLine('   \t   ', h.deps);
    expect(h.responses()).toHaveLength(0);
  });

  it('treats notifications/initialized as a notification (no response)', async () => {
    const h = makeDeps();
    await handleMcpLine(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      h.deps,
    );
    expect(h.responses()).toHaveLength(0);
  });
});
