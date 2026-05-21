# Open Bugs — SigmaLink

> **Status as of v1.5.1 (2026-05-20)**: this file is a HISTORICAL LEDGER. Every entry below with `**Status**: open` was already closed by a later version — they are kept here for repro/hypothesis context only. The 2026-05-20 catch-up sweep updated [`BACKLOG.md`](BACKLOG.md) with the authoritative list of what's actually open (2 items: DOGFOOD-V1.4.2-01 + -02, both UX-investigation-class).
>
> **For the current consolidated backlog (open bugs + deferred optimization + known limitations + shipped/verified table), see [`BACKLOG.md`](BACKLOG.md).** That doc is updated every release and is the source of truth for "what's still open in SigmaLink". `DEFERRED.md` is currently empty.
>
> This file is the long-form bug ledger — each entry has full repro / hypothesis / surface details. The v1.1.1-* / v1.1.2-* / v1.1.3-* / W7-* entries below STILL show `**Status**: open` but their fixes have ALREADY SHIPPED in the named version. See the "Shipped & verified" tables in `BACKLOG.md` for which version closed each one.

Filed during build + visual test waves. Each bug gets attempts in `ATTEMPTS.md`; if five attempts fail, the bug moves to `DEFERRED.md`.

> **W7-003 + W7-006**: Promoted to `verified` 2026-05-10 by Phase 3 Step 9 automated dogfood (`app/tests/e2e/dogfood.spec.ts`). Both run against per-test temp `userData` directories (Chromium `--user-data-dir`), which is the clean-kv install scenario the original sweep could not exercise.

## Format

```
### BUG-<id>: <one-line title>
- **Severity**: P0 / P1 / P2 / P3
- **Surface**: where it shows up (room, file, action)
- **Repro**: minimal steps
- **Expected**: …
- **Actual**: …
- **Hypothesis**: …
- **Owner**: <agent id> or unassigned
- **Status**: open / in-progress / fixed / deferred
- **Attempts**: N
- **Notes**: …
```

## Bugs

## v1.1.3 planned work (2026-05-11) — planning artifacts, not yet implemented

Filed from user dogfood + plan-mode review of v1.1.2-rev3. Implementation will be delegated to a parallel agent swarm once the user authorizes execution. Plan reference: `docs/10-memory/v1.1.3-plan.md`.

### BUG-V1.1.3-01: Chat role label still reads "BRIDGE" instead of "SIGMA"
- **Severity**: P3
- **Surface**: Sigma Assistant chat — `app/src/renderer/features/bridge-agent/ChatTranscript.tsx` role label
- **Repro**: open Sigma Assistant, send a message, observe assistant reply's role chip reads "BRIDGE"
- **Expected**: assistant reply role chip reads "SIGMA"
- **Owner**: coder-rebrand-chat (planned)
- **Status**: closed (shipped v1.1.3 — `ChatTranscript.tsx:26` `assistant: 'SIGMA'`)
- **Notes**: last user-facing brand string the v1.1.1 sweep missed. 30-min fix; Step 1 in v1.1.3 plan.

### BUG-V1.1.3-02: Workspace switching is destructive — prior workspace runtime state lost
- **Severity**: P1 (UX-blocking for multi-project workflows)
- **Surface**: Sidebar `WorkspaceTabs` click → renderer state `SET_ACTIVE_WORKSPACE` discards prior context
- **Repro**: open workspace A, spawn 2 agents, switch to workspace B; switch back to A — sessions still in DB but renderer no longer treats A as "open"
- **Expected**: switching is a tab swap; both workspaces stay live; close button per tab dismisses just one
- **Owner**: coder-multi-workspace (planned)
- **Status**: closed (shipped v1.1.3 — `openWorkspaces[]` state model + `activeWorkspaceId`)
- **Notes**: Step 2 in v1.1.3 plan. Requires state model change from `activeWorkspace` to `openWorkspaces[]` + `activeWorkspaceId`.

### BUG-V1.1.3-03: All previously-open workspaces don't restore on app relaunch
- **Severity**: P2
- **Surface**: app boot after quit
- **Repro**: open 3 workspaces, quit, relaunch — only 1 workspace (the active one) restores
- **Expected**: every workspace open at quit-time reappears as a tab; active workspace matches last; per-workspace last-room is preserved
- **Owner**: coder-session-restore (planned)
- **Status**: closed (shipped v1.1.3 — `SessionSnapshotSchema` extended to list-of-workspaces shape)
- **Notes**: Step 6 in v1.1.3 plan. Extends v1.1.2 BUG-V1.1.2-02 single-workspace snapshot to list-of-workspaces shape.

### BUG-V1.1.3-04: PTY panes don't resume on app restart — CLI sessions evaporate
- **Severity**: P1
- **Surface**: app boot — `agent_sessions` rows survive, but the actual claude/codex/gemini processes don't; no `--resume` mechanism is wired
- **Repro**: open workspace, spawn claude pane, have a conversation, quit app, relaunch — pane is gone; row is stale in DB
- **Expected**: pane respawns with `<provider> --resume <session_id>` and the prior chat history continues
- **Owner**: coder-pane-resume (planned)
- **Status**: closed (shipped v1.1.3 — session-id-extractor + resume-launcher + migration 0011 `external_session_id`)
- **Notes**: Step 3 in v1.1.3 plan. Needs migration 0011 to add `external_session_id` column + session-id extractor parsing CLI early output + resume launcher consuming the existing `resumeArgs` registry field (declared but unused since v1.1.0). Per-CLI extractor fixtures need capture during implementation.

### BUG-V1.1.3-05: Cannot add agents to an existing swarm — pane count locked at preset
- **Severity**: P2
- **Surface**: Swarm Wizard preset selection at create-time; Command Room has no "+pane" UI
- **Repro**: create swarm with 5-pane preset; want to add a 6th — no affordance exists
- **Expected**: "+pane" button in Command Room top bar; "+agent" in Swarm Room header; Sigma Assistant tool `add_agent` callable via MCP
- **Owner**: coder-add-pane (planned)
- **Status**: closed (shipped v1.1.3 — `swarms.addAgent` RPC + `add_agent` Sigma tool; cap 20)
- **Notes**: Step 4 in v1.1.3 plan. Reuses existing `spawnAgentSession` helper in `swarms/factory.ts`. Cap at 20 (existing preset max).

### BUG-V1.1.3-06: Ruflo bootstrap is lazy + verifies nothing on workspace open
- **Severity**: P2
- **Surface**: workspace creation in `workspaces/factory.ts:openWorkspace()`
- **Repro**: open a fresh workspace; observe Ruflo supervisor stays in `absent` or `down` state until user clicks Download in Settings; mcp-autowrite ran but nothing verified the agents can actually discover the server
- **Expected**: `openWorkspace` calls `rufloSupervisor.ensureStarted()` + `verifyForWorkspace(root, 'fast')`; readiness pill in the breadcrumb area animates green when ready; strict-verification toggle available in Settings
- **Owner**: coder-ruflo-preflight (planned)
- **Status**: closed (shipped v1.1.3 — `rufloSupervisor.ensureStarted()` + `verifyForWorkspace` on workspace open)
- **Notes**: Step 5 in v1.1.3 plan. Fast mode: ~50ms config file readback. Strict mode (opt-in toggle): ~3-5s per CLI MCP handshake probe.

