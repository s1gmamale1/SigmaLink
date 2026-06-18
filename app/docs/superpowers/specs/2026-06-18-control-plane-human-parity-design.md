# Sigma Control Plane — Human-Parity Completeness (Phase 2) — Design

**Date:** 2026-06-18
**Status:** Approved direction (brainstorming). Standing authorization to proceed to plan + execute.
**Owner:** Operator (arifkhodjaev98)
**Builds on:** Phase 1 (`feat/external-control-mcp`) — the external Control MCP Host, `origin:'external'`
provider-aware authz, stdio bridge, escalation seam, and the first 8 control tools.

## 1. Reframe & Goal

**SigmaLink is a pure MCP surface — it does not host or run any agent brain.** Per the operator
(2026-06-18): *"It shouldn't matter or care how Hermes/OpenClaw runs where — it shouldn't even know they
exist. Just expose endpoints + tools for full control. Treat it like Unity MCP / Blender MCP for agents."*

Consequently the **Hermes runtime** (managed child process, mission store, Hermes control room) from the
earlier combined spec §7 is **dropped from SigmaLink's scope** — the brain is external and runs separately.

The goal of Phase 2 is **human-parity control**: *"use SigmaLink instead of me."* An external MCP client
must be able to **do** everything a human operator can do in the UI, and **see** everything a human sees.
The Unity/Blender-MCP pattern always pairs the action tools with a `get_scene_state` perception tool — so the
keystone of Phase 2 is a single holistic **`get_app_state`** snapshot, plus a curated set of action tools that
close the highest-value gaps between the human UI and the existing 27-tool surface.

## 2. Scope (operator-locked: **core only**)

**In scope (this spec):**
1. `get_app_state` — the holistic "look at the screen" observation tool.
2. Ten core parity action tools (§5).
3. Authorization classification + fail-open pinning for every new tool (§6).
4. Two main-side enablers for `get_app_state`: an `AttentionDetector` query map and a renderer→main viewport
   shadow (§4).

**Deferred (explicitly NOT built now — listed so the operator can pull any forward later):**
- **Git mutations:** worktree create/remove, `switch_branch`, checkpoint create/restore, `commit_and_merge`
  (all ESCALATE-class — they rewind working trees or write history).
- **Arbitrary write/exec → DENY for external:** `fs.writeFile`, `run_git_command` (the external agent has its
  own file tools, or drives a shell pane, which already escalates).
- **Tasks mutation** (update/setStatus/assign/comment), **Memory mutation** (update/append/delete).
- **Browser lifecycle** (open/close tab, back/forward/reload, switch tab, claim/release driver) — behind the
  existing agent-driving feature gate.
- Notifications mutation, settings/KV/theme, `app.openShell`, replay scrub/bookmark, `brief_pane`, resize-grid.

**Non-goals:** any Hermes/mission/brain code in SigmaLink; remote/network transport (Phase 3, separate spec).

## 3. Ground Truth (confirmed by audit 2026-06-18)

All control operations already exist as `rpc.*` methods or reducer actions; Phase 2 wraps them as tools and
adds one read aggregator. **~90% of observable screen state is already reachable from `main`** (DB +
registries); only the live "viewport" (what the human is currently looking at) and per-pane attention need a
thin bridge.

Key reused entry points (file:line in the `feat/external-control-mcp` worktree):
- `swarms/controller.ts`: `splitPane`:230, `minimisePane`:292, `kill`:184, `resume`:197, `sendMessage`:85.
- `rpc-router.ts`: `panes.setDisplayProvider`:1529, `workspaces.rename`:1763, `windows.detachWorkspace`:1798,
  `windows.redockWorkspace`:1813, `pty.kill`:1222, `panes.listForWorkspace`:1463–1520.
- Read sources for `get_app_state`: `getOpenWorkspaceIds()` (`core/workspaces/lifecycle.ts:72`),
  `WindowRegistry.scopes()` (`core/windows/registry.ts:132`), `pty.list()` (`core/pty/registry.ts`),
  `listSwarmsForWorkspace()` (`core/swarms/factory.ts`), `browserRegistry.get(wsId).getState()`
  (`core/browser/manager.ts:544`), `notificationsManager.list()/unreadCount()`,
  `derivePaneName()` (`shared/agent-identity.ts:47`).
