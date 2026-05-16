// BUG-V1.1.2-01 — Sigma Assistant stdio MCP server entry point.
//
// This file is the bundled CJS entry (`electron-dist/mcp-sigma-host-server.cjs`)
// spawned by the Claude CLI as ITS child whenever a turn carries
// `--mcp-config <path>` pointing at our temp `.mcp.json`. It speaks
// newline-delimited JSON-RPC 2.0 — MCP's stdio transport — over its own
// stdin/stdout. Diagnostics go to stderr only so they never pollute the wire.
//
// Sigma model (see `mcp-host-bridge.ts` for the main-process side):
//
//   claude CLI ──stdio──> THIS SERVER ──unix socket──> SigmaLink main
//                          (mcp tools/list,             (calls invokeTool()
//                           tools/call → forward         on the existing
//                           via tools.invoke RPC)        assistant controller
//                                                        with live PTY,
//                                                        mailbox, browser…)
//
// Why a thin proxy and not a self-contained tool host:
//   • The 13 Sigma tools NEED live access to the PTY registry, the browser
//     manager, the worktree pool, etc., which only exist in the main process.
//   • Re-instantiating those from a stdio child would deadlock against the
//     better-sqlite3 WAL writer and miss live in-memory state (BUG-V1.1.1-02
//     root cause).
//   • Forwarding via the bridge means Claude sees the freshly-spawned panes
//     immediately (no DB-flush race), and the tool result envelope flows
//     back through the SAME path as direct `assistant.invokeTool` RPC.
//
// Env vars set by `runClaudeCliTurn.ts` when writing the temp `.mcp.json`:
//   • SIGMA_HOST_SOCKET     — Unix socket path / Windows pipe name to dial
//   • SIGMA_CONVERSATION_ID — the conversation id (so tool traces land in
//                              the right Sigma Room transcript). Optional.
//   • SIGMA_WORKSPACE_ID    — (informational) the active workspace; the
//                              main process resolves the canonical id from
//                              the conversation row.

import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface BridgeRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'tools.invoke';
  params: {
    conversationId?: string;
    name: string;
    args: Record<string, unknown>;
  };
}

interface BridgeResponse {
  jsonrpc: '2.0';
  id: string;
  result?: { ok: boolean; result: unknown; error?: string };
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = '2024-11-05';

// Tool catalogue — must mirror `tools.ts`. We embed the JSON-Schema directly
// so the MCP `tools/list` response is well-typed without importing the full
// tools module (which would drag in better-sqlite3, drizzle, the launcher,
// etc., none of which the stdio server can use anyway since they live in
// the main process).
const TOOLS = [
  {
    name: 'launch_pane',
    description: 'Spawn one or more agent panes in the active workspace.',
    inputSchema: {
      type: 'object' as const,
      required: ['workspaceRoot', 'provider'],
      properties: {
        workspaceRoot: { type: 'string' },
        provider: { type: 'string' },
        count: { type: 'number', minimum: 1, maximum: 8 },
        initialPrompt: { type: 'string' },
      },
    },
  },
  {
    name: 'prompt_agent',
    description: 'Type a prompt into an existing PTY session.',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId', 'prompt'],
      properties: {
        sessionId: { type: 'string' },
        prompt: { type: 'string' },
      },
    },
  },
  {
    name: 'read_files',
    description: 'Read up to 32 files from disk (UTF-8, capped per file).',
    inputSchema: {
      type: 'object' as const,
      required: ['paths'],
      properties: {
        paths: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        maxBytes: { type: 'number' },
      },
    },
  },
  {
    name: 'open_url',
    description: 'Open a URL in the active browser tab (creates one if missing).',
    inputSchema: {
      type: 'object' as const,
      required: ['url'],
      properties: { url: { type: 'string' }, workspaceId: { type: 'string' } },
    },
  },
  {
    name: 'create_task',
    description: 'Create a backlog task in the workspace kanban.',
    inputSchema: {
      type: 'object' as const,
      required: ['title'],
      properties: {
        workspaceId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'create_swarm',
    description: 'Spin up a swarm with a default roster for the chosen preset.',
    inputSchema: {
      type: 'object' as const,
      required: ['mission', 'preset'],
      properties: {
        workspaceId: { type: 'string' },
        mission: { type: 'string' },
        preset: {
          type: 'string',
          enum: ['squad', 'team', 'platoon', 'battalion', 'custom'],
        },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'create_memory',
    description: 'Add a markdown memory note to the workspace memory hub.',
    inputSchema: {
      type: 'object' as const,
      required: ['name'],
      properties: {
        workspaceId: { type: 'string' },
        name: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'search_memories',
    description: 'Search the workspace memory hub for matching notes.',
    inputSchema: {
      type: 'object' as const,
      required: ['query'],
      properties: {
        workspaceId: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'broadcast_to_swarm',
    description: 'Send a broadcast message to every agent in a swarm.',
    inputSchema: {
      type: 'object' as const,
      required: ['swarmId', 'body'],
      properties: { swarmId: { type: 'string' }, body: { type: 'string' } },
    },
  },
  {
    name: 'roll_call',
    description:
      'Send ROLLCALL to one swarm (or every swarm in the workspace if `swarmId` is omitted).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        swarmId: { type: 'string' },
        workspaceId: { type: 'string' },
      },
    },
  },
  {
    name: 'list_active_sessions',
    description: 'List live PTY sessions, optionally scoped to a workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: { workspaceId: { type: 'string' } },
    },
  },
  {
    name: 'list_swarms',
    description: 'List swarms and role rosters for the active workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: { workspaceId: { type: 'string' } },
    },
  },
  {
    name: 'list_workspaces',
    description: 'List known workspaces and mark the active assistant workspace.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

export const SIGMA_HOST_TOOLS = TOOLS;

interface PendingBridgeCall {
  resolve: (value: BridgeResponse['result']) => void;
  reject: (err: Error) => void;
}

class BridgeClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingBridgeCall>();
  private buf = '';
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath, () => {
        socket.off('error', reject);
        this.socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.onData(chunk));
        socket.on('close', () => this.onClose());
        socket.on('error', (err: Error) => {
          writeStderr(`bridge socket error: ${err.message}`);
        });
        resolve();
      });
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf('\n');
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const resp = JSON.parse(trimmed) as BridgeResponse;
        const pending = this.pending.get(resp.id);
        if (!pending) continue;
        this.pending.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(resp.error.message));
        } else {
          pending.resolve(resp.result);
        }
      } catch (err) {
        writeStderr(
          `bridge response parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private onClose(): void {
    this.socket = null;
    // Reject any in-flight calls; the next tools/call will re-connect.
    for (const [id, p] of this.pending) {
      p.reject(new Error('bridge socket closed'));
      this.pending.delete(id);
    }
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    conversationId: string | undefined,
  ): Promise<BridgeResponse['result']> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket) throw new Error('bridge not connected');
    const id = randomUUID();
    const req: BridgeRequest = {
      jsonrpc: '2.0',
      id,
      method: 'tools.invoke',
      params: { conversationId, name, args },
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(JSON.stringify(req) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}

export interface McpHostServerDeps {
  bridge: Pick<BridgeClient, 'invoke'>;
  conversationId: string | undefined;
  /** Inject a writer (testing). Defaults to stdout. */
  write?: (line: string) => void;
}

/**
 * Handle one JSON-RPC line. Exported so the unit test can drive the server
 * without spawning a child process.
 */
export async function handleMcpLine(
  line: string,
  deps: McpHostServerDeps,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch (err) {
    sendError(deps, null, -32700, `Parse error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    sendError(deps, req.id ?? null, -32600, 'Invalid Request');
    return;
  }
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case 'initialize':
        sendResult(deps, id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sigma-host', version: '1.0.0' },
        });
        return;
      case 'initialized':
      case 'notifications/initialized':
        return;
      case 'ping':
        sendResult(deps, id, {});
        return;
      case 'tools/list':
        sendResult(deps, id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const params = req.params as
          | { name?: string; arguments?: Record<string, unknown> }
          | undefined;
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (typeof name !== 'string') {
          sendError(deps, id, -32602, 'tools/call requires { name }');
          return;
        }
        const result = await deps.bridge.invoke(name, args, deps.conversationId);
        const ok = result?.ok ?? false;
        const payload = result?.error
          ? { error: result.error, result: result.result }
          : result?.result;
        sendResult(deps, id, {
          content: [
            {
              type: 'text',
              text: typeof payload === 'string' ? payload : JSON.stringify(payload ?? null, null, 2),
            },
          ],
          isError: !ok,
        });
        return;
      }
      default:
        sendError(deps, id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(deps, id, -32000, message);
  }
}

