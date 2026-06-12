# Multi-Window Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detach a workspace from the sidebar into its own OS window (VS Code/Slack-style); closing the window re-docks the workspace to the main window with its PTYs untouched.

**Architecture:** Main process becomes the single source of truth for window topology via a new `WindowRegistry` (windowId↔BrowserWindow + workspaceId→windowId ownership). Every window loads the same SPA; secondary windows receive a `workspaceScope` via preload `additionalArguments` and render a Command-Room-only shell. `pty:data`/`pty:exit`/`pty:error` are **routed** to the owning window (supersedes the PERF-11 single-target fast path); everything else stays broadcast. Detach = MOVE never mirror: the new window attaches to the still-running PTYs via the existing `pty.snapshot` + pty-data-bus first-attach path (`terminal-cache.ts` Layer-1 race-safe ordering) — **no PTY restart, no resume machinery**.

**Tech Stack:** Electron BrowserWindow, TypeScript, React reducer state, vitest (DI'd fakes — never `new Database()`, see better-sqlite3 ABI note), zod IPC schemas.

**Design source:** WISHLIST.md `[windows/UX]` entry (committed `8345402`). Phases here = design phases 1 (plumbing, dark) + 2 (detach UX). Design phase 3 (boot restore of window layout, kv `ui.windows.layout`) is a **follow-up plan**, not in scope here.

---

## Verified ground truth (all file:line checked 2026-06-12)

| Fact | Where |
|---|---|
| `mainWindow` singleton + all its uses | `electron/main.ts:32` (decl); tray nav `:80-88`, tray click `:147-155`, voice download toast `:233-241`, global-capture emit `:284-289`, `setBroadcastTarget` `:616-617`, `window:restored` `:623-629`, loadURL/loadFile `:631-635`, session-restore push `:645-658` (gated by `sessionRestoreSent` `:45`), native-rebuild `:660-679`, windowOpenHandler `:681-684`, closed handler `:686-697`, second-instance `:712-718`, activate `:796-798` |
| PERF-11 broadcast fast path | `src/main/rpc-router.ts:227-241` (`setBroadcastTarget` + `broadcast()` with `getAllWindows` fallback) |
| `pty:data` single choke point | `rpc-router.ts:483-486` — `PtyDataCoalescer` `emit: (sessionId, data) => broadcast('pty:data', …)`; `pty:exit` at `:506-510` |
| sessionId→workspaceId lookup | `agent_sessions.workspace_id`, query pattern at `rpc-router.ts:398-405` |
| Ring-buffer snapshot RPC (live attach) | `pty.snapshot` + `pty.subscribe` channels (`rpc-channels.ts:31-32`); handler returns `{ history: pty.snapshot(sessionId) }`; registry buffer at `core/pty/registry.ts:593`. Renderer first-attach: `terminal-cache.ts:337-413` (subscribe bus → `rpc.pty.snapshot` → overlap-dedup drain) |
| Workspace open-list lifecycle | `src/main/core/workspaces/lifecycle.ts` — module-local `openWorkspaceIds`, broadcasts `app:open-workspaces-changed` to ALL windows (`:34-38`), accepts FULL list from any renderer (`:71-76`) ← the multi-writer stomp risk |
| Renderer mirror (bidirectional) | `src/renderer/app/state-hooks/use-workspace-mirror.ts` — inbound `:31-55` (SYNC_OPEN_WORKSPACES), outbound `:57-71` (`eventSend('app:open-workspaces-changed', { workspaceIds })`) |
| Session restore snapshot | `src/main/core/session/session-restore.ts` — kv `app.lastSession`, `SessionSnapshotSchema` `{activeWorkspaceId, openWorkspaces:[{workspaceId, room}]}` `:36-47`; pushed once per run from `main.ts:645-658` |
| Preload bridge | `electron/preload.ts:9-54` — `invoke`/`eventOn`/`eventSend` (allowlist-guarded), `platform`, zoom; `SigmaPreloadApi = typeof api`; global typing `src/types/electron.d.ts` |
| EVENTS allowlist | `src/shared/rpc-channels.ts:376-503` (`EVENTS` set), `isAllowedEvent` `:509` |
| Channels QUAD for new RPCs | `rpc-channels.ts:10` (`CHANNELS`, workspaces block `:82-93`) + `rpc-channels.test.ts:67` (`TYPED_ROUTER_CHANNELS` hand-list, workspaces `:110-117`) + `src/shared/router-shape.ts` (workspaces at `:327`) + handler in `rpc-router.ts` |
| Reducer actions | `state.types.ts:173-176`: `WORKSPACE_OPEN {workspace}`, `WORKSPACE_CLOSE {workspaceId}`, `SYNC_OPEN_WORKSPACES {workspaceIds, workspaces}`; reducer cases `state.reducer.ts:274,291,357` |
| Secondary-window precedent | `src/main/core/browser/manager.ts:395-460` (BSP-B2 `detachToWindow`: secondary BrowserWindow, reattach-on-close, focused-window stomp guard `:62-85`) |
| Sidebar workspace rows | `src/renderer/features/sidebar/Sidebar.tsx:379` (`onClose` → `WORKSPACE_CLOSE`) — detach affordance goes beside it |
| App room routing | `src/renderer/app/App.tsx:83-106` (`RoomSwitch`, CommandRoom eager) |

**Invariant (non-negotiable):** a workspace and its xterm instances are attached to exactly ONE window. Two xterms on one PTY fight over SIGWINCH/cols and double-echo input. All ownership transitions are sequenced in MAIN (registry), never via racing renderer events.

**Repo test rules:** vitest with DI'd fakes; never `new Database()` (Electron-ABI better-sqlite3); any new `eventOn` subscriber needs the EVENTS-allowlist guard test; new RPC channels must update the QUAD or the bridge silently rejects them (DEV-W2 precedent). Run the FULL `vitest run` before review (mock-breakage class). NO local Playwright e2e — defer to CI e2e-matrix.

---

## File structure (created / modified)

```
src/main/core/windows/registry.ts          NEW  — WindowRegistry: windows, ownership, session→workspace cache, routed sends, scope broadcast
src/main/core/windows/registry.test.ts     NEW  — pure DI tests (fake WindowHandle)
src/main/rpc-router.ts                     MOD  — broadcast() routes via registry; windows.* handlers; deps export
src/main/core/workspaces/lifecycle.ts      MOD  — per-window open lists, union; outbound payload {windowId, workspaceIds}
src/main/core/rpc/schemas.ts               MOD  — outbound schema gains optional windowId
electron/main.ts                           MOD  — createWindow(opts), secondary factory, registry wiring, re-dock on closed
electron/preload.ts                        MOD  — windowContext from process.argv
src/shared/rpc-channels.ts                 MOD  — +windows.detachWorkspace, +windows.redockWorkspace, +app:window-scope-changed event
src/shared/rpc-channels.test.ts            MOD  — QUAD test list + EVENTS guard
src/shared/router-shape.ts                 MOD  — windows: {...} section
src/renderer/lib/window-context.ts         NEW  — typed accessors for sigma.windowContext
src/renderer/app/state-hooks/use-workspace-mirror.ts  MOD — scope-aware inbound filter + windowId-tagged outbound + module-scope scopes cache
src/renderer/app/state-hooks/use-window-scope-boot.ts NEW — scoped-window boot (WORKSPACE_OPEN + hydrate panes)
src/renderer/app/state-hooks/use-session-restore.ts   MOD — early-return when scoped
src/renderer/app/App.tsx                   MOD  — scoped shell branch (same provider tree, body switch)
src/renderer/features/sidebar/Sidebar.tsx  MOD  — "Open in New Window" row action (main window only)
```

Rationale: ownership/routing logic is ONE new main-side module with a pure-DI seam (repo pattern: `lifecycle.ts`, `session-restore.ts`). The scoped renderer shell is a branch INSIDE `App.tsx` on the same provider tree — deliberately NOT a second root file, to avoid the App-wiring mirror-drift class.

---

## Phase A — de-singleton plumbing (ships dark; zero UX change)

### Task A1: WindowRegistry module

**Files:**
- Create: `src/main/core/windows/registry.ts`
- Test: `src/main/core/windows/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/core/windows/registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  WindowRegistry,
  type WindowHandle,
} from './registry';

function fakeWindow(id: number): WindowHandle & { sent: Array<{ event: string; payload: unknown }>; destroyed: boolean } {
  const sent: Array<{ event: string; payload: unknown }> = [];
  return {
    id,
    sent,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    send(event: string, payload: unknown) { sent.push({ event, payload }); },
    focus() { /* recorded only when a test needs it */ },
  };
}

describe('WindowRegistry', () => {
  let reg: WindowRegistry;
  let main: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    reg = new WindowRegistry({ lookupSessionWorkspace: () => null });
    main = fakeWindow(1);
    reg.registerWindow(main, { isMain: true });
  });

  it('routes sendToAll to every live window and skips destroyed ones', () => {
    const w2 = fakeWindow(2);
    reg.registerWindow(w2, { isMain: false });
    w2.destroyed = true;
    reg.sendToAll('app:navigate', { pane: 'settings' });
    expect(main.sent).toHaveLength(1);
    expect(w2.sent).toHaveLength(0);
  });

  it('assigns workspace ownership and routes sendToWorkspaceOwner', () => {
    const w2 = fakeWindow(2);
    reg.registerWindow(w2, { isMain: false });
    reg.assignWorkspace('ws-a', 2);
    reg.sendToWorkspaceOwner('ws-a', 'x:ev', { v: 1 });
    expect(w2.sent).toEqual([{ event: 'x:ev', payload: { v: 1 } }]);
    expect(main.sent).toHaveLength(0);
  });

  it('falls back to sendToAll for an unowned workspace', () => {
    reg.sendToWorkspaceOwner('ws-unknown', 'x:ev', {});
    expect(main.sent).toHaveLength(1);
  });

  it('resolves session owner through the cache, then the injected lookup', () => {
    const lookups: string[] = [];
    reg = new WindowRegistry({
      lookupSessionWorkspace: (sid) => { lookups.push(sid); return 'ws-a'; },
    });
    reg.registerWindow(main, { isMain: true });
    const w2 = fakeWindow(2);
    reg.registerWindow(w2, { isMain: false });
    reg.assignWorkspace('ws-a', 2);

    reg.sendToSessionOwner('sess-1', 'pty:data', { sessionId: 'sess-1', data: 'x' });
    reg.sendToSessionOwner('sess-1', 'pty:data', { sessionId: 'sess-1', data: 'y' });
    expect(w2.sent).toHaveLength(2);
    expect(lookups).toEqual(['sess-1']); // second send hit the cache
  });

  it('falls back to sendToAll when the session lookup returns null', () => {
    reg.sendToSessionOwner('sess-ghost', 'pty:data', {});
    expect(main.sent).toHaveLength(1);
  });

  it('unregisterWindow returns the workspaces it owned and re-docks them to main', () => {
    const w2 = fakeWindow(2);
    reg.registerWindow(w2, { isMain: false });
    reg.assignWorkspace('ws-a', 2);
    reg.assignWorkspace('ws-b', 2);
    const released = reg.unregisterWindow(2);
    expect(released.sort()).toEqual(['ws-a', 'ws-b']);
    // re-assignment is the CALLER's job (main.ts closed handler) — registry only releases
    expect(reg.ownerWindowIdFor('ws-a')).toBeNull();
  });

  it('broadcastScopes sends one scope snapshot to every window', () => {
    const w2 = fakeWindow(2);
    reg.registerWindow(w2, { isMain: false });
    reg.assignWorkspace('ws-a', 2);
    reg.broadcastScopes();
    const payload = main.sent[0];
    expect(payload.event).toBe('app:window-scope-changed');
    expect(payload.payload).toEqual({
      scopes: [
        { windowId: 1, isMain: true, workspaceIds: [] },
        { windowId: 2, isMain: false, workspaceIds: ['ws-a'] },
      ],
    });
    expect(w2.sent[0]).toEqual(payload);
  });

  it('forgetSession evicts the routing cache', () => {
    reg = new WindowRegistry({ lookupSessionWorkspace: () => 'ws-a' });
    reg.registerWindow(main, { isMain: true });
    reg.sendToSessionOwner('s1', 'pty:data', {});
    reg.forgetSession('s1');
    // next send re-resolves (observable only via lookup count — covered above);
    // here we just assert it doesn't throw and still delivers
    reg.sendToSessionOwner('s1', 'pty:data', {});
    expect(main.sent).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/core/windows/registry.test.ts`
Expected: FAIL — `Cannot find module './registry'`

- [ ] **Step 3: Implement the registry**

```ts
// src/main/core/windows/registry.ts
//
// Multi-window topology source of truth (design: WISHLIST [windows/UX], 2026-06-12).
// Owns: windowId → handle, workspaceId → windowId ownership, and the
// sessionId → workspaceId routing cache used to deliver pty:data only to the
// window that owns the session's workspace. Pure-DI: Electron BrowserWindows
// are adapted to WindowHandle at the main.ts boundary so tests inject fakes.

import { isAllowedEvent } from '../../../shared/rpc-channels';

export interface WindowHandle {
  readonly id: number;
  isDestroyed(): boolean;
  send(event: string, payload: unknown): void;
  focus(): void;
}

export interface WindowRegistryDeps {
  /** Resolve a session's workspace (agent_sessions.workspace_id). Null = unknown. */
  lookupSessionWorkspace: (sessionId: string) => string | null;
}

export interface WindowScope {
  windowId: number;
  isMain: boolean;
  workspaceIds: string[];
}

const SCOPE_EVENT = 'app:window-scope-changed';

export class WindowRegistry {
  private readonly windows = new Map<number, { handle: WindowHandle; isMain: boolean }>();
  private readonly ownership = new Map<string, number>(); // workspaceId → windowId
  private readonly sessionWorkspace = new Map<string, string>(); // sessionId → workspaceId
  private readonly deps: WindowRegistryDeps;

  constructor(deps: WindowRegistryDeps) {
    this.deps = deps;
  }

  registerWindow(handle: WindowHandle, opts: { isMain: boolean }): void {
    this.windows.set(handle.id, { handle, isMain: opts.isMain });
  }

  /** Drop a window; returns the workspaceIds it owned (caller re-docks them). */
  unregisterWindow(windowId: number): string[] {
    this.windows.delete(windowId);
    const released: string[] = [];
    for (const [wsId, ownerId] of this.ownership) {
      if (ownerId === windowId) released.push(wsId);
    }
    for (const wsId of released) this.ownership.delete(wsId);
    return released;
  }

  assignWorkspace(workspaceId: string, windowId: number): void {
    this.ownership.set(workspaceId, windowId);
  }

  releaseWorkspace(workspaceId: string): void {
    this.ownership.delete(workspaceId);
  }

  ownerWindowIdFor(workspaceId: string): number | null {
    const id = this.ownership.get(workspaceId);
    return id != null && this.windows.has(id) ? id : null;
  }

  mainWindow(): WindowHandle | null {
    for (const { handle, isMain } of this.windows.values()) {
      if (isMain && !handle.isDestroyed()) return handle;
    }
    return null;
  }

  windowById(windowId: number): WindowHandle | null {
    const rec = this.windows.get(windowId);
    return rec && !rec.handle.isDestroyed() ? rec.handle : null;
  }

  sendToAll(event: string, payload: unknown): void {
    for (const { handle } of this.windows.values()) {
      if (!handle.isDestroyed()) handle.send(event, payload);
    }
  }

  /** Routed delivery: owner window, falling back to all (unowned/destroyed). */
  sendToWorkspaceOwner(workspaceId: string, event: string, payload: unknown): void {
    const ownerId = this.ownerWindowIdFor(workspaceId);
    const owner = ownerId != null ? this.windowById(ownerId) : null;
    if (owner) {
      owner.send(event, payload);
      return;
    }
    this.sendToAll(event, payload);
  }

  /** pty:data/pty:exit fast path: cache → DB lookup → fallback broadcast. */
  sendToSessionOwner(sessionId: string, event: string, payload: unknown): void {
    let wsId = this.sessionWorkspace.get(sessionId) ?? null;
    if (wsId == null) {
      wsId = this.deps.lookupSessionWorkspace(sessionId);
      if (wsId != null) this.sessionWorkspace.set(sessionId, wsId);
    }
    if (wsId == null) {
      this.sendToAll(event, payload);
      return;
    }
    this.sendToWorkspaceOwner(wsId, event, payload);
  }

  forgetSession(sessionId: string): void {
    this.sessionWorkspace.delete(sessionId);
  }

  scopes(): WindowScope[] {
    const byWindow = new Map<number, string[]>();
    for (const id of this.windows.keys()) byWindow.set(id, []);
    for (const [wsId, windowId] of this.ownership) {
      byWindow.get(windowId)?.push(wsId);
    }
    return [...this.windows.entries()].map(([windowId, rec]) => ({
      windowId,
      isMain: rec.isMain,
      workspaceIds: byWindow.get(windowId) ?? [],
    }));
  }

  /** Push the full scope table to every window (renderers filter locally). */
  broadcastScopes(): void {
    if (!isAllowedEvent(SCOPE_EVENT)) return;
    this.sendToAll(SCOPE_EVENT, { scopes: this.scopes() });
  }
}

// Process-wide singleton, mirroring lifecycle.ts's module pattern. main.ts
// seeds the real lookup at boot; the default null-lookup keeps unit tests
// of OTHER modules (which import this transitively) inert.
let instance: WindowRegistry | null = null;

export function initWindowRegistry(deps: WindowRegistryDeps): WindowRegistry {
  instance = new WindowRegistry(deps);
  return instance;
}

export function getWindowRegistry(): WindowRegistry {
  if (!instance) instance = new WindowRegistry({ lookupSessionWorkspace: () => null });
  return instance;
}

export function __resetWindowRegistryForTests(): void {
  instance = null;
}
```

Note: `app:window-scope-changed` is not in the EVENTS allowlist until Task A4 — the `isAllowedEvent` gate makes `broadcastScopes()` a silent no-op until then, which is exactly the dark-ship behavior we want. The A1 test above will fail on the `broadcastScopes` case until A4's allowlist entry lands — implement A4's `rpc-channels.ts` line in the SAME commit if running tests strictly in order, or mark that single test `it.todo` until A4 (prefer the former: one-line allowlist addition is part of this task's green state).

- [ ] **Step 4: Add the EVENTS allowlist entry (required for the broadcastScopes test)**

In `src/shared/rpc-channels.ts`, inside the `EVENTS` set (after `'window:restored',` at `:502`):

```ts
  // Multi-window (2026-06-12) — full scope table {scopes:[{windowId,isMain,workspaceIds}]}
  // pushed by WindowRegistry.broadcastScopes() on every ownership change.
  'app:window-scope-changed',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/core/windows/registry.test.ts src/shared/rpc-channels.test.ts`
Expected: registry tests PASS; rpc-channels tests PASS (EVENTS guard tests in that file assert membership patterns — if one enumerates EVENTS exhaustively, add the new event there too; check `rpc-channels.test.ts` for an EVENTS list).

- [ ] **Step 6: Commit**

```bash
git add src/main/core/windows/ src/shared/rpc-channels.ts src/shared/rpc-channels.test.ts
git commit -m "feat(windows): WindowRegistry — window topology + workspace ownership + routed sends (multi-window A1)"
```

---

### Task A2: route rpc-router broadcasts through the registry

**Files:**
- Modify: `src/main/rpc-router.ts:216-241` (broadcast helper), `:483-486` (coalescer emit), `:506-510` (pty:exit)
- Modify: `electron/main.ts:616-617`, `:695` (setBroadcastTarget call sites)
- Test: extend `src/main/core/windows/registry.test.ts` only if new logic appears (routing itself is A1-tested; this task is wiring)

- [ ] **Step 1: Replace the PERF-11 fast path in `rpc-router.ts`**

Replace the block at `:225-241` (`broadcastTarget` + `setBroadcastTarget` + `broadcast`) with:

```ts
import { getWindowRegistry, initWindowRegistry } from './core/windows/registry';

/** Events whose payload carries a sessionId and should only reach the
 *  window owning that session's workspace. Everything else broadcasts. */
const SESSION_ROUTED_EVENTS = new Set(['pty:data', 'pty:exit', 'pty:error', 'pty:link-detected']);

function broadcast(event: string, payload: unknown) {
  const registry = getWindowRegistry();
  if (SESSION_ROUTED_EVENTS.has(event)) {
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId === 'string') {
      registry.sendToSessionOwner(sessionId, event, payload);
      return;
    }
  }
  registry.sendToAll(event, payload);
}
```

Inside `registerRouter()` (near the top, after the DB is available), seed the real lookup:

```ts
  initWindowRegistry({
    lookupSessionWorkspace: (sessionId) => {
      try {
        const row = getRawDb()
          .prepare('SELECT workspace_id FROM agent_sessions WHERE id = ?')
          .get(sessionId) as { workspace_id?: string } | undefined;
        return row?.workspace_id ?? null;
      } catch {
        return null;
      }
    },
  });
```

Keep exporting a deprecated shim so `main.ts` compiles until Step 2 (then delete both ends):

```ts
/** @deprecated multi-window A2 — registry owns delivery; kept only until main.ts migrates. */
export function setBroadcastTarget(_win: unknown): void { /* no-op */ }
```

- [ ] **Step 2: Migrate `main.ts` to the registry**

In `electron/main.ts` `createWindow()`:
- Delete `setBroadcastTarget(mainWindow);` (`:616-617`) and the `setBroadcastTarget(null)` in the closed handler (`:695`).
- After constructing the window, register it (adapter inline):

```ts
import { getWindowRegistry } from '../src/main/core/windows/registry';

function asHandle(win: BrowserWindow): import('../src/main/core/windows/registry').WindowHandle {
  return {
    id: win.id,
    isDestroyed: () => win.isDestroyed(),
    send: (event, payload) => {
      if (!win.isDestroyed()) win.webContents.send(event, payload);
    },
    focus: () => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  };
}

// inside createWindow(), after `new BrowserWindow({...})`:
getWindowRegistry().registerWindow(asHandle(mainWindow), { isMain: true });

// inside the 'closed' handler, before `mainWindow = null`:
getWindowRegistry().unregisterWindow(winId); // capture `const winId = mainWindow.id` at create time
```

Then remove the deprecated `setBroadcastTarget` export from `rpc-router.ts` and its import in `main.ts:12`.

- [ ] **Step 3: Evict the session-routing cache on exit**

In `rpc-router.ts` at the PtyRegistry exit callback (`:506-510`), after `broadcast('pty:exit', …)`:

```ts
      getWindowRegistry().forgetSession(sessionId);
```

(Eviction AFTER the broadcast so the exit event itself still routes to the owner.)

- [ ] **Step 4: Full gate**

Run: `npx tsc -b && npx vitest run`
Expected: clean compile; FULL suite green (the broadcast change touches the hottest path — the full suite is the mock-breakage catch).

- [ ] **Step 5: Commit**

```bash
git add src/main/rpc-router.ts electron/main.ts
git commit -m "feat(windows): route pty events to owning window via WindowRegistry; retire PERF-11 single-target (multi-window A2)"
```

---

### Task A3: window identity through preload

**Files:**
- Modify: `electron/preload.ts` (add `windowContext`)
- Modify: `electron/main.ts` `createWindow()` (additionalArguments)
- Create: `src/renderer/lib/window-context.ts`
- Test: `src/renderer/lib/window-context.test.ts`

- [ ] **Step 1: Write the failing renderer test**

```ts
// src/renderer/lib/window-context.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('window-context', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    // @ts-expect-error test cleanup
    delete (globalThis as { window?: unknown }).window?.sigma;
  });

  it('reads scope + main flag from the preload bridge', async () => {
    (globalThis as unknown as { window: { sigma: unknown } }).window.sigma = {
      windowContext: { windowId: 7, isMain: false, workspaceScope: 'ws-a' },
    };
    const { getWindowContext, isMainWindow, getWorkspaceScope } = await import('./window-context');
    expect(getWindowContext()).toEqual({ windowId: 7, isMain: false, workspaceScope: 'ws-a' });
    expect(isMainWindow()).toBe(false);
    expect(getWorkspaceScope()).toBe('ws-a');
  });

  it('defaults to main-window semantics when the bridge predates multi-window', async () => {
    (globalThis as unknown as { window: { sigma: unknown } }).window.sigma = {};
    const { isMainWindow, getWorkspaceScope } = await import('./window-context');
    expect(isMainWindow()).toBe(true);
    expect(getWorkspaceScope()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/lib/window-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement preload + main args + renderer lib**

`electron/preload.ts` — parse argv once at top, add to `api`:

```ts
// Multi-window (2026-06-12) — window identity injected by main via
// webPreferences.additionalArguments. Absent args = legacy single window.
function argValue(prefix: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
const windowContext = {
  windowId: (() => { const v = argValue('--sigma-window-id='); return v ? Number(v) : null; })(),
  isMain: argValue('--sigma-window-main=') !== '0',
  workspaceScope: argValue('--sigma-workspace-scope=') || null,
};
```

…and inside the `api` object literal: `windowContext,`

`electron/main.ts` `createWindow()` webPreferences gains (main window):

```ts
      additionalArguments: [
        '--sigma-window-main=1',
        // window id is only known post-construction; main windows don't need it —
        // secondary windows get theirs in Task B1's factory.
      ],
```

`src/renderer/lib/window-context.ts`:

```ts
// Multi-window (2026-06-12) — typed access to the preload-injected window
// identity. Missing bridge fields (older preload, unit tests) degrade to
// main-window semantics so every existing surface behaves exactly as before.

export interface WindowContext {
  windowId: number | null;
  isMain: boolean;
  workspaceScope: string | null;
}

export function getWindowContext(): WindowContext {
  const raw = (window as unknown as { sigma?: { windowContext?: Partial<WindowContext> } }).sigma?.windowContext;
  return {
    windowId: typeof raw?.windowId === 'number' ? raw.windowId : null,
    isMain: raw?.isMain !== false,
    workspaceScope: typeof raw?.workspaceScope === 'string' && raw.workspaceScope ? raw.workspaceScope : null,
  };
}

export function isMainWindow(): boolean {
  return getWindowContext().isMain;
}

export function getWorkspaceScope(): string | null {
  return getWindowContext().workspaceScope;
}
```

- [ ] **Step 4: Run tests, then full gate**

Run: `npx vitest run src/renderer/lib/window-context.test.ts && npx tsc -b`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add electron/preload.ts electron/main.ts src/renderer/lib/window-context.ts src/renderer/lib/window-context.test.ts
git commit -m "feat(windows): window identity via preload additionalArguments + renderer accessor (multi-window A3)"
```

---

### Task A4: detached-aware open-workspace union in lifecycle.ts

**Files:**
- Modify: `src/main/core/workspaces/lifecycle.ts`
- Test: extend the existing lifecycle tests (`git grep -l "replaceOpenWorkspaces" src/main/core/workspaces` to find them; likely `__tests__/`)

The stomp fix, minimal form. Today ANY renderer echo REPLACES the global list (`lifecycle.ts:71-76`). With multi-window: the MAIN window stays the only renderer that echoes (scoped windows are gated off in B3), so the replace semantics stay — but the main window's echo describes only the workspaces IT shows, which post-detach EXCLUDES detached ones. The global union must still include them or the scoped window's workspace evaporates from `app:open-workspaces-changed`. Fix: union = renderer-echoed list ∪ detached set, with the detached set injected from the WindowRegistry (main-side truth, no renderer protocol change at all — the event payload stays `{workspaceIds}`).

- [ ] **Step 1: Write the failing tests** (extend the existing lifecycle test file)

```ts
import {
  replaceOpenWorkspaces,
  getOpenWorkspaceIds,
  setDetachedWorkspaceIdsProvider,
  __resetWorkspaceLifecycleForTests,
} from '../lifecycle';

describe('detached-aware union (multi-window A4)', () => {
  beforeEach(() => __resetWorkspaceLifecycleForTests());

  it('keeps detached workspaces in the union when the main renderer echoes without them', () => {
    setDetachedWorkspaceIdsProvider(() => ['b']);
    replaceOpenWorkspaces(['a']); // main window dropped 'b' after detach
    expect(getOpenWorkspaceIds()).toEqual(['a', 'b']);
  });

  it('does not duplicate a workspace both echoed and detached', () => {
    setDetachedWorkspaceIdsProvider(() => ['a']);
    replaceOpenWorkspaces(['a', 'c']);
    expect(getOpenWorkspaceIds()).toEqual(['a', 'c']);
  });

  it('without a provider, behaves exactly as before (legacy single-window)', () => {
    replaceOpenWorkspaces(['a', 'b']);
    expect(getOpenWorkspaceIds()).toEqual(['a', 'b']);
  });

  it('a workspace leaving the detached set stays open only if echoed or re-marked', () => {
    let detached: string[] = ['b'];
    setDetachedWorkspaceIdsProvider(() => detached);
    replaceOpenWorkspaces(['a']);
    expect(getOpenWorkspaceIds()).toEqual(['a', 'b']);
    detached = []; // redock happened registry-side…
    replaceOpenWorkspaces(['a', 'b']); // …and the redock path re-marks it (B2/B1 call markWorkspaceOpened)
    expect(getOpenWorkspaceIds()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/core/workspaces` — new cases FAIL (missing export).

- [ ] **Step 3: Implement**

In `lifecycle.ts` — keep `openWorkspaceIds` as the RENDERER-ECHOED list; derive the public union:

```ts
// Multi-window A4 — detached workspaces live in secondary windows; the main
// renderer's echo legitimately omits them. The registry is the source of
// truth for "detached"; inject as a provider to keep this module pure.
let detachedIdsProvider: (() => string[]) | null = null;

export function setDetachedWorkspaceIdsProvider(provider: (() => string[]) | null): void {
  detachedIdsProvider = provider;
}

function unionWithDetached(ids: string[]): string[] {
  const detached = detachedIdsProvider?.() ?? [];
  if (detached.length === 0) return [...ids];
  const seen = new Set(ids);
  return [...ids, ...detached.filter((id) => id && !seen.has(id))];
}

export function getOpenWorkspaceIds(): string[] {
  return unionWithDetached(openWorkspaceIds);
}
```

…and make `emitOpenWorkspacesChanged()` broadcast `unionWithDetached(openWorkspaceIds)` instead of the raw list (`:42-44`). `replaceOpenWorkspaces`'s no-change short-circuit (`:54`) keeps comparing the RAW echoed list — a registry-side detach/redock re-broadcast is triggered explicitly by the callers below, not by diffing here. `__resetWorkspaceLifecycleForTests` also nulls the provider.

Wire the provider at boot — in `rpc-router.ts` `registerRouter()` right after `initWindowRegistry(...)` (Task A2):

```ts
  setDetachedWorkspaceIdsProvider(() => {
    const reg = getWindowRegistry();
    const mainId = reg.mainWindow()?.id ?? null;
    return reg
      .scopes()
      .filter((s) => !s.isMain && s.windowId !== mainId)
      .flatMap((s) => s.workspaceIds);
  });
```

Re-dock continuity rule (consumed by B1/B2): any path that moves a workspace BACK to the main window must call `markWorkspaceOpened(workspaceId)` (`lifecycle.ts:60`) so the echoed list regains it before the registry stops reporting it detached — otherwise the union transiently drops it and the main window's SYNC never re-adds it.

- [ ] **Step 4: Run the workspaces suite + full gate**

Run: `npx vitest run src/main/core/workspaces && npx tsc -b && npx vitest run`
Expected: all green — without a provider every existing path is byte-identical.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspaces/ src/main/rpc-router.ts
git commit -m "feat(windows): open-workspace union includes registry-detached workspaces (multi-window A4)"
```

**Phase A exit criteria:** `npx tsc -b && npx vitest run && npm run build` all green; app behaves byte-identically (single window, all events broadcast or trivially routed to it). Ships dark on its own PR.

---

## Phase B — detach / re-dock UX

### Task B1: secondary-window factory in main.ts

**Files:**
- Modify: `electron/main.ts` (extract window construction; add `createSecondaryWindow`)
- No new unit tests (Electron window construction — covered by CI e2e + the B2 handler tests via injected factory)

- [ ] **Step 1: Parameterize window construction**

Refactor `createWindow()` so the `BrowserWindow` options + load logic live in a helper both paths share; `createSecondaryWindow` differs ONLY in: smaller default size (1100×800), `additionalArguments` carrying identity/scope, title, no session-restore push, no native-rebuild recheck, and a closed-handler that re-docks:

```ts
function buildWindow(opts: {
  width: number; height: number; title: string;
  additionalArguments: string[];
}): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    minWidth: 1024,
    minHeight: 660,
    title: opts.title,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 19, y: 9 } } : {}),
    backgroundColor: '#0a0c12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: opts.additionalArguments,
    },
  });
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(path.join(__dirname, '../dist/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Pane-refit: every window needs the restore/show → 'window:restored' signal.
  const emitRestored = () => {
    if (!win.isDestroyed()) win.webContents.send('window:restored', {});
  };
  win.on('restore', emitRestored);
  win.on('show', emitRestored);
  win.once('ready-to-show', () => win.show());
  return win;
}

export function createSecondaryWindow(workspaceId: string, workspaceName: string): BrowserWindow {
  const win = buildWindow({
    width: 1100,
    height: 800,
    title: `${workspaceName} — SigmaLink`,
    additionalArguments: [
      '--sigma-window-main=0',
      `--sigma-workspace-scope=${workspaceId}`,
      // window-id arg can't carry win.id (not known pre-construction); the
      // renderer's outbound mirror gets the id from the scope event instead —
      // see use-workspace-mirror (Task B3). Keep a monotonic fallback:
      `--sigma-window-id=${nextSecondaryWindowSeq++}`,
    ],
  });
  const registry = getWindowRegistry();
  registry.registerWindow(asHandle(win), { isMain: false });
  registry.assignWorkspace(workspaceId, win.id);
  registry.broadcastScopes();

  win.on('closed', () => {
    // Re-dock everything this window owned to the main window. PTYs untouched.
    // ORDER MATTERS (A4 continuity rule): seed the echoed open-list FIRST so
    // the union never transiently drops the workspace, THEN release ownership.
    const released = registry.unregisterWindow(win.id);
    const main = registry.mainWindow();
    if (main) {
      for (const wsId of released) {
        registry.assignWorkspace(wsId, main.id);
        markWorkspaceOpened(wsId); // lifecycle.ts:60 — re-enters the echoed list + emits
      }
    }
    registry.broadcastScopes();
  });
  return win;
}
let nextSecondaryWindowSeq = 1000; // diagnostic disambiguation only — never used for ownership
```

CAREFUL — the argv `--sigma-window-id` and Electron's `win.id` differ; the renderer must NOT use the argv id for ownership math. Ownership truth always flows main→renderer via `app:window-scope-changed` + each renderer matching on `workspaceScope`/`isMain`, never on raw ids. (`markWorkspaceOpened` is imported from `../src/main/core/workspaces/lifecycle` — main.ts gains that import.)

Wire `createWindow()` (the main window) through `buildWindow` too, preserving its extra blocks verbatim: session-restore push (`:645-658`), native-rebuild recheck (`:660-679`), closed → `browserRegistry.teardownAll()` + `registry.unregisterWindow` + `mainWindow = null`.

ALSO: when the MAIN window closes while secondary windows live (macOS), `window-all-closed` won't fire. Decide explicitly: closing the main window closes all secondary windows too (simplest; matches "main owns the app"). In main window's closed handler:

```ts
    for (const other of BrowserWindow.getAllWindows()) {
      if (!other.isDestroyed()) other.close();
    }
```

- [ ] **Step 2: Gate**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: green; behavior unchanged (nothing calls `createSecondaryWindow` yet).

- [ ] **Step 3: Commit**

```bash
git add electron/main.ts
git commit -m "feat(windows): secondary-window factory + re-dock-on-close + main-closes-all (multi-window B1)"
```

---

### Task B2: `windows.detachWorkspace` / `windows.redockWorkspace` RPCs (the QUAD)

**Files:**
- Modify: `src/shared/rpc-channels.ts` (CHANNELS, after `'workspaces.openNew',` `:93`)
- Modify: `src/shared/rpc-channels.test.ts` (TYPED_ROUTER_CHANNELS list, after `:117`)
- Modify: `src/shared/router-shape.ts` (new `windows:` section near `workspaces:` `:327`)
- Modify: `src/main/rpc-router.ts` (handlers; factory injected from main.ts)
- Modify: `electron/main.ts` (inject factory)
- Test: `src/main/core/windows/detach-handlers.test.ts` (NEW — pure handler logic with fake factory/registry)

The QUAD is mandatory: a channel registered in the router but absent from `CHANNELS` is silently bridge-rejected (DEV-W2 precedent, `rpc-channels.test.ts:116-117` comments).

- [ ] **Step 1: Write the failing handler tests**

Extract the handler logic into a testable function first (file below), then test it:

```ts
// src/main/core/windows/detach-handlers.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowRegistry, type WindowHandle } from './registry';
import { buildDetachWorkspace, buildRedockWorkspace } from './detach-handlers';

function fakeWindow(id: number) {
  return {
    id,
    destroyed: false,
    focused: 0,
    sent: [] as Array<{ event: string; payload: unknown }>,
    isDestroyed() { return this.destroyed; },
    send(event: string, payload: unknown) { this.sent.push({ event, payload }); },
    focus() { this.focused++; },
  };
}

describe('windows.detachWorkspace / redockWorkspace handlers', () => {
  let reg: WindowRegistry;
  let main: ReturnType<typeof fakeWindow>;
  let created: string[];

  beforeEach(() => {
    reg = new WindowRegistry({ lookupSessionWorkspace: () => null });
    main = fakeWindow(1);
    reg.registerWindow(main, { isMain: true });
    created = [];
  });

  function detach() {
    return buildDetachWorkspace({
      registry: reg,
      createSecondaryWindow: (wsId, name) => {
        created.push(wsId);
        const w = fakeWindow(100 + created.length);
        reg.registerWindow(w, { isMain: false });
        reg.assignWorkspace(wsId, w.id);
        return w as unknown as WindowHandle;
      },
      getWorkspaceName: (wsId) => (wsId === 'ws-a' ? 'Alpha' : null),
    });
  }

  it('creates a window for an undetached workspace', async () => {
    await detach()({ workspaceId: 'ws-a' });
    expect(created).toEqual(['ws-a']);
    expect(reg.ownerWindowIdFor('ws-a')).toBe(101);
  });

  it('focuses the existing window instead of double-detaching', async () => {
    const fn = detach();
    await fn({ workspaceId: 'ws-a' });
    await fn({ workspaceId: 'ws-a' });
    expect(created).toEqual(['ws-a']); // no second window
  });

  it('rejects an unknown workspace', async () => {
    await expect(detach()({ workspaceId: 'ws-nope' })).rejects.toThrow(/unknown workspace/i);
  });

  it('redock reassigns to main, seeds the open list, and broadcasts scopes', async () => {
    await detach()({ workspaceId: 'ws-a' });
    const reopened: string[] = [];
    const redock = buildRedockWorkspace({ registry: reg, markWorkspaceOpened: (id) => reopened.push(id) });
    await redock({ workspaceId: 'ws-a' });
    expect(reg.ownerWindowIdFor('ws-a')).toBe(1);
    expect(reopened).toEqual(['ws-a']); // A4 continuity rule
    expect(main.focused).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/core/windows/detach-handlers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/core/windows/detach-handlers.ts`**

```ts
// Multi-window B2 — RPC handler logic, DI'd so rpc-router stays thin and the
// Electron window factory (main.ts) is injectable in tests.

import type { WindowRegistry, WindowHandle } from './registry';

export interface DetachDeps {
  registry: WindowRegistry;
  /** main.ts createSecondaryWindow, adapted to WindowHandle. */
  createSecondaryWindow: (workspaceId: string, workspaceName: string) => WindowHandle;
  /** Resolve a display name (workspaces table). Null = unknown id. */
  getWorkspaceName: (workspaceId: string) => string | null;
}

export function buildDetachWorkspace(deps: DetachDeps) {
  return async ({ workspaceId }: { workspaceId: string }): Promise<{ windowId: number }> => {
    const existing = deps.registry.ownerWindowIdFor(workspaceId);
    if (existing != null) {
      const win = deps.registry.windowById(existing);
      const isMainOwner = deps.registry.mainWindow()?.id === existing;
      if (win && !isMainOwner) {
        win.focus(); // already detached — jump to it
        return { windowId: existing };
      }
    }
    const name = deps.getWorkspaceName(workspaceId);
    if (!name) throw new Error(`windows.detachWorkspace: unknown workspace ${workspaceId}`);
    const win = deps.createSecondaryWindow(workspaceId, name);
    // factory assigns ownership + broadcasts scopes (see main.ts B1)
    return { windowId: win.id };
  };
}

export function buildRedockWorkspace(deps: {
  registry: WindowRegistry;
  /** lifecycle.ts markWorkspaceOpened — A4 continuity rule (seed BEFORE the
   *  registry stops reporting the workspace detached, or the union drops it). */
  markWorkspaceOpened: (workspaceId: string) => void;
}) {
  return async ({ workspaceId }: { workspaceId: string }): Promise<void> => {
    const reg = deps.registry;
    const ownerId = reg.ownerWindowIdFor(workspaceId);
    const main = reg.mainWindow();
    if (!main) return;
    if (ownerId == null || ownerId === main.id) return; // already docked
    reg.assignWorkspace(workspaceId, main.id);
    deps.markWorkspaceOpened(workspaceId);
    reg.broadcastScopes();
    main.focus();
  };
}
```

- [ ] **Step 4: Register the QUAD**

1. `rpc-channels.ts` after `'workspaces.openNew',` (`:93`):
```ts
  // Multi-window (2026-06-12)
  'windows.detachWorkspace',
  'windows.redockWorkspace',
```
2. `rpc-channels.test.ts` `TYPED_ROUTER_CHANNELS` after `:117`:
```ts
  'windows.detachWorkspace',  // multi-window B2
  'windows.redockWorkspace',  // multi-window B2
```
3. `router-shape.ts` (sibling of `workspaces:` `:327`):
```ts
  windows: {
    /** Detach a workspace into its own OS window; focuses the existing one if already detached. */
    detachWorkspace: (input: { workspaceId: string }) => Promise<{ windowId: number }>;
    /** Move a detached workspace back into the main window (closes nothing; ownership only). */
    redockWorkspace: (input: { workspaceId: string }) => Promise<void>;
  };
```
4. `rpc-router.ts` — in the router object, with the factory injected. `registerRouter()` is called from `main.ts`; add an optional deps parameter (or a setter mirroring how other supervisors are wired — match the existing style around `:721` `resolveMcpCommand`):
```ts
    windows: {
      detachWorkspace: buildDetachWorkspace({
        registry: getWindowRegistry(),
        createSecondaryWindow: (wsId, name) => secondaryWindowFactory(wsId, name),
        getWorkspaceName: (wsId) => {
          try {
            const row = getRawDb()
              .prepare('SELECT name FROM workspaces WHERE id = ?')
              .get(wsId) as { name?: string } | undefined;
            return row?.name ?? null;
          } catch { return null; }
        },
      }),
      redockWorkspace: buildRedockWorkspace({
        registry: getWindowRegistry(),
        markWorkspaceOpened, // imported from './core/workspaces/lifecycle'
      }),
    },
```
with module-level injection (set from main.ts before `registerRouter()`):
```ts
let secondaryWindowFactory: (wsId: string, name: string) => import('./core/windows/registry').WindowHandle =
  () => { throw new Error('secondary window factory not wired'); };
export function setSecondaryWindowFactory(f: typeof secondaryWindowFactory): void {
  secondaryWindowFactory = f;
}
```
`main.ts` in `whenReady` BEFORE `registerRouter()`:
```ts
  setSecondaryWindowFactory((wsId, name) => asHandle(createSecondaryWindow(wsId, name)));
```
(Check the real `workspaces` table column for the display name first — `git grep -n "FROM workspaces" src/main | head`; if it's `label`/`title` adjust the SQL.)

- [ ] **Step 5: Run handler tests + channel QUAD tests + full gate**

Run: `npx vitest run src/main/core/windows src/shared/rpc-channels.test.ts && npx tsc -b && npx vitest run`
Expected: all green; the QUAD defensive test passes with the two new channels in BOTH lists.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/windows/ src/shared/ src/main/rpc-router.ts electron/main.ts
git commit -m "feat(windows): detach/redock RPCs with injected window factory; channel QUAD updated (multi-window B2)"
```

---

### Task B3: scope-aware renderer mirror

**Files:**
- Modify: `src/renderer/app/state-hooks/use-workspace-mirror.ts`
- Test: extend the existing mirror tests (`git grep -l "useWorkspaceMirror" src/renderer --include="*.test.*"`) — if none exist, create `src/renderer/app/state-hooks/use-workspace-mirror.test.tsx` with jsdom + a stubbed `window.sigma`

Behavior changes:
1. **Inbound** `app:open-workspaces-changed` (global union): each window intersects with what it OWNS before dispatching `SYNC_OPEN_WORKSPACES`. Owned set comes from the latest `app:window-scope-changed` payload: main window owns `union − (all secondary scopes)`; a scoped window owns `[workspaceScope]`.
2. **Outbound**: scoped windows DON'T echo at all (their list is derived); the main window keeps echoing the UNCHANGED `{workspaceIds}` payload — main-side A4 re-adds detached ids to the union, so no protocol change.
3. New inbound subscriber for `app:window-scope-changed` → caches scopes at MODULE scope (remount-persistent, PaneSplash lesson) + re-filters against the last-known union.

- [ ] **Step 1: Write the failing tests**

```tsx
// use-workspace-mirror.test.tsx (sketch — follow the repo's existing hook-test harness;
// jsdom + manual event-callback capture via a stubbed window.sigma)
import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listeners = new Map<string, (p: unknown) => void>();
const sent: Array<{ event: string; payload: unknown }> = [];
beforeEach(() => {
  listeners.clear();
  sent.length = 0;
  (window as any).sigma = {
    eventOn: (ev: string, cb: (p: unknown) => void) => { listeners.set(ev, cb); return () => listeners.delete(ev); },
    eventSend: (ev: string, p: unknown) => { sent.push({ event: ev, payload: p }); },
    windowContext: { windowId: null, isMain: true, workspaceScope: null },
  };
  vi.resetModules(); // module-scope scope cache must reset between tests
});

it('main window filters out workspaces owned by secondary windows', async () => {
  const { useWorkspaceMirror } = await import('./use-workspace-mirror');
  const dispatched: unknown[] = [];
  renderHook(() => useWorkspaceMirror(makeState({ workspaces: [ws('a'), ws('b')] }), (a) => dispatched.push(a)));
  listeners.get('app:window-scope-changed')!({ scopes: [
    { windowId: 1, isMain: true, workspaceIds: [] },
    { windowId: 2, isMain: false, workspaceIds: ['b'] },
  ]});
  listeners.get('app:open-workspaces-changed')!({ workspaceIds: ['a', 'b'] });
  await vi.waitFor(() => {
    const sync = dispatched.find((d: any) => d.type === 'SYNC_OPEN_WORKSPACES') as any;
    expect(sync.workspaceIds).toEqual(['a']); // 'b' lives in window 2
  });
});

it('scoped window keeps only its own workspace', async () => {
  (window as any).sigma.windowContext = { windowId: 1001, isMain: false, workspaceScope: 'b' };
  const { useWorkspaceMirror } = await import('./use-workspace-mirror');
  const dispatched: unknown[] = [];
  renderHook(() => useWorkspaceMirror(makeState({ workspaces: [ws('a'), ws('b')] }), (a) => dispatched.push(a)));
  listeners.get('app:open-workspaces-changed')!({ workspaceIds: ['a', 'b'] });
  await vi.waitFor(() => {
    const sync = dispatched.find((d: any) => d.type === 'SYNC_OPEN_WORKSPACES') as any;
    expect(sync.workspaceIds).toEqual(['b']);
  });
});

it('scoped window never echoes outbound', async () => {
  (window as any).sigma.windowContext = { windowId: 1001, isMain: false, workspaceScope: 'b' };
  const { useWorkspaceMirror } = await import('./use-workspace-mirror');
  renderHook(() => useWorkspaceMirror(makeState({ ready: true, openWorkspaces: [ws('b')] }), () => {}));
  expect(sent.filter((s) => s.event === 'app:open-workspaces-changed')).toHaveLength(0);
});
```

(`makeState`/`ws` are tiny local fixtures matching `AppState`/`Workspace` minimal fields — copy the pattern from the nearest existing state-hook test; `git grep -l "renderHook" src/renderer/app/state-hooks`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/renderer/app/state-hooks/use-workspace-mirror.test.tsx`

- [ ] **Step 3: Implement**

In `use-workspace-mirror.ts`:

```ts
import { getWindowContext, getWorkspaceScope, isMainWindow } from '../../lib/window-context';

// MODULE scope (survives remounts — PaneSplash lesson): latest scope table.
let secondaryOwned = new Set<string>();

function visibleSubset(workspaceIds: string[]): string[] {
  const scope = getWorkspaceScope();
  if (scope) return workspaceIds.filter((id) => id === scope);
  return workspaceIds.filter((id) => !secondaryOwned.has(id));
}
```

- New effect subscribing to `app:window-scope-changed`: parse `{scopes}`, rebuild `secondaryOwned` from entries with `isMain === false`, then re-run the same reconcile body as the open-workspaces listener with the LAST known union (cache the last union in module scope too: `let lastUnion: string[] = []`).
- Inbound listener (`:32-53`): after `parseOpenWorkspacesChanged`, set `lastUnion = workspaceIds`, then `const visible = visibleSubset(workspaceIds)` and dispatch `SYNC_OPEN_WORKSPACES` with `visible`.
- Outbound effect (`:57-71`): first line `if (!isMainWindow()) return;`. The payload stays the existing `{ workspaceIds }` — the main window's visible list legitimately excludes detached workspaces; A4's union re-adds them main-side. No schema change.
- Also export `__resetWorkspaceMirrorModuleStateForTests()` clearing `secondaryOwned`/`lastUnion` (tests rely on `vi.resetModules`, but the explicit reset keeps non-isolated suites safe).

- [ ] **Step 4: Run new tests + full gate** — `npx vitest run src/renderer/app/state-hooks && npx tsc -b && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/state-hooks/ src/renderer/lib/window-context.ts
git commit -m "feat(windows): scope-aware workspace mirror — per-window filtering, main-only outbound echo (multi-window B3)"
```

---

### Task B4: scoped-window boot + Command-Room shell

**Files:**
- Create: `src/renderer/app/state-hooks/use-window-scope-boot.ts`
- Modify: `src/renderer/app/state-hooks/use-session-restore.ts` (early-return when scoped)
- Modify: `src/renderer/app/App.tsx` (scoped body branch)
- Modify: `src/renderer/app/state.tsx` (mount the new hook beside the others)
- Test: `src/renderer/app/state-hooks/use-window-scope-boot.test.tsx`

A scoped window must NOT wait for `app:session-restore` (main.ts only pushes it to the main window). It self-hydrates: fetch `workspaces.list` → find scope → `WORKSPACE_OPEN` + `SET_ACTIVE_WORKSPACE_ID` → hydrate panes exactly like `use-session-restore.ts:145` does (`rpc.panes.listForWorkspace`), dispatching the same actions it dispatches for a restored workspace (read `use-session-restore.ts:89-160` and mirror the pane-hydration dispatch VERBATIM — same action types, same payload massaging; running sessions then attach live via `terminal-cache` `pty.snapshot`, dead ones surface their normal exited state).

- [ ] **Step 1: Write the failing test**

```tsx
// use-window-scope-boot.test.tsx (same harness as B3)
it('opens + activates the scoped workspace and hydrates its panes', async () => {
  (window as any).sigma.windowContext = { windowId: 1001, isMain: false, workspaceScope: 'ws-b' };
  stubRpc({
    'workspaces.list': [wsRow('ws-a'), wsRow('ws-b')],
    'panes.listForWorkspace': [paneRow('sess-1', 'ws-b', 'running')],
  });
  const dispatched: any[] = [];
  renderHook(() => useWindowScopeBoot((a) => dispatched.push(a)));
  await vi.waitFor(() => {
    expect(dispatched.some((d) => d.type === 'WORKSPACE_OPEN' && d.workspace.id === 'ws-b')).toBe(true);
    expect(dispatched.some((d) => d.type === 'SET_ACTIVE_WORKSPACE_ID')).toBe(true);
  });
});

it('no-ops in the main window', async () => {
  (window as any).sigma.windowContext = { windowId: null, isMain: true, workspaceScope: null };
  const dispatched: any[] = [];
  renderHook(() => useWindowScopeBoot((a) => dispatched.push(a)));
  await new Promise((r) => setTimeout(r, 10));
  expect(dispatched).toHaveLength(0);
});
```

(`stubRpc` stubs `src/renderer/lib/rpc` via `vi.mock` — copy the mocking pattern from the nearest existing state-hook test. The pane-hydration assertion should mirror whatever actions `use-session-restore` dispatches — read it FIRST, then assert those exact types.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the hook** — mirror `use-session-restore`'s hydration block, guarded by `if (!getWorkspaceScope()) return;` and run-once via a `useRef`. In `use-session-restore.ts`, add at the top of its main effect: `if (getWorkspaceScope()) return;` (scoped windows must not race a second hydration or emit `app:session-snapshot` — also gate the snapshot-writer effect with `isMainWindow()`).

- [ ] **Step 4: App.tsx scoped shell**

Inside the EXISTING provider tree (do not fork the file): where the body renders (`RoomSwitch` at `:83-106` / layout around `:161-197`), branch:

```tsx
import { getWorkspaceScope } from '@/renderer/lib/window-context';
// …
const scoped = getWorkspaceScope() != null;
// in the layout JSX: when `scoped`, render the header + <CommandRoom /> only —
// no Sidebar, no room nav, no Jorvis/Settings routes (design non-goals).
```

Set the document title in scoped windows (effect near the tint hook `:281-283`):

```tsx
useEffect(() => {
  if (!scoped) return;
  const name = state.activeWorkspace?.name;
  if (name) document.title = `${name} — SigmaLink`;
}, [scoped, state.activeWorkspace?.name]);
```

(Confirm the `Workspace` display field — `name` vs `label` — same check as B2 Step 4.)

- [ ] **Step 5: Run tests + full gate + build** — `npx vitest run src/renderer && npx tsc -b && npx vitest run && npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/
git commit -m "feat(windows): scoped-window boot + Command-Room-only shell + per-window title (multi-window B4)"
```

---

### Task B5: sidebar detach affordance + main-window detach reaction

**Files:**
- Modify: `src/renderer/features/sidebar/Sidebar.tsx` (row action near `onClose` `:379`)
- Modify: `src/renderer/app/state-hooks/use-workspace-mirror.ts` (detach reaction — covered by B3's scope filter; verify only)
- Test: extend Sidebar tests if a row-action test harness exists (`git grep -l "Sidebar" src/renderer --include="*.test.*"`); otherwise cover via the B3 mirror tests + CI e2e

- [ ] **Step 1: Add the action**

Beside the existing close affordance on each open-workspace row (pattern-match the close button's JSX), main window only:

```tsx
{isMainWindow() && (
  <button
    type="button"
    title="Open in new window"
    aria-label={`Open ${workspace.name} in a new window`}
    className={/* copy the close button's classes */}
    onClick={(e) => {
      e.stopPropagation();
      void rpc.windows.detachWorkspace({ workspaceId: workspace.id }).catch(() => undefined);
    }}
  >
    {/* lucide-react ExternalLink or AppWindow icon, sized like the close icon */}
  </button>
)}
```

No optimistic dispatch: the round-trip is main creates window → broadcasts scopes → B3's filter drops the workspace from THIS window. Single source of truth, no divergence path (failed-resume optimistic-state lesson, PR #137).

- [ ] **Step 2: Verify the detach reaction end-of-chain** — with B3 merged, simulate in the mirror test: scope event marking `ws-b` secondary-owned must yield `SYNC_OPEN_WORKSPACES` without `ws-b` while `lastUnion` still contains it (this exact case is B3 test 1 — confirm it covers the post-detach re-filter, extend if not).

- [ ] **Step 3: Full gate + build.**

- [ ] **Step 4: Commit**

```bash
git add src/renderer/features/sidebar/
git commit -m "feat(windows): 'Open in new window' workspace row action (multi-window B5)"
```

---

### Task B6: release gate + manual smoke script

- [ ] **Step 1: Full local gate** (NO local Playwright — CI runs the e2e matrix):

```bash
npx tsc -b && npx eslint . && npx vitest run && npm run build
```

- [ ] **Step 2: PR** with this manual smoke list for the operator (local `electron .` from `app/` with an isolated `--user-data-dir`, per the dev-launch memory):

1. Detach a workspace with a RUNNING claude pane → new window shows the pane, scrollback present (snapshot replay), typing works, NO doubled input echo in either window.
2. Main window no longer shows the workspace; other workspaces unaffected.
3. Resize the detached window → TUI re-wraps once (single SIGWINCH owner).
4. Close the detached window → workspace re-docks into the main sidebar; pane still live; again no doubled echo.
5. Detach again → "already detached" focus path (click detach twice fast: exactly one window).
6. Quit + relaunch → single main window, all workspaces docked (Phase 3 — layout restore — is explicitly NOT in this plan), no resurrected ghosts.
7. Notifications/toasts: trigger a pane exit in the detached window → exactly ONE toast (in the owning window), not two.

- [ ] **Step 3: Squash-merge after review + CI green.**

---

## Self-review notes (run before handing off)

- **Sibling-mirror audit (MANDATORY at PR time):** `grep -n "mainWindow" electron/main.ts` and `grep -rn "getFocusedWindow\|getAllWindows" src/main` — every remaining site must be deliberately classified (tray/global-capture/voice stay main-window-targeted by design; memory controller's focused-window pick at `core/memory/controller.ts:164,184` is already multi-window-tolerant).
- **Type consistency:** `WindowHandle` (A1) is the ONLY window surface rpc-router/handlers see; `asHandle` (A2) is the single adapter; B2's factory returns `WindowHandle` via `asHandle(createSecondaryWindow(...))`.
- **Known soft spots an implementer must verify in situ:** (1) exact `workspaces` table name column; (2) where lifecycle's existing tests live + their import style; (3) the state-hook test harness conventions (`renderHook` + rpc mock pattern); (4) whether `rpc-channels.test.ts` enumerates EVENTS exhaustively (then add `app:window-scope-changed` there); (5) `use-session-restore`'s exact pane-hydration dispatches (B4 mirrors them verbatim).
- **Out of scope (recorded in WISHLIST/ROADMAP):** boot restore of window layout (kv `ui.windows.layout`); secondary windows hosting non-workspace rooms; pane-level tear-out; mirroring; per-window theme.
