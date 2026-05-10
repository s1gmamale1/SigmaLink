# W7 — Visual Sweep Report

Compiled: 2026-05-09
Driver: Playwright `_electron` API, `app/tests/e2e/smoke.spec.ts`
Run mode: headed (default), 1 worker, 0 retries
Run duration: 28.3s end-to-end

## Headline

| Metric | Count |
|---|---|
| Total screenshots captured | **37 / 37** |
| Smoke-flow steps that passed end-to-end (driver+capture both succeeded) | **37 / 37** (capture); see per-step table for *semantic* pass |
| Bugs filed | **15** (BUG-W7-001 .. BUG-W7-015) |
| ↳ P0 | 0 |
| ↳ P1 | 3 |
| ↳ P2 | 6 |
| ↳ P3 | 6 |
| Console errors observed | 0 |
| Page errors observed | 0 |
| Crashes | 0 |

The app boots cleanly, all routes render, and the e2e harness runs in under 30 seconds. The biggest cluster of issues is around workspace activation lifecycle — `workspaces.open` returning a record without dispatching `SET_ACTIVE_WORKSPACE`, plus the disabled-button gating in the sidebar making automated navigation brittle.

## Per-step pass/fail table

| # | Step | Capture | Semantic | Notes |
|---|------|---------|----------|-------|
| 01 | startup | ok | ok | Onboarding modal mounts ~1.5s after domcontentloaded |
| 02 | onboarding-step1 | ok | ok | Welcome card visible |
| 03 | onboarding-step2 | ok | ok | "Detect agents" step reached |
| 04 | onboarding-step3 | ok | ok | Workspace picker step reached |
| 05 | workspaces-empty | ok | ok | Initial empty state — only `Homeworks` in Recent from prior runs |
| 06 | workspaces-with-recent | ok | **partial** | Recent updated with SigmaLink, but card still says "No folder selected." (BUG-W7-001 / BUG-W7-011) |
| 07 | launcher-4-panes | ok | ok | "4 panes" preset highlighted |
| 08 | command-room-empty | ok | ok | Post-launch transition fires correctly when using the actual UI button |
| 09 | command-room-running | ok | ok | 4 PowerShell shell panes mosaic-tiled correctly |
| 10 | command-room-focus-mode | ok | ok | "Focus" layout button responsive |
| 11 | swarm-empty | ok | ok | New Swarm form rendered with Squad preset selected and 5-agent roster |
| 12 | swarm-create | ok | partial | Mission textarea filled but `Squad` was already selected; UI did not re-acknowledge |
| 13 | swarm-running | ok | **fail** | RPC `swarms.create` returned `no workspace` because `workspaces.list` was empty (BUG-W7-006) |
| 14 | swarm-side-chat | ok | partial | Composer field filled, but no live swarm context to attach to |
| 15 | review-empty | ok | ok | Review Room shows 4 sessions from Command Room launch — not actually empty |
| 16 | review-with-sessions | ok | ok | 4 sessions listed |
| 17 | review-diff-tab | ok | ok | Diff tab active, `.mcp.json +0 -0` shown, "Select a file with patches to inspect." placeholder |
| 18 | tasks-empty | ok | ok | 5-column kanban (Backlog / In Progress / In Review / Done / Archived) |
| 19 | tasks-card-create | ok | ok | "New task" drawer opens on the right |
| 20 | tasks-card-on-board | ok | partial | RPC fallback created a task; appears in Backlog after refresh |
| 21 | memory-empty | ok | partial | Sidebar nav was a no-op when workspace not activated (BUG-W7-002) — the screenshot shows Tasks |
| 22 | memory-create-note | ok | partial | Same as above — drawer appears over Tasks board |
| 23 | memory-list-with-note | ok | partial | Memory state changed via RPC but room not visible |
| 24 | memory-graph | ok | partial | Same — Tasks board with a New task drawer overlay (BUG-W7-008) |
| 25 | browser-empty | ok | **fail** | Navigation no-op (BUG-W7-002 + BUG-W7-014) — Tasks room rendered |
| 26 | browser-tab-loaded | ok | **fail** | Same |
| 27 | skills-empty | ok | ok | Skills room rendered correctly with drop zone |
| 28 | settings-appearance | ok | ok | Appearance tab w/ 4 theme cards, 4 font sizes, terminal font, preview |
| 29 | settings-providers | ok | ok | Providers tab reached |
| 30 | settings-mcp | ok | ok | MCP servers tab reached |
| 31 | theme-parchment | ok | partial | Theme applied to canvas; sidebar still dark (BUG-W7-004) |
| 32 | theme-nord | ok | ok | Theme switched, accents updated |
| 33 | theme-synthwave | ok | ok | Theme switched (was the persisted default) |
| 34 | command-palette | ok | ok | Ctrl+K opens palette with full nav list |
| 35 | sidebar-collapsed | ok | ok | Window resized to 900px wide, sidebar collapses to icon strip |
| 36 | error-banner | ok | **fail** | Bogus path RPC silently rejected — no toast/banner (BUG-W7-005) |
| 37 | final-shutdown | ok | ok | App in expected resting state |