### BUG-V1.1.3-07: Skills not verified per-CLI on workspace open
- **Severity**: P3
- **Surface**: skills fanout — `manager.ts` already fans skills to claude/codex/gemini paths but never re-verifies content hash on subsequent workspace opens
- **Repro**: install skill, fanout succeeds, manually delete the skill from `~/.claude/skills/<name>/`, re-open workspace — skill is missing but SigmaLink doesn't notice
- **Expected**: on workspace open, `skillsManager.verifyFanoutForWorkspace(workspaceId)` checks each enabled skill's content hash at each enabled CLI path; missing/stale triggers reFanout
- **Owner**: coder-skills-verify (planned)
- **Status**: closed (shipped v1.1.3 — `skillsManager.verifyFanoutForWorkspace` on workspace open)
- **Notes**: Step 7 in v1.1.3 plan. Non-blocking on failure; just a hygiene pass.

### BUG-W7-001: `workspaces.open` RPC succeeds but does not activate the workspace
- **Severity**: P1
- **Surface**: Workspaces room — `workspaces.open` IPC handler / Launcher.tsx integration
- **Repro**:
  1. Launch app, dismiss onboarding.
  2. From the renderer, `await window.sigma.invoke('workspaces.open', '<existing repo path>')`.
  3. Inspect renderer state.
- **Expected**: The opened workspace becomes the active workspace, footer shows the repo, and the "1 · Choose a folder" card shows the selected folder card (not "No folder selected").
- **Actual**: RPC returns the workspace record successfully, the recent list updates with the new entry, but the launcher card still says "No folder selected." and the footer still reads "No workspace open." Sidebar room buttons (Command Room, Swarm Room, Review Room, Tasks, Memory, Browser) remain disabled.
- **Hypothesis**: `workspaces.open` only persists/upserts the workspace record. The renderer doesn't auto-dispatch `SET_ACTIVE_WORKSPACE` for non-launch flows; only `Launcher.launch()` dispatches that action. Either `workspaces.open` should activate it, or the renderer should listen and reflect it.
- **Owner**: unassigned
- **Status**: verified
- **Fix**: `app/src/renderer/features/workspace-launcher/Launcher.tsx:73,82` (pickFolder + chooseExisting now dispatch `SET_ACTIVE_WORKSPACE`); reducer in `app/src/renderer/app/state.tsx:142` no longer auto-switches rooms so the user can stay on Workspaces while assigning panes; OnboardingModal + CommandPalette already dispatched the action.
- **Attempts**: 1
- **Verification**: Wave 9 acceptance re-ran `tests/e2e/smoke.spec.ts`; the recents row + footer + Launch CTA now agree, and the launcher transitions to Command Room on launch.
- **Notes**: Visible in `docs/06-test/screenshots/06-workspaces-with-recent.png`. Affects automation and any future "open most recent" deep-link flow.

### BUG-W7-002: Sidebar room buttons match for click via `:has-text()` even when no workspace is active and remain navigable
- **Severity**: P2
- **Surface**: `src/renderer/features/sidebar/Sidebar.tsx`
- **Repro**:
  1. Launch app, no workspace active.
  2. Programmatically click `button[aria-label="Browser"]` via Playwright.
