# Perf: Render & Bundle Cluster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut ~450 kB of eager vendor JS from every boot (recharts/d3 riding the vendor-react chunk) and stop the hottest always-mounted renderer components from re-rendering on every global dispatch (broad `useAppState()` context reads, unmemoized per-row components, unbounded swarm-message growth).

**Architecture:** Three mechanisms, applied surgically. (1) **Bundle:** replace the sole recharts consumer (a 48×16 px sparkline) with ~30 lines of inline SVG, uninstall recharts, and fix the `manualChunks` matcher whose `id.includes('react')` substring match is the class-of-bug that dragged `react-smooth`/`react-transition-group` (and via rollup hoisting, the whole recharts+d3 subtree) into the eager `vendor-react` chunk. (2) **Render isolation:** convert broad `useAppState()` context reads to `useAppStateSelector` (PERF-3 pattern, `useSyncExternalStore` on `appStateStore`) and `memo()` the per-row components (`MailboxBubble`, `ChatRow`). (3) **Growth bound:** cap the per-swarm message array at 500 inside `APPEND_SWARM_MESSAGE`.

**Tech Stack:** React 19, Vite/Rollup `manualChunks`, vitest + @testing-library/react (jsdom), the existing `appStateStore`/`useAppStateSelector` external store (`src/renderer/app/state.hook.ts`).

---

## ⚠️ Pre-flight: RE-VERIFY FILE STATE BEFORE EXECUTING (WIP hazard)

This repo's working tree is **shared by concurrent sessions and gets stomped mid-task**. At conversation start, `ChatTranscript.tsx` had uncommitted WIP on branch `feat/bsp-pane-tiling`; by planning time the tree had silently flipped to `main @ a4156ac` and the file was clean (md5 `74846b82ee2fe7d2359aeb35395bfe96`, identical to HEAD). All line anchors and code in this plan were derived from **committed state at `a4156ac`** (`git show HEAD:<path>`).

Before executing **each** task:

- [ ] Run (from `/Users/aisigma/projects/SigmaLink/app`):

```bash
git log -1 --format='%h %s' && git status --short -- \
  vite.config.ts package.json \
  src/renderer/features/command-room/GitActivityStrip.tsx \
  src/renderer/features/command-room/GitActivityStrip.test.tsx \
  src/renderer/features/swarm-room/MailboxBubble.tsx \
  src/renderer/features/jorvis-assistant/ChatTranscript.tsx \
  src/renderer/features/jorvis-assistant/JorvisRoom.tsx \
  src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts \
  src/renderer/app/state.reducer.ts \
  src/renderer/features/editor/EditorTab.tsx \
  src/renderer/components/RufloReadinessPill.tsx \
  src/renderer/features/onboarding/
```

- [ ] If ANY target file is dirty (especially `ChatTranscript.tsx` — concurrent jorvis-session WIP), STOP and coordinate with the operator before touching it. If HEAD has moved past `a4156ac`, re-derive the line anchors (the code blocks below quote enough surrounding context to re-locate every edit).
- [ ] Execute in an **isolated worktree off `origin/main`** (`git worktree add ../sl-perf -b perf/render-and-bundle origin/main`), commit atomically per task, and re-run the final gate in MAIN before merging — the shared tree gets stomped (see Coordination notes).

## Architecture decision (Finding 1): inline SVG over `React.lazy(recharts)`

Both options were evaluated:

| | A: `React.lazy(GitActivityStrip)` + Suspense + matcher fix | B (CHOSEN): inline SVG bars + uninstall recharts + matcher fix |
|---|---|---|
| Eager bytes saved | ~450 kB moved to an async chunk | ~450 kB **deleted** |
| First popover open | network/parse hitch + Suspense flash in a 16 px strip | instant, synchronous |
| Dependency footprint | recharts + 11 `d3-*` + react-smooth + react-transition-group + victory-vendor stay installed | all removed |
| Complexity | lazy boundary + fallback + chunk verification | ~30-line SVG, same a11y contract |

**Verified facts driving the choice:** recharts has exactly ONE consumer in the codebase (`grep -rn "from 'recharts'" src/` → only `GitActivityStrip.tsx`; no `d3` imports anywhere). The chart is a 48×16 px bar strip with **no axes, no tooltip, no legend, and `isAnimationActive={false}`** — recharts buys nothing here. Option B is chosen. The matcher fix ships regardless because `id.includes('react')` matching any `*react*`-named package is the underlying class of bug.

**Baseline (recorded 2026-06-10, `npx vite build` on main `a4156ac`):**

```
dist/assets/vendor-react-Ck0qBH5V.js   636.08 kB │ gzip: 187.45 kB   ← target
dist/assets/vendor-xterm-9GY8wIfa.js   443.43 kB │ gzip: 113.90 kB
dist/assets/index-COOXBOGr.js          280.96 kB │ gzip:  81.34 kB
dist/assets/SettingsRoom-BNXERBQM.js   137.85 kB │ gzip:  32.07 kB
✓ built in 5.19s
```

react 19 + react-dom + scheduler alone are ≈180 kB pre-gzip, so ≈450 kB of that chunk is recharts/d3/react-smooth/react-transition-group freight (plus other `*react*`-named strays like `react-remove-scroll` that the precise matcher will also evict — total eager bytes is the number to compare).

## File Structure

```
app/
  vite.config.ts                                              MODIFY — precise vendor-react matcher (Task 1)
  package.json                                                MODIFY — remove recharts dep (Task 1)
  src/renderer/
    features/command-room/
      GitActivityStrip.tsx                                    MODIFY — recharts BarChart → inline SVG (Task 1)
      GitActivityStrip.test.tsx                               MODIFY — assert SVG bars; drop ResizeObserver stub (Task 1)
    features/swarm-room/
      MailboxBubble.tsx                                       MODIFY — narrow selector + memo (Task 2)
      MailboxBubble.render-count.test.tsx                     CREATE — render-isolation probe (Task 2)
    features/jorvis-assistant/
      ChatTranscript.tsx                                      MODIFY — memo(ChatRow) + useMemo prettyPrint (Task 3)
      ChatTranscript.render-count.test.tsx                    CREATE — row-memo probe (Task 3)
      JorvisRoom.tsx                                          MODIFY — selectors + useAppDispatch (Task 5)
      use-jorvis-conversations.ts                             MODIFY — selector (Task 5 SIBLING — mandatory)
      JorvisRoom.render-count.test.tsx                        CREATE — real-provider isolation probe (Task 5)
      JorvisRoom.test.tsx                                     MODIFY — extend state-module mock (Task 5)
      JorvisRoom.b3.test.tsx                                  MODIFY — extend state-module mock (Task 5)
    features/editor/
      EditorTab.tsx                                           MODIFY — selectors (Task 5)
      EditorTab.render-count.test.tsx                         CREATE — real-provider isolation probe (Task 5)
    app/
      state.reducer.ts                                        MODIFY — SWARM_MESSAGES_CAP in APPEND_SWARM_MESSAGE (Task 4)
      state.reducer.swarm-cap.test.ts                         CREATE — cap behavior (Task 4)
    components/
      RufloReadinessPill.tsx                                  MODIFY — one-line selector swap (Task 6)
      RufloReadinessPill.render-count.test.tsx                CREATE — isolation probe (Task 6)
    features/onboarding/
      OnboardingModal.tsx                                     MODIFY — selector swap (Task 7)
      FeatureSpotlightModal.tsx                               MODIFY — selector swap (Task 7)
      use-whats-new.ts                                        MODIFY — selector swap (Task 7)
      FeatureSpotlightModal.test.tsx                          MODIFY — extend state-module mock (Task 7)
      use-whats-new.test.tsx                                  MODIFY — extend state-module mock (Task 7)
```

