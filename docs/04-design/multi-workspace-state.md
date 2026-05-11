# Multi-workspace state model

> **Status**: planning draft for v1.1.3. The implementation may refine this design as it lands; this file will be amended with final shape at PR-merge time.

## Why

Today (v1.1.2) SigmaLink models the world as a single `activeWorkspace`. Switching workspaces in the sidebar is destructive: the prior workspace's runtime context (Sigma transcript, Command Room state, Operator Console focus) is replaced. Sessions persist in DB but the renderer treats them as inert until the workspace is re-activated. Users running multiple projects simultaneously (a BridgeSpace-style workflow) have no good answer — they either bounce between workspaces and lose context, or close everything and reopen one at a time.

v1.1.3 fixes this by introducing a real "open workspaces" set distinct from "persisted workspaces". Switching is a tab swap, not a teardown.

## State shape (renderer)

Today (`app/src/renderer/app/state.tsx`):

```ts
interface AppState {
  workspaces: Workspace[];          // all persisted; sorted by lastOpenedAt
  activeWorkspace: Workspace | null; // currently shown
  sessions: AgentSession[];         // globally indexed
  swarms: Swarm[];                  // globally indexed
  // ... room state etc
}
```

Target (v1.1.3):

```ts
interface AppState {
  workspaces: Workspace[];           // all persisted (unchanged)
  openWorkspaces: Workspace[];       // subset currently "live" in UI
  activeWorkspaceId: string | null;  // id, not the whole workspace
  // derived selector:
  //   activeWorkspace: state.openWorkspaces.find(w => w.id === state.activeWorkspaceId) ?? null
  sessions: AgentSession[];          // unchanged — filter by workspaceId at consume site
  swarms: Swarm[];                   // unchanged
  // ... room state etc
}
```

Why an `id` field + derived selector instead of a direct `activeWorkspace` reference:
- Single source of truth — the workspace object lives in `openWorkspaces` exactly once.
- O(1) updates — closing a workspace mutates only `openWorkspaces`, not a separate active pointer.
- Trivial to migrate consumers — a 3-line selector replaces every `state.activeWorkspace` read with a derived lookup.

## Reducer actions

| Action | Payload | Effect |
|---|---|---|
| `WORKSPACE_OPEN` | `{ workspace }` | Append to `openWorkspaces` if not already present. Idempotent. |
| `WORKSPACE_CLOSE` | `{ workspaceId }` | Remove from `openWorkspaces`. If closed workspace was active, fall back to most-recently-active remaining; if `openWorkspaces` becomes empty, set `activeWorkspaceId=null`. |
| `SET_ACTIVE_WORKSPACE_ID` | `{ workspaceId }` | Update `activeWorkspaceId`. The workspace must already be in `openWorkspaces` — caller is responsible for `WORKSPACE_OPEN` first. |

The legacy `SET_ACTIVE_WORKSPACE` action is replaced by a 2-step pattern: open the workspace if needed, then set active id. Codemod the call sites once during implementation.

## Cap + overflow UX

Per locked decision (AskUserQuestion 2026-05-11): **8 sidebar tabs visible + overflow drawer**.

Behaviour when `openWorkspaces.length > 8`:
- Sidebar `WorkspaceTabs` shows first 7 most-recently-active + a "+N more" pill that opens an overflow drawer.
- Overflow drawer lists all open workspaces beyond the visible 7; clicking promotes that workspace into the visible top-7 + sets active.
- LRU heuristic for visible set: most-recently-activated 7 are visible; least-recently-activated tab gets bumped to overflow when a new workspace is opened.

Runtime cap: none. The state model can hold any number; memory pressure is the only limit.

## Sigma Assistant scoping

Per locked decision: **shared right-rail panel; switching workspace swaps active conversation**.

Conversations are already DB-keyed by `workspaceId` in v1.1.2 (`conversations` table). The renderer just needs to pass the current `state.activeWorkspaceId` to `rpc.assistant.send` calls (already does this). When `activeWorkspaceId` changes, `BridgeRoom` re-fetches the conversation list for the new workspace.

No data leak between workspaces. No new UI surface — same orb, same composer, same transcript area; the content swaps.

## Affected files

- `app/src/renderer/app/state.tsx` — reducer + selector
- `app/src/renderer/features/sidebar/Sidebar.tsx` — WorkspaceTabs source + close buttons + overflow
- `app/src/main/core/workspaces/lifecycle.ts` (NEW) — backend event emitter for open/close
- `app/src/shared/rpc-channels.ts` — `app:open-workspaces-changed` allowlist
- `app/src/main/core/rpc/schemas.ts` — array shape zod
- `app/src/renderer/features/bridge-agent/BridgeRoom.tsx` — already reads activeWorkspace via accessor; verify selector swap works transparently

## Verification

- Reducer unit tests covering OPEN / CLOSE / SET_ACTIVE
- Selector returns correct workspace for active id; returns null when id not in `openWorkspaces`
- E2E: open 3 workspaces, switch between them, assert Sigma transcript is workspace-specific
- E2E: close active workspace → fallback to most-recently-active remaining
- E2E: open 10 workspaces, assert overflow drawer renders the last 3

## Out of scope

- Pane-level UI state per workspace (Editor open files, scroll positions) — deferred to v1.2.
- "Snapshot" / workspace templates — deferred.
- Workspace-private settings (e.g., per-workspace theme) — deferred.
