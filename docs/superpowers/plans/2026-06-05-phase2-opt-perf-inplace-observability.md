# Phase 2 — OPT: perf/resource pass + in-place worktree mode + observability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop steady-state CPU/disk footprint and let users opt out of worktrees, while making any future disk runaway observable — implementing only the Phase-2 work that is genuinely unbuilt.

**Architecture:** Three file-disjoint lanes runnable in parallel. **Lane A (renderer):** migrate the 23 whole-context `useAppState()` consumers to the already-shipped `useAppStateSelector` so a dispatch only re-renders subscribers of the changed slice. **Lane B (main):** convert `session-disk-scanner.ts`'s 5 sync `fs.*Sync` sites to `fs/promises` (public Promise shape unchanged). **Lane C (main):** add a per-workspace `worktreeMode` KV flag that short-circuits BOTH worktree gates to the existing no-worktree path (ADR-007), plus structured logging + a critical notification at the disk-guard / spawn / cleanup sites.

**Tech Stack:** Electron main (Node ≥18, better-sqlite3 via MockDb in tests), React 19 renderer (`useSyncExternalStore`), vitest, Tailwind/shadcn, Drizzle-style raw-prepare DAO.

---

## ⚠️ Recon outcome — what is ALREADY shipped (do NOT rebuild)

A 5-agent read-only recon (2026-06-05) found these Phase-2 items already implemented, wired, and tested — exclude them and strike them from `ROADMAP.md`/`WISHLIST.md` on wrap-up:

- **PERF-1** `pty:data` IPC coalescing — `src/main/core/pty/pty-data-coalescer.ts` (one shared 12ms timer + 64KiB force-flush + flush-before-exit at `rpc-router.ts:477/561`, `dispose()` at `:2342`); full unit suite `pty-data-coalescer.test.ts`.
- **PERF-5** refcounted Ruflo-health poller — `src/renderer/features/command-room/useRufloDaemonHealth.ts` (module-level `pollers` Map + `useSyncExternalStore`, one 5s interval per workspace); `useRufloDaemonHealth.test.ts` covers refcount teardown.
- **PERF-6 / PERF-16** per-pane git-status / activity polling — `src/renderer/lib/use-git-status-poll.ts` (15s) + `use-git-activity-poll.ts` (60s), both refcounted + `document.hidden` visibility-gated; `use-git-status-poll.test.ts` covers pause/resume.

**Genuinely remaining (this plan):** PERF-3 (selector migration), PERF-8 (async disk-scan), DEV-W3b (in-place mode), ruflo-observability.

## Lane / file-disjointness map (parallel-safe)

| Lane | Item(s) | Files (exclusive) | Process |
|------|---------|-------------------|---------|
| **A** | PERF-3 | `src/renderer/app/App.tsx`, `…/rooms/TasksRoom.tsx`, `…/rooms/MemoryRoom.tsx`, secondary swarm consumers; READS `state.hook.ts` (no edit) | renderer |
| **B** | PERF-8 | `src/main/core/pty/session-disk-scanner.ts` (+ its test) | main |
| **C** | DEV-W3b + observability | `src/main/core/workspaces/{launcher.ts,worktree-mode.ts(new),factory.ts}`, `src/main/core/swarms/factory-spawn.ts`, `src/main/core/git/worktree.ts`, `src/main/core/workspaces/worktree-cleanup.ts`, `src/renderer/features/settings/*` toggle | main+renderer |

Lanes A, B, C touch disjoint files → run as 3 worktree-isolated agents. Within Lane C, do DEV-W3b tasks **before** observability tasks (both edit `launcher.ts`/`factory-spawn.ts`; one agent, sequential, avoids the sibling-twin collision — see [[feedback_grep_sibling_call_sites]]).

