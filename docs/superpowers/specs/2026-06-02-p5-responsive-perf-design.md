# P5 — Responsiveness & performance (pillar b) · design spec

**Status:** approved (autonomous `/goal`). **Ships as:** `v1.41.0` (untagged). **Date:** 2026-06-02.
**Baseline:** main @ `6d9403e` (P1–P4 shipped). **Roadmap items:** RSP-1, PERF-1, PERF-11, PERF-3,
PERF-2, PERF-4, PERF-5, PERF-6, PERF-8, PERF-7, PERF-9, PERF-10, PERF-12.

## Goal
Resizable, layout-remembering surfaces that stay smooth under live multi-agent load. Recon confirmed the
heavy lifting is smaller than feared: the selector API already exists; the hot path has one coalescing seam.

## Recon findings (load-bearing)
- **PERF-1** — `pty:data`: `rpc-router.ts:375` `(sid,data)=>broadcast('pty:data',{sid,data})` fires one IPC
  send per raw chunk (~50/s/pane). Coalesce HERE only (wrap the callback): `Map<sid,string[]>` + a shared
  ~12ms timer; the registry's ring-buffer append + link-detect must stay per-chunk (untouched). Force-flush a
  session on `pty:exit` (`:376`) + `onCliExited` (`:451`) so trailing bytes precede the exit line; size-cap
  immediate-flush for big bursts. The shell-first sentinel is stripped in `registry.ts:238` (independent of
  `pty:data` — coalescing can't corrupt exit detection). Renderer (`pty-data-bus.ts`→`terminal-cache.ts:283`
  `term.write`) handles concatenated chunks. 2nd direct consumer: `ProviderInstallModal.tsx:126` (fine).
- **PERF-11** — `broadcast()` (`rpc-router.ts:170`) rebuilds `getAllWindows()` per event. App has ONE
  renderer window (`main.ts:32/601/683`; a transient diagnostic window has no listeners). Add
  `setBroadcastTarget(win)` (rpc-router exports it; `createWindow()` sets it, `closed` clears it) → O(1) send.
- **PERF-3** — the selector API ALREADY EXISTS: `state.hook.ts:24-66` `AppStateStore` + `useAppStateSelector`
  (`useSyncExternalStore`, `Object.is` bail-out); `state.tsx:43` mirrors the reducer into the store. The
  `useAppState()` whole-`state` memo (`state.tsx:137`) re-renders all 27 remaining full-context consumers on
  ANY dispatch. Migrate the hot ones: `NotificationBell.tsx:20`, `NotificationDropdown.tsx:46`,
  `Breadcrumb.tsx:34`, `RoomsMenuButton.tsx:24`, `RightRailSwitcher.tsx:37` (dispatch-only → `useAppDispatch()`).
  RISK: primitive/stable-ref selectors ONLY (no inline `{...}`/`.filter()` → tear); keep a component
  all-selector or all-context (mixed-hook layout-effect skew); each migrated test swaps its `useAppState`
  mock to `useAppStateSelector:(sel)=>sel(mockState)`.