All commands below run from `/Users/aisigma/projects/SigmaLink/app` (or the isolated worktree's `app/`). Do not push; commits land locally per task.

### The shared render-count probe pattern (used by Tasks 2, 3, 5, 6)

The shipped PERF-3 tests (`src/renderer/app/App.room-selectors.test.tsx`) prove selector isolation with probe components + `appStateStore.setState`. That works for selector mechanics but cannot detect a component's own broad context subscription. These tasks therefore probe the REAL component inside the REAL `AppStateProvider` and count renders via a module the component calls **exactly once per render** (a wrapped `cn()` or a mocked per-render hook), driving unrelated state changes through a real `dispatch` (context value changes on dispatch; `appStateStore.setState` alone does NOT re-render context consumers). Each test file resets `appStateStore.setState(initialAppState)` in `afterEach` so tests don't bleed.

---

### Task 1: GitActivityStrip — inline SVG, drop recharts, precise vendor-react matcher

**Files:**
- Modify: `src/renderer/features/command-room/GitActivityStrip.tsx` (whole file, 91 lines)
- Modify: `src/renderer/features/command-room/GitActivityStrip.test.tsx`
- Modify: `vite.config.ts:29-41` (manualChunks)
- Modify: `package.json` (remove `"recharts": "^2.15.4"` from dependencies, line 68)
- Test: `src/renderer/features/command-room/GitActivityStrip.test.tsx`

Sole consumer of the strip: `src/renderer/features/command-room/PaneGearPopover.tsx:13,123` — **unchanged by this task** (props identical), so no overlap with the terminal-cache plan's command-room work.

- [ ] **Step 1: Write the failing test**

In `GitActivityStrip.test.tsx`, ADD this test inside the existing `describe('GitActivityStrip', …)` block (after the `'passes the worktree path through to the poll hook'` test):

```tsx
  it('renders one inline-SVG bar per active day, scaled by churn (no recharts)', () => {
    pollMock.mockReturnValue([
      bucket({ date: '2026-05-01', commitCount: 2, churn: 20 }),
      bucket({ date: '2026-05-02', commitCount: 1, churn: 5 }),
    ]);
    render(<GitActivityStrip worktreePath="/wt" />);
    const bars = screen.getAllByTestId('git-activity-bar');
    expect(bars).toHaveLength(2);
    const h0 = Number(bars[0].getAttribute('height'));
    const h1 = Number(bars[1].getAttribute('height'));
    expect(h0).toBeGreaterThan(h1);      // churn-20 day taller than churn-5 day
    expect(h1).toBeGreaterThanOrEqual(1); // floor: faint tick for calm days
    expect(bars[0].tagName.toLowerCase()).toBe('rect');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/GitActivityStrip.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="git-activity-bar"]` (recharts' ResponsiveContainer measures 0×0 in jsdom and paints no bars). The 5 existing tests still pass.

- [ ] **Step 3: Replace the component with inline SVG**

Replace the ENTIRE contents of `src/renderer/features/command-room/GitActivityStrip.tsx` with:

```tsx
// P6 FEAT-8 — per-worktree git-activity sparkline.
//
// A compact (~16px tall) churn bar-strip for a pane header. Self-contained: it
// owns the shared 60 s activity poll for its worktree path and renders one bar
// per active day (oldest→newest), bar height ∝ that day's churn, bar tint
// ∝ relative heat (calm → hot). When there is no worktree or no recent
// activity it renders nothing — the lead mounts it unconditionally in
// PaneHeader and lets it self-suppress.
//
// Perf audit 2026-06-10 #1 — rendered with inline SVG. This used to be a
// recharts <BarChart>; recharts (+ d3-* / react-smooth / react-transition-group
// / victory-vendor) was ~450 kB of EAGER vendor JS for a 48×16 px strip with
// no axes, tooltip, or animation. recharts' only consumer was this file, so
// the dependency was removed outright.

import { useMemo } from 'react';
import { useGitActivityPoll } from '@/renderer/lib/use-git-activity-poll';
import type { GitActivityBucket } from '@/shared/types';

interface GitActivityStripProps {
  worktreePath: string | null;
}

/** Map a 0..1 heat ratio to a CSS color. Calm = muted, hot = accent. We blend
 *  via HSL alpha on the accent token so it reads on both light/dark glass. */
function heatColor(ratio: number): string {
  // Clamp + floor the alpha so even the calmest active day is visible.
  const a = 0.35 + Math.min(1, Math.max(0, ratio)) * 0.65;
  return `hsl(var(--accent) / ${a.toFixed(2)})`;
}

interface Row {
  date: string;
  churn: number;
  fill: string;
}

function toRows(buckets: GitActivityBucket[]): { rows: Row[]; maxChurn: number } {
  const maxChurn = buckets.reduce((m, b) => Math.max(m, b.churn), 0);
  const rows = buckets.map((b) => ({
    date: b.date,
    // Floor the rendered value so a 0-churn-but-active day (commit with no
    // numstat, e.g. a rename) still draws a faint tick.
    churn: Math.max(b.churn, 1),
    fill: heatColor(maxChurn > 0 ? b.churn / maxChurn : 0),
  }));
  return { rows, maxChurn };
}

// SVG geometry in viewBox units; the svg stretches (preserveAspectRatio=none)
// to fill the 48×16 px box, mirroring recharts' barCategoryGap={1} look.
const BAR_W = 3;
const BAR_GAP = 1;
const STRIP_H = 16;

export function GitActivityStrip({ worktreePath }: GitActivityStripProps) {
  const buckets = useGitActivityPoll(worktreePath);

  const { rows, totals, maxChurn } = useMemo(() => {
    const { rows, maxChurn } = toRows(buckets);
    const totals = buckets.reduce(
      (acc, b) => {
        acc.commits += b.commitCount;
        acc.churn += b.churn;
        acc.added += b.linesAdded;
        acc.deleted += b.linesDeleted;
        return acc;
      },
      { commits: 0, churn: 0, added: 0, deleted: 0 },
    );
    return { rows, totals, maxChurn };
  }, [buckets]);

  // No worktree, no data yet, or no recent activity → render nothing. The strip
  // is mounted unconditionally; it self-suppresses so the header stays clean.
  if (!worktreePath || rows.length === 0) return null;

  const label =
    `Git activity, last ${rows.length} active ${rows.length === 1 ? 'day' : 'days'}: ` +
    `${totals.commits} ${totals.commits === 1 ? 'commit' : 'commits'}, ` +
    `${totals.churn} lines changed (+${totals.added} / -${totals.deleted}).`;

  const viewW = rows.length * (BAR_W + BAR_GAP) - BAR_GAP;

  return (
    <div
      className="h-4 w-12 shrink-0"
      role="img"
      aria-label={label}
      title={label}
      data-testid="git-activity-strip"
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${viewW} ${STRIP_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {rows.map((r, i) => {
          // Height ∝ churn relative to the hottest day, floored at 1 unit so a
          // calm-but-active day still draws a faint tick (same floor recharts
          // got via the churn:1 clamp in toRows).
          const h = Math.max(1, Math.round((r.churn / Math.max(maxChurn, 1)) * (STRIP_H - 1)));
          return (
            <rect
              key={r.date}
              data-testid="git-activity-bar"
              x={i * (BAR_W + BAR_GAP)}
              y={STRIP_H - h}
              width={BAR_W}
              height={h}
              rx={0.5}
              fill={r.fill}
            />
          );
        })}
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: Clean the test file's recharts scaffolding**

In `GitActivityStrip.test.tsx`:
1. DELETE the `beforeAll` ResizeObserver stub block (lines 28-38, the one commented `recharts' ResponsiveContainer instantiates a ResizeObserver…`) and remove `beforeAll` from the vitest import.
2. Replace the header-comment lines 12-14 (`// recharts' ResponsiveContainer measures its parent; …`) with:

```tsx
// The strip renders inline SVG (perf audit 2026-06-10 #1 — recharts removed),
// so jsdom can assert the bars directly in addition to the a11y label.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/features/command-room/GitActivityStrip.test.tsx`
Expected: PASS — all 6 tests (5 existing + the new bar assertion).

- [ ] **Step 6: Fix the vendor-react chunk matcher**

In `vite.config.ts`, replace line 39:

```ts
            if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
```

with:

```ts
            // Perf audit 2026-06-10 #1 — match ONLY the React core packages
            // by exact path segment. The old `id.includes('react')` substring
            // matched ANY package with "react" in its name (react-smooth,
            // react-transition-group — recharts deps; react-remove-scroll, …),
            // dragging recharts' whole d3 subtree into this EAGER chunk
            // (~450 kB excess parse/compile every boot).
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
              return 'vendor-react';
            }
```

- [ ] **Step 7: Remove the recharts dependency**

Run: `npm uninstall recharts`
Then verify it is fully gone from source:

Run: `grep -rn "recharts" src/ package.json`
Expected: no output (exit code 1).

- [ ] **Step 8: Build and record the before/after chunk sizes**

Run: `npx vite build 2>&1 | tail -30`

Record the new chunk list next to the baseline above. Acceptance:
- `vendor-react-*.js` < 250 kB pre-gzip (expected ≈180–200 kB: react 19 + react-dom + scheduler only; baseline was **636.08 kB / gzip 187.45 kB**).
- No chunk named or containing recharts/d3 appears in the output.
- App still boots: covered by `npm run product:check` in the gate (NO local e2e — CI e2e-matrix owns runtime verification).

Paste the actual before/after numbers into the commit body.

- [ ] **Step 9: Run the full command-room test directory (sibling consumers)**

Run: `npx vitest run src/renderer/features/command-room`
Expected: PASS (PaneGearPopover/CommandRoom tests unaffected — the strip's props and testids are unchanged).

- [ ] **Step 10: Commit**

```bash
git add src/renderer/features/command-room/GitActivityStrip.tsx \
        src/renderer/features/command-room/GitActivityStrip.test.tsx \
        vite.config.ts package.json
git commit -m "perf(renderer): inline-SVG git sparkline + precise vendor-react matcher — drop recharts (~450KB eager JS)

vendor-react before: 636.08 kB (gzip 187.45) → after: <paste actual>
recharts' sole consumer was the 48x16px GitActivityStrip; replaced with
~30 lines of SVG. id.includes('react') substring matcher fixed to exact
react/react-dom/scheduler path match.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: MailboxBubble — narrow selector + memo (stop N-bubble re-render per dispatch)

**Files:**
- Modify: `src/renderer/features/swarm-room/MailboxBubble.tsx:1-5` (imports), `:85-98` (component head), `:134-136` (TaskBriefBody call)
- Create: `src/renderer/features/swarm-room/MailboxBubble.render-count.test.tsx`
- Test: `src/renderer/features/swarm-room/MailboxBubble.render-count.test.tsx`

Every message row in `SideChat` (and `operator-console/ActivityFeed`) calls broad `useAppState()` at `:86` just to read `state.activeWorkspace?.id` at `:135`. Every global dispatch (pty focus, notifications, room switches) re-renders ALL N bubbles, including task-brief payload parsing hosts.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/features/swarm-room/MailboxBubble.render-count.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// Perf audit 2026-06-10 #2 — MailboxBubble render isolation.
// Every message row used to call the broad useAppState() (context read →
// re-renders on EVERY global dispatch) just to read activeWorkspace?.id.
// Probe: MailboxBubble calls cn() several times per render; a wrapped cn
// counts renders without prod instrumentation. Asserts:
//   1. an unrelated dispatch does NOT re-render a mounted bubble
//   2. a parent re-render with the SAME message prop is memo-skipped
//   3. control: a DIFFERENT message prop DOES re-render

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useState, type Dispatch } from 'react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: vi.fn().mockResolvedValue(null) },
    workspaces: { list: vi.fn().mockResolvedValue([]) },
    browser: { openTab: vi.fn().mockResolvedValue(undefined) },
  },
  onEvent: vi.fn(() => () => undefined),
}));

const cnSpy = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return {
    ...actual,
    cn: (...args: Parameters<typeof actual.cn>) => {
      cnSpy.count += 1;
      return actual.cn(...args);
    },
  };
});

import { AppStateProvider, useAppDispatch, type Action } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';
import { MailboxBubble } from './MailboxBubble';
import type { SwarmMessage } from '@/shared/types';

function msg(over: Partial<SwarmMessage> = {}): SwarmMessage {
  return {
    id: 'm-1',
    swarmId: 'sw-1',
    fromAgent: 'coordinator',
    toAgent: '*',
    kind: 'SAY',
    body: 'hello swarm',
    ts: 1_700_000_000_000,
    ...over,
  };
}

let dispatchRef: Dispatch<Action> | null = null;
function DispatchGrabber() {
  dispatchRef = useAppDispatch();
  return null;
}

beforeEach(() => {
  cnSpy.count = 0;
  vi.stubGlobal('sigma', {
    eventOn: vi.fn(() => () => undefined),
    eventSend: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  appStateStore.setState(initialAppState);
});

describe('MailboxBubble render isolation (perf audit #2)', () => {
  it('does NOT re-render on an unrelated global dispatch', () => {
    render(
      <AppStateProvider>
        <DispatchGrabber />
        <MailboxBubble message={msg()} />
      </AppStateProvider>,
    );
    const before = cnSpy.count;
    act(() => {
      dispatchRef!({ type: 'SET_ROOM', room: 'swarm' });
    });
    expect(cnSpy.count).toBe(before);
  });

  it('memo: a parent re-render with the same message prop does not re-render the bubble', () => {
    let bump: (() => void) | null = null;
    function Host({ message }: { message: SwarmMessage }) {
      const [, set] = useState(0);
      bump = () => set((n) => n + 1);
      return <MailboxBubble message={message} />;
    }
    const stable = msg();
    render(
      <AppStateProvider>
        <Host message={stable} />
      </AppStateProvider>,
    );
    const before = cnSpy.count;
    act(() => bump!());
    expect(cnSpy.count).toBe(before);
  });

  it('control: a different message prop DOES re-render the bubble', () => {
    const { rerender } = render(
      <AppStateProvider>
        <MailboxBubble message={msg()} />
      </AppStateProvider>,
    );
    const before = cnSpy.count;
    rerender(
      <AppStateProvider>
        <MailboxBubble message={msg({ id: 'm-2', body: 'changed' })} />
      </AppStateProvider>,
    );
    expect(cnSpy.count).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/features/swarm-room/MailboxBubble.render-count.test.tsx`
Expected: FAIL — tests 1 and 2 (`expected <n> to be <before>` with a larger count: the broad context read re-renders on dispatch; the unmemoized component re-renders with its parent). Test 3 passes.

- [ ] **Step 3: Implement — selector + memo**

In `src/renderer/features/swarm-room/MailboxBubble.tsx`:

Replace lines 1-4:

```tsx
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
```

with:

```tsx
import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import { useAppStateSelector } from '@/renderer/app/state';
```

Replace the component head (lines 85-87):

```tsx
export function MailboxBubble({ message }: Props) {
  const { state } = useAppState();
  const isOperator = message.fromAgent === 'operator';
```

with:

```tsx
// Perf audit 2026-06-10 #2 — memo + narrow selector. One bubble renders per
// message in SideChat/ActivityFeed; the old broad useAppState() context read
// re-rendered EVERY bubble (incl. task-brief payload hosts) on EVERY global
// dispatch, just to read activeWorkspace?.id.
export const MailboxBubble = memo(function MailboxBubble({ message }: Props) {
  const activeWorkspaceId = useAppStateSelector((s) => s.activeWorkspace?.id ?? null);
  const isOperator = message.fromAgent === 'operator';
```

Replace line 135:

```tsx
          <TaskBriefBody brief={taskBrief} workspaceId={state.activeWorkspace?.id ?? null} />
```

with:

```tsx
          <TaskBriefBody brief={taskBrief} workspaceId={activeWorkspaceId} />
```

Replace the component's closing line 142 `}` (the one ending `export function MailboxBubble`, immediately before `function TaskBriefBody`) with `});`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/features/swarm-room/MailboxBubble.render-count.test.tsx src/renderer/features/swarm-room/SideChat.test.tsx`
Expected: PASS (SideChat imports the same named export — `export const` keeps it intact).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/swarm-room/MailboxBubble.tsx \
        src/renderer/features/swarm-room/MailboxBubble.render-count.test.tsx
git commit -m "perf(renderer): MailboxBubble narrow selector + memo — stop re-rendering every swarm bubble per global dispatch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: ChatTranscript — memo(ChatRow) + memoized tool-row prettyPrint

**Files:**
- Modify: `src/renderer/features/jorvis-assistant/ChatTranscript.tsx:6` (import), `:173` (`function ChatRow`), `:282-288` (`ToolBody`)
- Create: `src/renderer/features/jorvis-assistant/ChatTranscript.render-count.test.tsx`
- Test: `src/renderer/features/jorvis-assistant/ChatTranscript.render-count.test.tsx` + existing `ChatTranscript.stream.test.tsx`

Anchors verified against HEAD `a4156ac` (file md5 `74846b82…`, working tree clean at planning time — **re-run the pre-flight check first**, this file had concurrent-session WIP earlier today).

**Prop-identity verification (done at planning time, claim-checked in code):** committed rows receive `message` objects whose identity is stable across stream deltas — `JorvisRoom` keeps `messages` in `useState` and appends via `[...rows, newRow]` (`use-jorvis-conversations.ts` setMessages callers + `JorvisRoom.tsx:164-172`); only full hydration replaces the objects (one re-render, correct). `isStreaming=false`, `isPending=false`, `streamingDelta=undefined`, `streamingTurnId=undefined`, `conversationId` stable → default shallow `memo` comparison skips committed rows; the sentinel row's `message` object and `streamingDelta` change per delta → it re-renders.

**MUST PRESERVE:** the in-flight sentinel row is keyed by the turn's **eventual committed messageId** (`ChatTranscript.tsx:80-97`, Phase-6 H1 anti-double-spring, PR #133-era). `memo()` wraps the component, not the JSX `key={m.id}` — keying is untouched, and on commit the row's props change (`isStreaming` flips, `message` swaps to the stored twin) so memo MUST NOT block that render. The control test below pins this, and `ChatTranscript.stream.test.tsx` must stay green.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/features/jorvis-assistant/ChatTranscript.render-count.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// Perf audit 2026-06-10 #3 — ChatTranscript row memoization.
// JorvisRoom re-renders the whole transcript on every stream delta; committed
// rows have stable props (same message object identity, isStreaming=false) so
// memo(ChatRow) must skip them. Probe: every ChatRow render calls
// useJorvisStreamReveal exactly once — mock it with a counter.
// Also: historical tool rows must not re-run JSON.parse(content) per delta.
// MUST-PRESERVE pin: the sentinel→committed key handoff (Phase-6 H1
// anti-double-spring) still re-renders the transitioning row.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const revealMock = vi.hoisted(() =>
  vi.fn(() => ({ revealed: '', caret: false })),
);
vi.mock('./use-jorvis-stream-reveal', () => ({
  useJorvisStreamReveal: revealMock,
}));
// InlineToolChips subscribes to live events; not under test.
vi.mock('./InlineToolChips', () => ({
  InlineToolChips: () => null,
}));

import { ChatTranscript, type ChatMessageView } from './ChatTranscript';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const committed: ChatMessageView[] = [
  { id: 'm1', role: 'user', content: 'hi', createdAt: 1000 },
  { id: 'm2', role: 'assistant', content: 'hello', createdAt: 2000 },
  { id: 'm3', role: 'tool', content: '{"tool":"ok","n":1}', toolCallId: 'tc1', createdAt: 3000 },
];

describe('ChatTranscript memo(ChatRow) (perf audit #3)', () => {
  it('a stream delta re-renders ONLY the in-flight sentinel row', () => {
    const { rerender } = render(
      <ChatTranscript
        messages={committed}
        streaming={{ turnId: 't1', delta: 'a', messageId: 'm-new' }}
        conversationId="c1"
      />,
    );
    // Mount: 3 committed rows + 1 sentinel = 4 hook calls.
    expect(revealMock.mock.calls.length).toBe(4);

    // New delta, SAME messages array identity (mirrors JorvisRoom: only the
    // streaming object changes between deltas).
    rerender(
      <ChatTranscript
        messages={committed}
        streaming={{ turnId: 't1', delta: 'ab', messageId: 'm-new' }}
        conversationId="c1"
      />,
    );
    // Only the sentinel re-renders → exactly +1.
    expect(revealMock.mock.calls.length).toBe(5);
  });

  it('does not re-run JSON.parse on a historical tool row per stream delta', () => {
    const toolContent = '{"tool":"ok","n":1}';
    const parseSpy = vi.spyOn(JSON, 'parse');
    const callsForTool = () =>
      parseSpy.mock.calls.filter((c) => c[0] === toolContent).length;

    const { rerender } = render(
      <ChatTranscript
        messages={committed}
        streaming={{ turnId: 't1', delta: 'a', messageId: 'm-new' }}
        conversationId="c1"
      />,
    );
    expect(callsForTool()).toBe(1); // parsed once on mount

    rerender(
      <ChatTranscript
        messages={committed}
        streaming={{ turnId: 't1', delta: 'ab', messageId: 'm-new' }}
        conversationId="c1"
      />,
    );
    expect(callsForTool()).toBe(1); // NOT re-parsed on the delta re-render
    parseSpy.mockRestore();
  });

  it('control: the sentinel→committed transition still re-renders the row (key handoff preserved)', () => {
    const { rerender } = render(
      <ChatTranscript
        messages={committed}
        streaming={{ turnId: 't1', delta: 'done', messageId: 'm-new' }}
        conversationId="c1"
      />,
    );
    const before = revealMock.mock.calls.length;
    // Turn commits: the standby handler appends the committed twin with the
    // SAME id the sentinel row was keyed by (Phase-6 H1 anti-double-spring).
    rerender(
      <ChatTranscript
        messages={[
          ...committed,
          { id: 'm-new', role: 'assistant', content: 'done', createdAt: 4000 },
        ]}
        streaming={null}
        conversationId="c1"
      />,
    );
    // The m-new row's props changed (isStreaming flips, message swaps) —
    // memo must NOT block this render.
    expect(revealMock.mock.calls.length).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/features/jorvis-assistant/ChatTranscript.render-count.test.tsx`
Expected: FAIL — test 1 (`expected 8 to be 5`: all 4 rows re-render) and test 2 (`expected 2 to be 1`: tool row re-parses). Test 3 passes.

- [ ] **Step 3: Implement — memo + useMemo**

In `src/renderer/features/jorvis-assistant/ChatTranscript.tsx`:

Replace line 6:

```tsx
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
```

with:

```tsx
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
```

Replace line 173:

```tsx
function ChatRow({ message, isStreaming, isPending, streamingDelta, conversationId, streamingTurnId }: ChatRowProps) {
```

with:

```tsx
// Perf audit 2026-06-10 #3 — memo'd: committed rows keep stable props across
// stream deltas (stable message object identity; isStreaming=false), so only
// the in-flight sentinel re-renders per delta. The sentinel's key handoff to
// its committed twin (Phase-6 H1 anti-double-spring) lives in the PARENT's
// key={m.id} and is untouched by memoization.
const ChatRow = memo(function ChatRow({ message, isStreaming, isPending, streamingDelta, conversationId, streamingTurnId }: ChatRowProps) {
```

and replace the function's closing `}` (the line immediately before the `TypingDots` JSDoc block, currently line ~253) with `});`.

Replace `ToolBody` (lines 282-288):

```tsx
function ToolBody({ content }: { content: string }) {
  // Compute outside JSX so the lint rule (no JSX in try/catch) never fires.
  const pretty = prettyPrint(content);
  return pretty === null
    ? <span>{content}</span>
    : <pre className="m-0 whitespace-pre-wrap break-words">{pretty}</pre>;
}
```

with:

```tsx
function ToolBody({ content }: { content: string }) {
  // Compute outside JSX so the lint rule (no JSX in try/catch) never fires.
  // Perf audit #3 — memoized: historical tool rows re-ran JSON.parse +
  // stringify on every transcript render; content is stable for committed rows.
  const pretty = useMemo(() => prettyPrint(content), [content]);
  return pretty === null
    ? <span>{content}</span>
    : <pre className="m-0 whitespace-pre-wrap break-words">{pretty}</pre>;
}
```

- [ ] **Step 4: Run new + existing transcript tests**

Run: `npx vitest run src/renderer/features/jorvis-assistant/ChatTranscript.render-count.test.tsx src/renderer/features/jorvis-assistant/ChatTranscript.stream.test.tsx`
Expected: PASS — including every stream/typing-dots test (the `pending` prop contract from PR #135 and the sentinel keying are behaviorally unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/jorvis-assistant/ChatTranscript.tsx \
        src/renderer/features/jorvis-assistant/ChatTranscript.render-count.test.tsx
git commit -m "perf(renderer): memo ChatTranscript rows + memoize tool-row prettyPrint — stream deltas re-render only the sentinel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Cap swarmMessages growth in APPEND_SWARM_MESSAGE

**Files:**
- Modify: `src/renderer/app/state.reducer.ts:528-538` (`APPEND_SWARM_MESSAGE` case) + a module-top const
- Create: `src/renderer/app/state.reducer.swarm-cap.test.ts`
- Test: `src/renderer/app/state.reducer.swarm-cap.test.ts`

**Finding 4 — partially REFUTED:** "memoize runGroups derivation" is ALREADY implemented — `SideChat.tsx:290-315` chains `filteredMessages` → `unpinnedMessages` → `runGroups` through `useMemo`, so unrelated renders don't rebuild groups; an append necessarily changes the input array, making the O(n) rebuild inherent. The actionable remainder is bounding n: hydrate tails 200 (`SwarmRoom.tsx:56`, `SwarmRailTab.tsx` mirror), then live appends grow forever with dedupe but no cap. **No SideChat change ships.** Windowed rendering = deferred (YAGNI per the audit).

Note: `state.reducer.ts` is 794 lines (pre-existing, over the 500-line guideline) — this task adds ~10 lines; splitting the reducer is explicitly out of scope.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/state.reducer.swarm-cap.test.ts`:

```ts
// Perf audit 2026-06-10 #4 — APPEND_SWARM_MESSAGE growth cap.
// Hydrate tails 200 messages (SwarmRoom/SwarmRailTab `rpc.swarms.tail`); live
// appends then grew the per-swarm array unbounded (dedupe, no cap). The
// reducer caps each thread at 500 by dropping the oldest, bounding bubble row
// count and SideChat's (already-memoized) runGroups rebuild on long swarms.
//
// Pure reducer — no React, no DOM, no DB. Safe under vitest.

import { describe, expect, it } from 'vitest';
import { appStateReducer } from './state.reducer';
import { initialAppState } from './state.types';
import type { SwarmMessage } from '../../shared/types';

function swarmMsg(id: string, ts: number): SwarmMessage {
  return {
    id,
    swarmId: 'sw-1',
    fromAgent: 'coordinator',
    toAgent: '*',
    kind: 'SAY',
    body: `msg ${id}`,
    ts,
  };
}

function hydrated(count: number) {
  const messages = Array.from({ length: count }, (_, i) => swarmMsg(`m-${i}`, 1000 + i));
  return appStateReducer(initialAppState, {
    type: 'SET_SWARM_MESSAGES',
    swarmId: 'sw-1',
    messages,
  });
}

describe('APPEND_SWARM_MESSAGE cap (perf audit #4)', () => {
  it('appends normally under the cap', () => {
    const s1 = hydrated(10);
    const s2 = appStateReducer(s1, {
      type: 'APPEND_SWARM_MESSAGE',
      message: swarmMsg('m-next', 2000),
    });
    expect(s2.swarmMessages['sw-1']).toHaveLength(11);
    expect(s2.swarmMessages['sw-1'].at(-1)!.id).toBe('m-next');
  });

  it('caps at 500 by dropping the head once full', () => {
    const s1 = hydrated(500);
    const s2 = appStateReducer(s1, {
      type: 'APPEND_SWARM_MESSAGE',
      message: swarmMsg('m-next', 2000),
    });
    const arr = s2.swarmMessages['sw-1'];
    expect(arr).toHaveLength(500);
    expect(arr[0].id).toBe('m-1'); // m-0 (oldest) dropped
    expect(arr.at(-1)!.id).toBe('m-next'); // newest kept at the tail
  });

  it('preserves dedupe-by-id (same state reference returned)', () => {
    const s1 = hydrated(3);
    const s2 = appStateReducer(s1, {
      type: 'APPEND_SWARM_MESSAGE',
      message: swarmMsg('m-1', 9999),
    });
    expect(s2).toBe(s1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/app/state.reducer.swarm-cap.test.ts`
Expected: FAIL — `'caps at 500…'` gets length 501. Tests 1 and 3 pass (existing behavior).

- [ ] **Step 3: Implement the cap**

In `src/renderer/app/state.reducer.ts`, add near the top of the file (after the imports, alongside any existing module consts):

```ts
// Perf audit 2026-06-10 #4 — per-swarm message thread cap. Hydrate tails 200
// (SwarmRoom / SwarmRailTab); live APPENDs previously grew the array without
// bound. 500 keeps the full hydrated tail plus a generous live window while
// bounding SideChat / MailboxBubble row counts on long-running swarms.
const SWARM_MESSAGES_CAP = 500;
```

Replace the `APPEND_SWARM_MESSAGE` case (lines 528-538):

```ts
    case 'APPEND_SWARM_MESSAGE': {
      const existing = state.swarmMessages[action.message.swarmId] ?? [];
      // Avoid duplicates if the renderer received the message twice (event +
      // tail refresh). Identity by `id`.
      if (existing.some((m) => m.id === action.message.id)) return state;
      const next = [...existing, action.message];
      return {
        ...state,
        swarmMessages: { ...state.swarmMessages, [action.message.swarmId]: next },
      };
    }
```

with:

```ts
    case 'APPEND_SWARM_MESSAGE': {
      const existing = state.swarmMessages[action.message.swarmId] ?? [];
      // Avoid duplicates if the renderer received the message twice (event +
      // tail refresh). Identity by `id`.
      if (existing.some((m) => m.id === action.message.id)) return state;
      const appended = [...existing, action.message];
      // Cap the thread, dropping the oldest, so it can't grow unbounded.
      const next =
        appended.length > SWARM_MESSAGES_CAP
          ? appended.slice(appended.length - SWARM_MESSAGES_CAP)
          : appended;
      return {
        ...state,
        swarmMessages: { ...state.swarmMessages, [action.message.swarmId]: next },
      };
    }
```

- [ ] **Step 4: Run the reducer suites to verify pass + no regression**

Run: `npx vitest run src/renderer/app/state.reducer.swarm-cap.test.ts src/renderer/app/state.reducer.test.ts src/renderer/app/state.reducer.memory-graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/state.reducer.ts src/renderer/app/state.reducer.swarm-cap.test.ts
git commit -m "perf(renderer): cap per-swarm message thread at 500 in APPEND_SWARM_MESSAGE (drop head)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Selectorize JorvisRoom (+ its use-jorvis-conversations SIBLING) and EditorTab

**Files:**
- Modify: `src/renderer/features/jorvis-assistant/JorvisRoom.tsx:15` (import), `:59-61`, `:118-122`
- Modify: `src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts:2,62-64` — **mandatory sibling**
- Modify: `src/renderer/features/editor/EditorTab.tsx:30` (import), `:87-88`, `:110`, `:136-153`
- Modify: `src/renderer/features/jorvis-assistant/JorvisRoom.test.tsx:24-32` (state-module mock)
- Modify: `src/renderer/features/jorvis-assistant/JorvisRoom.b3.test.tsx:49-54` (state-module mock)
- Create: `src/renderer/features/jorvis-assistant/JorvisRoom.render-count.test.tsx`
- Create: `src/renderer/features/editor/EditorTab.render-count.test.tsx`
- Test: both new files + existing `JorvisRoom.test.tsx`, `JorvisRoom.b3.test.tsx`, `EditorTab.test.tsx`

**SIBLING ALERT (grep-the-siblings):** `JorvisRoom` calls `useJorvisConversations()`, and that hook ALSO does a broad `useAppState()` at `use-jorvis-conversations.ts:63`. A hook's context subscription re-renders its HOST — converting JorvisRoom alone is a **silent no-op**. Both convert in this task, and the render-count test (real provider, real hook) would catch the miss.

Reads verified at HEAD: `JorvisRoom` uses only `state.activeWorkspace` (`:60`) and `state.workspaces` (`:119`) + `dispatch`. `use-jorvis-conversations` uses only `state.activeWorkspace?.id` (`:64`). `EditorTab` uses only `state.activeWorkspace` (`:110`), `state.sessions` (`:138,146`), `state.activeSessionId` (`:150-153`) — no dispatch.

- [ ] **Step 1: Write the failing JorvisRoom test**

Create `src/renderer/features/jorvis-assistant/JorvisRoom.render-count.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// Perf audit 2026-06-10 #5 — JorvisRoom render isolation. Uses the REAL
// AppStateProvider (the sibling JorvisRoom.test.tsx mocks the state module,
// so it cannot catch a broad-subscription regression). The broad
// useAppState() reads — in the room AND in useJorvisConversations — used to
// re-render the whole transcript subtree on every global dispatch.
// Probe: JorvisRoom calls useJorvisPaneEvents exactly once per render.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Dispatch } from 'react';

const paneEventsMock = vi.hoisted(() => vi.fn(() => []));
vi.mock('./use-jorvis-pane-events', () => ({
  useJorvisPaneEvents: paneEventsMock,
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    workspaces: { list: vi.fn().mockResolvedValue([]) },
    assistant: { send: vi.fn() },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null) },
    ruflo: {
      health: vi.fn().mockResolvedValue({ state: 'absent' }),
      'patterns.search': vi.fn().mockResolvedValue({ ok: true, results: [] }),
      'patterns.store': vi.fn().mockResolvedValue({ ok: true }),
    },
  },
  onEvent: vi.fn(() => () => undefined),
}));

vi.mock('@/renderer/lib/voice', () => ({
  isVoiceSupported: () => false,
  startCapture: vi.fn(),
  VoiceBusyError: class VoiceBusyError extends Error {},
}));
vi.mock('@/renderer/lib/notifications', () => ({ playDing: vi.fn() }));
vi.mock('@/renderer/lib/canDo', () => ({ useCanDo: () => false }));

import { AppStateProvider, useAppDispatch, type Action } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';
import { JorvisRoom } from './JorvisRoom';
import type { Workspace } from '@/shared/types';

const workspace: Workspace = {
  id: 'ws-1',
  name: 'SigmaLink',
  rootPath: '/tmp/sigmalink',
  repoRoot: '/tmp/sigmalink',
  repoMode: 'git',
  createdAt: 1,
  lastOpenedAt: 1,
};

let dispatchRef: Dispatch<Action> | null = null;
function DispatchGrabber() {
  dispatchRef = useAppDispatch();
  return null;
}

beforeEach(() => {
  vi.stubGlobal('sigma', {
    eventOn: vi.fn(() => () => undefined),
    eventSend: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  appStateStore.setState(initialAppState);
});

describe('JorvisRoom render isolation (perf audit #5)', () => {
  it('does NOT re-render on an unrelated global dispatch', async () => {
    render(
      <AppStateProvider>
        <DispatchGrabber />
        <JorvisRoom />
      </AppStateProvider>,
    );
    // Activate a workspace so the full (non-empty) branch renders, then let
    // the conversation-hydration microtasks settle.
    await act(async () => {
      dispatchRef!({ type: 'WORKSPACE_OPEN', workspace });
    });
    await act(async () => {});
    const before = paneEventsMock.mock.calls.length;
    await act(async () => {
      dispatchRef!({ type: 'SET_ROOM', room: 'swarm' });
    });
    // `room` is not part of JorvisRoom's (or useJorvisConversations')
    // subscription → no re-render.
    expect(paneEventsMock.mock.calls.length).toBe(before);
  });

  it('control: DOES re-render when the active workspace changes', async () => {
    render(
      <AppStateProvider>
        <DispatchGrabber />
        <JorvisRoom />
      </AppStateProvider>,
    );
    await act(async () => {
      dispatchRef!({ type: 'WORKSPACE_OPEN', workspace });
    });
    await act(async () => {});
    const before = paneEventsMock.mock.calls.length;
    await act(async () => {
      dispatchRef!({
        type: 'WORKSPACE_OPEN',
        workspace: { ...workspace, id: 'ws-2', name: 'Other' },
      });
    });
    expect(paneEventsMock.mock.calls.length).toBeGreaterThan(before);
  });
});
```

(If mount throws on an rpc method this mock doesn't cover, extend the `rpc`/`rpcSilent` mock with a `vi.fn()` for that method — the base set above mirrors the proven `JorvisRoom.test.tsx` + `App.room-selectors.test.tsx` mocks.)

- [ ] **Step 2: Write the failing EditorTab test**

Create `src/renderer/features/editor/EditorTab.render-count.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// Perf audit 2026-06-10 #5 — EditorTab render isolation. Real provider; the
// sibling EditorTab.test.tsx mocks the state module so it cannot catch a
// broad-subscription regression. The broad useAppState() read re-rendered
// the whole Monaco host tree on every global dispatch.
// Probe: EditorTab calls useEditor exactly once per render.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Dispatch } from 'react';

const useEditorMock = vi.hoisted(() =>
  vi.fn(() => ({
    file: null,
    buffer: '',
    setBuffer: vi.fn(),
    dirty: false,
    loading: false,
    error: null,
    open: vi.fn(),
    save: vi.fn(),
  })),
);
vi.mock('./useEditor', () => ({
  useEditor: useEditorMock,
  EDITOR_FOCUS_EVENT: 'editor:focus',
}));
vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco" />,
}));
vi.mock('./FileTree', () => ({
  FileTree: ({ rootPath }: { rootPath: string }) => (
    <div data-testid="file-tree" data-root={rootPath} />
  ),
}));
vi.mock('@/renderer/app/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    workspaces: { list: vi.fn().mockResolvedValue([]) },
  },
  rpcSilent: { kv: { get: vi.fn().mockResolvedValue(null) } },
  onEvent: vi.fn(() => () => undefined),
}));

