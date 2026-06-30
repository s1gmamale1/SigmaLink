# Plain terminals don't count toward the swarm agent cap — Design

**Date:** 2026-06-29
**Branch:** `feat/plain-terminal-uncapped` (off `origin/main` @ 90736ee)
**Status:** Approved (operator), pre-implementation

## Problem

The Command Room caps a swarm at **20 agents**. A "Plain terminal" pane is not a
distinct entity in the data model — it is spawned through the *same* path as a real
agent pane, with `providerId: 'shell'` (an internal sentinel; see
`src/shared/providers.ts`). It is persisted as an ordinary `swarm_agents` row and is
counted at every cap site.

Consequence: plain terminals consume the 20-agent budget. Open a handful of throwaway
shells alongside real agents and the operator hits "Maximum 20 panes per swarm" and is
locked out of adding more *agents* — the annoyance this change removes.

### Verified cap-enforcement sites

| # | Site | Code | Role |
|---|------|------|------|
| 1 | `src/main/core/swarms/factory-add-agent.ts:91` | `agentRows.length >= MAX_SWARM_AGENTS` → throws | **Authoritative** backend gate |
| 2 | `src/renderer/features/command-room/AddPaneButton.tsx:79` | `activeSwarm.agents.length >= 20` | `+ Pane` disable + reason pill |
| 3 | `src/renderer/features/swarm-room/SwarmRoom.tsx:227` | `activeSwarm.agents.length >= 20` | `+ Agent` button disable |
| 4 | `src/main/core/swarms/factory.ts:104` | `roster.length > MAX_SWARM_AGENTS` | create-time roster cap — **out of scope** (rosters never contain shell rows) |

`SwarmAgent` and the `swarm_agents` row both already carry `providerId`
(`src/shared/types.ts:246`), so a shell pane is cheaply distinguishable from an agent pane.

## Decision (operator)

- **Plain terminals are fully free.** The 20-cap counts only real agent panes
  (`providerId !== 'shell'`). Plain terminals are uncapped at the swarm level — they
  remain implicitly bounded by RAM Brake admission and the per-repo worktree cap (40).
- **Do not touch the Dev workspace `DEV_WORKSPACE_MAX_PANES = 12`** — a separate
  mechanism (the Dev terminal-bench dialog), unrelated to the swarm cap.

## Design

### Single source of truth — a shared predicate + constant

Add to `src/shared/providers.ts` (where the `'shell'` sentinel already lives):

```ts
/** Internal sentinel providerId for agent-less plain-shell / custom-command panes. */
export const SHELL_PROVIDER_ID = 'shell';

/** Max real-agent panes per swarm. Plain terminals (shell) do NOT count. */
export const MAX_SWARM_AGENTS = 20;

/** A pane counts toward the swarm agent cap only if it runs a real agent. */
export function countsTowardAgentCap(providerId: string): boolean {
  return providerId !== SHELL_PROVIDER_ID;
}
```

Both main and renderer import these — one definition, no future sibling drift. (Today
`MAX_SWARM_AGENTS = 20` is duplicated in `factory.ts` + `factory-add-agent.ts` and the
literal `20` is hardcoded twice in the renderer; this consolidates all four.)

### Apply the predicate at the three live count sites

1. **`factory-add-agent.ts:91`** (authoritative):
   `agentRows.filter((a) => countsTowardAgentCap(a.providerId)).length >= MAX_SWARM_AGENTS`.
   Shell rows are still inserted exactly as before — they are simply not counted.
2. **`AddPaneButton.tsx:79`**: count with the same filter; reword the pill to
   `Maximum 20 agents per swarm (current: N)` so it is unambiguously about agents.
3. **`SwarmRoom.tsx:227`**: same filter on the `+ Agent` disable condition.

`factory.ts:104` (roster create cap) imports the shared `MAX_SWARM_AGENTS` for
consistency but keeps its existing semantics (rosters contain no shell rows).

### What does NOT change

- DB schema / migrations — shell rows persist identically.
- IPC / RPC shapes — `addAgent` input/output unchanged.
- Spawn / resume / pane-index logic — a shell pane is still a full `swarm_agents` row.
- Dev workspace 12-cap.

## Edge cases

- **Custom-command panes** also route through `providerId: 'shell'` (per the
  `providers.ts` comment). They fall in the same "not an agent" bucket — excluding all
  `'shell'` is the intended, consistent behavior.
- **Backend ↔ frontend parity:** both gates use the same predicate, so the `+ Pane`
  button never enables a click that the backend would then reject (or vice-versa).

## Testing (TDD)

**Backend — `src/main/core/swarms/factory.test.ts`:**
- 20 real agents → adding a 21st *agent* throws (existing "capacity refusal" stays green).
- 20 real agents → adding a *shell* pane SUCCEEDS (shells uncapped).
- 19 real agents + 5 shells → adding the 20th *agent* SUCCEEDS (shells not counted).

**Renderer — `AddPaneButton` (`getAddPaneDisabledReason`):**
- 20 shells, 0 agents → reason is `null` (button enabled).
- 20 agents → reason is the "Maximum 20 agents" pill (disabled).

## Out of scope

- Dev workspace `DEV_WORKSPACE_MAX_PANES`.
- `factory.ts:104` roster-create semantics (constant import only).
- Any separate cap / backstop for plain terminals (operator chose "fully free").
