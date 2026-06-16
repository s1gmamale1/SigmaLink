# Tools in Scoped (Popped-Out) Workspace Windows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-app Browser, the Jorvis assistant, and the other right-rail tools usable inside a workspace that has been detached into its own OS window, scoped to that one workspace.

**Architecture:** Reuse-in-place. Mount the existing `RightRail` + `RightRailSwitcher` in `ScopedShell`; route `assistant:*` / `browser:state` events to the workspace's owner window inside `broadcast()` (priority chain: `workspaceId` → `sessionId` → `conversationId`); resolve each `BrowserManager`'s host window from `WindowRegistry` ownership and tear the manager down on detach/redock so it re-hydrates fresh in the new owner window (matching the terminal-cache "re-hydrate on the other side" precedent).

**Tech Stack:** Electron (main: `WebContentsView`, `BrowserWindow`), React 18 + TypeScript (renderer), Vitest, Drizzle/better-sqlite3, the `WindowRegistry` multi-window source of truth.

**Spec:** `docs/superpowers/specs/2026-06-16-tools-in-scoped-windows-design.md`

**Reference — verified ground truth (file:line):**
- `broadcast()` + `SESSION_ROUTED_EVENTS`: `src/main/rpc-router.ts:235-249`
- assistant `emit` wrapper (Telegram fan-out preserved): `src/main/rpc-router.ts:2080-2106`
- `assistant:dispatch-echo` payload already carries `workspaceId`: `src/main/core/assistant/controller.ts:480-493`
- `assistant:pane-event` payload (carries `conversationId` + `sessionId`): `src/main/rpc-router.ts:597-604`
- `assistant:pane-closed` payload (`{ sessionId }`): `src/main/core/assistant/tools.ts:419`
- `assistant:state` payload (carries `conversationId` + `turnId`): `src/main/core/assistant/runClaudeCliTurn.emit.ts:52-55,71,93,119`
- `getConversation(id): Conversation | null` with `.workspaceId`: `src/main/core/assistant/conversations.ts:14-17,69`
- `WindowRegistry.ownerWindowIdFor` / `sendToWorkspaceOwner` / `sendToSessionOwner`: `src/main/core/windows/registry.ts:78-81,102-125`
- `BrowserManagerRegistry` + `windowProvider` (currently `() => getFocusedWindow()`): `src/main/core/browser/manager.ts:751-803`; constructed `src/main/rpc-router.ts:727-736`
- `BrowserManager.setWindow` (BSP-B2 guard) / `ensureView` (attaches to `this.window.contentView`): `src/main/core/browser/manager.ts:80-87,561-609`
- detach/redock handlers (DI'd): `src/main/core/windows/detach-handlers.ts:20-37,39-70`
- `ScopedShell`: `src/renderer/app/App.tsx:228-247`; `MainBody` rail-wrap pattern: `:192-210`; `RightRailProvider` wraps both shells: `:358-391`
- `RightRailSwitcher` (zero-prop, uses `noDragStyle()`): `src/renderer/features/top-bar/RightRailSwitcher.tsx`
- `RightRailContext` tab persistence (global `KV_TAB`): `src/renderer/features/right-rail/RightRailContext.tsx:43-91`; keys `RightRailContext.data.ts:10-13`
- per-workspace KV helpers: `src/renderer/lib/workspace-ui-kv.ts`

**Constraints (project conventions):**
- `better-sqlite3` cannot load in Vitest (built for Electron's ABI). DB/native paths use mocks — never `new Database()`. Existing harnesses to follow: `src/main/core/browser/manager.test.ts`, `src/main/core/windows/detach-handlers.test.ts`, `src/main/core/windows/registry.test.ts`.
- After any member access added to a mocked dep, run the FULL `vitest run` (a sibling mock can silently break — see project memory).
- Do NOT run Electron / Playwright e2e locally (launches competing windows). Local gate = `tsc -b` + `vitest run` + lint + build; defer e2e to CI.
- TS `erasableSyntaxOnly` is on in `app/`: NO `constructor(private x)` param-properties, NO enums/namespaces — declare the field then assign in the body.

---

## File Structure

**Main process**
- `src/main/rpc-router.ts` — Modify: add `resolveAssistantRoute` (exported pure helper) + `WORKSPACE_ROUTED_ASSISTANT_EVENTS` + conversation→workspace cache; call from `broadcast()`. Change `windowProvider` to resolve the owner window (via new pure helper `resolveBrowserHostWindowId`). Wire `teardownBrowser` into the detach/redock handler deps.
- `src/main/core/browser/manager.ts` — Modify: `RegistryDeps.windowProvider` takes `workspaceId`; `get()` passes it + self-heals a stale manager; add `BrowserManager.isStale()`.
- `src/main/core/windows/detach-handlers.ts` — Modify: `DetachDeps`/redock deps gain optional `teardownBrowser(workspaceId)`; call it on detach (after window creation) and on redock (before closing the former owner).

**Renderer**
- `src/renderer/features/top-bar/RightRailSwitcher.tsx` — Modify: add optional `showSettings?: boolean` prop (default `true`).
- `src/renderer/features/right-rail/RightRailContext.tsx` — Modify: per-workspace active-tab persistence (`ui.<wsId>.rightRail.tab`, legacy global fallback).
- `src/renderer/app/App.tsx` — Modify: `ScopedShell` renders the titlebar switcher + wraps `CommandRoom` in `RightRail`.

**Tests (new/modified)**
- `src/main/rpc-router.route.test.ts` (NEW) — `resolveAssistantRoute` + `resolveBrowserHostWindowId` pure-helper tests.
- `src/main/core/browser/manager.test.ts` — extend: `get()` passes `workspaceId`, self-heals stale managers; `isStale()`.
- `src/main/core/windows/detach-handlers.test.ts` — extend: `teardownBrowser` called on detach + redock.
- `src/renderer/features/top-bar/RightRailSwitcher.test.tsx` (NEW) — `showSettings` gates the gear.
- `src/renderer/features/right-rail/RightRailContext.test.tsx` (NEW or extend) — per-workspace tab read/write.
- `src/renderer/app/ScopedShell.test.tsx` (NEW) — scoped shell mounts switcher + rail.

---

## Task 1: Route assistant/browser events to the workspace owner window

**Files:**
- Modify: `src/main/rpc-router.ts:235-249`
- Test: `src/main/rpc-router.route.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/main/rpc-router.route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveAssistantRoute } from './rpc-router';

describe('resolveAssistantRoute', () => {
  const convWs = (id: string) => (id === 'c-owned' ? 'ws-conv' : null);

  it('routes by explicit workspaceId first', () => {
    expect(resolveAssistantRoute('assistant:dispatch-echo', { workspaceId: 'ws-1', sessionId: 's', conversationId: 'c' }, convWs))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-1' });
    expect(resolveAssistantRoute('browser:state', { workspaceId: 'ws-2' }, convWs))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-2' });
  });

  it('falls back to sessionId for pane events without a workspaceId', () => {
    expect(resolveAssistantRoute('assistant:pane-closed', { sessionId: 's-9' }, convWs))
      .toEqual({ kind: 'session', sessionId: 's-9' });
    expect(resolveAssistantRoute('assistant:pane-event', { sessionId: 's-7', conversationId: 'c' }, convWs))
      .toEqual({ kind: 'session', sessionId: 's-7' });
  });

  it('resolves conversationId → workspace for chat-stream events', () => {
    expect(resolveAssistantRoute('assistant:state', { conversationId: 'c-owned', turnId: 't' }, convWs))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-conv' });
    expect(resolveAssistantRoute('assistant:tool-trace', { conversationId: 'c-owned' }, convWs))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-conv' });
  });

  it('falls back to broadcast when nothing resolves or the event is not routed', () => {
    expect(resolveAssistantRoute('assistant:state', { conversationId: 'c-unknown' }, convWs)).toEqual({ kind: 'all' });
    expect(resolveAssistantRoute('assistant:state', {}, convWs)).toEqual({ kind: 'all' });
    expect(resolveAssistantRoute('memory:changed', { workspaceId: 'ws-1' }, convWs)).toEqual({ kind: 'all' });
    expect(resolveAssistantRoute('assistant:state', null, convWs)).toEqual({ kind: 'all' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/rpc-router.route.test.ts`
Expected: FAIL — `resolveAssistantRoute` is not exported from `./rpc-router`.

- [ ] **Step 3: Implement the helper and wire it into `broadcast()`**

In `src/main/rpc-router.ts`, add the `getConversation` import alongside the other assistant imports near the top (find the existing `from './core/assistant/...'` imports):

```ts
import { getConversation } from './core/assistant/conversations';
```

Replace the `SESSION_ROUTED_EVENTS` + `broadcast` block at `src/main/rpc-router.ts:235-249` with:

```ts
/** Events whose payload carries a sessionId and should only reach the
 *  window owning that session's workspace. Everything else broadcasts. */
const SESSION_ROUTED_EVENTS = new Set(['pty:data', 'pty:exit', 'pty:error', 'pty:link-detected']);

/** Multi-window — assistant/browser events that must reach only the window
 *  owning the relevant workspace, so a popped-out window's Jorvis/browser
 *  acts on its own workspace and the main window never double-acts. */
const WORKSPACE_ROUTED_ASSISTANT_EVENTS = new Set([
  'assistant:state',
  'assistant:tool-trace',
  'assistant:dispatch-echo',
  'assistant:pane-event',
  'assistant:pane-closed',
  'browser:state',
]);

export type AssistantRoute =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'all' };

/** Pure routing decision for a workspace-routed event. Priority:
 *  explicit workspaceId → sessionId (session→workspace) → conversationId
 *  (conversation→workspace) → broadcast. `resolveConversationWorkspace`
 *  returns null when the conversation is unknown. */
export function resolveAssistantRoute(
  event: string,
  payload: unknown,
  resolveConversationWorkspace: (conversationId: string) => string | null,
): AssistantRoute {
  if (!WORKSPACE_ROUTED_ASSISTANT_EVENTS.has(event)) return { kind: 'all' };
  const p = (payload ?? {}) as { workspaceId?: unknown; sessionId?: unknown; conversationId?: unknown };
  if (typeof p.workspaceId === 'string' && p.workspaceId) return { kind: 'workspace', workspaceId: p.workspaceId };
  if (typeof p.sessionId === 'string' && p.sessionId) return { kind: 'session', sessionId: p.sessionId };
  if (typeof p.conversationId === 'string' && p.conversationId) {
    const ws = resolveConversationWorkspace(p.conversationId);
    if (ws) return { kind: 'workspace', workspaceId: ws };
  }
  return { kind: 'all' };
}

// conversationId → workspaceId is immutable once a conversation exists, so a
// forever-cache keeps the hot delta path (assistant:state) off the DB.
const conversationWorkspaceCache = new Map<string, string>();
function conversationWorkspace(conversationId: string): string | null {
  const hit = conversationWorkspaceCache.get(conversationId);
  if (hit) return hit;
  try {
    const ws = getConversation(conversationId)?.workspaceId ?? null;
    if (ws) conversationWorkspaceCache.set(conversationId, ws);
    return ws;
  } catch {
    return null;
  }
}

function broadcast(event: string, payload: unknown) {
  const registry = getWindowRegistry();
  if (SESSION_ROUTED_EVENTS.has(event)) {
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId === 'string') {
      registry.sendToSessionOwner(sessionId, event, payload);
      return;
    }
  }
  const route = resolveAssistantRoute(event, payload, conversationWorkspace);
  if (route.kind === 'workspace') {
    registry.sendToWorkspaceOwner(route.workspaceId, event, payload);
    return;
  }
  if (route.kind === 'session') {
    registry.sendToSessionOwner(route.sessionId, event, payload);
    return;
  }
  registry.sendToAll(event, payload);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/rpc-router.route.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/rpc-router.ts src/main/rpc-router.route.test.ts
git commit -m "feat(windows): route assistant/browser events to the workspace owner window"
```

---

## Task 2: Resolve the browser host window from workspace ownership

**Files:**
- Modify: `src/main/rpc-router.ts:727-736`
- Test: `src/main/rpc-router.route.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append to `src/main/rpc-router.route.test.ts`)

```ts
import { resolveBrowserHostWindowId } from './rpc-router';

describe('resolveBrowserHostWindowId', () => {
  const ids = { ownerWindowIdFor: (ws: string) => (ws === 'ws-detached' ? 1001 : null) };

  it('prefers the owner window when ownership is known', () => {
    expect(resolveBrowserHostWindowId('ws-detached', ids, 1, [1, 1001])).toBe(1001);
  });
  it('falls back to the focused window when ownership is unknown', () => {
    expect(resolveBrowserHostWindowId('ws-unowned', ids, 1, [1, 1001])).toBe(1);
  });
  it('falls back to the first window when nothing is focused', () => {
    expect(resolveBrowserHostWindowId('ws-unowned', ids, null, [7, 8])).toBe(7);
  });
  it('returns null when there are no windows', () => {
    expect(resolveBrowserHostWindowId('ws-unowned', ids, null, [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/rpc-router.route.test.ts -t resolveBrowserHostWindowId`
Expected: FAIL — `resolveBrowserHostWindowId` not exported.

- [ ] **Step 3: Implement the pure helper + use it in `windowProvider`**

In `src/main/rpc-router.ts`, add the pure helper near `resolveAssistantRoute`:

```ts
/** Pure browser-host window resolution: owner window first, then the focused
 *  window, then the first live window. ids/focusedId/allIds are window ids;
 *  the caller maps the result back to a BrowserWindow. */
export function resolveBrowserHostWindowId(
  workspaceId: string,
  registry: { ownerWindowIdFor: (workspaceId: string) => number | null },
  focusedWindowId: number | null,
  allWindowIds: number[],
): number | null {
  const owner = registry.ownerWindowIdFor(workspaceId);
  if (owner != null && allWindowIds.includes(owner)) return owner;
  if (focusedWindowId != null && allWindowIds.includes(focusedWindowId)) return focusedWindowId;
  return allWindowIds[0] ?? null;
}
```

Replace the `browserRegistry` construction at `src/main/rpc-router.ts:727-736`:

```ts
const browserRegistry = new BrowserManagerRegistry({
  windowProvider: (workspaceId: string) => {
    // Multi-window — mount the browser view in the window that OWNS this
    // workspace (possibly a detached/scoped window), not just the focused one.
    const live = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const focused = BrowserWindow.getFocusedWindow();
    const hostId = resolveBrowserHostWindowId(
      workspaceId,
      getWindowRegistry(),
      focused && !focused.isDestroyed() ? focused.id : null,
      live.map((w) => w.id),
    );
    if (hostId == null) return null;
    const host = BrowserWindow.fromId(hostId);
    return host && !host.isDestroyed() ? host : (live[0] ?? null);
  },
  onState: (state) => broadcast('browser:state', state),
});
```

Confirm `BrowserWindow` is already imported at the top of `rpc-router.ts` (it is — `windowProvider` used `getFocusedWindow()` before). If not, add `import { BrowserWindow } from 'electron';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/rpc-router.route.test.ts -t resolveBrowserHostWindowId`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/rpc-router.ts src/main/rpc-router.route.test.ts
git commit -m "feat(browser): resolve the browser host window from workspace ownership"
```

---

## Task 3: BrowserManagerRegistry passes workspaceId + self-heals stale managers

**Files:**
- Modify: `src/main/core/browser/manager.ts:80-87,751-782`
- Test: `src/main/core/browser/manager.test.ts` (extend, follow its existing electron mock)

- [ ] **Step 1: Write the failing test** (append to `src/main/core/browser/manager.test.ts`, reusing that file's existing electron/db mocks)

```ts
describe('BrowserManagerRegistry — multi-window host resolution', () => {
  it('passes the workspaceId to windowProvider', () => {
    const seen: string[] = [];
    const reg = new BrowserManagerRegistry({
      windowProvider: (wsId: string) => {
        seen.push(wsId);
        return makeFakeWindow(); // helper already used elsewhere in this file
      },
      onState: () => {},
    });
    reg.get('ws-abc');
    expect(seen).toContain('ws-abc');
  });

  it('tears down and rebuilds a manager whose window was destroyed', () => {
    const win1 = makeFakeWindow();
    const win2 = makeFakeWindow();
    let next = win1;
    const reg = new BrowserManagerRegistry({
      windowProvider: () => next,
      onState: () => {},
    });
    const first = reg.get('ws-1');
    win1.__destroy(); // mark isDestroyed() → true (fake helper)
    next = win2;
    const second = reg.get('ws-1');
    expect(second).not.toBe(first); // stale manager was replaced
    expect(first.isStale()).toBe(true);
  });
});
```

> Note: `makeFakeWindow()` / `__destroy()` mirror the window fake already used in `manager.test.ts`. If the existing fake lacks an `isDestroyed` toggle, extend it there (one place) so both old and new tests share it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/browser/manager.test.ts`
Expected: FAIL — `windowProvider` signature is `() =>` (no arg seen) and `isStale` is undefined.

- [ ] **Step 3: Implement**

In `src/main/core/browser/manager.ts`, add `isStale()` to `BrowserManager` (just after `setWindow`, around line 87):

```ts
/** Multi-window — a manager is stale once its host window is destroyed
 *  (e.g. a scoped window the user closed). The registry rebuilds it,
 *  re-hydrating tabs from the DB into the new owner window. */
isStale(): boolean {
  if (this.detachedState) return false; // BSP-B2 popout manages its own window
  try {
    return this.window.isDestroyed();
  } catch {
    return true;
  }
}
```

Change `RegistryDeps` (line 753) and `get()` (line 765):

```ts
interface RegistryDeps {
  windowProvider: (workspaceId: string) => BrowserWindow | null;
  onState: (state: BrowserState) => void;
}
```

```ts
get(workspaceId: string): BrowserManager {
  let mgr = this.map.get(workspaceId);
  if (mgr && mgr.isStale()) {
    // Host window gone (scoped window closed) — drop the stale manager so a
    // fresh one re-hydrates from the DB into the current owner window.
    this.teardown(workspaceId);
    mgr = undefined;
  }
  if (mgr) {
    const win = this.deps.windowProvider(workspaceId);
    if (win) mgr.setWindow(win);
    return mgr;
  }
  const win = this.deps.windowProvider(workspaceId);
  if (!win) throw new Error('No active BrowserWindow for workspace ' + workspaceId);
  mgr = new BrowserManager({ workspaceId, window: win });
  mgr.on('state', this.deps.onState);
  this.map.set(workspaceId, mgr);
  return mgr;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/browser/manager.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/browser/manager.ts src/main/core/browser/manager.test.ts
git commit -m "feat(browser): per-workspace host resolution + self-heal stale managers"
```

---

## Task 4: Tear down the workspace browser on detach/redock

**Files:**
- Modify: `src/main/core/windows/detach-handlers.ts:6-12,20-37,39-70`
- Modify: `src/main/rpc-router.ts` (wire `teardownBrowser` into the detach/redock deps — find where `buildDetachWorkspace` / `buildRedockWorkspace` are constructed)
- Test: `src/main/core/windows/detach-handlers.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append to `src/main/core/windows/detach-handlers.test.ts`, following its existing fake-registry pattern)

```ts
describe('detach/redock — browser teardown', () => {
  it('tears down the workspace browser when detaching', async () => {
    const torndown: string[] = [];
    const { deps } = makeDetachDeps(); // existing helper in this test file
    const detach = buildDetachWorkspace({ ...deps, teardownBrowser: (id) => torndown.push(id) });
    await detach({ workspaceId: 'ws-1' });
    expect(torndown).toEqual(['ws-1']);
  });

  it('tears down the workspace browser when redocking, before closing the former owner', async () => {
    const order: string[] = [];
    const { deps, formerOwner } = makeRedockDeps('ws-1'); // existing helper
    formerOwner.close = () => order.push('close');
    const redock = buildRedockWorkspace({ ...deps, teardownBrowser: (id) => order.push('teardown:' + id) });
    await redock({ workspaceId: 'ws-1' });
    expect(order).toEqual(['teardown:ws-1', 'close']);
  });
});
```

> If `makeDetachDeps` / `makeRedockDeps` don't exist with these exact names, mirror the inline dep-construction the existing tests in this file already use; the assertion intent (teardown called; teardown-before-close on redock) is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/windows/detach-handlers.test.ts`
Expected: FAIL — `teardownBrowser` is not a recognized dep / not called.

- [ ] **Step 3: Implement**

In `src/main/core/windows/detach-handlers.ts`, add the optional dep to `DetachDeps` (line 6) and call it in `buildDetachWorkspace` (after the window is created, line 33):

```ts
export interface DetachDeps {
  registry: WindowRegistry;
  createSecondaryWindow: (workspaceId: string, workspaceName: string) => WindowHandle;
  getWorkspaceName: (workspaceId: string) => string | null;
  /** Multi-window — dispose the workspace's BrowserManager so its WebContentsView
   *  is released from the old window; the new owner re-hydrates it from the DB. */
  teardownBrowser?: (workspaceId: string) => void;
}
```

```ts
    const win = deps.createSecondaryWindow(workspaceId, name);
    // factory assigns ownership + broadcasts scopes + refreshes the open list (B1)
    deps.teardownBrowser?.(workspaceId); // release the main-window browser view
    return { windowId: win.id };
```

Add the dep to `buildRedockWorkspace`'s param type (line 39) and call it after re-assigning ownership but BEFORE closing the former owner (so the view is released before the scoped window is destroyed), at line 60:

```ts
export function buildRedockWorkspace(deps: {
  registry: WindowRegistry;
  markWorkspaceOpened: (workspaceId: string) => void;
  refreshOpenWorkspaces: () => void;
  teardownBrowser?: (workspaceId: string) => void;
}) {
```

```ts
    reg.assignWorkspace(workspaceId, main.id);
    reg.broadcastScopes();
    deps.refreshOpenWorkspaces();
    main.focus();
    deps.teardownBrowser?.(workspaceId); // release scoped-window view before close
    formerOwner?.close();
```

In `src/main/rpc-router.ts`, find where `buildDetachWorkspace` and `buildRedockWorkspace` are constructed (the `windows` controller wiring) and add `teardownBrowser: (workspaceId) => browserRegistry.teardown(workspaceId)` to both deps objects.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/windows/detach-handlers.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/windows/detach-handlers.ts src/main/core/windows/detach-handlers.test.ts src/main/rpc-router.ts
git commit -m "feat(browser): tear down the workspace browser on detach/redock so the view follows its window"
```

---

## Task 5: RightRailSwitcher gains an optional `showSettings` prop

**Files:**
- Modify: `src/renderer/features/top-bar/RightRailSwitcher.tsx:37-99`
- Test: `src/renderer/features/top-bar/RightRailSwitcher.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `src/renderer/features/top-bar/RightRailSwitcher.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RightRailSwitcher } from './RightRailSwitcher';
import { RightRailCtx, type RightRailContextValue } from '@/renderer/features/right-rail/RightRailContext.data';
import { AppStateProvider } from '@/renderer/app/state';

function renderSwitcher(props: { showSettings?: boolean }) {
  const ctx: RightRailContextValue = {
    activeTab: 'jorvis',
    setActiveTab: () => {},
    railOpen: true,
    setRailOpen: () => {},
    toggleRail: () => {},
  };
  return render(
    <AppStateProvider>
      <RightRailCtx.Provider value={ctx}>
        <RightRailSwitcher {...props} />
      </RightRailCtx.Provider>
    </AppStateProvider>,
  );
}

describe('RightRailSwitcher', () => {
  it('shows the Settings gear by default', () => {
    renderSwitcher({});
    expect(screen.getByLabelText('Settings')).toBeTruthy();
  });
  it('hides the Settings gear when showSettings is false', () => {
    renderSwitcher({ showSettings: false });
    expect(screen.queryByLabelText('Settings')).toBeNull();
    // tabs still render
    expect(screen.getByLabelText('Jorvis')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/top-bar/RightRailSwitcher.test.tsx`
Expected: FAIL — the gear renders regardless (prop not supported), so the second test fails.

- [ ] **Step 3: Implement**

In `src/renderer/features/top-bar/RightRailSwitcher.tsx`, change the signature (line 37) and gate the gear (lines 86-96):

```tsx
export function RightRailSwitcher({ showSettings = true }: { showSettings?: boolean } = {}) {
  const { activeTab, setActiveTab, railOpen, setRailOpen, toggleRail } = useRightRail();
  const dispatch = useAppDispatch();
```

Wrap the existing Settings `<button>` (the one with `aria-label="Settings"`) so it only renders when `showSettings`:

```tsx
      {showSettings && (
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          data-room-id="settings"
          onClick={() => dispatch({ type: 'SET_ROOM', room: 'settings' })}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={noDragStyle()}
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
```

(The existing `<RightRailSwitcher />` call in `Breadcrumb.tsx` keeps the gear — default `true`, no change needed there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/top-bar/RightRailSwitcher.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/top-bar/RightRailSwitcher.tsx src/renderer/features/top-bar/RightRailSwitcher.test.tsx
git commit -m "feat(right-rail): optional showSettings prop on RightRailSwitcher"
```

---

## Task 6: Per-workspace active-tab persistence in RightRailContext

**Files:**
- Modify: `src/renderer/features/right-rail/RightRailContext.tsx:41-91`
- Test: `src/renderer/features/right-rail/RightRailContext.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `src/renderer/features/right-rail/RightRailContext.test.tsx`. Mock the workspace-ui-kv helpers and assert the per-workspace key is used:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useEffect } from 'react';

const reads: Array<[string, string, string | undefined]> = [];
const writes: Array<[string, string, string]> = [];
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: (ws: string, panel: string, legacy?: string) => {
    reads.push([ws, panel, legacy]);
    return Promise.resolve(panel === 'rightRail.tab' ? 'swarm' : null);
  },
  writeWorkspaceUi: (ws: string, panel: string, value: string) => {
    writes.push([ws, panel, value]);
    return Promise.resolve();
  },
}));
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { set: () => Promise.resolve() } },
  rpcSilent: { kv: { get: () => Promise.resolve(null) } },
}));
vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (sel: (s: unknown) => unknown) => sel({ activeWorkspace: { id: 'ws-77' } }),
}));

