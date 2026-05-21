// Per-workspace Ruflo HTTP daemon supervisor.
//
// Manages one `ruflo mcp start -t http` child process per workspace. Unlike
// `RufloMcpSupervisor` (which is a process-singleton stdio server), this
// supervisor starts independent HTTP daemons bound to dynamic loopback ports
// so each workspace gets its own isolated endpoint — no PID-file collisions.
//
// Lifecycle:
//   • spawn() — allocate port, launch daemon, health-probe until ready
//   • crash recovery — linear backoff (1.5s / 4.5s / 13.5s); 3 attempts max
//   • stop() — SIGTERM, wait 5s, SIGKILL
//   • emits 'restarted' (workspaceId, success) after each recovery cycle

import { EventEmitter } from 'node:events';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

// ── constants ────────────────────────────────────────────────────────────────

/** Linear backoff delays for crash recovery (ms). */
const RESPAWN_DELAYS_MS = [1_500, 4_500, 13_500] as const;
const MAX_RESTARTS = RESPAWN_DELAYS_MS.length;

/** Health-probe schedule: 200ms / 500ms / 1s / 2s / 5s / then 5s steady. */
const PROBE_SCHEDULE_MS = [200, 500, 1_000, 2_000, 5_000] as const;
const PROBE_STEADY_MS = 5_000;
const SPAWN_TIMEOUT_MS = 10_000;

/** SIGKILL escalation if SIGTERM does not exit within 5s. */
const KILL_ESCALATION_MS = 5_000;

// ── public types ─────────────────────────────────────────────────────────────

export type DaemonStatus = 'starting' | 'running' | 'crashed' | 'down';

export interface DaemonHandle {
  pid: number;
  port: number;
  workspaceRoot: string;
  status: DaemonStatus;
  restartCount: number;
  startedAt: number;
}

export interface RufloHttpDaemonSupervisorOpts {
  /** Override binary name / path (for tests). Defaults to 'ruflo'. */
  binary?: string;
}

// ── internal entry ───────────────────────────────────────────────────────────

interface DaemonEntry {
  workspaceId: string;
  workspaceRoot: string;
  port: number;
  child: ChildProcess | null;
  pid: number;
  status: DaemonStatus;
  restartCount: number;
  startedAt: number;
  shuttingDown: boolean;
  /** Resolve/reject the current spawn() Promise (if still waiting for health). */
  spawnResolve: ((h: DaemonHandle) => void) | null;
  spawnReject: ((e: Error) => void) | null;
  spawnTimer: NodeJS.Timeout | null;
}

// ── supervisor ───────────────────────────────────────────────────────────────

export class RufloHttpDaemonSupervisor extends EventEmitter {
  private readonly entries = new Map<string, DaemonEntry>();
  private readonly binary: string;

  constructor(opts: RufloHttpDaemonSupervisorOpts = {}) {
    super();
    this.binary = opts.binary ?? 'ruflo';
  }

  /**
   * Spawn an HTTP daemon for the given workspace.
   * - Returns the existing handle if it is already 'running'.
   * - Stops + re-spawns if status is 'crashed' or 'down'.
   * - Resolves once the daemon passes the /health probe (or rejects on timeout).
   */
  async spawn(workspaceId: string, workspaceRoot: string): Promise<DaemonHandle | null> {
    const existing = this.entries.get(workspaceId);

    // Already starting / running — return immediately.
    if (existing && (existing.status === 'starting' || existing.status === 'running')) {
      if (existing.status === 'running') {
        return this.handleFor(existing);
      }
      // Still starting — wait for the existing spawn Promise.
      return new Promise<DaemonHandle | null>((resolve, reject) => {
        // Piggy-back: if the entry resolves, we resolve; if it rejects, reject.
        const origResolve = existing.spawnResolve;
        const origReject = existing.spawnReject;
        existing.spawnResolve = (h) => {
          origResolve?.(h);
          resolve(h);
        };
        existing.spawnReject = (e) => {
          origReject?.(e);
          reject(e);
        };
      });
    }

    // 'crashed' or 'down' — clean up first.
    if (existing) {
      await this.stop(workspaceId);
    }

    // Binary detection.
    if (!this.binaryAvailable()) {
      console.warn('[ruflo-http] ruflo binary not found in PATH — HTTP daemon not started');
      return null;
    }

    // Allocate a free port.
    const port = await allocatePort();

    const entry: DaemonEntry = {
      workspaceId,
      workspaceRoot,
      port,
      child: null,
      pid: 0,
      status: 'starting',
      restartCount: 0,
      startedAt: Date.now(),
      shuttingDown: false,
      spawnResolve: null,
      spawnReject: null,
      spawnTimer: null,
    };
    this.entries.set(workspaceId, entry);

    return this.doSpawn(entry);
  }

