# Perf Hot Paths (polling / IPC / main-loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the interlocked polling/IPC/main-loop hot-path cluster found in the 2026-06-10 audit: sync `ps` blocking the main loop per-pane, per-pane unshared 3 s pollers with no visibility pause, full-filename git-status payloads for a count-only consumer, a sync login-shell spawn on the boot critical path, and undebounced event-burst refetches.

**Architecture:** One coherent rework around three primitives: (1) a **main-process process-table snapshot layer** — ONE async `execFile('ps')` per ~2.5 s TTL window feeds every pane's subtree lookup (replaces N sync `execFileSync` calls: 12 panes × ~23 ms blocked / 3 s ≈ 280 ms of main-loop stalls per window → **0 ms blocked, 12× fewer ps spawns**), built behind a per-platform `ProcessLister` seam so the sibling win32 plan can plug in a backend without touching the cache; (2) a **generic refcounted shared renderer poller** (extracted from the two existing PERF-6 pollers in `src/renderer/lib/`) with visibility pause, in-flight overlap guard, and optional per-key phase stagger — `usePaneLiveStats`/`useSwarmLiveStats` rebase onto it (2 RPCs/pane/3 s always-on → shared per-session entries, **0 RPCs while `document.hidden`**, pane+swarm watching the same session dedupe to one RPC pair/tick); (3) a **count-only `git.statusSummary` RPC** for the pane-header badge — ONE git proc per poll instead of `gitStatus`'s four (`rev-parse --show-toplevel` + `rev-parse --abbrev-ref` + `status` + `rev-list`), a ~2-field payload instead of full staged/unstaged/untracked filename arrays (20 worktree-distinct panes: **80 git spawns/15 s → 20, phase-staggered**). Plus: the macOS login-shell PATH bootstrap becomes **cached (userData JSON) + async-refresh** — warm boots drop the 200 ms–1.5 s `spawnSync` from the pre-window critical path; only the *first PTY spawn* gates on freshness (≤3.5 s cap), never window creation. Finally `runRefreshOnEvent` gains a **250 ms trailing coalesce** so a burst of k `memory:changed`/`tasks:changed`/`skills:changed`/`review:changed` events triggers one refetch, fixing all 4 channels in one place.

**Tech Stack:** TypeScript, Electron main (node `child_process.execFile`), React 19 (`useSyncExternalStore`), zod RPC schemas, vitest (`vi.useFakeTimers`, jsdom for renderer hooks, mocked `child_process`/`execCmd` for main — vitest cannot load electron/better-sqlite3, so all main-process units use DI/fakes per neighboring specs).

---

## Verified findings (2026-06-10 re-audit before planning)

| # | Status | Evidence |
|---|--------|----------|
| 1 | **Confirmed** | `src/main/core/process/process-tree.ts:47` `execFileSync('ps', …)`; called per-RPC via `src/main/rpc-router.ts:1009` → `registry.ts:405-409`; polled every 3 s/pane by `usePaneLiveStats.ts:128` (mounted at `PaneHeader.tsx:108`). |
| 2 | **Confirmed** | `usePaneLiveStats.ts:179` per-pane `setInterval`, 2 RPCs/tick, no `document.hidden` pause. Mirror: `useSwarmLiveStats.ts:101`. The shared pattern exists at `src/renderer/lib/use-git-status-poll.ts` and `src/renderer/lib/use-git-activity-poll.ts` (the "second instance"). |
| 3 | **Confirmed + refined** | `git-ops.ts:64-115` `gitStatus` spawns **4** procs per poll (finding said 3 — `getRepoRoot`'s `rev-parse --show-toplevel` at :66 is the 4th), so the win is bigger. `useUncommittedCount` (`use-git-status-poll.ts:186`) is the ONLY production consumer of the poller (verified by grep — `PaneShell.tsx:114`); `ArtifactsPanel`/`GitRoom`/`OrchestratorPanel` call `rpc.git.status` one-shot, not via the poller. The poller can go fully count-only; full `git.status` stays for one-shot consumers. |
| 4 | **Confirmed** | `electron/main.ts:740` calls `bootstrapShellPath()` (def :356, sync `spawnSync(shell, ['-ilc', …], {timeout: 3000})`) inside `whenReady` BEFORE `registerRouter()` (:753) + `createWindow()` (:754). Deviation from the finding's "cache in KV": the `kv` SQLite table is only safely available after `registerRouter()` opens/migrates the DB — a JSON file in `app.getPath('userData')` gives identical persistence one boot-phase earlier with zero DB coupling. |
| 5 | **Confirmed** | `parsers.ts:39` `runRefreshOnEvent` — no debounce. 4 consumers in `use-live-events.ts`: `skills:changed` (:93), `memory:changed` (:109), `review:changed` (:134), `tasks:changed` (:149). One test (`use-live-events.test.ts:293`) asserts a synchronous event→refetch and must be updated. |

**Refuted findings: none.**

---

## File Structure

```
app/
├── electron/
│   └── main.ts                                   # MODIFY (T4): cached/async shell-path bootstrap; drop sync bootstrapShellPath + spawnSync import
├── src/main/
│   ├── core/process/
│   │   ├── process-tree.ts                       # MODIFY (T1): export parsePsLine/emptySnapshot, extract pure buildSubtree(); sync inspect stays for the kill path
│   │   ├── ps-snapshot.ts                        # CREATE (T1): ProcessLister seam + TTL-cached async process table + inspectProcessTreeCached
│   │   └── ps-snapshot.test.ts                   # CREATE (T1)
│   ├── core/pty/registry.ts                      # MODIFY (T1): add async processSnapshotCached()
│   ├── core/git/
│   │   ├── git-ops.ts                            # MODIFY (T3): add gitStatusSummary() (1 git proc, count-only)
│   │   └── git-ops-summary.test.ts               # CREATE (T3)
│   ├── core/rpc/schemas.ts                       # MODIFY (T3): GIT_STATUS_SUMMARY_OUTPUT + 'git.statusSummary'
│   ├── core/util/
│   │   ├── shell-path.ts                         # CREATE (T4): mergeShellPath + async resolve + readiness gate (DI'd cache io, no electron import)
│   │   └── shell-path.test.ts                    # CREATE (T4)
│   ├── core/workspaces/launcher.ts               # MODIFY (T4): await whenShellPathReady() before resolveAndSpawn (~:460)
│   └── rpc-router.ts                             # MODIFY (T1: await processSnapshotCached at :1009; T3: statusSummary handler near :1488; T4: gate pty.create :961 / spawnScratch :1035 / providers.spawnInstall :1334)
├── src/shared/
│   ├── types.ts                                  # MODIFY (T3): GitStatusSummary
│   ├── router-shape.ts                           # MODIFY (T3): git.statusSummary signature
│   └── rpc-channels.ts                           # MODIFY (T3): 'git.statusSummary' in CHANNELS (drift net: rpc-channels.test.ts)
└── src/renderer/
    ├── lib/
    │   ├── shared-poll.ts                        # CREATE (T2): generic refcounted shared poller (visibility pause, in-flight guard, stagger)
    │   ├── shared-poll.test.ts                   # CREATE (T2)
    │   ├── use-session-stats-poll.ts             # CREATE (T2): shared 3 s per-session usage+processStats poller
    │   ├── use-git-activity-poll.ts              # MODIFY (T2): rebase onto factory (~196 → ~45 lines)
    │   ├── use-git-status-poll.ts                # MODIFY (T3): rebase onto factory + statusSummary fetch; drop unused useGitStatusPoll
    │   └── use-git-status-poll.test.ts           # MODIFY (T3): count-only assertions
    ├── features/command-room/
    │   ├── usePaneLiveStats.ts                   # MODIFY (T2): consume shared poller; PaneLiveStats shape unchanged
    │   └── usePaneLiveStats.test.ts              # MODIFY (T2): rpcSilent mocks + dedupe/visibility tests
    ├── features/right-rail/
    │   ├── useSwarmLiveStats.ts                  # MODIFY (T2): consume shared poller; SwarmLiveStats shape unchanged
    │   └── useSwarmLiveStats.test.ts             # CREATE (T2)
    └── app/state-hooks/
        ├── parsers.ts                            # MODIFY (T5): 250 ms trailing coalesce in runRefreshOnEvent
        ├── parsers.test.ts                       # MODIFY (T5)
        └── use-live-events.test.ts               # MODIFY (T5): review:changed test advances the 250 ms window
```

Consumers `PaneHeader.tsx:108`, `PaneShell.tsx:114`, `SigmaPanel.tsx:63` are **untouched** — every hook keeps its public signature and return shape.

All commands below run from `/Users/aisigma/projects/SigmaLink/app`.

---

### Task 1: Shared async `ps` snapshot + TTL cache (main-process process-table layer)

One `ps -axo pid=,ppid=,rss=,comm=,args=` output contains EVERY pane's tree. Fetch it once per ~2.5 s window with **async** `execFile` (zero event-loop blocking), let each `pty.processStats` RPC compute its subtree from the shared rows. The sync `inspectProcessTree` stays for the kill path (`stopProcessTrees` needs fresh-at-kill data and is rare, not hot) and for `workspaces/cleanup.ts`'s infrequent sweeps.

**Files:**
- Modify: `src/main/core/process/process-tree.ts` (export `parsePsLine` :29, `emptySnapshot` :19; extract `buildSubtree` from `inspectProcessTree` :59-91)
- Create: `src/main/core/process/ps-snapshot.ts`
- Modify: `src/main/core/pty/registry.ts:405` (add `processSnapshotCached`)
- Modify: `src/main/rpc-router.ts:1009` (`processStats` handler awaits the cached variant)
- Test: `src/main/core/process/ps-snapshot.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `src/main/core/process/ps-snapshot.test.ts`:

```ts
// perf-hot-paths Task 1 — shared async process-table snapshot + TTL cache.
// Fakes the ProcessLister (no real `ps` spawn); vi.useFakeTimers drives the
// TTL (vitest fake timers mock Date.now too). vitest cannot load electron,
// so the lister is injected — never spawn a real process here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  inspectProcessTreeCached,
  parsePsOutput,
  __setProcessListerForTests,
  __resetProcessTableForTests,
  PROCESS_TABLE_TTL_MS,
} from './ps-snapshot';
import type { ProcessTreeNode } from './process-tree';

function node(pid: number, ppid: number, rssKb: number, command = 'proc'): ProcessTreeNode {
  return { pid, ppid, rssBytes: rssKb * 1024, command, args: '' };
}

const TABLE: ProcessTreeNode[] = [
  node(1, 0, 100, 'launchd'),
  node(100, 1, 500, 'claude'),
  node(101, 100, 300, 'node'),
  node(102, 101, 200, 'ruflo-mcp'),
  node(200, 1, 400, 'codex'),
];

beforeEach(() => {
  vi.useFakeTimers();
  __resetProcessTableForTests();
});

afterEach(() => {
  __resetProcessTableForTests();
  vi.useRealTimers();
});

