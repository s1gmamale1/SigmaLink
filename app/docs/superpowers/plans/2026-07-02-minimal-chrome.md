# Minimal Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure four chrome surfaces (launcher landing, titlebar, sidebar, kbd-hint footer) to BridgeMind-minimal structure, adapted to SigmaLink's theme tokens.

**Architecture:** Renderer-only restyle-in-place. A new `'intent'` wizard step hosts a pure-landing `LauncherLanding` component (hero + stacked mode rows + kbd footer); `Breadcrumb` becomes a brand bar; `Sidebar` drops its wordmark; `WorkspacesPanel` header gains a count. Zero main-process / RPC / launch-contract changes.

**Tech Stack:** React 19 + TypeScript (erasableSyntaxOnly — no ctor param props/enums), Tailwind tokens, vitest + jsdom + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-02-minimal-chrome-design.md`

## Global Constraints

- Worktree: `/Users/aisigma/projects/SigmaLink-wt-minimal-chrome` on branch `feat/minimal-chrome`. ALL commands run from its `app/` directory. NEVER touch `/Users/aisigma/projects/SigmaLink` (the main tree has unrelated WIP).
- Zero hardcoded colors — theme tokens only (`bg-card`, `border-border`, `text-muted-foreground`, `text-primary`, `accent`). Must read on all 15 themes incl. light `parchment`.
- Launch RPCs / `LaunchPlan` contract / main process: DO NOT TOUCH.
- Renderer `.tsx` tests need the jsdom docblock (`// @vitest-environment jsdom`? — NO: this repo uses `/** @vitest-environment jsdom */` docblock style; copy the header of an existing sibling test), `vi.hoisted()` mocks, `afterEach(cleanup)`.
- Files stay under 500 lines.
- Run tests scoped while iterating; the FULL gate runs in Task 6.
- Commit after each task with the exact message given. NEVER push or tag.

---

### Task 1: `'intent'` step machinery (modes.ts + Stepper)

**Files:**
- Modify: `src/renderer/features/workspace-launcher/Stepper.tsx` (StepId union + STEP_LABELS)
- Modify: `src/renderer/features/workspace-launcher/modes.ts`
- Test: `src/renderer/features/workspace-launcher/modes.test.ts`

**Interfaces:**
- Produces: `StepId = 'intent' | 'start' | 'layout' | 'agents' | 'sessions'`; `stepsForMode('space')` → `['intent','start','layout','agents','sessions']`, every other mode → `['intent','start']`. `prevStepForMode(mode,'start')` → `'intent'`. `stepAfterStart` UNCHANGED.

- [ ] **Step 1: Read `modes.test.ts`, add failing expectations**

Update every existing `stepsForMode` assertion to include the leading `'intent'`, and add:

```ts
describe('intent landing step (minimal-chrome)', () => {
  it('prepends intent to every mode', () => {
    expect(stepsForMode('space')).toEqual(['intent', 'start', 'layout', 'agents', 'sessions']);
    expect(stepsForMode('single')).toEqual(['intent', 'start']);
    expect(stepsForMode('swarm')).toEqual(['intent', 'start']);
    expect(stepsForMode('canvas')).toEqual(['intent', 'start']);
  });
  it('navigates start ↔ intent', () => {
    expect(prevStepForMode('space', 'start')).toBe('intent');
    expect(nextStepForMode('swarm', 'intent')).toBe('start');
    expect(prevStepForMode('space', 'intent')).toBeNull();
  });
  it('stepAfterStart is unchanged', () => {
    expect(stepAfterStart('space')).toBe('layout');
    expect(stepAfterStart('single')).toBe('start');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/renderer/features/workspace-launcher/modes.test.ts` → FAIL (arrays missing `'intent'`).

- [ ] **Step 3: Implement**

`Stepper.tsx`: `export type StepId = 'intent' | 'start' | 'layout' | 'agents' | 'sessions';` and add `intent: 'Intent'` to `STEP_LABELS`.

