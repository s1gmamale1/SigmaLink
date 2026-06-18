# Sigma Control Plane — Human-Parity Completeness (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Execution is in the **existing Phase-1 worktree**
> `/Users/aisigma/projects/sl-control-mcp` on branch `feat/external-control-mcp` (Phase 2 stacks as additional
> commits). Implementers edit via ABSOLUTE paths under `/Users/aisigma/projects/sl-control-mcp/app`, run **no
> git** (the controller commits + gates), and are **anonymous** (no `name:`). NEVER touch the shared tree
> `/Users/aisigma/projects/SigmaLink`.

**Goal:** Make SigmaLink a complete Unity/Blender-MCP-style control surface — an external MCP client can
perceive the whole app (`get_app_state`) and perform the core human control loop (10 new action tools), under
the Phase-1 supervised-autonomy authz.

**Architecture:** All 10 action tools follow the proven Phase-1 pattern — the tool handler `ctx.emit`s an
`assistant:*` event; a `use-live-events` subscriber calls the authoritative `rpc.*` and dispatches the reducer
action (mirrors `switch_workspace`/`focus_pane`/`open_workspace`/`close_workspace`). `get_app_state` is the
read exception: a `ctx.appState.snapshot()` provider built in `main` from DB + registries + an `AttentionDetector`
query map + a renderer→main viewport shadow. Authz: new tools default FREE (fall-through in `classifyExternal`);
`kill_swarm` is added to `EXTERNAL_ESCALATE_TOOLS` + `DANGEROUS_REMOTE`. Every new tool is pinned in the
fail-open `EXPECTED_VERDICT` and mirrored across the 3 catalogue surfaces.

**Tech Stack:** TypeScript (`erasableSyntaxOnly` — NO enums, NO constructor param-properties, NO namespaces),
Zod schemas, hand-rolled MCP catalogue, vitest (MockDb/fakes — `better-sqlite3` cannot load under vitest),
Electron main/renderer + redux reducer + IPC.

**Gate after every task (controller runs, not the implementer):**
```
cd /Users/aisigma/projects/sl-control-mcp/app
npx tsc -b
npx vitest run <touched test files>
```
Full `npx vitest run` + `npx eslint` + electron build in the final task.

---

## Task 1: AttentionDetector query map (get_app_state enabler)

**Files:**
- Modify: `src/main/core/pty/attention-detector.ts`
- Test: `src/main/core/pty/attention-detector.test.ts` (create if absent; else extend)

Today `AttentionDetector` is push-only (fires `emit` on bell/idle) with no way to ask "which panes are waiting
now?". Add a queryable last-attention map so `get_app_state` can report per-pane attention from `main`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/core/pty/attention-detector.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AttentionDetector } from './attention-detector';

function make() {
  const emitted: Array<{ id: string; reason: string }> = [];
  let t = 1000;
  const d = new AttentionDetector({
    idleMs: () => 5_000,
    emit: (id, reason) => emitted.push({ id, reason }),
    now: () => t,
  });
  return { d, emitted, tick: (ms: number) => { t += ms; } };
}

