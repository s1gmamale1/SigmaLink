# Phase 4 — Pane chrome + grid (BridgeSpace-faithful) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the pane header as a BridgeSpace-faithful truncated title-pill + icon-only glyph cluster (gear·focus·split·minimise·close) with all metadata relocated off the bar, and make the pane grid preserve/persist/animate its proportions instead of hard-resetting.

**Architecture:** A pure `derivePaneIdentity(session)` helper + a deterministic `agentAlias(id)` are built first (foundation, lead) so the header gear-popover and the fullscreen context-sidebar render the SAME metadata from one source (anti-drift). Then three file-disjoint, worktree-isolated lanes run in parallel: **A** header (`PaneHeader.tsx` + new `PaneGearPopover.tsx`), **B** grid (`GridLayout.tsx`), **C** surfaces (`PaneContextSidebar` + `PaneSplash` + `PaneFooter`). The lead then wires the one integration seam (`CommandRoom` → `GridLayout` workspaceId) and runs the full gate.

**Tech Stack:** React 19, TypeScript, Tailwind, Radix UI (Popover/DropdownMenu/Tooltip), lucide-react icons, Vitest + @testing-library/react (jsdom), Playwright e2e. KV persistence via `rpc.kv.get/set`.

**Spec:** `docs/superpowers/specs/2026-06-05-phase-4-pane-chrome-grid-design.md`

---

## File Structure

**Foundation (lead, sequential — before lanes):**
- Modify `app/src/renderer/lib/workspace-color.ts` — add `agentAlias(id)` (mirrors `agentShortId`/FNV-1a).
- Modify `app/src/renderer/lib/workspace-color.test.ts` — `agentAlias` cases. *(create if absent)*
- Create `app/src/renderer/features/command-room/pane-identity.ts` — pure `derivePaneIdentity(session)` returning the static identity/metadata bundle both the popover and sidebar render.
- Create `app/src/renderer/features/command-room/pane-identity.test.ts`.

**Lane A — header (worktree):**
- Modify `app/src/renderer/features/command-room/PaneHeader.tsx` — pill + icon cluster; mount gear popover; merge split icons.
- Create `app/src/renderer/features/command-room/PaneGearPopover.tsx` — consolidated metadata + actions panel.
- Modify `app/src/renderer/features/command-room/PaneHeader.test.tsx` — lockstep rewrite.

**Lane B — grid (worktree):**
- Modify `app/src/renderer/features/command-room/GridLayout.tsx` — `reshapeFracs`, `workspaceId` prop, KV persistence, reflow transition.
- Modify `app/src/renderer/features/command-room/GridLayout.test.tsx` — lockstep + new cases.

**Lane C — surfaces (worktree):**
- Modify `app/src/renderer/features/command-room/PaneContextSidebar.tsx` — add Identity / Branch / Model+Effort sections (via `derivePaneIdentity`).
- Modify `app/src/renderer/features/command-room/PaneContextSidebar.test.tsx`.
- Modify `app/src/renderer/features/command-room/PaneSplash.tsx` — quiet idle model-tier + cwd line.
- Modify/Create `app/src/renderer/features/command-room/PaneSplash.test.tsx`.
- Modify `app/src/renderer/features/command-room/PaneFooter.tsx` — verify/extend dim status line under the new header.
- Modify `app/src/renderer/features/command-room/PaneFooter.test.tsx`.

**Lead seam (after lanes merge):**
- Modify `app/src/renderer/features/command-room/CommandRoom.tsx` — pass `activeWorkspaceId` → `GridLayout`.
- Modify `app/src/renderer/features/command-room/PaneShell.tsx` — only if a new prop is genuinely required (default: no change; `PaneHeader` is self-contained).

> **All commands run from `app/`.** Test a single file: `npx vitest run src/renderer/features/command-room/<File>.test.tsx`. Full gate: `npx tsc -b && npx vitest run && npm run lint && npm run build` then `npx playwright test tests/e2e/`.

---

## Phase 0 — Foundation (lead, sequential)

### Task 1: `agentAlias(id)` deterministic human-name helper (BSP-P3)

**Files:**
- Modify: `app/src/renderer/lib/workspace-color.ts` (after `agentShortId`, ~line 83)
- Test: `app/src/renderer/lib/workspace-color.test.ts`

- [ ] **Step 1: Write the failing test**

Add (create the file if it does not exist — match the jsdom-free unit style; this is pure):