`modes.ts`:
```ts
const FULL_STEPS: StepId[] = ['intent', 'start', 'layout', 'agents', 'sessions'];

export function stepsForMode(mode: LauncherMode): StepId[] {
  return mode === 'space' ? FULL_STEPS : ['intent', 'start'];
}
```
(Update both functions' doc comments to describe the landing step. `nextStepForMode`/`prevStepForMode`/`stepAfterStart` bodies need no change — they derive from the list.)

- [ ] **Step 4: Verify pass** — same vitest command → PASS. Also `npx vitest run src/renderer/features/workspace-launcher/` (Launcher tests may not compile-break yet since 'start' remains a valid StepId — note any failures, they belong to Task 3).

- [ ] **Step 5: Commit** — `git add -A src/renderer/features/workspace-launcher && git commit -m "feat(launcher): add 'intent' landing step to wizard step machinery"`

---

### Task 2: `Kbd` primitive + `LauncherLanding` component

**Files:**
- Create: `src/renderer/components/Kbd.tsx`
- Create: `src/renderer/features/workspace-launcher/LauncherLanding.tsx`
- Test: `src/renderer/features/workspace-launcher/LauncherLanding.test.tsx`

**Interfaces:**
- Consumes: `LauncherMode` from `./modes`; `Monogram` from `@/renderer/components/Monogram` (`<Monogram size={n} />`); `MOD_KEY_LABEL` from `@/renderer/lib/shortcuts`; `rpcSilent.kv.get('canvas.gaSign')` (ALPHA gate, copied from IntentCards).
- Produces: `<LauncherLanding onPick={(mode: LauncherMode) => void} onOpenSettings={() => void} />` and `<Kbd>{children}</Kbd>`.
- Test-ids preserved from IntentCards: `intent-card-space|swarm|single|canvas` (keeps sibling integration tests green). New: `landing-footer`.

- [ ] **Step 1: Write the failing test**

```tsx
/** @vitest-environment jsdom */  // ← copy exact docblock style from Launcher.test.tsx
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { kvGet } = vi.hoisted(() => ({ kvGet: vi.fn(async () => null as string | null) }));
vi.mock('@/renderer/lib/rpc', () => ({ rpcSilent: { kv: { get: kvGet } } }));

import { LauncherLanding } from './LauncherLanding';

afterEach(cleanup);

describe('LauncherLanding', () => {
  it('renders hero + all four mode rows with kbd labels', () => {
    render(<LauncherLanding onPick={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByText('Command the fleet.')).toBeTruthy();
    expect(screen.getByText('Choose how you want to work.')).toBeTruthy();
    for (const id of ['space', 'swarm', 'single', 'canvas']) {
      expect(screen.getByTestId(`intent-card-${id}`)).toBeTruthy();
    }
  });
  it('onPick fires with the row mode', async () => {
    const onPick = vi.fn();
    render(<LauncherLanding onPick={onPick} onOpenSettings={vi.fn()} />);
    await userEvent.click(screen.getByTestId('intent-card-swarm'));
    expect(onPick).toHaveBeenCalledWith('swarm');
  });
  it('shows ALPHA chip until canvas.gaSign === "1"', async () => {
    render(<LauncherLanding onPick={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(await screen.findByText('Alpha')).toBeTruthy();
  });
  it('footer: kbd hints + settings affordance', async () => {
    const onOpenSettings = vi.fn();
    render(<LauncherLanding onPick={vi.fn()} onOpenSettings={onOpenSettings} />);
    const footer = screen.getByTestId('landing-footer');
    expect(footer.textContent).toContain('Command palette');
    expect(footer.textContent).toContain('Memory');
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
```
(If `userEvent` isn't used elsewhere in this repo's tests, use `fireEvent.click` from RTL instead — match sibling test convention.)

- [ ] **Step 2: Verify failure** — `npx vitest run src/renderer/features/workspace-launcher/LauncherLanding.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement `Kbd.tsx`**

```tsx
// Tiny presentational <kbd> chip — shared by the launcher landing rows and
// the landing footer hints. Token-only styling.
import type { ReactNode } from 'react';

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}
```

- [ ] **Step 4: Implement `LauncherLanding.tsx`**

```tsx
// Minimal-chrome landing (BridgeMind-structure, SigmaLink tokens). Pure
// landing: hero + four stacked mode rows + kbd-hint footer. Screenshot-bare
// rows — blurbs live in `title` tooltips. Replaces IntentCards (deleted).
// The ALPHA gate on SigmaCanvas (`canvas.gaSign`) is preserved verbatim.

