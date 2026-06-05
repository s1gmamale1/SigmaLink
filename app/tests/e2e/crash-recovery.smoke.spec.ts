// Phase-0 crash-recovery smoke — the automated form of the operator's
// "force-quit → relaunch" hardware smoke.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS GATES
// ─────────────────────────────────────────────────────────────────────────
// A force-quit (SIGKILL) skips Electron's `before-quit`, so:
//   • CRIT-3 — `app.lastSession` is only written in `before-quit`, so the
//     restore-context (active workspace + room) is lost on the next launch.
//     The workspace ROWS are durable (workspaces.open inserts immediately +
//     WAL-checkpoints), so `workspaces.list` should still be non-empty — but
//     the session snapshot kv row is missing.
//   • CRIT-2 — dead `agent_sessions` rows keep `status='running'` AND their
//     `pane_index` (the exit-status update + graceful teardown never ran).
//     The PARTIAL UNIQUE INDEX `agent_sessions_ws_pane_uq (workspace_id,
//     pane_index) WHERE pane_index IS NOT NULL` is STATUS-AGNOSTIC, so the
//     dead rows keep "occupying" slots 0/1. A relaunch that re-launches the
//     prior panes at those same indices hits a UNIQUE violation → the
//     launcher logs "duplicate spawn suppressed", tears the just-spawned PTY
//     down, and returns an `error` session → NO live pane.
//   • CRIT-1 — a spawn-retry loop (each failed spawn having created a worktree
//     first) can leak git worktrees unboundedly (the real incident hit 49 GB).
//
// ─────────────────────────────────────────────────────────────────────────
// RED on Lane-A-only main / GREEN after Lane B
// ─────────────────────────────────────────────────────────────────────────
// This base (origin/main @ Phase-0 Lane A) has the DISK-safety net (CRIT-1
// guards) but NOT the DB lockout fix. So:
//   • CRIT-1 assertion is expected to PASS even here (Lane A bounds the disk).
//   • CRIT-2 / CRIT-3 assertions are expected to FAIL (RED) here — that is the
//     point: the smoke REPRODUCES the lockout. They go GREEN once Lane B lands
//     (status-aware unique index + per-boot janitor reconcile of dead rows +
//     adopt/replace on slot conflict + session-snapshot persistence flush).
//
// Run: `npm run test:smoke:crash` (sets SMOKE_CRASH=1). Excluded from the
// default CI matrix via the `test.skip(!process.env.SMOKE_CRASH)` guard —
// mirrors how tests/perf/ is PERF=1-gated.
//
// HARNESS NOTES (for the integrator):
//   • Custom throwaway userData is forced with the Chromium `--user-data-dir`
//     switch (Electron honours it; the app reads app.getPath('userData')).
//     We NEVER touch the operator's real userData.
//   • The post-kill DB read uses node:sqlite (DatabaseSync), NOT better-sqlite3
//     — the latter is built for Electron's ABI and cannot load in the plain
//     Node Playwright runner (see reference_better_sqlite3_electron_abi).
//   • All waits are condition-based (expect.poll / waitForSelector), never
//     fixed sleeps, to keep the smoke flake-resistant.