- Attention: `AttentionDetector` constructed at `rpc-router.ts:660`, fires `agent:attention` IPC at
  `rpc-router.ts:663`; reason type `AttentionReason = 'bell'|'idle'` (`core/pty/attention-detector.ts:5`).
  **It is push-only — no query API today.**
- Renderer viewport state (renderer-only): `SET_ACTIVE_WORKSPACE_ID`, `SET_ACTIVE_SESSION`, `SET_ROOM`,
  `FOCUS_PANE`/`UNFOCUS_PANE`, `SET_ACTIVE_SWARM`, `SET_ATTENTION` (`state.types.ts` / `state.reducer.ts`).

## 4. `get_app_state` — the keystone observation tool

A single FREE tool returning one holistic snapshot, assembled in `main` from DB + registries. New file
`src/main/core/control/app-state.ts` exports a pure-ish builder `buildAppState(deps): AppStateSnapshot`.

### 4.1 Return shape (TypeScript-ish; trimmed for the tool boundary)
```ts
interface AppStateSnapshot {
  capturedAt: number;
  viewportStale: boolean;            // true if the renderer shadow has never reported
  workspaces: {
    all: Array<{ id; name; rootPath; repoRoot; repoMode; lastOpenedAt }>;
    openIds: string[];               // getOpenWorkspaceIds() — main
    activeId: string | null;         // viewport shadow
    detachedIds: string[];           // WindowRegistry.scopes().filter(!isMain) — main
    attention: Record<string, number>; // workspaceId → ts; from AttentionDetector query map — main
  };
  currentView: { room: string | null; activeSwarmId: string | null }; // viewport shadow
  panes: {
    activeSessionId: string | null;  // viewport shadow
    focusedPaneId: string | null;    // viewport shadow (fullscreen)
    gridShape: string;               // shapeSignature(orderedSessionIds)
    orderedSessionIds: string[];     // agent_sessions.pane_index order — main
    sessions: Array<{
      sessionId; workspaceId; paneIndex; displayName; operatorName;
      providerId; displayProviderId; cwd; branch; worktreePath;
      dbStatus: 'starting'|'running'|'exited'|'error'; ptyAlive: boolean; pid: number|null;
      exitCode; startedAt; exitedAt;
      minimised; splitGroupId; splitDirection; splitIndex;
      attentionTs: number | null;    // AttentionDetector query map — main
      swarmId; agentKey; swarmRole;
    }>;
  };
  swarms: Array<{ swarmId; name; mission; preset; status; createdAt; endedAt; agentCount;
                  agents: Array<{ agentKey; role; roleIndex; status; sessionId; providerId }> }>;
  browser: null | { available; activeTabId; lockOwner; detached;
                    tabs: Array<{ id; url; title; active; createdAt; lastVisitedAt }> };
  notifications: { unreadCount: number; recent: Array<{ id; kind; severity; title; body; workspaceId; createdAt; readAt }> };
  windows: Array<{ windowId; isMain; workspaceIds: string[] }>;
}
```
**Default scope:** the snapshot is scoped to the **active workspace** for `panes`/`swarms`/`browser` (the
agent can pass `workspaceId` to target another, or `allWorkspaces:true` for a fuller dump). `workspaces`,
`windows`, `notifications` are always global.

### 4.2 Two main-side enablers
1. **`AttentionDetector` query map** (`core/pty/attention-detector.ts`): add a private
   `Map<sessionId, { ts: number; reason: AttentionReason }>` updated wherever it currently fires
   `agent:attention`, cleared on the existing clear/forget path. Expose `snapshot(): Map<...>` (or
   `lastAttention(sessionId)`). This makes "which panes are waiting" answerable on demand — the single most
   valuable datum for an unattended supervisor. **Additive, no behavior change to the push path.**
2. **Viewport shadow** (`core/control/app-state-shadow.ts`): a tiny main-side mutable record
   `{ activeWorkspaceId, activeSessionId, focusedPaneId, room, activeSwarmId, lastReportAt }`. Updated via a
   new always-on RPC `rpc.control.reportViewport(patch)` (not behind the control-enabled gate — it only writes
   a local map). A renderer hook `src/renderer/app/state-hooks/use-viewport-shadow.ts` watches the six state
   fields and calls `rpc.control.reportViewport({...})` whenever they change. `viewportStale` is
   `lastReportAt === null`. Stale-across-reload is acceptable and surfaced via the flag.