```ts
import { describe, expect, it } from 'vitest';
import { agentAlias, AGENT_ALIAS_PALETTE } from './workspace-color';

describe('agentAlias', () => {
  it('is deterministic for the same id', () => {
    expect(agentAlias('sess-abc')).toBe(agentAlias('sess-abc'));
  });
  it('returns a name from the palette', () => {
    expect(AGENT_ALIAS_PALETTE).toContain(agentAlias('any-uuid-1234'));
  });
  it('handles long UUID ids without throwing', () => {
    const uuid = '7f3c1e2a-9b4d-4c8e-a1f2-3d4e5f6a7b8c';
    expect(typeof agentAlias(uuid)).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/lib/workspace-color.test.ts`
Expected: FAIL — `agentAlias`/`AGENT_ALIAS_PALETTE` not exported.

- [ ] **Step 3: Implement (append to `workspace-color.ts`, reusing the existing `fnv1a32`)**

```ts
/**
 * BSP-P3 — deterministic human-name alias for an agent session id. Same id →
 * same name across reloads/panes. 16 short, distinct, gender-neutral names so
 * collisions across a single grid are rare. Uses the existing FNV-1a hash.
 */
export const AGENT_ALIAS_PALETTE: readonly string[] = [
  'Ava', 'Thea', 'Nia', 'Iris', 'Juno', 'Wren', 'Cleo', 'Vera',
  'Nova', 'Lyra', 'Echo', 'Sage', 'Rhea', 'Mira', 'Faye', 'Zara',
];

export function agentAlias(id: string): string {
  return AGENT_ALIAS_PALETTE[fnv1a32(id) % AGENT_ALIAS_PALETTE.length]!;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/lib/workspace-color.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/lib/workspace-color.ts app/src/renderer/lib/workspace-color.test.ts
git commit -m "feat(phase4): agentAlias deterministic human-name helper (BSP-P3)"
```

### Task 2: `derivePaneIdentity(session)` shared metadata bundle (anti-drift)

**Files:**
- Create: `app/src/renderer/features/command-room/pane-identity.ts`
- Test: `app/src/renderer/features/command-room/pane-identity.test.ts`

This is the single source of truth for the static metadata the gear popover (Lane A) and the context sidebar (Lane C) both render, so they cannot drift.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { derivePaneIdentity } from './pane-identity';
import type { AgentSession } from '@/shared/types';

function makeSession(o: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1', workspaceId: 'ws-1', providerId: 'claude',
    status: 'running', branch: 'feature/x', cwd: '/repo',
    startedAt: 0, ...o,
  } as AgentSession;
}

