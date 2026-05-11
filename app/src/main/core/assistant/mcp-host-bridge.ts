// BUG-V1.1.2-01 — Sigma Assistant MCP host bridge (main-process side).
//
// The Claude CLI's tool-use protocol requires tools to be REGISTERED via an
// MCP server, not described in prose in the system prompt. With no MCP server
// publishing the 13 Sigma tools to the child CLI, Claude never emits a
// `tool_use` envelope and the live dispatcher in `runClaudeCliTurn.ts` never
// fires.
//
// Architecture (see `mcp-host-server.ts` for the child entry point):
//
//   main process (SigmaLink)
//     └── McpHostBridge.start()  → listens on a Unix socket / Windows pipe
//   spawns claude CLI as child
//     └── claude spawns mcp-sigma-host-server.cjs as ITS child
//           └── the child connects BACK to the main process via that socket
//                and proxies MCP tools/call → main → invokeTool() → tools.ts
//
// Why stdio + socket-bridge instead of an HTTP MCP server inside main?
//   1. The Claude CLI already supports `--mcp-config <json>` declaring stdio
//      servers — exact same shape used by `mcp-memory-server.cjs`. The
//      runtime is well-tested.
//   2. We avoid port allocation, framework overhead, and CORS plumbing that
//      a full HTTP MCP server would entail. The browser MCP uses
//      @playwright/mcp's own HTTP server; that path is not reusable here
//      because each Claude CLI spawns its OWN MCP stdio client subprocess.
//   3. Unix domain sockets / Windows named pipes are the simplest
//      cross-process JSON-RPC transport. Node's `net` module handles both.
//
// One bridge per process; address is exposed via `getSocketPath()` so the
// runClaudeCliTurn driver can write a temp `.mcp.json` pointing the child
// MCP server at us. The bridge does NOT need to be per-workspace because
// each connection carries the workspaceId in its handshake.

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export type ToolInvoker = (input: {
  conversationId?: string;
  name: string;
  args: Record<string, unknown>;
}) => Promise<{ ok: boolean; result: unknown; error?: string }>;

export interface McpHostBridgeOpts {
  /**
   * Override socket path. Defaults to a per-process file under the OS temp
   * directory so multiple SigmaLink instances on the same machine don't
   * collide. Pass an explicit path in tests so they can assert on it.
   */
  socketPath?: string;
  /**
   * Resolve the tool invoker. Called per request so a freshly-started bridge
   * picks up controller wiring done after `start()`. Returns null when no
   * controller is wired yet (the child receives a JSON-RPC error).
   */
  resolveInvoker: () => ToolInvoker | null;
}

interface IncomingMessage {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: {
    conversationId?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
}

interface OutgoingResult {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: { ok: boolean; result: unknown; error?: string };
  error?: { code: number; message: string };
}

/**
 * Default socket path. On macOS/Linux this is a real Unix domain socket file
 * under the OS temp dir; on Windows we mint a `\\.\pipe\<name>` form which
 * `net.createServer` understands directly.
 */
function defaultSocketPath(): string {
  const id = `sigma-host-${process.pid}-${randomUUID().slice(0, 8)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${id}.sock`;
  }
  return path.join(os.tmpdir(), `${id}.sock`);
}

export class McpHostBridge {
  private server: net.Server | null = null;
  private readonly socketPath: string;
  private readonly resolveInvoker: () => ToolInvoker | null;
  private started = false;

  constructor(opts: McpHostBridgeOpts) {
    this.socketPath = opts.socketPath ?? defaultSocketPath();
    this.resolveInvoker = opts.resolveInvoker;
  }

  /** The address the spawned stdio MCP server should connect to. */
  getSocketPath(): string {
    return this.socketPath;
  }

