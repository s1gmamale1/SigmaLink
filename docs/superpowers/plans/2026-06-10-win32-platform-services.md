# Win32 Platform Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SigmaLink's platform-service layer (process-tree kill/RSS, worktree reaping, Claude resume bridging, voice PTT, provider install, path containment, git long paths) actually work on win32 instead of silently degrading.

**Architecture:** Every win32 behavior is implemented as pure, platform-injected logic (`platform` passed as a parameter, never `process.platform` branched inside new code) so it is unit-testable on the macOS dev machine. Real win32 syscall behavior (taskkill, ConPTY, junctions, NTFS handle locks) is deferred to a device-verification checklist at the end. The process-tree win32 backend is deliberately shaped as a per-platform "list processes" function so the sibling **perf-hot-paths** plan can wrap it in its snapshot+TTL layer unchanged.

**Tech Stack:** TypeScript (Electron main process + voice-core package), vitest, node:child_process (`execFileSync` / `execCmd`), PowerShell CIM (`Get-CimInstance Win32_Process`), `taskkill`, NTFS hardlinks/junctions via `node:fs`.

---

## Scope & verified findings (2026-06-10 audit)

| # | Finding | Verdict after reading the code |
|---|---------|-------------------------------|
| 1 | process-tree darwin-only (`ps -axo`); win32 `supported:false` → registry.stop degrades to `rec.pty.kill()`, detached grandchildren leak; pane RSS empty | **Confirmed** (`process-tree.ts:42-43`, `registry.ts:416-423`) |
| 2 | janitor `fs.rm(recursive,force)` wedges on win32 EBUSY/EPERM | **Confirmed** (`cleanup.ts:139`) |
| 3 | resume bridge symlink → copyFile fallback diverges history | **Confirmed** at BOTH sites (`claude-resume-sigma.ts:166` ctx file/dir, `:440-458` resume jsonl). What's linked: `prepareClaudeResume` links a **file** (`.jsonl`); `linkOrCopyContextPath` links `CLAUDE.md` (**file**) and `.claude` (**directory** → junction applies) |
| 4 | PTT `CommandOrControl+Alt+Space` = Ctrl+Alt+Space on win32 (IME collision); register failure silent | **Half-refuted:** failure already emits a toast (`global-capture.ts:386`) — BUT the toast fires at boot before any subscriber mounts (`VoiceTab.tsx:182` only listens while mounted), so it's still effectively silent. Adjusted fix: win32 default accelerator + persistent `hotkeyRegistered` status field |
| 5 | providers need per-platform installCommand schema | **Half-refuted:** the per-platform schema ALREADY exists (`providers.ts:44-48`). Real bugs: (a) cursor's win32 value is `['bash','-c',…]` (`providers.ts:206-208`); (b) win32 falls back to the LINUX command at `rpc-router.ts:1327` AND its renderer mirror `ProviderInstallModal.tsx:185,194` (sibling-twin); (c) kimi pip-assumes-Python is ALREADY gated by the modal's prereq probe (`ProviderInstallModal.tsx:107-115`) → kimi value kept unchanged |
| 6 | H-6 shell-first force-coerced to direct on win32 | **Confirmed, deferred-by-design** (`local-pty.ts:371-378`). Planned as the LAST, device-gated task |
| 7 | `revealInFolder`/`openShell` raw `startsWith(root + path.sep)` (drive-letter casing) vs path-guard's `path.relative` | **Confirmed** (`rpc-router.ts:885,891,901,907`) |
| + | `core.longpaths` on worktree add (from device-checklist mandate) | git-ops has **three** sibling `worktree add` invocations: `worktreeAdd` (:493-497) + `ensureWorktree` re-attach (:533-537) + fresh-branch (:540-544) — all three get the flag |

All commands below run from `/Users/aisigma/projects/SigmaLink/app`.

## File Structure

```
app/src/main/core/process/
  process-list-win32.ts        CREATE  pure win32 primitives: CIM argv, JSON parse, taskkill argv
  process-list-win32.test.ts   CREATE
  process-tree.ts              MODIFY  platform-dispatched listProcessRows + deps injection + win32 stop
  process-tree.test.ts         CREATE  (module previously had no direct tests; covered via registry mocks)
app/src/main/core/util/
  rm-retry.ts                  CREATE  win32-aware recursive rm with bounded backoff
  rm-retry.test.ts             CREATE
app/src/main/core/workspaces/
  cleanup.ts                   MODIFY  line 139 only (rm → rmDirWithRetry)
app/src/main/core/pty/
  claude-resume-sigma.ts       MODIFY  symlink → hardlink/junction → copy strategy ladder, both sites
  claude-resume-sigma.test.ts  MODIFY  add ladder cases
app/packages/voice-core/src/
  global-capture.ts            MODIFY  defaultGlobalCaptureHotkey(platform) + hotkeyRegistered status
  global-capture.test.ts       MODIFY  add cases
app/src/shared/
  providers.ts                 MODIFY  cursor win32 PowerShell installer + installCommandFor() helper
  providers.test.ts            CREATE
app/src/main/
  rpc-router.ts                MODIFY  :1327 install platform resolution; :882-910 containment helper
app/src/renderer/features/workspace-launcher/
  ProviderInstallModal.tsx     MODIFY  3 mirrored cmd-derivation sites → installCommandFor
app/src/main/core/security/
  path-guard.ts                MODIFY  add isInsideAnyRoot (pathImpl-injectable)
  path-guard.test.ts           MODIFY  win32 drive-casing cases via path.win32
app/src/main/core/git/
  git-ops.ts                   MODIFY  gitArgsWithLongPaths at the 3 worktree-add sites
  git-ops-worktree.test.ts     MODIFY  add pure-builder cases
app/src/main/core/pty/local-pty.ts    GATED (Task 8) — do NOT touch before device validation
```

---

### Task 1: Win32 process-tree backend (CIM enumeration + taskkill tree-kill)

**Files:**
- Create: `app/src/main/core/process/process-list-win32.ts`
- Create: `app/src/main/core/process/process-list-win32.test.ts`
- Modify: `app/src/main/core/process/process-tree.ts` (whole file shown below; currently 143 lines)
- Create: `app/src/main/core/process/process-tree.test.ts`
- NOT modified: `app/src/main/core/pty/registry.ts` — its call sites (`:408`, `:416`, `:488`) use the new optional `deps` defaults, and `registry.test.ts` mocks the whole module, so zero churn there.

Why: on win32 `inspectProcessTree` returns `supported:false`, so `registry.stop` (`registry.ts:416-423`) falls back to `rec.pty.kill()` — ConPTY close takes console children but DETACHED grandchildren (MCP servers, daemons spawned by CLIs) leak, and pane RSS / RAM-brake telemetry is permanently empty.

**Coordination (perf-hot-paths):** that sibling plan refactors process-tree into a snapshot+TTL cache over a per-platform list fn. `listProcessRows(deps?: ProcessTreeDeps): ProcessListResult` defined here IS that per-platform fn — keep the signature, add **no caching** here; the TTL layer wraps it.

- [ ] **Step 1: Write the failing pure-logic tests**

Create `app/src/main/core/process/process-list-win32.test.ts`:

```typescript
// Pure-logic tests for the win32 process backend (argv construction + CIM JSON
// parsing). Runs on any host platform — no child_process, no Windows needed.
import { describe, it, expect } from 'vitest';
import {
  buildCimPsArgs,
  buildTaskkillArgs,
  parseCimProcessRows,
  CIM_PROCESS_QUERY,
} from './process-list-win32';

describe('buildCimPsArgs', () => {
  it('builds a non-interactive powershell argv around the CIM query', () => {
    expect(buildCimPsArgs()).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      CIM_PROCESS_QUERY,
    ]);
  });

  it('uses CIM, never the deprecated wmic', () => {
    expect(CIM_PROCESS_QUERY).toContain('Get-CimInstance Win32_Process');
    expect(CIM_PROCESS_QUERY).not.toMatch(/wmic/i);
  });
});

describe('buildTaskkillArgs', () => {
  it('kills the FULL tree forcefully: /PID <p> /T /F', () => {
    expect(buildTaskkillArgs(1234)).toEqual(['/PID', '1234', '/T', '/F']);
  });
});

describe('parseCimProcessRows', () => {
  it('parses a JSON array of CIM rows (WorkingSetSize is already bytes)', () => {
    const rows = parseCimProcessRows(
      JSON.stringify([
        { ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 1048576, Name: 'node.exe', CommandLine: 'node server.js' },
        { ProcessId: 200, ParentProcessId: 100, WorkingSetSize: 2048, Name: 'claude.exe', CommandLine: null },
      ]),
    );
    expect(rows).toEqual([
      { pid: 100, ppid: 1, rssBytes: 1048576, command: 'node.exe', args: 'node server.js' },
      { pid: 200, ppid: 100, rssBytes: 2048, command: 'claude.exe', args: '' },
    ]);
  });

  it('tolerates the single-object form (PowerShell unwraps 1-element arrays)', () => {
    const rows = parseCimProcessRows(
      JSON.stringify({ ProcessId: 7, ParentProcessId: 4, WorkingSetSize: 512, Name: 'x.exe', CommandLine: 'x' }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pid).toBe(7);
  });

  it('drops rows without a numeric ProcessId and survives garbage input', () => {
    expect(parseCimProcessRows('not json at all')).toEqual([]);
    expect(parseCimProcessRows(JSON.stringify([{ Name: 'ghost.exe' }, null]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/main/core/process/process-list-win32.test.ts`
Expected: FAIL — `Cannot find module './process-list-win32'` (or missing exports).

- [ ] **Step 3: Implement the pure win32 primitives**

Create `app/src/main/core/process/process-list-win32.ts`:

```typescript
// Win32 process enumeration + tree-kill primitives (pure argv/parse logic).
//
// The process-tree subsystem was darwin-only (`ps -axo`). This module supplies
// the win32 backend pieces:
//   - buildCimPsArgs()      — PowerShell argv that emits the process table as
//                             compact JSON via CIM (Win32_Process). wmic is
//                             deprecated/removed on Win11 — never used here.
//   - parseCimProcessRows() — tolerant JSON → ProcessTreeNode[] parser.
//   - buildTaskkillArgs()   — `taskkill /PID <p> /T /F` argv. /T walks the
//                             parent-child chain (kills detached grandchildren
//                             whose ppid links survive), /F is forceful.
//
// Everything here is PURE (no child_process import) so it is unit-tested on
// any host platform. The exec dispatch lives in process-tree.ts; real win32
// behavior is device-verified (see plan checklist).

import type { ProcessTreeNode } from './process-tree';

/** PowerShell expression dumping pid/ppid/rss/name/cmdline as compact JSON. */
export const CIM_PROCESS_QUERY =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name,CommandLine | ConvertTo-Json -Compress -Depth 2';

/** argv for `powershell.exe` (no profile, no prompts — safe for execFileSync). */
export function buildCimPsArgs(): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', CIM_PROCESS_QUERY];
}

/** argv for `taskkill` — force-kill the whole tree rooted at `pid`. */
export function buildTaskkillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

interface CimRow {
  ProcessId?: number | null;
  ParentProcessId?: number | null;
  WorkingSetSize?: number | null;
  Name?: string | null;
  CommandLine?: string | null;
}

/**
 * Parse `ConvertTo-Json` output into ProcessTreeNode rows.
 * Tolerant by design: single object (PowerShell unwraps 1-element arrays),
 * null CommandLine (access denied / system processes), garbage → [].
 * WorkingSetSize is reported in BYTES by CIM (unlike `ps` rss kilobytes).
 */
export function parseCimProcessRows(jsonText: string): ProcessTreeNode[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const out: ProcessTreeNode[] = [];
  for (const row of rows) {
    const r = row as CimRow | null;
    if (typeof r?.ProcessId !== 'number' || r.ProcessId <= 0) continue;
    out.push({
      pid: r.ProcessId,
      ppid: typeof r.ParentProcessId === 'number' ? r.ParentProcessId : 0,
      rssBytes: typeof r.WorkingSetSize === 'number' ? r.WorkingSetSize : 0,
      command: r.Name ?? '',
      args: r.CommandLine ?? '',
    });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/main/core/process/process-list-win32.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing dispatch tests**

Create `app/src/main/core/process/process-tree.test.ts`:

```typescript
// Platform-dispatch tests for the process-tree subsystem. Win32 behavior is
// exercised via INJECTED platform + exec (real powershell/taskkill calls are
// device-verified — see the win32-platform-services plan checklist).
import { describe, it, expect, vi } from 'vitest';
import { inspectProcessTree, listProcessRows, stopProcessTrees } from './process-tree';
import { buildCimPsArgs, buildTaskkillArgs } from './process-list-win32';

const CIM_TABLE = JSON.stringify([
  { ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 1000, Name: 'conhost.exe', CommandLine: '' },
  { ProcessId: 200, ParentProcessId: 100, WorkingSetSize: 2000, Name: 'claude.exe', CommandLine: 'claude' },
  { ProcessId: 300, ParentProcessId: 200, WorkingSetSize: 4000, Name: 'mcp.exe', CommandLine: 'mcp --stdio' },
  { ProcessId: 999, ParentProcessId: 1, WorkingSetSize: 8, Name: 'unrelated.exe', CommandLine: '' },
]);

describe('listProcessRows (the per-platform list fn — perf-hot-paths wraps this)', () => {
  it('win32: shells out to powershell.exe with the CIM argv', () => {
    const exec = vi.fn(() => CIM_TABLE);
    const res = listProcessRows({ platform: 'win32', exec });
    expect(exec).toHaveBeenCalledWith('powershell.exe', buildCimPsArgs());
    expect(res.supported).toBe(true);
    expect(res.rows).toHaveLength(4);
  });

  it('linux: unsupported, never execs (status quo preserved — win32-only scope)', () => {
    const exec = vi.fn();
    expect(listProcessRows({ platform: 'linux', exec })).toEqual({ supported: false, rows: [] });
    expect(exec).not.toHaveBeenCalled();
  });

  it('win32 exec failure: supported stays true, rows empty (registry falls back to pty.kill)', () => {
    const exec = vi.fn(() => {
      throw new Error('powershell missing');
    });
    expect(listProcessRows({ platform: 'win32', exec })).toEqual({ supported: true, rows: [] });
  });
});

