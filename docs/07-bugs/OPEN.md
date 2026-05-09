# Open Bugs — SigmaLink

Filed during build + visual test waves. Each bug gets attempts in `ATTEMPTS.md`; if five attempts fail, the bug moves to `DEFERRED.md`.

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
- **Status**: fixed
- **Fix**: `app/src/renderer/app/ThemeProvider.tsx:33-46` — value is validated against `isThemeId` and corrected to obsidian + persisted; `app/src/renderer/features/settings/AppearanceTab.tsx:62-77` — added "Reset to default" button next to the Theme grid.
- **Attempts**: 1
- **Verification**: Wave 9 acceptance smoke runs against a kv that already contains `app.theme=synthwave` (carried over from the W7 sweep), so the screenshot still shows Synthwave selected. Manual re-verification on a clean kv profile is recommended; the validator + Reset button were code-reviewed but not exercised on a fresh install in this pass.
- **Notes**: `screenshots/28-settings-appearance.png` confirms Synthwave is the active card.

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
- **Status**: fixed
- **Fix**: `app/src/main/core/workspaces/factory.ts:24-58` — `openWorkspace` now runs `wal_checkpoint(PASSIVE)` after the insert/update so any subsequent `workspaces.list` (in the same or another renderer call) is guaranteed to see the row. `app/src/main/core/swarms/factory.ts:51-66` — `createSwarm` continues to look up by the caller-supplied `workspaceId` directly (no dependence on `workspaces.list`) and now throws a clearer error pointing at `workspaces.open` if the row really is missing. The remaining "no workspace" line in the smoke console output is a test-harness bug (it consumes the raw envelope as an array — see BUG-W7-010).
- **Attempts**: 1
- **Verification**: Wave 9 acceptance smoke still emits the legacy "no workspace" console line for the same harness reason (BUG-W7-010 unchanged). Manual re-verification through the GUI rpc client is recommended before promoting to verified.
- **Notes**: See `docs/06-test/console-output.txt` line `[RPC swarms.create] {"ok":false,"err":"no workspace"}`.

### BUG-W7-007: PowerShell new-version banner clutters every fresh shell pane
- **Severity**: P3
- **Surface**: `pty.create` default args / Command Room shell panes
- **Repro**:
  1. Launch a 4-pane workspace with provider=Shell on Windows where pwsh upgrade is available.
- **Expected**: Pane shows just the prompt; the upgrade nag is suppressed or shown once across the workspace, not in every pane.
- **Actual**: All four panes render the "A new PowerShell stable release is available: v7.6.1" message. Visually noisy, takes ~6 lines of vertical space per pane.
- **Hypothesis**: PowerShell environment variable `POWERSHELL_UPDATECHECK=Off` is not set when spawning the pty. We could pass `-NoLogo` and the env var to suppress.
- **Owner**: unassigned
- **Status**: open
- **Attempts**: 0
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
- **Owner**: unassigned
- **Status**: open
- **Attempts**: 0
- **Notes**: Cosmetic.

### BUG-W7-010: Test-only limitation — Folder picker is the native dialog, can't be scripted by Playwright
- **Severity**: P3
- **Surface**: Test harness (`tests/e2e/smoke.spec.ts`) interacting with `workspaces.pickFolder`
- **Repro**: N/A (test-only).
- **Expected**: Playwright can drive a folder pick during automation.
- **Actual**: We must substitute the equivalent `workspaces.open` RPC because Electron's `dialog.showOpenDialog` cannot be intercepted from the renderer.
- **Hypothesis**: Wrap `pickFolder` so test mode (`process.env.NODE_ENV === 'test'`) bypasses the native dialog with a fixed path.
- **Owner**: unassigned
- **Status**: open
- **Attempts**: 0
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
- **Owner**: unassigned
- **Status**: open
- **Attempts**: 0
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
- **Owner**: unassigned
- **Status**: open
- **Attempts**: 0
- **Notes**: Coupled bug — close when BUG-W7-001 closes.

### BUG-W7-015: "Launch N agents" button label and shape not clearly differentiated from cancel/secondary actions in light themes
- **Severity**: P3
- **Surface**: Workspaces room CTA / parchment + nord theme contrast
- **Repro**: Switch to Parchment theme, view the Workspaces room.
- **Actual**: The Launch button background uses a dark rust accent with white text — readable, but in the corner of a cream canvas, the visual emphasis is weaker than the dark theme's neon-cyan equivalent. No regression test — just a contrast nit.
- **Hypothesis**: Parchment uses `--brand-warm` for the accent which is also the Pick folder button — they read as siblings. Make Launch use `--accent` only.
- **Owner**: unassigned
- **Status**: open
- **Attempts**: 0
- **Notes**: `screenshots/31-theme-parchment.png`.