import { RightRailProvider } from './RightRailContext';
import { useRightRail } from './RightRailContext.data';

beforeEach(() => { reads.length = 0; writes.length = 0; });

function Harness({ onReady }: { onReady: (v: ReturnType<typeof useRightRail>) => void }) {
  const v = useRightRail();
  useEffect(() => onReady(v));
  return null;
}

describe('RightRailContext per-workspace tab', () => {
  it('hydrates the active tab from ui.<wsId>.rightRail.tab with a legacy global fallback', async () => {
    render(<RightRailProvider><Harness onReady={() => {}} /></RightRailProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(reads).toContainEqual(['ws-77', 'rightRail.tab', 'rightRail.tab']);
  });

  it('persists tab changes per-workspace', async () => {
    let api: ReturnType<typeof useRightRail> | null = null;
    render(<RightRailProvider><Harness onReady={(v) => (api = v)} /></RightRailProvider>);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { api!.setActiveTab('skills'); });
    expect(writes).toContainEqual(['ws-77', 'rightRail.tab', 'skills']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/right-rail/RightRailContext.test.tsx`
Expected: FAIL — today the tab is read/written via the global `rpc.kv` key, so `readWorkspaceUi`/`writeWorkspaceUi` are never called with `'rightRail.tab'`.

- [ ] **Step 3: Implement**

In `src/renderer/features/right-rail/RightRailContext.tsx`, replace the tab-hydration effect (lines 41-60) so it keys per-workspace and re-runs on `wsId` change:

```tsx
  // Hydrate the persisted tab. DEV-W4 follow-up — per-workspace key
  // (`ui.<wsId>.rightRail.tab`) with a legacy global fallback, so the main
  // window and a detached/scoped window don't clobber each other's tab.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = wsId
          ? await readWorkspaceUi(wsId, KV_TAB, KV_TAB)
          : await rpcSilent.kv.get(KV_TAB);
        if (!alive) return;
        const normalized = typeof raw === 'string' ? normalizeTabId(raw) : raw;
        if (typeof normalized === 'string' && VALID_TABS.has(normalized as RightRailTabId)) {
          setActiveTabState(normalized as RightRailTabId);
        }
      } catch {
        // kv unavailable — leave at DEFAULT_TAB.
      }
    })();
    return () => {
      alive = false;
    };
  }, [wsId]);
