# Bug: "Cannot create swarm: empty roster" — pane-create regression (v1.13.1)

## Root Cause

`v1.13.1` (commit `a1aadfd`) introduced a zero-swarm fast-path: when a workspace
has no swarm yet, both **AddPaneButton** and **addEmptyStatePane** (CommandRoom)
call `rpc.swarms.create` with `{ preset: 'custom', roster: [] }` before calling
`rpc.swarms.addAgent`.

The backend `createSwarm` in `factory.ts:106-109` does the following:

```ts
const roster =
  input.roster && input.roster.length > 0 ? input.roster : defaultRoster(input.preset);
if (roster.length === 0) {
  throw new Error('Cannot create swarm: empty roster.');
}
```

`defaultRoster('custom')` returns `[]` (see `types.ts:280`). Because the
renderer passes `preset: 'custom'` *and* `roster: []`, the fallback also yields
an empty array and the guard throws. The error surfaces in the renderer as "Could
not add pane — Cannot create swarm: empty roster."

---

## Backend Contract (`swarms.create` / `CreateSwarmInput`)

**File:** `/Users/aisigma/projects/SigmaLink/app/src/shared/types.ts:171-179`

```ts
export interface CreateSwarmInput {
  workspaceId: WorkspaceId;
  mission: string;
  preset: SwarmPreset;
  name?: string;
  baseRef?: string;
  roster: RoleAssignment[];   // ← REQUIRED, must not be empty
}

export interface RoleAssignment {
  role: Role;          // 'coordinator' | 'builder' | 'scout' | 'reviewer'
  roleIndex: number;   // 1-based
  providerId: string;
  modelId?: string;
  autoApprove?: boolean;
}
```

The guard is enforced in
`/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/factory.ts:106-109`.
No other location in the factory or controller throws this specific message.

**Required roster shape for a single-pane default swarm:**

```ts
roster: [{ role: 'builder', roleIndex: 1, providerId: '<selectedProviderId>' }]
```

`addAgentToSwarm` (called immediately after) defaults `role` to `'builder'`
(`factory-add-agent.ts:50`), so the single-entry roster is consistent with what
the subsequent `addAgent` would also create.

---

## Pre-v1.13.1 Behaviour (no regression existed)

Before `a1aadfd`, neither **AddPaneButton** nor **addEmptyStatePane** ever called
`swarms.create`. Both functions required `activeSwarm` to be non-null before
proceeding:

- **AddPaneButton** (`c5a78bd` — the extraction commit, pre-regression):
  `if (!activeSwarm || !swarmId || adding) return;` — hard-gated on an existing
  swarm; no create path existed.

- **CommandRoom.addEmptyStatePane** (`c5a78bd`):
  `if (!activeSwarm || emptyStateAdding ...) return;` — same guard.

Both called `rpc.swarms.addAgent({ swarmId: activeSwarm.id, providerId })` directly.
`swarms.create` was only invoked by the **SwarmCreate wizard**
(`SwarmCreate.tsx:146`), which always collects a non-empty `roster` from the
`buildDefaultRoster(preset)` UI helper before launching.

The zero-swarm fast-path that `a1aadfd` introduced was novel functionality — it
was not a pre-existing code path that regressed.

---

## All Empty-Roster Call Sites

Both call sites are in the renderer, introduced in the same commit (`a1aadfd`):

| # | File | Line | Context |
|---|------|------|---------|
| 1 | `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/command-room/AddPaneButton.tsx` | 112-117 | `addPane()` — "+Pane" dropdown button in toolbar |
| 2 | `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/command-room/CommandRoom.tsx` | 209-214 | `addEmptyStatePane()` — "Add first pane" empty-state CTA |

Both sites use identical code:

```ts
const newSwarm = await rpc.swarms.create({
  workspaceId: activeWorkspace.id,
  mission: 'Default swarm',
  preset: 'custom',
  roster: [],       // ← INCORRECT: empty roster always throws
});
```