import { useEffect, useState } from 'react';
import { Layers, Network, Settings as SettingsIcon, Terminal, Wand2 } from 'lucide-react';
import { Kbd } from '@/renderer/components/Kbd';
import { Monogram } from '@/renderer/components/Monogram';
import { rpcSilent } from '@/renderer/lib/rpc';
import { MOD_KEY_LABEL } from '@/renderer/lib/shortcuts';
import type { LauncherMode } from './modes';

interface LandingRowSpec {
  id: LauncherMode;
  title: string;
  hotkey: string; // display label only — bindings are a WISHLIST item
  blurb: string;  // tooltip
  icon: typeof Layers;
  alpha?: boolean;
}

const LANDING_ROWS: LandingRowSpec[] = [
  {
    id: 'space',
    title: 'SigmaLink',
    hotkey: 'T',
    blurb: 'A clean grid of terminals — each pane gets its own git worktree.',
    icon: Layers,
  },
  {
    id: 'swarm',
    title: 'SigmaSwarm',
    hotkey: 'S',
    blurb: 'A team of AI agents tackles one goal together, each on its own branch.',
    icon: Network,
  },
  {
    id: 'single',
    title: 'Single terminal',
    hotkey: '1',
    blurb: 'One plain terminal in the folder you pick.',
    icon: Terminal,
  },
  {
    id: 'canvas',
    title: 'SigmaCanvas',
    hotkey: '2',
    blurb: 'The visual design canvas for this workspace.',
    icon: Wand2,
    alpha: true,
  },
];

interface LauncherLandingProps {
  onPick: (mode: LauncherMode) => void;
  onOpenSettings: () => void;
}