describe('derivePaneIdentity', () => {
  it('exposes alias, agentId, provider name/color, model+effort, branch, cwd', () => {
    const id = derivePaneIdentity(makeSession());
    expect(typeof id.alias).toBe('string');
    expect(typeof id.agentId).toBe('string');
    expect(id.providerName.length).toBeGreaterThan(0);
    expect(id.branch).toBe('feature/x');
    expect(id.cwd).toBe('/repo');
    expect(typeof id.modelLabel).toBe('string');
    expect(typeof id.effortLabel).toBe('string');
  });
  it('defaults branch to "dev" when session has none', () => {
    expect(derivePaneIdentity(makeSession({ branch: undefined })).branch).toBe('dev');
  });
  it('flags relabel when displayProviderId differs from real providerId', () => {
    const id = derivePaneIdentity(makeSession({ providerId: 'claude', displayProviderId: 'codex' }));
    expect(id.isRelabelled).toBe(true);
    expect(id.realProviderName.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/pane-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `pane-identity.ts`** (lift the existing derivations out of `PaneHeader.tsx:154-179`)

```ts
// Phase 4 — single source of truth for a pane's STATIC identity/metadata.
// Rendered identically by PaneGearPopover (grid view) and PaneContextSidebar
// (fullscreen) so the two surfaces cannot drift. Async/polled data (Ruflo
// health, usage) stays in those surfaces via their existing hooks.
import { findProvider } from '@/shared/providers';
import { defaultModelFor } from '@/shared/model-catalog';
import { agentAlias, agentColor, agentShortId } from '@/renderer/lib/workspace-color';
import type { AgentSession } from '@/shared/types';

export interface PaneIdentity {
  alias: string;
  agentId: string;
  agentAccent: string;
  providerName: string;
  providerColor: string;
  providerShort: string;
  realProviderName: string;
  isRelabelled: boolean;
  modelLabel: string;
  effortLabel: string;
  branch: string;
  cwd: string;
  worktreePath: string | null;
}

export function derivePaneIdentity(session: AgentSession): PaneIdentity {
  const effectiveProviderId = session.displayProviderId ?? session.providerId;
  const provider = findProvider(effectiveProviderId);
  const realProvider = findProvider(session.providerId);
  const providerName = provider?.name ?? effectiveProviderId.toUpperCase();
  const meta = defaultModelFor(session.providerId);
  return {
    alias: agentAlias(session.id),
    agentId: agentShortId(session.id),
    agentAccent: agentColor(session.id),
    providerName,
    providerColor: provider?.color ?? '#6b7280',
    providerShort: providerName.split(' ')[0] ?? providerName,
    realProviderName: realProvider?.name ?? session.providerId.toUpperCase(),
    isRelabelled: effectiveProviderId !== session.providerId,
    modelLabel: meta?.label ?? '—',
    effortLabel: meta?.defaultEffort ?? '—',
    branch: session.branch ?? 'dev',
    cwd: session.cwd,
    worktreePath: session.worktreePath ?? null,
  };
}
```

> Worker note: confirm `displayProviderId`, `worktreePath`, `cwd`, `branch` exist on `AgentSession` (they're read in today's `PaneHeader.tsx`). If a field is optional, the `?? ` fallbacks above already cover it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/command-room/pane-identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/features/command-room/pane-identity.ts app/src/renderer/features/command-room/pane-identity.test.ts
git commit -m "feat(phase4): derivePaneIdentity shared metadata bundle (anti-drift)"
```

> **After Phase 0:** record the foundation commit SHA. Each lane worktree must `git merge --ff-only <FOUNDATION_SHA>` (or branch from it) so A/B/C all see `agentAlias` + `derivePaneIdentity`.

---

## Phase 1 — Lanes A / B / C (parallel, worktree-isolated)

### LANE A — Header (DEV-L1 + BSP-F1/P2/P3)

**Contract the tests lock (new `data-testid` / `aria-label`):**
- `pane-header` (root, unchanged) · `pane-title-pill` (status glyph + alias·effort; is the drag handle, `draggable`, fires `PANE_DRAG_MIME` via the existing `handleGripDragStart`) · `pane-status-glyph` (single folded status dot) · `pane-gear` (button, `aria-label="Pane details & actions"`) · `pane-gear-popover` (Radix content) · `pane-split` (single merged split button, `aria-label="Split pane"`) · fullscreen button (`aria-label` unchanged: "Fullscreen pane"/"Exit fullscreen (Esc)") · minimise (`aria-label` "Minimise pane"/"Restore pane") · close (`aria-label="Close pane"`).
- **Removed from the bar** (now inside `pane-gear-popover`): `pane-provider-label` relabel menu, `agent-short-id`, `ruflo-health-dot`, inline branch/model, `±uncommitted`, `GitActivityStrip`, usage-coins, `pane-rewind-item`, brief button.

#### Task A1: Rewrite `PaneHeader.test.tsx` to the new contract (RED)

**Files:** Modify `app/src/renderer/features/command-room/PaneHeader.test.tsx`

- [ ] **Step 1: Rewrite the test cases** (keep the existing mock block at the top — `rpc`, `rpcSilent`, `useRufloDaemonHealth`, the `ResizeObserver`/pointer polyfills, and `makeSession`). Replace the body assertions with:

```tsx
it('renders the title pill with alias and is the drag handle', () => {
  render(<PaneHeader {...baseProps()} />);
  const pill = screen.getByTestId('pane-title-pill');
  expect(pill).toHaveAttribute('draggable', 'true');
  // alias is deterministic from session.id via agentAlias
  expect(pill.textContent ?? '').toMatch(/\w+/);
});

it('shows a single status glyph (folded dots)', () => {
  render(<PaneHeader {...baseProps()} />);
  expect(screen.getByTestId('pane-status-glyph')).toBeInTheDocument();
  // the three legacy dots are gone from the bar
  expect(screen.queryByTestId('ruflo-health-dot')).toBeNull();
  expect(screen.queryByTestId('agent-short-id')).toBeNull();
});

it('exposes the icon cluster: gear, fullscreen, split, minimise, close', () => {
  const onToggleFullscreen = vi.fn();
  const onToggleMinimise = vi.fn();
  const onSplit = vi.fn();
  render(<PaneHeader {...baseProps({ onToggleFullscreen, onToggleMinimise, onSplit })} />);
  expect(screen.getByTestId('pane-gear')).toBeInTheDocument();
  expect(screen.getByLabelText('Fullscreen pane')).toBeInTheDocument();
  expect(screen.getByTestId('pane-split')).toBeInTheDocument();
  expect(screen.getByLabelText('Minimise pane')).toBeInTheDocument();
  expect(screen.getByLabelText('Close pane')).toBeInTheDocument();
});

it('opens the gear popover with relocated metadata + actions', async () => {
  render(<PaneHeader {...baseProps()} />);
  fireEvent.click(screen.getByTestId('pane-gear'));
  const pop = await screen.findByTestId('pane-gear-popover');
  expect(pop).toBeInTheDocument();
  // branch + model now live in the popover, not on the bar
  expect(pop.textContent ?? '').toMatch(/dev|feature/);
});

it('Close calls onClose', () => {
  const onClose = vi.fn();
  render(<PaneHeader {...baseProps({ onClose })} />);
  fireEvent.click(screen.getByLabelText('Close pane'));
  expect(onClose).toHaveBeenCalledOnce();
});

it('fullscreen toggle calls onToggleFullscreen', () => {
  const onToggleFullscreen = vi.fn();
  render(<PaneHeader {...baseProps({ onToggleFullscreen })} />);
  fireEvent.click(screen.getByLabelText('Fullscreen pane'));
  expect(onToggleFullscreen).toHaveBeenCalledOnce();
});
```

Add a `baseProps` helper near `makeSession`:

```tsx
function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    session: makeSession(),
    paneIndex: 1,
    onFocus: vi.fn(),
    onClose: vi.fn(),
    providers: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }],
    onSplit: vi.fn(),
    onToggleMinimise: vi.fn(),
    isMinimised: false,
    isFullscreen: false,
    onToggleFullscreen: vi.fn(),
    uncommitted: 3,
    ...overrides,
  };
}
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/renderer/features/command-room/PaneHeader.test.tsx`
Expected: FAIL — `pane-title-pill` / `pane-gear` not found (old header still renders).

#### Task A2: Build `PaneGearPopover.tsx` (consolidated metadata + actions)

**Files:** Create `app/src/renderer/features/command-room/PaneGearPopover.tsx`

- [ ] **Step 3: Implement the popover.** It receives the same data the old bar had and hosts every relocated affordance. Reuse existing components rather than reimplementing.

Structure (Radix `Popover` triggered by the gear button in PaneHeader; this file exports the **content**):

```tsx
// Phase 4 — consolidated per-pane metadata + actions, opened from the header
// gear. Grid-view home for everything moved off the bar. NOT a 4-tab inspector.
import { History } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { useState } from 'react';
import { derivePaneIdentity } from './pane-identity';
import { useRufloDaemonHealth } from './useRufloDaemonHealth';
import { UsagePopover } from './UsagePopover';
import { GitActivityStrip } from './GitActivityStrip';
import { CheckpointPanel } from './CheckpointPanel';
import type { AgentSession } from '@/shared/types';

export function PaneGearPopoverBody({
  session, providers, uncommitted,
}: {
  session: AgentSession;
  providers?: { id: string; name: string }[];
  uncommitted?: number | null;
}) {
  const id = derivePaneIdentity(session);
  const health = useRufloDaemonHealth(session.workspaceId);
  const [rewindOpen, setRewindOpen] = useState(false);
  const canRewind = Boolean(session.worktreePath) &&
    (session.status === 'running' || session.status === 'exited');

  function relabel(displayProviderId: string | null) {
    void rpc.panes.setDisplayProvider({ sessionId: session.id, displayProviderId }).catch(() => undefined);
  }

  return (
    <div data-testid="pane-gear-popover" className="flex w-72 flex-col gap-2 p-1 text-[11px]">
      {/* Identity */}
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: id.agentAccent }} aria-hidden />
        <span className="font-medium">{id.alias}</span>
        <span className="text-muted-foreground">· {id.providerName} · {id.effortLabel}</span>
        <span className="ml-auto font-mono text-[10px] opacity-60">{id.agentId}</span>
      </div>
      {/* Branch / model / uncommitted */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground/70">branch</dt><dd className="truncate">{id.branch}</dd>
        <dt className="text-muted-foreground/70">model</dt><dd className="truncate">{id.modelLabel}</dd>
        <dt className="text-muted-foreground/70">cwd</dt><dd className="truncate" title={id.cwd}>{id.cwd}</dd>
        {typeof uncommitted === 'number' && uncommitted > 0 ? (
          <><dt className="text-muted-foreground/70">uncommitted</dt><dd>±{uncommitted}</dd></>
        ) : null}
      </dl>
      <GitActivityStrip worktreePath={id.worktreePath} />
      {/* Ruflo health */}
      <div className="text-muted-foreground" data-testid="pane-gear-ruflo">Ruflo MCP — {health.detail}</div>
      {/* Usage */}
      <UsagePopover session={session} />
      {/* Actions: relabel + rewind + brief (re-use existing handlers) */}
      <div className="mt-1 flex flex-col gap-1 border-t border-border/50 pt-1">
        {(providers ?? []).map((p) => (
          <button key={p.id} type="button" className="text-left hover:underline" onClick={() => relabel(p.id)}>
            Label as {p.name}
          </button>
        ))}
        {id.isRelabelled ? (
          <button type="button" className="text-left text-amber-500 hover:underline" onClick={() => relabel(null)}>
            Reset to {id.realProviderName}
          </button>
        ) : null}
        {canRewind ? (
          <details open={rewindOpen} onToggle={(e) => setRewindOpen((e.target as HTMLDetailsElement).open)}>
            <summary data-testid="pane-rewind-item" className="cursor-pointer select-none">
              <History className="mr-1 inline h-3 w-3" aria-hidden /> Rewind…
            </summary>
            <CheckpointPanel sessionId={session.id} />
          </details>
        ) : null}
      </div>
    </div>
  );
}
```

> Worker note: the C-5 "Brief" form is large; lift the existing `PaneHeaderBriefButton` body into this popover as a `<details>` section, OR keep the brief as a small button inside the popover that opens the existing form. Preserve `rpc.panes.brief`. Do not duplicate the form markup — move it.

#### Task A3: Rewrite `PaneHeader.tsx` to pill + icon cluster (GREEN)

**Files:** Modify `app/src/renderer/features/command-room/PaneHeader.tsx`

- [ ] **Step 4: Replace the header body.** Keep the file's props interface (no prop changes) and the provider colour stripe. The new single `h-7` row is:

```
[2px provider stripe]
[ pane-title-pill: ●status-glyph  alias · effort ]  …spacer…  [⚙ gear][⤢ fullscreen][⊞ split][– minimise][✕ close]
```

Implementation contract:
- **Title pill** (`data-testid="pane-title-pill"`): a single rounded element; `draggable`, `onDragStart={handleGripDragStart}` (keep the existing FEAT-12 handler + coachmark tooltip — move the coachmark onto the pill). Left-prefix a `data-testid="pane-status-glyph"` dot whose colour folds session status (`dotColor` logic stays: error→red, exited→grey, else green); tint the pill border with `agentColor(session.id)`. Pill text = `${id.alias} · ${id.effortLabel}` via `derivePaneIdentity`. Tooltip on the pill = `PROVIDER·N`, cwd, worktree (move the existing rich tooltip content here).
- **Gear** (`data-testid="pane-gear"`, `aria-label="Pane details & actions"`): Radix `Popover` whose `PopoverContent` renders `<PaneGearPopoverBody session={session} providers={providers} uncommitted={uncommitted} />`.
- **Fullscreen / minimise / close**: keep the EXISTING buttons + handlers + aria-labels verbatim (`onToggleFullscreen ?? onFocus`, `onToggleMinimise`, `onClose`).
- **Split**: collapse the two `PaneHeaderSplitButton`s into ONE `data-testid="pane-split"` button (`aria-label="Split pane"`) opening a DropdownMenu with a direction sub-choice then provider — or a flat menu of `{direction × provider}`. Keep `onSplit(direction, providerId)` + the `canSplit` disabled fallback. Keep the `PaneHeaderSplitButton`/disabled-placeholder logic; just render one trigger.
- **Apple restraint**: gear + split + minimise stay in the DOM/tab order but `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`; fullscreen + close stay full-opacity (the two always-available actions). Keep the `onDragStart={(e) => e.stopPropagation()}` guard on the cluster wrapper.
- **Delete** from this file: the standalone status dot, ruflo-health dot, agent-accent dot+short-id, the inline branch/model/uncommitted/`GitActivityStrip`/usage-coins span, and the provider-label relabel/rewind `Popover`+`DropdownMenu` block (all now in `PaneGearPopoverBody`). Remove now-unused imports (`Coins`, `GitBranch`, `Columns2`/`Rows2` if split merges to one icon, `Target` if unused, `History`, `UsagePopover`, `GitActivityStrip`, `CheckpointPanel`, `PopoverAnchor`).

- [ ] **Step 5: Run Lane A tests to GREEN**

Run: `npx vitest run src/renderer/features/command-room/PaneHeader.test.tsx`
Expected: PASS (all cases from Task A1).

- [ ] **Step 6: Typecheck the lane**

Run: `npx tsc -b`
Expected: no errors (worktree tsc may be laxer — lead re-gates in main).

- [ ] **Step 7: Commit Lane A**

```bash
git add app/src/renderer/features/command-room/PaneHeader.tsx \
        app/src/renderer/features/command-room/PaneGearPopover.tsx \
        app/src/renderer/features/command-room/PaneHeader.test.tsx