No other non-test file passes `roster: []` to `swarms.create`. The SwarmCreate
wizard (`SwarmCreate.tsx:144`) passes the live `roster` state variable, which is
always populated by `buildDefaultRoster(preset)`.

---

## Recommended Fix

### Option A — Renderer passes a one-entry roster (RECOMMENDED)

Fix both renderer call sites to supply a single `builder` roster entry using the
selected provider. This is the minimal change and keeps the backend contract
unchanged.

**AddPaneButton.tsx** (`addPane`, called with `providerId`):

```ts
const newSwarm = await rpc.swarms.create({
  workspaceId: activeWorkspace.id,
  mission: 'Default swarm',
  preset: 'custom',
  roster: [{ role: 'builder', roleIndex: 1, providerId }],
});
```

The subsequent `rpc.swarms.addAgent({ swarmId: targetSwarmId, providerId })` call
must then be **removed or skipped**, because the create call already materialises
the agent and its PTY. The `create` return value's `agents[0]` carries the
`sessionId` that must be dispatched. Alternatively, keep `addAgent` and drop the
roster entry — see note below.

**CommandRoom.tsx** (`addEmptyStatePane`, provider is `providers[0]!.id`):

```ts
const newSwarm = await rpc.swarms.create({
  workspaceId: activeWorkspace.id,
  mission: 'Default swarm',
  preset: 'custom',
  roster: [{ role: 'builder', roleIndex: 1, providerId: providers[0]!.id }],
});
```

Same note applies: if `addAgent` is kept after `create`, do not include the agent
in the roster (or accept a redundant agent). The cleanest path is:

1. `swarms.create` with the one-entry roster — this spawns the PTY.
2. Skip the separate `addAgent` call.
3. Derive `sessionId` from `newSwarm.agents[0]!.sessionId`.

### Option B — Relax `createSwarm` to allow empty roster for `custom` preset

Change `factory.ts:107-109` to only throw when the resolved roster is empty *and*
the preset is not `custom`:

```ts
if (roster.length === 0 && input.preset !== 'custom') {
  throw new Error('Cannot create swarm: empty roster.');
}
```

Then a `custom` swarm with no initial agents is legal, and the caller adds agents
exclusively via `addAgentToSwarm`.

**This option is NOT recommended** because:
- It silently allows a swarm to be created with zero agents, diverging from the
  intent documented in the factory comment ("materialises one PTY agent per role").
- `SYSTEM` mailbox message would claim `agentCount: 0`, misleading the console.
- All existing swarm creation paths (wizard, voice dispatcher) rely on the guard
  to enforce at least one agent. Weakening it increases the blast radius of
  future caller mistakes.

### Summary of recommendation

Fix the two renderer call sites (Option A). Either:
- Pass a one-entry roster and remove the separate `addAgent` call (cleanest), or
- Keep the two-step flow but fix the roster to contain the initial agent, then
  let `addAgent` append a second agent if a second pane is still desired.

The first variant (one-step) is preferred because it avoids the double-spawn edge
case and mirrors how SwarmCreate already works.

---

## 5-Line Summary

1. `v1.13.1` added a zero-swarm fast-path in AddPaneButton and CommandRoom that
   calls `swarms.create({ preset: 'custom', roster: [] })`.
2. The backend rejects any create request where the resolved roster is empty
   (`factory.ts:107-109`); `defaultRoster('custom')` also returns `[]`.
3. Before `v1.13.1`, neither call site existed — both required `activeSwarm` to be
   non-null and only called `addAgent` directly.
4. Both broken call sites are in `AddPaneButton.tsx:112` and `CommandRoom.tsx:209`.
5. Fix: pass `roster: [{ role: 'builder', roleIndex: 1, providerId }]` at both
   sites and skip the subsequent `addAgent` call (the create already spawns the PTY).