```

Replace `setActiveTab` (lines 88-91) so writes are per-workspace:

```tsx
  const setActiveTab = useCallback(
    (tab: RightRailTabId) => {
      setActiveTabState(tab);
      if (wsId) {
        void writeWorkspaceUi(wsId, KV_TAB, tab);
      } else {
        void rpc.kv.set(KV_TAB, tab).catch(() => undefined);
      }
    },
    [wsId],
  );
```

(`readWorkspaceUi`/`writeWorkspaceUi`, `KV_TAB`, `normalizeTabId`, `VALID_TABS`, `wsId` are all already imported/defined in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/right-rail/RightRailContext.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/right-rail/RightRailContext.tsx src/renderer/features/right-rail/RightRailContext.test.tsx
git commit -m "fix(right-rail): persist active tab per-workspace so windows don't clobber each other"
```

---

## Task 7: ScopedShell mounts the rail switcher + RightRail

**Files:**
- Modify: `src/renderer/app/App.tsx:228-247`
- Test: `src/renderer/app/ScopedShell.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/ScopedShell.test.tsx`. Force scoped-window mode and assert the switcher + a rail-hosted tool render:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Force the module-load discriminator to "scoped window".
vi.mock('@/renderer/lib/window-context', () => ({
  getWorkspaceScope: () => 'ws-scoped',
  isMainWindow: () => false,
  getWindowContext: () => ({ windowId: 1001, isMain: false, workspaceScope: 'ws-scoped' }),
}));
// Rail enabled + open so the rail mounts.
vi.mock('@/renderer/features/right-rail/use-right-rail-enabled', () => ({
  useRightRailEnabled: () => ({ enabled: true, ready: true }),
}));