describe('inspectProcessTreeCached', () => {
  it('12 concurrent calls share ONE lister invocation (in-flight dedupe)', async () => {
    const lister = vi.fn(async () => TABLE);
    __setProcessListerForTests(lister);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => inspectProcessTreeCached(100)),
    );

    expect(lister).toHaveBeenCalledTimes(1);
    for (const snap of results) {
      expect(snap.supported).toBe(true);
      expect(snap.rootPid).toBe(100);
      expect([...snap.descendantPids].sort((a, b) => a - b)).toEqual([101, 102]);
      expect(snap.rssBytes).toBe((500 + 300 + 200) * 1024);
    }
  });

  it('serves from cache within the TTL, refetches after expiry', async () => {
    const lister = vi.fn(async () => TABLE);
    __setProcessListerForTests(lister);

    await inspectProcessTreeCached(100);
    await inspectProcessTreeCached(200); // different root, same shared table
    expect(lister).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PROCESS_TABLE_TTL_MS + 100);
    await inspectProcessTreeCached(100);
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it('different panes get their own subtree from one shared table', async () => {
    __setProcessListerForTests(vi.fn(async () => TABLE));
    const a = await inspectProcessTreeCached(100);
    const b = await inspectProcessTreeCached(200);
    expect(a.nodes.map((n) => n.pid).sort((x, y) => x - y)).toEqual([100, 101, 102]);
    expect(b.nodes.map((n) => n.pid)).toEqual([200]);
    expect(b.rssBytes).toBe(400 * 1024);
  });

  it('returns unsupported-empty when no lister exists for the platform', async () => {
    __setProcessListerForTests(null);
    const snap = await inspectProcessTreeCached(100, 'win32');
    expect(snap.supported).toBe(false);
    expect(snap.nodes).toEqual([]);
    expect(snap.rssBytes).toBe(0);
  });

  it('a failing lister degrades to the last cached table (never throws)', async () => {
    const lister = vi
      .fn<() => Promise<ProcessTreeNode[]>>()
      .mockResolvedValueOnce(TABLE)
      .mockRejectedValueOnce(new Error('ps blew up'));
    __setProcessListerForTests(lister);

    const first = await inspectProcessTreeCached(100);
    expect(first.rssBytes).toBeGreaterThan(0);

    vi.advanceTimersByTime(PROCESS_TABLE_TTL_MS + 100);
    const second = await inspectProcessTreeCached(100);
    expect(second.rssBytes).toBe(first.rssBytes); // stale-but-served
  });

  it('rootPid absent from the table → empty supported snapshot', async () => {
    __setProcessListerForTests(vi.fn(async () => TABLE));
    const snap = await inspectProcessTreeCached(99999);
    expect(snap.supported).toBe(true);
    expect(snap.nodes).toEqual([]);
    expect(snap.rssBytes).toBe(0);
  });
});

describe('parsePsOutput', () => {
  it('parses pid/ppid/rss/comm/args lines and skips malformed rows', () => {
    const out =
      '  100   1 500 claude --resume abc\n garbage \n  101 100 300 node ruflo mcp start\n';
    const rows = parsePsOutput(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      pid: 100,
      ppid: 1,
      rssBytes: 500 * 1024,
      command: 'claude',
      args: '--resume abc',
    });
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `npx vitest run src/main/core/process/ps-snapshot.test.ts`
Expected: FAIL — `Cannot find module './ps-snapshot'` (or unresolved import).

- [ ] **Step 1.3: Refactor `process-tree.ts` — export helpers, extract pure `buildSubtree`**

In `src/main/core/process/process-tree.ts`:

1. Change `function emptySnapshot(` (line 19) to `export function emptySnapshot(`.
2. Change `function parsePsLine(` (line 29) to `export function parsePsLine(`.
3. Extract the body of `inspectProcessTree` lines 59-91 into a new exported pure function placed right above `inspectProcessTree`:

```ts
/**
 * Pure subtree computation over a full process table. Shared by the sync
 * kill-path inspector below and the async TTL-cached path in ps-snapshot.ts.
 */
export function buildSubtree(rows: ProcessTreeNode[], rootPid: number): ProcessTreeSnapshot {
  const byParent = new Map<number, ProcessTreeNode[]>();
  const byPid = new Map<number, ProcessTreeNode>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }

  const nodes: ProcessTreeNode[] = [];
  const stack = byPid.get(rootPid) ? [rootPid] : [];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const node = byPid.get(pid);
    if (!node) continue;
    nodes.push(node);
    for (const child of byParent.get(pid) ?? []) {
      stack.push(child.pid);
    }
  }

  const descendantPids = nodes.filter((node) => node.pid !== rootPid).map((node) => node.pid);
  const rssBytes = nodes.reduce((sum, node) => sum + node.rssBytes, 0);
  return { rootPid, supported: true, nodes, descendantPids, rssBytes };
}
```

4. Shrink `inspectProcessTree` to use it (keep the sync exec — kill path + cleanup.ts still need it):

```ts
export function inspectProcessTree(rootPid: number): ProcessTreeSnapshot {
  if (!rootPid || rootPid <= 0) return emptySnapshot(rootPid, process.platform === 'darwin');
  if (process.platform !== 'darwin') return emptySnapshot(rootPid, false);

  let rows: ProcessTreeNode[];
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm=,args='], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    rows = out
      .split('\n')
      .map(parsePsLine)
      .filter((row): row is ProcessTreeNode => row !== null);
  } catch {
    return emptySnapshot(rootPid, true);
  }

  return buildSubtree(rows, rootPid);
}
```

- [ ] **Step 1.4: Write the minimal implementation**

Create `src/main/core/process/ps-snapshot.ts`:

```ts
// perf-hot-paths Task 1 — shared async process-table snapshot + TTL cache.
//
// WHY: `inspectProcessTree` shells out to `ps -axo …` SYNCHRONOUSLY (~23 ms of
// blocked main loop per call) and the renderer polls `pty.processStats` every
// 3 s PER running pane — 12 panes ≈ 280 ms of main-loop stalls per 3 s window,
// which stalls pty.write echo + the 12 ms pty:data coalescer flush. ONE `ps`
// output already contains EVERY pane's tree, so this module fetches the table
// at most once per TTL window with ASYNC execFile (zero event-loop blocking)
// and each pane computes its subtree locally from the shared rows.
//
// Backend-agnostic seam: the per-platform "list all processes" function is a
// `ProcessLister`. darwin's lives here; the win32-platform-services plan adds
// a `win32:` entry to LISTERS WITHOUT touching the TTL/cache layer.

import { execFile } from 'node:child_process';
import {
  buildSubtree,
  emptySnapshot,
  parsePsLine,
  type ProcessTreeNode,
  type ProcessTreeSnapshot,
} from './process-tree';

export type ProcessLister = () => Promise<ProcessTreeNode[]>;

/** One process-table fetch covers all panes polling within this window. */
export const PROCESS_TABLE_TTL_MS = 2_500;

export function parsePsOutput(out: string): ProcessTreeNode[] {
  return out
    .split('\n')
    .map(parsePsLine)
    .filter((row): row is ProcessTreeNode => row !== null);
}

const darwinLister: ProcessLister = () =>
  new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,rss=,comm=,args='],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parsePsOutput(stdout));
      },
    );
  });

// Per-platform backends. win32-platform-services adds `win32:` here.
const LISTERS: Partial<Record<NodeJS.Platform, ProcessLister>> = {
  darwin: darwinLister,
};

let testLister: ProcessLister | null = null;
let cachedRows: ProcessTreeNode[] | null = null;
let cachedAt = 0;
let inFlight: Promise<ProcessTreeNode[]> | null = null;

function activeLister(platform: NodeJS.Platform): ProcessLister | null {
  return testLister ?? LISTERS[platform] ?? null;
}

function getProcessTable(lister: ProcessLister): Promise<ProcessTreeNode[]> {
  const now = Date.now();
  if (cachedRows && now - cachedAt < PROCESS_TABLE_TTL_MS) {
    return Promise.resolve(cachedRows);
  }
  if (inFlight) return inFlight;
  inFlight = lister().then(
    (rows) => {
      cachedRows = rows;
      cachedAt = Date.now();
      inFlight = null;
      return rows;
    },
    () => {
      // Lister failure: degrade to the last table (or empty) without throwing
      // — a transient ps failure must never break the stats badge. Stamp
      // cachedAt so we back off for one TTL window instead of hammering.
      inFlight = null;
      cachedAt = Date.now();
      return cachedRows ?? [];
    },
  );
  return inFlight;
}

/**
 * Async, TTL-cached equivalent of `inspectProcessTree`. NEVER blocks the main
 * event loop and NEVER throws. N panes polling within one TTL window share
 * ONE `ps` exec.
 */
export async function inspectProcessTreeCached(
  rootPid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessTreeSnapshot> {
  const lister = activeLister(platform);
  if (!lister) return emptySnapshot(rootPid, false);
  if (!rootPid || rootPid <= 0) return emptySnapshot(rootPid, true);
  const rows = await getProcessTable(lister);
  return buildSubtree(rows, rootPid);
}

/** Test-only: override the platform lister (null = simulate no backend). */
export function __setProcessListerForTests(lister: ProcessLister | null): void {
  testLister = lister;
}

/** Test-only: drop the cached table + in-flight state between tests. */
export function __resetProcessTableForTests(): void {
  testLister = null;
  cachedRows = null;
  cachedAt = 0;
  inFlight = null;
}
```

- [ ] **Step 1.5: Run the test to verify it passes**

Run: `npx vitest run src/main/core/process/ps-snapshot.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 1.6: Wire the cached path into the registry + RPC handler**

In `src/main/core/pty/registry.ts`, next to `processSnapshot` (line 405), add (and add the import `import { inspectProcessTreeCached } from '../process/ps-snapshot';` near the existing process-tree import at line 24):

```ts
/**
 * perf-hot-paths Task 1 — async TTL-cached variant for the hot per-pane
 * `pty.processStats` RPC. The sync `processSnapshot` above stays for the
 * infrequent cleanup sweeps (workspaces/cleanup.ts) and the kill path.
 */
async processSnapshotCached(id: string): Promise<ProcessTreeSnapshot | null> {
  const rec = this.sessions.get(id);
  if (!rec) return null;
  return inspectProcessTreeCached(rec.pid);
}
```

In `src/main/rpc-router.ts:1009-1010`, change the `processStats` handler's first line:

```ts
    processStats: async (sessionId: string) => {
      const snapshot = await pty.processSnapshotCached(sessionId);
```

(The rest of the handler body and the `pty.processStats` zod schema are unchanged — same output shape.)

- [ ] **Step 1.7: Run the full gate for this slice**

Run: `npx tsc -b && npx vitest run src/main/core/process/ src/main/rpc-router.wiring.test.ts`
Expected: PASS, no type errors.

- [ ] **Step 1.8: Commit**

```bash
git add src/main/core/process/process-tree.ts src/main/core/process/ps-snapshot.ts src/main/core/process/ps-snapshot.test.ts src/main/core/pty/registry.ts src/main/rpc-router.ts
git commit -m "perf(pty): shared async ps snapshot + 2.5s TTL cache — unblock main loop on processStats"
```

---

### Task 2: Generic refcounted shared poller + shared session-stats poll (visibility pause)

Extract the PERF-6 pattern (duplicated across `use-git-status-poll.ts` and `use-git-activity-poll.ts`) into one factory, then rebase `use-git-activity-poll`, `usePaneLiveStats`, and `useSwarmLiveStats` onto it. (`use-git-status-poll` is rebased in Task 3 where its fetch also changes — one rewrite instead of two.)

**Files:**
- Create: `src/renderer/lib/shared-poll.ts`
- Test: `src/renderer/lib/shared-poll.test.ts`
- Modify: `src/renderer/lib/use-git-activity-poll.ts` (full rebase, ~196 → ~45 lines)
- Create: `src/renderer/lib/use-session-stats-poll.ts`
- Modify: `src/renderer/features/command-room/usePaneLiveStats.ts` (full rewrite, shape preserved)
- Modify: `src/renderer/features/command-room/usePaneLiveStats.test.ts`
- Modify: `src/renderer/features/right-rail/useSwarmLiveStats.ts` (full rewrite, shape preserved)
- Create: `src/renderer/features/right-rail/useSwarmLiveStats.test.ts`

- [ ] **Step 2.1: Write the failing factory test**

Create `src/renderer/lib/shared-poll.test.ts`:

```ts
// @vitest-environment jsdom
//
// perf-hot-paths Task 2 — generic refcounted shared poller. Covers the
// invariants every consumer (git status/activity, session stats) relies on:
// refcount/fan-out, last-subscriber teardown, visibility pause + immediate
// refresh, in-flight overlap guard, per-key phase stagger, quiet failure.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSharedPoller } from './shared-poll';

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
});

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('createSharedPoller', () => {
  it('two subscribers on one key share ONE fetch per tick and both are notified', async () => {
    const fetch = vi.fn(async (key: string) => `${key}:v${fetch.mock.calls.length}`);
    const poller = createSharedPoller<string>({ intervalMs: 3_000, fetch });
    const seenA = vi.fn();
    const seenB = vi.fn();
    const offA = poller.subscribe('k1', seenA);
    const offB = poller.subscribe('k1', seenB);
    await flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(poller.getSnapshot('k1')).toBe('k1:v1');
    expect(seenA).toHaveBeenCalled();
    expect(seenB).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    offA();
    offB();
    poller.__reset();
  });

  it('tears down the interval when the LAST subscriber leaves', async () => {
    const fetch = vi.fn(async () => 1);
    const poller = createSharedPoller<number>({ intervalMs: 3_000, fetch });
    const offA = poller.subscribe('k1', () => {});
    const offB = poller.subscribe('k1', () => {});
    await flush();
    offA();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledTimes(2); // immediate + 1 tick (B still alive)
    offB();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fetch).toHaveBeenCalledTimes(2); // dead key — no further polls
    poller.__reset();
  });

  it('pauses while document.hidden and refreshes immediately on visible', async () => {
    const fetch = vi.fn(async () => 1);
    const poller = createSharedPoller<number>({ intervalMs: 3_000, fetch });
    const off = poller.subscribe('k1', () => {});
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetch).toHaveBeenCalledTimes(1); // occluded → ZERO polls

    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2); // immediate refresh on return
    off();
    poller.__reset();
  });

  it('skips ticks while the previous fetch is in flight (overlap guard)', async () => {
    let release: (v: number) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise<number>((r) => {
          release = r;
        }),
    );
    const poller = createSharedPoller<number>({ intervalMs: 3_000, fetch });
    const off = poller.subscribe('k1', () => {});
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6_500); // two ticks elapse, fetch unresolved
    expect(fetch).toHaveBeenCalledTimes(1); // guarded — no stacking

    release(42);
    await flush();
    expect(poller.getSnapshot('k1')).toBe(42);
    off();
    poller.__reset();
  });

  it('staggerPhase: exactly one recurring tick lands within the first interval window', async () => {
    const fetch = vi.fn(async () => 1);
    const poller = createSharedPoller<number>({ intervalMs: 15_000, fetch, staggerPhase: true });
    const off = poller.subscribe('repo-a', () => {});
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1); // immediate first poll
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2); // one phase-offset tick in (0, 15s)
    off();
    poller.__reset();
  });

  it('a rejecting fetch keeps the last good snapshot (degrade quietly)', async () => {
    const fetch = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(7)
      .mockRejectedValueOnce(new Error('rpc down'));
    const poller = createSharedPoller<number>({ intervalMs: 3_000, fetch });
    const off = poller.subscribe('k1', () => {});
    await flush();
    expect(poller.getSnapshot('k1')).toBe(7);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poller.getSnapshot('k1')).toBe(7); // retained
    off();
    poller.__reset();
  });
});
```

- [ ] **Step 2.2: Run it to verify it fails**

Run: `npx vitest run src/renderer/lib/shared-poll.test.ts`
Expected: FAIL — `Cannot find module './shared-poll'`.

- [ ] **Step 2.3: Implement the factory**

Create `src/renderer/lib/shared-poll.ts`:

```ts
// perf-hot-paths Task 2 — generic refcounted shared poller with visibility
// pause: the PERF-6 pattern from use-git-status-poll.ts / use-git-activity-
// poll.ts extracted ONCE. One module-level poller per data source; entries
// keyed by string (repo path, session id, …). The interval exists only while
// ≥1 subscriber holds the key, pauses while document.hidden (immediate
// refresh + re-arm on return), and never stacks overlapping fetches
// (in-flight guard — subsumes the jorvis-renderer-fixes overlap stopgap).
// Listeners are bare invalidation callbacks for useSyncExternalStore.