- **Expected**: With no active workspace, navigation to non-allowed rooms should be a no-op AND visibly indicated (e.g. cursor-not-allowed shows but `disabled` attribute is set on the button).
- **Actual**: Buttons report `disabled={true}` to the DOM but the click can still be forced and the focus/outline state changes (Browser button's outline highlights) without dispatching a room change. This produces confusing screenshots where "Browser" appears active in the sidebar but the Tasks board is shown in the main pane.
- **Hypothesis**: The `disabled` attribute prevents `onClick` from firing, but the button still receives focus styling. Sidebar should also visually grey-out the focus ring when disabled, OR the room transition should be permitted but immediately route back to Workspaces room with a toast.
- **Owner**: unassigned
- **Status**: verified
- **Fix**: `app/src/renderer/features/sidebar/Sidebar.tsx:148-180` — disabled buttons now use `tabIndex={-1}`, `aria-disabled`, opacity/cursor-not-allowed, no focus ring, and a Radix tooltip explaining "Open a workspace to enable".
- **Attempts**: 1
- **Verification**: Wave 9 acceptance smoke confirms the disabled state has no focus ring; tooltip text rendered when hovered in manual sweep.
- **Notes**: `docs/06-test/screenshots/25-browser-empty.png` and `26-browser-tab-loaded.png` show this — sidebar shows "Browser" outlined but Tasks room rendered.

### BUG-W7-003: Default theme on first launch is Synthwave, not Obsidian
- **Severity**: P2
- **Surface**: `ThemeProvider.tsx` / `kv` defaults / Settings → Appearance
- **Repro**:
  1. Wipe app data (or run the smoke spec which writes `app.theme=synthwave` via the test driver).
  2. Re-launch.
- **Expected**: Per `UI_SPEC.md` §1.1, the default theme is `obsidian` (deep neutral with violet primary). `data-theme="obsidian"` should be applied if the kv key is missing.
- **Actual**: Settings shows the Synthwave card highlighted (and the canvas is the magenta neon variant). The kv value persisted from a previous session is retained without a reset path, and there is no "Reset to default" affordance in Appearance.
- **Hypothesis**: ThemeProvider reads `app.theme` from kv and applies whatever string is stored. There is no validation that the theme is in the canonical set, no fallback to `obsidian` if the value is malformed, and no obvious reset button.
- **Owner**: unassigned
- **Status**: verified
- **Fix**: `app/src/renderer/app/ThemeProvider.tsx:33-46` — value is validated against `isThemeId` and corrected to obsidian + persisted; `app/src/renderer/features/settings/AppearanceTab.tsx:62-77` — added "Reset to default" button next to the Theme grid.
- **Attempts**: 1
- **Verification**: Verified by automated dogfood test 2026-05-10. `app/tests/e2e/dogfood.spec.ts:'BUG-W7-003: default theme on fresh kv is obsidian'` launches the app with a per-test temp `userData` directory (Chromium `--user-data-dir` flag → empty kv), waits for ThemeProvider hydrate, then asserts both `kv.app.theme` resolves to `'obsidian'` (auto-corrected from null) AND `<html data-theme>` reads `obsidian`. Screenshot: `docs/06-test/screenshots/dogfood-v1/df-04-w7-003-default-theme.png`.
- **Notes**: `screenshots/28-settings-appearance.png` confirms Synthwave is the active card on the persisted dev kv (carried over from W7 sweep) — that profile is a separate concern from default-on-fresh-install behaviour.

### BUG-W7-004: Sidebar background does not retheme when switching to Parchment (light) theme
- **Severity**: P2
- **Surface**: `Sidebar.tsx` styles / `parchment.css` token coverage
- **Repro**:
  1. Open Settings → Appearance, choose "Parchment".
  2. Observe the left sidebar.
- **Expected**: Sidebar adopts the parchment surface tokens (cream background, dark text) like the rest of the workspace canvas.
- **Actual**: The sidebar remains dark (synthwave-era dark gradient) while the main pane and footer become parchment cream. Reads as a hard visual seam down the middle of the window.
- **Hypothesis**: Sidebar uses CSS classes like `bg-sidebar` rather than `bg-canvas`, and the parchment theme either doesn't override `--bg-sidebar` or the Tailwind class compiled to a literal hex that bypasses the variable.
- **Owner**: unassigned
- **Status**: verified
- **Fix**: `app/src/index.css:90-198` — audited Parchment, Nord, and Synthwave `:root[data-theme="..."]` blocks. All four themes (including Obsidian) define the full sidebar token set: `--sidebar-background`, `--sidebar-foreground`, `--sidebar-primary[-foreground]`, `--sidebar-accent[-foreground]`, `--sidebar-border`, `--sidebar-ring`. Tailwind's `bg-sidebar` is wired to `hsl(var(--sidebar-background))` in `tailwind.config.js:42-50`, so the sidebar now retheme-s with the rest of the canvas.
- **Attempts**: 1
- **Verification**: Wave 9 acceptance confirms the parchment/nord/synthwave screenshots show the sidebar adopting the theme background; no left-edge seam.
- **Notes**: `screenshots/31-theme-parchment.png` shows the seam.

### BUG-W7-005: Bogus `workspaces.open` path produces no visible error/toast
- **Severity**: P1
- **Surface**: Workspaces room / global error toaster
- **Repro**:
  1. From renderer, `await window.sigma.invoke('workspaces.open', 'Z:/this/path/definitely/does/not/exist')`.
- **Expected**: A toast or banner like "Folder not found: Z:\…" appears for at least 3 seconds.
- **Actual**: The promise rejects with an error string, but no visible UI feedback is rendered. Nothing in the Workspaces room changes.
- **Hypothesis**: Errors thrown from `rpc` invocations are not piped to a global toast surface — only individual call-sites that wrap in `try/catch` show user feedback, and `workspaces.open` is invoked from the Launcher's "Pick folder" path (where the native picker prevents bogus input). The programmatic path has no observer.
- **Owner**: unassigned
- **Status**: verified
- **Fix**: `app/src/renderer/lib/rpc.ts:1-90` — `invokeChannel` now calls `toast.error(message)` from sonner when the envelope is `{ok:false}` before re-throwing, so every unhandled RPC rejection surfaces. `app/src/renderer/app/App.tsx:1,55-60` — mounted `<Toaster position="bottom-right" richColors closeButton theme="dark" />` from `sonner` at the app root. Added a `rpcSilent` proxy for opt-out (probe loops, optional fetches).
- **Attempts**: 1
- **Verification**: Wave 9 acceptance smoke logged the bogus-path step and confirmed the sonner toaster mounted; per-step screenshot 36 shows the toast region.
- **Notes**: `screenshots/36-error-banner.png` shows the post-error state — indistinguishable from a normal Workspaces view.

### BUG-W7-006: `swarms.create` returns "no workspace" even after successful `workspaces.open`
- **Severity**: P1
- **Surface**: `swarms.create` IPC / workspaces-list lookup race
- **Repro**:
  1. `await window.sigma.invoke('workspaces.open', '<repo>')` — succeeds.
  2. Immediately `await window.sigma.invoke('workspaces.list')`.
- **Expected**: The list contains the just-opened workspace record (with the same id).
- **Actual**: `workspaces.list` returns `[]`, so the harness's swarms.create call returned `{ ok: false, err: 'no workspace' }`. Possibly a separation between "open" (current selection) and "list" (saved workspaces) that is not documented.
- **Hypothesis**: `workspaces.list` only returns workspaces that have been launched at least once (or saved via a different path). `workspaces.open` returns a transient record that isn't yet persisted. Either persist on open, or document the lifecycle.
- **Owner**: unassigned
- **Status**: verified
- **Fix**: `app/src/main/core/workspaces/factory.ts:24-58` — `openWorkspace` now runs `wal_checkpoint(PASSIVE)` after the insert/update so any subsequent `workspaces.list` (in the same or another renderer call) is guaranteed to see the row. `app/src/main/core/swarms/factory.ts:51-66` — `createSwarm` continues to look up by the caller-supplied `workspaceId` directly (no dependence on `workspaces.list`) and now throws a clearer error pointing at `workspaces.open` if the row really is missing. The remaining "no workspace" line in the smoke console output is a test-harness bug (it consumes the raw envelope as an array — see BUG-W7-010).
- **Attempts**: 1
- **Verification**: Verified by automated dogfood test 2026-05-10. `app/tests/e2e/dogfood.spec.ts:'BUG-W7-006: swarms.create after workspaces.open has no race'` uses the workspace id returned by `workspaces.open` directly (envelope-aware, sidesteps BUG-W7-010 harness bug) and immediately invokes `swarms.create` — both calls share the same evaluate closure with no intervening wait, so any race would surface. Result: open returns `{ok:true, data:{id}}`, create returns `{ok:true, data:{id, ...}}`, and a follow-up `swarms.list(wsId)` shows the new row. Screenshot: `docs/06-test/screenshots/dogfood-v1/df-05-w7-006-swarm-created.png`.
- **Notes**: Test-harness bug BUG-W7-010 remains separate (it lives in the OLD smoke spec only); the dogfood spec consumes the envelope correctly.

### BUG-W7-007: PowerShell new-version banner clutters every fresh shell pane
- **Severity**: P3
- **Surface**: `pty.create` default args / Command Room shell panes
- **Repro**:
  1. Launch a 4-pane workspace with provider=Shell on Windows where pwsh upgrade is available.
- **Expected**: Pane shows just the prompt; the upgrade nag is suppressed or shown once across the workspace, not in every pane.
- **Actual**: All four panes render the "A new PowerShell stable release is available: v7.6.1" message. Visually noisy, takes ~6 lines of vertical space per pane.
- **Hypothesis**: PowerShell environment variable `POWERSHELL_UPDATECHECK=Off` is not set when spawning the pty. We could pass `-NoLogo` and the env var to suppress.
- **Owner**: coder-bugs
- **Status**: fixed
- **Fix**: `app/src/main/core/pty/local-pty.ts` — `defaultShell()` now passes `-NoLogo` to both `pwsh` and `powershell.exe` (cmd.exe and unix shells unchanged); `spawnLocalPty()` sets `POWERSHELL_UPDATECHECK=Off` when the resolved executable is in the PowerShell family (basename match against `pwsh{,.exe}` / `powershell{,.exe}`). The new `isPowerShell(command)` helper isolates the detection so user-supplied PowerShell paths (full paths, scripts) also benefit.
- **Verified by**: coder-bugs, Wave 12 — code review of `local-pty.ts` (banner suppression + env var); cmd.exe path unchanged, unix shells untouched. Awaiting Windows re-smoke for visual confirmation.
- **Attempts**: 1
- **Notes**: `screenshots/09-command-room-running.png`.

### BUG-W7-008: Tasks "New task" drawer stays open after navigating away to other rooms
- **Severity**: P2
- **Surface**: Tasks room drawer state
- **Repro**:
  1. Open Tasks, click "New" to open the drawer.
  2. Without closing, click Memory in the sidebar.
- **Expected**: Drawer dismisses on room change (or is anchored under the Tasks room and doesn't render in others).
- **Actual**: Drawer persists across room changes — the smoke-test memory-graph step (`24-memory-graph.png`) shows the New Task drawer still on top of the Tasks board (because navigation was actually a no-op due to BUG-W7-002, but conceptually the drawer should still close when room changes).
- **Hypothesis**: Drawer is mounted as a sibling overlay rather than within the Tasks subtree, and its `open` state is local to the drawer not gated by current room.
- **Owner**: unassigned
- **Status**: verified
- **Fix**: `app/src/renderer/features/tasks/TasksRoom.tsx:54-61,151-161` — drawer visibility is now derived from `state.room === 'tasks'` (`drawerNewOpen`, `drawerDetail`). Both `NewTaskDrawer` and `TaskDetailDrawer` receive `open=false` whenever the room is not Tasks, so the drawer cannot leak across rooms even if a sibling overlay or animation reentered.
- **Attempts**: 1
- **Verification**: Wave 9 acceptance smoke captured Tasks → Memory navigation; drawer no longer overlays the Memory room.
- **Notes**: Coupled with BUG-W7-002.

### BUG-W7-009: "Tasks" sidebar item is missing the leading icon visual weight on hover/active states
- **Severity**: P3
- **Surface**: `Sidebar.tsx` ITEMS list — Tasks icon
- **Repro**: Hover the "Tasks" sidebar entry.
- **Expected**: Same gap+icon+label rhythm as Workspaces / Command Room / Swarm Room.
- **Actual**: The Tasks lucide icon is much smaller in stroke weight than its siblings; the row reads as text-only at a glance.
- **Hypothesis**: Different `lucide-react` icon component used for tasks; perhaps `ListChecks` vs the heavier `ListTodo`.
- **Owner**: coder-bugs
- **Status**: fixed
- **Fix**: `app/src/renderer/features/sidebar/Sidebar.tsx` — replaced `ListChecks` (whose embedded checkmark glyph rendered visually lighter than its peers) with `LayoutGrid`, which shares the simple-square stroke profile of `Folder` / `Globe` / `Settings` and is also a clean visual metaphor for a Kanban board. Same `h-4 w-4` size, default lucide stroke (1.5 via the lib's class merge).
- **Verified by**: coder-bugs, Wave 12 — diff review against the rest of the ITEMS list. Status dots / agent count pills explicitly NOT added (those are `coder-launcher`'s V3-W12-008).
- **Attempts**: 1
- **Notes**: Cosmetic.

### BUG-W7-010: Test-only limitation — Folder picker is the native dialog, can't be scripted by Playwright
- **Severity**: P3
- **Surface**: Test harness (`tests/e2e/smoke.spec.ts`) interacting with `workspaces.pickFolder`
- **Repro**: N/A (test-only).
- **Expected**: Playwright can drive a folder pick during automation.
- **Actual**: We must substitute the equivalent `workspaces.open` RPC because Electron's `dialog.showOpenDialog` cannot be intercepted from the renderer.
- **Hypothesis**: Wrap `pickFolder` so test mode (`process.env.NODE_ENV === 'test'`) bypasses the native dialog with a fixed path.
- **Owner**: coder-bugs
- **Status**: fixed
- **Fix**: `app/src/main/rpc-router.ts` — `workspacesCtl.pickFolder` now checks `process.env.SIGMA_TEST` first. When set, it reads the path from `kv['tests.fakePickerPath']` and returns `{ path }` directly, skipping `dialog.showOpenDialog` entirely. If the env var is set but no fake path is configured, the call throws `"workspaces.pickFolder: SIGMA_TEST is set but no fake path configured. Set kv['tests.fakePickerPath'] before invoking the picker."` so tests fail loudly rather than silently fall back to an unscriptable native dialog. (The bug spec mentioned `core/workspaces/controller.ts`; the actual definition lives in `rpc-router.ts` — fixed at the live location.)
- **Verified by**: coder-bugs, Wave 12 — code review confirms native path unchanged when `SIGMA_TEST` is unset, and the kv lookup uses the same `kv` table the existing `kv.get`/`kv.set` controller writes to. Smoke spec opt-in with `SIGMA_TEST=1` + a `kv.set('tests.fakePickerPath', ...)` is now possible; the smoke itself still substitutes via `workspaces.open` (no behavioural change there).
- **Attempts**: 1
- **Notes**: Filed per orchestration rules — substituted with RPC and noted.

### BUG-W7-011: Workspaces room shows two conflicting selection signals after a recent click
- **Severity**: P2
- **Surface**: Workspaces room — recent list + "1 · Choose a folder" card
- **Repro**:
  1. With recents present, click a recent item.
- **Expected**: The "1 · Choose a folder" card transitions to show the selected folder details (path + "Git worktrees will be created per pane"), the row in Recents is highlighted, and the "Launch N agents" button enables.
- **Actual**: Card updates ("SigmaLink … Git worktrees will be created per pane"), recent row highlights, **but** the secondary text "No folder selected." persists from the empty state in some renders, and the footer still shows "No workspace open." The launch button enables but tooltip claims "Ready when you are." while the workspace is not actually active.
- **Hypothesis**: The "No folder selected" caption is conditionally rendered based on `selectedWorkspace == null` but a separate `activeWorkspace` controls the footer; the two should agree.
- **Owner**: unassigned
- **Status**: verified
- **Fix**: `app/src/renderer/features/workspace-launcher/Launcher.tsx:26-29` — removed local `selectedWorkspace` state; the launcher now derives selection from the canonical `state.activeWorkspace` reducer slice (single source of truth). All references downstream were already using `selectedWorkspace`; they now point at the dispatched value, so card, footer, and Launch CTA always agree.
- **Attempts**: 1
- **Verification**: Wave 9 acceptance smoke confirms launcher card/footer/Launch CTA agree.
- **Notes**: See `screenshots/06-workspaces-with-recent.png`.

### BUG-W7-012: Onboarding modal does not auto-dismiss after 5-second idle on a transient `Skip` click sometimes
- **Severity**: P3
- **Surface**: `OnboardingModal.tsx`
- **Repro**: Walk through the welcome step, click Skip quickly while modal is mid-fade-in.
- **Expected**: One click on Skip closes the modal.
- **Actual**: In the smoke run, after a Continue → Continue sequence, the Skip click occasionally bounced (the modal remained on the workspace step) and we relied on `kv.set('app.onboarded','1')` to suppress for the rest of the session.
- **Hypothesis**: Click handlers attached during the `data-state="open"` Radix Dialog transition are dropped if the click lands during `closing`/`open` transition. Add `pointer-events: auto` always or wait for `data-state="open"` before binding.
- **Owner**: coder-bugs
- **Status**: fixed
- **Fix**: `app/src/renderer/features/onboarding/OnboardingModal.tsx` — `complete()` was awaiting `rpc.kv.set` and the workspace open round-trip before dispatching `SET_ONBOARDED`, so the modal stayed mounted (and pointer-events were governed by the Radix transition) for the duration of the IPC. Now we dispatch `SET_ONBOARDED` synchronously on click, fire the kv write into the background (`void rpc.kv.set(...)`), and only set `busy=true` if there is a `pickedFolder` to open. The Skip button is also now never `disabled` during boot and forces `style={{ pointerEvents: 'auto' }}` so a click cannot fall through Radix's open/close fade. The kv write is idempotent; redundant skips are harmless.
- **Verified by**: coder-bugs, Wave 12 — code review of the new ordering. Awaiting slow-boot Playwright re-run for empirical confirmation.
- **Attempts**: 1
- **Notes**: Low-priority polish.

### BUG-W7-013: Memory and Browser rooms cannot be reached from the sidebar without first launching a workspace
- **Severity**: P2
- **Surface**: Sidebar gating logic
- **Repro**: Launch app, dismiss onboarding, click Memory.
- **Expected**: Either Memory opens with an empty/disabled state explaining "Open a workspace to see memories" or the click is a clear no-op with a tooltip.
- **Actual**: Click is silently ignored (`disabled` attribute), no tooltip explains why, and the Skills room is reachable without a workspace, suggesting inconsistent gating.
- **Hypothesis**: The disabled-room set in Sidebar.tsx (line 144) excludes 'workspaces', 'settings', and 'skills' but the rationale isn't documented for users.
- **Owner**: unassigned
- **Status**: verified
- **Fix**: Resolved by BUG-W7-002. `app/src/renderer/features/sidebar/Sidebar.tsx:148-180` — disabled sidebar items now show the "Open a workspace to enable" tooltip on hover/focus, fully explaining the gating without changing the gating set.
- **Attempts**: 1
- **Verification**: Wave 9 acceptance confirms tooltip wiring; W7-002 verified status applies here.
- **Notes**: UX polish — tooltips should explain disabled state.

### BUG-W7-014: Browser room not reachable in test sweep (no workspace activated) — placeholder screenshot misnamed
- **Severity**: P3
- **Surface**: Test harness limitation + Browser room dependency on active workspace
- **Repro**: Run smoke spec end-to-end without launching a workspace.
- **Expected**: `25-browser-empty.png` shows the Browser room.
- **Actual**: The screenshot shows the Tasks room because navigation didn't take. This compounds BUG-W7-001/002.
- **Hypothesis**: Resolving BUG-W7-001 (auto-activate on `workspaces.open`) will also fix this.
- **Owner**: coder-bugs
- **Status**: fixed
- **Fix**: Two-part decoupling.
  - `app/src/renderer/app/App.tsx` — `RoomSwitch` now mirrors `state.room` to `document.body.dataset.room` so the active room id is observable from outside React.
  - `app/tests/e2e/smoke.spec.ts` — the Browser-room captures now read `document.body.getAttribute('data-room')` and embed the actual rendered room in the filename: `25-browser-empty-<room>.png` and `26-browser-tab-loaded-<room>.png`. When sidebar gating sends the click elsewhere the file is named after the room that actually rendered (e.g. `25-browser-empty-tasks.png`), so screenshots are no longer silently mislabelled. The step note also includes `nav=<bool>` for diagnostic clarity.
- **Verified by**: coder-bugs, Wave 12 — diff review of the smoke + App.tsx wiring. The next Playwright run should produce filenames that match their content. Original BUG-W7-001 / W7-002 root causes already fixed in earlier waves; this fix protects the test harness from regressing if either reappears.
- **Attempts**: 1
- **Notes**: Coupled bug — close when BUG-W7-001 closes.

### BUG-W7-015: "Launch N agents" button label and shape not clearly differentiated from cancel/secondary actions in light themes
- **Severity**: P3
- **Surface**: Workspaces room CTA / parchment + nord theme contrast
- **Repro**: Switch to Parchment theme, view the Workspaces room.
- **Actual**: The Launch button background uses a dark rust accent with white text — readable, but in the corner of a cream canvas, the visual emphasis is weaker than the dark theme's neon-cyan equivalent. No regression test — just a contrast nit.
- **Hypothesis**: Parchment uses `--brand-warm` for the accent which is also the Pick folder button — they read as siblings. Make Launch use `--accent` only.
- **Owner**: unassigned
- **Status**: closed (shipped v1.4.6 — WCAG AA contrast pass; all four themes verified)
- **Attempts**: 1
- **Notes**: `screenshots/31-theme-parchment.png`. Verified by v1.4.6 theme contrast sweep; BACKLOG.md "Parchment contrast (BUG-W7-015)" entry confirmed.

### BUG-W7-000: Electron app failed to launch
- **Severity**: P0
- **Surface**: app startup
- **Repro**: npx playwright test tests/e2e/smoke.spec.ts
- **Expected**: app starts and renders first window
- **Actual**: Error: electron.launch: Electron Failed to install correctly, please delete node_modules/electron and try installing again
- **Status**: closed (shipped v1.4.6 + v1.4.7 — Playwright smoke refresh + Electron-ABI rebuild in CI lanes; final state 11 e2e tests, 0 fail, 3 documented skips)
- **Attempts**: 1

### BUG-DF-02: Two RPC channels lack zod schema entries (`app.tier`, `design.shutdown`)
- **Severity**: P3
- **Surface**: `app/src/main/core/rpc/schemas.ts` — boot-time soft-launch warning logged `2 channel(s) have no zod schema entry: app.tier · design.shutdown`.
- **Status**: open → fixed (2026-05-10)
- **Fix**: `app/src/main/core/rpc/schemas.ts` — added `APP_TIER_SCHEMA` (`output: z.enum(['basic','pro','ultra'])`, mirrors `Tier` in `core/plan/capabilities.ts`) and `DESIGN_SHUTDOWN_SCHEMA` (`output: z.void()` — main-internal teardown hook, not in the renderer allowlist). Both registered in `CHANNEL_SCHEMAS` so the soft-launch warning now reports zero gaps. Source bug entry: `docs/06-test/DOGFOOD_V1.md` §5.
- **Attempts**: 1
- **Notes**: Zod enforcement is still soft-launch (`VALIDATION_MODE = 'warn'`); this closes the coverage gap so a later wave can flip to `'enforce'` without further coordination.

### BUG-DF-01: Browser data-room flickers / sidebar nav lands on prior `tasks` room in Playwright auto-flow
- **Severity**: P3 (target: v1.1)
- **Surface**: `app/src/renderer/features/browser/{BrowserRoom,BrowserRecents,TabStrip,BrowserViewMount}.tsx` — Browser room re-render churn driven by `browser:state` IPC broadcasts.
- **Repro (Playwright)**: After clicking through Tasks → Memory → graph tab → click `button[aria-label="Browser"]`, then synchronously read `document.body.getAttribute('data-room')`. Reads `tasks`, not `browser`. Visually: a one-frame flash in the data-room area as the WebContentsView re-positions on every `did-navigate` / `page-title-updated` event.
- **Expected**: `data-room` settles to `browser` within 400 ms with no visible flicker in the recents column or the WebContentsView.
- **Actual** (pre-fix): `data-room` still reads `tasks` after 400 ms; `25-browser-empty-tasks.png` / `26-browser-tab-loaded-tasks.png` confirm the Tasks board content remained rendered. Manually visible as a one-frame WebContentsView flash on every page-title / did-navigate tick.
- **Hypothesis** (pre-fix): The Sidebar `disabled` calculation was suspected (BUG-W7-002 already addressed that). Actual root cause: `BrowserManager.broadcast()` (`app/src/main/core/browser/manager.ts:357-373,453-454`) fires `browser:state` for every WebContents `page-title-updated` / `did-navigate` / `did-navigate-in-page` event. Each broadcast calls `dispatch SET_BROWSER_STATE`, the reducer spreads (`app/src/renderer/app/state.tsx:231-234`) and produces a fresh `slice`/`tabs` reference, BrowserRecents re-runs `buildRecents` (sort + filter + map), BrowserViewMount's ResizeObserver schedules a redundant `setBounds` IPC, and the main process re-positions the WebContentsView with identical coords — observable as a flicker. Under Playwright the re-render storm also competes with the room-transition dispatch from the sidebar click, which is why the `data-room` attribute appears to "stick" on `tasks`.
- **Owner**: dataroom-fixer
- **Status**: open → fixed (2026-05-10)
- **Fix**:
  - `app/src/renderer/features/browser/BrowserViewMount.tsx` — wrap in `React.memo`; dedupe `setBounds` IPC by comparing the last-sent rect against the next one (skip when x/y/width/height + visible all match). Eliminates the WebContentsView re-position churn that produced the visible flicker.
  - `app/src/renderer/features/browser/TabStrip.tsx` — wrap in `React.memo` with a content-aware comparator (`id` / `url` / `title` per tab + handler identity). Tab strip no longer re-renders on every page-title tick.
  - `app/src/renderer/features/browser/BrowserRecents.tsx` — wrap in `React.memo` with a comparator over the inputs to `buildRecents` (`id` / `url` / `lastVisitedAt` per tab). Recents column no longer re-runs `buildRecents` on every broadcast.
  - `app/src/renderer/features/browser/BrowserRoom.tsx` — annotated the existing `useMemo(() => slice?.tabs ?? [], [slice])` to document why the short-circuit lives in the leaves (the reducer always spreads, so the parent ref legitimately changes; only content-aware comparators on the leaves can no-op the equal-payload renders).
- **Verified by**: dataroom-fixer, Phase 3 — `npx tsc -b --noEmit` exits 0; `npm run lint` reports 32 errors (well below the 54 baseline; none in the four touched files); E2E browser smoke not re-run in this session because Electron does not launch in the harness (BUG-W7-000), but the change is purely renderer memoisation + IPC dedup so the existing dogfood + smoke specs should pick it up on the next CI run.
- **Attempts**: 1
- **Visual-verify steps for next manual run** (operator, not automatable):
  1. Launch app, open a workspace, click Browser.
  2. Open a tab to a site with frequent title updates (e.g. a busy Twitter/X feed or a YouTube watch page) and let it run for ~30 s.
  3. Watch the recents column (left aside) and the underlying browser pane: neither should flash on title ticks. The WebContentsView should hold its position without reflow.
  4. With DevTools open in the renderer, add a `console.count('recents render')` inside `BrowserRecentsInner` and a `console.count('viewmount setBounds')` inside the dedup branch of `BrowserViewMount` — counts should be near-zero on title-only updates and bump only on real layout changes (window resize, sidebar collapse, tab close).
- **Notes**: BUG-W7-002 / BUG-W7-014 already addressed the sidebar gating + screenshot misnaming. This fix attacks the remaining substrate that made the Playwright nav race observable in the first place: a re-render storm in the Browser room that competes with the room-transition dispatch. Coupled with the prior sidebar fixes the entire DF-01 symptom should clear. Source bug entry: `docs/06-test/DOGFOOD_V1.md` §5.

---

## v1.1.2 smoke-test follow-ups (2026-05-11) — must-fix before tag

User dogfooded the v1.1.2-arm64 DMG (built off branch `v1.1.2-final` at commit `3b3627e`) and surfaced two real bugs that block the tag:

### BUG-V1.1.2-01: Sigma Assistant doesn't actually know about its tools (dispatch dead-letter)
- **Severity**: P1 (blocks v1.1.2 tag — supersedes the "tool dispatch parity PASS" verdict)
- **Surface**: Sigma Assistant chat in right-rail panel
- **Repro**: open Sigma Assistant; type "do you see how many panes are open?"
- **Expected**: Sigma calls `list_active_sessions`, replies with concrete counts
- **Actual**: Sigma replies: "I don't actually have access to the `list_active_sessions` tool in this environment — the Sigma tools listed in my prompt aren't wired up here. I can't see live pane or swarm state right now."
- **Hypothesis**: the v1.1.2 work built the *receiving* side of tool dispatch (`runClaudeCliTurn.ts:routeToolUse` extended with `dispatchTool` callback + stdin write queue + `tool_result` envelopes) but did NOT build the *announcing* side. The Claude CLI is spawned with `claude -p ... --output-format stream-json --verbose --append-system-prompt "<ctx>"` — the `<ctx>` lists tools by NAME but the CLI's tool-use protocol requires tools be REGISTERED via an MCP server, not just described in prose. With no MCP server exposing the 13 Sigma tools to the child CLI, Claude never emits a `tool_use` envelope, the dispatcher never fires, and the live `list_*` tools are dead code.
- **Owner**: coder-mcp-server (target v1.1.2 — must-fix)
- **Status**: closed (shipped v1.1.2-rev3 — `mcp-host-server.cjs` MCP stdio bridge wired into `runClaudeCliTurn`)
- **Attempts**: 1
- **Notes**: Fix: build a `sigma-host-mcp-server.cjs` (model after the existing `app/src/main/core/memory/mcp-server.ts` → `electron-dist/mcp-memory-server.cjs` pattern). The server exposes the 13 tools from `tools.ts` via MCP stdio. `runClaudeCliTurn` writes a temp `.mcp.json` referencing the spawned server and passes `--mcp-config <temp.path>` to the `claude` CLI. The CLI then auto-discovers the tools, emits `tool_use` envelopes for them, the existing dispatcher catches them, and the round-trip we built actually fires.

### BUG-V1.1.2-02: Workspace session state not persisted across restarts
- **Severity**: P2
- **Surface**: app launch
- **Repro**: open a workspace, open the Command Room, spawn some panes; quit the app; relaunch
- **Expected**: SigmaLink restores the last workspace, last room, and (ideally) the open panes' provider list — at minimum, the previously-active workspace is auto-opened
- **Actual**: app launches to the workspace picker as if first-run; user must manually re-pick their workspace
- **Hypothesis**: no `kv['app.lastSession']` write on quit / no auto-restore on `whenReady`. The kv pattern is already wired (used by `plan.tier`, `voice.mode`, `sidebar.collapsed`, etc); just needs a session-restore hook.
- **Owner**: coder-session-state (target v1.1.2)
- **Status**: closed (shipped v1.1.2 — `app:session-snapshot` emitter + `app:session-restore` listener; v1.1.3 extended to multi-workspace list shape)
- **Attempts**: 1
- **Notes**: Minimum viable fix: emit `app:session-snapshot` from renderer on every SET_ACTIVE_WORKSPACE / SET_ROOM; main process caches + writes to kv on `before-quit`; on next boot after `did-finish-load`, send `app:session-restore` to renderer which dispatches the state. Pane-level restore (provider, count, prompts) deferred — falls to v1.2 (already persisted in `agent_sessions` table).

## v1.1.1 smoke-test follow-ups (2026-05-11)

User dogfooded the v1.1.1 DMG (window drag + Sigma rebrand + Claude CLI streaming + voice diagnostics + single-instance lock). The four UX fixes ship as expected; three real-but-not-blocking gaps surfaced for v1.1.2:

### BUG-V1.1.1-01: Sigma Assistant `launch_pane` tool not wired into PTY spawn
- **Severity**: P2
- **Surface**: Sigma Assistant (right-rail) → user asks "launch a codex pane" → tool emits but pane never appears
- **Repro**: open right-rail Sigma Assistant; type "Launch 1 codex pane. Prompt is to give 1 sentence introduction of itself"; observe Tool calls panel shows `launch_pane` invocation but no new PTY in Command Room
- **Expected**: codex CLI pane materialises in the active swarm with the initialPrompt pre-typed
- **Actual**: tool call returns `{ fromCli: true, input: {...}, result: { ... } }` but the host bridge does not consume the tool_use envelope to spawn an actual pane. The CLI emits the intent, the renderer logs it, but `launch_pane` is not in the deferred-tools list and direct calls fail with "No such tool available."
- **Hypothesis**: `runClaudeCliTurn`'s `tool_use` handler routes through `ToolTracer` (visualisation) but never feeds the result back into the controller's `invokeTool('launch_pane', …)` path. coder-cli's follow-up #2 from the Step 3 exit summary already flagged this.
- **Owner**: unassigned (target v1.1.2)
- **Status**: closed (shipped v1.1.2 — `tools.ts` wired to factory; `launch_pane`/`dispatch_pane`/`dispatch_bulk`/`create_swarm` envelopes routed through `assistant.invokeTool()`)
- **Attempts**: 1
- **Notes**: To unblock — wire the CLI driver's `tool_use` envelopes into the existing `assistant.invokeTool()` controller method (controller.ts:189-259). Same for `dispatch_pane`, `dispatch_bulk`, and `create_swarm`.

### BUG-V1.1.1-02: Sigma Assistant cannot enumerate active sessions / swarm state
- **Severity**: P2
- **Surface**: Sigma Assistant chat
- **Repro**: with an active workspace + 4 spawned agent panes, ask Sigma "Do you see how many agents currently launched in our workspace?"
- **Expected**: Sigma replies with "4 agents: claude-1, claude-2, codex, gemini" or similar
- **Actual**: Sigma replies "No active swarms or panes in the SigmaLink workspace right now — the session header shows '(no active swarms)' and no recent files."
- **Hypothesis**: `buildSigmaSystemPrompt()` reads workspace + swarm state at turn start, but the renderer's active session list is not threaded through to the system prompt builder. The state queried is from the fresh main-process DB read, not the renderer's live session map.
- **Owner**: unassigned (target v1.1.2)
- **Status**: closed (shipped v1.1.2 — `list_active_sessions` tool queries live PTY registry; `list_active_swarms` added)
- **Attempts**: 1
- **Notes**: Likely `system-prompt.ts` reads via a query path that doesn't include the just-spawned PTY rows (race vs. eventual-consistency in the session table). Add an explicit `list_active_sessions` tool that queries the live `sessions` registry instead of the DB.

### BUG-V1.1.1-03: Inter-agent broadcast / chat surface inert
- **Severity**: P2
- **Surface**: Swarm Room → side chat → Operator broadcasts to `@all` / `@coordinators`
- **Repro**: open a swarm with 5 agents (1 coordinator, 2 builders, 1 scout, 1 reviewer); operator broadcasts "Deploy Scout 1 to review and summarize the project" via the side chat
- **Expected**: every recipient agent's message counter increments (e.g., coordinator-1 1 msg, scout-1 1 msg); the broadcast text reaches each pane's mailbox
- **Actual**: every agent shows `0 msgs` after the broadcast lands; operator side chat shows `MSG OPERATOR → @COORDINATORS` rows but no agent reads them
- **Hypothesis**: the side chat → mailbox plumbing was last touched in Phase 4 Track A (group-recipient grammar). Either `expandRecipient` is returning empty, or the mailbox writer is targeting a different swarm-id than the active panes use, or the renderer's per-agent counter isn't subscribing to the right event.
- **Owner**: unassigned (target v1.1.2)
- **Status**: closed (shipped v1.1.2 — `expandRecipient` group-broadcast grammar fixed; `controller.broadcast`/`rollCall` dual-delivery wired)
- **Attempts**: 1
- **Notes**: Cross-check with the rc3 fix for cross-swarm-leak (BUG-V1.1-02-IPC) — possible regression where the swarm-id scoping was tightened too aggressively. Reproduce with the existing `mailbox.test.ts` first.

### BUG-V1.1.1-04: Ruflo MCP not auto-connected for spawned agent CLIs
- **Severity**: P2 (architectural gap, not bug — but tracked here so it doesn't get lost)
- **Surface**: every agent CLI (claude/codex/gemini) spawned from a SigmaLink workspace
- **Repro**: open a workspace, spawn 4 agents (claude, codex, gemini); inside each, ask `ruflo mcp status` or run `mcp list`
- **Expected**: Ruflo MCP shows as `connected` in every agent
- **Actual**: claude says "RuFlo is not initialized in this directory"; codex sees `ruflo.mcp_status { running: true }` but only because *its own* user-config has Ruflo wired; gemini lists only `browser` + `sigmamemory` (both disconnected)
- **Hypothesis**: SigmaLink's embedded Ruflo daemon is main-process-only — there is no per-workspace `.mcp.json` (or codex/gemini equivalent) auto-written that points spawned CLIs at a shared `.claude-flow/` state dir.
- **Owner**: unassigned (target v1.1.2)
- **Status**: closed (shipped v1.1.3 — `mcp-autowrite` writes per-workspace MCP config files + `rufloSupervisor.ensureStarted()` on workspace open)
- **Attempts**: 1
- **Notes**: Two paths: (a) v1.1.x stop-gap — auto-write workspace-scoped MCP config files pointing each agent at a shared `.claude-flow/` dir; (b) v1.2 federation — Ruflo runs as a TCP/WS MCP server on a per-workspace localhost port; agents connect as clients sharing one in-memory daemon. (a) gets you 90% of the value with ~50ms boot per agent.

## Phase 4 v1.1.0-rc1 fixes (2026-05-10)

Below: bugs closed by the autonomous Phase 4 fix wave (4 fixers + lead direct edits + voice-coder + ruflo-coder). These were filed by the e2e-runner / ipc-auditor / provider-prober testing wave.

### BUG-V1.1-03-PROV: macOS .app double-click ships with truncated PATH; providers ENOENT
- **Severity**: P1
- **Surface**: `app/electron/main.ts` boot path (no shell-PATH bootstrap on Finder launch).
- **Repro**: Build DMG, install, launch by double-clicking SigmaLink.app from Applications. Workspaces → 4-pane preset → Launch agents → all CLIs error `claude: command not found` even though `which claude` works in user's terminal.
- **Status**: open → fixed (2026-05-10)
- **Fix**: `app/electron/main.ts` — added `bootstrapShellPath()` that spawns `${SHELL} -ilc 'printf %s "$PATH"'` once at boot on darwin (only when not running under VITE_DEV_SERVER_URL), captures the resolved PATH, and prepends shell entries (deduped) to `process.env.PATH` before `registerRouter()`. All downstream PTYs inherit the full PATH so `/opt/homebrew/bin/claude` etc. resolve. Closes the symmetric BUG-V1.1-04-PROV (probe vs launch parity) at the same time since both share `process.env.PATH` after the bootstrap.
- **Attempts**: 1

### BUG-V1.1-01-PROV / 05 / 06 / 07 / 08-PROV: Provider launcher façade
- **Severity**: P1 (01) + P2 (05/06/07/08)
- **Surface**: previously, no central `app/src/main/core/providers/launcher.ts`; three call sites (`workspaces/launcher.ts`, `swarms/factory.ts`, `rpc-router.ts`) re-implemented command/args resolution inconsistently.
- **Status**: open → fixed (2026-05-10)
- **Fix**: NEW `app/src/main/core/providers/launcher.ts` `resolveAndSpawn(deps, opts)` façade — resolves `comingSoon` → `fallbackProviderId` (BridgeCode → Claude with `provider_effective` populated); walks `[command, ...altCommands]` on ENOENT; appends `provider.autoApproveFlag` when `autoApprove === true`; re-checks `kv['providers.showLegacy']` main-side. Dropped dead `'droid'` and `'copilot'` from `ProviderId` union (08). New `app/src/main/core/providers/__tests__/launcher.spec.ts` 9/9 pass. Wired in `workspaces/launcher.ts` + `swarms/factory.ts:spawnAgentSession()`.
- **Owner**: fixer-provider-launcher

### BUG-V1.1-02-PROV: agent_sessions.providerEffective column missing
- **Severity**: P1 (documentation drift — promised in CHANGELOG but never landed)
- **Surface**: `app/src/main/core/db/schema.ts` had no `providerEffective` column; renderer chrome promising "BridgeCode (using claude)" couldn't be implemented.
- **Status**: open → fixed (2026-05-10)
- **Fix**: NEW migration `app/src/main/core/db/migrations/0010_provider_effective.ts` — `ALTER TABLE agent_sessions ADD COLUMN provider_effective TEXT`, idempotent with `PRAGMA table_info` guard + BEGIN/COMMIT/ROLLBACK transaction. Mirrors `0005_coordinator_id` shape. `app/src/main/core/db/schema.ts` now has `providerEffective: text('provider_effective')` (nullable). `app/src/main/core/db/migrate.ts` registers `mig0010` in `ALL_MIGRATIONS`. The provider-launcher façade populates the column via raw SQL UPDATE in a try/catch (degrades silently on pre-0010 DBs). New regression test in `migrate.spec.ts`.
- **Owner**: fixer-providereffective

### BUG-V1.1-01-IPC: Group recipient grammar (@coordinators/@builders/@scouts/@reviewers/@all) silently dropped
- **Severity**: P1
- **Surface**: `app/src/main/core/swarms/mailbox.ts:233-242` `recipientsFor()` short-circuited on `toAgent !== '*'` and returned `[toAgent]` literal.
- **Repro**: SideChat → "Send to @coordinators" → mailbox row persisted with literal `'@coordinators'` toAgent, JSONL appended to `inboxes/@coordinators.jsonl` (non-existent inbox), zero PTYs received the SIGMA:: line.
- **Status**: open → fixed (2026-05-10)
- **Fix**: New exported `expandRecipient(swarmId, recipient): string[]` in `mailbox.ts`. Resolves `*`/`@all` → all swarm_agents.agentKey for swarmId; resolves `@coordinators`/`@builders`/`@scouts`/`@reviewers` via `swarm_agents.role` filter; for literal agentKey returns `[recipient]` if exists; unknown returns `[]` + warns. `controller.ts` canonicalizes `*` → `@all` at controller boundary. New test `mailbox.spec.ts` 10 cases covering every grammar branch.
- **Owner**: fixer-ipc-mailbox

### BUG-V1.1-02-IPC: Cross-swarm directive leak via setPaneEcho
- **Severity**: P1 (confidentiality + correctness)
- **Surface**: `app/src/main/rpc-router.ts:153-174` setPaneEcho closure discarded swarmId; DB query had no swarmId filter.
- **Repro**: Two concurrent swarms (Battalion test) where both name agents `coordinator-1`. Operator → coordinator-1 directive in swarm A could type into swarm B's coordinator-1 PTY.
- **Status**: open → fixed (2026-05-10)
- **Fix**: setPaneEcho closure now consumes swarmId; uses `and(eq(swarmAgents.swarmId, swarmId), eq(swarmAgents.agentKey, toAgent))` in WHERE. Warns on miss. `and` added to drizzle import.
- **Owner**: fixer-ipc-mailbox

### BUG-V1.1-12-IPC: writeToPtys silently swallows dead-PTY writes
- **Severity**: P3
- **Surface**: `app/src/main/core/swarms/controller.ts:209-234` try/catch around `pty.write` swallowed all errors.
- **Status**: open → fixed (2026-05-10)
- **Fix**: New `reportDeadWrite(swarmId, targetAgent, originalEnvelopeId, reason)` in `controller.ts` emits a `kind:'error_report'` mailbox row when a write target is dead. Operator sees feedback in side-chat instead of silence.
- **Owner**: fixer-ipc-mailbox (folded into BUG-V1.1-01-IPC fix)

### BUG-V1.1-04-IPC: Cross-pane "Jump to pane" only fires on toast click
- **Severity**: P2
- **Surface**: `app/src/renderer/features/bridge-agent/BridgeRoom.tsx` + `command-room/{CommandRoom,Terminal}.tsx`.
- **Status**: open → fixed (2026-05-10)
- **Fix**: BridgeRoom now performs the workspace-switch + room-hop + active-session + `sigma:pty-focus` jump AUTOMATICALLY on `assistant:dispatch-echo` (not behind a toast button click). Toast retained as confirmation. New gate `kv['bridge.autoFocusOnDispatch']` (default ON). CommandRoom listens for `sigma:pty-focus` at room level; activeIndex now derived from `state.activeSessionId` via useMemo. Terminal short-circuits if already focused (avoid double-focus).
- **Owner**: fixer-pane-sync

### BUG-V1.1-DF-01-PW: Playwright e2e suite fails on Node 26
- **Severity**: P1 (blocks automated regression)
- **Surface**: `tests/e2e/{smoke,dogfood}.spec.ts`. Playwright 1.59 + Node 26 race the loader hook; `test.setTimeout`/`test.afterEach` at module-load fire before file suite registers.
- **Status**: open → defensive-fix applied (2026-05-10)
- **Defensive fix**: `smoke.spec.ts` — moved `test.setTimeout(240_000)` inside the test body. `dogfood.spec.ts` — wrapped contents in `test.describe('dogfood-v1', () => { ... })`. Both specs now survive the racey loader.
- **Proper fix (defer to v1.2)**: bump `@playwright/test` to ≥1.60 (uses `module.registerHooks()` instead of deprecated `module.register()`).
- **Owner**: lead

### Bugs deferred to v1.2

- **BUG-V1.1-03-IPC** (P1 → demoted P2): V3 envelope kinds (`escalation`, `review_request`, `quiet_tick`) have no producer. `error_report` IS now produced by writeToPtys dead-PTY check (BUG-V1.1-12 fix). The other kinds need quiet-tick detector + ESCALATE SIGMA:: parser.
- **BUG-V1.1-05-IPC** (P2): Roll-call has no main-process aggregation/timeout/feedback.
- **BUG-V1.1-06-IPC** (P2): Bridge Assistant `roll_call`/`broadcast` tools call `mailbox.append` directly, bypassing `controller.broadcast`/`rollCall` dual-delivery (mailbox row written but SIGMA:: line never typed into PTYs).
- **BUG-V1.1-07-IPC** (P2): `console-controller.stop-all` and `factory.killSwarm` are divergent kill paths — zombie agent rows possible after Battalion-20 stop.
- **BUG-V1.1-08-IPC** (P3): Mailbox JSONL mirror not transactional with SQLite insert — partial-write crash leaves on-disk artifacts inconsistent.
- **BUG-V1.1-09-IPC** (P3): factory.ts data handler subscribes before exit handler — fast-failing provider can race the data subscription.
- **BUG-V1.1-10-IPC** (P3): Replay scrub reads ALL `swarm_messages` rows on every slider tick; needs full-row LRU cache.
- **BUG-V1.1-11-IPC** (P3): No envelope-id deduplication in mailbox; double-click Roll Call yields 2 distinct rows.
- **BUG-V1.1-09-PROV** (P3): PTY allocation has no idempotent retry on transient failure.
- **BUG-V1.1-DF-02-PW** (P3): @playwright/mcp@0.0.75 forces a duplicate playwright-core@1.61.0-alpha into pnpm lockfile.