import App from './App';

describe('ScopedShell', () => {
  it('renders the right-rail switcher tabs (incl. Jorvis) in the titlebar', () => {
    render(<App />);
    expect(screen.getByLabelText('Jorvis')).toBeTruthy();
    expect(screen.getByLabelText('Browser')).toBeTruthy();
  });
  it('does NOT render the Settings gear in the scoped titlebar', () => {
    render(<App />);
    expect(screen.queryByLabelText('Settings')).toBeNull();
  });
});
```

> If `App` pulls in heavy modules that break under jsdom, prefer extracting `ScopedShell` into its own file `src/renderer/app/ScopedShell.tsx` (exported) and test that component directly wrapped in `<AppStateProvider><RightRailProvider>…`. Extracting it is acceptable and keeps App.tsx focused. Adjust imports in App.tsx accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/app/ScopedShell.test.tsx`
Expected: FAIL — the scoped shell renders only `CommandRoom`; no switcher/rail tabs.

- [ ] **Step 3: Implement**

In `src/renderer/app/App.tsx`, add the imports (top of file, near the other right-rail imports at lines 25-28):

```tsx
import { RightRailSwitcher } from '@/renderer/features/top-bar/RightRailSwitcher';
```

Replace `ScopedShell` (lines 228-247):

```tsx
function ScopedShell() {
  const workspaceName = useAppStateSelector((s) => s.activeWorkspace?.name ?? null);
  const { enabled, ready } = useRightRailEnabled();
  const { railOpen } = useRightRail();

  useEffect(() => {
    if (workspaceName) document.title = `${workspaceName} — SigmaLink`;
  }, [workspaceName]);

  // Mirror MainBody: only wrap in the rail once the enabled flag has resolved
  // and the rail is open, so the scoped window never flashes an empty rail.
  const showRail = ready && enabled && railOpen;
  const body = (
    <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col">
      <CommandRoom />
    </main>
  );

  return (
    <div className="flex h-full w-full flex-col">
      {/* Scoped titlebar: drag region + the rail switcher (no Settings gear —
          the scoped window has no RoomSwitch to navigate to Settings). The
          switcher's own buttons use noDragStyle() so they stay clickable. */}
      <div
        className="flex h-8 shrink-0 items-center border-b border-border bg-background/60 pr-2"
        style={dragStyle()}
      >
        {ready && enabled && <RightRailSwitcher showSettings={false} />}
      </div>
      {showRail ? <RightRail>{body}</RightRail> : body}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/app/ScopedShell.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/App.tsx src/renderer/app/ScopedShell.test.tsx
git commit -m "feat(windows): mount the right-rail (Browser/Jorvis/Skills/Swarm/Sigma) in scoped workspace windows"
```