  /** Stop the daemon for a workspace (SIGTERM → wait → SIGKILL). */
  async stop(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    entry.shuttingDown = true;
    this.cancelSpawnWait(entry, new Error('[ruflo-http] stop() called'));
    await killChild(entry.child);
    entry.child = null;
    this.entries.delete(workspaceId);
  }

  /** Stop all managed daemons. */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.entries.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /**
   * Stop then re-spawn the daemon for a workspace.
   * Equivalent to stop() followed by spawn().
   */
  async restart(workspaceId: string): Promise<DaemonHandle | null> {
    const entry = this.entries.get(workspaceId);
    const workspaceRoot = entry?.workspaceRoot;
    await this.stop(workspaceId);
    if (!workspaceRoot) return null;
    return this.spawn(workspaceId, workspaceRoot);
  }

  /** Current status for a workspace, or null if not tracked. */
  status(workspaceId: string): DaemonStatus | null {
    return this.entries.get(workspaceId)?.status ?? null;
  }

  /** Allocated port for a workspace, or null if not running. */
  port(workspaceId: string): number | null {
    const entry = this.entries.get(workspaceId);
    if (!entry || entry.status !== 'running') return null;
    return entry.port;
  }

  /**
   * Returns a snapshot of all tracked daemon handles.
   * Callers use this to populate the Settings → Ruflo daemon table.
   */
  list(): DaemonHandle[] {
    return Array.from(this.entries.values()).map((e) => this.handleFor(e));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private binaryAvailable(): boolean {
    try {
      execSync(`command -v ${this.binary}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Actually spawn the child and start the health-probe loop.
   * Returns a Promise that resolves/rejects when health is confirmed or timeout fires.
   */
  private doSpawn(entry: DaemonEntry): Promise<DaemonHandle | null> {
    return new Promise<DaemonHandle | null>((resolve, reject) => {
      if (entry.shuttingDown) {
        resolve(null);
        return;
      }

      entry.spawnResolve = resolve;
      entry.spawnReject = reject;

      // Spawn timeout.
      entry.spawnTimer = setTimeout(() => {
        if (entry.status !== 'running') {
          entry.status = 'down';
          this.cancelSpawnWait(
            entry,
            new Error(`[ruflo-http] daemon did not become healthy within ${SPAWN_TIMEOUT_MS}ms`),
          );
        }
      }, SPAWN_TIMEOUT_MS);

      let child: ChildProcess;
      try {
        child = spawn(
          this.binary,
          ['mcp', 'start', '-t', 'http', '-p', String(entry.port), '--host', '127.0.0.1'],
          {
            env: { ...process.env, CLAUDE_FLOW_CWD: entry.workspaceRoot },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ruflo-http] spawn() threw: ${msg}`);
        entry.status = 'crashed';
        this.cancelSpawnWait(entry, new Error(`[ruflo-http] spawn failed: ${msg}`));
        return;
      }

      entry.child = child;
      entry.pid = child.pid ?? 0;
      entry.startedAt = Date.now();

      // Pipe stderr for diagnostics.
      let stderrBuf = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > 8_000) stderrBuf = stderrBuf.slice(-4_000);
      });

      // Drain stdout (daemon writes HTTP server logs there; we don't parse them).
      child.stdout?.on('data', () => {
        /* drain */
      });

      child.on('error', (err: Error) => {
        console.warn(`[ruflo-http] child error (ws=${entry.workspaceId}): ${err.message}`);
      });

      child.on('exit', (code, signal) => {
        entry.child = null;
        if (entry.shuttingDown) return;

        const reason = `exit code=${code ?? 'null'} signal=${signal ?? 'null'} stderr=${stderrBuf.slice(-400)}`;
        console.warn(`[ruflo-http] daemon exited (ws=${entry.workspaceId}): ${reason}`);

        // If still starting (health not yet confirmed), cancel the spawn wait.
        if (entry.status === 'starting') {
          entry.status = 'crashed';
          this.cancelSpawnWait(
            entry,
            new Error(`[ruflo-http] daemon exited during startup: ${reason}`),
          );
          return;
        }

        // Was running — schedule crash recovery.
        entry.status = 'crashed';
        this.scheduleCrashRecovery(entry);
      });

      // Begin health probing.
      this.probeHealth(entry, 0);
    });
  }

  /**
   * Probe GET http://127.0.0.1:<port>/health with exponential-then-steady schedule.
   * On first 200+{"status":"ok"} → mark running + resolve spawn promise.
   */
  private probeHealth(entry: DaemonEntry, attempt: number): void {
    if (entry.shuttingDown || entry.status === 'down') return;

    const delay =
      attempt < PROBE_SCHEDULE_MS.length
        ? PROBE_SCHEDULE_MS[attempt]!
        : PROBE_STEADY_MS;

    setTimeout(() => {
      if (entry.shuttingDown || entry.status === 'down') return;

      httpGet(`http://127.0.0.1:${entry.port}/health`)
        .then((body) => {
          // Validate: must contain `"status":"ok"` (loose check).
          const ok =
            typeof body === 'string'
              ? body.includes('"ok"') || body.includes("'ok'")
              : false;

          if (ok && entry.status === 'starting') {
            entry.status = 'running';
            console.info(
              `[ruflo-http] daemon ready (ws=${entry.workspaceId} port=${entry.port} pid=${entry.pid})`,
            );
            const h = this.handleFor(entry);
            this.resolveSpawnWait(entry, h);
          } else if (entry.status === 'starting') {
            // Not yet ok — keep probing.
            this.probeHealth(entry, attempt + 1);
          }
        })
        .catch(() => {
          if (entry.status === 'starting') {
            this.probeHealth(entry, attempt + 1);
          }
        });
    }, delay);
  }

  /**
   * After a crash, schedule a respawn with linear backoff.
   * After MAX_RESTARTS failures → mark 'down', emit 'restarted' with success=false.
   */
  private scheduleCrashRecovery(entry: DaemonEntry): void {
    if (entry.shuttingDown) return;

    if (entry.restartCount >= MAX_RESTARTS) {
      entry.status = 'down';
      console.warn(
        `[ruflo-http] giving up after ${MAX_RESTARTS} restarts (ws=${entry.workspaceId})`,
      );
      this.emit('restarted', entry.workspaceId, false);
      return;
    }

    const delay = RESPAWN_DELAYS_MS[entry.restartCount]!;
    entry.restartCount += 1;

    console.info(
      `[ruflo-http] scheduling restart ${entry.restartCount}/${MAX_RESTARTS} in ${delay}ms (ws=${entry.workspaceId})`,
    );

    setTimeout(() => {
      if (entry.shuttingDown) return;

      // Reset status + probe promise before re-launching.
      entry.status = 'starting';
      entry.spawnResolve = null;
      entry.spawnReject = null;
      entry.spawnTimer = null;

      const child = this.launchChild(entry);
      if (!child) {
        entry.status = 'down';
        this.emit('restarted', entry.workspaceId, false);
        return;
      }

      entry.child = child;
      entry.pid = child.pid ?? 0;
      entry.startedAt = Date.now();

      // Set up a health-probe-only path (no external promise to resolve —
      // the original spawn() caller has already received a rejection or is gone).
      let recoveryDone = false;
      const probeRecovery = (attempt: number) => {
        if (entry.shuttingDown || recoveryDone) return;
        const delay2 =
          attempt < PROBE_SCHEDULE_MS.length
            ? PROBE_SCHEDULE_MS[attempt]!
            : PROBE_STEADY_MS;
        setTimeout(() => {
          if (entry.shuttingDown || recoveryDone) return;
          httpGet(`http://127.0.0.1:${entry.port}/health`)
            .then((body) => {
              const ok =
                typeof body === 'string'
                  ? body.includes('"ok"') || body.includes("'ok'")
                  : false;
              if (ok) {
                recoveryDone = true;
                entry.status = 'running';
                console.info(
                  `[ruflo-http] daemon recovered (ws=${entry.workspaceId} restart=${entry.restartCount})`,
                );
                this.emit('restarted', entry.workspaceId, true);
              } else {
                probeRecovery(attempt + 1);
              }
            })
            .catch(() => probeRecovery(attempt + 1));
        }, delay2);
      };

      // Wire exit for this recovery child.
      let stderrBuf2 = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf2 += chunk.toString('utf8');
        if (stderrBuf2.length > 8_000) stderrBuf2 = stderrBuf2.slice(-4_000);
      });
      child.on('exit', (code, signal) => {
        entry.child = null;
        if (entry.shuttingDown) return;
        if (recoveryDone) return; // already emitted success
        const reason = `exit code=${code ?? 'null'} signal=${signal ?? 'null'} stderr=${stderrBuf2.slice(-400)}`;
        console.warn(
          `[ruflo-http] recovery child exited (ws=${entry.workspaceId}): ${reason}`,
        );
        entry.status = 'crashed';
        recoveryDone = true; // prevent further probes for this cycle
        this.scheduleCrashRecovery(entry);
      });

      probeRecovery(0);
    }, delay);
  }

  /**
   * Helper: spawn the child process without setting up a full Promise chain.
   * Returns null if spawn throws.
   */
  private launchChild(entry: DaemonEntry): ChildProcess | null {
    try {
      return spawn(
        this.binary,
        ['mcp', 'start', '-t', 'http', '-p', String(entry.port), '--host', '127.0.0.1'],
        {
          env: { ...process.env, CLAUDE_FLOW_CWD: entry.workspaceRoot },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch (err) {
      console.warn(
        `[ruflo-http] launchChild() threw (ws=${entry.workspaceId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private cancelSpawnWait(entry: DaemonEntry, err: Error): void {
    if (entry.spawnTimer) {
      clearTimeout(entry.spawnTimer);
      entry.spawnTimer = null;
    }
    const rej = entry.spawnReject;
    entry.spawnResolve = null;
    entry.spawnReject = null;
    rej?.(err);
  }

  private resolveSpawnWait(entry: DaemonEntry, handle: DaemonHandle): void {
    if (entry.spawnTimer) {
      clearTimeout(entry.spawnTimer);
      entry.spawnTimer = null;
    }
    const res = entry.spawnResolve;
    entry.spawnResolve = null;
    entry.spawnReject = null;
    res?.(handle);
  }

  private handleFor(entry: DaemonEntry): DaemonHandle {
    return {
      pid: entry.pid,
      port: entry.port,
      workspaceRoot: entry.workspaceRoot,
      status: entry.status,
      restartCount: entry.restartCount,
      startedAt: entry.startedAt,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Allocate a free loopback port by binding to :0. */
function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(p);
      });
    });
    server.on('error', reject);
  });
}

/** HTTP GET helper. Resolves with the response body string on 2xx, rejects otherwise. */
function httpGet(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(3_000, () => {
      req.destroy(new Error('request timeout'));
    });
  });
}

/** Send SIGTERM; after KILL_ESCALATION_MS send SIGKILL if still alive. */
async function killChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  await new Promise<void>((resolve) => {
    const escalate = setTimeout(() => {
      if (!child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      resolve();
    }, KILL_ESCALATION_MS);
    child.once('exit', () => {
      clearTimeout(escalate);
      resolve();
    });
  });
}