describe('AttentionDetector query map', () => {
  it('records last attention on a bell and exposes it via lastAttention()', () => {
    const { d } = make();
    d.feed('s1', ''); // BEL
    const a = d.lastAttention('s1');
    expect(a?.reason).toBe('bell');
    expect(a?.ts).toBe(1000);
    expect(d.lastAttention('nope')).toBeNull();
  });

  it('snapshot() returns every tracked session and forget() clears it', () => {
    const { d } = make();
    d.feed('s1', '');
    expect(d.snapshot().get('s1')?.reason).toBe('bell');
    d.forget('s1');
    expect(d.snapshot().has('s1')).toBe(false);
    expect(d.lastAttention('s1')).toBeNull();
  });

  it('still fires the push emit unchanged (no behaviour regression)', () => {
    const { emitted, d } = make();
    d.feed('s1', '');
    expect(emitted).toEqual([{ id: 's1', reason: 'bell' }]);
  });
});
```

- [ ] **Step 2: Run it; expect FAIL** — `lastAttention`/`snapshot` not a function.
  `npx vitest run src/main/core/pty/attention-detector.test.ts`

- [ ] **Step 3: Implement.** In `attention-detector.ts`:
  - Add field `private readonly lastAttn = new Map<string, { ts: number; reason: AttentionReason }>();`
  - Add `private now(): number { return (this.opts.now ?? Date.now)(); }`
  - Add `private record(sessionId: string, reason: AttentionReason): void { this.lastAttn.set(sessionId, { ts: this.now(), reason }); }`
  - Call `this.record(sessionId, 'bell')` immediately before `this.opts.emit(sessionId, 'bell')` in `feed`.
  - In the constructor's IdleDetector `onIdle`, wrap to record idle:
    `onIdle: (sessionId) => { this.record(sessionId, 'idle'); opts.emit(sessionId, 'idle'); }`
  - In `forget`, add `this.lastAttn.delete(sessionId);`
  - Add public accessors:
    ```ts
    lastAttention(sessionId: string): { ts: number; reason: AttentionReason } | null {
      return this.lastAttn.get(sessionId) ?? null;
    }
    snapshot(): ReadonlyMap<string, { ts: number; reason: AttentionReason }> {
      return new Map(this.lastAttn);
    }
    ```
  Keep `erasableSyntaxOnly` rules (field declared, assigned in body — no param-properties).

- [ ] **Step 4: Run the test; expect PASS.**

- [ ] **Step 5: Controller commits** `feat(control): AttentionDetector queryable last-attention map`.

---

## Task 2: Viewport shadow + reportViewport RPC (get_app_state enabler)

**Files:**
- Create: `src/main/core/control/app-state-shadow.ts`
- Test: `src/main/core/control/app-state-shadow.test.ts`
- Modify: `src/main/core/control/control-rpc.ts` (add `reportViewport`)
- Modify: `src/shared/rpc-channels.ts` (+ `rpc-channels.test.ts`), `src/shared/router-shape.ts` (add channel/shape)
- Create: `src/renderer/app/state-hooks/use-viewport-shadow.ts`
- Modify: the root state host that mounts hooks (e.g. `src/renderer/app/App.tsx`) to mount the hook

The few "what is the human looking at" facts live ONLY in the renderer redux store. A main-side shadow,
echoed by the renderer, lets `get_app_state` report them.

- [ ] **Step 1: Write the failing test (shadow)**

```ts
// src/main/core/control/app-state-shadow.test.ts
import { describe, it, expect } from 'vitest';
import { createViewportShadow } from './app-state-shadow';

describe('viewport shadow', () => {
  it('starts stale and merges patches', () => {
    const s = createViewportShadow();
    expect(s.get().viewportStale).toBe(true);
    s.report({ activeWorkspaceId: 'w1', room: 'command' });
    const v = s.get();
    expect(v.viewportStale).toBe(false);
    expect(v.activeWorkspaceId).toBe('w1');
    expect(v.room).toBe('command');
    s.report({ activeSessionId: 's1' });
    expect(s.get().activeWorkspaceId).toBe('w1'); // prior fields retained
    expect(s.get().activeSessionId).toBe('s1');
  });
});
```

- [ ] **Step 2: Run; expect FAIL.** `npx vitest run src/main/core/control/app-state-shadow.test.ts`

- [ ] **Step 3: Implement `app-state-shadow.ts`**

```ts
// src/main/core/control/app-state-shadow.ts
//
// Main-side mirror of the few renderer-only "what is the human looking at"
// facts. The renderer echoes changes via rpc.control.reportViewport; get_app_state
// reads this. Stale across process reload — surfaced via viewportStale.

export interface ViewportShadow {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  focusedPaneId: string | null;
  room: string | null;
  activeSwarmId: string | null;
  viewportStale: boolean;
}

export type ViewportPatch = Partial<Omit<ViewportShadow, 'viewportStale'>>;

export interface ViewportShadowHandle {
  get(): ViewportShadow;
  report(patch: ViewportPatch): void;
}

