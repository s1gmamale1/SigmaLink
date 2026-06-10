# SigmaLink Dev Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A singleton "SigmaLink Dev" workspace, created/opened from the sidebar "+" menu, with NO git/worktree machinery — N plain shell terminals (`providerId: 'shell'`, stepper 1–12, default 4) cwd'd at `os.homedir()`, respawning fresh on app restart.

**Architecture:** Zero schema change. A fixed KV pointer (`workspace.devWorkspace.id`) marks the singleton; a new `openDevWorkspace()` factory inserts a forced-`plain` row at `~` with **all** open side effects skipped (no `.mcp.json`/trust/memory-seed into `~`); a new `workspaces.openDev` RPC (four mirrored registration sites); launch rides the existing `LaunchPlan` + `'shell'` provider path; a `'shell'` case in `buildResumeArgs` makes restart respawn fresh shells. Spec: `docs/superpowers/specs/2026-06-11-sigmalink-dev-workspace-design.md`.

**Tech Stack:** Electron main (better-sqlite3 via drizzle — tests MUST mock, Electron-ABI), React renderer (shadcn, jsdom vitest), existing RPC bridge.

**Verbatim-grounded:** all line numbers verified 2026-06-11 on `main` @ `41f6e53`.

---

### Task 1: Shared constants module

**Files:**
- Create: `src/shared/special-workspace.ts`
- Test: `src/shared/special-workspace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/special-workspace.test.ts
import { describe, it, expect } from 'vitest';
import {
  DEV_WORKSPACE_KV_KEY,
  DEV_WORKSPACE_NAME,
  DEV_WORKSPACE_MAX_PANES,
} from './special-workspace';

describe('special-workspace constants', () => {
  it('exposes the singleton KV pointer key', () => {
    expect(DEV_WORKSPACE_KV_KEY).toBe('workspace.devWorkspace.id');
  });
  it('exposes the display name and pane cap', () => {
    expect(DEV_WORKSPACE_NAME).toBe('SigmaLink Dev');
    expect(DEV_WORKSPACE_MAX_PANES).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/special-workspace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// src/shared/special-workspace.ts
// SigmaLink Dev (2026-06-11) — the special singleton dev workspace contract,
// shared by main + renderer (same single-source-of-truth rationale as
// shared/worktree-mode.ts: the renderer can't import main-only DB readers,
// and a hand-copied key string is a drift hazard).
//
// The KV row `workspace.devWorkspace.id → <workspaceId>` marks THE dev
// workspace: a forced-`plain` row at os.homedir() holding only plain shell
// panes. If the pointed-at row is deleted, openDevWorkspace self-heals by
// inserting a fresh row and re-pointing the KV.

export const DEV_WORKSPACE_KV_KEY = 'workspace.devWorkspace.id';
export const DEV_WORKSPACE_NAME = 'SigmaLink Dev';
export const DEV_WORKSPACE_MAX_PANES = 12;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/special-workspace.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/special-workspace.ts src/shared/special-workspace.test.ts
git commit -m "feat(dev-workspace): shared singleton KV contract"
```

---

### Task 2: `openDevWorkspace()` factory (main)

**Files:**
- Modify: `src/main/core/workspaces/factory.ts` (add import + new export; current imports at `:3-16`, `openWorkspaceNew` ends `:179`)
- Test: Create `src/main/core/workspaces/factory.dev.test.ts`

- [ ] **Step 1: Write the failing test**

Copy the entire mock preamble from `src/main/core/workspaces/factory.test.ts:10-56` VERBATIM (the `vi.mock` blocks for `node:fs`, `node:path`, `node:crypto`, `../git/git-ops`, `./mcp-autowrite`, `./mcp-trust`, `./ruflo-fallback-notice`, `../ruflo/seed-workspace-memory`, `../ruflo/verify`) **plus its fake drizzle-db harness** (the `FakeWorkspaceRow` section that follows, through its `vi.mock('../db/client', …)`). better-sqlite3 cannot load under vitest (Electron ABI) — never `new Database()`. Add one extra mock so `os.homedir()` is deterministic:

```ts
vi.mock('node:os', () => ({
  default: { homedir: vi.fn(() => '/home/testuser') },
  homedir: vi.fn(() => '/home/testuser'),
}));
```

Then the cases (adapt the fake-db accessor names to the harness you copied — it captures inserted rows and serves `select().from(workspaces)` lookups, and exposes the raw-db `prepare` mock used for the kv table):

```ts
import { openDevWorkspace } from './factory';
import { DEV_WORKSPACE_KV_KEY, DEV_WORKSPACE_NAME } from '../../../shared/special-workspace';

describe('openDevWorkspace (SigmaLink Dev singleton)', () => {
  it('first call inserts a forced-plain row at ~ and writes the KV pointer', async () => {
    // kv lookup for DEV_WORKSPACE_KV_KEY returns undefined (no pointer yet)
    const ws = await openDevWorkspace();
    expect(ws.name).toBe(DEV_WORKSPACE_NAME);
    expect(ws.rootPath).toBe('/home/testuser');
    expect(ws.repoMode).toBe('plain');
    expect(ws.repoRoot).toBeNull();
    // KV upsert ran with (DEV_WORKSPACE_KV_KEY, ws.id)
    // — assert via the raw-db prepare().run mock captured by the harness.
  });

  it('never probes git (getRepoRoot must NOT be called)', async () => {
    const { getRepoRoot } = await import('../git/git-ops');
    await openDevWorkspace();
    expect(getRepoRoot).not.toHaveBeenCalled();
  });

  it('skips ALL open side effects (no MCP autowrite / trust / memory seed)', async () => {
    const { writeWorkspaceMcpConfig } = await import('./mcp-autowrite');
    const { ensureRufloTrusted } = await import('./mcp-trust');
    const { seedWorkspaceMemory } = await import('../ruflo/seed-workspace-memory');
    await openDevWorkspace();
    expect(writeWorkspaceMcpConfig).not.toHaveBeenCalled();
    expect(ensureRufloTrusted).not.toHaveBeenCalled();
    expect(seedWorkspaceMemory).not.toHaveBeenCalled();
  });

  it('second call reuses the pointed-at row (no second insert, lastOpenedAt bumped)', async () => {
    const first = await openDevWorkspace();
    // harness: make the kv prepare().get return { value: first.id }
    const second = await openDevWorkspace();
    expect(second.id).toBe(first.id);
    // assert insert count is still 1 in the fake db
  });

  it('self-heals a dangling KV pointer (row deleted → fresh insert + repoint)', async () => {
    // harness: kv returns { value: 'gone-uuid' }; workspace select by that id returns undefined
    const ws = await openDevWorkspace();
    expect(ws.id).not.toBe('gone-uuid');
    // assert kv upsert ran again with the NEW id
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/workspaces/factory.dev.test.ts`
Expected: FAIL — `openDevWorkspace` is not exported.

- [ ] **Step 3: Implement `openDevWorkspace`**

In `factory.ts`: add `import os from 'node:os';` after the `node:fs` import (`:4`), and `import { DEV_WORKSPACE_KV_KEY, DEV_WORKSPACE_NAME } from '../../../shared/special-workspace';` with the other shared imports. Append after `openWorkspaceNew` (`:179`):

