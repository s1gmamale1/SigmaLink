// Phase 4 Track C — Ruflo MCP supervisor.
//
// Process-singleton manager for the embedded `@claude-flow/cli` MCP server.
// Spawns a single Node child via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`
// out of the lazy-installed runtime under `<userData>/ruflo/`. Multiplexes
// JSON-RPC 2.0 over stdio.
//
// Differences from `MemoryMcpSupervisor`:
//   - One child per app (not per workspace).
//   - Owns the JSON-RPC client (line-buffered stdout reader, in-flight map,
//     per-call timeouts, circuit breaker). The memory supervisor doesn't talk
//     to its children — it just keeps them alive for external CLI clients.
//   - Emits `ruflo:health` on every state transition.
//
// Health states: see ./types.ts.

import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import type { RufloHealth, RufloHealthState } from './types';

/** Restart budget. Three attempts with 500ms / 1500ms / 4500ms backoff. */
const RESTART_BACKOFFS_MS = [500, 1500, 4500] as const;
/** ≥5 consecutive call failures inside any 10s window → mark `degraded`. */
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_WINDOW_MS = 10_000;
/** Default per-call timeout (most tools are sub-second; some pattern stores
 *  take a beat on cold writes). Configurable via `call({ timeoutMs })`. */
const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const ENSURE_READY_TIMEOUT_MS = 5_000;
/** Cap concurrent in-flight JSON-RPC calls to keep stdio backpressure sane. */
const MAX_INFLIGHT = 10;
/** SIGKILL escalation if a graceful SIGTERM doesn't exit within 2s. */
const KILL_ESCALATION_MS = 2_000;

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RufloMcpSupervisorOpts {
  /** Override the install root. Defaults to `<userData>/ruflo`. */
  rufloRoot?: string;
  /** Working dir for the child. Defaults to `<userData>/ruflo-runtime`. */
  cwd?: string;
  /** Bypass the on-disk probe (used by unit tests). */
  forceState?: RufloHealthState;
  /** Override `process.execPath` (for tests). */
  nodeBinary?: string;
}

export interface RufloCallOptions {
  /** Per-call timeout in ms. Falls back to `DEFAULT_CALL_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export class RufloMcpSupervisor extends EventEmitter {
  private _state: RufloHealthState = 'absent';
  private _lastError: string | undefined;
  private _startedAt: number | null = null;
  private _version: string | undefined;
  private child: ChildProcess | null = null;
  private restartCount = 0;
  private shuttingDown = false;
  private rpcId = 0;
  private readonly inflight = new Map<number, PendingCall>();
  private readonly recentFailures: number[] = [];
  private readonly opts: Required<Pick<RufloMcpSupervisorOpts, 'rufloRoot' | 'cwd' | 'nodeBinary'>>;
  private ensureStartedPromise: Promise<RufloHealth> | null = null;

  constructor(opts: RufloMcpSupervisorOpts = {}) {
    super();
    this.opts = {
      rufloRoot: opts.rufloRoot ?? defaultRufloRoot(),
      cwd: opts.cwd ?? defaultRuntimeCwd(),
      nodeBinary: opts.nodeBinary ?? process.execPath,
    };
    if (opts.forceState) {
      this._state = opts.forceState;
    } else {
      this._state = this.probeInstalled() ? 'down' : 'absent';
    }
  }

  /** Public read-only view of the supervisor health. */
  health(): RufloHealth {
    const uptimeMs = this._startedAt ? Date.now() - this._startedAt : undefined;
    return {
      state: this._state,
      lastError: this._lastError,
      pid: this.child?.pid ?? undefined,
      uptimeMs,
      version: this._version,
      runtimePath: this.opts.rufloRoot,
    };
  }

  /** Start the child if not already running. Idempotent. Resolves once the
   *  child has been spawned (NOT after JSON-RPC initialize). */
  async start(): Promise<void> {
    if (this._state === 'absent') {
      // No install on disk — the controller will handle this via a typed
      // `ruflo-unavailable` envelope.
      return;
    }
    if (this.child && !this.child.killed) return;
    this.shuttingDown = false;
    this.transition('starting');
    this.spawnChild();
  }

