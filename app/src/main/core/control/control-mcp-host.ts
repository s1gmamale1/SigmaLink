// src/main/core/control/control-mcp-host.ts
//
// External Control MCP Host — a net socket server in MAIN that accepts
// connections from the external stdio bridge (mcp-sigma-control-server.cjs).
// Mirrors mcp-host-sigma.ts but: (a) requires a token handshake, (b) FORCES
// origin:'external' on every forwarded call (a client cannot claim 'local'),
// (c) is kill-switch aware, (d) injects an escalation confirmDangerous.
// Stateless per-connection except a live-socket Set for clean teardown — MAIN
// spawns NO child per client (the bridge is the client's child) -> leak-safe.

import * as net from 'node:net';
import * as fs from 'node:fs';
import { tokenEquals } from './control-config';
import { isExternallyListed } from './authz-external';

/** The protocol version this host implements. Clients advertising a higher version are rejected. */
const SIGMA_CONTROL_PROTOCOL = 1;
const MIN_PROTOCOL = 1;

export interface ExternalToolInvoker {
  (input: {
    name: string;
    args: Record<string, unknown>;
    origin: 'external';
    confirmDangerous: (toolName: string, summary: string) => Promise<boolean>;
    /** Task 4 — label of the connecting client (used to key one-shot grants). */
    clientLabel?: string;
  }): Promise<{ ok: boolean; result: unknown; error?: string }>;
}

export interface ControlMcpHostOpts {
  socketPath: string;
  getToken: () => string | null;
  isFrozen: () => boolean;
  resolveInvoker: () => ExternalToolInvoker | null;
  /** Route a dangerous-action confirmation to the operator; resolve true to allow. */
  escalate: (toolName: string, summary: string, clientLabel: string) => Promise<boolean>;
  /** Optional catalogue provider for tools/list (the external-exposed subset). */
  getCatalogue?: () => unknown[];
  /** Destroy a socket that hasn't completed control.hello within this window (default 10s). */
  handshakeTimeoutMs?: number;
  /** Max bytes buffered before a newline before the connection is dropped (default 1 MiB). */
  maxLineBytes?: number;
}

interface IncomingMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class ControlMcpHost {
  private server: net.Server | null = null;
  private started = false;
  private readonly live = new Set<net.Socket>();
  private readonly authed = new WeakMap<net.Socket, { label: string }>();
  private readonly handshakeTimers = new Map<net.Socket, ReturnType<typeof setTimeout>>();
  private readonly opts: ControlMcpHostOpts;

  constructor(opts: ControlMcpHostOpts) {
    this.opts = opts;
  }

  getSocketPath(): string { return this.opts.socketPath; }
  liveConnectionCount(): number { return this.live.size; }