```ts
/**
 * SigmaLink Dev (2026-06-11) — open THE singleton dev workspace: a
 * forced-`plain` row rooted at os.homedir() that holds only plain shell
 * panes. Deliberately:
 *   • never calls getRepoRoot(~) — even if ~ sits inside a dotfiles repo,
 *     this workspace must never engage worktree machinery (repoMode is
 *     forced 'plain', repoRoot null, so launcher Gate A and factory-spawn
 *     Gate B both skip worktreePool.create unconditionally);
 *   • skips EVERY open side effect (MCP autowrite, ruflo trust, memory
 *     seeding, preflight) — nothing may write `.mcp.json`/`.sigmamemory`
 *     into the user's home directory.
 * Singleton: the kv row DEV_WORKSPACE_KV_KEY points at the live row; a
 * dangling pointer (row deleted) self-heals by inserting fresh + repointing.
 */
export async function openDevWorkspace(): Promise<Workspace> {
  const db = getDb();
  const raw = getRawDb();
  const now = Date.now();
  const kvRow = raw
    .prepare('SELECT value FROM kv WHERE key = ?')
    .get(DEV_WORKSPACE_KV_KEY) as { value?: string } | undefined;
  if (kvRow?.value) {
    const existing = db.select().from(workspaces).where(eq(workspaces.id, kvRow.value)).get();
    if (existing) {
      db.update(workspaces).set({ lastOpenedAt: now }).where(eq(workspaces.id, existing.id)).run();
      return rowToWorkspace({ ...existing, lastOpenedAt: now });
    }
  }
  const resultId = randomUUID();
  db.insert(workspaces)
    .values({
      id: resultId,
      name: DEV_WORKSPACE_NAME,
      rootPath: os.homedir(),
      repoRoot: null,
      repoMode: 'plain',
      createdAt: now,
      lastOpenedAt: now,
    })
    .run();
  raw
    .prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(DEV_WORKSPACE_KV_KEY, resultId);
  // Same WAL-checkpoint rationale as openWorkspaceNew (BUG-W7-006).
  try {
    raw.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    /* best-effort */
  }
  const row = db.select().from(workspaces).where(eq(workspaces.id, resultId)).get();
  return rowToWorkspace(row!);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/core/workspaces/factory.dev.test.ts src/main/core/workspaces/factory.test.ts`
Expected: PASS (new file + existing factory tests untouched).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspaces/factory.ts src/main/core/workspaces/factory.dev.test.ts
git commit -m "feat(dev-workspace): openDevWorkspace singleton factory (forced plain at ~, zero side effects)"
```

---

### Task 3: `workspaces.openDev` RPC — FOUR mirrored sites

> ⚠️ Sibling-mirror trap: `router-shape.ts` + `rpc-router.ts` + `rpc-channels.ts` `CHANNELS` + `rpc-channels.test.ts` `TYPED_ROUTER_CHANNELS`. The preload bridge (`electron/preload.ts:11` → `isAllowedChannel`, exact-match `CHANNELS.has`) hard-rejects anything missing from `CHANNELS`. All four or none.

**Files:**
- Modify: `src/shared/router-shape.ts:318-328` (workspaces block)
- Modify: `src/main/rpc-router.ts:1477-1492` (after `openNew` handler)
- Modify: `src/shared/rpc-channels.ts:78-83` (workspaces section of `CHANNELS`)
- Modify: `src/shared/rpc-channels.test.ts:108-113` (workspaces section of `TYPED_ROUTER_CHANNELS`)

- [ ] **Step 1: Add the failing test expectation**

In `rpc-channels.test.ts`, append to the workspaces section of `TYPED_ROUTER_CHANNELS` (`:108-113`):

```ts
  'workspaces.openDev',     // SigmaLink Dev — singleton plain-shell workspace at ~
```

Run: `npx vitest run src/shared/rpc-channels.test.ts`
Expected: FAIL — `'workspaces.openDev'` missing from CHANNELS allowlist.

- [ ] **Step 2: Add the channel + type + handler**

`rpc-channels.ts` (after `'workspaces.launch'`, `:83`):

```ts
  // SigmaLink Dev (2026-06-11) — open/create the singleton dev workspace.
  'workspaces.openDev',
```

`router-shape.ts` (inside the `workspaces` block, after `openNew`, `:327`):

```ts
    /** SigmaLink Dev — open (or create) the singleton plain-shell dev workspace at ~. */
    openDev: () => Promise<Workspace>;
