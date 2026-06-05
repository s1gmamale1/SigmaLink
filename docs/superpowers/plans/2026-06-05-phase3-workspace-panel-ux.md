# Phase 3 — Workspace & panel UX quick wins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Four small, high-frequency UX papercuts in the chrome the operator uses constantly: toggle the workspace rail from the logo, rename workspaces inline, toggle the right rail by re-clicking the active tab, and add a plain-terminal / worktree-choice to `+Pane`.

**Architecture:** Mostly renderer + 1–2 thin RPCs. State machinery already exists (sidebar collapse, right-rail context, KV persistence). No new infra.

**Tech Stack:** React 19 renderer (`useAppStateSelector`/`useAppDispatch`, `useSyncExternalStore`), Tailwind/shadcn, KV via `rpc.kv` + `workspace-ui-kv`, vitest + RTL.

---

## ⚠️ Sequencing constraint — Phase 3 overlaps the LIVE Phase 2 file set

Phase 2 (OPT) is being executed concurrently (operator's 3 lanes). Phase 3 touches several of the **same files**. To avoid collisions, execute in this order:

| Item | Files | Phase-2 overlap | When to run |
|------|-------|-----------------|-------------|
| **DEV-W1** logo→rail toggle | `sidebar/Sidebar.tsx` | none (Sidebar already on selectors) | ✅ **safe now** (isolated worktree) |
| **DEV-W4** rail open/close on active-tab re-click | `right-rail/RightRailContext{.tsx,.data.ts}`, `top-bar/RightRailSwitcher.tsx`, **`app/App.tsx`** (render gate) | **App.tsx = Phase-2 Lane A (PERF-3)** | after Lane A merges |
| **DEV-W2** rename workspace | `core/workspaces/factory.ts`, `rpc-router.ts`, `sidebar/WorkspacesPanel.tsx` | **rpc-router/factory = Phase-2 Lane C** | after Lane C merges |
| **DEV-W5** +Pane plain-terminal + worktree toggle | `command-room/AddPaneButton.tsx`, `swarms/factory-spawn.ts` | **factory-spawn = Lane C** + **depends on W3b's `skipWorktree`** | after Phase 2 merges |

**Recon facts (2026-06-05):** `workspaces.rename` RPC does NOT exist yet (`rpc-router.ts`/`factory.ts` clean); the `workspaces.name` column already exists (no migration). `AddPaneButton.tsx` exists, no `shell`/`spawnScratch`/worktree-toggle yet. `RightRailContext` value = `{activeTab,setActiveTab}` — **no `railOpen` state** yet. The ROADMAP's `RightRailSwitcher.tsx:59` ref points at **`features/top-bar/RightRailSwitcher.tsx`** (not `right-rail/`).

---

## DEV-W1 — SigmaLink logo toggles the sidebar (safe now)

**Files:** `src/renderer/features/sidebar/Sidebar.tsx` (header block ~235–262) + `Sidebar.*.test.tsx`.

Today the `Monogram` logo (line ~242) is non-interactive; collapse/expand are separate `ChevronLeft`/`ChevronRight` buttons. `setCollapsed(next)` already exists (`dispatch SET_SIDEBAR_COLLAPSED` + persists `app.sidebar.collapsed`).

### Task W1.1: logo becomes a toggle (TDD)
- [ ] **Step 1 — failing test** (`Sidebar.test.tsx`): render `<Sidebar/>` in `<AppStateProvider>`, click the logo (by its new `aria-label="Toggle sidebar"`), assert `sidebarCollapsed` flipped (probe state or assert the collapsed-class on the `aside`). Expect FAIL (logo not clickable yet).
- [ ] **Step 2 — implement:** wrap the `Monogram` in a `<button type="button" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle sidebar" title="Toggle sidebar">`, keeping the `text-primary` style + `noDragStyle()`. Leave the existing Chevron buttons as-is (redundant affordances are fine). When collapsed, the logo is centered (already handled by the parent `justify-center`).
- [ ] **Step 3 — run + typecheck:** `npx vitest run src/renderer/features/sidebar/ && npx tsc -b` → green.
- [ ] **Step 4 — commit:** `git add src/renderer/features/sidebar/Sidebar.tsx src/renderer/features/sidebar/Sidebar.test.tsx` → `feat(DEV-W1): SigmaLink logo toggles the sidebar`.

---

## DEV-W4 — re-clicking the active right-rail tab collapses the panel (after Lane A)

**Files:** `right-rail/RightRailContext.tsx` + `RightRailContext.data.ts` (add `railOpen` + persist), `top-bar/RightRailSwitcher.tsx` (toggle-on-active), `app/App.tsx` (render gate — **Lane A file; sequence after it merges**) + tests.

**Decision (ROADMAP, revisit if wrong):** Jorvis "minimize" = collapse-to-strip (same close mechanic); the Settings tab returns to the last non-settings room (recoverable from `roomByWorkspace`).

### Task W4.1: `railOpen` in context + persistence
- [ ] Add `railOpen: boolean` + `setRailOpen(open)` / `toggleRail()` to `RightRailContextValue` (`RightRailContext.data.ts`), default `true`. Persist per-workspace via the `workspace-ui-kv` pattern already used for `rightRail.width` (KV panel id `rightRail.open`), with read-through hydrate on workspace change (mirror `RightRail.tsx`'s width hydrate). Test the reducer/context with RTL.

### Task W4.2: switcher toggles on active-tab re-click
- [ ] In `top-bar/RightRailSwitcher.tsx`: clicking a **different** tab → `setActiveTab(tab)` + `setRailOpen(true)`; clicking the **already-active** tab → `toggleRail()` (close if open, reopen if closed). Test: active-tab click closes; other-tab click opens+switches.

### Task W4.3: App.tsx honors `railOpen` (AFTER Lane A merges)
- [ ] Where `App.tsx` renders `<RightRail/>` (gated on `rightRail.enabled`), additionally gate on `railOpen` (render the body full-width when closed). **Do NOT touch App.tsx until Phase-2 Lane A (PERF-3 selectors) has merged** — rebase onto that. Update `RightRail.layout.test.tsx`/`RightRail.rsp.test.tsx` in lockstep.

---

## DEV-W2 — editable workspace names (after Lane C)

**Files:** `core/workspaces/factory.ts` (rename fn), `rpc-router.ts` (`workspaces.rename` channel — **Lane C file; sequence after**), `sidebar/WorkspacesPanel.tsx` (inline edit) + tests. No migration (`name` column exists).

### Task W2.1: `workspaces.rename` (TDD, main)
- [ ] `factory.ts`: `renameWorkspace(id, name)` — trim + non-empty validate, `UPDATE workspaces SET name=? WHERE id=?`; return the row. MockDb test (better-sqlite3 can't load under vitest).
- [ ] `rpc-router.ts`: register `workspaces.rename` with zod input `{ id: string, name: string (1..120) }`. Add to `COLUMN_ALLOWLIST`/sync only if a synced column changed (name already synced — verify the drift test).

### Task W2.2: inline edit in WorkspacesPanel (renderer)
- [ ] Double-click (or a kebab "Rename") on a workspace row → inline `<input>` (Enter commits via `rpc.workspaces.rename`, Esc cancels); optimistic `dispatch` then reconcile. The folder/`rootPath` is unchanged (only the display name). Test the commit/cancel paths.

---

## DEV-W5 — +Pane plain terminal + per-add worktree toggle (after Phase 2 / W3b)

**Files:** `command-room/AddPaneButton.tsx` (menu), `swarms/factory-spawn.ts` (**Lane C file + needs W3b's `skipWorktree` plumbing**) + tests.

### Task W5.1: plain-terminal add
- [ ] `AddPaneButton` offers "Plain terminal" → spawn via the `providerId:'shell'` sentinel (agent-less pane; reuse `pty.spawnScratch` if present). Test the menu + dispatch.

### Task W5.2: per-add "create in worktree" toggle
- [ ] A per-add checkbox (default = the workspace `worktreeMode` from W3b) threading `skipWorktree` into the spawn. **Reuse DEV-W3b's `skipWorktree` plumbing** (do W3b first — Phase 2). Both worktree gates already honor it after W3b.

---

## Final integration gate (run in MAIN after each item merges)
- [ ] `npm run build && npm test` (main's `tsc -b` is stricter than a worktree's).
- [ ] `npx playwright test tests/e2e/` (whole dir).
- [ ] Operator smoke: logo toggles the rail; a renamed workspace persists (folder unchanged); re-clicking the active right-tab closes the panel and any tab re-opens it; `+Pane` adds a plain terminal and can choose worktree on/off.

## Definition of done (ROADMAP Phase 3)
Logo click toggles the rail; renamed workspace persists (folder unchanged); re-clicking the active right-tab closes the panel and any tab re-opens it; `+Pane` can add a plain terminal and choose worktree on/off; gates green.