export interface SharedPollerOptions<T> {
  intervalMs: number;
  fetch: (key: string) => Promise<T>;
  /**
   * Phase-offset the recurring tick per key (deterministic FNV-1a hash of the
   * key, range (0, intervalMs)) so N keys don't land their fetches in one
   * synchronized burst (git spawn storms with worktree-per-pane).
   */
  staggerPhase?: boolean;
}

export interface SharedPoller<T> {
  subscribe(key: string, onStoreChange: () => void): () => void;
  getSnapshot(key: string): T | null;
  /** Test-only: tear down all entries + the shared visibility listener. */
  __reset(): void;
}

interface Entry<T> {
  subscribers: Set<() => void>;
  timeoutId: ReturnType<typeof setTimeout> | null;
  intervalId: ReturnType<typeof setInterval> | null;
  last: T | null;
  generation: number;
  inFlight: boolean;
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function docHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

export function createSharedPoller<T>(opts: SharedPollerOptions<T>): SharedPoller<T> {
  const entries = new Map<string, Entry<T>>();
  let visibilityInstalled = false;

  async function poll(key: string, entry: Entry<T>): Promise<void> {
    if (entry.inFlight) return; // overlap guard — never stack fetches
    entry.inFlight = true;
    const gen = entry.generation;
    try {
      const value = await opts.fetch(key);
      // Entry may have been torn down while the fetch was in flight — drop
      // the stale result rather than emitting into nobody.
      if (entry.generation !== gen || entry.subscribers.size === 0) return;
      entry.last = value;
      // Snapshot before dispatch so a subscriber that unsubscribes itself
      // during notification doesn't mutate the set we're iterating.
      for (const fn of Array.from(entry.subscribers)) fn();
    } catch {
      // Degrade quietly — keep the last good value.
    } finally {
      if (entry.generation === gen) entry.inFlight = false;
    }
  }

  function clearTimers(entry: Entry<T>): void {
    if (entry.timeoutId != null) {
      clearTimeout(entry.timeoutId);
      entry.timeoutId = null;
    }
    if (entry.intervalId != null) {
      clearInterval(entry.intervalId);
      entry.intervalId = null;
    }
  }

  function arm(key: string, entry: Entry<T>): void {
    if (entry.timeoutId != null || entry.intervalId != null) return; // armed
    if (docHidden()) return; // re-armed by the visibility handler
    const startInterval = (): void => {
      entry.intervalId = setInterval(() => {
        void poll(key, entry);
      }, opts.intervalMs);
    };
    if (opts.staggerPhase) {
      // First recurring tick at a per-key phase in (0, intervalMs); every
      // subsequent tick at intervalMs. Deterministic per key.
      const offset = (fnv1a(key) % (opts.intervalMs - 1)) + 1;
      entry.timeoutId = setTimeout(() => {
        entry.timeoutId = null;
        void poll(key, entry);
        startInterval();
      }, offset);
    } else {
      startInterval();
    }
  }

  function handleVisibility(): void {
    if (docHidden()) {
      for (const entry of entries.values()) clearTimers(entry);
      return;
    }
    for (const [key, entry] of entries.entries()) {
      if (entry.subscribers.size === 0) continue;
      void poll(key, entry);
      arm(key, entry);
    }
  }

  function installVisibilityOnce(): void {
    if (visibilityInstalled || typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', handleVisibility);
    visibilityInstalled = true;
  }

  return {
    subscribe(key, onStoreChange) {
      installVisibilityOnce();
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          subscribers: new Set(),
          timeoutId: null,
          intervalId: null,
          last: null,
          generation: 0,
          inFlight: false,
        };
        entries.set(key, entry);
      }
      const wasEmpty = entry.subscribers.size === 0;
      entry.subscribers.add(onStoreChange);
      if (wasEmpty) {
        entry.generation += 1;
        entry.inFlight = false;
        if (!docHidden()) void poll(key, entry);
        arm(key, entry);
      }
      const captured = entry;
      return () => {
        captured.subscribers.delete(onStoreChange);
        if (captured.subscribers.size === 0) {
          clearTimers(captured);
          captured.generation += 1;
          entries.delete(key);
        }
      };
    },
    getSnapshot(key) {
      return entries.get(key)?.last ?? null;
    },
    __reset() {
      for (const entry of entries.values()) clearTimers(entry);
      entries.clear();
      if (visibilityInstalled && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
      visibilityInstalled = false;
    },
  };
}
```

- [ ] **Step 2.4: Run the factory test**

Run: `npx vitest run src/renderer/lib/shared-poll.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 2.5: Rebase `use-git-activity-poll.ts` onto the factory**

Replace the entire contents of `src/renderer/lib/use-git-activity-poll.ts` with:

```ts
// P6 FEAT-8 + perf-hot-paths Task 2 — refcounted shared per-worktree
// git-activity poller, now riding the generic shared-poll factory (refcount,
// 60 s cadence, visibility pause, overlap guard, per-key phase stagger so N
// worktrees don't burst their commit-history walks simultaneously).

import { useCallback, useSyncExternalStore } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import { createSharedPoller } from '@/renderer/lib/shared-poll';
import type { GitActivityBucket } from '@/shared/types';

const POLL_INTERVAL_MS = 60_000;

const poller = createSharedPoller<GitActivityBucket[] | null>({
  intervalMs: POLL_INTERVAL_MS,
  staggerPhase: true,
  fetch: (worktreePath) => rpcSilent.git.activityLog(worktreePath),
});

const EMPTY_UNSUBSCRIBE = (): void => undefined;
const EMPTY_BUCKETS: GitActivityBucket[] = [];

/**
 * Shared git-activity poll for a worktree path. N strips on the same path
 * share ONE 60 s poll; polling pauses while the window is hidden and
 * refreshes immediately when it becomes visible. Pass `null` to disable.
 * Never throws — a failing poll retains the last good value.
 */
export function useGitActivityPoll(worktreePath: string | null): GitActivityBucket[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      worktreePath ? poller.subscribe(worktreePath, onStoreChange) : EMPTY_UNSUBSCRIBE,
    [worktreePath],
  );
  const getSnapshot = useCallback(
    () => (worktreePath ? poller.getSnapshot(worktreePath) : null),
    [worktreePath],
  );
  const buckets = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return buckets ?? EMPTY_BUCKETS;
}

/** Test-only helper. */
export function __resetGitActivityPollers(): void {
  poller.__reset();
}
```

Note the nested-null shape: `getSnapshot` returns `(GitActivityBucket[] | null) | null`; the `?? EMPTY_BUCKETS` at the end normalizes both nulls exactly as before.

- [ ] **Step 2.6: Create the shared session-stats poller**

Create `src/renderer/lib/use-session-stats-poll.ts`:

```ts
// perf-hot-paths Task 2 — ONE shared, visibility-paused 3 s poller per
// sessionId for the pane-header live-stats badge (usePaneLiveStats) + the
// Sigma panel swarm aggregate (useSwarmLiveStats). Replaces the per-pane
// independent setInterval (2 RPCs / pane / 3 s with NO document.hidden
// pause) and dedupes a pane + the swarm panel watching the SAME session into
// one RPC pair per tick. Uses rpcSilent so a failing poll degrades quietly
// (a 3 s loop must never toast-storm).

import { useCallback, useSyncExternalStore } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import { createSharedPoller } from '@/renderer/lib/shared-poll';
import type { UsageSummary } from '@/shared/types';

export interface ProcessStatsNode {
  pid: number;
  ppid: number;
  rssBytes: number;
  command: string;
  args: string;
}

export interface ProcessStatsResponse {
  supported: boolean;
  rssBytes: number;
  processCount: number;
  nodes?: ProcessStatsNode[];
}

export interface SessionStatsSnapshot {
  summary: UsageSummary | null;
  processStats: ProcessStatsResponse | null;
  /** Timestamp of this poll — drives tok/s delta math in consumers. */
  polledAt: number;
}

export const SESSION_STATS_INTERVAL_MS = 3_000;

export const sessionStatsPoller = createSharedPoller<SessionStatsSnapshot>({
  intervalMs: SESSION_STATS_INTERVAL_MS,
  // NO staggerPhase: consumers derive tok/s from inter-poll deltas and rely
  // on a steady 3 s cadence; the expensive half (ps) is TTL-cached in main.
  fetch: async (sessionId) => {
    const [summaryRes, statsRes] = await Promise.allSettled([
      rpcSilent.usage.sessionSummary({ sessionId }),
      rpcSilent.pty.processStats(sessionId),
    ]);
    return {
      summary: summaryRes.status === 'fulfilled' ? (summaryRes.value as UsageSummary) : null,
      processStats:
        statsRes.status === 'fulfilled' ? (statsRes.value as ProcessStatsResponse) : null,
      polledAt: Date.now(),
    };
  },
});

const EMPTY_UNSUBSCRIBE = (): void => undefined;

/**
 * Live `{summary, processStats, polledAt}` for a session. Pass `null` to
 * disable — the PERF-5 status gate: callers pass the id only while
 * `session.status === 'running'`, so exited/error panes never subscribe.
 */
export function useSessionStatsPoll(sessionId: string | null): SessionStatsSnapshot | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      sessionId ? sessionStatsPoller.subscribe(sessionId, onStoreChange) : EMPTY_UNSUBSCRIBE,
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => (sessionId ? sessionStatsPoller.getSnapshot(sessionId) : null),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only helper. */
export function __resetSessionStatsPoller(): void {
  sessionStatsPoller.__reset();
}
```

- [ ] **Step 2.7: Update the pane-stats tests FIRST (failing)**

In `src/renderer/features/command-room/usePaneLiveStats.test.ts`:

1. Replace the rpc mock block (lines 26-35) — the shared poller calls `rpcSilent`:

```ts
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {},
  rpcSilent: {
    usage: {
      sessionSummary: (...args: unknown[]) => sessionSummaryMock(...args),
    },
    pty: {
      processStats: (...args: unknown[]) => processStatsMock(...args),
    },
  },
}));
```

2. Add below the existing imports:

```ts
import { __resetSessionStatsPoller } from '@/renderer/lib/use-session-stats-poll';

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}
```

3. In `beforeEach` add `__resetSessionStatsPoller();` and `setHidden(false);`; in `afterEach` add `__resetSessionStatsPoller();` and `setHidden(false);` (before `vi.useRealTimers()`).

4. Append two new tests inside the `describe('usePaneLiveStats', …)` block:

```ts
  // ── perf-hot-paths Task 2: shared poller ───────────────────────────────────

  it('TWO components on the SAME session share ONE RPC pair per tick', async () => {
    sessionSummaryMock.mockResolvedValue(makeSummary({ turnCount: 1, outputTokens: 10 }));
    renderHook(() => usePaneLiveStats('sess-shared', true));
    renderHook(() => usePaneLiveStats('sess-shared', true));

    await tickMs(0);
    expect(sessionSummaryMock).toHaveBeenCalledTimes(1);
    expect(processStatsMock).toHaveBeenCalledTimes(1);

    await tickMs(3_000);
    expect(sessionSummaryMock).toHaveBeenCalledTimes(2);
    expect(processStatsMock).toHaveBeenCalledTimes(2);
  });

  it('pauses polling while document.hidden and resumes on visibilitychange', async () => {
    sessionSummaryMock.mockResolvedValue(makeSummary({ turnCount: 1, outputTokens: 5 }));
    renderHook(() => usePaneLiveStats('sess-vis', true));
    await tickMs(0);
    const callsVisible = sessionSummaryMock.mock.calls.length;

    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await tickMs(12_000);
    expect(sessionSummaryMock.mock.calls.length).toBe(callsVisible); // ZERO occluded polls

    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await tickMs(0);
    expect(sessionSummaryMock.mock.calls.length).toBe(callsVisible + 1); // immediate refresh
  });
```

All pre-existing tests stay textually unchanged — the rewrite below preserves every behavior they assert (status gate, first-poll-null tok/s, 300 tok / 3 s = 100, RSS breakdown, unmount safety).

- [ ] **Step 2.8: Run to verify failures**

Run: `npx vitest run src/renderer/features/command-room/usePaneLiveStats.test.ts`
Expected: FAIL — `Cannot find module '@/renderer/lib/use-session-stats-poll'` plus rpc-mock mismatches (the current hook imports `rpc`, the mock now only provides `rpcSilent`).

- [ ] **Step 2.9: Rewrite `usePaneLiveStats.ts`**

Replace the entire contents of `src/renderer/features/command-room/usePaneLiveStats.ts` with:

```ts
// BSP-V2 + perf-hot-paths Task 2 — live per-pane cost + tok/s estimate.
//
// The pane no longer owns a poll loop: it subscribes to the SHARED
// visibility-paused 3 s session-stats poller (use-session-stats-poll.ts) and
// derives the tok/s ESTIMATE from successive shared snapshots (output-token
// delta ÷ polledAt delta; always labelled "~" — the CLI only reports tokens
// at turn-end, not mid-stream). N components watching the same session share
// ONE RPC pair per tick; NOTHING polls while the window is hidden; exited/
// error panes pass enabled=false and never subscribe (PERF-5 status gate,
// mirrors PaneFooter.tsx:91).

import { useEffect, useRef, useState } from 'react';
import {
  useSessionStatsPoll,
  type ProcessStatsNode,
  type ProcessStatsResponse,
} from '@/renderer/lib/use-session-stats-poll';

/** Minimum elapsed seconds before we emit a tok/s estimate (avoids div/0 or
 *  wildly inaccurate bursts at startup). */
const MIN_ELAPSED_S = 1;

export interface PaneLiveStats {
  /** Total USD cost from the usage ledger; null when no priced turn yet. */
  totalCostUsd: number | null;
  /** Estimated output tokens per second ("~" label required). null when not
   *  enough data to estimate (< 2 polls or < MIN_ELAPSED_S elapsed). */
  estTokPerSec: number | null;
  /** True when at least one usage turn has been recorded (turnCount > 0). */
  hasData: boolean;
  /** Process-tree RSS in bytes; null when unsupported or unavailable. */
  rssBytes: number | null;
  /** Number of processes in the pane tree; null when unsupported or unavailable. */
  processCount: number | null;
  /** RSS for the root CLI process in bytes; null when unavailable. */
  rootRssBytes: number | null;
  /** RSS for MCP-like child processes in bytes; null when unavailable. */
  mcpRssBytes: number | null;
  /** Highest-RSS child command, useful for spotting MCP/npm/node inflation. */
  topChildCommand: string | null;
}

const EMPTY_STATS: PaneLiveStats = {
  totalCostUsd: null,
  estTokPerSec: null,
  hasData: false,
  rssBytes: null,
  processCount: null,
  rootRssBytes: null,
  mcpRssBytes: null,
  topChildCommand: null,
};

/**
 * Live cost + tok/s + RSS for a pane. Shape and gating semantics are
 * unchanged from the pre-Task-2 hook (PaneHeader.tsx:108 consumes as-is).
 */
export function usePaneLiveStats(sessionId: string, enabled: boolean): PaneLiveStats {
  const snap = useSessionStatsPoll(enabled ? sessionId : null);
  const [stats, setStats] = useState<PaneLiveStats>(EMPTY_STATS);
  const prevRef = useRef<{ outputTokens: number; polledAt: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Reset the delta baseline so a future re-enable starts clean.
      prevRef.current = null;
      return;
    }
    if (!snap) return;

    const { summary, processStats, polledAt } = snap;
    const rssBytes =
      processStats?.supported && processStats.rssBytes > 0 ? processStats.rssBytes : null;
    const processCount =
      processStats?.supported && processStats.processCount > 0
        ? processStats.processCount
        : null;
    const rssBreakdown = computeRssBreakdown(processStats);

    if (!summary) {
      // Usage RPC failed this tick: keep RSS fresh, retain prior usage fields.
      setStats((prev) => ({ ...prev, rssBytes, processCount, ...rssBreakdown }));
      return;
    }
    if (summary.turnCount === 0) {
      prevRef.current = null;
      setStats({ ...EMPTY_STATS, rssBytes, processCount, ...rssBreakdown });
      return;
    }

    const prev = prevRef.current;
    let estTokPerSec: number | null = null;
    if (prev) {
      const elapsedS = (polledAt - prev.polledAt) / 1_000;
      const tokenDelta = summary.outputTokens - prev.outputTokens;
      if (elapsedS >= MIN_ELAPSED_S && tokenDelta > 0) {
        estTokPerSec = Math.round((tokenDelta / elapsedS) * 10) / 10;
      }
    }
    prevRef.current = { outputTokens: summary.outputTokens, polledAt };

    setStats({
      totalCostUsd: summary.totalCostUsd,
      estTokPerSec,
      hasData: true,
      rssBytes,
      processCount,
      ...rssBreakdown,
    });
  }, [snap, enabled]);

  return enabled ? stats : EMPTY_STATS;
}

function computeRssBreakdown(
  processStats: ProcessStatsResponse | null,
): Pick<PaneLiveStats, 'rootRssBytes' | 'mcpRssBytes' | 'topChildCommand'> {
  if (!processStats?.supported || !processStats.nodes?.length) {
    return { rootRssBytes: null, mcpRssBytes: null, topChildCommand: null };
  }
  const root = processStats.nodes[0];
  const children = processStats.nodes.filter((node) => node.pid !== root.pid);
  const mcpRssBytes = children
    .filter((node) => /mcp|ruflo|claude-flow|context7/i.test(`${node.command} ${node.args}`))
    .reduce((sum, node) => sum + node.rssBytes, 0);
  const topChild = children.reduce<ProcessStatsNode | null>(
    (top, node) => (!top || node.rssBytes > top.rssBytes ? node : top),
    null,
  );
  return {
    rootRssBytes: root.rssBytes > 0 ? root.rssBytes : null,
    mcpRssBytes: mcpRssBytes > 0 ? mcpRssBytes : null,
    topChildCommand: topChild?.command || null,
  };
}
```

Lint contingency: the current file's comments show this repo enforces `react-hooks/set-state-in-effect` for SYNCHRONOUS setState in an effect body. If `npx eslint` flags the `setStats` calls above, defer each one through a guarded microtask instead (same pattern the `useSwarmLiveStats` rewrite below uses):

```ts
  // At the top of the effect:
  let alive = true;
  const commit = (next: PaneLiveStats | ((prev: PaneLiveStats) => PaneLiveStats)): void => {
    queueMicrotask(() => {
      if (alive) setStats(next);
    });
  };
  // …replace every `setStats(…)` in the effect with `commit(…)`, and return:
  return () => {
    alive = false;
  };
```

The fake-timer tests still pass — `act()` + `advanceTimersByTimeAsync` flush microtasks.

- [ ] **Step 2.10: Run the pane tests + lint the touched files**

Run: `npx vitest run src/renderer/features/command-room/usePaneLiveStats.test.ts`
Expected: PASS (all pre-existing tests + the 2 new ones).

Run: `npx eslint src/renderer/features/command-room/usePaneLiveStats.ts src/renderer/lib/ --max-warnings 0`
Expected: clean (apply the lint contingency above if `set-state-in-effect` fires).

- [ ] **Step 2.11: Write the failing swarm-stats test**

Create `src/renderer/features/right-rail/useSwarmLiveStats.test.ts`:

```ts
// @vitest-environment jsdom
//
// perf-hot-paths Task 2 — useSwarmLiveStats rides the SHARED session-stats
// poller: no own RPC loop, per-session dedupe with PaneHeader, M2 seed
// semantics (no lifetime-count spike) preserved.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const sessionSummaryMock = vi.fn();
const processStatsMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {},
  rpcSilent: {
    usage: {
      sessionSummary: (...args: unknown[]) => sessionSummaryMock(...args),
    },
    pty: {
      processStats: (...args: unknown[]) => processStatsMock(...args),
    },
  },
}));

import { useSwarmLiveStats } from './useSwarmLiveStats';
import { __resetSessionStatsPoller } from '@/renderer/lib/use-session-stats-poll';

function summary(outputTokens: number) {
  return {
    inputTokens: 0,
    outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: null,
    turnCount: 1,
  };
}

async function tickMs(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  __resetSessionStatsPoller();
  processStatsMock.mockResolvedValue({ supported: false, rssBytes: 0, processCount: 0, nodes: [] });
});

afterEach(() => {
  cleanup();
  __resetSessionStatsPoller();
  vi.useRealTimers();
});

describe('useSwarmLiveStats — shared-poller aggregate', () => {
  it('seeds baselines silently (no lifetime spike), then sums per-session deltas', async () => {
    const calls = new Map<string, number>();
    const tokens: Record<string, number[]> = { a: [100, 130, 130], b: [200, 250, 250] };
    sessionSummaryMock.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      const n = calls.get(sessionId) ?? 0;
      calls.set(sessionId, n + 1);
      const seq = tokens[sessionId]!;
      return summary(seq[Math.min(n, seq.length - 1)]!);
    });

    const { result } = renderHook(() => useSwarmLiveStats(['a', 'b'], true));

    // Poll #1 (a:100, b:200) seeds baselines — delta MUST be 0, not 300.
    await tickMs(0);
    expect(result.current.hasData).toBe(true);
    expect(result.current.swarmTokenDelta).toBe(0);

    // Poll #2 (a:+30, b:+50) → summed delta 80.
    await tickMs(3_000);
    expect(result.current.swarmTokenDelta).toBe(80);

    // Poll #3 (no movement) → deltas decay to 0.
    await tickMs(3_000);
    expect(result.current.swarmTokenDelta).toBe(0);
  });

  it('shares the per-session RPC with other subscribers (one sessionSummary per tick per id)', async () => {
    sessionSummaryMock.mockResolvedValue(summary(100));
    const h1 = renderHook(() => useSwarmLiveStats(['a'], true));
    const h2 = renderHook(() => useSwarmLiveStats(['a'], true));
    await tickMs(0);
    expect(sessionSummaryMock).toHaveBeenCalledTimes(1);
    await tickMs(3_000);
    expect(sessionSummaryMock).toHaveBeenCalledTimes(2);
    h1.unmount();
    h2.unmount();
  });

  it('returns EMPTY and never polls when disabled', async () => {
    const { result } = renderHook(() => useSwarmLiveStats(['a'], false));
    await tickMs(6_000);
    expect(sessionSummaryMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({ swarmTokenDelta: 0, hasData: false });
  });
});
```

- [ ] **Step 2.12: Run to verify it fails**

Run: `npx vitest run src/renderer/features/right-rail/useSwarmLiveStats.test.ts`
Expected: FAIL — the current hook polls via `rpc.usage.sessionSummary` (mock provides `rpc: {}`), so the dedupe and seed assertions break.

- [ ] **Step 2.13: Rewrite `useSwarmLiveStats.ts`**

Replace the entire contents of `src/renderer/features/right-rail/useSwarmLiveStats.ts` with:

```ts
// BSP-O1 + perf-hot-paths Task 2 — swarm-level token-delta aggregator for the
// Sigma panel Canvas sub-tab. No own RPC loop anymore: each swarm session is
// subscribed on the SHARED session-stats poller (dedupes with any PaneHeader
// watching the same session; pauses while the window is hidden) and
// per-session output-token deltas are accumulated, emitting once per
// notification burst via a microtask coalesce. M2 (seed without a lifetime
// spike) and L2 (roster prune) semantics preserved.

import { useEffect, useRef, useState } from 'react';
import { sessionStatsPoller } from '@/renderer/lib/use-session-stats-poll';

export interface SwarmLiveStats {
  /** Sum of output-token deltas across all swarm sessions since each
   *  session's previous poll. */
  swarmTokenDelta: number;
  /** True once at least one session has recorded a usage turn. */
  hasData: boolean;
}

const EMPTY_STATS: SwarmLiveStats = { swarmTokenDelta: 0, hasData: false };

/**
 * Aggregate live output-token delta across all agent sessions in a swarm.
 *
 * @param sessionIds - The agent_sessions ids belonging to the active swarm.
 * @param enabled    - Only subscribe while true (pass `swarm.status === 'running'`).
 */
export function useSwarmLiveStats(sessionIds: string[], enabled: boolean): SwarmLiveStats {
  const [stats, setStats] = useState<SwarmLiveStats>(EMPTY_STATS);
  // Baselines persist across roster changes within one running swarm (M2/L2).
  const baselinesRef = useRef<Map<string, number>>(new Map());

  // Stable dep value for the array identity.
  const idsKey = sessionIds.join(',');

  useEffect(() => {
    if (!enabled || idsKey === '') {
      baselinesRef.current.clear();
      return;
    }
    const ids = idsKey.split(',').filter(Boolean);
    const baselines = baselinesRef.current;
    // L2 — prune baselines for sessions no longer in the roster.
    const live = new Set(ids);
    for (const key of baselines.keys()) {
      if (!live.has(key)) baselines.delete(key);
    }

    const deltas = new Map<string, number>();
    let hasData = false;
    let scheduled = false;
    let alive = true;

    const emit = (): void => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!alive) return;
        let total = 0;
        for (const d of deltas.values()) total += d;
        setStats({ swarmTokenDelta: total, hasData });
      });
    };

    const onUpdate = (id: string): void => {
      const summary = sessionStatsPoller.getSnapshot(id)?.summary;
      if (!summary || summary.turnCount === 0) return;
      hasData = true;
      const base = baselines.get(id);
      baselines.set(id, summary.outputTokens);
      if (base === undefined) {
        // M2 — seed WITHOUT emitting a delta: prev=0 would report the full
        // lifetime output-token count (a huge bogus spike for resumed swarms).
        emit();
        return;
      }
      const delta = summary.outputTokens - base;
      if (delta > 0) deltas.set(id, delta);
      else deltas.delete(id);
      emit();
    };

    const unsubs = ids.map((id) => sessionStatsPoller.subscribe(id, () => onUpdate(id)));

    return () => {
      alive = false;
      unsubs.forEach((off) => off());
    };
  }, [enabled, idsKey]);

  return enabled ? stats : EMPTY_STATS;
}
```

- [ ] **Step 2.14: Run the swarm tests + every suite this task touched**

Run: `npx vitest run src/renderer/features/right-rail/useSwarmLiveStats.test.ts src/renderer/features/command-room/usePaneLiveStats.test.ts src/renderer/lib/shared-poll.test.ts src/renderer/lib/use-git-status-poll.test.ts`
Expected: PASS — including the UNTOUCHED `use-git-status-poll.test.ts` (its module is rebased in Task 3, not here).

- [ ] **Step 2.15: Commit**

```bash
git add src/renderer/lib/shared-poll.ts src/renderer/lib/shared-poll.test.ts src/renderer/lib/use-session-stats-poll.ts src/renderer/lib/use-git-activity-poll.ts src/renderer/features/command-room/usePaneLiveStats.ts src/renderer/features/command-room/usePaneLiveStats.test.ts src/renderer/features/right-rail/useSwarmLiveStats.ts src/renderer/features/right-rail/useSwarmLiveStats.test.ts
git commit -m "perf(renderer): refcounted shared session-stats poller — visibility pause + per-session RPC dedupe"
```

---

### Task 3: Count-only `git.statusSummary` RPC + poller phase stagger

`PaneShell` consumes only a COUNT (`useUncommittedCount`), but the 15 s poller ships full staged/unstaged/untracked filename arrays and spawns 4 git procs per poll. Add a count-only RPC backed by ONE `git status --porcelain` proc, rebase the poller onto the Task-2 factory with `staggerPhase`, and keep full `git.status` for the one-shot consumers (ArtifactsPanel, GitRoom, OrchestratorPanel, SessionList).

**A new RPC = FOUR mirrored sites** (sibling-twin discipline): `rpc-router.ts` handler, `core/rpc/schemas.ts`, `shared/rpc-channels.ts` CHANNELS, `shared/router-shape.ts`. `src/shared/rpc-channels.test.ts` is the drift net — run it.

**Files:**
- Modify: `src/shared/types.ts` (after `GitStatus`, ~line 88)
- Modify: `src/main/core/git/git-ops.ts` (after `gitStatus`, ~line 115)
- Test: `src/main/core/git/git-ops-summary.test.ts` (new)
- Modify: `src/main/core/rpc/schemas.ts` (next to `GIT_STATUS_OUTPUT` :50 and `'git.status'` :473)
- Modify: `src/main/rpc-router.ts` (`git` controller, next to `status:` :1488; import at :32)
- Modify: `src/shared/rpc-channels.ts` (after `'git.status'` :83)
- Modify: `src/shared/router-shape.ts` (git namespace :321)
- Modify: `src/renderer/lib/use-git-status-poll.ts` (full rewrite)
- Modify: `src/renderer/lib/use-git-status-poll.test.ts` (full rewrite)

- [ ] **Step 3.1: Write the failing git-ops test**

Create `src/main/core/git/git-ops-summary.test.ts` (mirrors the established mock pattern of `git-ops-panel.test.ts`):

```ts
// perf-hot-paths Task 3 — count-only gitStatusSummary. Mocks execCmd +
// fs.existsSync (no real git proc; mirrors git-ops-panel.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
}));

vi.mock('../../lib/exec', () => ({
  execCmd: vi.fn(),
}));

import fs from 'node:fs';
import { execCmd } from '../../lib/exec';
import { gitStatusSummary } from './git-ops';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecCmd = execCmd as any as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExistsSync = (fs as any as { existsSync: ReturnType<typeof vi.fn> }).existsSync;

function ok(stdout = ''): { stdout: string; stderr: string; code: number; maxBufferExceeded: boolean } {
  return { stdout, stderr: '', code: 0, maxBufferExceeded: false };
}

function fail(code = 128): { stdout: string; stderr: string; code: number; maxBufferExceeded: boolean } {
  return { stdout: '', stderr: 'fatal: not a git repository', code, maxBufferExceeded: false };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockExistsSync.mockReturnValue(true);
});

describe('gitStatusSummary', () => {
  it('counts with EXACT useUncommittedCount parity (MM double-counts: staged AND unstaged)', async () => {
    // 'MM a.ts' → staged + unstaged (2); ' M b.ts' → unstaged (1); '?? c.ts' → untracked (1).
    mockExecCmd.mockResolvedValue(ok('MM a.ts\n M b.ts\n?? c.ts\n'));
    expect(await gitStatusSummary('/repo')).toEqual({ uncommitted: 4, clean: false });
  });

  it('clean tree → uncommitted 0, clean true', async () => {
    mockExecCmd.mockResolvedValue(ok(''));
    expect(await gitStatusSummary('/repo')).toEqual({ uncommitted: 0, clean: true });
  });

  it('non-zero git exit (not a work tree) → null', async () => {
    mockExecCmd.mockResolvedValue(fail());
    expect(await gitStatusSummary('/not-a-repo')).toBeNull();
  });

  it('missing path → null WITHOUT spawning git', async () => {
    mockExistsSync.mockReturnValue(false);
    expect(await gitStatusSummary('/gone')).toBeNull();
    expect(mockExecCmd).not.toHaveBeenCalled();
  });

  it('spawns exactly ONE git process (vs gitStatus four)', async () => {
    mockExecCmd.mockResolvedValue(ok('?? a.ts\n'));
    await gitStatusSummary('/repo');
    expect(mockExecCmd).toHaveBeenCalledTimes(1);
    expect(mockExecCmd).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain=v1', '-uall'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});
```

- [ ] **Step 3.2: Run to verify it fails**

Run: `npx vitest run src/main/core/git/git-ops-summary.test.ts`
Expected: FAIL — `gitStatusSummary` is not exported.

- [ ] **Step 3.3: Implement `gitStatusSummary` + the shared type**

In `src/shared/types.ts`, immediately after the `GitStatus` interface (line 88):

```ts
/** perf-hot-paths Task 3 — count-only mirror of GitStatus for the pane-header
 *  15 s poll. One git proc + a 2-field payload instead of gitStatus's four
 *  procs + full filename arrays. */
export interface GitStatusSummary {
  /** staged + unstaged + untracked entries, with gitStatus's exact
   *  double-count semantics (an 'MM' file counts as staged AND unstaged). */
  uncommitted: number;
  clean: boolean;
}
```

In `src/main/core/git/git-ops.ts`, add `GitStatusSummary` to the type import from `'../../../shared/types'` (line 16-22), then add after `gitStatus` (line 115):

```ts
/**
 * perf-hot-paths Task 3 — count-only status for the pane-header badge. ONE
 * git proc (`status --porcelain`) instead of gitStatus's four (rev-parse
 * --show-toplevel, rev-parse --abbrev-ref, status, rev-list), and a 2-field
 * payload instead of full staged/unstaged/untracked filename arrays.
 * `git status` exits non-zero outside a work tree, so the repo probe is
 * folded in for free. Count parity with useUncommittedCount's historical
 * `staged.length + unstaged.length + untracked.length` is preserved exactly
 * (an 'MM' line increments both staged AND unstaged).
 */
export async function gitStatusSummary(cwd: string): Promise<GitStatusSummary | null> {
  if (!fs.existsSync(cwd)) return null;
  const res = await execCmd('git', ['status', '--porcelain=v1', '-uall'], {
    cwd,
    timeoutMs: 8_000,
  });
  if (res.code !== 0) return null; // not a git work tree (or git unavailable)

  let uncommitted = 0;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') {
      uncommitted += 1;
      continue;
    }
    if (x !== ' ' && x !== '?') uncommitted += 1;
    if (y !== ' ' && y !== '?') uncommitted += 1;
  }
  return { uncommitted, clean: uncommitted === 0 };
}
```

- [ ] **Step 3.4: Run the git-ops test**

Run: `npx vitest run src/main/core/git/git-ops-summary.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 3.5: Wire the RPC across all FOUR mirrored sites**

1. `src/main/core/rpc/schemas.ts` — below `GIT_STATUS_OUTPUT` (line 61):

```ts
const GIT_STATUS_SUMMARY_OUTPUT = z
  .object({
    uncommitted: z.number().int().nonnegative(),
    clean: z.boolean(),
  })
  .passthrough()
  .nullable();
```

and next to `'git.status'` (line 473):

```ts
  'git.statusSummary': { input: PATH_STR, output: GIT_STATUS_SUMMARY_OUTPUT },
```

2. `src/main/rpc-router.ts` — add `gitStatusSummary` to the git-ops import block (line 32), then in the git controller next to `status:` (line 1488):

```ts
    // perf-hot-paths Task 3 — count-only summary for the pane-header poller.
    statusSummary: async (cwd: string) => gitStatusSummary(cwd),
```

3. `src/shared/rpc-channels.ts` — after `'git.status',` (line 83):

```ts
  'git.statusSummary',
```

4. `src/shared/router-shape.ts` — in the `git` namespace after `status:` (line 322), and add `GitStatusSummary` to the file's type imports from `./types`:

```ts
    /** perf-hot-paths Task 3 — count-only status for the pane-header poll. */
    statusSummary: (cwd: string) => Promise<GitStatusSummary | null>;
```

- [ ] **Step 3.6: Run the channel drift net**

Run: `npx vitest run src/shared/rpc-channels.test.ts`
Expected: PASS — proves handler ↔ CHANNELS ↔ schema wiring is complete.

- [ ] **Step 3.7: Rewrite the poller test (failing)**

Replace the entire contents of `src/renderer/lib/use-git-status-poll.test.ts` with:

```ts
// @vitest-environment jsdom
//
// PERF-6 + perf-hot-paths Task 3 — count-only shared per-repo git-status
// poller. The pane-header path now fetches `git.statusSummary` (ONE git proc,
// 2-field payload) instead of the full `git.status`. Factory invariants
// (visibility pause, overlap guard, teardown) are covered by
// shared-poll.test.ts; this file covers the count-only consumer contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    git: {
      statusSummary: vi.fn(),
    },
  },
  rpc: {},
}));