git commit -m "feat(phase4): BridgeSpace-strip pane header — title pill + gear popover + merged split (DEV-L1/BSP-F1/P2/P3)"
```

### LANE B — Grid stickiness (DEV-L2)

#### Task B1: `GridLayout.test.tsx` new cases (RED)

**Files:** Modify `app/src/renderer/features/command-room/GridLayout.test.tsx`

- [ ] **Step 1: Add cases.** Mock `rpc` for KV. Render a tiny harness that lets the test change `items.length` (shape change) and a divider, asserting fractions persist.

```tsx
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) } },
  rpcSilent: { kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) } },
}));
```

```tsx
import { reshapeFracs } from './GridLayout';

describe('reshapeFracs (proportion-preserving reflow)', () => {
  it('returns prev unchanged when length matches', () => {
    expect(reshapeFracs([2, 1], 2)).toEqual([2, 1]);
  });
  it('keeps surviving proportions when shrinking', () => {
    expect(reshapeFracs([2, 1, 1], 2)).toEqual([2, 1]); // not reset to [1,1]
  });
  it('seeds new tracks at the current average when growing', () => {
    expect(reshapeFracs([3, 1], 3)).toEqual([3, 1, 2]); // avg of [3,1] = 2
  });
  it('falls back to equal split from empty', () => {
    expect(reshapeFracs([], 3)).toEqual([1, 1, 1]);
  });
});
```

Plus a render-level case asserting persistence is attempted when `workspaceId` is set (use the existing divider drag/keyboard helpers in the file to mutate a fraction, then assert `rpc.kv.set` is called with a `grid.fracs.<id>` key — `await waitFor`). And a reduced-motion case: with the grid container, assert the transition class is present by default and that `data-dragging` suppresses it (toggle is internal — assert via the className when not dragging).

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/renderer/features/command-room/GridLayout.test.tsx`
Expected: FAIL — `reshapeFracs` not exported; no `kv.set`.