export function LauncherLanding({ onPick, onOpenSettings }: LauncherLandingProps) {
  const [gaSign, setGaSign] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const v = await rpcSilent.kv.get('canvas.gaSign');
        if (alive) setGaSign(v === '1');
      } catch {
        /* default false */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="sl-fade-in flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-6 py-10">
      {/* Hero — brand + per-theme tinted tagline. */}
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex items-center gap-3">
          <Monogram size={36} />
          <span className="text-2xl font-semibold tracking-tight">SigmaLink</span>
        </div>
        <div className="text-4xl font-bold tracking-tight text-primary">Command the fleet.</div>
        <p className="text-sm text-muted-foreground">Choose how you want to work.</p>
      </div>

      {/* Stacked mode rows. */}
      <div className="flex w-full max-w-md flex-col gap-3">
        {LANDING_ROWS.map((row) => {
          const Icon = row.icon;
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onPick(row.id)}
              title={row.blurb}
              data-testid={`intent-card-${row.id}`}
              className="group relative flex w-full items-center gap-3 overflow-hidden rounded-xl border border-border bg-card/40 px-4 py-3.5 text-left transition-[transform,border-color,background-color,box-shadow] duration-200 ease-smooth hover:-translate-y-0.5 hover:border-ring/50 hover:bg-card hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* 1px token-driven gradient hairline (top edge). */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-primary/25 via-accent/20 to-transparent"
              />
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent-foreground">
                <Icon className="h-4.5 w-4.5" />
              </span>
              <span className="flex-1 text-sm font-medium tracking-tight">{row.title}</span>
              {row.alpha && !gaSign ? (
                <span className="rounded-sm bg-accent/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-accent-foreground">
                  Alpha
                </span>
              ) : null}
              <Kbd>
                {MOD_KEY_LABEL}
                {row.hotkey}
              </Kbd>
            </button>
          );
        })}
      </div>

      {/* Kbd-hint footer — only bindings that actually exist (mod+k, mod+o). */}
      <div
        data-testid="landing-footer"
        className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[11px] uppercase tracking-wider text-muted-foreground"
      >
        <span className="flex items-center gap-1.5">
          <Kbd>{MOD_KEY_LABEL}K</Kbd> Command palette
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>{MOD_KEY_LABEL}O</Kbd> Memory
        </span>
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 uppercase tracking-wider transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Open settings"
        >
          <SettingsIcon className="h-3 w-3" /> Settings
        </button>
      </div>
    </div>
  );
}
```
Note: `h-4.5 w-4.5` is not a stock Tailwind size — use `h-[18px] w-[18px]` or `h-5 w-5`; check what the repo's Tailwind config allows and prefer `h-5 w-5` if arbitrary values are uncommon in siblings.

- [ ] **Step 5: Verify pass** — `npx vitest run src/renderer/features/workspace-launcher/LauncherLanding.test.tsx` → PASS.

- [ ] **Step 6: Commit** — `git add src/renderer/components/Kbd.tsx src/renderer/features/workspace-launcher/LauncherLanding.tsx src/renderer/features/workspace-launcher/LauncherLanding.test.tsx && git commit -m "feat(launcher): LauncherLanding hero + Kbd primitive (BridgeMind-minimal structure)"`

---

### Task 3: Wire the landing into `Launcher.tsx`, delete `IntentCards` + dead `BottomActionRow`

**Files:**
- Modify: `src/renderer/features/workspace-launcher/Launcher.tsx`
- Delete: `src/renderer/features/workspace-launcher/IntentCards.tsx`
- Test: `src/renderer/features/workspace-launcher/Launcher.test.tsx` (+ `Launcher.sessions.integration.test.tsx`, `Launcher.swarm-hydration.test.tsx` if they mount the launcher at step 'start')

**Interfaces:**
- Consumes: `LauncherLanding` (Task 2), `'intent'` StepId (Task 1).
- Produces: launcher opens on the landing; `pickIntent(mode)` = set mode (with single-mode preset pin/restore) + `setStep('start')`.

- [ ] **Step 1: Write failing tests** (in `Launcher.test.tsx`, following its existing mock setup exactly):

```tsx
it('opens on the intent landing (minimal-chrome)', async () => {
  renderLauncher(); // ← whatever helper the file already uses
  expect(await screen.findByText('Command the fleet.')).toBeTruthy();
  // wizard card absent on the landing:
  expect(screen.queryByLabelText('Wizard progress')).toBeNull();
});

it('clicking a mode row advances to the folder step', async () => {
  renderLauncher();
  fireEvent.click(await screen.findByTestId('intent-card-space'));
  expect(await screen.findByText('Pick folder')).toBeTruthy(); // StartStep CTA
});

