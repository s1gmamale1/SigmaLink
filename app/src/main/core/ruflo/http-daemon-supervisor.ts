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
import { execFileSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { defaultRufloRoot } from './installer';
import { spawnExecutable } from '../util/spawn-cross-platform';

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
  /** Result of the last store→search round-trip health probe. undefined = not yet run. */
  roundTrip?: boolean;
}

export interface RufloHttpDaemonSupervisorOpts {
  /**
   * Force a specific launcher binary (for tests). When set, it is used verbatim
   * with NO `npx` package prefix and NO resolution — the supervisor trusts it.
   * When omitted, the supervisor resolves a launcher at spawn time (PATH `ruflo`
   * → lazy-installed `<userData>/ruflo` CLI); see {@link resolveLaunch}.
   */
  binary?: string;
  /**
   * Override the lazy-install root (`<userData>/ruflo`) the supervisor probes
   * for a bundled-offline `@claude-flow/cli` (SF-14). Tests point this at a
   * temp dir; production lets it default to {@link defaultRufloRoot}.
   */
  rufloRoot?: string;
}

/** The daemon subcommand + flags appended after the launcher prefix. Port/host
 *  are filled in per-spawn. */
const DAEMON_SUBCOMMAND = ['mcp', 'start', '-t', 'http'] as const;

/**
 * A resolved way to launch the Ruflo daemon: a command plus any prefix args
 * that must precede the daemon subcommand. For PATH `ruflo` the prefix is empty;
 * for the userData-CLI tier the prefix carries the bundled `cli.js` entry.
 */
interface LaunchSpec {
  command: string;
  prefixArgs: string[];
  /** Human label for diagnostics ('ruflo (PATH)', 'userData @claude-flow/cli', …). */
  label: string;
  /** Extra env merged into the daemon spawn — used by the userData-CLI tier to
   *  run via Electron's embedded node (ELECTRON_RUN_AS_NODE + NODE_PATH). */
  env?: Record<string, string>;
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
  /** Result of the last store→search round-trip health probe. undefined = not yet run. */
  roundTrip?: boolean;
  /** Resolve/reject the current spawn() Promise (if still waiting for health). */
  spawnResolve: ((h: DaemonHandle) => void) | null;
  spawnReject: ((e: Error) => void) | null;
  spawnTimer: NodeJS.Timeout | null;
  /** The launcher resolved at spawn time — reused verbatim across restarts. */
  launch: LaunchSpec;
}

// ── supervisor ───────────────────────────────────────────────────────────────

export class RufloHttpDaemonSupervisor extends EventEmitter {
  private readonly entries = new Map<string, DaemonEntry>();
  /** When set (tests), the supervisor uses this binary verbatim and skips
   *  PATH/npx resolution. */
  private readonly forcedBinary: string | undefined;
  /** Override for the lazy-install root; undefined → resolve {@link defaultRufloRoot}
   *  lazily (so constructing the supervisor never requires electron). */
  private readonly rufloRootOverride: string | undefined;

  constructor(opts: RufloHttpDaemonSupervisorOpts = {}) {
    super();
    this.forcedBinary = opts.binary;
    this.rufloRootOverride = opts.rufloRoot;
  }