describe('inspectProcessTree on win32', () => {
  it('walks descendants and sums rss from the CIM table', () => {
    const exec = vi.fn(() => CIM_TABLE);
    const snap = inspectProcessTree(100, { platform: 'win32', exec });
    expect(snap.supported).toBe(true);
    expect([...snap.descendantPids].sort((a, b) => a - b)).toEqual([200, 300]);
    expect(snap.rssBytes).toBe(7000);
    expect(snap.nodes.map((n) => n.pid).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('invalid root pid: empty snapshot but supported=true on win32', () => {
    const exec = vi.fn();
    const snap = inspectProcessTree(0, { platform: 'win32', exec });
    expect(snap.supported).toBe(true);
    expect(snap.nodes).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('stopProcessTrees on win32', () => {
  it('issues one `taskkill /PID <root> /T /F` per root and reports every tree pid stopped', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = vi.fn((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return cmd === 'powershell.exe' ? CIM_TABLE : '';
    });
    const { snapshots, stoppedPids } = stopProcessTrees([100], 5_000, { platform: 'win32', exec });
    const kills = calls.filter((c) => c.cmd === 'taskkill');
    expect(kills).toEqual([{ cmd: 'taskkill', args: buildTaskkillArgs(100) }]);
    expect([...stoppedPids].sort((a, b) => a - b)).toEqual([100, 200, 300]);
    expect(snapshots[0]!.supported).toBe(true);
  });

  it('an already-dead root (taskkill throws) is swallowed — parity with darwin catch blocks', () => {
    const exec = vi.fn((cmd: string) => {
      if (cmd === 'taskkill') throw new Error('ERROR: process not found');
      return CIM_TABLE;
    });
    expect(() => stopProcessTrees([100], 5_000, { platform: 'win32', exec })).not.toThrow();
  });
});
```

- [ ] **Step 6: Run to verify FAIL**

Run: `npx vitest run src/main/core/process/process-tree.test.ts`
Expected: FAIL — `listProcessRows` is not exported / deps parameter unknown.

- [ ] **Step 7: Rewrite process-tree.ts with platform dispatch**

Replace the FULL content of `app/src/main/core/process/process-tree.ts` with:

```typescript
import { execFileSync } from 'node:child_process';
import { buildCimPsArgs, buildTaskkillArgs, parseCimProcessRows } from './process-list-win32';

export interface ProcessTreeNode {
  pid: number;
  ppid: number;
  rssBytes: number;
  command: string;
  args: string;
}

export interface ProcessTreeSnapshot {
  rootPid: number;
  supported: boolean;
  nodes: ProcessTreeNode[];
  descendantPids: number[];
  rssBytes: number;
}

/**
 * Injection seam. NEVER branch on raw process.platform inside the logic —
 * platform flows in as a parameter (tests force 'win32' on the macOS host).
 */
export interface ProcessTreeDeps {
  platform?: NodeJS.Platform;
  /** Sync exec returning stdout. Tests fake this; prod uses execFileSync. */
  exec?: (command: string, args: string[]) => string;
}

function defaultExec(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

function platformSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

function emptySnapshot(rootPid: number, supported: boolean): ProcessTreeSnapshot {
  return { rootPid, supported, nodes: [], descendantPids: [], rssBytes: 0 };
}

function parsePsLine(line: string): ProcessTreeNode | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    rssBytes: Number(match[3]) * 1024,
    command: match[4] ?? '',
    args: match[5] ?? '',
  };
}

export interface ProcessListResult {
  supported: boolean;
  rows: ProcessTreeNode[];
}

/**
 * Per-platform raw process listing.
 *
 * COORDINATION (perf-hot-paths plan): this is THE per-platform list fn its
 * snapshot+TTL layer wraps. Keep the `(deps?) => ProcessListResult` signature
 * and add NO caching here.
 *
 * darwin: `ps -axo` (kilobyte rss → bytes). win32: PowerShell CIM
 * (`Get-CimInstance Win32_Process`, byte WorkingSetSize; wmic-free — wmic is
 * deprecated/removed on Win11). Other platforms: unsupported (status quo).
 * Exec failure ⇒ `{ supported: true, rows: [] }` so callers keep their
 * existing pty.kill() fallback (registry.ts:417-423).
 */
export function listProcessRows(deps: ProcessTreeDeps = {}): ProcessListResult {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  if (!platformSupported(platform)) return { supported: false, rows: [] };
  try {
    if (platform === 'win32') {
      return { supported: true, rows: parseCimProcessRows(exec('powershell.exe', buildCimPsArgs())) };
    }
    const out = exec('ps', ['-axo', 'pid=,ppid=,rss=,comm=,args=']);
    return {
      supported: true,
      rows: out
        .split('\n')
        .map(parsePsLine)
        .filter((row): row is ProcessTreeNode => row !== null),
    };
  } catch {
    return { supported: true, rows: [] };
  }
}

export function inspectProcessTree(rootPid: number, deps: ProcessTreeDeps = {}): ProcessTreeSnapshot {
  const platform = deps.platform ?? process.platform;
  if (!rootPid || rootPid <= 0) return emptySnapshot(rootPid, platformSupported(platform));

  const listed = listProcessRows(deps);
  if (!listed.supported) return emptySnapshot(rootPid, false);
  const rows = listed.rows;

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function stopProcessTree(
  rootPid: number,
  fallbackMs = 5_000,
  deps: ProcessTreeDeps = {},
): ProcessTreeSnapshot {
  const platform = deps.platform ?? process.platform;
  return (
    stopProcessTrees([rootPid], fallbackMs, deps).snapshots[0] ??
    emptySnapshot(rootPid, platformSupported(platform))
  );
}

export function stopProcessTrees(
  rootPids: number[],
  fallbackMs = 5_000,
  deps: ProcessTreeDeps = {},
): { snapshots: ProcessTreeSnapshot[]; stoppedPids: number[] } {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  const snapshots = rootPids.map((pid) => inspectProcessTree(pid, deps));

  if (platform === 'win32') {
    // `taskkill /T` walks the parent-child chain itself (takes the detached
    // grandchildren — MCP servers, daemons — that ConPTY close leaves behind);
    // /F is forceful, so no SIGTERM→SIGKILL escalation timer is needed.
    // Already-gone pids make taskkill exit non-zero — swallowed, mirroring the
    // darwin catch blocks.
    const stoppedPids: number[] = [];
    const seen = new Set<number>();
    for (const snapshot of snapshots) {
      for (const node of snapshot.nodes) {
        if (!seen.has(node.pid)) {
          seen.add(node.pid);
          stoppedPids.push(node.pid);
        }
      }
    }
    for (const pid of rootPids) {
      if (!pid || pid <= 0) continue;
      try {
        exec('taskkill', buildTaskkillArgs(pid));
      } catch {
        /* already gone */
      }
    }
    return { snapshots, stoppedPids };
  }

  // darwin: SIGTERM the whole tree leaves-first, SIGKILL stragglers later.
  const nodesByPid = new Map<number, ProcessTreeNode>();
  for (const snapshot of snapshots) {
    if (!snapshot.supported || snapshot.nodes.length === 0) continue;
    for (const node of snapshot.nodes) {
      nodesByPid.set(node.pid, node);
    }
  }
  const ordered = Array.from(nodesByPid.values()).reverse();
  const stoppedPids = ordered.map((node) => node.pid);

  for (const node of ordered) {
    try {
      process.kill(node.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  if (ordered.length > 0) {
    setTimeout(() => {
      for (const node of ordered) {
        try {
          if (pidAlive(node.pid)) process.kill(node.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, fallbackMs).unref();
  }

  return { snapshots, stoppedPids };
}
```

Note the registry consequence (no registry change needed): on win32, `registry.stop` now gets `supported:true` snapshots. With nodes → taskkill already killed the tree, node-pty's onExit fires and cleanup proceeds exactly as on darwin. With 0 nodes (powershell failed) → the existing `rec.pty.kill()` fallback at `registry.ts:417-423` still runs. Pane RSS (`processSnapshot`, cleanup.ts `liveRssBytes`, RAM-brake) now populates on win32 for free.

- [ ] **Step 8: Run to verify PASS**

Run: `npx vitest run src/main/core/process/process-tree.test.ts src/main/core/process/process-list-win32.test.ts src/main/core/pty/registry.test.ts`
Expected: PASS — including the untouched registry suite (it mocks this module).

- [ ] **Step 9: Commit**

```bash
git add src/main/core/process/process-list-win32.ts src/main/core/process/process-list-win32.test.ts src/main/core/process/process-tree.ts src/main/core/process/process-tree.test.ts
git commit -m "fix(win32): CIM process enumeration + taskkill tree-kill backend for process-tree"
```

---

### Task 2: Janitor rm retry-with-backoff on win32 EBUSY/EPERM

**Files:**
- Create: `app/src/main/core/util/rm-retry.ts`
- Create: `app/src/main/core/util/rm-retry.test.ts`
- Modify: `app/src/main/core/workspaces/cleanup.ts:139` (the single `fs.rm` site in `pruneRepoDir`)

Why: win32 cannot delete dirs with open handles / a process cwd inside → `fs.rm(recursive,force)` throws EBUSY/EPERM; combined with the (now fixed) no-tree-kill this could wedge a worktree dir permanently. Handles release ms-to-s after a tree-kill, so bounded backoff converts a wedge into a short wait.

Kill-tree-first note: the call sites that own pids already stop trees BEFORE deletion (`clearPanesForWorkspace` → `pty.stop(id, { tree: true })`, `cleanup.ts:220` — Task 1 makes that real on win32). `pruneRepoDir` removes orphan dirs with **no** live session row, so there is no pid to kill there — the retry absorbs straggler handle release (a dying child, an AV scan).

**Coordination (worktree-reaper-fence):** that sibling plan rewrites this file's keep/use PREDICATE. This task touches ONLY the rm mechanics at line 139 — a one-line call swap — so the two land in either order with a trivial merge.

- [ ] **Step 1: Write the failing tests**

Create `app/src/main/core/util/rm-retry.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { rmDirWithRetry, WIN32_RM_RETRY_DELAYS_MS } from './rm-retry';

const errWith = (code: string) => Object.assign(new Error(code), { code });

describe('rmDirWithRetry', () => {
  it('win32: retries EBUSY/EPERM with backoff then succeeds', async () => {
    const rm = vi
      .fn()
      .mockRejectedValueOnce(errWith('EBUSY'))
      .mockRejectedValueOnce(errWith('EPERM'))
      .mockResolvedValueOnce(undefined);
    const sleeps: number[] = [];
    await rmDirWithRetry('/x/wt', {
      platform: 'win32',
      rm,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      warn: vi.fn(),
    });
    expect(rm).toHaveBeenCalledTimes(3);
    expect(rm).toHaveBeenCalledWith('/x/wt', { recursive: true, force: true });
    expect(sleeps).toEqual([WIN32_RM_RETRY_DELAYS_MS[0], WIN32_RM_RETRY_DELAYS_MS[1]]);
  });

  it('win32: exhausts retries → warns once and rethrows the last error', async () => {
    const rm = vi.fn().mockRejectedValue(errWith('EBUSY'));
    const warn = vi.fn();
    await expect(
      rmDirWithRetry('/x/wt', { platform: 'win32', rm, sleep: async () => {}, warn }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(rm).toHaveBeenCalledTimes(WIN32_RM_RETRY_DELAYS_MS.length + 1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('win32: a non-retryable code throws immediately (no retry storm)', async () => {
    const rm = vi.fn().mockRejectedValue(errWith('EINVAL'));
    await expect(
      rmDirWithRetry('/x/wt', { platform: 'win32', rm, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: 'EINVAL' });
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it('darwin: single attempt, no retry — behavior unchanged', async () => {
    const rm = vi.fn().mockRejectedValue(errWith('EBUSY'));
    const sleep = vi.fn();
    await expect(rmDirWithRetry('/x/wt', { platform: 'darwin', rm, sleep })).rejects.toMatchObject({
      code: 'EBUSY',
    });
    expect(rm).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('first-try success → no sleep, no warn', async () => {
    const rm = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn();
    const warn = vi.fn();
    await rmDirWithRetry('/x/wt', { platform: 'win32', rm, sleep, warn });
    expect(rm).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/main/core/util/rm-retry.test.ts`
Expected: FAIL — `Cannot find module './rm-retry'`.

- [ ] **Step 3: Implement rm-retry.ts**

Create `app/src/main/core/util/rm-retry.ts`:

```typescript
// Win32-aware recursive dir removal.
//
// On Windows a dir with an open handle / a process cwd inside it fails
// `fs.rm` with EBUSY or EPERM (and a half-removed tree surfaces ENOTEMPTY).
// Handles are typically released within ms-to-s of a tree-kill, so a bounded
// retry-with-backoff converts a permanent wedge into a short wait. Non-win32
// platforms keep single-shot semantics — zero behavior change on macOS/Linux.
//
// Platform is INJECTED (never branch on raw process.platform in callers).

import { promises as fsPromises } from 'node:fs';

export const WIN32_RM_RETRY_DELAYS_MS = [100, 300, 900] as const;

const RETRYABLE_WIN32_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

export interface RmRetryDeps {
  platform?: NodeJS.Platform;
  rm?: (p: string, opts: { recursive: boolean; force: boolean }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  warn?: (...args: unknown[]) => void;
}

/**
 * `fs.rm(p, { recursive: true, force: true })` with win32-only bounded
 * retry-with-backoff on EBUSY/EPERM/ENOTEMPTY. After the final failure a
 * warning is surfaced (so the operator sees WHY a worktree dir survived the
 * janitor) and the last error is rethrown — callers keep their fail-open
 * error counting (cleanup.ts pruneRepoDir).
 */
export async function rmDirWithRetry(p: string, deps: RmRetryDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const rm = deps.rm ?? ((target, opts) => fsPromises.rm(target, opts));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const warn = deps.warn ?? console.warn;

  const attempts = platform === 'win32' ? WIN32_RM_RETRY_DELAYS_MS.length + 1 : 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(WIN32_RM_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      await rm(p, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (platform !== 'win32' || !RETRYABLE_WIN32_CODES.has(code)) throw err;
    }
  }
  warn(
    `[rm-retry] win32: dir still locked after ${attempts} attempts (open handle / process cwd?):`,
    p,
    lastErr,
  );
  throw lastErr;
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/main/core/util/rm-retry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into cleanup.ts**

In `app/src/main/core/workspaces/cleanup.ts`, add the import below the existing `path-key` import (line 20):

```typescript
import { rmDirWithRetry } from '../util/rm-retry';
```

Replace line 139 inside `pruneRepoDir`:

```typescript
        await fs.rm(p, { recursive: true, force: true });
```

with:

```typescript
        await rmDirWithRetry(p);
```

(The surrounding catch at :141-144 already logs and counts `errors++` — unchanged.)

- [ ] **Step 6: Run the cleanup suite to verify no regression**

Run: `npx vitest run src/main/core/workspaces/cleanup.test.ts`
Expected: PASS — darwin semantics are byte-identical (single attempt, same error propagation).

- [ ] **Step 7: Commit**

```bash
git add src/main/core/util/rm-retry.ts src/main/core/util/rm-retry.test.ts src/main/core/workspaces/cleanup.ts
git commit -m "fix(win32): bounded EBUSY/EPERM retry-with-backoff for janitor worktree rm"
```

---

### Task 3: Resume bridge — hardlink/junction before copyFile

**Files:**
- Modify: `app/src/main/core/pty/claude-resume-sigma.ts` (`ClaudeBridgeDeps:78-83`, `linkOrCopyContextPath:140-189`, `prepareClaudeResume` step 4 `:431-461`, header comment `:29-38`)
- Modify: `app/src/main/core/pty/claude-resume-sigma.test.ts` (append a describe block)

Why: on win32 without Dev Mode, `fs.promises.symlink` throws EPERM and both sites fall straight to a copy that diverges session history (the file's own header admits it). What gets linked: `prepareClaudeResume` → a **file** (the session `.jsonl`); `prepareClaudeWorkspaceContext` → `CLAUDE.md` (**file**) and `.claude` (**directory**). Hardlinks (`fs.link`) need no privilege on the same volume and share the inode — appends through either name keep history unified. Both jsonl paths live under `~/.claude/projects/` (same volume by construction). For the directory, a junction (`fs.symlink(…, 'junction')`) needs no privilege on win32.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/main/core/pty/claude-resume-sigma.test.ts` (reuses the file's existing `makeTmpHome`, `rmRf`, `seedSourceJsonl`, `VALID_UUID` helpers and its imports of `prepareClaudeResume`, `prepareClaudeWorkspaceContext`, `claudeSlugForCwd`):

```typescript
describe('win32 link-strategy ladder (hardlink/junction before copy)', () => {
  let home: string;
  let workspaceCwd: string;
  let worktreeCwd: string;

  beforeEach(() => {
    home = makeTmpHome();
    workspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ws-'));
    worktreeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-wt-'));
  });
  afterEach(() => {
    rmRf(home);
    rmRf(workspaceCwd);
    rmRf(worktreeCwd);
  });

  const epermSymlink = () =>
    Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));

  it('resume bridge: symlink EPERM on win32 → HARDLINK (same inode, history stays unified)', async () => {
    const source = seedSourceJsonl(home, workspaceCwd, VALID_UUID);
    const outcome = await prepareClaudeResume(workspaceCwd, worktreeCwd, VALID_UUID, {
      homeDir: home,
      platform: 'win32',
      linkOps: { symlink: epermSymlink },
    });
    expect(outcome).toBe('linked');
    const target = path.join(
      home,
      '.claude',
      'projects',
      claudeSlugForCwd(worktreeCwd),
      `${VALID_UUID}.jsonl`,
    );
    const s = fs.statSync(source);
    const t = fs.statSync(target);
    expect(t.ino).toBe(s.ino); // hardlink, NOT a copy
    expect(s.nlink).toBe(2);
    // Append-through: a write via the target lands on the source inode.
    fs.appendFileSync(target, '{"type":"assistant"}\n');
    expect(fs.readFileSync(source, 'utf8')).toContain('"assistant"');
  });

  it('resume bridge: symlink EPERM + hardlink EXDEV → copyFile last resort', async () => {
    seedSourceJsonl(home, workspaceCwd, VALID_UUID);
    const outcome = await prepareClaudeResume(workspaceCwd, worktreeCwd, VALID_UUID, {
      homeDir: home,
      platform: 'win32',
      linkOps: {
        symlink: epermSymlink,
        link: () =>
          Promise.reject(Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' })),
      },
    });
    expect(outcome).toBe('linked');
    const target = path.join(
      home,
      '.claude',
      'projects',
      claudeSlugForCwd(worktreeCwd),
      `${VALID_UUID}.jsonl`,
    );
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).nlink).toBe(1); // independent copy
  });

  it('context dir (.claude): symlink(dir) EPERM on win32 → junction attempted (no privilege needed)', async () => {
    fs.mkdirSync(path.join(workspaceCwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(workspaceCwd, '.claude', 'settings.json'), '{}');
    const symlinkTypes: Array<string | undefined> = [];
    const outcome = await prepareClaudeWorkspaceContext(workspaceCwd, worktreeCwd, {
      homeDir: home,
      platform: 'win32',
      linkOps: {
        symlink: (s: string, t: string, type?: 'file' | 'dir' | 'junction') => {
          symlinkTypes.push(type);
          if (type !== 'junction') return epermSymlink();
          return fs.promises.symlink(s, t); // host stand-in for a real junction
        },
      },
    });
    expect(symlinkTypes).toContain('junction');
    expect(outcome.linked).toContain('.claude');
    expect(fs.lstatSync(path.join(worktreeCwd, '.claude')).isSymbolicLink()).toBe(true);
  });

  it('non-win32: a non-EEXIST symlink failure still skips (no ladder on posix)', async () => {
    seedSourceJsonl(home, workspaceCwd, VALID_UUID);
    const outcome = await prepareClaudeResume(workspaceCwd, worktreeCwd, VALID_UUID, {
      homeDir: home,
      platform: 'darwin',
      linkOps: { symlink: epermSymlink },
    });
    expect(outcome).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/main/core/pty/claude-resume-sigma.test.ts`
Expected: FAIL — `linkOps` is not a known property of `ClaudeBridgeDeps`; win32 EPERM still copies (`nlink` is 1, ino differs).

- [ ] **Step 3: Implement the strategy ladder**

In `app/src/main/core/pty/claude-resume-sigma.ts`:

3a. Extend `ClaudeBridgeDeps` (lines 78-83) and add the ops types right after it:

```typescript
export interface ClaudeBridgeDeps {
  /** Override `os.homedir()` — tests inject a tmpdir. */
  homeDir?: string;
  /** Override platform — tests force the Windows fallback ladder. */
  platform?: NodeJS.Platform;
  /** Override individual link syscalls — tests force EPERM/EXDEV branches. */
  linkOps?: Partial<BridgeLinkOps>;
}

export type BridgeLinkStrategy = 'symlink' | 'hardlink' | 'junction' | 'copy';

export interface BridgeLinkOps {
  symlink: (source: string, target: string, type?: 'file' | 'dir' | 'junction') => Promise<void>;
  link: (source: string, target: string) => Promise<void>;
  copyFile: (source: string, target: string) => Promise<void>;
  cp: (source: string, target: string, opts: { recursive: boolean }) => Promise<void>;
}

const defaultLinkOps: BridgeLinkOps = {
  symlink: (s, t, type) => fs.promises.symlink(s, t, type),
  link: (s, t) => fs.promises.link(s, t),
  copyFile: (s, t) => fs.promises.copyFile(s, t),
  cp: (s, t, o) => fs.promises.cp(s, t, o),
};

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? '';
}

/**
 * Create the best available bridge link at `targetPath` → `sourcePath`.
 *
 * Strategy ladder:
 *  file: symlink → hardlink (`fs.link`; no privilege needed on the same
 *        volume — both jsonl ends live under ~/.claude/projects/, and appends
 *        hit the SAME inode so history stays unified, unlike a copy)
 *        → copyFile (last resort; diverges history; logged).
 *  dir:  symlink('dir') → junction (`fs.symlink` type 'junction'; no
 *        privilege on win32, dirs only) → cp recursive (last resort).
 *
 * The ladder only runs on win32 (posix symlinks are first-class). EEXIST is
 * rethrown so callers keep their existing exists handling. Returns the
 * winning strategy, or null when every rung failed.
 */
async function createBridgeLink(
  sourcePath: string,
  targetPath: string,
  kind: 'file' | 'dir',
  platform: NodeJS.Platform,
  ops: BridgeLinkOps,
): Promise<BridgeLinkStrategy | null> {
  try {
    await ops.symlink(sourcePath, targetPath, kind);
    return 'symlink';
  } catch (err) {
    if (errCode(err) === 'EEXIST') throw err;
    // win32 symlinks need Dev Mode / elevation (EPERM, sometimes EACCES) —
    // fall through to the privilege-free rungs. Posix: no ladder, fail here.
    if (platform !== 'win32') return null;
  }

  if (kind === 'dir') {
    try {
      await ops.symlink(sourcePath, targetPath, 'junction');
      console.warn(`[claude-bridge] symlink unavailable — junction created: ${targetPath}`);
      return 'junction';
    } catch (err) {
      if (errCode(err) === 'EEXIST') throw err;
    }
    try {
      await ops.cp(sourcePath, targetPath, { recursive: true });
      console.warn(`[claude-bridge] junction unavailable — dir COPIED (may diverge): ${targetPath}`);
      return 'copy';
    } catch {
      return null;
    }
  }

  try {
    await ops.link(sourcePath, targetPath);
    console.warn(`[claude-bridge] symlink unavailable — hardlink created: ${targetPath}`);
    return 'hardlink';
  } catch (err) {
    if (errCode(err) === 'EEXIST') throw err;
    // EXDEV (cross-volume) or anything else → copy as the true last resort.
  }
  try {
    await ops.copyFile(sourcePath, targetPath);
    console.warn(
      `[claude-bridge] hardlink unavailable — file COPIED (history may diverge): ${targetPath}`,
    );
    return 'copy';
  } catch {
    return null;
  }
}
```

3b. Replace the body of `linkOrCopyContextPath` from the first `try { await fs.promises.symlink(` (line 165) through its closing `}` (line 188) — keep the preceding lstat/mkdir blocks (lines 145-163) — with:

```typescript
  const ops: BridgeLinkOps = { ...defaultLinkOps, ...deps.linkOps };
  try {
    const strategy = await createBridgeLink(
      sourcePath,
      targetPath,
      sourceStat.isDirectory() ? 'dir' : 'file',
      platform,
      ops,
    );
    return strategy === null ? 'skipped' : 'linked';
  } catch (err) {
    if (errCode(err) === 'EEXIST') return 'existing';
    return 'skipped';
  }
```

`linkOrCopyContextPath`'s signature changes from `(sourcePath, targetPath, platform)` to `(sourcePath, targetPath, platform, deps)` — update its single caller in `prepareClaudeWorkspaceContext` (line 351) to:

```typescript
    const result = await linkOrCopyContextPath(sourcePath, targetPath, platform, deps);
```

(and the function declaration at :140 gains `deps: ClaudeBridgeDeps = {}` as its 4th parameter).

3c. Replace `prepareClaudeResume` step 4 (the `try { await fs.promises.symlink(sourcePath, targetPath); … }` block, lines 439-461) with:

```typescript
  const ops: BridgeLinkOps = { ...defaultLinkOps, ...deps.linkOps };
  let strategy: BridgeLinkStrategy | null;
  try {
    strategy = await createBridgeLink(sourcePath, targetPath, 'file', platform, ops);
  } catch (err) {
    if (errCode(err) === 'EEXIST') {
      // Raced with another pane in the same worktree — treat as success.
      return 'exists';
    }
    return 'skipped';
  }
  return strategy === null ? 'skipped' : 'linked';
```

3d. Update the header comment block at lines 29-38 ("Symlink, not copy:") to document the new ladder — replace the `* Windows:` bullet with:

```
//   * Windows: `fs.promises.symlink` requires elevation OR Developer Mode.
//     The bridge now falls back symlink → HARDLINK (fs.link — no privilege on
//     the same volume; appends share the inode so history stays unified) →
//     copyFile as the true last resort (history diverges; logged). The
//     `.claude` context DIRECTORY falls back symlink → JUNCTION (privilege-
//     free on win32) → recursive copy. The winning strategy is logged.
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/main/core/pty/claude-resume-sigma.test.ts`
Expected: PASS — all pre-existing bridge tests (darwin symlink semantics untouched) plus the 4 new ladder tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/pty/claude-resume-sigma.ts src/main/core/pty/claude-resume-sigma.test.ts
git commit -m "fix(win32): resume bridge tries hardlink/junction before copyFile — keep session history unified without Dev Mode"
```

---

### Task 4: Voice PTT — win32 default accelerator + persistent register status

**Files:**
- Modify: `app/packages/voice-core/src/global-capture.ts` (`:199` DEFAULT_HOTKEY, `GlobalCaptureDeps:137`, `GlobalCaptureStatus:118-124`, `getStatus:356-358`, `loadFromKv:364-374`, `registerHotkey:376-390`, controller locals `:316-323`)
- Modify: `app/packages/voice-core/src/global-capture.test.ts` (append cases; electron is already module-mocked at the top of that file)

Why: `CommandOrControl+Alt+Space` resolves to Ctrl+Alt+Space on win32 — the IME input-method toggle on several layouts. **Refuted half:** register failure is NOT fully silent — `global-capture.ts:383-388` already warns + emits a toast. BUT the toast fires during `init()` at boot, before any subscriber mounts (`VoiceTab.tsx:182` listens only while the Voice settings tab is open), so in practice nobody sees it. Adjusted fix: (a) platform-injected default accelerator (`Control+Shift+Space` on win32), (b) a persistent `hotkeyRegistered` field on `GlobalCaptureStatus` so any later `getStatus()` pull or state broadcast carries the failure — late subscribers (VoiceTab, the SigmaVoice HUD which consumes voice-core via submodule) can render a lasting warning.

- [ ] **Step 1: Write the failing tests**

Append to `app/packages/voice-core/src/global-capture.test.ts` (the file already has `vi.mock('electron', …)` and imports `globalShortcut`; add `defaultGlobalCaptureHotkey` and `buildGlobalCaptureController` to its imports from `./global-capture.ts` if not present, plus `type GlobalCaptureDeps`):

```typescript
function makePttKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (k: string) => store.get(k) ?? null,
    set: (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

function makePttDeps(overrides: Partial<GlobalCaptureDeps> = {}): GlobalCaptureDeps {
  return {
    emit: vi.fn(),
    kv: makePttKv({ 'voice.globalCapture.enabled': '1' }),
    getModelsDir: () => '/tmp/voice-core-test/models',
    clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') } as unknown as GlobalCaptureDeps['clipboard'],
    ...overrides,
  };
}

describe('defaultGlobalCaptureHotkey (win32 IME collision)', () => {
  it('win32 default avoids Ctrl+Alt+Space (the IME input-method toggle)', () => {
    expect(defaultGlobalCaptureHotkey('win32')).toBe('Control+Shift+Space');
  });
  it('darwin/linux keep CommandOrControl+Alt+Space', () => {
    expect(defaultGlobalCaptureHotkey('darwin')).toBe('CommandOrControl+Alt+Space');
    expect(defaultGlobalCaptureHotkey('linux')).toBe('CommandOrControl+Alt+Space');
  });
});

describe('platform-aware hotkey + persistent register status', () => {
  beforeEach(() => {
    (globalShortcut.register as Mock).mockClear().mockReturnValue(true);
    (globalShortcut.unregister as Mock).mockClear();
  });

  it('registers the win32 default when no KV hotkey is stored', () => {
    buildGlobalCaptureController(makePttDeps({ platform: 'win32' }));
    expect(globalShortcut.register).toHaveBeenCalledWith('Control+Shift+Space', expect.any(Function));
  });

  it('a KV-stored hotkey always wins over the platform default', () => {
    buildGlobalCaptureController(
      makePttDeps({
        platform: 'win32',
        kv: makePttKv({ 'voice.globalCapture.enabled': '1', 'voice.globalCapture.hotkey': 'F9' }),
      }),
    );
    expect(globalShortcut.register).toHaveBeenCalledWith('F9', expect.any(Function));
  });

  it('register failure → hotkeyRegistered=false in status AND a state broadcast (not just a transient toast)', () => {
    (globalShortcut.register as Mock).mockReturnValue(false);
    const deps = makePttDeps({ platform: 'win32' });
    const ctl = buildGlobalCaptureController(deps);
    expect(ctl.getStatus().hotkeyRegistered).toBe(false);
    expect(deps.emit).toHaveBeenCalledWith(
      'voice:global-capture-state',
      expect.objectContaining({ hotkeyRegistered: false }),
    );
  });

  it('register success → hotkeyRegistered=true', () => {
    const ctl = buildGlobalCaptureController(makePttDeps({ platform: 'darwin' }));
    expect(ctl.getStatus().hotkeyRegistered).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run packages/voice-core/src/global-capture.test.ts`
Expected: FAIL — `defaultGlobalCaptureHotkey` not exported; `hotkeyRegistered` missing from status.

- [ ] **Step 3: Implement**

In `app/packages/voice-core/src/global-capture.ts`:

3a. Replace line 199 (`const DEFAULT_HOTKEY = 'CommandOrControl+Alt+Space';`) with:

```typescript
/**
 * Platform-aware default PTT accelerator. On win32, Ctrl+Alt+Space (what
 * CommandOrControl+Alt+Space resolves to there) collides with the IME
 * input-method toggle on several keyboard layouts, so the win32 default is
 * Ctrl+Shift+Space. A user-chosen hotkey stored in KV always wins.
 */
export function defaultGlobalCaptureHotkey(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Control+Shift+Space' : 'CommandOrControl+Alt+Space';
}
```

3b. Add to `GlobalCaptureDeps` (after the `clipboard` member, ~line 146):

```typescript
  /** Override platform — tests force the win32 accelerator default. */
  platform?: NodeJS.Platform;
```

3c. Add to `GlobalCaptureStatus` (line 118-124):

```typescript
export interface GlobalCaptureStatus {
  state: CaptureState;
  enabled: boolean;
  mode: CaptureMode;
  modelId: string;
  hotkey: string;
  /**
   * False when `globalShortcut.register` last failed (hotkey taken by another
   * app / IME). Persistent — late subscribers (VoiceTab mounts long after
   * boot; the boot-time toast is gone by then) can still render a warning.
   */
  hotkeyRegistered: boolean;
}
```

3d. In `buildGlobalCaptureController` (line 316), add the platform local and fix the `hotkey` initial value (line 321):

```typescript
  const platform = deps.platform ?? process.platform;
  // …
  let hotkey = defaultGlobalCaptureHotkey(platform);
```

3e. `getStatus` (line 356-358):

```typescript
  function getStatus(): GlobalCaptureStatus {
    return { state, enabled, mode, modelId, hotkey, hotkeyRegistered: currentHotkeyRegistered };
  }
```

3f. `loadFromKv` (line 371):

```typescript
    hotkey  = rawHotkey ?? defaultGlobalCaptureHotkey(platform);
```

3g. `registerHotkey` failure branch (lines 384-388) — add a state broadcast after the toast:

```typescript
    const ok = globalShortcut.register(hotkey, onHotkeyFired);
    if (!ok) {
      console.warn(`[global-capture] Failed to register hotkey "${hotkey}" — it may be taken by another app.`);
      toast(`Could not register hotkey ${hotkey}. Try rebinding in Settings → Voice.`, 'warn');
      broadcastStatus();
      return;
    }
    currentHotkeyRegistered = true;
```

(`broadcastStatus` is declared at :352, above `registerHotkey` — no hoisting issue.)

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run packages/voice-core/src/global-capture.test.ts`
Expected: PASS — all pre-existing voice-core tests plus the 6 new ones. If `npx tsc -b` later flags any test/file constructing a `GlobalCaptureStatus` literal, add `hotkeyRegistered: true` there (additive field).

- [ ] **Step 5: Commit**

```bash
git add packages/voice-core/src/global-capture.ts packages/voice-core/src/global-capture.test.ts
git commit -m "fix(win32): PTT default Ctrl+Shift+Space (IME collision) + persistent hotkeyRegistered status"
```

---

### Task 5: Provider installCommand — win32 values + no-posix-fallback (3 mirrored sites)

**Files:**
- Modify: `app/src/shared/providers.ts` (cursor `installCommand:205-209`; add `installCommandFor` helper after the `AgentProviderDefinition` interface)
- Create: `app/src/shared/providers.test.ts`
- Modify: `app/src/main/rpc-router.ts:1326-1332` (`providers.spawnInstall`)
- Modify: `app/src/renderer/features/workspace-launcher/ProviderInstallModal.tsx` (`:107-115` prereq, `:185` handleCopy, `:194` render — the sibling mirrors of the rpc-router site)

**Refuted half:** per-platform installCommand schema ALREADY exists (`providers.ts:44-48`) — no schema work needed. The real bugs: cursor's win32 value is `['bash','-c','curl … | bash']` (no bash on stock Windows), and BOTH the main-side resolver (`rpc-router.ts:1327`) and its renderer mirror (`ProviderInstallModal.tsx:185,194`) fall back to the LINUX command when a platform key is missing — on win32 that silently spawns a dead bash pane. Kimi: pip-assumes-Python is ALREADY gated (modal prereq probe `:107-115` + `installDocsUrl` fallback per the file header) — `pip install kimi-cli` is correct when Python ≥3.12 is present (kimi ships on PyPI, creates a `kimi.cmd` shim per `providers.ts:140-144`) — **kimi value unchanged**.

Research (2026-06-10): Cursor's docs ship a Windows PowerShell installer — `irm 'https://cursor.com/install?win32=true' | iex` (cursor.com/docs/cli/installation). First-class cursor-agent targets remain macOS/Linux, so the win32 path is best-effort → device-verify (checklist item 7).

- [ ] **Step 1: Write the failing tests**

Create `app/src/shared/providers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  AGENT_PROVIDERS,
  installCommandFor,
  type AgentProviderDefinition,
} from './providers';

const def = (ic?: AgentProviderDefinition['installCommand']): AgentProviderDefinition => ({
  id: 'x',
  name: 'X',
  description: '',
  command: 'x',
  args: [],
  color: '#fff',
  icon: 'cpu',
  installHint: '',
  installCommand: ic,
});

describe('installCommandFor', () => {
  it('win32 NEVER falls back to a posix command (the bash-on-Windows bug)', () => {
    expect(installCommandFor(def({ linux: ['bash', '-c', 'curl https://x | bash'] }), 'win32')).toBeNull();
  });

  it('win32 returns the win32 command when present', () => {
    expect(installCommandFor(def({ win32: ['npm', 'i', '-g', 'x'] }), 'win32')).toEqual(['npm', 'i', '-g', 'x']);
  });

  it('darwin falls back to linux when darwin is absent', () => {
    expect(installCommandFor(def({ linux: ['npm', 'i', '-g', 'x'] }), 'darwin')).toEqual(['npm', 'i', '-g', 'x']);
  });

  it('linux uses linux', () => {
    expect(installCommandFor(def({ linux: ['pip', 'install', 'x'] }), 'linux')).toEqual(['pip', 'install', 'x']);
  });

  it('no installCommand at all → null', () => {
    expect(installCommandFor(def(undefined), 'darwin')).toBeNull();
  });
});

describe('AGENT_PROVIDERS registry pins (win32 runnability)', () => {
  it('every win32 installCommand starts with a Windows-runnable binary', () => {
    const allowed = new Set(['npm', 'pip', 'powershell.exe']);
    for (const p of AGENT_PROVIDERS) {
      const win = p.installCommand?.win32;
      if (!win) continue;
      expect(allowed.has(win[0]!), `${p.id}: win32 installCommand starts with '${win[0]}'`).toBe(true);
    }
  });

  it('no provider ships bash on win32', () => {
    for (const p of AGENT_PROVIDERS) {
      expect(p.installCommand?.win32?.[0], `${p.id} win32 cmd[0]`).not.toBe('bash');
    }
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/shared/providers.test.ts`
Expected: FAIL — `installCommandFor` not exported AND cursor's win32 `cmd[0]` is `'bash'`.

- [ ] **Step 3: Implement providers.ts changes**

3a. Add the helper right after the `AgentProviderDefinition` interface (after line 60):

```typescript
/**
 * Resolve the install command for `platform`. win32 NEVER falls back to a
 * POSIX (linux) command — `['bash','-c',…]` is unrunnable on stock Windows
 * and silently spawning it produced a dead install pane. A null return means
 * "no automated installer on this platform" → callers hide the Install
 * button and surface `installDocsUrl` instead. darwin/linux keep the
 * linux-as-fallback convenience (those commands are interchangeable here).
 * Pure + platform-injected: safe in both main and renderer.
 */
export function installCommandFor(
  def: AgentProviderDefinition,
  platform: string,
): string[] | null {
  const ic = def.installCommand;
  if (!ic) return null;
  if (platform === 'win32') return ic.win32 ?? null;
  if (platform === 'darwin') return ic.darwin ?? ic.linux ?? null;
  return ic.linux ?? null;
}
```

3b. Replace cursor's `installCommand` (lines 205-209):

```typescript
    installCommand: {
      darwin: ['bash', '-c', 'curl https://cursor.com/install -fsS | bash'],
      linux: ['bash', '-c', 'curl https://cursor.com/install -fsS | bash'],
      // Windows PowerShell installer per cursor.com/docs/cli/installation
      // (`irm 'https://cursor.com/install?win32=true' | iex`). cursor-agent's
      // first-class targets are macOS/Linux — treat win32 as best-effort and
      // device-verify before relying on it (win32-platform-services plan).
      win32: [
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "irm 'https://cursor.com/install?win32=true' | iex",
      ],
    },
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/shared/providers.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Fix the main-side resolver (rpc-router.ts:1326-1332)**

Extend the existing `@/shared/providers`-equivalent import in `app/src/main/rpc-router.ts` (the line importing `AGENT_PROVIDERS` — find it via `grep -n "AGENT_PROVIDERS" src/main/rpc-router.ts`) to also import `installCommandFor`. Then replace lines 1326-1332:

```typescript
      const platform = process.platform as 'darwin' | 'linux' | 'win32';
      const cmd = def.installCommand?.[platform] ?? def.installCommand?.linux;
      if (!cmd || cmd.length === 0) {
        throw new Error(
          `providers.spawnInstall: no installCommand for provider '${providerId}' on ${platform}`,
        );
      }
```

with:

```typescript
      const platform = process.platform;
      // installCommandFor never cross-falls-back onto a POSIX command on
      // win32 — a missing win32 installer throws here and the renderer modal
      // shows the manual-install docs link instead.
      const cmd = installCommandFor(def, platform);
      if (!cmd || cmd.length === 0) {
        throw new Error(
          `providers.spawnInstall: no installCommand for provider '${providerId}' on ${platform}`,
        );
      }
```

- [ ] **Step 6: Fix the renderer mirrors (ProviderInstallModal.tsx — 3 sites)**

This is the sibling-twin of the rpc-router site ([[feedback_grep_sibling_call_sites]]). In `app/src/renderer/features/workspace-launcher/ProviderInstallModal.tsx`:

6a. Extend the import at line 25: `import { AGENT_PROVIDERS, installCommandFor } from '@/shared/providers';`

6b. Prereq site (:107-115) — replace:

```typescript
        const cmd = def?.installCommand?.[pl === 'win32' ? 'win32' : pl === 'linux' ? 'linux' : 'darwin'];
```

with:

```typescript
        const cmd = def ? installCommandFor(def, pl) : null;
```

6c. `handleCopy` (:185) — replace `const cmd = def.installCommand?.[platform] ?? def.installCommand?.linux ?? [];` with:

```typescript
    const cmd = installCommandFor(def, platform) ?? [];
```

6d. Render derivation (:194) — same replacement:

```typescript
  const cmd = installCommandFor(def, platform) ?? [];
```

6e. The existing JSX already gates correctly once `cmd` can be empty: the docs-fallback block renders on `runtimeMissing || cmd.length === 0` (:213) and the footer Install button only renders on `!runtimeMissing && cmd.length > 0` (:322). Improve the fallback copy so the two cases read correctly — replace the fallback `<div className="text-sm text-muted-foreground">` text (:215-217) with:

```tsx
              <div className="text-sm text-muted-foreground">
                {cmd.length === 0
                  ? 'No automated installer is available on this platform. Install manually via the docs:'
                  : 'The required runtime is not on PATH. Visit the docs to install manually:'}
              </div>
```

- [ ] **Step 7: Verify the full suite + types**

Run: `npx vitest run src/shared/providers.test.ts && npx tsc -b`
Expected: PASS / clean. (No new modal test: the gating JSX is pre-existing and condition-driven; the decision logic lives in the pure, pinned `installCommandFor`.)

- [ ] **Step 8: Commit**

```bash
git add src/shared/providers.ts src/shared/providers.test.ts src/main/rpc-router.ts src/renderer/features/workspace-launcher/ProviderInstallModal.tsx
git commit -m "fix(win32): cursor PowerShell installer + never fall back to posix installCommand on win32 (main + modal mirrors)"
```

---

### Task 6: Align revealInFolder/openShell containment with path-guard semantics

**Files:**
- Modify: `app/src/main/core/security/path-guard.ts` (add `isInsideAnyRoot` after `isInsideRoot`, line 46)
- Modify: `app/src/main/core/security/path-guard.test.ts` (append cases)
- Modify: `app/src/main/rpc-router.ts:882-897` (`revealInFolder`) and `:898-910+` (`openShell`)

Why: both handlers use raw `resolved.startsWith(root + path.sep)`. On win32 that breaks on drive-letter casing (`c:\repo` vs `C:\repo`) and mixed separators, while `path-guard.ts` already does this correctly via `path.relative` (which is case-insensitive under `path.win32`). The helper takes an injectable `pathImpl` so the win32 semantics are unit-tested on macOS with `path.win32`. Scope note: these two handlers are intentionally LEXICAL (no realpath) today; this task aligns separator/casing semantics only — `assertAllowedPath` remains the symlink-safe keystone for the fs RPC surface.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/main/core/security/path-guard.test.ts` (it already imports from `./path-guard`; add `isInsideAnyRoot` to that import and `import path from 'node:path';` if absent):

```typescript
describe('isInsideAnyRoot (lexical containment, pathImpl-injectable)', () => {
  it('win32: accepts a target whose drive-letter casing differs from the root', () => {
    expect(isInsideAnyRoot('c:\\Repo\\sub\\file.ts', ['C:\\Repo'], path.win32)).toBe(true);
  });

  it('win32: accepts the root itself regardless of casing', () => {
    expect(isInsideAnyRoot('C:\\Repo', ['c:\\repo'], path.win32)).toBe(true);
  });

  it('win32: rejects the prefix trap C:\\RepoEvil vs C:\\Repo', () => {
    expect(isInsideAnyRoot('C:\\RepoEvil\\x', ['C:\\Repo'], path.win32)).toBe(false);
  });

  it('win32: rejects a different drive', () => {
    expect(isInsideAnyRoot('D:\\Repo\\x', ['C:\\Repo'], path.win32)).toBe(false);
  });

  it('posix: rejects the prefix trap /a/bc vs /a/b', () => {
    expect(isInsideAnyRoot('/a/bc/file', ['/a/b'], path.posix)).toBe(false);
  });

  it('posix: accepts a nested target under any of several roots', () => {
    expect(isInsideAnyRoot('/w/two/x', ['/w/one', '/w/two'], path.posix)).toBe(true);
  });

  it('empty roots ⇒ false (fail-closed)', () => {
    expect(isInsideAnyRoot('/a/b', [], path.posix)).toBe(false);
  });

  it('empty-string roots are skipped, not treated as filesystem root', () => {
    expect(isInsideAnyRoot('/a/b', [''], path.posix)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/main/core/security/path-guard.test.ts`
Expected: FAIL — `isInsideAnyRoot` not exported.

- [ ] **Step 3: Implement the helper**

In `app/src/main/core/security/path-guard.ts`, add after `isInsideRoot` (line 46):

```typescript
/**
 * Lexical many-roots containment for the reveal/open-shell class of handlers
 * (rpc-router `revealInFolder` / `openShell`). Unlike `assertAllowedPath`
 * this does NOT realpath (those handlers are intentionally lexical); it fixes
 * the raw-`startsWith` class of bugs: separator boundaries (`/a/bc` vs
 * `/a/b`) and win32 drive-letter casing — `path.win32.relative` compares
 * case-insensitively, which is exactly the Windows filesystem contract.
 *
 * `pathImpl` is injected so win32 semantics are unit-testable on any host
 * (pass `path.win32`); production callers omit it and get the platform path.
 */
export function isInsideAnyRoot(
  target: string,
  roots: string[],
  pathImpl: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute'> = path,
): boolean {
  const resolvedTarget = pathImpl.resolve(target);
  for (const root of roots) {
    if (!root) continue;
    const resolvedRoot = pathImpl.resolve(root);
    const rel = pathImpl.relative(resolvedRoot, resolvedTarget);
    if (rel === '' || (!rel.startsWith('..') && !pathImpl.isAbsolute(rel))) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/main/core/security/path-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire the two rpc-router handlers**

In `app/src/main/rpc-router.ts`, extend the existing path-guard import (the line importing `assertAllowedPath` — find via `grep -n "path-guard" src/main/rpc-router.ts`) to also import `isInsideAnyRoot`. Replace the `revealInFolder` body (:882-897):

```typescript
    revealInFolder: async (p: string) => {
      const resolved = path.resolve(p);
      const userDataDir = app.getPath('userData');
      if (!isInsideAnyRoot(resolved, [userDataDir])) {
        const workspaces = getRawDb()
          .prepare('SELECT root_path FROM workspaces')
          .all() as { root_path: string }[];
        const allowed = isInsideAnyRoot(resolved, workspaces.map((w) => w.root_path));
        if (!allowed) return { ok: false, error: 'path not in allowed root' };
      }
      shell.showItemInFolder(resolved);
      return { ok: true };
    },
```

and the identical containment block inside `openShell` (:898-910):

```typescript
    openShell: async (cwd: string) => {
      const resolved = path.resolve(cwd);
      const userDataDir = app.getPath('userData');
      if (!isInsideAnyRoot(resolved, [userDataDir])) {
        const workspaces = getRawDb()
          .prepare('SELECT root_path FROM workspaces')
          .all() as { root_path: string }[];
        const allowed = isInsideAnyRoot(resolved, workspaces.map((w) => w.root_path));
        if (!allowed) return { ok: false, error: 'path not in allowed root' };
      }
```

(keep the rest of `openShell`'s body — everything after the containment check — byte-identical).

Behavior preserved: the userData check still short-circuits the DB query; `isInsideAnyRoot(resolved, [userDataDir])` covers both the old `=== userDataDir` and `startsWith(userDataDir + path.sep)` cases, minus the separator/casing bugs. rpc-router itself cannot load under vitest (better-sqlite3 Electron ABI) — the logic is fully pinned at the pure helper.

- [ ] **Step 6: Verify types + suite**

Run: `npx tsc -b && npx vitest run src/main/core/security/path-guard.test.ts`
Expected: clean / PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/core/security/path-guard.ts src/main/core/security/path-guard.test.ts src/main/rpc-router.ts
git commit -m "fix(win32): revealFile/openShell containment via path.relative helper — drive-letter casing + separator safety"
```

---

### Task 7: `core.longpaths=true` on worktree creation (win32 MAX_PATH)

**Files:**
- Modify: `app/src/main/core/git/git-ops.ts` — add `gitArgsWithLongPaths` near the top of the worktree section, apply at the THREE sibling `worktree add` sites: `worktreeAdd:493-497`, `ensureWorktree` re-attach `:533-537`, `ensureWorktree` fresh-branch `:540-544`
- Modify: `app/src/main/core/git/git-ops-worktree.test.ts` (append pure-builder cases)

Why: SigmaLink worktrees nest under `<userData>/worktrees/<repo-hash>/<branch-seg>/…` — a deep repo blows past MAX_PATH (260) on Windows and `git worktree add` fails checking out long paths unless `core.longpaths` is on. `git -c core.longpaths=true …` scopes the setting to the single invocation — we never mutate the user's git config. Decision recorded for the device checklist: per-invocation `-c` (not `git config --global`).

- [ ] **Step 1: Write the failing tests**

Append to `app/src/main/core/git/git-ops-worktree.test.ts` (add `gitArgsWithLongPaths` to its `./git-ops` import):

```typescript
describe('gitArgsWithLongPaths (win32 MAX_PATH)', () => {
  it('win32: prepends -c core.longpaths=true before the subcommand', () => {
    expect(gitArgsWithLongPaths(['worktree', 'add', '-b', 'b', '/p', 'HEAD'], 'win32')).toEqual([
      '-c',
      'core.longpaths=true',
      'worktree',
      'add',
      '-b',
      'b',
      '/p',
      'HEAD',
    ]);
  });

  it('darwin/linux: returns the base argv unchanged (same reference — zero churn)', () => {
    const base = ['worktree', 'add', '/p', 'branch'];
    expect(gitArgsWithLongPaths(base, 'darwin')).toBe(base);
    expect(gitArgsWithLongPaths(base, 'linux')).toBe(base);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/main/core/git/git-ops-worktree.test.ts`
Expected: FAIL — `gitArgsWithLongPaths` not exported.

- [ ] **Step 3: Implement**

In `app/src/main/core/git/git-ops.ts`, add immediately above `worktreeAdd` (line 487):

```typescript
/**
 * Wrap a git argv with win32 long-path support. SigmaLink worktrees nest
 * under <userData>/worktrees/<repo-hash>/<branch-seg>/… and deep repos exceed
 * MAX_PATH (260) on Windows; checkout then fails unless `core.longpaths` is
 * on. `-c` scopes the setting to THIS invocation — the user's git config is
 * never mutated. No-op (same array reference) off win32.
 */
export function gitArgsWithLongPaths(
  base: string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === 'win32' ? ['-c', 'core.longpaths=true', ...base] : base;
}
```

Apply at the three sibling sites (grep first: `grep -n "'worktree', 'add'" src/main/core/git/git-ops.ts` must list exactly these three; if a fourth appeared since, wrap it too):

`worktreeAdd` (:493-497):

```typescript
  const res = await execCmd(
    'git',
    gitArgsWithLongPaths(['worktree', 'add', '-b', args.branch, args.worktreePath, args.base]),
    { cwd: args.repoRoot, timeoutMs: 30_000 },
  );
```

`ensureWorktree` re-attach (:533-537):

```typescript
  let res = await execCmd(
    'git',
    gitArgsWithLongPaths(['worktree', 'add', args.worktreePath, args.branch]),
    { cwd: args.repoRoot, timeoutMs: 30_000 },
  );
```

`ensureWorktree` fresh-branch (:540-544):

```typescript
    res = await execCmd(
      'git',
      gitArgsWithLongPaths(['worktree', 'add', '-b', args.branch, args.worktreePath, 'HEAD']),
      { cwd: args.repoRoot, timeoutMs: 30_000 },
    );
```

(Production call sites omit the platform argument — the default keeps darwin behavior reference-identical; tests pin win32 via the explicit parameter, matching the deps-default pattern used by `claude-resume-sigma.ts`.)

- [ ] **Step 4: Run to verify PASS (including the real-git integration tests)**

Run: `npx vitest run src/main/core/git/git-ops-worktree.test.ts src/main/core/git/git-ops.test.ts`
Expected: PASS — on darwin the argv is unchanged, so the real-git `ensureWorktree` integration tests are untouched.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/git/git-ops.ts src/main/core/git/git-ops-worktree.test.ts
git commit -m "fix(win32): scope core.longpaths=true to worktree-add invocations (MAX_PATH deep repos)"
```

---

### Task 8: H-6 win32 shell-first lift — GATED, LAST, device-validation required

**Files:**
- Modify (GATED): `app/src/main/core/pty/local-pty.ts:371-378` (`resolveEffectiveSpawnMode`)
- Modify (GATED): `app/src/main/core/pty/local-pty.test.ts:561-569` (the win32-coercion test inverts) and `:571-605` (the spawn-consistency test retires)

**DO NOT EXECUTE the code steps of this task in the same pass as Tasks 1-7.** The deferred-by-design H-6 guard (shell-first force-coerced to `'direct'` on win32, `local-pty.ts:364-378`) stays in place until the device-verification evidence below exists. The win32 plumbing it would activate (`buildWin32CmdCommandLine`, `buildCmdSentinelSnippet`, sentinel watching) is already unit-tested but explicitly "pending-Windows-dogfood" (`local-pty.ts:335-337`). Lifting it blind would turn every win32 pane into an untested wrap path. Coordination: the .cmd-shim spawn class that shell-first interacts with is owned by the sibling **win32-spawn-correctness** plan — its landing is a PREREQUISITE for this lift.

- [ ] **Step 1 [GATE]: Collect device evidence on real Windows hardware (see Device-verification checklist items 1-2)**

Required evidence, all on a physical Windows 11 machine running a packaged (NSIS) build with the win32-spawn-correctness plan landed:
1. A claude pane spawned with `spawnMode: 'shell-first'` manually patched in (dev build): the cmd.exe sentinel snippet from `buildCmdSentinelSnippet()` emits the exit-code marker on CLI exit, and the registry's sentinel watcher catches it (crash-shell fallback shell appears instead of a dead pane).
2. The post-spawn `pty.write` initial-prompt providers (kimi, opencode — Path B per `local-pty.ts:393-397`) still receive their seed prompt reliably (the per-pane `'direct'` override logic must keep working).
3. No double-echo / encoding artifacts in the wrapped pane (cmd.exe quoting from `win32QuoteCmdArg`).

- [ ] **Step 2 [GATED]: Invert the pinned test**

Replace `local-pty.test.ts:561-569` (the `'win32: shell-first request is coerced to direct …'` test) with:

```typescript
  it('win32: shell-first request is honored (H-6 lifted after device validation — see 2026-06-10-win32-platform-services plan)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(resolveEffectiveSpawnMode('shell-first', 'claude')).toBe('shell-first');
  });
```

and DELETE the now-obsolete `describe('spawnLocalPty: win32 shell-first consistency (H-6)')` block (`:571-605`) — its premise (win32 coerces to direct) no longer holds; the wrap/watch consistency is guaranteed by both sides reading the same helper.

- [ ] **Step 3 [GATED]: Run to verify FAIL**

Run: `npx vitest run src/main/core/pty/local-pty.test.ts`
Expected: FAIL — the inverted test gets `'direct'`.

- [ ] **Step 4 [GATED]: The one-line guard lift**

Replace `resolveEffectiveSpawnMode` (`local-pty.ts:371-378`):

```typescript
export function resolveEffectiveSpawnMode(
  spawnMode: 'direct' | 'shell-first' | undefined,
  command: string,
): 'direct' | 'shell-first' {
  return spawnMode === 'shell-first' && command !== '' ? 'shell-first' : 'direct';
}
```

and update the H-6 comment above it (`:350-370`) to note the lift date + the device evidence reference. Both call sites (spawnLocalPty wrap-side, PtyRegistry.create watch-side) update automatically by construction.

- [ ] **Step 5 [GATED]: Run to verify PASS**

Run: `npx vitest run src/main/core/pty/local-pty.test.ts src/main/core/pty/registry.test.ts`
Expected: PASS.

- [ ] **Step 6 [GATED]: Commit**

```bash
git add src/main/core/pty/local-pty.ts src/main/core/pty/local-pty.test.ts
git commit -m "fix(win32): lift H-6 shell-first coercion after device validation — exit sentinel + crash-shell fallback live on Windows"
```

---

## Gate (run after Tasks 1-7; Task 8 re-runs it when its gate opens)

From `/Users/aisigma/projects/SigmaLink/app`:

```bash
npx tsc -b
npx eslint . --max-warnings 0
npx vitest run
npm run product:check
```

**NO local e2e** — `npx playwright test` launches competing Electron windows on the operator's machine; e2e runs in the CI e2e-matrix on the PR ([[feedback_no_local_e2e_with_live_app]]).

---

## Device-verification checklist (real Windows 11 hardware, packaged NSIS build)

1. **ConPTY pane feel** — open claude/codex/shell panes: typing latency, resize reflow (drag dividers), colors/cursor; no ghost text after resize.
2. **Shell-first sentinel (Task 8 gate)** — dev-patched shell-first pane: exit-code marker emitted on CLI exit, crash-shell fallback opens; kimi/opencode seed prompts still land. **Task 8 stays unlifted until this passes.**
3. **Tree-kill (Task 1)** — spawn a claude pane that starts an MCP server (detached grandchild); close the pane; `Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'mcp|node' }` shows the grandchild GONE; pane RSS visible in the RAM-brake/pane stats while running.
4. **Kill → reap EBUSY cycle (Tasks 1+2)** — open a shell pane with cwd inside its worktree, trigger workspace cleanup: first rm attempts may EBUSY, backoff retries succeed after the tree dies; no permanently wedged dir; on forced failure the `[rm-retry]` warning appears in the main-process log.
5. **Hardlink resume round-trip (Task 3)** — Dev Mode OFF (symlink EPERM path): create a session at the workspace root, resume it in a worktree pane; `fsutil hardlink list <workspace-slug jsonl>` shows 2 names; type a message, confirm the append is visible through BOTH paths; re-resume from the workspace root keeps full history. Verify the `.claude` dir arrives as a junction (`dir /AL` shows `<JUNCTION>`).
6. **MAX_PATH + longpaths (Task 7)** — workspace whose repo contains a >240-char nested path; create a worktree pane: checkout succeeds; decision confirmed: per-invocation `-c core.longpaths=true` only (no global git-config mutation). Also watch `worktree remove` on that repo — if removal hits long-path errors, extend `gitArgsWithLongPaths` to `worktreeRemove` (follow-up, not in this plan's scope).
7. **Provider install on win32 (Task 5)** — Install-now for cursor runs the PowerShell installer in the pane; kimi with no Python shows the docs fallback (not a dead pane); npm-based installs spawn (the `npm.cmd` shim resolution belongs to win32-spawn-correctness — verify after it lands).
8. **Voice natives + PTT (Task 4)** — NSIS build: voice natives load (no silent stub — [[reference_sigmavoice_cross_repo_native_gotchas]]); `Ctrl+Shift+Space` triggers capture on a fresh profile; with an IME layout active, no input-method toggle collision; bind a conflicting hotkey → Settings → Voice shows the persistent "not registered" state (not just a missed toast).
9. **Reveal/open-shell (Task 6)** — "Reveal in Explorer" works for a worktree under `%APPDATA%` AND for a workspace opened via a differently-cased drive letter (`c:\` vs `C:\`).

## Coordination notes (sibling plans from the same 2026-06-10 audit)

- **perf-hot-paths** — refactors process-tree into a snapshot+TTL cache over a per-platform list fn. Task 1's `listProcessRows(deps?: ProcessTreeDeps): ProcessListResult` IS that fn: keep its signature; the TTL layer wraps it; no caching added here. If perf-hot-paths lands first, rebase Task 1 by implementing the same win32 branch inside whatever it named the list fn — the CIM/taskkill primitives in `process-list-win32.ts` are dependency-free and survive either order.
- **worktree-reaper-fence** — rewrites `cleanup.ts`'s keep/use PREDICATE. Task 2 touches only the `fs.rm` call at :139 (one line) → trivial merge either order.
- **win32-spawn-correctness** — owns the `.cmd`-shim spawn class (npm/pip/`cursor-agent.cmd` PTY spawns, incl. `providers.spawnInstall` and scratch shells, and `rpc-router.ts:1034`'s `cmd.exe` default). Task 5 only decides WHICH command to run, never HOW it spawns; reuse that plan's spawn helper if it lands first. Its landing is a PREREQUISITE for Task 8's gate.

## Refuted / adjusted findings (for the audit record)

- **Finding 4 (silent register failure): half-refuted.** A toast already exists (`global-capture.ts:386`); the actual gap is that it fires before subscribers mount. Fixed via the persistent `hotkeyRegistered` status field instead of a duplicate notification.
- **Finding 5 (per-platform schema): half-refuted.** The schema has been per-platform since v1.4.9-06 (`providers.ts:44-48`). The bugs were value-level (cursor win32 = bash) and resolution-level (linux fallback on win32 at TWO mirrored sites). Kimi's pip command is already prereq-gated by the modal → unchanged.