import { rpcSilent } from '@/renderer/lib/rpc';
import { useUncommittedCount, __resetGitStatusPollers } from './use-git-status-poll';

const mockSummary = (
  rpcSilent as unknown as { git: { statusSummary: ReturnType<typeof vi.fn> } }
).git.statusSummary;

beforeEach(() => {
  vi.useFakeTimers();
  mockSummary.mockReset();
  __resetGitStatusPollers();
});

afterEach(() => {
  cleanup();
  __resetGitStatusPollers();
  vi.useRealTimers();
});

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useUncommittedCount — count-only shared poller', () => {
  it('two panes on the same repo share ONE statusSummary RPC and both get the count', async () => {
    mockSummary.mockResolvedValue({ uncommitted: 3, clean: false });

    const a = renderHook(() => useUncommittedCount('/repo'));
    const b = renderHook(() => useUncommittedCount('/repo'));
    await flushMicrotasks();

    expect(mockSummary).toHaveBeenCalledTimes(1);
    expect(mockSummary).toHaveBeenCalledWith('/repo');
    expect(a.result.current).toBe(3);
    expect(b.result.current).toBe(3);
    a.unmount();
    b.unmount();
  });

  it('null summary (not a repo) → null count; null path → disabled, no RPC', async () => {
    mockSummary.mockResolvedValue(null);
    const a = renderHook(() => useUncommittedCount('/not-a-repo'));
    const b = renderHook(() => useUncommittedCount(null));
    await flushMicrotasks();

    expect(a.result.current).toBeNull();
    expect(b.result.current).toBeNull();
    expect(mockSummary).toHaveBeenCalledTimes(1); // only the real path polled
    a.unmount();
    b.unmount();
  });

  it('distinct repo paths each get their own poll', async () => {
    mockSummary.mockResolvedValue({ uncommitted: 1, clean: false });
    const a = renderHook(() => useUncommittedCount('/repo-a'));
    const b = renderHook(() => useUncommittedCount('/repo-b'));
    await flushMicrotasks();

    expect(mockSummary).toHaveBeenCalledTimes(2);
    expect(mockSummary).toHaveBeenCalledWith('/repo-a');
    expect(mockSummary).toHaveBeenCalledWith('/repo-b');
    a.unmount();
    b.unmount();
  });

  it('staggered interval: exactly one recurring tick within the first 15 s window', async () => {
    mockSummary.mockResolvedValue({ uncommitted: 0, clean: true });
    const a = renderHook(() => useUncommittedCount('/repo'));
    await flushMicrotasks();
    expect(mockSummary).toHaveBeenCalledTimes(1); // immediate

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockSummary).toHaveBeenCalledTimes(2); // one phase-offset tick

    a.unmount();
  });

  it('tears down when the last subscriber unmounts (no further RPCs)', async () => {
    mockSummary.mockResolvedValue({ uncommitted: 1, clean: false });
    const a = renderHook(() => useUncommittedCount('/repo'));
    await flushMicrotasks();
    a.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockSummary).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3.8: Run to verify it fails**

Run: `npx vitest run src/renderer/lib/use-git-status-poll.test.ts`
Expected: FAIL — the current module fetches `rpcSilent.git.status` (now unmocked) and exports `useGitStatusPoll`.

- [ ] **Step 3.9: Rewrite `use-git-status-poll.ts`**

Replace the entire contents of `src/renderer/lib/use-git-status-poll.ts` with:

```ts
// PERF-6 + perf-hot-paths Task 3 — refcounted shared per-repo COUNT-ONLY
// git-status poller for PaneShell's uncommitted badge (PaneShell.tsx:114).
//
// History: PERF-6 deduped N same-repo panes onto one 15 s `git.status` poll.
// But worktree-per-pane defeats per-repoPath dedupe (every pane = a distinct
// key), and the badge consumes ONLY a count while git.status spawned 4 git
// procs and shipped full staged/unstaged/untracked filename arrays per poll.
// Now: `git.statusSummary` (ONE git proc, 2-field payload) on the generic
// shared-poll factory, with per-key phase stagger so 20 worktree panes don't
// land 20 git spawns in one synchronized burst.
//
// The full-status `useGitStatusPoll` hook was deleted — it had NO production
// consumers (one-shot callers use rpc.git.status directly). Re-add on top of
// the factory if a live full-status subscriber ever appears.

import { useCallback, useSyncExternalStore } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import { createSharedPoller } from '@/renderer/lib/shared-poll';
import type { GitStatusSummary } from '@/shared/types';

const POLL_INTERVAL_MS = 15_000;

const poller = createSharedPoller<GitStatusSummary | null>({
  intervalMs: POLL_INTERVAL_MS,
  staggerPhase: true,
  fetch: (repoPath) => rpcSilent.git.statusSummary(repoPath),
});

const EMPTY_UNSUBSCRIBE = (): void => undefined;

/**
 * Count of uncommitted changes (staged + unstaged + untracked) for a repo
 * path, or `null` when the path is absent or the repo status is unavailable.
 * Preserves the exact `number | null` shape PaneShell has always consumed.
 * N panes on the same `repoPath` share ONE 15 s poll; polling pauses while
 * the window is hidden. Never throws.
 */
export function useUncommittedCount(repoPath: string | null | undefined): number | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      repoPath ? poller.subscribe(repoPath, onStoreChange) : EMPTY_UNSUBSCRIBE,
    [repoPath],
  );
  const getSnapshot = useCallback(
    () => (repoPath ? poller.getSnapshot(repoPath) : null),
    [repoPath],
  );
  const summary = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return summary ? summary.uncommitted : null;
}

/** Test-only helper. */
export function __resetGitStatusPollers(): void {
  poller.__reset();
}
```

- [ ] **Step 3.10: Run the suites + sibling sweep**

Run: `npx vitest run src/renderer/lib/use-git-status-poll.test.ts src/main/core/git/ src/shared/rpc-channels.test.ts`
Expected: PASS.

Then sibling-twin sweep (the deleted export must have zero remaining importers):

Run: `grep -rn "useGitStatusPoll" src/ --include="*.ts" --include="*.tsx"`
Expected: zero hits outside `use-git-status-poll.ts`'s own comment.

- [ ] **Step 3.11: Commit**

```bash
git add src/shared/types.ts src/shared/router-shape.ts src/shared/rpc-channels.ts src/main/core/git/git-ops.ts src/main/core/git/git-ops-summary.test.ts src/main/core/rpc/schemas.ts src/main/rpc-router.ts src/renderer/lib/use-git-status-poll.ts src/renderer/lib/use-git-status-poll.test.ts
git commit -m "perf(git): count-only git.statusSummary for pane-header poll — 1 proc + 2-field payload, phase-staggered"
```

---

### Task 4: Cached async login-shell PATH bootstrap (gate the first PTY spawn, not window creation)

`bootstrapShellPath()` runs a **sync** `spawnSync(shell, ['-ilc', …], {timeout: 3000})` inside `whenReady` BEFORE `registerRouter()` + `createWindow()` — +200 ms–1.5 s cold boot on heavy zsh configs (darwin packaged builds only). New flow: apply a **cached** merged PATH synchronously (fast JSON read from userData), kick the live login-shell resolve **async**, and gate only PTY-spawn paths on readiness with a 3.5 s cap. Win/Linux + dev stay exact no-ops.

**Files:**
- Create: `src/main/core/util/shell-path.ts` (pure logic + readiness gate; NO electron import — vitest-safe)
- Test: `src/main/core/util/shell-path.test.ts`
- Modify: `electron/main.ts` (replace `bootstrapShellPath` :356-389 + its call :740; drop the `spawnSync` import :9 — it has no other user)
- Modify: `src/main/rpc-router.ts` (gate 3 spawn handlers: `pty.create` :961, `pty.spawnScratch` :1035, `providers.spawnInstall` :1334)
- Modify: `src/main/core/workspaces/launcher.ts` (gate `executeLaunchPlan`'s `resolveAndSpawn` call :460 — this covers panes resume/respawn, workspace open, and assistant spawns, since `providers/launcher.ts`'s `resolveAndSpawn` is a sync callee)

- [ ] **Step 4.1: Write the failing test**

Create `src/main/core/util/shell-path.test.ts`:

```ts
// perf-hot-paths Task 4 — cached async login-shell PATH bootstrap. All deps
// injected (no electron, no real shell spawn). Real timers — async settling
// is driven by resolving the injected promises.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mergeShellPath,
  startShellPathBootstrap,
  whenShellPathReady,
  __resetShellPathForTests,
  type ShellPathDeps,
} from './shell-path';

beforeEach(() => {
  __resetShellPathForTests();
});

describe('mergeShellPath', () => {
  it('prefers shell-resolved entries first and dedupes', () => {
    expect(mergeShellPath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin', ':')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin',
    );
  });

  it('drops empty segments', () => {
    expect(mergeShellPath(':/a::', '/b:', ':')).toBe('/a:/b');
  });
});

function makeDeps(over: Partial<ShellPathDeps> = {}): ShellPathDeps & {
  setEnvPath: ReturnType<typeof vi.fn>;
  writeCache: ReturnType<typeof vi.fn>;
} {
  let envPath = '/usr/bin:/bin';
  const deps = {
    platform: 'darwin' as NodeJS.Platform,
    isDev: false,
    shell: '/bin/zsh',
    pathDelimiter: ':',
    readCache: () => null as string | null,
    writeCache: vi.fn(),
    getEnvPath: () => envPath,
    setEnvPath: vi.fn((next: string) => {
      envPath = next;
    }),
    resolveShellPath: vi.fn(async () => '/opt/homebrew/bin:/usr/bin'),
    timeoutMs: 3_000,
    ...over,
  };
  return deps;
}

describe('startShellPathBootstrap', () => {
  it('warm boot: applies the cached PATH synchronously and is ready immediately', async () => {
    const deps = makeDeps({ readCache: () => '/opt/homebrew/bin' });
    startShellPathBootstrap(deps);

    // Cache applied before ANY async work (DMG-launch ENOENT window closed).
    expect(deps.setEnvPath).toHaveBeenCalledWith('/opt/homebrew/bin:/usr/bin:/bin');
    await expect(whenShellPathReady(10)).resolves.toBeUndefined();
  });

  it('warm boot: the background refresh still updates env + rewrites the cache', async () => {
    const deps = makeDeps({ readCache: () => '/stale/bin' });
    await startShellPathBootstrap(deps); // returned promise = refresh completion
    expect(deps.writeCache).toHaveBeenCalledWith('/opt/homebrew/bin:/usr/bin');
    // setEnvPath called twice: cache apply, then live-resolve merge.
    expect(deps.setEnvPath).toHaveBeenCalledTimes(2);
  });

  it('cold boot (no cache): not ready until the live resolve lands', async () => {
    let release: (v: string | null) => void = () => {};
    const deps = makeDeps({
      resolveShellPath: vi.fn(
        () =>
          new Promise<string | null>((r) => {
            release = r;
          }),
      ),
    });
    const refresh = startShellPathBootstrap(deps);

    let settled = false;
    void whenShellPathReady(60_000).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false); // first spawn would still be waiting

    release('/opt/homebrew/bin');
    await refresh;
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(true);
    expect(deps.setEnvPath).toHaveBeenCalledWith('/opt/homebrew/bin:/usr/bin:/bin');
    expect(deps.writeCache).toHaveBeenCalledWith('/opt/homebrew/bin');
  });

  it('whenShellPathReady caps the wait (a hung shell never deadlocks spawns)', async () => {
    const deps = makeDeps({
      resolveShellPath: vi.fn(() => new Promise<string | null>(() => {})), // never resolves
    });
    startShellPathBootstrap(deps);
    await expect(whenShellPathReady(50)).resolves.toBeUndefined(); // ~50ms real wait
  });

  it('non-darwin and dev are exact no-ops (ready immediately, no resolve)', async () => {
    const win = makeDeps({ platform: 'win32' });
    startShellPathBootstrap(win);
    expect(win.resolveShellPath).not.toHaveBeenCalled();
    await expect(whenShellPathReady(10)).resolves.toBeUndefined();

    __resetShellPathForTests();
    const dev = makeDeps({ isDev: true });
    startShellPathBootstrap(dev);
    expect(dev.resolveShellPath).not.toHaveBeenCalled();
    await expect(whenShellPathReady(10)).resolves.toBeUndefined();
  });

  it('a null resolve (shell failed) keeps the cache-less env untouched but still resolves ready', async () => {
    const deps = makeDeps({ resolveShellPath: vi.fn(async () => null) });
    await startShellPathBootstrap(deps);
    expect(deps.setEnvPath).not.toHaveBeenCalled();
    expect(deps.writeCache).not.toHaveBeenCalled();
    await expect(whenShellPathReady(10)).resolves.toBeUndefined();
  });

  it('whenShellPathReady resolves immediately when bootstrap never ran (tests, win32 boot paths)', async () => {
    await expect(whenShellPathReady(10)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4.2: Run to verify it fails**

Run: `npx vitest run src/main/core/util/shell-path.test.ts`
Expected: FAIL — `Cannot find module './shell-path'`.

- [ ] **Step 4.3: Implement `shell-path.ts`**

Create `src/main/core/util/shell-path.ts`:

```ts
// perf-hot-paths Task 4 — cached async login-shell PATH bootstrap.
//
// BUG-V1.1-03-PROV background: a DMG-launched app gets the truncated
// NSWorkspace PATH, so provider CLIs under /opt/homebrew/bin etc. ENOENT.
// The original fix spawned the user's login shell SYNCHRONOUSLY inside
// whenReady (3 s timeout) BEFORE registerRouter()+createWindow() — +200 ms
// to 1.5 s of cold-boot wall time on heavy zsh configs.
//
// New flow (darwin packaged only; win/linux/dev are exact no-ops):
//   1. Apply the previously-cached merged PATH synchronously (instant).
//   2. Resolve the live login-shell PATH ASYNC; merge + persist when it lands.
//   3. Window creation never waits. Only PTY-spawn paths await
//      `whenShellPathReady()` (≤3.5 s cap) — on a warm boot that resolves
//      immediately; on a true first run the FIRST spawn waits for the live
//      resolve so `node-pty.spawn('claude', …)` can't ENOENT.
//
// NOTE on "cache in KV": the kv SQLite table only becomes safely available
// after registerRouter() opens/migrates the DB, which is exactly the phase
// this bootstrap must precede. The caller injects a userData JSON-file cache
// instead — same persistence, zero DB coupling at boot (see electron/main.ts).
//
// No electron imports here — everything is injected so vitest can cover it.

import { execFile } from 'node:child_process';

export interface ShellPathDeps {
  platform: NodeJS.Platform;
  isDev: boolean;
  shell: string;
  pathDelimiter: string;
  /** Read the cached shell PATH (string) or null. Must be fast + sync. */
  readCache: () => string | null;
  /** Persist the freshly-resolved shell PATH. Best-effort. */
  writeCache: (shellPath: string) => void;
  getEnvPath: () => string;
  setEnvPath: (next: string) => void;
  /** Injectable for tests; defaults to the real login-shell exec. */
  resolveShellPath?: (shell: string, timeoutMs: number) => Promise<string | null>;
  timeoutMs?: number;
}

/**
 * Dedup-merge two PATH strings, shell-resolved entries first (so
 * /opt/homebrew/bin wins over a truncated /usr/bin shim). Pure.
 */
export function mergeShellPath(fromShell: string, existing: string, delimiter: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...fromShell.split(delimiter), ...existing.split(delimiter)]) {
    if (entry && !seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(delimiter);
}

/**
 * Default resolver: `-i` (interactive) so .zshrc is sourced, `-l` (login) so
 * /etc/profile + ~/.zprofile run, `-c` to evaluate one statement and exit.
 * TERM=dumb prevents prompt-theme work. Resolves null on any failure.
 */
export function defaultResolveShellPath(shell: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', 'printf %s "$PATH"'],
      { timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return resolve(null);
        resolve(stdout.trim());
      },
    );
  });
}