  /** Start if needed and wait up to 5s for a ready health state. Idempotent. */
  async ensureStarted(): Promise<RufloHealth> {
    if (this._state === 'ready') return this.health();
    if (this._state === 'absent') return this.health();
    if (this.ensureStartedPromise) return this.ensureStartedPromise;

    this.ensureStartedPromise = new Promise<RufloHealth>((resolve) => {
      let done = false;
      const finish = (health: RufloHealth) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('health', onHealth);
        this.ensureStartedPromise = null;
        resolve(health);
      };
      const onHealth = (health: RufloHealth) => {
        if (health.state === 'ready' || health.state === 'absent' || health.state === 'down') {
          finish(health);
        }
      };
      const timer = setTimeout(() => finish(this.health()), ENSURE_READY_TIMEOUT_MS);
      this.on('health', onHealth);
      void this.start()
        .then(() => {
          const health = this.health();
          if (health.state === 'ready' || health.state === 'absent') finish(health);
        })
        .catch((err) => {
          this._lastError = err instanceof Error ? err.message : String(err);
          finish(this.health());
        });
    });
    return this.ensureStartedPromise;
  }

  /** Stop the child (best-effort SIGTERM; SIGKILL after 2s). */
  stop(): void {
    this.shuttingDown = true;
    this.cancelAllInflight('supervisor stopping');
    const c = this.child;
    if (!c) {
      this.transition('down');
      return;
    }
    try {
      c.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (c && !c.killed) {
        try {
          c.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, KILL_ESCALATION_MS);
    this.child = null;
    this._startedAt = null;
    this.transition('down');
  }

  /** Issue a JSON-RPC tool call. Returns the raw `result` payload (or rejects
   *  with the `error` body). Throws synchronously if the supervisor is not
   *  in a callable state. */
  async call<T = unknown>(
    tool: string,
    params: Record<string, unknown> | undefined,
    options: RufloCallOptions = {},
  ): Promise<T> {
    if (this._state !== 'ready') {
      throw new Error(
        `ruflo-unavailable: supervisor state is ${this._state}; cannot call ${tool}`,
      );
    }
    if (this.inflight.size >= MAX_INFLIGHT) {
      throw new Error(`ruflo-unavailable: ${MAX_INFLIGHT} in-flight calls (rate limited)`);
    }
    const c = this.child;
    if (!c || !c.stdin || c.killed) {
      throw new Error('ruflo-unavailable: child process not writable');
    }
    const id = ++this.rpcId;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: tool, arguments: params ?? {} },
    });
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        this.recordFailure();
        reject(new Error(`ruflo-timeout: ${tool} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.inflight.set(id, {
        resolve: (v) => resolve(v as T),
        reject: (err) => reject(err),
        timer,
      });
      try {
        c.stdin!.write(frame + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.inflight.delete(id);
        this.recordFailure();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Reset restart counter + circuit breaker. Called from Settings ›
   *  "Restart Ruflo". */
  reset(): void {
    this.restartCount = 0;
    this.recentFailures.length = 0;
    if (this._state === 'down' || this._state === 'degraded') {
      this._state = this.probeInstalled() ? 'down' : 'absent';
      this.transition(this._state);
    }
  }

  /** Re-probe the install dir. Useful after the installer finishes — the
   *  supervisor flips from `absent` → `down` so `start()` becomes valid. */
  rescanInstall(): void {
    if (this.probeInstalled()) {
      // Read the pinned version from <root>/version.json if present.
      try {
        const vfile = path.join(this.opts.rufloRoot, 'version.json');
        if (fs.existsSync(vfile)) {
          const raw = JSON.parse(fs.readFileSync(vfile, 'utf8')) as { version?: string };
          this._version = typeof raw.version === 'string' ? raw.version : undefined;
        }
      } catch {
        /* version metadata is decorative */
      }
      if (this._state === 'absent') this.transition('down');
    } else if (this._state !== 'absent') {
      this.transition('absent');
    }
  }

  // ────────────────────────────── internals ──────────────────────────────

  private probeInstalled(): boolean {
    try {
      return fs.existsSync(this.serverEntryPath());
    } catch {
      return false;
    }
  }

  private serverEntryPath(): string {
    return path.join(
      this.opts.rufloRoot,
      'node_modules',
      '@claude-flow',
      'cli',
      'bin',
      'mcp-server.js',
    );
  }

  private spawnChild(): void {
    if (this.shuttingDown) return;
    const entry = this.serverEntryPath();
    if (!fs.existsSync(entry)) {
      this._lastError = `mcp-server.js missing at ${entry}`;
      this.transition('absent');
      return;
    }
    try {
      fs.mkdirSync(this.opts.cwd, { recursive: true });
    } catch {
      /* the spawn below will surface the real error */
    }
    let child: ChildProcess;
    try {
      child = spawn(this.opts.nodeBinary, [entry], {
        cwd: this.opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          // Ruflo's HNSW + sona prebuilds resolve from the install dir; pinning
          // NODE_PATH keeps the optionalDependency native binaries reachable.
          NODE_PATH: path.join(this.opts.rufloRoot, 'node_modules'),
          RUFLO_RUNTIME_DIR: this.opts.cwd,
        },
      });
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this._startedAt = Date.now();
    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
    });
    let stdoutBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      // Newline-delimited JSON-RPC frames.
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) this.handleLine(line);
        nl = stdoutBuf.indexOf('\n');
      }
    });
    child.on('error', (err: Error) => {
      this._lastError = err.message;
    });
    child.on('exit', (code, signal) => {
      this.cancelAllInflight(`child exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.child = null;
      this._startedAt = null;
      if (this.shuttingDown) return;
      this._lastError = `exit code=${code ?? 'null'} signal=${signal ?? 'null'} stderr=${stderrBuf.slice(-400)}`;
      this.scheduleRestart();
    });
    // Successful spawn → `ready`. We don't wait for an `initialize` round-trip
    // because `tools/call` will surface its own failure if the child hasn't
    // wired up the tool registry yet. The supervisor's `recordFailure` path
    // demotes us to `degraded` if the calls keep failing.
    this.transition('ready');
  }

  private handleLine(line: string): void {
    let frame: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      // Non-JSON is almost certainly diagnostics; ignore. Upstream's
      // `bin/mcp-server.js` already filters most of these to stderr.
      return;
    }
    if (typeof frame.id !== 'number') return;
    const pending = this.inflight.get(frame.id);
    if (!pending) return;
    this.inflight.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error) {
      this.recordFailure();
      pending.reject(new Error(frame.error.message ?? 'ruflo-error: unknown'));
      return;
    }
    this.recordSuccess();
    pending.resolve(frame.result);
  }

  private cancelAllInflight(reason: string): void {
    for (const [, pending] of this.inflight) {
      clearTimeout(pending.timer);
      try {
        pending.reject(new Error(`ruflo-cancelled: ${reason}`));
      } catch {
        /* ignore */
      }
    }
    this.inflight.clear();
  }

  private scheduleRestart(): void {
    if (this.shuttingDown) return;
    if (this.restartCount >= RESTART_BACKOFFS_MS.length) {
      this.transition('down');
      return;
    }
    const delay = RESTART_BACKOFFS_MS[this.restartCount];
    this.restartCount += 1;
    setTimeout(() => {
      if (!this.shuttingDown) this.spawnChild();
    }, delay);
  }

  private recordFailure(): void {
    const now = Date.now();
    this.recentFailures.push(now);
    // Drop entries older than the window.
    while (
      this.recentFailures.length > 0 &&
      now - this.recentFailures[0] > CIRCUIT_BREAKER_WINDOW_MS
    ) {
      this.recentFailures.shift();
    }
    if (this.recentFailures.length >= CIRCUIT_BREAKER_THRESHOLD) {
      this.transition('degraded');
    }
  }

  private recordSuccess(): void {
    if (this._state === 'degraded') {
      this.recentFailures.length = 0;
      this.transition('ready');
    }
  }

  private transition(next: RufloHealthState): void {
    if (next === this._state) return;
    this._state = next;
    this.emit('health', this.health());
  }
}

function defaultRufloRoot(): string {
  // Lazy-import `electron` so unit tests can construct the supervisor with
  // explicit `opts.rufloRoot` without triggering the electron app bootstrap.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as { app: { getPath(name: string): string } };
  return path.join(app.getPath('userData'), 'ruflo');
}

function defaultRuntimeCwd(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as { app: { getPath(name: string): string } };
  return path.join(app.getPath('userData'), 'ruflo-runtime');
}