## 5. New action tools (10 core)

Each tool: a Zod schema + handler in `tools.ts`, a `JorvisCatalogueEntry` in `tool-catalogue.ts`, a
`TOOL_BLURB` line in `system-prompt.ts` (3-mirror parity, enforced by `tool-catalogue.test.ts`), and a pinned
verdict in `authz-external.test.ts`.

| Tool | Args | Effect (wraps) | Authz (external) |
|------|------|----------------|------------------|
| `stop_pane` | `sessionId` | `pty.kill` — stop the process, **keep the pane** in the grid (recoverable). | FREE |
| `split_pane` | `paneId`, `direction:'horizontal'\|'vertical'`, `provider` | `swarms.splitPane` | FREE |
| `set_pane_minimised` | `paneId`, `minimised:boolean` | `swarms.minimisePane` | FREE |
| `set_pane_display_provider` | `sessionId`, `displayProviderId` | `panes.setDisplayProvider` (cosmetic relabel) | FREE |
| `rename_workspace` | `workspaceId`, `name` | `workspaces.rename` | FREE |
| `detach_window` | `workspaceId` | `windows.detachWorkspace` | FREE |
| `redock_window` | `workspaceId` | `windows.redockWorkspace` | FREE |
| `send_message_to_agent` | `swarmId`, `toAgent`, `body`, `kind?` | `swarms.sendMessage` — targeted DM to one swarm agent (the CRITICAL gap; broadcast-only today) | FREE |
| `resume_swarm` | `swarmId` | `swarms.resume` — heal a failed/paused swarm | FREE |
| `kill_swarm` | `swarmId` | `swarms.kill` — irreversible teardown of all the swarm's panes | **ESCALATE** |

Notes:
- `stop_pane` is FREE because it is recoverable (pane + scrollback remain; relaunchable). It is distinct from
  `close_pane` (ESCALATE — removes + destroys).
- `send_message_to_agent` is FREE (and **not** provider-gated): swarm agents are agent CLIs by construction,
  and the message goes to the swarm mailbox/pane echo, not a raw shell PTY write.
- `kill_swarm` mirrors `close_workspace`: irreversible multi-pane teardown → ESCALATE + telegram gate.
- `get_app_state` (§4) is FREE (pure read).

## 6. Authorization integration

`classifyExternal({ toolId, targetProvider, killSwitch })` is unchanged in shape. Changes:
- **`EXTERNAL_ESCALATE_TOOLS`** gains `kill_swarm` → `['browser_navigate','close_pane','close_workspace','kill_swarm']`.
- All other new tools + `get_app_state` are **FREE** by falling through (kill-switch still denies them first).
- **`DANGEROUS_REMOTE`** (telegram gate, `tools.ts`) gains `kill_swarm` →
  `['close_pane','close_workspace','kill_swarm','prompt_agent']`. `authorization.test.ts` strict membership
  assertion updated.
- **Fail-open guard** (`authz-external.test.ts` `EXPECTED_VERDICT`): add a pinned verdict for **every** new tool
  (`get_app_state`, `stop_pane`, `split_pane`, `set_pane_minimised`, `set_pane_display_provider`,
  `rename_workspace`, `detach_window`, `redock_window`, `send_message_to_agent`, `resume_swarm`,
  `kill_swarm`). The existing "every catalogue tool has a pinned verdict" + "no stale pinned verdicts" tests
  guarantee no new tool can silently default to FREE and no pin can dangle.

`PROVIDER_GATED_TOOLS` and the `origin:'local'|'telegram'` behavior are untouched.

## 7. Catalogue / parity (3 mirrors)

Every new tool added to **all three**: `tools.ts` (`TOOLS` handler), `tool-catalogue.ts`
(`JORVIS_TOOL_CATALOGUE` pure-data entry), `system-prompt.ts` (`TOOL_BLURB`). The strict-MCP catalogue is the
only callable surface for an external client — a missing mirror is a silent, untraceable tool failure.
`tool-catalogue.test.ts` enforces name/required/property agreement across the three.

## 8. Testing

- **Catalogue parity** (`tool-catalogue.test.ts`): all 11 new entries (10 actions + `get_app_state`) present + agreeing in all 3 mirrors.
- **Authz** (`authz-external.test.ts`): `kill_swarm` = escalate; the other 9 + `get_app_state` = free;
  kill-switch denies all; **membership regression** for `EXTERNAL_ESCALATE_TOOLS` (exact `toEqual`); the
  fail-open "every catalogue tool pinned" + "no stale pin" tests cover the new tools automatically.