let readyPromise: Promise<void> | null = null;

/**
 * Start the bootstrap. Returns the BACKGROUND refresh completion promise
 * (await it in tests). Readiness for spawn-gating is exposed separately via
 * `whenShellPathReady()`:
 *   - warm boot (cache hit) → ready immediately;
 *   - cold boot (no cache)  → ready when the live resolve settles.
 */
export function startShellPathBootstrap(deps: ShellPathDeps): Promise<void> {
  if (deps.platform !== 'darwin' || deps.isDev) {
    readyPromise = Promise.resolve();
    return readyPromise;
  }

  let cacheHit = false;
  try {
    const cached = deps.readCache();
    if (cached) {
      deps.setEnvPath(mergeShellPath(cached, deps.getEnvPath(), deps.pathDelimiter));
      cacheHit = true;
    }
  } catch {
    /* unreadable cache = cold path */
  }

  const resolveFn = deps.resolveShellPath ?? defaultResolveShellPath;
  const refresh = resolveFn(deps.shell, deps.timeoutMs ?? 3_000)
    .then((shellPath) => {
      if (!shellPath) return;
      deps.setEnvPath(mergeShellPath(shellPath, deps.getEnvPath(), deps.pathDelimiter));
      try {
        deps.writeCache(shellPath);
      } catch {
        /* cache write is best-effort */
      }
    })
    .catch(() => undefined);

  readyPromise = cacheHit ? Promise.resolve() : refresh;
  return refresh;
}