#### Task B2: Implement reshape + persistence + transition (GREEN)

**Files:** Modify `app/src/renderer/features/command-room/GridLayout.tsx`

- [ ] **Step 3: Add the pure helper** (top-level export, above the component):

```ts
/** DEV-L2 — preserve proportions across a pane add/remove instead of resetting.
 *  Shrink: slice (surviving tracks keep their fr). Grow: append the current
 *  average so a new track is "average width". fr units are relative — no
 *  renormalisation needed. */
export function reshapeFracs(prev: number[], next: number): number[] {
  if (next <= 0) return [];
  if (prev.length === next) return prev;
  if (prev.length === 0) return Array(next).fill(1);
  if (next < prev.length) return prev.slice(0, next);
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  return [...prev, ...Array(next - prev.length).fill(avg)];
}
```

- [ ] **Step 4: Add the `workspaceId` prop** to `Props<T>`:

```ts
/** DEV-L2 — when set, col/row fractions persist per (workspace,count) in KV. */
workspaceId?: string | null;
```

- [ ] **Step 5: Replace the reset (lines ~92-93)** with reshape:

```ts
// DEV-L2 — preserve user proportions across shape change (was Array(n).fill(1)).
if (colFracs.length !== cols) setColFracs((prev) => reshapeFracs(prev, cols));
if (rowFracs.length !== rows) setRowFracs((prev) => reshapeFracs(prev, rows));
```