- **RSP-1** — `resizable.tsx` wraps `react-resizable-panels` v4 (`.Group/.Panel/.Separator`, %-based,
  `onLayout`/`storage`), ZERO importers. Shell (`App.tsx:216`) + RightRail already have bespoke **px**
  splitters + global-key kv persistence; Memory tri-column is fixed CSS grid (`.memory-tri-grid`,
  `index.css:342`, 900px bp). kv is global, per-workspace by key convention (`ui.<wsId>.<panel>`).
  `useBreakpoint` + a shared density scale are NET-NEW (only Sidebar's inline 1100px `innerWidth` collapse +
  GridLayout's count-based density exist). **Strategy A (low-risk):** adopt Resizable for the Memory
  tri-column only; add `useBreakpoint`; switch Sidebar+RightRail kv to per-workspace keys + add right-rail
  narrow-collapse — DON'T rewrite the proven px splitters into %.
- **PERF-5** — `useRufloDaemonHealth.ts:53` polls per-PaneHeader (N identical RPCs/5s) → one refcounted
  per-workspace poller. **PERF-6** — `PaneShell.tsx:101`→`git-ops.ts:64` spawns `git status` per pane/15s →
  batch per repo + pause when hidden. **PERF-4** — `state.reducer.ts:48` rebuilds `sessionsByWorkspace` whole
  → incremental (preserve untouched-workspace array identity). **PERF-10** — delta re-sorts whole array →
  binary-insert. **PERF-2** — link-detect runs in main even when capture off (`registry.ts:251`) → mirror the
  KV gate. **PERF-7/8/9/12** — Constellation settle / async disk-scan / exit-listener bus / bounded JSONL read.

## Scope — two rounds

### Round-1 — perf internals (non-visual; gated by tests + perf harness)
- **Lane H (lead-owned, hot path):** PERF-1 coalesce `pty:data` (wrap the `rpc-router.ts:375` callback;
  flush on exit/cli-exit/size-cap) + PERF-11 `setBroadcastTarget` single-window fast-path (rpc-router +
  `electron/main.ts`). + a coalescer unit test (inject clock/flush).
- **Lane Sel:** PERF-3 migrate the 5 hot consumers to `useAppStateSelector`/`useAppDispatch` (+ swap their
  test mocks). Files: NotificationBell, NotificationDropdown, Breadcrumb, RoomsMenuButton, RightRailSwitcher (+ tests).
- **Lane Poll:** PERF-5 refcounted per-workspace Ruflo-health poller (`useRufloDaemonHealth`) + PERF-6 batch
  per-repo git-status + pause-when-hidden (`PaneShell`/a git-status hook). + tests. *(exit criterion: no
  per-pane duplicate Ruflo/git polling.)*
- **Lane Red:** PERF-4 incremental `sessionsByWorkspace` + PERF-10 binary-insert delta (`state.reducer.ts`) +
  PERF-2 main-side link-detect KV gate (`pty/registry.ts`). + reducer tests.

### Round-2 — RSP-1 responsive layout (the UX layer)
- `useBreakpoint` hook (net-new, SSR-safe like `motion.ts:88`) unifying the magic numbers (900/1100).
- Memory tri-column → `ResizablePanelGroup` (3 panels, side columns `collapsible`), sizes persisted per
  workspace (`ui.<wsId>.memory.cols` via debounced `onLayout`→`rpc.kv.set`, hydrate `defaultSize`).
- Sidebar + RightRail kv keys → per-workspace (read-through fallback to the old global key); right-rail
  narrow-width auto-collapse (mirror Sidebar's one-way collapse).
- Defer PERF-7/8/9/12 (Constellation settle, async disk-scan, exit-bus, bounded JSONL) → a P5.2 cleanup
  batch unless time permits in round-2.

## Verification / exit criteria
`npm run test:perf` (PERF=1 harness) shows reduced jank windows under CPU throttle + a materially lower
`pty:data` IPC message-rate under streaming; panel sizes persist per workspace across restart; no per-pane
duplicate Ruflo/git polling. Gate each round: `tsc -b` · `vitest` · build + electron:compile · full e2e ·
`eslint .` · Opus review. **Worktree base:** each lane FF-aligns to the round's foundation SHA (the P3/P4 lesson).

## Risks
- **PERF-1 coalescing latency** — keep the timer ≤16ms + force-flush on exit so the terminal never feels
  laggy or strands trailing output; the perf harness + a live smoke confirm.
- **PERF-3 selector tear** — primitive/stable-ref selectors only; migrate leaf/dispatch-only components first;
  re-gate the full vitest (the per-file `useAppState` mocks must be swapped).
- **RSP-1 px→% mismatch** — Strategy A keeps the px splitters; only the Memory grid goes %. Per-workspace key
  migration uses read-through fallback so existing widths aren't lost.