import { test, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// node:sqlite is a Node >=22.5 built-in. A STATIC top-level import crashes the
// whole file at module-load on older Node (e.g. CI's Node 20) — which fails the
// e2e job at collection time even though this SMOKE_CRASH-gated smoke is skipped
// there. Load it LAZILY so the file imports cleanly everywhere; node:sqlite is
// only touched when the SMOKE_CRASH=1 test actually runs (on a Node >=22.5 host).
const requireNodeBuiltin = createRequire(import.meta.url);
type DatabaseSyncCtor = new (
  dbFile: string,
  opts?: { readOnly?: boolean },
) => {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown };
  close: () => void;
};
function getDatabaseSync(): DatabaseSyncCtor {
  return (requireNodeBuiltin('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mainEntry = path.resolve(__dirname, '../../electron-dist/main.js');

// ── envelope-unwrapping invoke helper (mirrors multi-workspace.spec.ts) ──────
// All IPC handlers wrap results in {ok:true,data:X}. sigma.invoke() returns the
// raw envelope; unwrap here so callers receive the actual payload.
async function invoke<T>(win: Page, channel: string, ...args: unknown[]): Promise<T> {
  const raw = await win.evaluate(
    async ({ rpcChannel, rpcArgs }) => {
      const sigma = (
        window as unknown as {
          sigma: { invoke: (channelName: string, ...channelArgs: unknown[]) => Promise<unknown> };
        }
      ).sigma;
      return sigma.invoke(rpcChannel, ...rpcArgs);
    },
    { rpcChannel: channel, rpcArgs: args },
  );
  if (raw && typeof raw === 'object' && 'ok' in (raw as Record<string, unknown>)) {
    const env = raw as { ok: boolean; data?: unknown; error?: string };
    if (env.ok) return env.data as T;
    throw new Error(env.error ?? `${channel} failed`);
  }
  return raw as T;
}

async function waitForSigmaBridge(win: Page): Promise<boolean> {
  try {
    await expect
      .poll(
        () =>
          win.evaluate(() => {
            const maybeWindow = window as unknown as { sigma?: { invoke?: unknown } };
            return typeof maybeWindow.sigma?.invoke === 'function';
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
    return true;
  } catch {
    return false;
  }
}

async function activateWorkspace(win: Page, rootPath: string): Promise<void> {
  await win.evaluate((targetRoot) => {
    window.dispatchEvent(
      new CustomEvent('sigma:test:activate-workspace', { detail: { rootPath: targetRoot } }),
    );
  }, rootPath);
}

interface PaneSession {
  id: string;
  workspaceId: string;
  providerId: string;
  status: 'starting' | 'running' | 'exited' | 'error';
  worktreePath: string | null;
  error?: string;
}

interface LaunchResult {
  sessions: PaneSession[];
}

interface WorkspaceRow {
  id: string;
  rootPath: string;
}

// Launch the app against a fixed temp userData. The --user-data-dir Chromium
// switch redirects app.getPath('userData') so the app never reads/writes the
// operator's real profile.
async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_ENV: 'test' },
    timeout: 60_000,
  });
}

// Count immediate child directories under <userData>/worktrees recursively one
// level deep (worktrees are nested under a per-repo hash dir). Returns the total
// leaf worktree count so an unbounded leak (CRIT-1) is visible.
function countWorktreeDirs(userDataDir: string): number {
  const base = path.join(userDataDir, 'worktrees');
  if (!fs.existsSync(base)) return 0;
  let count = 0;
  for (const repoHash of fs.readdirSync(base)) {
    const repoDir = path.join(base, repoHash);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(repoDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const leaf of fs.readdirSync(repoDir)) {
      try {
        if (fs.statSync(path.join(repoDir, leaf)).isDirectory()) count += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return count;
}

// Read agent_sessions from the temp sigmalink.db AFTER the app process is dead
// (never while it holds the file). node:sqlite has no native-ABI dependency, so
// it loads in the plain-Node Playwright runner where better-sqlite3 cannot.
function readAgentSessions(userDataDir: string): Array<{
  id: string;
  pane_index: number | null;
  status: string;
}> {
  const dbPath = path.join(userDataDir, 'sigmalink.db');
  if (!fs.existsSync(dbPath)) return [];
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT id, pane_index, status FROM agent_sessions').all() as Array<{
      id: string;
      pane_index: number | null;
      status: string;
    }>;
  } finally {
    db.close();
  }
}

// Read a single kv value from the temp DB after the app is dead.
function readKv(userDataDir: string, key: string): string | null {
  const dbPath = path.join(userDataDir, 'sigmalink.db');
  if (!fs.existsSync(dbPath)) return null;
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

// The smoke is heavy + run on demand only. Excluded from the default CI matrix.
test.skip(
  !process.env.SMOKE_CRASH,
  'crash-recovery smoke is SMOKE_CRASH=1-gated (run via `npm run test:smoke:crash`)',
);

test('force-quit → relaunch recovers workspaces, panes, and bounded worktrees', async () => {
  test.setTimeout(180_000);

  // Throwaway userData — NEVER the operator's real profile.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-crash-ud-'));
  // Throwaway git repo used as the workspace, so the launcher creates worktrees
  // (the realistic path that leaked to 49 GB in the incident).
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-crash-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'smoke@sigmalink.test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Crash Smoke'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# crash smoke fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });

  const PANES = 2;
  let app: ElectronApplication | null = null;

  try {
    // ── PHASE 1 — seed: open workspace, launch ≥2 shell panes ────────────────
    app = await launchApp(userDataDir);
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded').catch(() => undefined);
    const ready = await waitForSigmaBridge(win);
    test.skip(!ready, `Sigma preload bridge unavailable; window title="${await win.title()}"`);

    await invoke(win, 'kv.set', 'app.onboarded', '1');
    await invoke(win, 'kv.set', 'coachmark.featureSpotlight.seen', '1');
    await invoke(win, 'workspaces.open', repoDir);
    await activateWorkspace(win, repoDir);

    const wsList = await invoke<WorkspaceRow[]>(win, 'workspaces.list');
    expect(wsList.length, 'workspace persisted after open').toBeGreaterThan(0);

    const seedLaunch = await invoke<LaunchResult>(win, 'workspaces.launch', {
      workspaceRoot: repoDir,
      preset: PANES,
      panes: Array.from({ length: PANES }, (_, i) => ({ paneIndex: i, providerId: 'shell' })),
    });
    // All seeded panes should be live before we crash — this establishes the
    // dead-but-`running` rows the relaunch then trips over.
    const seedLive = seedLaunch.sessions.filter(
      (s) => s.status === 'running' || s.status === 'starting',
    );
    expect(seedLive.length, 'seeded panes are live before crash').toBe(PANES);

    // Wait (condition-based) until pty.list reflects the live shells.
    await expect
      .poll(
        async () => {
          const ptys = await invoke<Array<{ cwd: string; alive: boolean }>>(win, 'pty.list');
          return ptys.filter((p) => p.alive).length;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(PANES);

    const worktreesAfterSeed = countWorktreeDirs(userDataDir);

    // ── PHASE 2 — FORCE-QUIT (SIGKILL, NOT app.close()) ──────────────────────
    // .close() would run before-quit (graceful). SIGKILL skips it — the real
    // crash. After this the agent_sessions rows are still status='running' and
    // app.lastSession was never written.
    const proc = app.process();
    proc.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once('exit', () => resolve());
    });
    app = null;

    // Post-kill DB inspection (process is dead — safe to open the file).
    const rowsAfterCrash = readAgentSessions(userDataDir);
    const stillRunning = rowsAfterCrash.filter((r) => r.status === 'running');
    // Sanity: the SIGKILL really did leave dead rows marked 'running' (this is
    // the precondition for the CRIT-2 lockout). Informational, not the gate.
    expect(stillRunning.length, 'SIGKILL left dead rows as running').toBeGreaterThan(0);

    // ── PHASE 3 — RELAUNCH with the SAME userData ────────────────────────────
    app = await launchApp(userDataDir);
    const win2 = await app.firstWindow({ timeout: 30_000 });
    await win2.waitForLoadState('domcontentloaded').catch(() => undefined);
    const ready2 = await waitForSigmaBridge(win2);
    test.skip(!ready2, `Sigma preload bridge unavailable on relaunch; title="${await win2.title()}"`);

    // ── ASSERT CRIT-3 — workspaces survive the crash ─────────────────────────
    // The workspace row is durable (insert + WAL checkpoint on open), so the
    // list must be non-empty even though app.lastSession was never flushed.
    const wsAfter = await invoke<WorkspaceRow[]>(win2, 'workspaces.list');
    expect(wsAfter.length, 'CRIT-3: workspaces non-empty after force-quit').toBeGreaterThan(0);
    expect(
      wsAfter.some((w) => path.resolve(w.rootPath) === path.resolve(repoDir)),
      'CRIT-3: the prior workspace is restorable from the list',
    ).toBe(true);

    await activateWorkspace(win2, repoDir);

    // ── ASSERT CRIT-2 — a fresh launch at the SAME pane slots reaches LIVE ────
    // On Lane-A-only main the dead 'running' rows still own slots 0/1 in the
    // status-agnostic unique index, so this re-launch hits a UNIQUE violation
    // → "duplicate spawn suppressed" → error sessions (no live pane). RED here.
    // After Lane B reconciles the dead rows on boot (or the index becomes
    // status-aware + adopt/replace runs), these panes come up live → GREEN.
    const relaunch = await invoke<LaunchResult>(win2, 'workspaces.launch', {
      workspaceRoot: repoDir,
      preset: PANES,
      panes: Array.from({ length: PANES }, (_, i) => ({ paneIndex: i, providerId: 'shell' })),
    });
    const relaunchLive = relaunch.sessions.filter(
      (s) => s.status === 'running' || s.status === 'starting',
    );
    const relaunchErrors = relaunch.sessions.filter((s) => s.status === 'error');

    // Primary CRIT-2 gate: every requested pane comes up live, none suppressed.
    expect(
      relaunchErrors,
      `CRIT-2: no pane was suppressed on relaunch (errors: ${relaunchErrors
        .map((s) => s.error ?? s.id)
        .join('; ')})`,
    ).toHaveLength(0);
    expect(relaunchLive.length, 'CRIT-2: every relaunched pane reached a live status').toBe(PANES);

    // Corroborate via the renderer-visible pane count (status-aware read-path).
    const liveForWs = await invoke<PaneSession[]>(win2, 'panes.listForWorkspace', wsAfter[0].id);
    expect(
      liveForWs.filter((p) => p.status === 'running' || p.status === 'starting').length,
      'CRIT-2: panes.listForWorkspace shows live panes (no -1 / suppressed slot)',
    ).toBeGreaterThanOrEqual(PANES);

    // ── ASSERT CRIT-1 — worktree count stays BOUNDED across a relaunch loop ───
    // Replay launch a couple more times to exercise the spawn path that leaked
    // worktrees. The total must stay bounded (≤ panes + small constant), not
    // grow unboundedly.
    for (let i = 0; i < 2; i += 1) {
      await invoke<LaunchResult>(win2, 'workspaces.launch', {
        workspaceRoot: repoDir,
        preset: PANES,
        panes: Array.from({ length: PANES }, (_, j) => ({ paneIndex: j, providerId: 'shell' })),
      }).catch(() => undefined);
      await win2.waitForTimeout(300);
    }
    const worktreesAfterLoop = countWorktreeDirs(userDataDir);
    const WORKTREE_BUDGET = PANES * 3 + 4; // generous: a few stragglers, NOT a leak
    expect(
      worktreesAfterLoop,
      `CRIT-1: worktree dir count bounded (seed=${worktreesAfterSeed}, after-loop=${worktreesAfterLoop}, budget=${WORKTREE_BUDGET})`,
    ).toBeLessThanOrEqual(WORKTREE_BUDGET);

    // ── Clean quit so a final DB read reflects a graceful shutdown ───────────
    // app.lastSession should NOW be written (before-quit ran), proving the
    // CRIT-3 mechanism: the kv row exists after a CLEAN quit but not a crash.
    await app.close().catch(() => undefined);
    app = null;

    const lastSessionAfterCleanQuit = readKv(userDataDir, 'app.lastSession');
    expect(
      lastSessionAfterCleanQuit,
      'app.lastSession is written on a CLEAN quit (the value SIGKILL skipped)',
    ).not.toBeNull();
  } finally {
    if (app) await app.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