- [ ] **Step 6: Add KV load + debounced save + drag flag.** Import `rpc` from `@/renderer/lib/rpc`. Add near the other state:

```ts
const [isDragging, setIsDragging] = useState(false);
const colKey = workspaceId ? `grid.fracs.${workspaceId}.${cols}.col` : null;
const rowKey = workspaceId ? `grid.fracs.${workspaceId}.${rows}.row` : null;

// Load persisted fracs when (workspace,count) changes. setState from async
// (external source) — allowed under react-hooks/set-state-in-effect.
useEffect(() => {
  if (!colKey) return;
  let alive = true;
  void rpc.kv.get(colKey).then((raw) => {
    if (!alive || !raw) return;
    try {
      const arr = JSON.parse(raw) as number[];
      if (Array.isArray(arr) && arr.length === cols) setColFracs(arr);
    } catch { /* ignore malformed */ }
  }).catch(() => undefined);
  return () => { alive = false; };
}, [colKey, cols]);
// …identical block for rowKey/rows/setRowFracs…

// Debounced persist on change (skips while dragging to avoid mid-drag churn).
useEffect(() => {
  if (!colKey || isDragging) return;
  const t = setTimeout(() => { void rpc.kv.set(colKey, JSON.stringify(colFracs)).catch(() => undefined); }, 250);
  return () => clearTimeout(t);
}, [colKey, colFracs, isDragging]);
// …identical block for rowKey/rowFracs…
```