import { AppStateProvider, useAppDispatch, type Action } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';
import { EditorTab } from './EditorTab';
import type { Workspace } from '@/shared/types';

const workspace: Workspace = {
  id: 'ws-1',
  name: 'Test WS',
  rootPath: '/tmp/ws',
  repoRoot: '/tmp/ws',
  repoMode: 'git',
  createdAt: 0,
  lastOpenedAt: 0,
};

let dispatchRef: Dispatch<Action> | null = null;
function DispatchGrabber() {
  dispatchRef = useAppDispatch();
  return null;
}

beforeEach(() => {
  vi.stubGlobal('sigma', {
    eventOn: vi.fn(() => () => undefined),
    eventSend: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  appStateStore.setState(initialAppState);
});

describe('EditorTab render isolation (perf audit #5)', () => {
  it('does NOT re-render the Monaco host tree on an unrelated global dispatch', async () => {
    render(
      <AppStateProvider>
        <DispatchGrabber />
        <EditorTab />
      </AppStateProvider>,
    );
    await act(async () => {
      dispatchRef!({ type: 'WORKSPACE_OPEN', workspace });
    });
    await act(async () => {}); // flush kv-hydration microtasks
    const before = useEditorMock.mock.calls.length;
    await act(async () => {
      dispatchRef!({ type: 'SET_ROOM', room: 'swarm' });
    });
    expect(useEditorMock.mock.calls.length).toBe(before);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run src/renderer/features/jorvis-assistant/JorvisRoom.render-count.test.tsx src/renderer/features/editor/EditorTab.render-count.test.tsx`
Expected: FAIL on the isolation assertions (probe counts increase after the unrelated `SET_ROOM` dispatch). The JorvisRoom control test passes.

- [ ] **Step 4: Convert JorvisRoom**

In `src/renderer/features/jorvis-assistant/JorvisRoom.tsx`:

Replace line 15:

```tsx
import { useAppState } from '@/renderer/app/state';
```

with:

```tsx
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
```

Replace lines 59-61:

```tsx
  const { state, dispatch } = useAppState();
  const activeWorkspace = state.activeWorkspace;
  const wsId = activeWorkspace?.id;
```

with:

```tsx
  // Perf audit 2026-06-10 #5 — narrow selectors (PERF-3 continuation). The
  // broad useAppState() context read re-rendered the whole transcript subtree
  // on every global dispatch.
  const dispatch = useAppDispatch();
  const activeWorkspace = useAppStateSelector((s) => s.activeWorkspace);
  const workspaces = useAppStateSelector((s) => s.workspaces);
  const wsId = activeWorkspace?.id;
```

Replace lines 118-122:

```tsx
  useJorvisDispatchEcho({
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspace?.id,
    dispatch,
  });
```

with:

```tsx
  useJorvisDispatchEcho({
    workspaces,
    activeWorkspaceId: wsId,
    dispatch,
  });
```

- [ ] **Step 5: Convert the use-jorvis-conversations sibling**

In `src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts`:

Replace line 2:

```ts
import { useAppState } from '@/renderer/app/state';
```

with:

```ts
import { useAppStateSelector } from '@/renderer/app/state';
```

Replace lines 62-64:

```ts
export function useJorvisConversations(): UseJorvisConversationsReturn {
  const { state } = useAppState();
  const wsId = state.activeWorkspace?.id;
```

with:

```ts
export function useJorvisConversations(): UseJorvisConversationsReturn {
  // Perf audit #5 — narrow selector. This hook runs inside JorvisRoom; a
  // broad useAppState() here re-rendered the room per global dispatch even
  // after the room itself was selectorized (sibling of the JorvisRoom fix).
  const wsId = useAppStateSelector((s) => s.activeWorkspace?.id);
```

- [ ] **Step 6: Convert EditorTab**

In `src/renderer/features/editor/EditorTab.tsx`:

Replace line 30:

```tsx
import { useAppState } from '@/renderer/app/state';
```

with:

```tsx
import { useAppStateSelector } from '@/renderer/app/state';
```

Replace line 88:

```tsx
  const { state } = useAppState();
```

with:

```tsx
  // Perf audit 2026-06-10 #5 — narrow selectors; the broad context read
  // re-rendered the whole Monaco host tree on every global dispatch.
  const ws = useAppStateSelector((s) => s.activeWorkspace);
  const sessions = useAppStateSelector((s) => s.sessions);
  const activeSessionId = useAppStateSelector((s) => s.activeSessionId);
```

DELETE line 110 (now shadowed by the selector above):

```tsx
  const ws = state.activeWorkspace;
```

Replace the `paneWorktrees` memo (lines 136-146):

```tsx
  const paneWorktrees = useMemo(() => {
    if (!ws) return [];
    const sessions = state.sessions;
    return sessions
      .filter((s) => s.workspaceId === ws.id && s.worktreePath)
      // Deduplicate by worktreePath so multiple panes on the same branch show once.
      .reduce<typeof sessions>((acc, s) => {
        if (!acc.some((a) => a.worktreePath === s.worktreePath)) acc.push(s);
        return acc;
      }, []);
  }, [state.sessions, ws]);
```

with:

```tsx
  const paneWorktrees = useMemo(() => {
    if (!ws) return [];
    return sessions
      .filter((s) => s.workspaceId === ws.id && s.worktreePath)
      // Deduplicate by worktreePath so multiple panes on the same branch show once.
      .reduce<typeof sessions>((acc, s) => {
        if (!acc.some((a) => a.worktreePath === s.worktreePath)) acc.push(s);
        return acc;
      }, []);
  }, [sessions, ws]);
```

In the `activeSession` memo (lines 148-153), replace `state.activeSessionId` → `activeSessionId` and `state.sessions` → `sessions` (both in the body and the dependency array):

```tsx
  const activeSession = useMemo(
    () => (activeSessionId
      ? sessions.find((s) => s.id === activeSessionId) ?? null
      : null),
    [sessions, activeSessionId],
  );
```

Then search the rest of the file for any remaining `state.` reads (`grep -n 'state\.' src/renderer/features/editor/EditorTab.tsx`) — the only legitimate leftover is the class ErrorBoundary's `this.state.hasError` (~line 506). Fix any other stray.

- [ ] **Step 7: Extend the existing test mocks (they mock the state MODULE and will crash on the new imports)**

`src/renderer/features/jorvis-assistant/JorvisRoom.test.tsx` (lines 24-32) — replace:

```tsx
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: {
      activeWorkspace: workspace,
      workspaces: [workspace],
    },
    dispatch: mocks.dispatch,
  }),
}));
```

with:

```tsx
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: {
      activeWorkspace: workspace,
      workspaces: [workspace],
    },
    dispatch: mocks.dispatch,
  }),
  useAppDispatch: () => mocks.dispatch,
  useAppStateSelector: (sel: (s: unknown) => unknown) =>
    sel({ activeWorkspace: workspace, workspaces: [workspace] }),
}));
```

`src/renderer/features/jorvis-assistant/JorvisRoom.b3.test.tsx` (lines 49-54) — replace:

```tsx
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: { activeWorkspace: workspace, workspaces: [workspace] },
    dispatch: mocks.dispatch,
  }),
}));
```

with:

```tsx
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: { activeWorkspace: workspace, workspaces: [workspace] },
    dispatch: mocks.dispatch,
  }),
  useAppDispatch: () => mocks.dispatch,
  useAppStateSelector: (sel: (s: unknown) => unknown) =>
    sel({ activeWorkspace: workspace, workspaces: [workspace] }),
}));
```

`src/renderer/features/editor/EditorTab.test.tsx` already mocks all three hooks with the right state shape (lines 97-110) — no change needed.

- [ ] **Step 8: Run all affected suites to verify pass**

Run: `npx vitest run src/renderer/features/jorvis-assistant src/renderer/features/editor`
Expected: PASS — both new render-count tests plus every existing jorvis/editor test.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/features/jorvis-assistant/JorvisRoom.tsx \
        src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts \
        src/renderer/features/jorvis-assistant/JorvisRoom.test.tsx \
        src/renderer/features/jorvis-assistant/JorvisRoom.b3.test.tsx \
        src/renderer/features/jorvis-assistant/JorvisRoom.render-count.test.tsx \
        src/renderer/features/editor/EditorTab.tsx \
        src/renderer/features/editor/EditorTab.render-count.test.tsx
git commit -m "perf(renderer): selectorize JorvisRoom (+use-jorvis-conversations sibling) and EditorTab — stop per-dispatch subtree re-renders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: RufloReadinessPill — one-line selector swap (always-mounted breadcrumb)

**Files:**
- Modify: `src/renderer/components/RufloReadinessPill.tsx:5,30-32`
- Create: `src/renderer/components/RufloReadinessPill.render-count.test.tsx`
- Test: `src/renderer/components/RufloReadinessPill.render-count.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/components/RufloReadinessPill.render-count.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// Perf audit 2026-06-10 #6 — RufloReadinessPill render isolation. The pill is
// always-mounted in the breadcrumb; its broad useAppState() context read
// re-rendered it on every global dispatch just to read activeWorkspace.
// Probe: the pill calls cn() per render once a workspace is active.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Dispatch } from 'react';