```

`rpc-router.ts` (after the `openNew` handler closes at `:1492`; `openDevWorkspace` joins the existing `factory` import):

```ts
    // SigmaLink Dev (2026-06-11) — singleton dev workspace. No side-effect
    // deps threaded ON PURPOSE: openDevWorkspace never autowrites MCP, never
    // seeds memory, never preflights (nothing may touch ~). fsAllowedRoots
    // picks the new row up from the DB on its next rebuild, same as open/openNew.
    openDev: async () => {
      const workspace = await openDevWorkspace();
      markWorkspaceOpened(workspace.id);
      return workspace;
    },
```

- [ ] **Step 3: Verify fsAllowedRoots coverage**

Read the `fsAllowedRoots` builder at `src/main/rpc-router.ts:323-341` and confirm it derives roots from **DB workspace rows** (it does — every `rootPath`/`repoRoot` row is added). No extra wiring needed for PTY spawn-path assertions at `~`. If you find it caches without invalidation on workspace insert, mirror whatever `open`/`openNew` do to refresh it.

- [ ] **Step 4: Run the channel tests**

Run: `npx vitest run src/shared/rpc-channels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/router-shape.ts src/main/rpc-router.ts src/shared/rpc-channels.ts src/shared/rpc-channels.test.ts
git commit -m "feat(dev-workspace): workspaces.openDev RPC across all four mirror sites"
```

---

### Task 4 (drive-by bugfix, pre-authorized by plan review): un-break `workspaces.rename` / `workspaces.openNew` at the preload bridge

**Found during plan grounding:** `workspaces.rename` (called from `Sidebar.tsx:294` — inline rename) and `workspaces.openNew` are registered in `rpc-router.ts` and typed in `router-shape.ts:323,327` but **absent from `CHANNELS`** (`rpc-channels.ts:78-83`) → `isAllowedChannel` (exact-match, `rpc-channels.ts:491-493`) hard-rejects them. Sidebar rename silently fails to persist (the optimistic `RENAME_WORKSPACE` dispatch masks it until restart). The defensive test passes because its own hand-list (`TYPED_ROUTER_CHANNELS:108-113`) omits them too — quad-list drift.

**Files:**
- Modify: `src/shared/rpc-channels.ts:78-83`
- Modify: `src/shared/rpc-channels.test.ts:108-113`

- [ ] **Step 1: Add the failing test expectations** — append to `TYPED_ROUTER_CHANNELS` workspaces section:

```ts
  'workspaces.rename',      // DEV-W2 — was missing from CHANNELS; Sidebar.tsx:294 rename was bridge-rejected
  'workspaces.openNew',     // DEV-W3a — was missing from CHANNELS
```

Run: `npx vitest run src/shared/rpc-channels.test.ts` — Expected: FAIL (2 missing from CHANNELS).

- [ ] **Step 2: Add both to `CHANNELS`** (workspaces section):

```ts
  'workspaces.rename',
  'workspaces.openNew',