---

## Task 8: Full gate + sibling-site sweep

**Files:** none (verification)

- [ ] **Step 1: Sibling-site sweep**

Run and eyeball that no mirrored site was missed:

```bash
grep -rn "windowProvider" src/main
grep -rn "assistant:state\|assistant:tool-trace\|assistant:dispatch-echo\|assistant:pane-event\|assistant:pane-closed\|browser:state" src/main
grep -rn "RightRailSwitcher" src/renderer
grep -rn "buildDetachWorkspace\|buildRedockWorkspace" src/main
```

Expected: `windowProvider` is constructed once (rpc-router) and consumed in `manager.ts`; the `RightRailSwitcher` call in `Breadcrumb.tsx` still compiles (default `showSettings`); detach/redock builders are wired with `teardownBrowser`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: no errors (the project's `tsc -b` also typechecks test files).

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: PASS — all suites green (full run catches sibling mock breakage from the `windowProvider`/window-fake changes).

- [ ] **Step 4: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 5: Manual smoke checklist (operator/CI — do NOT run Electron locally)**

Record in the PR for the operator to verify on-device:
1. Detach a workspace (Sidebar → Open in new window). The scoped window shows a titlebar with the rail switcher (Browser/Editor/Jorvis/Skills/Swarm/Sigma), no Settings gear.
2. In the scoped window, open the Browser tab → it loads the workspace's tabs and renders the page inside THIS window (not the main window).
3. In the scoped window, open Jorvis → send a prompt that uses `launch_pane`; the new pane appears in THIS window's Command Room, and the chat stream renders here — the main window does NOT react.
4. Start a Jorvis turn in the MAIN window for its active workspace — it streams in the main window only.
5. Redock (close the scoped window / `windows.redockWorkspace`) → the workspace returns to the main window; its browser tab works there (re-hydrated from the DB). No orphaned/blank WebContentsView.

- [ ] **Step 6: Commit (if the sweep prompted any fixups)**

```bash
git add -A
git commit -m "chore(windows): gate + sibling-sweep fixups for scoped-window tools"
```

---

## Self-Review

**Spec coverage:**
- §5.1 scoped shell + rail → Task 7. ✓
- §5.1 titlebar switcher → Tasks 5 + 7. ✓
- §5.2 per-workspace tab persistence → Task 6. ✓
- §5.3 Jorvis event routing by workspace owner → Task 1 (state/tool-trace via conversation→workspace; dispatch-echo via workspaceId; pane-event/pane-closed via session→workspace). Telegram `assistantStateSubscribers` fan-out untouched (it lives in the `emit` wrapper at rpc-router.ts:2080-2106, which still calls `broadcast` + the subscriber loop). ✓
- §5.4 browser view follows its workspace → Tasks 2 (owner resolution), 3 (self-heal), 4 (teardown on detach/redock). **Refinement vs spec:** the spec proposed live re-parenting of the `WebContentsView`; planning chose **teardown + re-hydrate-from-DB** instead — simpler, avoids the destroyed-view-on-close orphan, and matches the existing terminal-cache "re-hydrate on the other side" pattern. In-page scroll/form state is not preserved across a detach/redock; tab URLs (persisted) are. This is the documented behavior. ✓
- §5.5 edge cases (browser open in main then detached; redock; direct scoped-window close; two windows) → covered by Tasks 3 + 4 and listed in the Task 8 smoke checklist. ✓
- §6 testing → Tasks 1-7 each ship tests; Task 8 runs the full gate + sibling sweep. ✓
- §7 out-of-scope (rooms/CommandPalette/VoicePill) → not touched; `showSettings={false}` keeps the scoped window from offering a dead Settings route. ✓

**Placeholder scan:** none — every code step shows the actual code; test helper caveats (`makeFakeWindow`, `makeDetachDeps`) point at named existing harnesses with a fallback instruction.

**Type consistency:** `resolveAssistantRoute`/`AssistantRoute`, `resolveBrowserHostWindowId`, `BrowserManager.isStale()`, `RegistryDeps.windowProvider(workspaceId)`, `DetachDeps.teardownBrowser`, `RightRailSwitcher({ showSettings })` are used consistently across the tasks where defined and consumed.

**Open refinement noted for review:** the browser teardown-vs-reparent decision (Task 4 / §5.4) is the one deliberate deviation from the spec; flagged above and in the smoke checklist so the reviewer can confirm the UX trade-off (URLs persist, live page state does not).