const cnSpy = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return {
    ...actual,
    cn: (...args: Parameters<typeof actual.cn>) => {
      cnSpy.count += 1;
      return actual.cn(...args);
    },
  };
});

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: vi.fn().mockResolvedValue(null) },
    workspaces: { list: vi.fn().mockResolvedValue([]) },
  },
  onEvent: vi.fn(() => () => undefined),
  rpcSilent: {
    ruflo: {
      verifyForWorkspace: vi.fn().mockResolvedValue({
        claude: true,
        codex: true,
        gemini: true,
        kimi: false,
        opencode: false,
        detected: { kimi: false, opencode: false },
        mode: 'fast',
        errors: [],
      }),
    },
    skills: {
      verifyForWorkspace: vi.fn().mockResolvedValue({
        workspaceId: 'ws-1',
        verified: 1,
        refanned: 0,
        errors: [],
      }),
    },
  },
}));

import { AppStateProvider, useAppDispatch, type Action } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';
import { RufloReadinessPill } from './RufloReadinessPill';
import type { Workspace } from '@/shared/types';

const workspace: Workspace = {
  id: 'ws-1',
  name: 'SigmaLink',
  rootPath: '/tmp/ws',
  repoRoot: '/tmp/ws',
  repoMode: 'git',
  createdAt: 1,
  lastOpenedAt: 1,
};