```

- [ ] **Step 3: Run + verify** — `npx vitest run src/shared/rpc-channels.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/rpc-channels.ts src/shared/rpc-channels.test.ts
git commit -m "fix(rpc): allowlist workspaces.rename/openNew — preload bridge was hard-rejecting sidebar rename"
```

---

### Task 5: `buildResumeArgs` shell case — fresh respawn on restart

**Files:**
- Modify: `src/main/core/pty/resume-launcher.ts:80-132` (the provider switch)
- Test: `src/main/core/pty/resume-launcher.test.ts` (exists — extend)

Context: eligibility is `status='running' OR (status='exited' AND exit_code=-1)` (`:347-348`); the boot janitor marks app-quit survivors `exited(-1)`, so dead shells are in the eligible set — only the `null` return at the `default:` case skips them (`reason: 'provider-has-no-resume-args'`, `:690-697`). Downstream, `resume.args.length === 0` ⇒ `freshFallback` (`:718`) — exactly the fresh-spawn semantics we want. A user-`exit`ed shell is `exited(0)` → ineligible → correctly stays closed.

- [ ] **Step 1: Write the failing test** — in `resume-launcher.test.ts`, alongside the existing `buildResumeArgs` cases:

```ts
it("shell → fresh respawn descriptor (empty args), never an id/continue-latest guess", () => {
  // SigmaLink Dev — plain shells have no session to resume; id-or-fresh invariant.
  expect(buildResumeArgs('shell', null)).toEqual({ args: [], mode: 'continue' });
  // Even a (bogus) stored id must not produce resume flags for a shell.
  expect(buildResumeArgs('shell', 'whatever')).toEqual({ args: [], mode: 'continue' });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/core/pty/resume-launcher.test.ts` — Expected: FAIL (`null` returned).

- [ ] **Step 3: Implement** — in the switch (`:80`), before `default:`:

```ts
    case 'shell':
      // SigmaLink Dev (2026-06-11) — a plain shell has NO session to resume:
      // ALWAYS respawn fresh ($SHELL -l at the stored cwd). Empty args ⇒ the
      // freshFallback path below; never a resume/continue flag (id-or-fresh).
      return { args: [], mode: 'continue' };
```

- [ ] **Step 4: Run the full file** — `npx vitest run src/main/core/pty/resume-launcher.test.ts` — Expected: PASS, including all pre-existing provider cases (`custom` and unknown providers still return `null` via `default:` — do NOT touch them; verify the resume loop's shell pass end-to-end if the file has integration-style cases: a shell row must now land in `resumed`, not `skipped`).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/pty/resume-launcher.ts src/main/core/pty/resume-launcher.test.ts
git commit -m "feat(dev-workspace): shell panes respawn fresh on boot resume"
```

---

### Task 6: skip per-pane MCP wiring for shell panes (nothing writes into `~`)

**Files:**
- Modify: `src/main/core/workspaces/launcher.ts:262-305` (the per-pane MCP try-block inside `executeLaunchPlan`)
- Test: `src/main/core/workspaces/launcher.test.ts` (exists — extend)

Context: the block calls `writeMcpConfigForAgent({ worktree: cwd, … })` and `ensureRufloMcpForPane({ cwd, … })` — both write config files INTO THE PANE CWD. For dev-workspace panes `cwd = ~`, so without a gate this writes `.mcp.json` into the home directory. A plain shell never consumes MCP config (no agent CLI), so gate on the provider, not the workspace.

- [ ] **Step 1: Write the failing test** — in `launcher.test.ts` (reuse its existing mocks for `writeMcpConfigForAgent` / `ensureRufloMcpForPane`; if the file doesn't already mock them, mirror how it mocks the other launcher deps):

```ts
it('shell panes skip ALL per-pane MCP wiring (no .mcp.json written into the pane cwd)', async () => {
  // plan with a single { paneIndex: 0, providerId: 'shell' } pane on a plain workspace
  // …execute…
  expect(writeMcpConfigForAgent).not.toHaveBeenCalled();
  expect(ensureRufloMcpForPane).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/core/workspaces/launcher.test.ts`

- [ ] **Step 3: Implement** — wrap the existing try-block (`:262-305`) in a provider gate:

```ts
      // SigmaLink Dev (2026-06-11) — a plain shell consumes no MCP config
      // (no agent CLI reads .mcp.json), and for the dev workspace the pane
      // cwd IS the user's home directory: writing MCP/memory config there
      // is forbidden. Gate the whole wiring block on a non-shell provider.
      if (provider.id !== 'shell') {
        try {
          // …existing block body unchanged…
        } catch {
          /* MCP wiring is non-fatal */
        }
      }
```

(Indent the existing body; do not change its contents.)

- [ ] **Step 4: Run** — `npx vitest run src/main/core/workspaces/launcher.test.ts` — Expected: PASS, existing cases green (they all launch non-shell providers; if any existing case launches shell and asserts MCP wiring, that assertion is the bug — update it citing this task).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspaces/launcher.ts src/main/core/workspaces/launcher.test.ts
git commit -m "feat(dev-workspace): shell panes skip per-pane MCP wiring (never write config into pane cwd)"
```

---

### Task 7: exclude the dev workspace from Jorvis read-roots

**Files:**
- Modify: `src/main/core/assistant/tools.ts` (`allowedReadRoots`, `:250-262` region)
- Test: the existing tools/authorization test file beside it (locate with `ls src/main/core/assistant/*.test.ts`; extend the one covering `allowedReadRoots`/read-scope)

Context: `allowedReadRoots` adds **every** workspace `rootPath` (`tools.ts:250-262`). The dev workspace's rootPath is `~` — without an exclusion, Jorvis's read scope silently widens to the entire home directory (R-1 hardening regression).

- [ ] **Step 1: Write the failing test** — in the read-scope test: seed the fake DB with a workspace row whose `rootPath` is `/home/testuser` and a kv row `workspace.devWorkspace.id → <that id>`, plus one normal workspace; assert the returned roots include the normal workspace's root and do NOT include `/home/testuser`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — in `allowedReadRoots`, before the `for (const ws of rows)` loop. `tools.ts` does NOT currently import `getRawDb` — add it to the existing `../db/client` import; import `DEV_WORKSPACE_KV_KEY` from `../../../shared/special-workspace`:

```ts
  // SigmaLink Dev (2026-06-11) — the dev workspace roots at the user's HOME
  // directory. Never let it widen Jorvis's read scope to all of ~; its panes
  // are plain shells the assistant has no business reading for.
  let devWorkspaceId: string | null = null;
  try {
    const kvRow = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(DEV_WORKSPACE_KV_KEY) as { value?: string } | undefined;
    devWorkspaceId = kvRow?.value ?? null;
  } catch {
    devWorkspaceId = null;
  }
```

and as the first line of the loop body:

```ts
      if (ws.id === devWorkspaceId) continue;
```

- [ ] **Step 4: Run the assistant test file(s)** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/assistant/tools.ts src/main/core/assistant/<test-file>
git commit -m "feat(dev-workspace): exclude dev workspace (~) from Jorvis read-roots"
```

---

### Task 8: renderer — menu item, count dialog, DEV badge, open/launch flow

**Files:**
- Create: `src/renderer/features/sidebar/DevWorkspaceDialog.tsx`
- Modify: `src/renderer/features/sidebar/WorkspacesPanel.tsx` (`pickerMenu` `:242-271`; row render `:343-475`; props interface)
- Modify: `src/renderer/features/sidebar/Sidebar.tsx` (state + handlers near `openPersistedWorkspace` `:176-210`; prop threading)
- Test: `src/renderer/features/sidebar/WorkspacesPanel.test.tsx` (exists — extend) + create `src/renderer/features/sidebar/DevWorkspaceDialog.test.tsx`

- [ ] **Step 1: Write failing WorkspacesPanel tests** (jsdom; follow the file's existing render/props helpers):

```tsx
it('pickerMenu offers a SigmaLink Dev entry that fires onOpenDev', async () => {
  // render with onOpenDev: vi.fn(); open the "+" dropdown; click "SigmaLink Dev"
  expect(onOpenDev).toHaveBeenCalledTimes(1);
});

it('renders a DEV badge and ~ subtitle only on the dev workspace row', () => {
  // render two open workspaces, devWorkspaceId = first one's id
  // assert: first row shows the "dev" badge and subtitle "~";
  //         second row shows no badge and its basename subtitle.
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/renderer/features/sidebar/WorkspacesPanel.test.tsx`

- [ ] **Step 3: Implement WorkspacesPanel changes**

Props: add `onOpenDev?: () => void;` and `devWorkspaceId?: string | null;` to the props interface.

`pickerMenu` (`:242`): after the `Open Workspace` label block, before the persisted list:

```tsx
      <DropdownMenuItem onClick={() => onOpenDev?.()}>
        <Terminal className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">SigmaLink Dev</span>
          <span className="block truncate text-xs text-muted-foreground">Plain terminals at ~</span>
        </span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
```

(`Terminal` joins the existing `lucide-react` import next to `Folder`.)

Row name block (`:442-453`): after the name span:

```tsx
              {workspace.id === devWorkspaceId ? (
                <span className="ml-1 rounded bg-primary/15 px-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                  dev
                </span>
              ) : null}
```

Subtitle (`:455-462`): replace the `basenameOf(...)` expression with:

```tsx
              {workspace.id === devWorkspaceId ? '~' : basenameOf(workspace.rootPath)}
```

- [ ] **Step 4: Implement `DevWorkspaceDialog`** (new file — stepper modeled on `AgentsStep.tsx:436-460` `CounterControls`; Dialog primitives: mirror whatever `src/renderer/components/ui/dialog.tsx` exports and how sibling features import it):

```tsx
// src/renderer/features/sidebar/DevWorkspaceDialog.tsx
// SigmaLink Dev (2026-06-11) — "how many terminals?" count picker shown the
// FIRST time the dev workspace is opened (no sessions yet). Stepper 1–12,
// default 4 (cap: DEV_WORKSPACE_MAX_PANES).
import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { DEV_WORKSPACE_MAX_PANES } from '../../../shared/special-workspace';

interface DevWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLaunch: (paneCount: number) => void;
}

export function DevWorkspaceDialog({ open, onOpenChange, onLaunch }: DevWorkspaceDialogProps) {
  const [count, setCount] = useState(4);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs" data-testid="dev-workspace-dialog">
        <DialogHeader>
          <DialogTitle>SigmaLink Dev</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-muted-foreground">Terminals</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={count <= 1}
              onClick={() => setCount((c) => Math.max(1, c - 1))}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/60 text-sm transition hover:bg-card disabled:opacity-30"
              aria-label="Decrement"
            >
              −
            </button>
            <span className="w-6 text-center font-mono text-sm tabular-nums">{count}</span>
            <button
              type="button"
              disabled={count >= DEV_WORKSPACE_MAX_PANES}
              onClick={() => setCount((c) => Math.min(DEV_WORKSPACE_MAX_PANES, c + 1))}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/60 text-sm transition hover:bg-card disabled:opacity-30"
              aria-label="Increment"
            >
              +
            </button>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onLaunch(count)}>Launch</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Test (`DevWorkspaceDialog.test.tsx`, jsdom): stepper clamps at 1 and 12; Launch fires `onLaunch(4)` by default; +/− adjust the fired value.

- [ ] **Step 5: Implement the Sidebar flow** — in `Sidebar.tsx`, near `openPersistedWorkspace` (`:176`):

```tsx
  const [devDialogOpen, setDevDialogOpen] = useState(false);
  const [devWorkspaceId, setDevWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    void rpc.kv.get(DEV_WORKSPACE_KV_KEY).then((v) => setDevWorkspaceId(v ?? null)).catch(() => undefined);
  }, []);

  // SigmaLink Dev — menu entry. Open-or-create the singleton; if it already
  // has pane rows, mirror the boot-restore path (resume → hydrate → route) so
  // dead shells respawn fresh; otherwise ask for a terminal count first.
  async function openDevWorkspaceFlow() {
    try {
      const ws = await rpc.workspaces.openDev();
      setDevWorkspaceId(ws.id);
      const sessions = await rpc.panes.listForWorkspace(ws.id);
      dispatch({ type: 'WORKSPACE_OPEN', workspace: ws });
      dispatch({ type: 'SET_WORKSPACES', workspaces: await rpc.workspaces.list() });
      if (sessions.length === 0) {
        dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: ws.id });
        setDevDialogOpen(true);
        return;
      }
      await rpc.panes.resume(ws.id).catch(() => undefined);
      const refreshed = await rpc.panes.listForWorkspace(ws.id);
      if (refreshed.length > 0) dispatch({ type: 'ADD_SESSIONS', sessions: refreshed });
      dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: ws.id });
      dispatch({ type: 'SET_ROOM', room: 'command' });
    } catch (err) {
      console.error('Failed to open SigmaLink Dev workspace:', err);
    }
  }

  async function launchDevTerminals(paneCount: number) {
    setDevDialogOpen(false);
    try {
      const ws = await rpc.workspaces.openDev(); // idempotent — returns the singleton
      const PRESET_STEPS: GridPreset[] = [1, 2, 4, 6, 8, 10, 12];
      const preset = PRESET_STEPS.find((p) => p >= paneCount) ?? 12;
      const { sessions } = await rpc.workspaces.launch({
        workspaceRoot: ws.rootPath,
        workspaceId: ws.id,
        preset,
        panes: Array.from({ length: paneCount }, (_, i) => ({
          paneIndex: i,
          providerId: 'shell',
        })),
      });
      if (sessions.length > 0) dispatch({ type: 'ADD_SESSIONS', sessions });
      dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: ws.id });
      dispatch({ type: 'SET_ROOM', room: 'command' });
    } catch (err) {
      console.error('Failed to launch SigmaLink Dev terminals:', err);
    }
  }
```

Imports: `DEV_WORKSPACE_KV_KEY` from `../../../shared/special-workspace`, `DevWorkspaceDialog` from `./DevWorkspaceDialog`, `GridPreset` type from `../../../shared/types` (mirror the file's existing shared-types import path). Verify `rpc.kv.get`'s return shape in `router-shape.ts` (string vs `{value}`) and adapt the one-liner.

Thread the props where `<WorkspacesPanel …>` is rendered: `onOpenDev={() => void openDevWorkspaceFlow()}` and `devWorkspaceId={devWorkspaceId}`; render `<DevWorkspaceDialog open={devDialogOpen} onOpenChange={setDevDialogOpen} onLaunch={(n) => void launchDevTerminals(n)} />` next to the panel.

- [ ] **Step 6: Run all renderer tests touched**

Run: `npx vitest run src/renderer/features/sidebar/`
Expected: PASS (new + all pre-existing sidebar tests).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/features/sidebar/
git commit -m "feat(dev-workspace): sidebar menu entry, count dialog, DEV badge, open/launch flow"
```

---

### Task 9: full local gate

- [ ] **Step 1: Typecheck** — `npx tsc -b` — Expected: clean. (Gate in MAIN, not a worktree — worktree tsc is laxer about test files.)
- [ ] **Step 2: Lint** — `npm run lint` — Expected: clean.
- [ ] **Step 3: Full unit suite** — `npm test` (vitest) — Expected: green. Under-load timeouts in `swarms/factory` / VoiceTab are known flakes — re-run the file in isolation before reacting.
- [ ] **Step 4: Build** — `npm run build` — Expected: clean.
- [ ] **Step 5: Do NOT run Playwright e2e locally** (it launches competing Electron windows on the operator's machine) — e2e runs in the PR's CI e2e-matrix.
- [ ] **Step 6: Commit any stragglers, push the branch, open the PR**

```bash
git push -u origin feat/dev-workspace
gh pr create --title "feat: SigmaLink Dev workspace — N plain terminals at ~ (singleton, no worktree)" --body "Spec: docs/superpowers/specs/2026-06-11-sigmalink-dev-workspace-design.md ..."
```

---

## Execution notes for the lead

- **Worktree isolation:** dispatch the executor with `isolation: "worktree"` ON THE AGENT CALL (prompt prose does not isolate). Symlink `app/node_modules` into the worktree if needed. Re-gate in MAIN before merging.
- **Sibling-mirror traps in this plan:** the RPC quad (Task 3/4); the two pane read-paths (Task 8 deliberately mirrors boot-restore Path A, NOT the Sidebar reopen Path B); `launcher.ts` Gate A vs `factory-spawn.ts` Gate B (untouched here — forced `plain` covers both, but grep both if anything drifts).
- **Manual smoke (operator):** create dev workspace with 4 terminals → shells open at `~`; quit + relaunch → shells respawn fresh; `ls ~/.mcp.json` must NOT exist (unless pre-existing); rename a NORMAL workspace and restart → name persists (Task 4 verification).
