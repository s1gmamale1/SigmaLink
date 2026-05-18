# 07 — Window responsiveness on pane re-adjustment

**Severity**: P2
**Effort**: S (~2hr trace) + M (~4hr if rAF fix needed)
**Cluster**: Pane-grid Cluster A (after #03)
**Suggested delegate**: Sonnet
**Depends on**: #03 (xterm preservation changes mount/resize semantics)

## Context

v1.4.1 dogfood: "Need to double check the window responsiveness, when panes are getting re-adjusted."

Vague but actionable — investigate whether window resize + inter-pane divider drag stays smooth (60fps) at 4 / 12 / 20 panes.

Static analysis (no runtime data yet) flagged:
- `GridLayout.tsx:91-132` — `startDrag` pointermove handler updates `colFracs/rowFracs` state synchronously without `requestAnimationFrame` throttling. At 4×4 / 5×4 grids, every pointer event triggers up to 20 simultaneous ResizeObserver callbacks. Plausible jank source.
- `Terminal.tsx:174-217` — ResizeObserver-driven `runFit` is already debounced 25ms with non-zero-dim gating. PTY resize path (`registry.resize` at `registry.ts:239`) short-circuits on dead sessions. Likely fine.
- `Terminal.tsx:159` — `transition-shadow` per-cell may produce compositor lag during sustained drag.

## Step 1 — Perf trace (S, ~2hr)

DO NOT FIX BEFORE PROFILING. Capture:

1. `pnpm electron:dev`
2. Open workspace with 12 panes, then 20 panes (run twice).
3. Chrome DevTools (electron renderer) → Performance tab → Record.
4. Run two scenarios for each grid size:
   - **A**: drag the SigmaLink window edge to resize.
   - **B**: drag an inter-pane divider for 5s.
5. Stop recording. Save profile JSON.

Identify the longest tasks in the flame graph during each scenario. Save the profile to `docs/07-test/perf-traces/v1.4.2-pane-resize-{12,20}-{window,divider}.json`.

## Step 2 — Diagnose

Common findings + matching fix:

| Finding | Fix |
|---|---|
| Long `setColFracs/setRowFracs` tasks during pointermove | rAF-wrap the state setter |
| ResizeObserver fan-out causing 20 simultaneous reflows | Coalesce: single rAF callback per frame writes to all panes |
| `runFit` re-fits firing on every observer tick | Relax `runFit` debounce 25ms → 100ms during sustained pointer drag |
| `transition-shadow` causing compositor lag | Remove or gate transition during drag |
| Heavy xterm renderer work during resize | Use xterm `addon-canvas` or skip `term.refresh` until drag end |

## Step 3 — Implement (M, ~4hr, only if needed)

### rAF wrap (most likely fix)

`GridLayout.tsx:91-132`:

```ts
// before:
function onPointerMove(e: PointerEvent) {
  // ... compute new fracs ...
  setColFracs(newCols);
  setRowFracs(newRows);
}

// after:
let pendingRaf: number | null = null;
let latestCols: number[] | null = null;
let latestRows: number[] | null = null;
function onPointerMove(e: PointerEvent) {
  // ... compute new fracs ...
  latestCols = newCols;
  latestRows = newRows;
  if (pendingRaf === null) {
    pendingRaf = requestAnimationFrame(() => {
      if (latestCols) setColFracs(latestCols);
      if (latestRows) setRowFracs(latestRows);
      pendingRaf = null;
    });
  }
}
function onPointerUp() {
  if (pendingRaf !== null) cancelAnimationFrame(pendingRaf);
  pendingRaf = null;
  // ... final flush + persist ...
}
```

### Debounce relax

`Terminal.tsx:215-217`:

```ts
// gate by pointer state on document
const debounceMs = document.body.dataset.dragging ? 100 : 25;
```

`GridLayout.tsx`: set `document.body.dataset.dragging = 'true'` during drag, clear on `pointerup`.

## File:line targets

| File | Line | Edit (conditional on trace) |
|---|---|---|
| `app/src/renderer/features/command-room/GridLayout.tsx` | 91-132 | rAF-wrap state setters in pointermove handler |
| `app/src/renderer/features/command-room/GridLayout.tsx` | 159 | (maybe) remove `transition-shadow` during drag |
| `app/src/renderer/features/command-room/Terminal.tsx` | 215-217 | Relax debounce during sustained pointer drag |

## Reusable utilities

- Native `requestAnimationFrame` — no library needed
- Existing debounce timer pattern at `Terminal.tsx:215-217`

## Cross-file dependencies

Touches the same files as #03 (xterm preservation). Must land AFTER #03 because the new mount/cache semantics affect Terminal.tsx remount cost (the rAF fix only matters if ResizeObserver is still firing, which depends on whether the Activity/cache approach keeps observers alive).

## Verification

- Re-run Step 1 perf trace; assert no task >16ms during sustained drag at 20-pane grid.
- Tests: `GridLayout.test.tsx` add a "rAF coalesces multiple pointermove" case using fake timers.
- Manual: drag inter-pane divider for 10s at 20-pane grid; subjectively smooth.

## Risks

- R-07-1: Cannot confirm rAF fix actually helps without runtime profile. Don't ship the rAF change blind.
- R-07-2: rAF can fire after pointerup → final state might be stale. The pointerup handler must flush.

## Cross-references

- BACKLOG.md DOGFOOD-V1.4.2-02 — original investigation