  /** Idempotent. Resolves once the server is listening. */
  async start(): Promise<void> {
    if (this.started) return;
    // On unix, clean any stale socket file from a previous crashed instance
    // BEFORE binding. `EADDRINUSE` from a dangling node is annoying to debug;
    // the unlink is fail-soft because the file may legitimately not exist.
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        /* not there — proceed */
      }
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        this.server = server;
        this.started = true;
        resolve();
      });
    });
  }

  /** Tear down the listener and remove the socket file. */
  stop(): void {
    const s = this.server;
    this.server = null;
    this.started = false;
    if (!s) return;
    try {
      s.close();
    } catch {
      /* ignore */
    }
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        /* ignore */
      }
    }
  }

  private handleConnection(socket: net.Socket): void {
    // Newline-delimited JSON-RPC, same wire format as the stdio MCP servers.
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        const trimmed = line.trim();
        if (trimmed) {
          void this.handleLine(trimmed, socket);
        }
      }
    });
    socket.on('error', () => {
      // The MCP server child can disconnect at any time when claude finishes
      // a turn; we don't treat that as a bridge error.
    });
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let req: IncomingMessage;
    try {
      req = JSON.parse(line) as IncomingMessage;
    } catch {
      // Bad framing — drop silently. The child is our own code so this
      // should not happen in practice.
      return;
    }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return;
    const id = req.id ?? null;
    try {
      if (req.method === 'tools.invoke') {
        const invoker = this.resolveInvoker();
        if (!invoker) {
          this.send(socket, {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: 'sigma host: invoker not wired' },
          });
          return;
        }
        const params = req.params ?? {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args =
          params.args && typeof params.args === 'object'
            ? (params.args as Record<string, unknown>)
            : {};
        if (!name) {
          this.send(socket, {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'tools.invoke requires { name }' },
          });
          return;
        }
        const out = await invoker({
          conversationId: params.conversationId,
          name,
          args,
        });
        this.send(socket, { jsonrpc: '2.0', id, result: out });
        return;
      }
      this.send(socket, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(socket, {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message },
      });
    }
  }

  private send(socket: net.Socket, payload: OutgoingResult): void {
    try {
      socket.write(JSON.stringify(payload) + '\n');
    } catch {
      /* socket already closed */
    }
  }
}

// ────────────────────────────────────────────────────────────── temp config ──

export interface SigmaHostMcpDecl {
  serverEntry: string;
  socketPath: string;
  workspaceRoot?: string;
}

/**
 * Write the temp `.mcp.json` the Claude CLI consumes via `--mcp-config`.
 * Prefers `<workspaceRoot>/.claude-flow/sigma-host.mcp.json` so the file
 * lives alongside the rest of our workspace-scoped MCP state, and falls
 * back to `<os.tmpdir()>/sigma-host-<random>.mcp.json` when the workspace
 * directory is not writable (or none was supplied). Returns the path on
 * success or null on failure.
 *
 * The declared server runs `process.execPath` + `[serverEntry]`. Same trick
 * as `mcp-memory-server.cjs`: when SigmaLink is the packaged Electron app,
 * `process.execPath` IS Electron and `ELECTRON_RUN_AS_NODE=1` instructs it
 * to run as plain node. The CLI does not know or care.
 */
export function writeSigmaHostMcpConfig(
  decl: SigmaHostMcpDecl,
  conversationId: string | undefined,
  workspaceId: string | undefined,
): string | null {
  // Verify the bundled server entry actually exists. If the dev forgot to
  // run `pnpm electron:compile` the file is missing and we'd hand the CLI
  // a config it cannot satisfy — better to skip the flag and let Claude
  // run without Sigma tools than to abort the turn entirely.
  if (!fs.existsSync(decl.serverEntry)) return null;

  const config = {
    mcpServers: {
      'sigma-host': {
        type: 'stdio',
        command: process.execPath,
        args: [decl.serverEntry],
        env: {
          // Electron's bundled node, so the CJS file runs as a normal
          // node script — see mcp-supervisor.ts for the same pattern.
          ELECTRON_RUN_AS_NODE: '1',
          SIGMA_HOST_SOCKET: decl.socketPath,
          SIGMA_HOST_AUTOBOOT: '1',
          ...(conversationId ? { SIGMA_CONVERSATION_ID: conversationId } : {}),
          ...(workspaceId ? { SIGMA_WORKSPACE_ID: workspaceId } : {}),
        },
      },
    },
  };

  let target: string | null = null;
  if (decl.workspaceRoot) {
    try {
      const dir = path.join(decl.workspaceRoot, '.claude-flow');
      fs.mkdirSync(dir, { recursive: true });
      target = path.join(dir, 'sigma-host.mcp.json');
    } catch {
      target = null;
    }
  }
  if (!target) {
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-host-mcp-'));
      target = path.join(dir, 'sigma-host.mcp.json');
    } catch {
      return null;
    }
  }

  try {
    fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return target;
  } catch {
    return null;
  }
}
