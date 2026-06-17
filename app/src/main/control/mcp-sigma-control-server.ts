// src/main/control/mcp-sigma-control-server.ts
//
// External stdio MCP bridge — spawned by an external MCP client (Claude CLI,
// Hermes, OpenClaw) and connects BACK to SigmaLink's Control MCP socket server
// (src/main/core/control/control-mcp-host.ts) via a unix socket / named pipe.
//
// Architecture:
//
//   External MCP client ──stdio──> THIS SERVER ──unix socket──> SigmaLink main
//    (Claude CLI / Hermes /            (forwards MCP              (ControlMcpHost;
//     OpenClaw spawns this             tools/list,                 forced origin:
//     as its MCP server)               tools/call)                 'external')
//
// Env vars (set by whoever spawns this binary):
//   SIGMA_CONTROL_SOCKET  — unix socket path / Windows named-pipe name
//   SIGMA_CONTROL_TOKEN   — bearer token for control.hello handshake
//   SIGMA_CONTROL_LABEL   — (optional) human label sent in handshake; default 'external'
//
// The bundled CJS file (`electron-dist/mcp-sigma-control-server.cjs`) sets
// SIGMA_CONTROL_AUTOBOOT=1 via an esbuild banner so it auto-boots on direct
// invocation; importing this file from a unit test is side-effect free.

import net from 'node:net';
import process from 'node:process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface HostToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface InvokeOut {
  ok: boolean;
  result: unknown;
  error?: string;
}

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

interface ControlResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Pure mappers (unit-testable, no I/O)
// ---------------------------------------------------------------------------

/**
 * Map the host's tools catalogue (tools.list result) into MCP tool descriptors.
 * Each entry must have name + description + inputSchema.
 */
export function mapCatalogueToMcpTools(entries: HostToolEntry[]): McpToolDescriptor[] {
  return entries.map((e) => ({
    name: e.name,
    description: e.description,
    inputSchema: {
      type: 'object' as const,
      ...(typeof e.inputSchema === 'object' && e.inputSchema !== null ? e.inputSchema : {}),
    },
  }));
}

/**
 * Wrap a host tools.invoke result `{ok, result, error?}` into an MCP tool call
 * response content block.
 */
export function wrapInvokeResult(out: InvokeOut): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} {
  const payload: unknown = out.ok ? out.result : { error: out.error ?? 'unknown error', result: out.result };
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null, null, 2);
  return {
    content: [{ type: 'text', text }],
    isError: !out.ok,
  };
}

// ---------------------------------------------------------------------------
// Control socket client
// ---------------------------------------------------------------------------

interface PendingCall {
  resolve: (value: ControlResponse['result']) => void;
  reject: (err: Error) => void;
}

export class ControlClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private buf = '';
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /** Connect to the control socket and complete the control.hello handshake. */
  async connect(token: string, label: string): Promise<void> {
    await this.ensureSocket();
    const result = await this.rpc('control.hello', { token, label });
    const ok = (result as { ok?: boolean } | null)?.ok;
    if (!ok) throw new Error('control.hello rejected by host');
  }

  /** Send tools.list and return the raw result. */
  async toolsList(): Promise<unknown> {
    return this.rpc('tools.list', {});
  }

  /** Send tools.invoke. Origin is forced server-side; do NOT send it. */
  async toolsInvoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.rpc('tools.invoke', { name, args });
  }

  private async ensureSocket(): Promise<void> {
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
          writeStderr(`control bridge socket error: ${err.message}`);
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

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureSocket();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error('control socket not connected');
    const id = randomUUID();
    const req = { jsonrpc: '2.0', id, method, params };
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
        const resp = JSON.parse(trimmed) as ControlResponse;
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
          `control bridge response parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private onClose(): void {
    this.socket = null;
    for (const [id, p] of this.pending) {
      p.reject(new Error('control socket closed'));
      this.pending.delete(id);
    }
  }

  destroy(): void {
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this.socket = null;
  }
}

// ---------------------------------------------------------------------------
// MCP line handler (exported for unit tests)
// ---------------------------------------------------------------------------

export interface ControlServerDeps {
  client: Pick<ControlClient, 'toolsList' | 'toolsInvoke'>;
  /** Inject a writer (testing). Defaults to stdout. */
  write?: (line: string) => void;
}

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Handle one JSON-RPC line from the MCP client (Claude CLI / Hermes / OpenClaw).
 * Exported so the unit test can drive the server without spawning a child process.
 */
export async function handleControlMcpLine(
  line: string,
  deps: ControlServerDeps,
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
          capabilities: { tools: {} },
          serverInfo: { name: 'sigmalink-control', version: '0.1.0' },
        });
        return;

      case 'initialized':
      case 'notifications/initialized':
        // Notifications — no response required.
        return;

      case 'ping':
        sendResult(deps, id, {});
        return;

      case 'tools/list': {
        const rawResult = await deps.client.toolsList();
        const tools = (rawResult as { tools?: HostToolEntry[] } | null)?.tools ?? [];
        sendResult(deps, id, { tools: mapCatalogueToMcpTools(tools) });
        return;
      }

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
        const raw = await deps.client.toolsInvoke(name, args);
        const out = raw as InvokeOut | null;
        const wrapped = wrapInvokeResult(
          out ?? { ok: false, result: null, error: 'no response from host' },
        );
        sendResult(deps, id, wrapped);
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

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function sendResult(deps: ControlServerDeps, id: number | string | null, result: unknown): void {
  const payload: JsonRpcResponse = { jsonrpc: '2.0', id, result };
  (deps.write ?? writeStdout)(JSON.stringify(payload) + '\n');
}

function sendError(
  deps: ControlServerDeps,
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const socketPath = process.env.SIGMA_CONTROL_SOCKET;
  if (!socketPath) {
    writeStderr('sigma-control: SIGMA_CONTROL_SOCKET env var is required');
    process.exit(1);
  }
  const token = process.env.SIGMA_CONTROL_TOKEN;
  if (!token) {
    writeStderr('sigma-control: SIGMA_CONTROL_TOKEN env var is required');
    process.exit(1);
  }
  const label = process.env.SIGMA_CONTROL_LABEL ?? 'external';

  const client = new ControlClient(socketPath);

  try {
    await client.connect(token, label);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeStderr(`sigma-control: handshake failed: ${msg}`);
    // Write an MCP error before exiting so the spawner sees a well-formed response.
    writeStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: `sigma-control: handshake failed: ${msg}` },
      }) + '\n',
    );
    process.exit(1);
  }

  const deps: ControlServerDeps = { client };

  let pending = 0;
  let stdinClosed = false;
  const checkExit = (): void => {
    if (stdinClosed && pending === 0) {
      client.destroy();
      process.exit(0);
    }
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line: string) => {
    pending += 1;
    handleControlMcpLine(line, deps)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        writeStderr('sigma-control line handler crashed: ' + message);
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

/**
 * The bundled CJS file sets SIGMA_CONTROL_AUTOBOOT=1 via an esbuild banner.
 * Without that, importing this file from a unit test is side-effect free.
 */
if (process.env.SIGMA_CONTROL_AUTOBOOT === '1') {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    writeStderr('sigma-control failed to start: ' + message);
    process.exit(1);
  });
}