- **DANGEROUS_REMOTE** (`authorization.test.ts`): strict `toEqual` membership updated to include `kill_swarm`.
- **`get_app_state` builder** (`app-state.test.ts`): with a MockDb + fake registries, asserts the assembled
  snapshot shape — workspace/pane/swarm/browser/notification fields, `gridShape` from ordered pane_index,
  `attentionTs` populated from a fake attention map, `viewportStale:true` when the shadow is empty and the
  reported values when it is warm. **No real `better-sqlite3`** (Electron ABI — use MockDb/fakes).
- **Attention query map** (`attention-detector.test.ts`): a fed bell/idle updates `lastAttention`; the clear
  path removes it; the push (`agent:attention`) still fires unchanged.
- **Viewport shadow** (`app-state-shadow.test.ts`): `reportViewport(patch)` merges; `viewportStale` flips
  after the first report.
- **Tool handlers**: each new tool handler calls its underlying controller with the mapped args (mock the
  controllers; assert the call + the `ok:true/false` envelope).
- **E2E:** deferred to CI (`tests/e2e/`) — never run a live Electron app locally.

## 9. Error Handling

- Tools return `ok:false` on failure — never silent (strict-MCP lesson). A new tool fails loudly if its
  required `ctx` dependency (controller / `emit`) is missing.
- `get_app_state` is defensive: a missing browser manager → `browser:null`; a workspace with no panes → empty
  `sessions`; an unreadable sub-source degrades that section, never throws the whole snapshot.
- `reportViewport` is best-effort and never blocks a renderer dispatch.
- Kill-switch + escalation timeout/channel-down behavior is inherited unchanged from Phase 1 (fail-closed).

## 10. File Plan (informs the implementation plan)

**New:**
- `src/main/core/control/app-state.ts` — `buildAppState(deps)` snapshot assembler.
- `src/main/core/control/app-state-shadow.ts` — viewport shadow record + merge.
- `src/main/core/control/app-state.test.ts`, `app-state-shadow.test.ts`.
- `src/renderer/app/state-hooks/use-viewport-shadow.ts` — renderer echo hook.

**Modified:**
- `src/main/core/assistant/tools.ts` — 11 new handlers (10 actions + `get_app_state`); `DANGEROUS_REMOTE` += `kill_swarm`.
- `src/main/core/assistant/tool-catalogue.ts` — 11 new catalogue entries.
- `src/main/core/assistant/system-prompt.ts` — 11 new `TOOL_BLURB` lines.
- `src/main/core/control/authz-external.ts` — `EXTERNAL_ESCALATE_TOOLS` += `kill_swarm`.
- `src/main/core/control/authz-external.test.ts` — `EXPECTED_VERDICT` += 11 pins.
- `src/main/core/assistant/authorization.test.ts` — `DANGEROUS_REMOTE` membership.
- `src/main/core/assistant/tool-catalogue.test.ts` — parity coverage (auto via the loop).
- `src/main/core/pty/attention-detector.ts` (+ test) — query map.
- `src/main/core/control/control-rpc.ts` (+ `buildControlController`) — `reportViewport` method.
- `src/main/rpc-router.ts` — construct the shadow, pass `attentionDetector` + `appStateShadow` into the tool
  `ctx`, wire `reportViewport`.
- `src/renderer/app/App.tsx` (or the root state host) — mount `use-viewport-shadow`.
- `src/shared/rpc-channels.ts` (+ test), `src/shared/router-shape.ts` — `control.reportViewport` channel/shape.

## 11. Phasing

- **Phase 1 — Gateway** ✅ (built, `feat/external-control-mcp`, unpushed).
- **Phase 2 — Human-parity completeness** (this spec): `get_app_state` + 10 core tools + authz pins, stacked on
  Phase 1. Exit criteria: an external MCP client can perceive the full app state and perform the core human
  control loop (stop/split/minimise/relabel panes, rename/detach/redock workspaces, DM/resume/kill swarms)
  under supervised autonomy; `kill_swarm` escalates to the phone; parity + authz + builder tests green.
- **Phase 3 — Remote** (later, separate spec): authenticated remote transport.