**Gate every lane in MAIN after merge** (worktree `tsc` is laxer than main's `tsc -b`): `npm run build && npm test` + `npx playwright test tests/e2e/`.

---

# LANE B — PERF-8: async disk-scan (smallest, do first to warm up)

**Why first:** self-contained single file, public API already returns Promises, existing integration tests are the regression guard.

**Files:**
- Modify: `src/main/core/pty/session-disk-scanner.ts` (sync→async at lines ~119, 127, 329-345, 363-383, 421, 614, 139)
- Test: `src/main/core/pty/session-disk-scanner.test.ts` (real-tmpdir integration, no fs mock)

### Task B1: Lock current behavior with a parity test (RED is impossible — this is a characterization guard)

- [ ] **Step 1: Add a focused async-path test** to `session-disk-scanner.test.ts` that drives the public `listSessionsInCwd` for the `claude` provider through a real tmpdir and asserts it resolves with the seeded session. (This already-async entrypoint internally calls the sync functions we're about to convert; the test must stay green across the refactor.)

```typescript
// Append inside the existing describe block; reuse the file's mkdtemp helpers.
it('PERF-8: listSessionsInCwd(claude) resolves over async fs without changing results', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-disk-'));
  // seed a claude project dir + one session jsonl (mirror the existing claude fixture in this file)
  const proj = path.join(home, '.claude', 'projects', '-tmp-repo');
  fs.mkdirSync(proj, { recursive: true });
  const sess = path.join(proj, 'sess-1.jsonl');
  fs.writeFileSync(sess, JSON.stringify({ cwd: '/tmp/repo', sessionId: 'sess-1' }) + '\n');
  fs.utimesSync(sess, new Date(), new Date());

  const out = await listSessionsInCwd({ provider: 'claude', cwd: '/tmp/repo', homeDir: home, now: () => Date.now() });
  expect(out.map((s) => s.sessionId)).toContain('sess-1');
});
```

- [ ] **Step 2: Run it green on the CURRENT (sync) code**

Run: `npx vitest run src/main/core/pty/session-disk-scanner.test.ts -t PERF-8`
Expected: PASS (proves the fixture is correct before refactor).

- [ ] **Step 3: Commit**

```bash
git add src/main/core/pty/session-disk-scanner.test.ts
git commit -m "test(perf-8): characterize claude disk-scan async entrypoint before fs migration"
```

### Task B2: Convert the leaf fs helpers to fs/promises

- [ ] **Step 1: Convert `safeStat` + `safeReadDir`** (currently `fs.statSync`/`fs.readdirSync`).

```typescript
async function safeStat(p: string): Promise<fs.Stats | null> {
  try { return await fs.promises.stat(p); } catch { return null; }
}
async function safeReadDir(p: string): Promise<fs.Dirent[]> {
  try { return await fs.promises.readdir(p, { withFileTypes: true }); } catch { return []; }
}
```

- [ ] **Step 2: Convert `readFirstLine` + `readHeadLines`** to `fs.promises.open` → `handle.read` → `handle.close` (preserve the byte-budget read logic; just swap `fs.openSync/readSync/closeSync` for the handle API and `await` each; wrap in try/finally to always `await handle.close()`).

- [ ] **Step 3: Convert `listKimiSessions` line ~614** `fs.readFileSync(stateFile,'utf8')` → `await fs.promises.readFile(stateFile,'utf8')`.

- [ ] **Step 4: Make `findFiles` async** — the BFS loop `await`s each `safeReadDir` in sequence (breadth-first order preserved; no parallelism needed):

```typescript
async function findFiles(/* same args */): Promise<string[]> {
  // ...same BFS, but: const entries = await safeReadDir(dir);  and  const st = await safeStat(p);
}
```

- [ ] **Step 5: Propagate `async` up to the per-provider list/find functions** that call the now-async leaves: `listClaudeSessions`, `findCodexSession`, `findKimiSession` become `async function … : Promise<…>`. Their callers `listSessionsInCwd` (switch cases already `return` the value) and `findLatestSessionId` are already `async` — **no caller signature changes**. Add `await` at each internal call site (the switch `case 'claude': return await listClaudeSessions(...)` etc.).

- [ ] **Step 6: Run the FULL scanner suite**

Run: `npx vitest run src/main/core/pty/session-disk-scanner.test.ts`
Expected: PASS (all pre-existing tests + B1 stay green — public shape unchanged).

- [ ] **Step 7: Typecheck**

Run: `npx tsc -b`
Expected: no errors (every former-sync call is now awaited; no `Promise<x>` used as `x`).

- [ ] **Step 8: Commit**

```bash
git add src/main/core/pty/session-disk-scanner.ts
git commit -m "perf(PERF-8): non-blocking disk scan — fs/promises in session-disk-scanner (no API change)"
```

**Gotchas:** (1) `findOpencodeSession` is already async (subprocess) — leave it. (2) `listCodexSessions` is already async — only its internal `findCodexSession` call needs `await`. (3) The Phase-0 `onPostSpawnCapture` retry schedule already calls `findLatestSessionId` fire-and-forget (`void`) — async internals are transparent there.

---

# LANE A — PERF-3: migrate whole-context consumers to selectors

**Infra already exists** (`src/renderer/app/state.hook.ts`): `useAppStateSelector<T>(sel)` = `useSyncExternalStore(appStateStore.subscribe, () => sel(getSnapshot()), …)` with `Object.is` equality, and `useAppDispatch()` (zero-cost). **Do not add libraries.** The work is mechanical: swap `const { state } = useAppState()` for slice selectors, and `const { dispatch } = useAppState()` for `useAppDispatch()`. Start with the 5 worst (highest-frequency-action) consumers.

**Files:**
- Modify: `src/renderer/app/App.tsx` (RoomSwitch ~76, MainBody ~171, GlobalMemorySwitcher ~201)
- Modify: `src/renderer/.../rooms/TasksRoom.tsx` (~63), `.../rooms/MemoryRoom.tsx` (~66)
- Test: colocated `*.test.tsx` per component (RTL + vitest)

> **Render-count caveat:** these are perf migrations with no output change. The TDD signal is a **render-count assertion** — render the component inside the real `<AppStateProvider>`, dispatch an UNRELATED action, and assert the component body ran 0 extra times. Use a `vi.fn()` render spy in a test wrapper.

### Task A1: RoomSwitch + MainBody subscribe to `state.room` only

- [ ] **Step 1: Write the failing render-count test** (`App.room-selectors.test.tsx`, new):

```tsx
import { render, act } from '@testing-library/react';
import { AppStateProvider } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { useAppStateSelector } from '@/renderer/app/state';

// Minimal probe mirroring RoomSwitch's subscription contract.
function RoomProbe({ onRender }: { onRender: () => void }) {
  const room = useAppStateSelector((s) => s.room);
  onRender();
  return <span data-testid="room">{room}</span>;
}

it('PERF-3: a room-only consumer does NOT re-render on an unrelated NOTIFICATIONS_DELTA', () => {
  const spy = vi.fn();
  render(<AppStateProvider><RoomProbe onRender={spy} /></AppStateProvider>);
  const before = spy.mock.calls.length;
  act(() => {
    appStateStore.setState({ ...appStateStore.getSnapshot(), notificationsUnreadCount: 1 });
  });
  expect(spy.mock.calls.length).toBe(before); // room unchanged → no re-render
});
```

- [ ] **Step 2: Run — expect PASS for the probe** (it already uses the selector). This proves the *target* behavior. Now prove the *current* `App.tsx` violates it:

Run: `npx vitest run src/renderer/app/App.room-selectors.test.tsx`
Expected: PASS (probe is the spec). The real RoomSwitch fix below is verified by re-pointing the test at the real component once exported, or by manual inspection that `useAppState()` is gone.

- [ ] **Step 3: Migrate `RoomSwitch` (App.tsx ~76) and `MainBody` (~171)** — replace `const { state } = useAppState();` with `const room = useAppStateSelector((s) => s.room);` and use `room` instead of `state.room`. If either also dispatched, add `const dispatch = useAppDispatch();`.

- [ ] **Step 4: Run the full App test suite + typecheck**

Run: `npx vitest run src/renderer/app/ && npx tsc -b`
Expected: PASS / no errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/App.tsx src/renderer/app/App.room-selectors.test.tsx
git commit -m "perf(PERF-3): RoomSwitch+MainBody subscribe to state.room slice only"
```

### Task A2: GlobalMemorySwitcher subscribes to `activeWorkspaceId` + that workspace's memories

- [ ] **Step 1: Add a render-count test** asserting it does not re-render on `APPEND_SWARM_MESSAGE` (unrelated). Same harness as A1, probe reads `useAppStateSelector((s)=>s.activeWorkspaceId)` then derives memories via a second selector keyed by that id.

- [ ] **Step 2: Migrate `GlobalMemorySwitcher` (App.tsx ~201)** to two selectors:

```tsx
const wsId = useAppStateSelector((s) => s.activeWorkspaceId);
const memories = useAppStateSelector((s) => (wsId ? s.memories[wsId] : undefined) ?? EMPTY_MEMORIES);
// EMPTY_MEMORIES is a module-level const [] to keep referential stability
```

- [ ] **Step 3: Run + commit**

Run: `npx vitest run src/renderer/app/ && npx tsc -b`

```bash
git add src/renderer/app/App.tsx src/renderer/app/*.test.tsx
git commit -m "perf(PERF-3): GlobalMemorySwitcher reads wsId+memories[wsId] slices"
```

### Task A3: TasksRoom granular selectors

- [ ] **Step 1: Migrate `TasksRoom` (~63)** — replace the single `useAppState()` with: `activeWorkspace` (or `activeWorkspaceId`), `tasks[wsId]`, `room`, `activeSwarmId`, and **`swarmsByWorkspace[wsId]` (NOT the global `swarms` array)**. Wrap any `.find()` derivations in `useMemo`. Keep behavior identical.

- [ ] **Step 2: Run TasksRoom test + typecheck**

Run: `npx vitest run src/renderer/**/TasksRoom* && npx tsc -b`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/**/TasksRoom*
git commit -m "perf(PERF-3): TasksRoom subscribes per-slice (workspace-scoped swarms)"
```

### Task A4: MemoryRoom granular selectors

- [ ] **Step 1: Migrate `MemoryRoom` (~66)** to per-slice selectors: `activeWorkspace`, `memories[wsId]`, `activeMemoryName`, `memoryGraph`, `pendingRufloView`. Prefer separate `useAppStateSelector` calls per slice (Object.is equality) over a combined-object selector.

- [ ] **Step 2: Run + typecheck + commit**

Run: `npx vitest run src/renderer/**/MemoryRoom* && npx tsc -b`

```bash
git add src/renderer/**/MemoryRoom*
git commit -m "perf(PERF-3): MemoryRoom subscribes per-slice (no re-render on session/swarm churn)"
```

### Task A5 (secondary pass): fix leaky whole-map `swarmMessages` selectors

- [ ] **Step 1:** In `SwarmRoom`, `SwarmRailTab`, `OperatorConsole` — the existing `useAppStateSelector((s) => s.swarmMessages)` returns the whole map (new identity on every `APPEND_SWARM_MESSAGE`). Read `activeSwarmId` first, then derive the per-thread array:

```tsx
const activeSwarmId = useAppStateSelector((s) => s.activeSwarmId);
const messages = useAppStateSelector((s) => (activeSwarmId ? s.swarmMessages[activeSwarmId] : undefined) ?? EMPTY_MSGS);
```

- [ ] **Step 2:** Replace any remaining dispatch-only `useAppState()` (e.g. `OriginLink`) with `useAppDispatch()`.

- [ ] **Step 3: Run the renderer suite + typecheck + commit**

Run: `npx vitest run src/renderer/ && npx tsc -b`

```bash
git add -A src/renderer/
git commit -m "perf(PERF-3): per-thread swarmMessages selectors + dispatch-only consumers use useAppDispatch"
```

**Note:** the remaining low-heat `useAppState()` consumers (Settings/Onboarding/SkillsRoom/etc., ~14 sites) can be migrated opportunistically; they re-render rarely. Scope this lane to A1–A5 unless time remains.

---

# LANE C — DEV-W3b in-place mode + ruflo-observability (one agent, sequential)

Both edit `launcher.ts` and `factory-spawn.ts` → single agent, DEV-W3b first. ADR-007 governs in-place mode; reuse the existing no-worktree path — `worktree-cwd.ts` already returns `workspaceRoot` when `worktreePath` is null, so in-place mode just **never assigns** a worktree.

## Part 1 — DEV-W3b in-place / no-worktree mode

**Files:**
- Create: `src/main/core/workspaces/worktree-mode.ts` (+ test)
- Modify: `src/main/core/workspaces/launcher.ts` (Gate A ~224)
- Modify: `src/main/core/swarms/factory-spawn.ts` (Gate B ~205-220)
- Modify: a Settings UI component (per-workspace toggle)

### Task C1: `readWorktreeMode` KV helper (TDD)

KV is schema-free; key convention `workspace.worktreeMode.${workspaceId}` → `'worktree'|'in-place'`, default `'worktree'`. Mirror existing `readShowLegacy()`/`readRufloAutowrite()` raw-prepare helpers in `launcher.ts`.

- [ ] **Step 1: Write the failing test** `src/main/core/workspaces/worktree-mode.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { readWorktreeMode } from './worktree-mode';

function rawStub(value: string | undefined) {
  return { prepare: () => ({ get: () => (value === undefined ? undefined : { value }) }) } as any;
}

describe('readWorktreeMode', () => {
  it('returns in-place only for the exact string', () => {
    expect(readWorktreeMode(rawStub('in-place'), 'ws1')).toBe('in-place');
  });
  it('defaults to worktree when unset', () => {
    expect(readWorktreeMode(rawStub(undefined), 'ws1')).toBe('worktree');
  });
  it('defaults to worktree for any other value (fail-safe)', () => {
    expect(readWorktreeMode(rawStub('garbage'), 'ws1')).toBe('worktree');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

Run: `npx vitest run src/main/core/workspaces/worktree-mode.test.ts`
Expected: FAIL "Cannot find module './worktree-mode'".

- [ ] **Step 3: Implement** `src/main/core/workspaces/worktree-mode.ts`:

```typescript
import type { RawDb } from '../db/types'; // match the type used by readRufloAutowrite in launcher.ts

export type WorktreeMode = 'worktree' | 'in-place';

export function readWorktreeMode(rawDb: RawDb, workspaceId: string): WorktreeMode {
  try {
    const row = rawDb.prepare('SELECT value FROM kv WHERE key = ?').get(`workspace.worktreeMode.${workspaceId}`) as
      | { value?: string }
      | undefined;
    return row?.value === 'in-place' ? 'in-place' : 'worktree';
  } catch {
    return 'worktree';
  }
}
```

(If `launcher.ts`'s sibling helpers take the rawDb implicitly via `getRawDb()`, match that signature instead — read the existing `readRufloAutowrite` first and mirror it exactly.)

- [ ] **Step 4: Run — expect PASS.** Then commit:

```bash
git add src/main/core/workspaces/worktree-mode.ts src/main/core/workspaces/worktree-mode.test.ts
git commit -m "feat(DEV-W3b): readWorktreeMode KV helper (ADR-007), default worktree"
```

### Task C2: Gate A (launcher.ts) honors in-place

- [ ] **Step 1: Write the failing test** in `src/main/core/workspaces/launcher.test.ts` using the existing `GIT_WS_ROW` fixture; stub `getRawDb()` so the worktreeMode key returns `{value:'in-place'}`:

```typescript
it('DEV-W3b: in-place mode skips worktree creation and runs in workspace root', async () => {
  // arrange: GIT_WS_ROW (repoMode:'git', repoRoot), rawDb returns 'in-place' for the worktreeMode key
  // act: executeLaunchPlan(plan, deps)
  // assert:
  expect(deps.worktreePool.create).not.toHaveBeenCalled();
  expect(spawnedCwd).toBe(GIT_WS_ROW.rootPath); // workspaceCwdInWorktree(worktreePath=null) === rootPath
});
```

- [ ] **Step 2: Run — expect FAIL** (`worktreePool.create` IS called today).

Run: `npx vitest run src/main/core/workspaces/launcher.test.ts -t DEV-W3b`
Expected: FAIL (create called).

- [ ] **Step 3: Edit Gate A** (`launcher.ts` ~224). Read worktreeMode once, add `!inPlace &&` to the gate:

```typescript
const inPlace = readWorktreeMode(getRawDb(), wsRow.id) === 'in-place';
if (!inPlace && wsRow.repoMode === 'git' && wsRow.repoRoot) {
  const r = await deps.worktreePool.create({ /* unchanged */ });
  worktreePath = r.worktreePath;
  branch = r.branch;
  finalPreallocSessionId = r.sessionId;
}
// worktreePath stays null when inPlace → workspaceCwdInWorktree returns wsRow.rootPath
```

- [ ] **Step 4: Run — expect PASS** + run the full launcher suite (ensure the worktree path still works when mode=worktree):

Run: `npx vitest run src/main/core/workspaces/launcher.test.ts && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspaces/launcher.ts src/main/core/workspaces/launcher.test.ts
git commit -m "feat(DEV-W3b): launcher Gate A honors in-place worktreeMode"
```

### Task C3: Gate B (factory-spawn.ts) honors in-place — SIBLING TWIN

- [ ] **Step 1: Write the failing test** in `factory-spawn.test.ts`. `makeArgs` defaults to `repoMode:'plain'` — override to `'git'` + `repoRoot` (mirror the CRIT-1/2 describe block) and stub rawDb to return `'in-place'`:

```typescript
it('DEV-W3b: in-place mode skips worktree creation in factory-spawn', async () => {
  const args = makeArgs(deps);
  args.wsRow.repoMode = 'git'; args.wsRow.repoRoot = '/tmp/repo';
  // rawDb stub → worktreeMode key returns 'in-place'
  await spawnAgentSession(args);
  expect(deps.worktreePool.create).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `npx vitest run src/main/core/swarms/factory-spawn.test.ts -t DEV-W3b`
Expected: FAIL.

- [ ] **Step 3: Edit Gate B** (`factory-spawn.ts` ~205). Preserve the `worktreePathOverride` short-circuit (splitPane) — only add `!inPlace` to the `else if` git branch:

```typescript
const inPlace = readWorktreeMode(getRawDb(), args.wsRow.id) === 'in-place';
if (args.worktreePathOverride !== undefined) {
  worktreePath = args.worktreePathOverride;
  branch = args.branchOverride ?? null;
} else if (!inPlace && args.wsRow.repoMode === 'git' && args.wsRow.repoRoot) {
  const r = await args.deps.worktreePool.create({ /* unchanged */ });
  worktreePath = r.worktreePath; branch = r.branch; spawnSessionId = r.sessionId;
}
```

- [ ] **Step 4: Run — expect PASS** + full factory-spawn suite + typecheck.

Run: `npx vitest run src/main/core/swarms/factory-spawn.test.ts && npx tsc -b`

- [ ] **Step 5: Commit**

```bash
git add src/main/core/swarms/factory-spawn.ts src/main/core/swarms/factory-spawn.test.ts
git commit -m "feat(DEV-W3b): factory-spawn Gate B honors in-place (sibling twin to launcher)"
```

### Task C4: Settings UI toggle (per-workspace worktree mode)

- [ ] **Step 1:** In the per-workspace settings surface (the same place the Yolo/autoApprove default toggle lives — find it via the `pane.autoApprove.default.${wsId}` KV usage in `Launcher.tsx`/settings), add a "Worktree mode" control writing the KV via the renderer RPC:

```tsx
// on change:
void rpc.kv?.set?.(`workspace.worktreeMode.${workspaceId}`, inPlace ? 'in-place' : 'worktree')?.catch(() => undefined);
```

- [ ] **Step 2:** Render the trade-off warning when in-place is selected: *"In-place mode runs agents directly in the repo — concurrent agents share one working tree and their edits can collide. Applies to the next launch."*

- [ ] **Step 3:** Add a component test asserting toggling writes the right KV key/value, then run + commit:

Run: `npx vitest run src/renderer/features/settings/ && npx tsc -b`

```bash
git add -A src/renderer/features/settings/
git commit -m "feat(DEV-W3b): per-workspace worktree-mode toggle + collision warning"
```

## Part 2 — ruflo-observability (structured logging at the disk/spawn/cleanup sites)

No new logger dependency — extend the existing `console.*` bracketed-prefix convention + the `NotificationsManager.add` rail (already threaded into `OpenWorkspaceDeps.notifications`). Keep it a small packet: logs + one critical notification. Defer a `worktree_events` table (stretch, below) per the small-per-packet DDD rule.

**Files:**
- Modify: `src/main/core/git/worktree.ts` (create + guard sites)
- Modify: `src/main/core/workspaces/worktree-cleanup.ts` (boot-sweep log)
- Modify: `src/main/core/workspaces/launcher.ts` + `src/main/core/swarms/factory-spawn.ts` (guard-refused catch branch)

### Task C5: log the guard decision state in `WorktreePool.create`

- [ ] **Step 1:** In `worktree.ts`, surface the `count`/`cap` from `assertUnderCap` and `free`/`floor` from `assertAboveDiskFloor` as locals and `console.info` before proceeding:

```typescript
console.info('[worktree] create ws=%s repo=%s count=%d cap=%d freeGiB=%.2f floorGiB=%.2f',
  workspaceId ?? '?', repoHash, count, maxWorktreesPerRepo, free / GiB, minFreeDiskBytes / GiB);
```

- [ ] **Step 2:** Add a unit test (`worktree.test.ts`) spying `console.info` asserting one line is emitted on a successful create (mock `git-ops`, `fs.promises.statfs`/`readdir` per the existing pattern). Run + commit:

Run: `npx vitest run src/main/core/git/worktree.test.ts && npx tsc -b`

```bash
git add src/main/core/git/worktree.ts src/main/core/git/worktree.test.ts
git commit -m "feat(obs): log worktree-create decision state (count/cap/free/floor)"
```

### Task C6: discriminate + log + notify on `WorktreeDiskGuardError`

- [ ] **Step 1:** In both catch sites (`launcher.ts` generic catch ~652, `factory-spawn.ts` materialize-error branch), add a discriminated branch BEFORE the generic error-session handling:

```typescript
if (err instanceof WorktreeDiskGuardError) {
  console.warn('[launcher] disk-guard refused spawn code=%s ws=%s: %s', err.code, wsRow.id, err.message);
  deps.notifications?.add({
    kind: 'disk-guard',
    severity: 'critical',
    title: 'Disk guard triggered',
    body: err.message,
    dedupKey: `disk-guard:${err.code}`,
    workspaceId: wsRow.id,
    payload: JSON.stringify({ code: err.code }),
  });
}
```

(Match `NotificationsManager.add`'s real field names — read `core/notifications/manager.ts` first. Keep the existing error-session creation; this is additive.)

- [ ] **Step 2:** Test (extend `launcher.test.ts`): make `worktreePool.create` throw a `WorktreeDiskGuardError`; assert `notifications.add` called once with `severity:'critical'` + `dedupKey`. Run + commit:

Run: `npx vitest run src/main/core/workspaces/launcher.test.ts src/main/core/swarms/factory-spawn.test.ts && npx tsc -b`

```bash
git add src/main/core/workspaces/launcher.ts src/main/core/swarms/factory-spawn.ts src/main/core/workspaces/*.test.ts src/main/core/swarms/*.test.ts
git commit -m "feat(obs): critical notification + log on WorktreeDiskGuardError (both spawn sites)"
```

### Task C7: always-emit boot-sweep log with free-disk baseline

- [ ] **Step 1:** In `worktree-cleanup.ts` `sweepAllReposOnBoot`, after the sweep, `statfs(worktreeBase)` once and log unconditionally (today it only logs when `removed>0||errors>0`):

```typescript
let freeGiB = NaN;
try { const s = await fs.promises.statfs(worktreeBase); freeGiB = (s.bavail * s.bsize) / GiB; } catch {}
console.info('[worktree-cleanup] boot-sweep repos=%d removed=%d kept=%d errors=%d freeGiB=%.2f',
  repos, removed, kept, errors, freeGiB);
```

- [ ] **Step 2:** Update the existing boot-sweep test to assert the line emits even on a clean (0-removed) sweep. Run + commit:

Run: `npx vitest run src/main/core/workspaces/worktree-cleanup.test.ts && npx tsc -b`

```bash
git add src/main/core/workspaces/worktree-cleanup.ts src/main/core/workspaces/worktree-cleanup.test.ts
git commit -m "feat(obs): boot-sweep always logs free-disk baseline"
```

### Task C8 (STRETCH — only if lane has time): queryable `worktree_events` table

- [ ] Add one migration (model on `jorvis_pane_events`: `id, workspace_id, event, ts, worktree_count, free_bytes, meta_json`), a raw-prepare DAO `recordWorktreeEvent(...)`, and write at create-start / removeAndPrune / guard-refused. H-7 transactional-migration discipline + MockDb test (vitest can't load better-sqlite3 — see [[reference_better_sqlite3_electron_abi]]). **Defer if it grows the packet.**

---

## Final integration gate (run in MAIN after merging all lanes)

- [ ] **Step 1: Full build + unit suite**

Run: `npm run build && npm test`
Expected: green (worktree `tsc` is laxer — main's `tsc -b` checks test files too).

- [ ] **Step 2: Full e2e**

Run: `npx playwright test tests/e2e/`
Expected: green (whole dir, not just smoke — see [[feedback_release_gate_full_e2e]]).

- [ ] **Step 3: Manual perf confirmation (optional)**

Run: `npm run test:perf` (PERF=1-gated) and compare jank/IPC-rate before/after PERF-3.

- [ ] **Step 4: Operator smoke for in-place mode** — set a workspace to in-place, launch, confirm agents spawn in the repo root with **zero** new worktree dirs; flip back to worktree, confirm isolation returns.

---

## Self-review checklist (run before handoff)

1. **Spec coverage:** PERF-3 ✅ (A1–A5), PERF-8 ✅ (B1–B2), DEV-W3b ✅ (C1–C4), observability ✅ (C5–C7, C8 stretch). PERF-1/5/6/16 intentionally excluded (already shipped — verified). ruflo-observability "metrics" reduced to logs+notification per small-packet rule; events-table is stretch.
2. **Placeholders:** none — every code step has real code; line numbers are recon-verified (may drift ±, re-grep at execution).
3. **Type consistency:** `WorktreeMode = 'worktree'|'in-place'` used identically in C1/C2/C3; `readWorktreeMode` signature must match the chosen rawDb convention (mirror `readRufloAutowrite` — confirm at C1).
4. **Sibling twins:** C2+C3 explicitly paired (both gates); C6 explicitly paired (both catch sites). [[feedback_grep_sibling_call_sites]]

## Definition of done (ROADMAP Phase 2)

`npm run test:perf` shows a measurable jank/IPC drop after PERF-3; in-place mode spawns agents in the repo root with zero worktree dirs; spawn/worktree/disk-guard events are logged + a guard hit raises a critical notification; `tsc -b` · vitest · lint · build · full `tests/e2e/` green.