In `startDrag`, set `setIsDragging(true)` at pointerdown and `setIsDragging(false)` in `up` (alongside the existing `document.body.dataset.dragging` flag).

- [ ] **Step 7: Add the reflow transition** to the grid container className (the `cn('relative grid h-full w-full', densitySpacing)` call). Append:

```ts
!isDragging && 'transition-[grid-template-columns,grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
```

(`motion-reduce:transition-none` is the reduced-motion gate; suppressing during drag keeps the divider 1:1.)

- [ ] **Step 8: Run Lane B tests to GREEN**

Run: `npx vitest run src/renderer/features/command-room/GridLayout.test.tsx`
Expected: PASS.

- [ ] **Step 9: Typecheck + commit**

```bash
git add app/src/renderer/features/command-room/GridLayout.tsx app/src/renderer/features/command-room/GridLayout.test.tsx
git commit -m "feat(phase4): grid preserves+persists+animates pane proportions (DEV-L2)"
```

### LANE C — Surfaces (BSP-F2 + sidebar/splash metadata)

#### Task C1: Extend `PaneContextSidebar.tsx` with identity sections

**Files:** Modify `app/src/renderer/features/command-room/PaneContextSidebar.tsx` + `.test.tsx`

- [ ] **Step 1: Test (RED)** — add to `PaneContextSidebar.test.tsx`:

```tsx
it('renders an Identity section with alias + provider + model + branch', () => {
  render(<PaneContextSidebar session={makeSession()} open />);
  const id = screen.getByTestId('pane-context-identity-section');
  expect(id.textContent ?? '').toMatch(/\w+/); // alias present
  expect(screen.getByTestId('pane-context-identity-section')).toBeInTheDocument();
});
```