/**
 * Await PATH readiness before a PTY spawn, capped at `timeoutMs` so a hung
 * login shell can never deadlock spawning. Resolves immediately when the
 * bootstrap never ran (win/linux/dev/tests) or already settled.
 */
export function whenShellPathReady(timeoutMs = 3_500): Promise<void> {
  if (!readyPromise) return Promise.resolve();
  const ready = readyPromise;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    // unref so a pending gate can't hold the process open at quit.
    (timer as { unref?: () => void }).unref?.();
    void ready.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Test-only. */
export function __resetShellPathForTests(): void {
  readyPromise = null;
}
```

- [ ] **Step 4.4: Run the test**

Run: `npx vitest run src/main/core/util/shell-path.test.ts`
Expected: PASS (9 tests; the timeout-cap test takes ~50 ms real time).

- [ ] **Step 4.5: Rewire `electron/main.ts`**

1. Delete the whole `bootstrapShellPath` function (lines 356-389) — keep its doc-comment block (lines 339-355) and move it above the new wiring. Keep `bootstrapNodeToolPath` (line 401) untouched — it is fs-only and cheap.
2. Remove `import { spawnSync } from 'node:child_process';` (line 9 — `bootstrapShellPath` was its only user; verify with `grep -n "spawnSync" electron/main.ts` → zero hits after the edit).
3. Add the import:

```ts
import { startShellPathBootstrap } from '../src/main/core/util/shell-path';
```

4. Add the cache helpers near the other top-level helpers:

```ts
// perf-hot-paths Task 4 — userData JSON cache for the resolved login-shell
// PATH ("KV" at a boot phase where the SQLite kv table isn't open yet).
function shellPathCacheFile(): string {
  return path.join(app.getPath('userData'), 'shell-path-cache.json');
}

function readShellPathCache(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(shellPathCacheFile(), 'utf8')) as {
      path?: unknown;
    };
    return typeof raw.path === 'string' && raw.path ? raw.path : null;
  } catch {
    return null;
  }
}

