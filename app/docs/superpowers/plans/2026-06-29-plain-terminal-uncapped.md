# Plain Terminals Uncapped — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The 20-agent swarm cap counts only real agent panes; plain terminals (`providerId: 'shell'`) no longer consume the budget.

**Architecture:** Add one shared predicate + constant in `src/shared/providers.ts` (`countsTowardAgentCap`, `MAX_SWARM_AGENTS`). The authoritative backend gate (`factory-add-agent.ts`) and the two renderer gates (`AddPaneButton.tsx`, `SwarmRoom.tsx`) filter shell rows out of the count via that single predicate. Shell rows still persist as ordinary `swarm_agents` rows — only the *counting* changes. No DB/IPC/spawn changes.

**Tech Stack:** TypeScript, Electron (main + renderer), Drizzle/better-sqlite3, React, Vitest, React Testing Library.

## Global Constraints

- TS `erasableSyntaxOnly`: no `enum`, no `namespace`, no constructor parameter properties.
- Files under ~500 LOC; no working files in repo root.
- Local gate (run in the worktree): `npx tsc -b`, `npx vitest run`, `npx eslint --max-warnings 0` on touched files. Defer e2e to CI.
- `'shell'` is an INTERNAL sentinel providerId; it is the only providerId that is NOT a real agent. Custom-command panes also use it — intentionally in the same "not an agent" bucket.
- Cap value is exactly `20`.

---

### Task 1: Shared predicate + constant

**Files:**
- Modify: `src/shared/providers.ts` (append exports after `listVisibleProviders`, ~line 304)
- Test: `src/shared/providers.test.ts`

**Interfaces:**
- Produces:
  - `export const SHELL_PROVIDER_ID = 'shell'`
  - `export const MAX_SWARM_AGENTS = 20`
  - `export function countsTowardAgentCap(providerId: string): boolean`

- [ ] **Step 1: Write the failing test** — append to `src/shared/providers.test.ts`:

```ts
describe('swarm agent cap helpers', () => {
  it('real agent providers count toward the cap', () => {
    expect(countsTowardAgentCap('claude')).toBe(true);
    expect(countsTowardAgentCap('codex')).toBe(true);
    expect(countsTowardAgentCap('gemini')).toBe(true);
  });

  it('the shell sentinel (plain terminal) does NOT count', () => {
    expect(countsTowardAgentCap(SHELL_PROVIDER_ID)).toBe(false);
    expect(countsTowardAgentCap('shell')).toBe(false);
  });

  it('MAX_SWARM_AGENTS is 20', () => {
    expect(MAX_SWARM_AGENTS).toBe(20);
  });
});
```

Add `countsTowardAgentCap, SHELL_PROVIDER_ID, MAX_SWARM_AGENTS` to the existing
`import { ... } from './providers';` block at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/providers.test.ts`
Expected: FAIL — `countsTowardAgentCap is not a function` / import has no exported member.

- [ ] **Step 3: Write minimal implementation** — append to `src/shared/providers.ts` after the `listVisibleProviders` function:

```ts
/** Internal sentinel providerId for agent-less plain-shell / custom-command panes. */
export const SHELL_PROVIDER_ID = 'shell';

/**
 * Max real-agent panes per swarm. Plain terminals (providerId 'shell') do NOT
 * count toward this — see `countsTowardAgentCap`. Single source of truth shared
 * by the backend gate (factory-add-agent) and the renderer +Pane / +Agent gates.
 */
export const MAX_SWARM_AGENTS = 20;

/**
 * A pane counts toward the swarm agent cap only if it runs a real agent. Plain
 * terminals / custom-command panes spawn through the internal 'shell' sentinel
 * and are uncapped at the swarm level (still bounded by RAM Brake + worktree cap).
 */