function sendResult(deps: McpHostServerDeps, id: number | string | null, result: unknown): void {
  const payload: JsonRpcResponse = { jsonrpc: '2.0', id, result };
  (deps.write ?? writeStdout)(JSON.stringify(payload) + '\n');
}

function sendError(
  deps: McpHostServerDeps,
  id: number | string | null,
  code: number,
  message: string,
): void {
  const payload: JsonRpcResponse = { jsonrpc: '2.0', id, error: { code, message } };
  (deps.write ?? writeStdout)(JSON.stringify(payload) + '\n');
}

function writeStdout(s: string): void {
  process.stdout.write(s);
}

function writeStderr(msg: string): void {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
}

async function main(): Promise<void> {
  const socketPath = process.env.SIGMA_HOST_SOCKET;
  if (!socketPath) {
    writeStderr('sigma-host: SIGMA_HOST_SOCKET env var is required');
    process.exit(1);
  }
  const bridge = new BridgeClient(socketPath);
  const conversationId = process.env.SIGMA_CONVERSATION_ID || undefined;
  const deps: McpHostServerDeps = { bridge, conversationId };

  let pending = 0;
  let stdinClosed = false;
  const checkExit = (): void => {
    if (stdinClosed && pending === 0) process.exit(0);
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line: string) => {
    pending += 1;
    handleMcpLine(line, deps)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        writeStderr(`sigma-host line handler crashed: ${message}`);
      })
      .finally(() => {
        pending -= 1;
        checkExit();
      });
  });
  rl.on('close', () => {
    stdinClosed = true;
    checkExit();
  });
}

// Resolve `path` so esbuild keeps the import live for the runtime entry
// shim without breaking when this module is imported from the unit test.
void path;

/**
 * The bundled CJS file (`mcp-sigma-host-server.cjs`) sets
 * `SIGMA_HOST_AUTOBOOT=1` via a banner — see `scripts/build-electron.cjs`.
 * Without that banner, importing this file from a unit test is side-effect
 * free, and `runClaudeCliTurn.ts` always supplies the env var when spawning
 * a child via supervisor / `--mcp-config`. We deliberately do NOT autoboot
 * unconditionally because the test harness imports `handleMcpLine` directly.
 */
if (process.env.SIGMA_HOST_AUTOBOOT === '1') {
  main().catch((err: unknown) => {
    writeStderr(
      `sigma-host failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    process.exit(1);
  });
}