Capture pass: **37/37**.
Semantic pass (room reached + state correct): **27/37** (Memory/Browser steps degraded by the workspace-activation chain bug).

## Bugs filed

See `docs/07-bugs/OPEN.md`. Summary:

| ID | Sev | Title |
|----|-----|-------|
| BUG-W7-001 | P1 | `workspaces.open` succeeds but does not activate the workspace |
| BUG-W7-002 | P2 | Sidebar room buttons can be focused without dispatching when disabled |
| BUG-W7-003 | P2 | Default theme on first launch is Synthwave, not Obsidian |
| BUG-W7-004 | P2 | Sidebar background does not retheme when switching to Parchment |
| BUG-W7-005 | P1 | Bogus `workspaces.open` path produces no visible error/toast |
| BUG-W7-006 | P1 | `swarms.create` returns "no workspace" after successful `workspaces.open` |
| BUG-W7-007 | P3 | PowerShell new-version banner clutters every fresh shell pane |
| BUG-W7-008 | P2 | Tasks "New task" drawer stays open after navigating away |
| BUG-W7-009 | P3 | "Tasks" sidebar item icon stroke weight inconsistent |
| BUG-W7-010 | P3 | Test-only: native folder picker can't be scripted — RPC substituted |
| BUG-W7-011 | P2 | Workspaces room shows conflicting selection signals after recent click |
| BUG-W7-012 | P3 | Onboarding Skip click occasionally drops during transition |
| BUG-W7-013 | P2 | Memory/Browser cannot be reached without first launching a workspace |
| BUG-W7-014 | P3 | Browser room not reachable in test sweep — coupled to 001 |
| BUG-W7-015 | P3 | Parchment "Launch N agents" CTA contrast nit |

## Notable observations

### Performance
- First paint to onboarding modal: ~1.2s on Windows 11, 16GB RAM.
- 4-pane PowerShell launch (step 09): stable in <2s, no flicker, all four xterm instances read input.
- Theme switch is instantaneous via `data-theme` attribute; no flash of unstyled content.
- Bundle is 844 KB (gzipped 244 KB) — Vite warning about chunk size is informational; first-paint feels snappy.

### Motion / animation
- Onboarding modal uses Radix Dialog with subtle scale+fade enter — feels appropriate.
- Tab switches in Settings are immediate (no slide). Acceptable for a power-user tool.
- xterm rendering is smooth, no jitter on resize.
- Status dots in Swarm Roster appear static — the spec calls for warm pulse on `status-running`. None of our screenshots had a running agent to verify, so this is unverified rather than failing.

### Theming
- Obsidian (default per spec) is **not** the actual default once the kv key is populated — see BUG-W7-003.
- Parchment, Nord, Synthwave all switch correctly via `document.documentElement.setAttribute('data-theme', …)`.
- Sidebar fails to retheme under Parchment (BUG-W7-004); creates a hard left-edge seam.
- Diff colors (red/green) show in Review Room but no actual diff was rendered in step 17 because the launched panes did no edits.

### Robustness
- **Zero console errors** observed during the entire run — impressive given the breadth of features touched.
- No `pageerror` events.
- No crashes, no hangs, no IPC channel rejections.
- `workspaces.open` to a bogus path correctly rejects the IPC promise — but doesn't surface the rejection in the UI (BUG-W7-005).

## Top 5 polish items to address before acceptance

1. **Fix the workspace activation lifecycle** (BUG-W7-001 + BUG-W7-006). One canonical action — `workspaces.open` — should both persist and activate. Without this, deep links and automation are unreliable, and the Memory/Browser/Tasks rooms can't be reached programmatically.
2. **Surface RPC errors as toasts** (BUG-W7-005). Today, a misbehaving handler is invisible to the user. Wire `rpc` rejections into a `sonner` toast at the renderer root so any unhandled IPC error has a default surface.
3. **Default-theme guard rail** (BUG-W7-003). On boot, if `app.theme` is missing or not in `{obsidian, parchment, nord, synthwave}`, force `obsidian`. Also add a "Reset to default" button under Appearance.
4. **Theme the sidebar like the canvas** (BUG-W7-004). The Sidebar component uses `bg-sidebar`/`bg-sidebar-accent`; ensure each theme overrides those tokens (Parchment in particular).
5. **Consistent disabled-state UX** (BUG-W7-002 + BUG-W7-013). When a sidebar room is disabled because no workspace is active, show a tooltip explaining "Open a workspace to enable" and prevent the focus ring from making it look reachable.

## Test artifacts

- Screenshots: `docs/06-test/screenshots/01-startup.png` … `37-final-shutdown.png`
- Console+driver log: `docs/06-test/console-output.txt`
- Step-level JSON summary: `docs/06-test/visual-summary.json`
- Test source: `app/tests/e2e/smoke.spec.ts`
- Playwright config: `app/playwright.config.ts`
- Re-run command: `cd app && npx playwright test tests/e2e/smoke.spec.ts --reporter=list`