function writeShellPathCache(shellPath: string): void {
  try {
    fs.writeFileSync(
      shellPathCacheFile(),
      JSON.stringify({ path: shellPath, savedAt: Date.now() }),
    );
  } catch {
    /* best-effort */
  }
}
```

5. In `whenReady` (line 740) replace `bootstrapShellPath();` with:

```ts
  // BUG-V1.1-03-PROV + perf-hot-paths Task 4 — cached + ASYNC login-shell
  // PATH bootstrap. Warm boots apply the cached merged PATH instantly and
  // refresh in the background; window creation never waits. PTY-spawn paths
  // gate on whenShellPathReady() (≤3.5 s) so a true first run still can't
  // ENOENT the provider CLI. No-op on win/linux + dev.
  void startShellPathBootstrap({
    platform: process.platform,
    isDev: Boolean(devServerUrl),
    shell: process.env.SHELL || '/bin/zsh',
    pathDelimiter: path.delimiter,
    readCache: readShellPathCache,
    writeCache: writeShellPathCache,
    getEnvPath: () => process.env.PATH || '',
    setEnvPath: (next) => {
      process.env.PATH = next;
    },
  });
```

- [ ] **Step 4.6: Gate every PTY-spawn path**

Add `import { whenShellPathReady } from './core/util/shell-path';` to `src/main/rpc-router.ts` and `import { whenShellPathReady } from '../util/shell-path';` to `src/main/core/workspaces/launcher.ts`, then insert `await whenShellPathReady();` immediately before each registry-create:

1. `rpc-router.ts` `pty.create` handler — before `const rec = pty.create({` (line 961).
2. `rpc-router.ts` `pty.spawnScratch` handler — before `const rec = pty.create({` (line 1035), after the `assertAllowedPath` check.
3. `rpc-router.ts` `providers.spawnInstall` — before `const rec = pty.create({` (line 1334).
4. `workspaces/launcher.ts` `executeLaunchPlan` — before `const spawnResult = resolveAndSpawn(` (line 460). This single gate covers ALL `executeLaunchPlan` callers (panes resume/respawn, workspace open at `rpc-router.ts:1460`, assistant at `assistant/controller.ts:457`) because `providers/launcher.ts`'s `resolveAndSpawn` (:281, sync) is only reached through it or the gated handlers above.

Sibling-twin sweep — every registry-create site must sit behind a gate:

Run: `grep -rn "ptyRegistry\.create(\|pty\.create(" src/main --include="*.ts" | grep -v "\.test\."`
Expected: exactly 4 hits (`rpc-router.ts:961/1035/1334` neighborhoods + `providers/launcher.ts:329`), each either directly preceded by `await whenShellPathReady()` or (launcher.ts:329) reached only via the gated `executeLaunchPlan`.

- [ ] **Step 4.7: Run the affected suites + typecheck**

Run: `npx tsc -b && npx vitest run src/main/core/util/shell-path.test.ts src/main/rpc-router.wiring.test.ts src/shared/rpc-channels.test.ts`
Expected: PASS. (Boot behavior itself is exercised by CI e2e — do NOT launch the app locally.)

- [ ] **Step 4.8: Commit**

```bash
git add src/main/core/util/shell-path.ts src/main/core/util/shell-path.test.ts electron/main.ts src/main/rpc-router.ts src/main/core/workspaces/launcher.ts
git commit -m "perf(boot): cached async login-shell PATH bootstrap — gate first PTY spawn, not window creation"
```

---

### Task 5: 250 ms trailing coalesce in `runRefreshOnEvent`

A burst of `memory:changed`/`tasks:changed`/`skills:changed`/`review:changed` events fires N full-list refetches + N full `SET_MEMORIES`-class state replaces. One trailing debounce inside `runRefreshOnEvent` fixes all 4 channels. The mount-time hydration stays immediate (rooms must not appear 250 ms late on open).

**Files:**
- Modify: `src/renderer/app/state-hooks/parsers.ts:39-60`
- Modify: `src/renderer/app/state-hooks/parsers.test.ts` (new describe block)
- Modify: `src/renderer/app/state-hooks/use-live-events.test.ts:293-307` (event→refetch test must advance the window)

- [ ] **Step 5.1: Write the failing test**

In `src/renderer/app/state-hooks/parsers.test.ts`, extend the vitest import to `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';`, add `runRefreshOnEvent` to the `./parsers` import, and append:

```ts
describe('runRefreshOnEvent — perf-hot-paths Task 5: 250 ms trailing coalesce', () => {
  let eventHandler: (() => void) | null = null;
  const offSpy = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    eventHandler = null;
    offSpy.mockClear();
    vi.stubGlobal('window', {
      sigma: {
        eventOn: vi.fn((_name: string, handler: () => void) => {
          eventHandler = handler;
          return offSpy;
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('mount-time hydration fires immediately (no debounce on the first fetch)', () => {
    const fetcher = vi.fn(async () => {});
    const cleanup = runRefreshOnEvent(fetcher, 'memory:changed', 'memories');
    expect(fetcher).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('a burst of 5 events coalesces into ONE trailing refetch after 250 ms', () => {
    const fetcher = vi.fn(async () => {});
    const cleanup = runRefreshOnEvent(fetcher, 'memory:changed', 'memories');
    expect(fetcher).toHaveBeenCalledTimes(1); // mount fetch

    for (let i = 0; i < 5; i++) eventHandler!();
    vi.advanceTimersByTime(249);
    expect(fetcher).toHaveBeenCalledTimes(1); // still coalescing
    vi.advanceTimersByTime(1);
    expect(fetcher).toHaveBeenCalledTimes(2); // ONE trailing refetch
    cleanup();
  });

  it('a later event re-arms the trailing window (true trailing debounce)', () => {
    const fetcher = vi.fn(async () => {});
    const cleanup = runRefreshOnEvent(fetcher, 'tasks:changed', 'tasks');
    eventHandler!();
    vi.advanceTimersByTime(200);
    eventHandler!(); // re-arms at t=200
    vi.advanceTimersByTime(200); // t=400, window ends at 450
    expect(fetcher).toHaveBeenCalledTimes(1); // mount only
    vi.advanceTimersByTime(50);
    expect(fetcher).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('cleanup cancels a pending debounced refetch and unsubscribes', () => {
    const fetcher = vi.fn(async () => {});
    const cleanup = runRefreshOnEvent(fetcher, 'skills:changed', 'skills');
    eventHandler!();
    cleanup();
    vi.advanceTimersByTime(1_000);
    expect(fetcher).toHaveBeenCalledTimes(1); // mount fetch only
    expect(offSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 5.2: Run to verify it fails**

Run: `npx vitest run src/renderer/app/state-hooks/parsers.test.ts`
Expected: FAIL — burst test sees 6 calls (no coalesce); cleanup test sees 2.

- [ ] **Step 5.3: Implement the coalesce**

Replace `runRefreshOnEvent` in `src/renderer/app/state-hooks/parsers.ts` (lines 39-60) with:

```ts
/** Trailing-coalesce window for event-driven refetches. A burst of
 *  `memory:changed`/`tasks:changed`/`skills:changed`/`review:changed` events
 *  (e.g. a batch write emitting N change notifications) collapses into ONE
 *  full-list refetch + ONE state replace. */
const EVENT_REFRESH_DEBOUNCE_MS = 250;

/**
 * Shared shape for the per-workspace hydrate-on-mount-and-event pattern.
 * Mirrors the original `let alive = true / if (!alive) return / off()`
 * boilerplate so a stale fetch after unmount can't dispatch into a
 * torn-down provider. The fetcher receives an `isAlive()` getter that
 * must be re-checked after every `await` boundary.
 *
 * The MOUNT-time hydration fires immediately; EVENT-triggered refreshes are
 * trailing-coalesced over `debounceMs` (perf-hot-paths Task 5).
 *
 * Returns the useEffect cleanup function — call it as
 * `return runRefreshOnEvent(...)` from inside a useEffect.
 */
export function runRefreshOnEvent(
  fetcher: (isAlive: () => boolean) => Promise<void>,
  eventName: string,
  label: string,
  debounceMs = EVENT_REFRESH_DEBOUNCE_MS,
): () => void {
  let alive = true;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const refresh = () => {
    void (async () => {
      try {
        await fetcher(() => alive);
      } catch (err) {
        if (alive) console.error('Failed to load', label, err);
      }
    })();
  };
  // Mount-time hydration stays immediate — rooms must not open 250 ms stale.
  refresh();
  const onEvent = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (alive) refresh();
    }, debounceMs);
  };
  const off = window.sigma.eventOn(eventName, onEvent);
  return () => {
    alive = false;
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    off();
  };
}
```

- [ ] **Step 5.4: Run the parsers tests**

Run: `npx vitest run src/renderer/app/state-hooks/parsers.test.ts`
Expected: PASS.

- [ ] **Step 5.5: Fix the now-stale `use-live-events` assertion**

`src/renderer/app/state-hooks/use-live-events.test.ts:293-307` asserts a synchronous `review:changed` → refetch. Replace that single test with:

```ts
  it('still refreshes review state when the review:changed event fires (after the 250 ms coalesce)', async () => {
    vi.useFakeTimers();
    try {
      await renderLiveEvents(stateWith([session('s1')]));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(reviewListMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        sigma.emit('review:changed', { workspaceId: 'a' });
        await vi.advanceTimersByTimeAsync(250); // trailing coalesce window
      });

      expect(reviewListMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
```

(If `vi` is not already imported in that file it is — line 148 uses `vi.fn`.)

- [ ] **Step 5.6: Run the live-events suite**

Run: `npx vitest run src/renderer/app/state-hooks/use-live-events.test.ts src/renderer/app/state-hooks/parsers.test.ts`
Expected: PASS — all other tests in the file subscribe to non-debounced channels (`pty:error`, `notifications:changed` use direct `eventOn`, not `runRefreshOnEvent`) and are unaffected.

- [ ] **Step 5.7: Commit**

```bash
git add src/renderer/app/state-hooks/parsers.ts src/renderer/app/state-hooks/parsers.test.ts src/renderer/app/state-hooks/use-live-events.test.ts
git commit -m "perf(state): 250ms trailing coalesce in runRefreshOnEvent — one refetch per event burst, 4 channels"
```

---

### Final gate (run in MAIN, after all tasks)

- [ ] `npx tsc -b` — clean (main tsc also checks test files; worktree tsc is laxer — re-gate in main if tasks ran in worktrees).
- [ ] `npx eslint . --max-warnings 0` — clean.
- [ ] `npx vitest run` — full suite green. Under load, full-run timeouts in swarms/factory or VoiceTab are known flakes — re-run the failing file in isolation before reacting.
- [ ] `npm run product:check` — green.
- [ ] **NO local e2e** (`npx playwright test`, `electron:dev`) — it launches competing Electron windows on the operator's machine. e2e runs in the CI e2e-matrix on the PR.
- [ ] `npm run test:perf` is **operator-run only** — note in the PR description that it's the before/after measurement harness for findings 1-3, do not run it yourself.
- [ ] Final commit if gate fixes were needed: `git add -A && git commit -m "perf: hot-paths gate fixes"`.

---

## Coordination notes

1. **win32-platform-services (sibling plan, process-tree backend).** The seam is `ProcessLister` in `src/main/core/process/ps-snapshot.ts` — the win32 plan adds a `win32:` entry to `LISTERS` (one function returning `ProcessTreeNode[]`) and gets the TTL cache, in-flight dedupe, and `inspectProcessTreeCached` for free. It must NOT re-introduce a per-call platform branch above the cache, and must keep `supported: false` semantics for platforms without a lister. The sync `inspectProcessTree`/`stopProcessTrees` kill path is a separate concern that plan may also touch — `buildSubtree` is exported precisely so both paths share the subtree math. Merge order is flexible; if win32 lands first, rebase `ps-snapshot.ts` to call its lister instead of duplicating one.
2. **jorvis-renderer-fixes (sibling plan, in-flight overlap stopgap).** That plan adds a minimal in-flight guard to `usePaneLiveStats`/`useSwarmLiveStats` as a correctness stopgap. Task 2's factory has the overlap guard built in (`shared-poll.ts` `poll()` head) and **fully subsumes it**. If the stopgap lands first: Task 2's full-file rewrites of both hooks delete it — expect textual merge conflicts, resolve by taking this plan's versions. If this plan lands first: tell the jorvis lane to DROP its stopgap task.
3. **rpc-boundary plan (merge ordering on `rpc-router.ts`).** Tasks 1/3/4 all edit `src/main/rpc-router.ts` (handler at :1009, git controller at :1488, three gating awaits) — line numbers will drift if the rpc-boundary plan restructures the router first. Coordinate merge order; whichever lands second rebases by anchor text (`processStats: async`, `status: async (cwd: string) => gitStatus(cwd)`, `const rec = pty.create({`), not line numbers. `src/shared/rpc-channels.test.ts` is the shared drift net for the new `git.statusSummary` channel — any router restructure must keep it green. The 4 mirrored sites for a new RPC (router handler / schemas.ts / rpc-channels.ts / router-shape.ts) are called out in Task 3 Step 3.5 — grep-verify all four if conflicts were resolved by hand.
4. **Behavioral notes for reviewers.** (a) `useSwarmLiveStats` now also triggers `pty.processStats` for swarm sessions (the shared poller fetches both) — post-Task-1 that is a cache-hit subtree computation, deliberately accepted for one shared poller instead of two. (b) The pane badge's RSS/usage numbers now update at the shared cadence; two same-session subscribers see identical snapshots (previously two drifting pollers). (c) `git.statusSummary` deliberately drops branch/ahead/behind — `PaneShell` never consumed them; one-shot consumers keep full `git.status`. (d) Warm-boot PATH staleness window: if the user installs a new CLI into a brand-new PATH dir, the first spawn after the NEXT boot picks it up (cache refreshed async every boot) — same worst-case as today's 3 s-timeout failure path, minus the boot stall.