  /**
   * Path to the lazy-installed `@claude-flow/cli` entry under `<userData>/ruflo`
   * (SF-14), or null when not installed. Mirrors RufloMcpSupervisor's install
   * layout; the daemon runs it via Electron's embedded node. Resolving the
   * default root is lazy + fail-safe so a missing/unavailable electron (tests)
   * never throws here — it just means "no userData CLI".
   */
  private userDataCliEntry(): { entry: string; nodeModules: string } | null {
    let root = this.rufloRootOverride;
    if (!root) {
      try {
        root = defaultRufloRoot();
      } catch {
        return null;
      }
    }
    const nodeModules = path.join(root, 'node_modules');
    const entry = path.join(nodeModules, '@claude-flow', 'cli', 'bin', 'cli.js');
    try {
      return fs.existsSync(entry) ? { entry, nodeModules } : null;
    } catch {
      return null;
    }
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

    // Launcher resolution (SF-14). Prefer PATH `ruflo`; then the lazy-installed
    // userData `@claude-flow/cli` (offline, no network). When NEITHER resolves
    // the daemon is unavailable — and we say so LOUDLY (distinct message) so the
    // operator understands why live cross-pane HTTP state is degraded. We do NOT
    // fall through to `npx -y @claude-flow/cli@latest`: that auto-downloads from
    // the network during the awaited workspace open (see resolveLaunch). Panes
    // still get a working stdio MCP via the per-worktree autowrite (SF-15).
    const launch = this.resolveLaunch();
    if (!launch) {
      console.warn(
        '[ruflo-http] DAEMON UNAVAILABLE: no `ruflo` on PATH and no lazy-installed ' +
          '@claude-flow/cli under userData — the per-workspace HTTP daemon cannot ' +
          'start. Panes fall back to per-process stdio MCP (no live daemon health, ' +
          'no shared HTTP state). Install Ruflo (Settings → Ruflo) to enable the daemon.',
      );
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
      launch,
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

  /**
   * Full handle snapshot for a workspace including the round-trip probe result.
   * Returns null if the workspace is not tracked.
   */
  statusDetail(workspaceId: string): DaemonHandle | null {
    const entry = this.entries.get(workspaceId);
    if (!entry) return null;
    return this.handleFor(entry);
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

  /**
   * Resolve a launcher for the daemon (SF-14).
   *   1. A forced binary (tests) → used verbatim, no prefix, no PATH probe.
   *   2. PATH `ruflo`            → `ruflo mcp start -t http …`.
   *   3. userData `@claude-flow/cli` (lazy-installed) → Electron-node runs
   *      `<userData>/ruflo/.../bin/cli.js mcp start -t http …` offline.
   * Tier 3 closes the SF-14 first-run-network gap: once the CLI is installed
   * under userData, production (which has no PATH `ruflo`) runs the pinned
   * local copy instead of depending on npx/network — so claude/codex panes get
   * a working Ruflo MCP daemon offline. Returns null when none resolve.
   *
   * There is intentionally NO `npx -y @claude-flow/cli@latest` fall-through:
   * `npx -y` AUTO-DOWNLOADS the package from the network, and `spawn()` is
   * AWAITED during `workspaces.open` (factory.ts). With the crash-restart loop
   * that meant several concurrent network downloads on every open of a no-ruflo
   * machine → CI runner saturation → the dogfood e2e hung to its 180s timeout.
   * Auto-downloading a package during workspace open was never acceptable; when
   * ruflo is resolvable via neither PATH nor userData we return null so the
   * existing stdio fallback in factory.ts takes over (panes still get a working
   * per-CLI stdio MCP via the autowrite, SF-15).
   */
  private resolveLaunch(): LaunchSpec | null {
    if (this.forcedBinary) {
      return { command: this.forcedBinary, prefixArgs: [], label: this.forcedBinary };
    }
    if (commandOnPath('ruflo')) {
      return { command: 'ruflo', prefixArgs: [], label: 'ruflo (PATH)' };
    }
    const cli = this.userDataCliEntry();
    if (cli) {
      return {
        command: process.execPath,
        prefixArgs: [cli.entry],
        label: 'userData @claude-flow/cli',
        // Run via Electron's embedded node; pin NODE_PATH so the CLI's native
        // optionalDeps (HNSW/neural) resolve from the install dir. Mirrors
        // RufloMcpSupervisor.spawnChild().
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          NODE_PATH: cli.nodeModules,
        },
      };
    }
    return null;
  }

  /**
   * Build the full argv for a daemon spawn: launcher prefix + daemon subcommand
   * + the per-spawn port/host. Centralised so doSpawn() and launchChild() can't
   * drift apart.
   */
  private daemonArgs(entry: DaemonEntry): string[] {
    return [
      ...entry.launch.prefixArgs,
      ...DAEMON_SUBCOMMAND,
      '-p',
      String(entry.port),
      '--host',
      '127.0.0.1',
    ];
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
        child = spawnExecutable(entry.launch.command, this.daemonArgs(entry), {
          env: {
            ...process.env,
            CLAUDE_FLOW_CWD: entry.workspaceRoot,
            CLAUDE_FLOW_DIR: path.join(entry.workspaceRoot, '.claude-flow'),
            // userData-CLI tier carries ELECTRON_RUN_AS_NODE + NODE_PATH; PATH
            // `ruflo`/npx tiers carry none. Merged last so the launcher wins.
            ...(entry.launch.env ?? {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
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

      // BUG-2 — wire stderr buffering + stdout drain via the shared helper so
      // this path and the crash-recovery path can't drift (stdout MUST be
      // drained or the daemon deadlocks on a full pipe).
      const { getStderrTail } = this.wireChildIo(child);

      child.on('error', (err: Error) => {
        console.warn(`[ruflo-http] child error (ws=${entry.workspaceId}): ${err.message}`);
      });

      child.on('exit', (code, signal) => {
        entry.child = null;
        if (entry.shuttingDown) return;

        const reason = `exit code=${code ?? 'null'} signal=${signal ?? 'null'} stderr=${getStderrTail().slice(-400)}`;

        // If still starting (health not yet confirmed), cancel the spawn wait.
        if (entry.status === 'starting') {
          // B4 — a CLEAN exit (code 0) before /health ever succeeded means the
          // installed CLI does not actually support HTTP server-mode (it ran the
          // command, then exited normally instead of serving). Retrying can never
          // succeed, so classify it as "HTTP mode unsupported", do NOT schedule
          // crash recovery, and log ONCE at info (not warn-spam per open). Panes
          // still get a working stdio MCP via the per-worktree autowrite (SF-15).
          if (code === 0) {
            entry.status = 'down';
            console.info(
              `[ruflo-http] HTTP mode unsupported by the installed @claude-flow/cli ` +
                `(ws=${entry.workspaceId}): daemon exited cleanly before /health came up. ` +
                `Skipping crash-recovery; panes use stdio MCP. ${reason}`,
            );
            this.cancelSpawnWait(
              entry,
              new Error(`[ruflo-http] HTTP mode unsupported (clean exit during startup): ${reason}`),
            );
            return;
          }
          console.warn(`[ruflo-http] daemon exited (ws=${entry.workspaceId}): ${reason}`);
          entry.status = 'crashed';
          this.cancelSpawnWait(
            entry,
            new Error(`[ruflo-http] daemon exited during startup: ${reason}`),
          );
          return;
        }

        // Was running — schedule crash recovery.
        console.warn(`[ruflo-http] daemon exited (ws=${entry.workspaceId}): ${reason}`);
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
            // Non-fatal round-trip probe; run after promise resolves.
            void this.roundTripProbe(entry);
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

      // BUG-2 — wire stderr buffering AND the stdout drain via the same shared
      // helper as doSpawn(). The recovery child previously wired only stderr +
      // exit, leaving stdout undrained → a recovered daemon that logged enough
      // filled the pipe and silently wedged. The helper guarantees parity.
      const { getStderrTail } = this.wireChildIo(child);
      child.on('exit', (code, signal) => {
        entry.child = null;
        if (entry.shuttingDown) return;
        if (recoveryDone) return; // already emitted success
        const reason = `exit code=${code ?? 'null'} signal=${signal ?? 'null'} stderr=${getStderrTail().slice(-400)}`;
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
      return spawnExecutable(entry.launch.command, this.daemonArgs(entry), {
        env: {
          ...process.env,
          CLAUDE_FLOW_CWD: entry.workspaceRoot,
          CLAUDE_FLOW_DIR: path.join(entry.workspaceRoot, '.claude-flow'),
          // Must mirror doSpawn(): the userData-CLI tier needs
          // ELECTRON_RUN_AS_NODE + NODE_PATH or the respawn boots Electron
          // instead of node and crash-recovery fails. (Empty for ruflo/npx.)
          ...(entry.launch.env ?? {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      console.warn(
        `[ruflo-http] launchChild() threw (ws=${entry.workspaceId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * BUG-2 — wire a freshly-spawned child's stdio so it cannot deadlock.
   *
   * Both spawn paths use `stdio: ['ignore','pipe','pipe']`, so stdout AND stderr
   * are piped. If NOBODY reads stdout, the daemon's HTTP-server logs fill the
   * ~64KB OS pipe buffer, the daemon blocks on `write()`, and it silently stops
   * serving `/health` and `/mcp`. The original `doSpawn` drained stdout but the
   * crash-recovery child only wired stderr + exit — so a recovered daemon could
   * wedge. Factoring the stderr-buffering + stdout-drain into this single helper
   * (called from BOTH paths) keeps them from drifting again (grep-sibling class).
   *
   * Returns a getter for the buffered stderr tail so each path's `exit` handler
   * can keep its existing diagnostic reason string.
   */
  private wireChildIo(child: ChildProcess): { getStderrTail: () => string } {
    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 8_000) stderrBuf = stderrBuf.slice(-4_000);
    });
    // Drain stdout (daemon writes HTTP server logs there; we don't parse them).
    // Without this the pipe fills and the daemon blocks on write.
    child.stdout?.on('data', () => {
      /* drain */
    });
    return { getStderrTail: () => stderrBuf };
  }

  /**
   * Non-fatal store→search round-trip probe against the daemon's MCP endpoint.
   * POSTs `memory_store` then `memory_search_unified` for a canary key.
   * Sets `entry.roundTrip = true` on success, `false` + a single console.warn on failure.
   * Never throws; never changes `entry.status`.
   */
  private async roundTripProbe(entry: DaemonEntry): Promise<void> {
    const mcpUrl = `http://127.0.0.1:${entry.port}/mcp`;
    const canaryKey = '__sigmalink_healthcheck__';

    try {
      // Step 1: store the canary.
      await httpPost(mcpUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'memory_store',
          arguments: {
            key: canaryKey,
            value: 'sigmalink-daemon-healthcheck',
            namespace: 'patterns',
            ttl: 300,
          },
        },
      });

      // Step 2: retrieve it with unified search.
      const searchBody = await httpPost(mcpUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'memory_search_unified',
          arguments: { query: canaryKey, limit: 1 },
        },
      });

      // Accept any non-error response as success.
      const parsed = JSON.parse(searchBody) as { error?: unknown };
      if (parsed.error) throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`);

      entry.roundTrip = true;
    } catch (err) {
      entry.roundTrip = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ruflo-http] round-trip probe failed (ws=${entry.workspaceId}): ${msg}`);
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
      roundTrip: entry.roundTrip,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * True when `name` resolves on PATH. Uses `where` (Windows) or the `command -v`
 * shell builtin (POSIX) via execFileSync. NO interpolation into a shell string:
 * on POSIX `name` is passed as a positional arg (`$1`) to a fixed script, so
 * there is no shell-injection surface (the names probed here are hardcoded
 * constants regardless). A non-zero exit (not found) throws → false.
 *
 * Exported as the single source of truth for "is this CLI installed?" — the
 * seed-workspace-memory gate imports it so its availability check matches the
 * daemon's tier-2 PATH probe exactly (platform-agnostic; no process.platform
 * branches at the call sites).
 */
export function commandOnPath(name: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [name], { stdio: 'pipe' });
    } else {
      execFileSync('sh', ['-c', 'command -v "$1"', 'sh', name], { stdio: 'pipe' });
    }
    return true;
  } catch {
    return false;
  }
}

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

/** HTTP POST helper — sends JSON body, resolves with response body string on 2xx, rejects otherwise. */
function httpPost(url: string, body: unknown): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
        },
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
          return;
        }
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          responseBody += chunk;
        });
        res.on('end', () => resolve(responseBody));
      },
    );
    req.on('error', reject);
    req.setTimeout(3_000, () => {
      req.destroy(new Error('request timeout'));
    });
    req.write(json);
    req.end();
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