export function countsTowardAgentCap(providerId: string): boolean {
  return providerId !== SHELL_PROVIDER_ID;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/providers.test.ts`
Expected: PASS (all, including the pre-existing registry tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/providers.ts src/shared/providers.test.ts
git commit -m "feat(swarms): shared countsTowardAgentCap predicate + MAX_SWARM_AGENTS"
```

---

### Task 2: Backend authoritative gate excludes shell

**Files:**
- Modify: `src/main/core/swarms/factory-add-agent.ts` (remove local `const MAX_SWARM_AGENTS = 20` at line 29; count via predicate at line ~91)
- Modify: `src/main/core/swarms/factory.ts` (remove local `const MAX_SWARM_AGENTS = 20` at line 40; import the shared constant)
- Test: `src/main/core/swarms/factory.test.ts`

**Interfaces:**
- Consumes: `countsTowardAgentCap`, `MAX_SWARM_AGENTS` from `../../../shared/providers` (Task 1).

- [ ] **Step 1: Update the test helper to seed a chosen provider** — in `src/main/core/swarms/factory.test.ts`, extend `seedSwarmOf` (currently `(count, roleFor)`) with a third optional param. Replace its signature + the `seedAgent` `providerId` line:

```ts
function seedSwarmOf(
  count: number,
  roleFor: (idx: number) => 'coordinator' | 'builder' | 'scout' | 'reviewer' = () => 'builder',
  providerFor: (idx: number) => string = () => 'shell',
): void {
```

and inside the loop change `providerId: 'shell',` to:

```ts
      providerId: providerFor(i),
```

(Default stays `'shell'` so the many pane-index callers are unchanged.)

- [ ] **Step 2: Write the failing tests** — in `factory.test.ts`, update the two existing capacity tests to seed REAL agents, and add the shell-exclusion cases. Replace the existing `it('rejects 21st agent (20-cap)', ...)` and `it('capacity refusal at roster.length === 20', ...)` bodies so they seed real agents and add a real agent, and add three new tests:

```ts
  it('rejects 21st agent (20-cap) — real agents', async () => {
    seedSwarmOf(20, () => 'builder', () => 'claude');
    const deps = makeDeps();
    const agentInput: AddAgentToSwarmInput = { swarmId: 'swarm-1', providerId: 'claude' };

    await expect(addAgentToSwarm(agentInput, deps)).rejects.toThrow(/20 agents/);

    expect(vi.mocked(resolveAndSpawn)).not.toHaveBeenCalled();
    expect((fake.store.tables.get('swarm_agents') ?? []).length).toBe(20);
  });

  it('shell panes do NOT count toward the cap', async () => {
    // 20 plain terminals present — adding a real agent still succeeds.
    seedSwarmOf(20, () => 'builder', () => 'shell');
    const agentInput: AddAgentToSwarmInput = { swarmId: 'swarm-1', providerId: 'claude' };

    const result = await addAgentToSwarm(agentInput, makeDeps());

    expect(result.agentKey).toBe('builder-21');
    expect((fake.store.tables.get('swarm_agents') ?? []).length).toBe(21);
  });

  it('a shell pane is uncapped even at 20 real agents', async () => {
    seedSwarmOf(20, () => 'builder', () => 'claude');
    const shellInput: AddAgentToSwarmInput = { swarmId: 'swarm-1', providerId: 'shell' };

    const result = await addAgentToSwarm(shellInput, makeDeps());

    expect((fake.store.tables.get('swarm_agents') ?? []).length).toBe(21);
    expect(result.session.id).toBe(result.sessionId);
  });
```

And update the other existing capacity test:

```ts
  it('capacity refusal at 20 real agents', async () => {
    seedSwarmOf(20, () => 'builder', () => 'claude');
    const deps = makeDeps();
    const agentInput: AddAgentToSwarmInput = { swarmId: 'swarm-1', providerId: 'claude' };

    await expect(addAgentToSwarm(agentInput, deps)).rejects.toThrow(/swarm already has 20 agents/);

    expect((fake.store.tables.get('swarm_agents') ?? []).length).toBe(20);
    expect(vi.mocked(resolveAndSpawn)).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/main/core/swarms/factory.test.ts`
Expected: FAIL — `shell panes do NOT count` errors (still throws "already has 20 agents") because the count currently includes shell rows.

- [ ] **Step 4: Implement — exclude shell from the backend count.** In `src/main/core/swarms/factory-add-agent.ts`:

Delete the local constant (line 29):
```ts
const MAX_SWARM_AGENTS = 20;
```
Add to the imports near the top (the file already imports from `../../../shared/types`):
```ts
import { countsTowardAgentCap, MAX_SWARM_AGENTS } from '../../../shared/providers';
```
Replace the count guard (currently lines 91–93):
```ts
    if (agentRows.length >= MAX_SWARM_AGENTS) {
      throw new Error(`Cannot add agent: swarm already has ${MAX_SWARM_AGENTS} agents.`);
    }
```
with:
```ts
    const agentPaneCount = agentRows.filter((a) => countsTowardAgentCap(a.providerId)).length;
    if (agentPaneCount >= MAX_SWARM_AGENTS) {
      throw new Error(`Cannot add agent: swarm already has ${MAX_SWARM_AGENTS} agents.`);
    }
```

- [ ] **Step 5: Implement — share the constant in `factory.ts`.** In `src/main/core/swarms/factory.ts`:

Delete the local constant (line 40):
```ts
const MAX_SWARM_AGENTS = 20;
```
Add it to the shared-providers import (create the import if absent):
```ts
import { MAX_SWARM_AGENTS } from '../../../shared/providers';
```
The existing roster guard (`if (roster.length > MAX_SWARM_AGENTS)`) is unchanged — rosters never contain shell rows, so create-time semantics stay identical.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/main/core/swarms/factory.test.ts`
Expected: PASS (all — updated capacity tests + 2 new shell tests + untouched pane-index/role-index tests).

- [ ] **Step 7: Commit**

```bash
git add src/main/core/swarms/factory-add-agent.ts src/main/core/swarms/factory.ts src/main/core/swarms/factory.test.ts
git commit -m "feat(swarms): exclude plain-terminal (shell) panes from the 20-agent cap"
```

---

### Task 3: Renderer gates exclude shell + reword pill

**Files:**
- Modify: `src/renderer/features/command-room/AddPaneButton.tsx` (cap check + pill string, lines 79–81)
- Modify: `src/renderer/features/swarm-room/SwarmRoom.tsx` (+Agent disable, line 227)
- Test: `src/renderer/features/command-room/AddPaneButton.test.tsx`

**Interfaces:**
- Consumes: `countsTowardAgentCap`, `MAX_SWARM_AGENTS` from `@/shared/providers` (Task 1).

- [ ] **Step 1: Update the renderer test helper + cap tests.** In `src/renderer/features/command-room/AddPaneButton.test.tsx`:

Extend `makeSwarm` with a per-agent provider param (default `'claude'`):
```ts
function makeSwarm(
  overrides: Partial<Swarm> = {},
  agentCount = 0,
  providerId = 'claude',
): Swarm {
```
and in the `agents:` array change `providerId: 'claude',` to `providerId,`.

Update test `1c` (the cap pill) — reword the expected text and add a shell case right after it:
```ts
  it('1c: shows pill "Maximum 20 agents" when real-agent count reaches 20', async () => {
    await renderAddPaneButton({ activeSwarm: makeSwarm({}, 20) });
    const pill = screen.getByTestId('add-pane-disabled-reason');
    expect(pill.textContent).toContain('Maximum 20 agents per swarm');
  });

  it('1c-shell: NO pill when 20 panes are all plain terminals (shell)', async () => {
    await renderAddPaneButton({ activeSwarm: makeSwarm({}, 20, 'shell') });
    expect(screen.queryByTestId('add-pane-disabled-reason')).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/features/command-room/AddPaneButton.test.tsx`
Expected: FAIL — `1c` fails on the new "agents" wording (still says "panes"); `1c-shell` fails because 20 shell agents still trip the cap pill.

- [ ] **Step 3: Implement — `AddPaneButton.tsx`.** Add the import:
```ts
import { countsTowardAgentCap, MAX_SWARM_AGENTS } from '@/shared/providers';
```
Replace the cap branch in `getAddPaneDisabledReason` (currently lines 79–81):
```ts
  if (activeSwarm.agents.length >= 20) {
    return `Maximum 20 panes per swarm (current: ${activeSwarm.agents.length})`;
  }
```
with:
```ts
  const agentPaneCount = activeSwarm.agents.filter((a) => countsTowardAgentCap(a.providerId)).length;
  if (agentPaneCount >= MAX_SWARM_AGENTS) {
    return `Maximum ${MAX_SWARM_AGENTS} agents per swarm (current: ${agentPaneCount})`;
  }
```

- [ ] **Step 4: Implement — `SwarmRoom.tsx`.** Add the import:
```ts
import { countsTowardAgentCap, MAX_SWARM_AGENTS } from '@/shared/providers';
```
Replace the disable condition (currently line 227 `activeSwarm.agents.length >= 20`) so the `+ Agent` button is disabled by real-agent count:
```ts
                  activeSwarm.agents.filter((a) => countsTowardAgentCap(a.providerId)).length >=
                    MAX_SWARM_AGENTS
```
(Keep the surrounding `busy || activeSwarm.status !== 'running' || …` clauses intact.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/features/command-room/AddPaneButton.test.tsx`
Expected: PASS (all, incl. updated `1c` + new `1c-shell`).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/features/command-room/AddPaneButton.tsx src/renderer/features/swarm-room/SwarmRoom.tsx src/renderer/features/command-room/AddPaneButton.test.tsx
git commit -m "feat(command-room): +Pane/+Agent gates count real agents, not plain terminals"
```

---

### Task 4: Full local gate

- [ ] **Step 1: Typecheck** — `npx tsc -b` → no errors (ignore any pre-existing worktree node_modules symlink false-positives; grep -v known-noise).
- [ ] **Step 2: Full unit suite** — `npx vitest run` → green (catches sibling-mock breakage missed by scoped runs).
- [ ] **Step 3: Lint touched files** — `npx eslint --max-warnings 0 src/shared/providers.ts src/main/core/swarms/factory.ts src/main/core/swarms/factory-add-agent.ts src/renderer/features/command-room/AddPaneButton.tsx src/renderer/features/swarm-room/SwarmRoom.tsx`
- [ ] **Step 4: Build** — `npm run build` → succeeds.
- [ ] No commit (gate only). Report receipts: tsc/vitest/eslint/build output.

---

## Self-Review

**Spec coverage:**
- Shared predicate + constant → Task 1. ✓
- Backend authoritative gate excludes shell → Task 2 (factory-add-agent.ts). ✓
- Const consolidation (factory.ts) → Task 2 Step 5. ✓
- AddPaneButton gate + pill reword → Task 3. ✓
- SwarmRoom +Agent gate → Task 3 Step 4. ✓
- Backend tests (20 real reject / 20 shell allow / shell uncapped) → Task 2. ✓
- Renderer tests (20 shell → enabled; 20 agents → disabled) → Task 3. ✓
- Out of scope (Dev workspace cap, roster-create semantics) → untouched. ✓

**Placeholder scan:** none — every code step shows the exact code.

**Type consistency:** `countsTowardAgentCap(providerId: string): boolean` and `MAX_SWARM_AGENTS` used identically in Tasks 2 & 3; `seedSwarmOf` third param and `makeSwarm` third param both default to a provider string; backend agent rows and renderer `SwarmAgent` both expose `.providerId`.