(Reuse the file's existing mocks for `rpcSilent.usage`/`useRufloDaemonHealth`; add `makeSession` if absent.)

- [ ] **Step 2: Run RED** — `npx vitest run src/renderer/features/command-room/PaneContextSidebar.test.tsx` → FAIL.

- [ ] **Step 3: Implement** — add an `IdentitySection` above `McpSection`, fed by `derivePaneIdentity(session)`:

```tsx
import { derivePaneIdentity } from './pane-identity';

function IdentitySection({ session }: { session: AgentSession }) {
  const id = derivePaneIdentity(session);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="pane-context-identity-section">
      <h3 id={headingId} className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Identity</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted-foreground/70">agent</dt><dd className="font-medium">{id.alias} <span className="opacity-60">{id.agentId}</span></dd>
        <dt className="text-muted-foreground/70">provider</dt><dd>{id.providerName}</dd>
        <dt className="text-muted-foreground/70">model</dt><dd className="truncate">{id.modelLabel} · {id.effortLabel}</dd>
        <dt className="text-muted-foreground/70">branch</dt><dd className="truncate">{id.branch}</dd>
      </dl>
    </section>
  );
}
```

Mount it first in the `<aside>`, with a divider before `McpSection`.

- [ ] **Step 4: GREEN + commit** — `npx vitest run …PaneContextSidebar.test.tsx` → PASS.

#### Task C2: `PaneSplash.tsx` idle model-tier + cwd line

**Files:** Modify `app/src/renderer/features/command-room/PaneSplash.tsx` (+ test)

- [ ] **Step 5: Test (RED)** — assert the splash shows the model-tier + a basename of cwd (`data-testid="pane-splash-meta"`).

- [ ] **Step 6: Implement** — add a quiet line using `derivePaneIdentity(session)`:

```tsx
<div data-testid="pane-splash-meta" className="text-[11px] text-muted-foreground/60">
  {id.modelLabel} · {id.effortLabel} · {id.cwd}
</div>
```

(Place it under the existing splash content; keep it muted/quiet — BridgeSpace "body-at-idle".)

- [ ] **Step 7: GREEN + commit.**

#### Task C3: `PaneFooter.tsx` verify/extend under the new header

**Files:** Modify `app/src/renderer/features/command-room/PaneFooter.tsx` (+ test)

- [ ] **Step 8:** The dim status line (ANIM-3 verb+elapsed left, `auto mode on (shift+tab to cycle)` / `bypass permissions on` right) already satisfies BSP-F2. Run the existing test to confirm no regression: `npx vitest run src/renderer/features/command-room/PaneFooter.test.tsx` → PASS. Only adjust if the visual balance under the stripped header needs a spacing/tone tweak; if so, keep the existing `data-testid="pane-footer"` / `pane-aliveness` selectors. Commit only if changed.

```bash
git add app/src/renderer/features/command-room/PaneContextSidebar.tsx app/src/renderer/features/command-room/PaneContextSidebar.test.tsx \
        app/src/renderer/features/command-room/PaneSplash.tsx app/src/renderer/features/command-room/PaneSplash.test.tsx
git commit -m "feat(phase4): surface pane metadata in context sidebar + idle splash (BSP-F2-adjacent)"
```

---

## Phase 2 — Lead integration seam + gate

### Task 3: Thread `workspaceId` → `GridLayout`

**Files:** Modify `app/src/renderer/features/command-room/CommandRoom.tsx` (the `<GridLayout<SessionCell> …>` at ~:458)

- [ ] **Step 1:** Add `workspaceId={activeWorkspaceId}` to the `GridLayout` props (`activeWorkspaceId` already exists at `CommandRoom.tsx:59`).
- [ ] **Step 2:** Confirm `PaneShell` needs no new props (PaneHeader is self-contained; sidebar/splash read `session`). If a brief-form lift required a prop, wire it here.

### Task 4: Full gate in MAIN (decisive)

- [ ] **Step 1:** Merge lanes A/B/C into the integration branch (FF where possible; hand-merge the `PaneShell`/`CommandRoom` seam).
- [ ] **Step 2:** Run the full gate from `app/`:

```bash
npx tsc -b && npx vitest run && npm run lint && npm run build
npx playwright test tests/e2e/
```

Expected: all green. `tsc -b` in main checks test files (worktree tsc is laxer — fix any drift here). Run the **whole** `tests/e2e/` dir (not just smoke) per the release-gate rule.

- [ ] **Step 3:** Capture an e2e screenshot/trace of a multi-pane room and confirm visually: title pill + gear cluster, no dot-soup; add/remove a pane preserves proportions; reflow animates.
- [ ] **Step 4: Commit the integration + spec/plan docs.**

```bash
git add -A
git commit -m "feat(phase4): integrate pane chrome + grid lanes; thread workspaceId; full gate green"
```

### Task 5: Opus 2-stage review

- [ ] Dispatch an Opus reviewer over the full diff (correctness + sibling-twin drift + a11y + reduced-motion + KV-keying). Fold blocking findings; re-gate. (Do NOT tag/release — that's the operator's `/sigmalink-release` step.)

---

## Self-Review (writing-plans)

**Spec coverage:**
- DEV-L1 (header redesign) → Lane A (A1–A3). ✓
- BSP-F1 (single-accent ring + header-as-pill) → existing ring kept; pill in A3; single status glyph in A3. ✓
- BSP-P2 (branch pill) → branch surfaced in gear popover + sidebar (A2/C1). ✓ *(Operator chose off-bar; "pill" = popover/sidebar surfacing.)*
- BSP-P3 (alias + effort) → `agentAlias` (Task 1) + pill text (A3). ✓
- BSP-F2 (dim footer line) → C3 (verify/extend; already shipped). ✓
- DEV-L2 (preserve+persist+animate) → Lane B (B1–B2) + seam Task 3. ✓
- Anti-drift (popover vs sidebar) → `derivePaneIdentity` (Task 2), consumed by A2 + C1. ✓
- Tests in lockstep → A1, B1, C1/C2; full e2e in Task 4. ✓

**Placeholder scan:** No TBD/TODO; code shown for every code step. The two "lift the existing form/markup" notes (brief form, split-button) point at named existing code (`PaneHeaderBriefButton`, `PaneHeaderSplitButton`) rather than inventing it. ✓

**Type consistency:** `derivePaneIdentity` → `PaneIdentity` fields (`alias`, `agentId`, `agentAccent`, `providerName`, `providerColor`, `providerShort`, `realProviderName`, `isRelabelled`, `modelLabel`, `effortLabel`, `branch`, `cwd`, `worktreePath`) are used identically in A2 (popover) and C1 (sidebar). `reshapeFracs(prev, next)` signature identical in B1 test and B2 impl. `agentAlias(id)` / `AGENT_ALIAS_PALETTE` consistent across Task 1 + `pane-identity.ts`. ✓