  async start(): Promise<void> {
    if (this.started) return;
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.opts.socketPath); } catch { /* not there */ }
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once('error', reject);
      server.listen(this.opts.socketPath, () => { server.off('error', reject); this.server = server; this.started = true; resolve(); });
    });
  }

  stop(): void {
    const s = this.server;
    this.server = null;
    this.started = false;
    for (const t of this.handshakeTimers.values()) { try { clearTimeout(t); } catch { /* ignore */ } }
    this.handshakeTimers.clear();
    for (const sock of [...this.live]) { try { sock.destroy(); } catch { /* ignore */ } }
    this.live.clear();
    if (s) { try { s.close(); } catch { /* ignore */ } }
    if (process.platform !== 'win32') { try { fs.unlinkSync(this.opts.socketPath); } catch { /* ignore */ } }
  }

  private handleConnection(socket: net.Socket): void {
    this.live.add(socket);
    let buf = '';
    const maxBytes = this.opts.maxLineBytes ?? 1 << 20;
    // Drop a socket that connects but never completes the handshake (stuck
    // listener / resource hold).
    const hsTimer = setTimeout(() => {
      if (!this.authed.has(socket)) { try { socket.destroy(); } catch { /* ignore */ } }
    }, this.opts.handshakeTimeoutMs ?? 10_000);
    this.handshakeTimers.set(socket, hsTimer);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      // Cap the pre-newline buffer (a client streaming bytes with no newline
      // would otherwise grow `buf` unbounded — local memory-exhaustion path).
      if (buf.length > maxBytes) {
        this.send(socket, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'line too large' } });
        buf = '';
        try { socket.destroy(); } catch { /* ignore */ }
        return;
      }
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (line) void this.handleLine(line, socket);
      }
    });
    socket.on('close', () => this.cleanupSocket(socket));
    socket.on('error', () => this.cleanupSocket(socket));
  }

  private cleanupSocket(socket: net.Socket): void {
    const t = this.handshakeTimers.get(socket);
    if (t) { clearTimeout(t); this.handshakeTimers.delete(socket); }
    this.live.delete(socket);
  }

  private send(socket: net.Socket, payload: unknown): void {
    try { socket.write(JSON.stringify(payload) + '\n'); } catch { /* closed */ }
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let req: IncomingMessage;
    try { req = JSON.parse(line) as IncomingMessage; } catch { return; }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return;
    const id = req.id ?? null;
    const params = req.params ?? {};

    if (req.method === 'control.hello') {
      const token = this.opts.getToken();
      const provided = typeof params.token === 'string' ? params.token : '';
      const label = typeof params.label === 'string' ? params.label.slice(0, 64) : 'external';
      if (!token || !tokenEquals(provided, token)) {
        this.send(socket, { jsonrpc: '2.0', id, error: { code: -32001, message: 'unauthorized' } });
        socket.destroy();
        return;
      }
      // Protocol range check: absent/non-number → floor (accept); number outside [MIN,MAX] → reject.
      const protocol = params.protocol;
      if (typeof protocol === 'number' && (protocol > SIGMA_CONTROL_PROTOCOL || protocol < MIN_PROTOCOL)) {
        this.send(socket, { jsonrpc: '2.0', id, error: { code: -32003, message: `protocol v${protocol} unsupported; host accepts [${MIN_PROTOCOL},${SIGMA_CONTROL_PROTOCOL}]` } });
        socket.destroy();
        return;
      }
      this.authed.set(socket, { label });
      const t = this.handshakeTimers.get(socket);
      if (t) { clearTimeout(t); this.handshakeTimers.delete(socket); }
      this.send(socket, { jsonrpc: '2.0', id, result: { ok: true } });
      return;
    }

    const session = this.authed.get(socket);
    if (!session) {
      this.send(socket, { jsonrpc: '2.0', id, error: { code: -32002, message: 'handshake required (call control.hello first)' } });
      return;
    }
    if (this.opts.isFrozen()) {
      this.send(socket, { jsonrpc: '2.0', id, error: { code: -32010, message: 'control is frozen (kill-switch engaged)' } });
      return;
    }

    if (req.method === 'tools.list') {
      const all = this.opts.getCatalogue?.() ?? [];
      // Filter to the external-safe subset so shell/exec/write tools added in future
      // don't silently leak to external clients (isExternallyListed is the single source
      // of truth in authz-external.ts).
      const tools = (all as Array<{ name: string }>).filter((t) => isExternallyListed(t.name));
      this.send(socket, { jsonrpc: '2.0', id, result: { tools } });
      return;
    }
    if (req.method === 'tools.invoke') {
      const invoker = this.opts.resolveInvoker();
      if (!invoker) { this.send(socket, { jsonrpc: '2.0', id, error: { code: -32000, message: 'control host: invoker not wired' } }); return; }
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.args && typeof params.args === 'object' ? (params.args as Record<string, unknown>) : {};
      if (!name) { this.send(socket, { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools.invoke requires { name }' } }); return; }
      try {
        const out = await invoker({
          name,
          args,
          origin: 'external',
          confirmDangerous: (toolName, summary) => this.opts.escalate(toolName, summary, session.label),
          clientLabel: session.label,
        });
        this.send(socket, { jsonrpc: '2.0', id, result: out });
      } catch (err) {
        this.send(socket, { jsonrpc: '2.0', id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
      }
      return;
    }
    this.send(socket, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
}