export function createViewportShadow(): ViewportShadowHandle {
  const state: ViewportShadow = {
    activeWorkspaceId: null, activeSessionId: null, focusedPaneId: null,
    room: null, activeSwarmId: null, viewportStale: true,
  };
  return {
    get: () => ({ ...state }),
    report: (patch) => {
      if (patch.activeWorkspaceId !== undefined) state.activeWorkspaceId = patch.activeWorkspaceId;
      if (patch.activeSessionId !== undefined) state.activeSessionId = patch.activeSessionId;
      if (patch.focusedPaneId !== undefined) state.focusedPaneId = patch.focusedPaneId;
      if (patch.room !== undefined) state.room = patch.room;
      if (patch.activeSwarmId !== undefined) state.activeSwarmId = patch.activeSwarmId;
      state.viewportStale = false;
    },
  };
}
```

- [ ] **Step 4: Run; expect PASS.**

- [ ] **Step 5: Wire `reportViewport` into the control RPC.** In `control-rpc.ts`:
  - Add to `ControlRpcDeps`: `reportViewport: (patch: import('./app-state-shadow').ViewportPatch) => void;`
  - Add to the returned object:
    ```ts
    reportViewport: async (patch: import('./app-state-shadow').ViewportPatch): Promise<{ ok: boolean }> => {
      deps.reportViewport(patch); return { ok: true };
    },
    ```
  - Add the channel `control.reportViewport` to `src/shared/rpc-channels.ts` (mirror the other `control.*`
    entries) and update `rpc-channels.test.ts` count/membership. Add the method shape to
    `src/shared/router-shape.ts`'s `control` namespace: `reportViewport(patch: ViewportPatch): Promise<{ ok: boolean }>`.

- [ ] **Step 6: Renderer echo hook.** Create `use-viewport-shadow.ts`:
  - Read the six fields from app state: `activeWorkspaceId`, `activeSessionId`, `focusedPaneId`, `room`,
    `activeSwarmId` (and derive nothing else). Use a `useEffect` keyed on those values that calls
    `rpc.control.reportViewport({ activeWorkspaceId, activeSessionId, focusedPaneId, room, activeSwarmId })`.
    Best-effort: wrap in try/catch; never throw. (Mirror an existing simple state-hook in
    `src/renderer/app/state-hooks/` for the `useAppState()` access + rpc import.)
  - Mount it once in the root host (where other top-level hooks like `use-live-events` are mounted).

- [ ] **Step 7: Gate** `npx tsc -b` + the new tests + `rpc-channels.test.ts`. Controller commits
  `feat(control): renderer→main viewport shadow + reportViewport RPC`.

---

## Task 3: get_app_state snapshot builder

**Files:**
- Create: `src/main/core/control/app-state.ts`
- Test: `src/main/core/control/app-state.test.ts`

A pure-ish builder assembling the §4.1 snapshot from injected sources. NO electron import; NO real DB (so the
test runs under vitest). All sources are passed in as a deps object → fully fakeable.

- [ ] **Step 1: Write the failing test** — construct `buildAppState(fakeDeps, { workspaceId: 'w1' })` with fake
  sources (one workspace, two sessions one with attention, one swarm, no browser, two notifications, a warm
  viewport shadow) and assert: `workspaces.all` length, `openIds`, `activeId` from shadow, `panes.sessions`
  fields incl. `attentionTs` for the flagged session and `null` for the other, `gridShape` from ordered
  `paneIndex`, `swarms[0].agentCount`, `browser` is null, `notifications.unreadCount`, `viewportStale:false`.
  Add a second test: empty/missing sub-sources degrade (no workspace panes → `sessions: []`; shadow never
  reported → `viewportStale:true`, viewport fields null) and never throw.

- [ ] **Step 2: Run; expect FAIL.** `npx vitest run src/main/core/control/app-state.test.ts`

- [ ] **Step 3: Implement `app-state.ts`.** Define `AppStateSnapshot` (the §4.1 shape) and:

```ts
export interface AppStateDeps {
  listWorkspaces: () => Array<{ id: string; name: string; rootPath: string; repoRoot: string | null; repoMode: string; lastOpenedAt: number }>;
  getOpenWorkspaceIds: () => string[];
  windowScopes: () => Array<{ windowId: number; isMain: boolean; workspaceIds: string[] }>;
  listSessions: (workspaceId: string) => Array<RawSession>;          // ordered by pane_index
  ptyAlive: (sessionId: string) => { alive: boolean; pid: number | null };
  attention: () => ReadonlyMap<string, { ts: number; reason: string }>;
  listSwarms: (workspaceId: string) => Array<RawSwarm>;
  browserState: (workspaceId: string) => RawBrowser | null;          // null if no manager
  notifications: () => { unreadCount: number; recent: Array<RawNotif> };
  viewport: () => import('./app-state-shadow').ViewportShadow;
  derivePaneName: (s: { id: string; name: string | null }) => string; // shared/agent-identity
  shapeSignature: (orderedIds: string[]) => string;                   // shared/pane-grid-shape
}
export function buildAppState(deps: AppStateDeps, opts: { workspaceId?: string; allWorkspaces?: boolean }): AppStateSnapshot { ... }
```

  - Resolve the target workspace = `opts.workspaceId ?? viewport().activeWorkspaceId ?? getOpenWorkspaceIds()[0]`.
  - `workspaces.attention` and per-session `attentionTs` come from `attention()` (a `Map`); for a session id
    not in the map → `null`.
  - Wrap EACH sub-source read in try/catch so one failing source degrades its section (`browser:null`,
    `sessions:[]`, `notifications:{unreadCount:0,recent:[]}`) and never throws the whole snapshot.
  - `capturedAt: (deps as any).now?.() ?? Date.now()` — accept an optional `now` for deterministic tests
    (add `now?: () => number` to `AppStateDeps`).
  - Use the real shared helpers `derivePaneName` (`shared/agent-identity.ts`) and `shapeSignature`
    (`shared/pane-grid-shape.ts`) — passed in as deps so the test can pass the real pure fns.

- [ ] **Step 4: Run; expect PASS.**

- [ ] **Step 5: Controller commits** `feat(control): get_app_state snapshot builder (buildAppState)`.

---

## Task 4: get_app_state tool + ctx.appState injection

**Files:**
- Modify: `src/main/core/assistant/tools.ts` (ToolContext += appState; add the `get_app_state` tool)
- Modify: `src/main/core/assistant/tool-catalogue.ts` (add entry)
- Modify: `src/main/core/assistant/system-prompt.ts` (add blurb line)
- Modify: `src/main/core/control/authz-external.test.ts` (`EXPECTED_VERDICT.get_app_state = 'free'`)
- Modify: `src/main/rpc-router.ts` (build the `appState` provider from in-scope sources; inject into the tool ctx)
- Test: `src/main/core/assistant/tool-catalogue.test.ts` (parity auto-covers via its loop), `authz-external.test.ts`

- [ ] **Step 1: Failing test** — extend `authz-external.test.ts` `EXPECTED_VERDICT` with `get_app_state: 'free'`.
  Run `npx vitest run src/main/core/control/authz-external.test.ts` → FAILS the "every catalogue tool pinned"
  test once the catalogue entry is added (Step 3) but pin is missing, OR the "no stale pin" test if pin added
  first. (This is the fail-open guard doing its job.)

- [ ] **Step 2: ToolContext + tool.** In `tools.ts`:
  - Add to `ToolContext`:
    ```ts
    /** get_app_state — holistic app snapshot provider (built in the router). */
    appState?: { snapshot(opts: { workspaceId?: string; allWorkspaces?: boolean }): unknown };
    ```
  - Add a zod schema `const sGetAppState = z.object({ workspaceId: z.string().optional(), allWorkspaces: z.boolean().optional() });`
    near the other `s*` schemas.
  - Add the tool (place beside the other read tools):
    ```ts
    T(
      'get_app_state',
      'Get app state',
      'Return a holistic snapshot of SigmaLink: workspaces (open/active/detached), panes (per-pane provider/label/cwd/status/attention/split), grid shape, swarms, browser tabs, notifications, windows. The "look at the screen" tool — call this to orient before acting.',
      { type: 'object', properties: { workspaceId: { type: 'string' }, allWorkspaces: { type: 'boolean' } } },
      sGetAppState,
      async (a, ctx) => {
        if (!ctx.appState) return { ok: false, error: 'app-state unavailable' };
        return { ok: true, state: ctx.appState.snapshot({ workspaceId: a.workspaceId, allWorkspaces: a.allWorkspaces === true }) };
      },
    ),
    ```

- [ ] **Step 3: Catalogue + blurb.** Add to `tool-catalogue.ts`:
  ```ts
  {
    name: 'get_app_state',
    description: 'Holistic snapshot of the app: workspaces, panes (provider/label/cwd/status/attention/split), grid shape, swarms, browser, notifications, windows. The "look at the screen" tool.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' }, allWorkspaces: { type: 'boolean' } } },
  },
  ```
  Add a `TOOL_BLURB` line in `system-prompt.ts` (in the read-tools area):
  ```
  get_app_state       { workspaceId?, allWorkspaces? }
                      Holistic snapshot: workspaces, panes, grid, swarms,
                      browser, notifications, windows. Orient before acting.
  ```

- [ ] **Step 4: Wire the provider in `rpc-router.ts`.** Where the assistant tool `ctx` is assembled (the same
  place Phase 1 injected `promptSink`), construct:
  ```ts
  const appStateProvider = {
    snapshot: (opts: { workspaceId?: string; allWorkspaces?: boolean }) =>
      buildAppState({
        listWorkspaces: () => /* drizzle select from workspaces, map fields */,
        getOpenWorkspaceIds: () => getOpenWorkspaceIds(),
        windowScopes: () => getWindowRegistry().scopes(),
        listSessions: (wsId) => /* the panes.listForWorkspace query (rpc-router.ts:1463-1520), ordered by pane_index */,
        ptyAlive: (sid) => { const r = sharedDeps.pty.list().find(x => x.id === sid); return { alive: !!r?.alive, pid: r?.pid ?? null }; },
        attention: () => attentionDetector.snapshot(),
        listSwarms: (wsId) => listSwarmsForWorkspace(wsId),
        browserState: (wsId) => browserRegistry.has(wsId) ? browserRegistry.get(wsId).getState() : null,
        notifications: () => ({ unreadCount: notificationsManager.unreadCount(), recent: notificationsManager.list({ limit: 10 }) }),
        viewport: () => viewportShadow.get(),
        derivePaneName,
        shapeSignature,
      }, opts),
  };
  ```
  Add `appState: appStateProvider` to the ctx object passed to `invokeAssistantTool`/the tool host. Reference
  the exact source identifiers already imported/constructed in `rpc-router.ts` (this is integration glue — the
  implementer wires to the real symbols; mirror how `promptSink` and `attentionDetector` are already in scope).

- [ ] **Step 5: Gate.** `npx tsc -b` + `npx vitest run src/main/core/assistant/tool-catalogue.test.ts src/main/core/control/authz-external.test.ts`. Controller commits
  `feat(control): get_app_state tool + ctx.appState provider`.

---

## Task 5: Pane action tools — stop_pane, split_pane, set_pane_minimised, set_pane_display_provider

**Files:**
- Modify: `tools.ts` (4 tools, all emit), `tool-catalogue.ts` (4 entries), `system-prompt.ts` (4 blurbs)
- Modify: `src/main/core/control/authz-external.test.ts` (4 pins, all `'free'`)
- Modify: `src/renderer/app/state-hooks/use-live-events.ts` (4 subscribers)
- Test: `authz-external.test.ts`, `tool-catalogue.test.ts`

Pattern per tool (mirror `set_pane_label`/`focus_pane` at `tools.ts:1044-1082`): handler `ctx.emit('assistant:<x>', payload)` + `return { ok: true, ... }`.

| Tool | args | emit event | use-live-events subscriber action |
|------|------|-----------|-----------------------------------|
| `stop_pane` | `{ sessionId }` | `assistant:stop-pane` `{sessionId}` | `rpc.pty.kill(sessionId)` (mirror PaneHeader "Stop"; exit plumbing updates UI) |
| `split_pane` | `{ paneId, direction, provider }` | `assistant:split-pane` `{paneId,direction,provider}` | `rpc.swarms.splitPane({paneId,direction,provider})` + dispatch `SPLIT_PANE` (mirror the CommandRoom/PaneHeader split handler) |
| `set_pane_minimised` | `{ paneId, minimised }` | `assistant:set-pane-minimised` `{paneId,minimised}` | `rpc.swarms.minimisePane({paneId,minimised})` + dispatch `MINIMISE_PANE` |
| `set_pane_display_provider` | `{ sessionId, displayProviderId }` | `assistant:set-display-provider` `{sessionId,displayProviderId}` | `rpc.panes.setDisplayProvider({sessionId,displayProviderId})` + dispatch the same action PaneGearPopover uses (broadcast `panes:display-provider-changed` already refreshes; mirror PaneGearPopover.tsx:55) |

- [ ] **Step 1: Failing test** — add the 4 pins to `EXPECTED_VERDICT` (all `'free'`); run `authz-external.test.ts`
  (fails until catalogue entries exist — fail-open guard).
- [ ] **Step 2:** Add the 4 zod schemas + 4 tools in `tools.ts` (emit pattern above).
- [ ] **Step 3:** Add the 4 catalogue entries (exact arg schemas: `split_pane` required `['paneId','direction','provider']`
  with `direction` enum `['horizontal','vertical']`; `set_pane_minimised` required `['paneId','minimised']`;
  `stop_pane` required `['sessionId']`; `set_pane_display_provider` required `['sessionId','displayProviderId']`)
  + 4 blurb lines.
- [ ] **Step 4:** Add the 4 `use-live-events` subscribers, mirroring the existing Phase-1 subscribers
  (`assistant:switch-workspace`, `assistant:focus-pane` etc.) for the `eventOn` + `dispatch`/`rpc` shape. Read
  the existing renderer call sites named in the table to copy the correct rpc args + reducer action.
  **Multi-window note:** these are workspace/pane-scoped; verify whether they need adding to
  `SESSION_ROUTED_EVENTS` (rpc-router.ts:237) so they route to the owning window — pane-scoped events that must
  reach the pane's window do (mirror how `focus_pane`'s event is routed). Add an EVENTS-allowlist guard test if
  a new routed event is introduced.
- [ ] **Step 5:** Run `npx vitest run src/main/core/control/authz-external.test.ts src/main/core/assistant/tool-catalogue.test.ts` + the use-live-events test file if present. Controller commits
  `feat(control): pane control tools (stop/split/minimise/relabel) + subscribers`.

---

## Task 6: Workspace/window action tools — rename_workspace, detach_window, redock_window

**Files:** same set as Task 5 (tools/catalogue/blurb/authz-test/use-live-events).

| Tool | args | emit event | subscriber action |
|------|------|-----------|-------------------|
| `rename_workspace` | `{ workspaceId, name }` | `assistant:rename-workspace` `{workspaceId,name}` | `rpc.workspaces.rename({id:workspaceId,name})` + dispatch `RENAME_WORKSPACE` (mirror Sidebar.tsx:401) |
| `detach_window` | `{ workspaceId }` | `assistant:detach-window` `{workspaceId}` | `rpc.windows.detachWorkspace({workspaceId})` (mirror Sidebar.tsx:385) |
| `redock_window` | `{ workspaceId }` | `assistant:redock-window` `{workspaceId}` | `rpc.windows.redockWorkspace({workspaceId})` |

- [ ] **Step 1:** Add 3 pins (`'free'`) to `EXPECTED_VERDICT`; run → fail-open guard fails until catalogue added.
- [ ] **Step 2:** 3 zod schemas + 3 tools (emit pattern). All required: `rename_workspace`→`['workspaceId','name']`;
  detach/redock→`['workspaceId']`.
- [ ] **Step 3:** 3 catalogue entries + 3 blurb lines.
- [ ] **Step 4:** 3 use-live-events subscribers (mirror Sidebar call sites named above).
- [ ] **Step 5:** Run the authz + parity tests. Controller commits
  `feat(control): workspace rename + window detach/redock tools + subscribers`.

---

## Task 7: Swarm action tools — send_message_to_agent, resume_swarm, kill_swarm (+ escalation wiring)

**Files:** tools/catalogue/blurb/use-live-events as before, PLUS:
- Modify: `src/main/core/control/authz-external.ts` (`EXTERNAL_ESCALATE_TOOLS` += `kill_swarm`)
- Modify: `src/main/core/assistant/tools.ts` (`DANGEROUS_REMOTE` += `kill_swarm`, line ~1257)
- Modify: `src/main/core/assistant/authorization.test.ts` (DANGEROUS_REMOTE strict membership)
- Modify: `authz-external.test.ts` (3 pins: send/resume=`'free'`, kill=`'escalate'`; AND the
  `EXTERNAL_ESCALATE_TOOLS` `toEqual` membership test → `['browser_navigate','close_pane','close_workspace','kill_swarm']`)

| Tool | args | emit event | subscriber action | authz |
|------|------|-----------|-------------------|-------|
| `send_message_to_agent` | `{ swarmId, toAgent, body, kind? }` | `assistant:swarm-message` `{...}` | `rpc.swarms.sendMessage({swarmId,toAgent,body,kind})` (mirror the Swarm room DM send) | FREE |
| `resume_swarm` | `{ swarmId }` | `assistant:resume-swarm` `{swarmId}` | `rpc.swarms.resume(swarmId)` + refetch swarms | FREE |
| `kill_swarm` | `{ swarmId }` | `assistant:kill-swarm` `{swarmId}` | `rpc.swarms.kill(swarmId)` + refetch/dispatch | **ESCALATE** |

- [ ] **Step 1: Failing tests** — update `authz-external.test.ts`: add 3 `EXPECTED_VERDICT` pins; change the
  `EXTERNAL_ESCALATE_TOOLS` membership `toEqual` to include `kill_swarm`; add an explicit case
  `classifyExternal({toolId:'kill_swarm',targetProvider:null,killSwitch:false})` → `'escalate'`. Update
  `authorization.test.ts` DANGEROUS_REMOTE `toEqual` to include `kill_swarm`. Run both → FAIL.
- [ ] **Step 2:** `authz-external.ts`: add `'kill_swarm'` to `EXTERNAL_ESCALATE_TOOLS`. `tools.ts`: add
  `'kill_swarm'` to `DANGEROUS_REMOTE`.
- [ ] **Step 3:** 3 zod schemas + 3 tools (emit). Required: `send_message_to_agent`→`['swarmId','toAgent','body']`
  (`kind` optional); resume/kill→`['swarmId']`.
- [ ] **Step 4:** 3 catalogue entries + 3 blurb lines (note kill_swarm blurb: "Destructive — requires operator
  approval.").
- [ ] **Step 5:** 3 use-live-events subscribers.
- [ ] **Step 6:** Run `npx vitest run src/main/core/control/authz-external.test.ts src/main/core/assistant/authorization.test.ts src/main/core/assistant/tool-catalogue.test.ts` → PASS. Controller commits
  `feat(control): swarm DM/resume/kill tools; kill_swarm escalates + telegram-gated`.

---

## Task 8: Final parity, authz, and full gate

**Files:** none new — verification + any drift fixes.

- [ ] **Step 1:** Confirm all 11 new tools are present in **all three** mirrors (`tools.ts`, `tool-catalogue.ts`,
  `system-prompt.ts`) and pinned in `EXPECTED_VERDICT` (10 actions + `get_app_state`). The fail-open "every
  catalogue tool pinned" + "no stale pin" tests must be green.
- [ ] **Step 2:** Run the FULL suite (catches sibling/mock breakage):
  `cd /Users/aisigma/projects/sl-control-mcp/app && npx vitest run`
- [ ] **Step 3:** `npx tsc -b` (clean for ALL files incl. tests) + `npx eslint <changed files>`.
- [ ] **Step 4:** Electron build sanity (the stdio bridge bundle must still build):
  `node scripts/build-electron.cjs` → confirm `electron-dist/` outputs incl. `mcp-sigma-control-server.cjs`.
- [ ] **Step 5:** Dispatch a final READ-ONLY code-review subagent over the whole Phase-2 diff
  (`git diff fb98971..HEAD`) — focus: 3-mirror parity, authz fail-open coverage, multi-window event routing
  for the new `assistant:*` events (the `SESSION_ROUTED_EVENTS`/`agent:attention`-drop lesson), and
  emit→subscriber arg agreement (grep-sibling lesson). Controller addresses findings, then this phase is ready
  to land with Phase 1.

---

## Self-Review (controller, against the spec)

- **Spec coverage:** Task 3+4 = `get_app_state` (§4); Tasks 5–7 = the 10 action tools (§5); Task 7 = authz
  escalation (§6); Task 1 = attention enabler, Task 2 = viewport enabler (§4.2); Task 8 = parity + testing (§7,§8).
  All spec sections map to a task.
- **No placeholders:** every task names exact files, the RPC/reducer to wrap, the emit event, the authz verdict,
  and the test. The repetitive tool bodies reference the canonical Phase-1 tool (`set_pane_label`/`focus_pane`)
  + the exact renderer call site to mirror — concrete, not vague.
- **Type consistency:** tool arg names match the underlying RPCs from the audit (`split_pane`/`set_pane_minimised`
  use `paneId`; `stop_pane`/`set_pane_display_provider` use `sessionId`; `rpc.workspaces.rename` takes `{id,name}`
  so the subscriber maps `workspaceId→id`). `EXTERNAL_ESCALATE_TOOLS` final membership and `DANGEROUS_REMOTE`
  final membership are stated explicitly in Task 7.