let dispatchRef: Dispatch<Action> | null = null;
function DispatchGrabber() {
  dispatchRef = useAppDispatch();
  return null;
}

beforeEach(() => {
  cnSpy.count = 0;
  vi.stubGlobal('sigma', {
    eventOn: vi.fn(() => () => undefined),
    eventSend: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  appStateStore.setState(initialAppState);
});

describe('RufloReadinessPill render isolation (perf audit #6)', () => {
  it('does NOT re-render on an unrelated global dispatch', async () => {
    render(
      <AppStateProvider>
        <DispatchGrabber />
        <RufloReadinessPill />
      </AppStateProvider>,
    );
    // Activate a workspace and let the verify round-trips settle.
    await act(async () => {
      dispatchRef!({ type: 'WORKSPACE_OPEN', workspace });
    });
    await act(async () => {});
    const before = cnSpy.count;
    await act(async () => {
      dispatchRef!({ type: 'SET_ROOM', room: 'swarm' });
    });
    expect(cnSpy.count).toBe(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/components/RufloReadinessPill.render-count.test.tsx`
Expected: FAIL — cn count increases after the unrelated dispatch.

- [ ] **Step 3: Implement the swap**

In `src/renderer/components/RufloReadinessPill.tsx`:

Replace line 5:

```tsx
import { useAppState } from '@/renderer/app/state';
```

with:

```tsx
import { useAppStateSelector } from '@/renderer/app/state';
```

Replace lines 31-32:

```tsx
  const { state } = useAppState();
  const active = state.activeWorkspace;
```

with:

```tsx
  // Perf audit 2026-06-10 #6 — narrow selector; always-mounted breadcrumb.
  const active = useAppStateSelector((s) => s.activeWorkspace);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/components/RufloReadinessPill.render-count.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/RufloReadinessPill.tsx \
        src/renderer/components/RufloReadinessPill.render-count.test.tsx
git commit -m "perf(renderer): RufloReadinessPill narrow selector — always-mounted breadcrumb no longer re-renders per dispatch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: App-root onboarding trio — selector swaps (fold-in)

**Files:**
- Modify: `src/renderer/features/onboarding/OnboardingModal.tsx` (import, `:35-36`, `:116`)
- Modify: `src/renderer/features/onboarding/FeatureSpotlightModal.tsx` (import, `:81`, `:91`)
- Modify: `src/renderer/features/onboarding/use-whats-new.ts:15,28-29`
- Modify: `src/renderer/features/onboarding/FeatureSpotlightModal.test.tsx:19-22` (mock)
- Modify: `src/renderer/features/onboarding/use-whats-new.test.tsx:34-37` (mock)
- Test: existing `FeatureSpotlightModal.test.tsx` + `use-whats-new.test.tsx`

**Deliberate TDD deviation:** these are 1-line subscription swaps using the exact mechanism proven by render-count probes in Tasks 2/5/6; a third copy of the probe per file adds no information (audit said "fold in cheaply"). Existing behavior tests gate the swap; OnboardingModal has no test file and gets none (out of scope — behavior unchanged).

- [ ] **Step 1: OnboardingModal**

Find the `useAppState` import line and replace it with:

```tsx
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
```

Replace lines 35-36:

```tsx
  const { state, dispatch } = useAppState();
  const open = state.uiBoot && !state.onboarded;
```

with:

```tsx
  // Perf audit 2026-06-10 #7 — narrow selectors (mounted at the App root).
  const dispatch = useAppDispatch();
  const uiBoot = useAppStateSelector((s) => s.uiBoot);
  const onboarded = useAppStateSelector((s) => s.onboarded);
  const open = uiBoot && !onboarded;
```

Replace line 116:

```tsx
    <Dialog open={open} onOpenChange={(o) => (!o && state.onboarded ? undefined : undefined)}>
```

with:

```tsx
    <Dialog open={open} onOpenChange={(o) => (!o && onboarded ? undefined : undefined)}>
```

(`dispatch` is used at `:89,95,96` — unchanged.)

- [ ] **Step 2: FeatureSpotlightModal**

Find the `useAppState` import line and replace it with:

```tsx
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
```

Replace line 81:

```tsx
  const { state, dispatch } = useAppState();
```

with:

```tsx
  // Perf audit 2026-06-10 #7 — narrow selectors (mounted at the App root).
  const dispatch = useAppDispatch();
  const uiBoot = useAppStateSelector((s) => s.uiBoot);
  const onboarded = useAppStateSelector((s) => s.onboarded);
```

Replace line 91:

```tsx
  const open = state.uiBoot && state.onboarded && loaded && !seen;
```

with:

```tsx
  const open = uiBoot && onboarded && loaded && !seen;
```

(`dispatch` is used at `:100-110` — unchanged.)

- [ ] **Step 3: use-whats-new**

Replace line 15:

```ts
import { useAppState } from '@/renderer/app/state';
```

with:

```ts
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
```

Replace lines 28-29:

```ts
  const { state, dispatch } = useAppState();
  const { uiBoot, onboarded } = state;
```

with:

```ts
  // Perf audit 2026-06-10 #7 — narrow selectors (hook runs at the App root).
  const dispatch = useAppDispatch();
  const uiBoot = useAppStateSelector((s) => s.uiBoot);
  const onboarded = useAppStateSelector((s) => s.onboarded);
```

- [ ] **Step 4: Extend the two existing test mocks**

`src/renderer/features/onboarding/FeatureSpotlightModal.test.tsx` (lines 19-22) — replace:

```tsx
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({ state: mockState, dispatch }),
}));
```

with:

```tsx
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({ state: mockState, dispatch }),
  useAppDispatch: () => dispatch,
  useAppStateSelector: (sel: (s: typeof mockState) => unknown) => sel(mockState),
}));
```

`src/renderer/features/onboarding/use-whats-new.test.tsx` (lines 34-37) — apply the identical replacement (same mock shape, same `mockState`/`dispatch` hoisted names).

- [ ] **Step 5: Run the onboarding suites**

Run: `npx vitest run src/renderer/features/onboarding`
Expected: PASS — all existing ONB-1 behavior tests green against the selector-based implementations.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/features/onboarding/OnboardingModal.tsx \
        src/renderer/features/onboarding/FeatureSpotlightModal.tsx \
        src/renderer/features/onboarding/use-whats-new.ts \
        src/renderer/features/onboarding/FeatureSpotlightModal.test.tsx \
        src/renderer/features/onboarding/use-whats-new.test.tsx
git commit -m "perf(renderer): selectorize App-root onboarding trio (OnboardingModal, FeatureSpotlightModal, useWhatsNew)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Sibling sweep + full gate

**Files:** none modified (verification only; fix-forward if the sweep finds a converted file regressed).

- [ ] **Step 1: Grep the siblings — enumerate every remaining broad useAppState call site**

Run:

```bash
grep -rn "useAppState()" src/renderer --include="*.ts" --include="*.tsx" | grep -v ".test." | grep -v "state.hook.ts"
```

Expected output after Tasks 2-7 — EXACTLY these 9 sites, all deliberately deferred (each is a room-level mount rendered only while its room is active, or a modal step — not an always-hot mount):

```
features/settings/McpServersTab.tsx:52
features/settings/SettingsRoom.tsx:69
features/swarm-room/SwarmCreate.tsx:65
features/swarm-room/MissionStep.tsx:87
features/review/ReviewRoom.tsx:18
features/sigmabench-room/SigmaBenchRoom.tsx:62
features/skills/SkillsRoom.tsx:18
features/browser/BrowserRoom.tsx:81
features/jorvis-assistant/... — must NOT appear (Task 5 converted JorvisRoom + use-jorvis-conversations)
```

- If any of the 8 sites this plan converted (MailboxBubble, ChatTranscript has none, JorvisRoom, use-jorvis-conversations, EditorTab, RufloReadinessPill, OnboardingModal, FeatureSpotlightModal, use-whats-new) still appears → a step was missed; go back and fix.
- If NEW sites appeared since planning (concurrent sessions add code daily): list them in the commit/PR body; convert in-place only if the site is always-mounted and reads ≤2 fields, otherwise park in WISHLIST.

- [ ] **Step 2: Full local gate (NO local e2e — CI e2e-matrix owns it; never launch competing Electron windows on the operator's machine)**

```bash
npx tsc -b
npx eslint . --max-warnings 0
npx vitest run
npm run product:check
```

Expected: all green. Note: full-suite vitest under machine load can flake on the known-heavy files (swarms/factory, VoiceTab) — re-run the failing file in isolation before reacting.

- [ ] **Step 3: Re-gate in MAIN if executed in a worktree**

Worktree tsc is laxer than main's `tsc -b` (which checks test files). Bring the commits to the main checkout (or fresh branch off `origin/main`) and re-run the Step 2 gate there before opening a PR.

---

## Coordination notes

- **ChatTranscript WIP hazard (Task 3):** the conversation-start snapshot showed uncommitted ChatTranscript WIP on `feat/bsp-pane-tiling`; by planning time the shared tree had flipped to `main @ a4156ac` with the file clean (md5 `74846b82ee2fe7d2359aeb35395bfe96`). Another jorvis session may re-dirty it at any moment — run the Pre-flight check immediately before Task 3 and STOP if dirty.
- **Jorvis plan overlap:** a sibling plan touches JorvisRoom-adjacent hooks. This plan edits `JorvisRoom.tsx` + `use-jorvis-conversations.ts` (Task 5) and `ChatTranscript.tsx` (Task 3). Whoever lands second rebases; the `pending` typing-dots contract (PR #135) and the sentinel `messageId` keying (PR #133-era) are load-bearing — Task 3's control test and the existing `ChatTranscript.stream.test.tsx` pin both.
- **Terminal-cache plan owns command-room PaneShell:** Task 1 touches only `GitActivityStrip.tsx`(+test) inside command-room and leaves `PaneGearPopover.tsx` and PaneShell untouched (identical props/testids) — no expected conflict surface.
- **Renderer-state plan also touches `state.reducer.ts`:** Task 4's footprint is one module-top const + the `APPEND_SWARM_MESSAGE` case (lines 528-538). **Ordering:** land whichever plan is ready first; the second rebases — the conflict is mechanical. If the renderer-state plan restructures the reducer, re-locate the case by the `'APPEND_SWARM_MESSAGE'` literal.
- **Execution environment:** isolated worktree off `origin/main` (`feedback_concurrent_tree_stomp`), commits atomic per task, re-gate in MAIN, no push/PR without operator authorization. If dispatched to agents, pass `isolation: "worktree"` on the Agent call — prompt prose does not isolate.
- **Bundle numbers:** baseline recorded in this plan (vendor-react 636.08 kB / gzip 187.45 kB at `a4156ac`); paste post-change numbers into the Task 1 commit body so the win is auditable from history.

## Self-review (performed at planning time; issues fixed inline)

- **Spec coverage:** Finding 1 → Task 1 (both options evaluated, B recommended; matcher fixed; build-size verification with recorded baseline). Finding 2 → Task 2. Finding 3 → Task 3 (prop identity verified against committed state; sentinel keying pinned by a control test). Finding 4 → Task 4 (runGroups-memoization half **refuted with evidence** — already `useMemo`'d at `SideChat.tsx:290-315`; cap implemented; windowing deferred YAGNI). Finding 5 → Task 5 (**plus the use-jorvis-conversations sibling the finding didn't list** — without it the JorvisRoom conversion is a silent no-op). Finding 6 → Task 6. Finding 7 → Task 7. Method requirements → render-count probes (Tasks 2/3/5/6), grep-siblings enumeration (Task 8), gate without local e2e (Task 8).
- **Mechanism check (caught during planning):** `appStateStore.setState` alone does NOT re-render broad-context consumers — the failing tests must drive changes through a real `dispatch` (DispatchGrabber pattern); all probe tests do.
- **Mock-crash check (caught during planning):** `JorvisRoom.test.tsx` and `JorvisRoom.b3.test.tsx` mock the state MODULE with only `useAppState` — the Task 5 conversion would crash them; Step 7 extends both mocks. `EditorTab.test.tsx` already provides all three hooks. Task 7's two test files get the same extension.
- **Type consistency:** `useAppStateSelector<T>((s: AppState) => T)` per `state.hook.ts:58-66`; `SwarmMessage` factory fields match `shared/types.ts:258-268`; `Workspace` factories match the shapes used by existing tests; `WORKSPACE_OPEN`/`SET_ROOM` action shapes verified against `state.reducer.ts:269` and `state.types.ts:141`.
- **Placeholder scan:** every code step contains complete code; no TBDs; expected test failures stated with reasons.