it('clicking the CURRENT mode row still advances (no changeMode early-return trap)', async () => {
  renderLauncher();
  fireEvent.click(await screen.findByTestId('intent-card-space')); // 'space' is the default mode
  expect(await screen.findByText('Pick folder')).toBeTruthy();
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run src/renderer/features/workspace-launcher/Launcher.test.tsx` → new tests FAIL.

- [ ] **Step 3: Implement in `Launcher.tsx`**

1. `const [step, setStep] = useState<StepId>('intent');`
2. Refactor `changeMode` into a pure mode-application + add the landing handler:

```tsx
// N1 + minimal-chrome — apply a mode switch (preset pin/restore for 'single')
// WITHOUT deciding the step. changeMode (stepper path) resets to the folder
// step only on an actual change; pickIntent (landing path) ALWAYS advances,
// including when the user re-picks the current mode.
function applyMode(next: LauncherMode): void {
  if (next === mode) return;
  setError(null);
  setMode(next);
  if (next === 'single') {
    if (mode === 'space') setGridPreset(preset);
    setPreset(1);
  } else if (mode === 'single') {
    setPreset(gridPreset);
  }
}

function changeMode(next: LauncherMode): void {
  if (next === mode) return;
  applyMode(next);
  setStep('start');
}

function pickIntent(next: LauncherMode): void {
  applyMode(next);
  setStep('start');
}
```
3. Stepper display: hide the intent crumb —
```tsx
const visibleSteps = useMemo(
  () => stepsForMode(mode).filter((s) => s !== 'intent'),
  [mode],
);
```
(Back from 'start' still reaches the landing via `prevStepForMode`, which reads the UNfiltered list.) Add `intent: true` to the `completed` memo so jump-back logic stays consistent.
4. Render: at the top of the return, branch on the landing —
```tsx
if (step === 'intent') {
  return (
    <div className="sl-fade-in flex h-full flex-col overflow-y-auto p-6">
      {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}
      <LauncherLanding
        onPick={pickIntent}
        onOpenSettings={() => dispatch({ type: 'SET_ROOM', room: 'settings' })}
      />
    </div>
  );
}
```
5. In the `step === 'start'` block: remove `<IntentCards …/>` + its wrapping divider — StartStep renders alone.
6. Delete the `<BottomActionRow />` usage and the whole `BottomActionRow` function (two of its three buttons were dead `onClick={() => undefined}` stubs; Settings moved to the landing footer). Remove now-unused imports (`Plus`, `SettingsIcon`, `SplitSquareHorizontal`, `IntentCards`).
7. Wizard-step header: the big `Build the future.` tagline (old BridgeSpace copy) would double-hero right after the landing — shrink the header to the muted subtitle only:
```tsx
<header className="flex flex-col gap-1">
  <div className="text-lg font-semibold tracking-tight">Set up your workspace</div>
  <div className="text-sm text-muted-foreground">{headerSubtitle(mode)}</div>
</header>
```
8. `git rm src/renderer/features/workspace-launcher/IntentCards.tsx`
9. `grep -rn "IntentCards\|BottomActionRow\|intent-card-\|Build the future" src/ tests/ e2e/ 2>/dev/null` — update every surviving reference (test twins!). `intent-card-*` testids still exist (LauncherLanding), so integration tests that click them may only need a landing-first navigation step added.

- [ ] **Step 4: Verify** — `npx vitest run src/renderer/features/workspace-launcher/` → ALL PASS (fix any integration tests that assumed step 'start' on mount by clicking `intent-card-<mode>` first).

- [ ] **Step 5: Commit** — `git add -A src/renderer/features/workspace-launcher && git commit -m "feat(launcher): pure landing step — wire LauncherLanding, retire IntentCards + dead BottomActionRow"`

---

### Task 4: Breadcrumb → brand bar

**Files:**
- Modify: `src/renderer/features/top-bar/Breadcrumb.tsx`
- Test: `src/renderer/features/top-bar/Breadcrumb.test.tsx`

**Interfaces:**
- Consumes: `Monogram`, `rpc.app.getVersion(): Promise<string>` (same source as `use-whats-new.ts`).
- Produces: ONE bar for both empty/active states, `data-testid="breadcrumb"`. `breadcrumb-empty` testid RETIRED — grep the whole repo for it and update consumers.
- Preserved invariants: `h-8`, `dragStyle()`, `WIN32_WCO_RESERVE_PX = 140` right-padding on win32, `sl-glass-toolbar`, memory-graph button keeps `noDragStyle()` + `data-testid="breadcrumb-memory-graph"`.

- [ ] **Step 1: Rewrite tests first** (keep the file's existing `window.sigma` mock scaffolding; WCO padding tests survive as-is):

```tsx
it('renders the brand bar: monogram + wordmark + version', async () => {
  versionMock.mockResolvedValue('9.9.9');
  renderBreadcrumb(); // existing helper/pattern in the file
  expect(screen.getByText('SigmaLink')).toBeTruthy();
  expect(await screen.findByText('v9.9.9')).toBeTruthy();
});

it('never renders the old workspace/user text', async () => {
  renderBreadcrumb({ activeWorkspace: someWorkspace });
  expect(screen.queryByText(/Workspace \d/)).toBeNull();
  expect(screen.queryByText(/No workspace open/)).toBeNull();
});

it('renders ONE breadcrumb testid regardless of workspace state', () => {
  renderBreadcrumb({ activeWorkspace: null });
  expect(screen.getByTestId('breadcrumb')).toBeTruthy();
  expect(screen.queryByTestId('breadcrumb-empty')).toBeNull();
});

it('memory-graph + ruflo pill only with an active workspace', () => {
  renderBreadcrumb({ activeWorkspace: null });
  expect(screen.queryByTestId('breadcrumb-memory-graph')).toBeNull();
});
```
Mock `rpc.app.getVersion` via the file's existing `vi.mock('@/renderer/lib/rpc', …)` block (add `app: { getVersion: versionMock }`).

- [ ] **Step 2: Verify failure** — `npx vitest run src/renderer/features/top-bar/Breadcrumb.test.tsx` → FAIL.

- [ ] **Step 3: Rewrite the component**

```tsx
// Minimal-chrome brand bar (2026-07-02 spec). One bar for both the empty and
// active-workspace states: rooms menu · Σ monogram · wordmark · muted version,
// with the functional icon cluster right-aligned. The old
// `Workspace N / user — name` text and its `app.userName` kv plumbing are
// deliberately removed — workspace identity lives in the sidebar.

import { useCallback, useEffect, useState } from 'react';
import { Network } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { dragStyle, noDragStyle } from '@/renderer/lib/drag-region';
import { IS_WIN32 } from '@/renderer/lib/platform';
import { Monogram } from '@/renderer/components/Monogram';
import { RufloReadinessPill } from '@/renderer/components/RufloReadinessPill';
import { NotificationBell } from '@/renderer/features/notifications/NotificationBell';
import { RoomsMenuButton } from './RoomsMenuButton';
import { RightRailSwitcher } from './RightRailSwitcher';

// V1.2.0 Windows port — reserve 140px … (keep the existing comment verbatim)
const WIN32_WCO_RESERVE_PX = 140;

export function Breadcrumb() {
  const dispatch = useAppDispatch();
  const active = useAppStateSelector((s) => s.activeWorkspace);
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    let alive = true;
    void rpc.app
      .getVersion()
      .then((v) => {
        if (alive && typeof v === 'string' && v.trim()) setVersion(v.trim());
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const openMemoryGraph = useCallback(() => {
    dispatch({ type: 'SET_ROOM', room: 'memory' });
    dispatch({ type: 'SET_PENDING_MEMORY_GRAPH_VIEW', pending: true });
  }, [dispatch]);

  return (
    <div
      className="sl-glass-toolbar flex h-8 items-center gap-2 border-b border-border bg-background/60 px-4 text-xs"
      style={{
        ...dragStyle(),
        paddingRight: IS_WIN32 ? WIN32_WCO_RESERVE_PX : undefined,
      }}
      data-testid="breadcrumb"
    >
      <RoomsMenuButton />
      <Monogram size={14} />
      <span className="font-medium text-foreground">SigmaLink</span>
      {version ? <span className="text-muted-foreground">v{version}</span> : null}
      <div className="flex-1" />
      <NotificationBell />
      {active ? (
        <button
          type="button"
          onClick={openMemoryGraph}
          aria-label="Open memory graph"
          data-testid="breadcrumb-memory-graph"
          style={noDragStyle()}
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <Network className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <RightRailSwitcher />
      {active ? <RufloReadinessPill /> : null}
    </div>
  );
}
```
Delete `extractUserFromPath`, the `userName` state/effect, `useMemo`/`workspaces` selector imports if now unused. CHECK before adding `<div className="flex-1" />`: if `NotificationBell` (or another right-cluster child) already self-aligns with `ml-auto`, keep the bar's existing alignment mechanism instead — inspect those components first and match.

- [ ] **Step 4: Grep the twins** — `grep -rn "breadcrumb-empty\|No workspace open\|app.userName" src/ e2e/ tests/ 2>/dev/null` → update every reference (e2e specs included; if an e2e spec references them, update the selector to `breadcrumb`).

- [ ] **Step 5: Verify** — `npx vitest run src/renderer/features/top-bar/` → PASS.

- [ ] **Step 6: Commit** — `git add -A src/renderer/features/top-bar && git commit -m "feat(top-bar): breadcrumb → minimal brand bar (monogram + wordmark + version)"`

---

### Task 5: Sidebar polish — drop wordmark, header count

**Files:**
- Modify: `src/renderer/features/sidebar/Sidebar.tsx` (header block ~line 320-343)
- Modify: `src/renderer/features/sidebar/WorkspacesPanel.tsx` (header block ~line 318-321)
- Test: `src/renderer/features/sidebar/Sidebar.test.tsx`, `src/renderer/features/sidebar/WorkspacesPanel.test.tsx`

**Interfaces:**
- Consumes: nothing new. The Σ `Monogram` button's onClick (collapse/expand toggle) is UNTOUCHED — operator explicitly wants it kept.
- Produces: expanded sidebar header = Σ button + spacer + collapse chevron (no `SigmaLink` wordmark text). WorkspacesPanel header = `Workspaces` + muted count of open workspaces.

- [ ] **Step 1: Failing tests**

In `Sidebar.test.tsx` (reuse its existing render scaffolding):
```tsx
it('renders no wordmark text in the header (brand moved to titlebar)', () => {
  renderSidebar();
  expect(screen.queryByText('SigmaLink')).toBeNull();
});
```
In `WorkspacesPanel.test.tsx`:
```tsx
it('shows the open-workspace count in the header', () => {
  renderPanel({ workspaces: [wsA, wsB, wsC] }); // 3 open workspaces
  const header = screen.getByTestId('workspaces-header-count');
  expect(header.textContent).toBe('3');
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run src/renderer/features/sidebar/` → the two new tests FAIL. If an EXISTING Sidebar test asserts the wordmark, update it in the same edit.

- [ ] **Step 3: Implement**

`Sidebar.tsx` — replace the wordmark block:
```tsx
{collapsed ? null : <div className="flex-1" />}
```
(keeping the Σ `Monogram` button and the collapse chevron exactly as they are; verify the header row still has a drag region + correct height after the text is gone).

`WorkspacesPanel.tsx` — header label becomes:
```tsx
<div className="flex flex-1 items-baseline gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
  Workspaces
  <span data-testid="workspaces-header-count" className="text-[10px] text-muted-foreground/70">
    {workspaces.length}
  </span>
</div>
```

- [ ] **Step 4: Verify** — `npx vitest run src/renderer/features/sidebar/` → PASS (includes glass + rsp suites).

- [ ] **Step 5: Commit** — `git add -A src/renderer/features/sidebar && git commit -m "feat(sidebar): minimal header — wordmark to titlebar, workspace count in panel header"`

---

### Task 6: Full gate + repo-wide twin sweep

**Files:** none new — verification + fallout fixes only.

- [ ] **Step 1: Twin sweep** — `grep -rn "IntentCards\|BottomActionRow\|breadcrumb-empty\|No workspace open\|Workspace \$\{\|extractUserFromPath" src/ e2e/ tests/ 2>/dev/null` → zero live references (docs/ hits are fine).
- [ ] **Step 2: Typecheck** — `npx tsc -b` → clean. (Worktree node_modules is a symlink to the main tree — if tsc reports errors from OUTSIDE this worktree's `src/`, filter them out per the known symlink-leak issue, but errors in our files must be fixed.)
- [ ] **Step 3: Lint** — `npx eslint . --max-warnings 0` → clean (PR #207: tsc+vitest alone MISS eslint-only failures like unused imports — this step is mandatory).
- [ ] **Step 4: Full unit suite** — `npx vitest run` → ALL PASS (full suite, not scoped — mocked-sibling breakage is invisible to scoped runs). Capture the exit code directly; do NOT pipe through `tail`.
- [ ] **Step 5: Build** — `npm run build` → succeeds.
- [ ] **Step 6: Commit any fallout fixes** — `git add -A && git commit -m "fix(minimal-chrome): gate fallout"` (only if fixes were needed).

---

## Post-plan orchestration (lead runs these, NOT plan tasks)

1. Live-dial: iso Electron launch, operator eyeballs landing → titlebar → sidebar → footer, one at a time.
2. WISHLIST entries: landing-row real key bindings (⌘T/⌘S/⌘1/⌘2) · sidebar attention-count numeric badge · titlebar version-click → What's New.
3. `/sigma-check` — PR, independent review, merge on green.
