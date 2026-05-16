# SigmaLink Backlog — Open Bugs + Optimization Targets

> Snapshot at **v1.2.7** (2026-05-13).
> Latest sweep: v1.2.7 multi-workspace state preservation — PTY ring-buffer replay on terminal remount, visible pane-resume failures, 500-line external session scan, sidebar close/dropdown polish, and pid-stability e2e coverage.
> Bug ledger details live in [`OPEN.md`](OPEN.md); the v1.1.1 / v1.1.2 / v1.1.3 entries there are CLOSED — see "Shipped & verified" at the bottom of this file.
> History: v1.1.8 (5-coder optimization swarm, bundle -61% gzip), v1.1.9 (perf + lint 0/0), v1.1.10 (Gemini P1 reliability), v1.1.11 (Kimi P1 + state-hook fixes), v1.2.0 (Windows port), v1.2.4 (auto-update), v1.2.5 (post-install regression sweep), v1.2.6 (browser MCP stdio).

## Index

| Bucket | Count | Lives where |
|---|---|---|
| P0 critical | 0 | — |
| P1 functional bugs | 0 | — |
| P2 functional bugs / UX | 2 | [P2 — bugs](#p2--functional--ux) |
| P3 polish | 2 | [P3 — polish](#p3--polish) |
| Provider registry cleanup | 0 (shipped v1.2.4) | [v1.1.10 providers](#v1110--provider-registry-cleanup--shipped--verified--v124) |
| Perf — sustained runtime | 2 | [v1.1.9 perf](#v119--paired-perf-refactor) |
| Quality — refactor | 3 | [v1.1.9 quality](#v119--quality--file-size) |
| Tests / CI | 2 | [v1.1.9 ci](#v119--ci--test-infra) |
| Platform / distribution | 5 | [v1.3 platform](#v13--platform--distribution) |
| Lint — React-compiler family | 31 errors | [v1.1.9 lint](#v119--react-compiler-lint-wave) |
| Funded-only (Apple, Porcupine) | 2 | [Waiting on external](#waiting-on-external--needs-funding) |

---

## v1.2.7 — multi-workspace state preservation → **Shipped & verified**

### What landed

1. `pty.snapshot(sessionId)` RPC exposes the existing main-process PTY ring buffer.
2. `SessionTerminal` replays the snapshot before attaching the live PTY data bus, so workspace switching no longer appears to wipe terminal output.
3. `externalSessionScanLineLimit` increased from 100 to 500.
4. `resumeWorkspacePanes` now reports missing `external_session_id` rows as failures instead of silently filtering them out.
5. Boot restore surfaces failed resume results through a toast.
6. Workspace sidebar close buttons show on hover for every row; the chevron dropdown opens persisted-but-closed workspaces.
7. `pty.list` includes pid for diagnostics and e2e verification.

### v1.3 follow-up

- True xterm instance preservation via React Activity or a renderer-side terminal cache for zero-latency switching. v1.2.7 deliberately ships the lower-risk replay model first.

---

## P2 — functional / UX

### BUG-W7-015 — "Launch N agents" button low-contrast in light themes
- **Surface**: Workspace Launcher light-theme variants (Parchment, etc.).
- **Issue**: primary CTA reads as a secondary button against the Parchment chrome; cancel/secondary actions look similar.
- **Effort**: XS (~30min) — adjust the variant token in `src/components/ui/button.data.ts` for the `parchment` theme.
- **Defer to**: v1.1.9 polish pass.
- **2026-05-12 check**: Current branch already uses the accent-filled launch CTA and darker Parchment accent tokens; no additional code change was needed in this PR.
- **Source**: [`OPEN.md`](OPEN.md) → BUG-W7-015.

### BUG-W7-000 — Test-runner reports "Electron app failed to launch" intermittently in Phase 3 visual sweep
- **Surface**: `tests/e2e/*.spec.ts` against a fresh kv install.
- **Issue**: Playwright cannot reliably bring the app up cold; first run sometimes hangs on better-sqlite3 module load. Repeating the test in the same run passes.
- **Hypothesis**: race between `electron-builder install-app-deps` rebuild and the test's Electron spawn. Already mitigated by v1.1.5 ad-hoc-sign hook + v1.1.8 NMV test-isolation, but never closed formally.
- **Effort**: S (~2hr) — verify on a clean CI runner with the v1.1.8 install path; close or refile.
- **Defer to**: v1.1.10 — paired with the [Playwright e2e refresh](#v1110--playwright-e2e-refresh) because the focused smoke fails on stale selectors before it can re-verify launch.
- **2026-05-12 check**: Launch step now works locally after `node scripts/build-electron.cjs`; focused smoke still fails later on v1.1.4-stale selectors (see v1.1.10 entry).
- **Source**: [`OPEN.md`](OPEN.md) → BUG-W7-000.

---

## v1.4.2 — dogfood items (2026-05-17, opened)

### DOGFOOD-V1.4.2-01 — "+ Pane" button reported as not working (likely discoverability, not stub)
- **User quote** (2026-05-17): "make the + Pane button actually work alr."
- **Surface**: `app/src/renderer/features/command-room/CommandRoom.tsx:223-282` (top-bar `Plus / Pane` button inside the Command Room header strip).
- **Investigation finding**: the button is **fully wired**, not a no-op stub.
  - Click handler (line 262) opens a `DropdownMenu` listing every provider from `rpc.providers.list()`.
  - Selecting a provider calls `addPane(providerId)` (line 201) → `rpc.swarms.addAgent({ swarmId, providerId })` → main-process `addAgentToSwarm()` in `app/src/main/core/swarms/factory.ts:198`.
  - `addAgentToSwarm` inserts the `swarm_agents` row inside a better-sqlite3 transaction (line 246), calls `spawnAgentSession()` (line 284) which spawns the PTY, and the renderer dispatches `UPSERT_SWARM` + `ADD_SESSIONS` + `SET_ACTIVE_SESSION` on success (lines 206-208). Errors are surfaced via `toast.error` (line 213).
  - v1.2.5 Step 3 added a `disabledReason` tooltip (line 51) for the three disabled states: no workspace, swarm paused, or 20-pane cap.
- **Hypothesis** (why the user thinks it's broken — needs verification):
  1. **Disabled state masquerading as broken**: when the active swarm is `paused` or the workspace has no running swarm, the button renders disabled with a tooltip that requires a 200ms hover to surface. A click on the disabled span produces no feedback at all.
  2. **DropdownMenu UX**: the button opens a dropdown rather than spawning a default pane on a single click. Users coming from the "Launch N agents" flow expect one-click "add another like the last one" semantics.
  3. **Silent failure**: `addAgentToSwarm` can reject (e.g. provider CLI missing, mailbox path unwritable). The toast fires but is easy to miss on a busy screen.
- **Effort**: S (~2-3hr).
  - First: capture a screen recording of the exact click → outcome the user is seeing. Without that we can't tell which of the three hypotheses applies.
  - If (1): add a visible inline "swarm paused — resume to add panes" pill next to the button so the reason shows without hover.
  - If (2): change single click to spawn the last-used provider directly, and reserve the dropdown for a chevron alongside (split-button pattern).
  - If (3): bubble the toast description into a persistent error chip in the pane header.
- **Defer to**: v1.4.2 first patch after v1.4.1 ships.

### DOGFOOD-V1.4.2-02 — Window responsiveness audit on pane re-adjustment
- **User quote** (2026-05-17): "Need to double check the window responsiveness, when panes are getting re-adjusted."
- **Surface**: `app/src/renderer/features/command-room/GridLayout.tsx` (divider drag) + `app/src/renderer/features/command-room/Terminal.tsx:174-217` (ResizeObserver + PTY resize IPC).
- **Investigation finding** (static read — needs perf trace to confirm):
  - The PTY resize path is already debounced sanely: `Terminal.tsx:215-217` clears the prior timer and reschedules `runFit` after 25ms; the first fit at non-zero dimensions runs synchronously; main-process `registry.resize` (`app/src/main/core/pty/registry.ts:239`) short-circuits on dead sessions. No obvious IPC flood.
  - The most plausible jank source is `GridLayout.startDrag` (`GridLayout.tsx:91-132`): the `pointermove` handler updates `colFracs` / `rowFracs` state synchronously on every move event without rAF throttling. At a 4×4 / 5×4 preset that triggers up to 20 simultaneous `ResizeObserver` callbacks per move event, each scheduling its own 25ms debounced `fit.fit()` + IPC roundtrip. The drag itself stays smooth (state update is cheap) but the post-release PTY catch-up can stutter as 12-20 fits land within a ~25ms window.
  - Window resize (dragging the OS window edge) only flows through ResizeObserver — there's no `window.addEventListener('resize', ...)` at the App or CommandRoom level. The Sidebar and BrowserViewMount have their own listeners but neither touches the pane grid. This is likely fine; ResizeObserver fires per cell so the per-pane fit cascade applies here too.
- **Risk areas not visible without runtime profile**:
  - Whether xterm.js `fit.fit()` reflow blocks the main thread at high cell counts.
  - Whether `pty.resize` IPC takes long enough to backpressure when 12-20 fire near-simultaneously.
  - Whether the CSS grid `transition-shadow` on each pane cell (line 159 of GridLayout) contributes to compositor lag during a drag.
- **Effort**: S (~2hr investigation, M (~4hr) if rAF-throttling the divider drag is the fix).
  - Capture a Chrome DevTools perf trace during: (a) OS window edge drag with 4 panes, 12 panes, 20 panes; (b) inter-pane divider drag at 4×3 and 5×4.
  - If `pointermove` handler shows up in scripting time, wrap `setColFracs/setRowFracs` in `requestAnimationFrame`.
  - If `fit.fit()` shows up in layout time, gate the per-cell ResizeObserver behind a 100ms debounce instead of 25ms during sustained resize bursts.
- **Defer to**: v1.4.2 first patch after v1.4.1 ships. Pair with DOGFOOD-V1.4.2-01 since both touch the Command Room top bar.

---

## P3 — polish

### Tooltip text "Coming in v1.2" on disabled pane icons
- **Surface**: PaneHeader (v1.1.4) — `Split` (Columns2) + `Minimise` (Minimize2) icons are visual-only placeholders with `disabled` + tooltip.
- **Issue**: V3 mockup showed both as functional. Today they're decoration.
- **Effort**: M (~1d each) — pane splitting needs sub-grid inside one cell; minimise needs collapse-to-footer-chip animation + state slice.
- **Defer to**: v1.2 (alongside notifications + V3 orange brand).

### Gemini pane resume — CLI lacks `--resume`
- **Surface**: `src/main/core/pty/resume-launcher.ts` + provider registry.
- **Issue**: Gemini CLI v0.41+ has no documented resume protocol. SigmaLink's resume launcher skips gemini panes (they respawn fresh on restart).
- **Effort**: External dependency — file an upstream gemini-cli issue. Until then, claude + codex panes resume; gemini doesn't.
- **Defer to**: when upstream lands `gemini --resume <session_id>`.

---

## v1.1.10 — provider registry cleanup → **Shipped & verified — v1.2.4**

> Moved to "Shipped & verified" 2026-05-13. The registry was trimmed to the
> five CLIs SigmaLink actually targets: Claude Code, Codex CLI, Gemini CLI,
> Kimi Code CLI, and OpenCode CLI. BridgeCode, Cursor Agent, Aider, Continue,
> and the user-facing "Shell" row were removed. The `'shell'` literal stays
> as an INTERNAL registry sentinel so the workspace launcher's "Skip — no
> agents" / "Custom Command" rows continue to route through `defaultShell()`
> without surfacing as a user-facing button.

### Final shipping registry (v1.2.4)

| Provider | Command | Install hint | Notes |
|---|---|---|---|
| Claude Code | `claude` (alt `claude.cmd`) | `npm i -g @anthropic-ai/claude-code` | Resume via `--resume` |
| Codex CLI | `codex` (alt `codex.cmd`) | `npm i -g @openai/codex` | Resume via `--resume` |
| Gemini CLI | `gemini` (alt `gemini.cmd`) | `npm i -g @google/gemini-cli` | No `--resume` upstream — panes respawn fresh |
| Kimi Code CLI | `kimi` (alt `kimi.cmd`) | "See moonshot.ai" (upstream npm package name pending) | No `--resume` confirmed yet — leave undefined |
| OpenCode CLI | `opencode` (alt `opencode.cmd`) | `npm i -g opencode` | — |

### What landed (file-by-file)

1. `app/src/shared/providers.ts` — dropped `bridgecode`, `cursor`, `aider`, `continue` registry rows; added `kimi`. `ProviderId` union narrowed accordingly. `'shell'` kept as internal sentinel and filtered out of `listVisibleProviders`.
2. `app/src/renderer/features/workspace-launcher/AgentsStep.tsx` — `MATRIX_ORDER` rewritten to `[claude, codex, gemini, kimi, opencode, custom]`; Droid + Copilot stubs deleted.
3. `app/src/renderer/features/swarm-room/RoleRoster.tsx` — `V3_PROVIDER_ORDER` + `DEFAULT_MODEL_BY_PROVIDER` rewritten to the 5-keep set.
4. `app/src/renderer/features/command-room/PaneHeader.tsx` + `PaneSplash.tsx` — `DEFAULT_MODELS` / `DEFAULT_MODEL_LABEL` lookup tables rewritten; BridgeCode / Cursor / Droid / Copilot rows dropped; Kimi added; OpenCode default model corrected (no longer mislabelled as Kimi K2.6 OpenRouter).
5. `app/src/renderer/features/onboarding/OnboardingModal.tsx` — welcome copy updated to "Claude Code, Codex, Gemini, Kimi, OpenCode"; BridgeCode "coming soon" lines were never present, no further changes.
6. `app/src/main/core/design/controller.ts` — `VALID_PROVIDERS` allowlist trimmed to `[claude, codex, gemini, kimi, opencode, shell, custom]`.
7. `app/src/main/core/pty/session-id-extractor.ts` — dropped `bridgecode` from `CLAUDE_PROVIDER_IDS`.
8. `app/src/main/core/providers/models.ts` — dropped `bridgecode-default` + `kimi-k2.6 (OpenRouter, under opencode)` model rows; added native `kimi-k2.6` row.
9. `app/src/main/core/plan/capabilities.ts` — dropped the `'bridgecode.access'` capability (no consumers).
10. `app/src/main/core/providers/__tests__/launcher.spec.ts` — `bridgecodeProvider` / `aiderProvider` fixtures renamed to `comingSoonStub` / `legacyStub` (synthetic — the shipping registry no longer carries those rows).
11. `app/src/main/core/assistant/tools.test.ts` — replaced `'bridgecode'` provider-id literal in the `list_active_sessions` fixture with synthetic `'future-cli'`.
12. `README.md` — Supported agents table rewritten to the 5-row v1.2.4 set; the "kimi-is-a-model-not-a-CLI" paragraph removed.
13. `docs/08-bugs/BACKLOG.md` (this entry) — moved to Shipped & verified.

### Out of scope (deferred — separate ticket)

- **Skills fanout / Ruflo verify** — Kimi MCP support is unverified upstream. `app/src/main/core/skills/fanout.ts`, `app/src/main/core/skills/types.ts`, and `app/src/main/core/ruflo/verify.ts` still hard-code `[claude, codex, gemini]`. File a follow-up once Kimi's `~/.kimi/` layout + MCP config behaviour is confirmed.
- **CHANGELOG / release notes** — handled by lead at release time.
- **Migration for historical agent_sessions** — the proposed kv-migration that rewrites stale `provider_id = 'bridgecode'|'cursor-agent'|'aider'|'continue'|'shell'` rows to `'claude'` was NOT shipped in this pass. The launcher tolerates unknown ids (creates an `error` session that the renderer surfaces) so users on a stale DB just see an error pane and pick a current provider; if real users surface, refile.

### Verification gates (2026-05-13)

- `pnpm exec tsc -b` — clean.
- `pnpm exec vitest run` — 205/205 pass.
- `pnpm exec eslint .` — clean.
- `pnpm exec vite build` — clean.
- `node --import tsx --test app/src/main/core/providers/__tests__/launcher.spec.ts` — 9/9 pass.
- Grep `bridgecode|cursor-agent|'aider'|'cursor'|'continue'` over `app/src` — zero hits.

---

## v1.1.9 — paired perf refactor

> Flagged by Phase-1 `perf-investigator` during the v1.1.8 swarm as "higher impact for sustained runtime, but better landed together". Deferred so v1.1.8 could ship cold-boot wins fast.

### `useAppStateSelector<T>` built on `useSyncExternalStore`
- **Surface**: `src/renderer/app/state.tsx` + `state.hook.ts` + 27 consumer files.
- **Issue today**: `useAppState()` returns `{ state, dispatch }` whose ref flips on every reducer call. 27 consumers re-render on EVERY dispatch (PTY exit, swarm message, browser state, 250ms snapshot timer, ephemeral UI flags). 24 of those destructure the full state.
- **Fix sketch**: New `useAppStateSelector<T>(sel, eq?)` built on `useSyncExternalStore` over a tiny event emitter the reducer fans out to. Keep `useAppState()` as a thin alias for migration; opt-in conversion of consumers over time.
- **2026-05-12 status**: Implemented additive `useAppStateSelector` + `useAppDispatch`; converted Command Room, Command Palette, Swarm Room, and Operator Console as the first high-churn consumer wave.
- **Effort**: M (~1d for the hook + emitter; +0.5d per consumer wave of conversions).
- **Risk**: Med — additive (old hook stays), but touches global state. Land alongside the precomputed slice work below for combined acceptance.

### Precomputed `sessionsByWorkspace` + `swarmsByWorkspace` slices
- **Surface**: `src/renderer/app/state.reducer.ts` + 4 consumer files (CommandRoom, CommandPalette, SwarmRoom, OperatorRoom).
- **Issue today**: Reducer rebuilds `Map(state.sessions)` on every `ADD_SESSIONS` / `MARK_SESSION_EXITED`. Four consumers run linear `sessions.filter(s => s.workspaceId === ...)` on every render. Combined with the selector issue above, that's O(N×consumers) wasted work per dispatch.
- **Fix sketch**: Add `sessionsByWorkspace: Record<string, AgentSession[]>` derived slice maintained by the reducer (rebuild on add/remove/exited). Same for `swarmsByWorkspace`. Consumers read the precomputed slice. Additive — old `state.sessions` array preserved.
- **2026-05-12 status**: Implemented and covered by reducer tests for add/exit/remove session paths and set/upsert/end swarm paths.
- **Effort**: S (~3hr).
- **Risk**: Low (additive).
- **Pair with**: `useAppStateSelector` above — together they eliminate the worst sustained-runtime overhead.

---

## v1.1.9 — quality / file size

### Split `swarms/factory.ts` (713 LOC)
- **Surface**: `src/main/core/swarms/factory.ts`.
- **Fix sketch**: Keep `createSwarm`, `addAgentToSwarm`, `listSwarmsForWorkspace`, `loadSwarm`, `killSwarm`, and the public `SwarmFactoryDeps` / `AddAgentToSwarm*` types. Move `spawnAgentSession` + `pickCoordinatorId` + `buildExtraArgs` + `loadAgentSession` into a new `factory-spawn.ts` (private). Target: factory.ts ≈ 380 LOC, factory-spawn.ts ≈ 330 LOC.
- **Effort**: M (~1d).
- **Risk**: Med — internal-API surface change; relies on the existing `factory.test.ts` (added in v1.1.8) plus the v1.1.4 swarm tests to guard.

### Split `runClaudeCliTurn.ts` (709 LOC)
- **Surface**: `src/main/core/assistant/runClaudeCliTurn.ts`.
- **Fix sketch**: Keep `runClaudeCliTurn`, `cancelClaudeCliTurn`, public types, `__reset*` test helpers. Move emit/persist helpers (`streamDelta`, `emitDelta`, `emitState`, `emitFinal`, `emitErrorFinal`, `persistFinal`, `createStdinWriter`, `withTimeout`) into `runClaudeCliTurn.emit.ts`. Trajectory helpers (`recordTrajectoryStep`, `endTrajectory`, `routeToolUse`, `traceToolUse`) into `runClaudeCliTurn.trajectory.ts`. Target: main ≈ 320 LOC.
- **Effort**: M (~1d).
- **Risk**: Med — guarded by `runClaudeCliTurn.test.ts` (830 LOC).

---

## v1.1.9 — CI / test infra

### CI workflow `cache-dependency-path` resolves to stale path
- **Surface**: `.github/workflows/lint-and-build.yml`, `e2e-matrix.yml`.
- **Issue**: 4 jobs fail at "Setup Node" because the cache-dependency-path points at a moved lockfile. Local gates all green. Tracked in v1.1.4 release notes, never fixed.
- **2026-05-12 status**: CI cache path now targets `app/package.json`; workflows install with `--no-frozen-lockfile` because this repo ignores `app/pnpm-lock.yaml`.
- **Effort**: XS (~30min) — update the path glob.
- **Risk**: Zero.

### Add `vitest run --coverage` + threshold
- **Surface**: `app/vitest.config.ts` + new CI job.
- **Issue**: 16 test files cover 17/55 main-process modules; the v1.1.8 swarm grew that to maybe 19/55, but no enforcement floor. Future regressions can silently drop coverage.
- **Fix sketch**: `@vitest/coverage-v8` is already bundled. Add baseline threshold (start lenient, e.g. 40% lines), upgrade quarterly. Expose `coverage/index.html` artifact in CI.
- **2026-05-12 status**: Added `pnpm run coverage` and an initial repo-wide ratchet matching the current baseline: 22% lines, 21% statements/functions, 18% branches.
- **Effort**: S (~2hr).
- **Risk**: Low — additive.
- **Source**: v1.1.8 `test-investigator` Win 2.

### Add `shellcheck` step for `app/scripts/install-macos.sh`
- **Surface**: CI workflow.
- **Issue**: today only `bash -n` syntax check guards the install script. `shellcheck` catches real lint (quoting, exit-code handling, etc.).
- **2026-05-12 status**: Added a CI step that installs ShellCheck on Ubuntu and checks `app/scripts/install-macos.sh`.
- **Effort**: Trivial (~10min) — single `shellcheck app/scripts/install-macos.sh` step.
- **Risk**: Zero.
- **Source**: v1.1.8 `test-investigator` finding.

---

## v1.1.9 — React-compiler lint wave

> 31 of the 32 remaining lint errors are React-compiler structural family. They need a dedicated wave because each fix can subtly change render behaviour; not non-breaking-line-edit territory.

| Family | Count | Notes |
|---|---|---|
| `react-hooks/set-state-in-effect` | 16 | Calls `setState` synchronously inside `useEffect`. Most can be replaced by `useMemo` derived state or moved to `useReducer`. |
| `react-hooks/immutability` | 8 | Reassigning props or mutating arrays/objects in renders. Each is a real correctness risk under React Compiler. |
| `react-hooks/exhaustive-deps` | 2 | Stale closure risks. Usually intentional — needs `useCallback` + dep audit. |
| `react-hooks/purity` | 1 | Side effect inside a render path. Hardest to refactor; usually a downstream signal. |
| `@typescript-eslint/no-var-requires` | 1 | One stray `require()` in a `.cjs` shim. |
| `@typescript-eslint/no-explicit-any` | 1 | Remaining `any` after the v1.1.8 cleanup (probably `shared/rpc.ts:5`). |

### Plan
1. Fix `no-var-requires` + `no-explicit-any` first (XS each).
2. Then `exhaustive-deps` + `purity` (S total).
3. Tackle `set-state-in-effect` in 3 sub-waves of ~5 each — easiest first (cached value derivations), hardest last (Composer.tsx + BridgeRoom).
4. `immutability` last — usually exposes deeper architecture issues.

**Total effort**: L (~3-5d sustained).

**2026-05-12 status**: `pnpm run lint` is clean on `codex/bug-backlog-pr`. The fixes cover the remaining `set-state-in-effect`, `purity`, `immutability`, `exhaustive-deps`, and `no-explicit-any` findings from this snapshot. The two canvas physics surfaces retain narrow lint disables for intentional per-frame mutable layout state.

---

## v1.1.10 — Playwright e2e refresh

> Surfaced during the v1.1.9 finalisation pass (2026-05-12). The v1.1.4 V3 visual parity layout broke several smoke-suite selectors; the v1.1.1 BRIDGE→SIGMA rebrand broke the assistant aria-label. The launch path itself now works after `node scripts/build-electron.cjs`, but the in-suite assertions are stale, so BUG-W7-000 cannot be re-verified end-to-end yet.

### Stale selectors in `tests/e2e/smoke.spec.ts`

- `aria-label="Bridge Assistant"` → should be `Sigma Assistant` (v1.1.1 rebrand).
- `Swarm Room` / `Operator Console` direct sidebar lookups → these moved into the top-left `RoomsMenuButton` dropdown in v1.1.4. Selectors need to open the dropdown first.
- `conversationsPanelCount > 0` expectation → the conversations panel surface changed in v1.1.4; assertion no longer matches the new layout.

### Plan

1. Inventory every selector in `tests/e2e/*.spec.ts` against the current `Sidebar` + `Breadcrumb` + `RoomsMenuButton` markup.
2. Replace direct nav lookups with `RoomsMenuButton`-opening flows.
3. Update aria-labels (`Bridge Assistant` → `Sigma Assistant`).
4. Re-verify BUG-W7-000 closure on a clean CI runner: `node scripts/build-electron.cjs` already unblocks the launch step locally; need to confirm in CI matrix.
5. Move BUG-W7-000 to the "Shipped & verified" table once the focused smoke passes a full sweep.

**Effort**: S (~1d) — selector audit + smoke rerun.
**Risk**: Low — test-only changes.

---

## v1.3 — platform / distribution

> v1.2.0 closed the Windows platform port at the unsigned-NSIS + PowerShell-installer + Web-Speech-fallback level. The items below are the next platform-distribution wave.

### Native Windows SAPI5 voice binding
- **Surface**: `src/main/core/voice/*` — currently macOS Speech.framework only (`native-mac.ts:107` gates non-darwin to `null`).
- **Issue**: Windows voice routes through Chromium's Web Speech API which requires internet (cloud STT via Google). Air-gapped or offline-first Windows users have no voice path.
- **Fix sketch**: Add `native-win.ts` calling SAPI5 via a small node-gyp binding (or off-the-shelf `node-microsoft-cognitiveservices-speech-sdk` for online + `whisper.cpp` for offline). Dispatcher contract is already platform-agnostic.
- **Effort**: L (~3-5d).
- **Defer to**: v1.3+.

### `windowsControlsOverlay` frameless chrome
- **Surface**: `electron/main.ts:235` currently sets `titleBarStyle: 'default'` (native frame) on win32. Breadcrumb pads 140px right to clear WCO.
- **Issue**: v1.2.0 ships with the native Windows frame for fastest landing. The 140px shim is cosmetically awkward and prevents drawing custom controls in the title bar region.
- **Fix sketch**: `webPreferences.titleBarOverlay` + `frame: false` + WCO-aware Breadcrumb. Adds non-trivial layout + a11y work.
- **Effort**: M (~1-2d).
- **Defer to**: v1.3+.

### EV/OV Authenticode certificate
- **Issue**: every v1.2.x EXE is unsigned. Users who download the EXE manually (not via the PowerShell installer's `Unblock-File` flow) see SmartScreen on first launch. SmartScreen reputation is per-binary-hash, so every release re-warms reputation from zero.
- **Cost**: EV cert $300-700/year (immediate reputation); OV cert $80-200/year (reputation accumulates over time).
- **Defer to**: indefinitely. Funded-only. Same gating as Apple Developer ID.

### Linux AppImage / .deb — wontfix (2026-05-16)
- **Status**: Closed as wontfix per user decision 2026-05-16. SigmaLink will not support Linux.
- **Historical context**: `electron-builder.yml` still has a `linux:` target block; local builds emit
  AppImage + .deb; no CI, no smoke, no installer, no docs. See `docs/03-plan/WISHLIST.md`
  "Architectural decisions" section.

### Microsoft Store / WinGet distribution
- **Issue**: GitHub Releases only as of v1.2.0. WinGet manifest needs the signed EXE; Microsoft Store needs the same plus identity validation.
- **Defer to**: after EV cert lands.

### Windows auto-update
- **Issue**: `autoUpdater` for Windows needs either signed Microsoft Store distribution or a self-hosted `electron-updater` differential feed.
- **Defer to**: after EV cert lands. Renderer toggle stays opt-in and macOS-only until then.

### Apple Developer ID + notarisation
- **Issue**: every v1.1.x DMG carries an ad-hoc signature (`scripts/adhoc-sign.cjs` from v1.1.5). On first Gatekeeper assessment of a browser-downloaded DMG, macOS surfaces "Apple could not verify SigmaLink..." — recoverable via `xattr -cr` or System Settings → Privacy & Security → Open Anyway, OR bypassed entirely via the v1.1.7 `curl | bash` installer. Real fix is notarisation.
- **Cost**: $99/year Apple Developer Program. No free tier. No open-source exception (FSFE petitioned Nov 2025; no movement).
- **Setup once funded**:
  1. Generate "Developer ID Application" cert via Apple Developer portal; export as .p12.
  2. CI secrets: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK` (base64-encoded .p12), `CSC_KEY_PASSWORD`.
  3. `electron-builder.yml`: `mac.identity: "Developer ID Application: <NAME>"`, `hardenedRuntime: true`, `notarize: true`.
  4. Drop `scripts/adhoc-sign.cjs` + `build/dmg/README — Open SigmaLink.txt` + `scripts/install-macos.sh` (no longer needed).
- **Bonus once shipped**: SigmaLink becomes eligible for Homebrew Cask submission (un-notarised casks removed by Sept 2026 anyway).

### x64 macOS DMG via CI matrix
- **Issue**: every v1.1.x release is arm64-only (Intel-Mac users stuck on v1.0.1). The current local build dance uses `--config.npmRebuild=false` + manual `electron-rebuild` against pinned Electron 30.5.1 — works for one arch at a time.
- **Fix sketch**: GitHub Actions matrix with macOS arm64 + macOS x64 runners, each rebuilding native modules for its arch, then `electron-builder` packs both into a fat DMG OR two arch-specific DMGs.
- **Effort**: M (~1d setup + debug).
- **Pair with**: notarisation (otherwise the x64 DMG hits the same Gatekeeper wall).

### `Split` + `Minimise` pane actions become functional
- **Surface**: PaneHeader (v1.1.4). Today disabled with "Coming in v1.2" tooltip — note the tooltip copy is now stale, will update when these ship.
- **Effort**: M (~1d each).
- **Risk**: Med — pane grid layout already complex; splitting needs sub-grid; minimise needs collapse-to-chip animation + state slice.

### Pane Focus → true fullscreen
- **Surface**: PaneHeader Focus icon (Target glyph).
- **Today**: clicking pins the focus ring on the active session; does NOT expand the pane to fill the grid.
- **Want**: clicking hides sibling panes and expands the active pane to fullscreen with Esc to restore. Same behaviour as `Cmd+Shift+F` keyboard shortcut.
- **Effort**: M (~1d) — needs a new `focusedPaneId` state in CommandRoom, sibling-hide CSS, Esc handler.
- **Defer to**: v1.3 alongside Split + Minimise functional implementations.

### Notifications system + bell in top-right
- **Surface**: top-right corner of Breadcrumb (v1.1.4 deferred). V3 BridgeMind showed a bell next to the settings gear; SigmaLink doesn't have one because no notification source exists yet.
- **Required first**: define what generates notifications (PTY exits? swarm broadcasts? Ruflo readiness changes? Sigma Assistant tool errors?). Then surface (bell badge → dropdown of recent items).
- **Effort**: L (~3d for source taxonomy + dropdown UI + persistence layer).

### v1.2.1 polish: replace `nsis.license` with custom NSIS welcome page
- **Surface**: `app/electron-builder.yml` (`nsis.license` field) + `app/build/nsis/README — First launch.txt`.
- **Issue**: v1.2.0 wired the welcome README via `nsis.license`, which renders the text behind a forced "I accept the terms of the License Agreement" radio gate. Semantically odd — it's a SmartScreen explainer, not a license.
- **Fix sketch**: `nsis.include: build/nsis/welcome.nsh` registering a custom MUI2 informational page (no radio gate, Next-only).
- **Effort**: S (~2-4hr).
- **Risk**: Low — installer-only.

---

## Waiting on external — needs funding

### "Hey Sigma" wake-word
- **Blocker**: Porcupine licensing forbids bundled key.
- **Options**:
  1. **Picovoice paid license** — ~$200/mo for 1k users. Bundled key OK.
  2. **whisper.cpp continuous mode** — open source, runs locally, but ~5% CPU per active wake-word listener.
  3. **OS-level integration** — macOS dictation + custom shortcut. No wake-word, but free.
- **Decision needed**: pick option 1, 2, or 3 once monetisation lands.

### Apple Developer Program ($99/year)
- Documented in [v1.2 platform](#v12--platform--distribution) above.

---

## Shipped & verified — v1.2.0 (Windows platform port, 2026-05-12)

Items moved from the former "v1.2 — platform / distribution" section into the Shipped column. Verified by code inspection 2026-05-12; Windows VM smoke deferred to first beta tag.

| Item | Shipping evidence |
|---|---|
| Windows NSIS installer build via CI on tag push | `.github/workflows/release-windows.yml` (70 LOC) runs on `v*` tag + `workflow_dispatch`, builds on `windows-latest`, uploads via `softprops/action-gh-release@v2`. |
| GitHub Release upload pipeline | Same workflow. `contents: write` permission; concurrency group `release-windows-${{ github.ref }}` with `cancel-in-progress: false`. |
| PowerShell one-liner installer (parity with curl-bash macOS) | `app/scripts/install-windows.ps1` (234 lines / ~180 LOC). PowerShell 5+ gate, AMD64 detect, `Invoke-RestMethod` to `/releases/latest` or `/releases/tags/<tag>`, picks `SigmaLink-Setup-*.exe`, `Unblock-File` strips MOTW, `Start-Process`. Params: `-Version`, `-Quiet`, `-KeepInstaller`. |
| SmartScreen workaround docs | `app/build/nsis/README — First launch.txt` (72 lines) wired via `nsis.license` in `app/electron-builder.yml`. Two recovery paths documented: Option A "More info → Run anyway"; Option B right-click → Properties → Unblock. |
| Cascadia Mono terminal font on Windows | `app/src/renderer/features/command-room/Terminal.tsx:112` prepended to xterm fontFamily stack ahead of Consolas. |
| VoiceTab platform-aware copy | `app/src/renderer/features/settings/VoiceTab.tsx` — `NATIVE_ENGINE_LABEL` reads "Web Speech API (Chromium, requires internet)" on non-darwin; diagnostics dot grey neutral, not red error. |
| Native frame WCO clearance | `app/src/renderer/features/top-bar/Breadcrumb.tsx` — conditional 140px right-padding on win32 via new `IS_WIN32` helper from `app/src/renderer/lib/platform.ts`. |
| ia32 dropped, x64 only | `app/electron-builder.yml` — `win.target.nsis.arch: [x64]`. ia32 actively removed. |
| NSIS icon set wired | `app/electron-builder.yml` — `installerIcon`, `uninstallerIcon`, `installerHeaderIcon` all pointing at `build/icon.ico`. |
| Renderer platform helper | `app/src/renderer/lib/platform.ts` (NEW, 12 LOC) — `getPlatform()` + `IS_WIN32`. |
| `window.sigma.platform` exposure | `app/electron/preload.ts` — added `platform: process.platform`. |
| Historic Windows `.cmd` shim spawn bug closed | `docs/01-investigation/01-known-bug-windows-pty.md` marked RESOLVED. Cites `app/src/main/core/pty/local-pty.ts:47-85` (`resolveWindowsCommand`), `:175-197` (wrap), `:215-230` (pre-flight ENOENT). |
| 2 new test files | `Breadcrumb.test.tsx` + `VoiceTab.test.tsx` — 9 new cases. Repo total 196 → **205/205**. |
| v1.2.0 design doc | `docs/04-design/windows-port.md` (NEW). |

---

## Shipped & verified — closed entries in OPEN.md

These OPEN.md entries still show `**Status**: open` but were resolved by their named version. Verified via release notes + commit history at v1.1.8 (commit `74d33e4`). OPEN.md will be cleaned up in v1.1.9.

| Entry | Closed in | Shipping evidence |
|---|---|---|
| BUG-V1.1.1-01 launch_pane PTY spawn | v1.1.2 | `tools.ts` wired to factory; v1.1.2 release notes |
| BUG-V1.1.1-02 list_active_sessions | v1.1.2 | tools.ts list_* tools added |
| BUG-V1.1.1-03 inter-agent broadcast | v1.1.2 | mailbox group-broadcast fix |
| BUG-V1.1.1-04 Ruflo MCP auto-connect | v1.1.3 | mcp-autowrite + Ruflo supervisor.ensureStarted |
| BUG-V1.1.2-01 Sigma dispatch dead-letter | v1.1.2-rev3 | `mcp-host-server.cjs` MCP stdio bridge |
| BUG-V1.1.2-02 session state not persisted | v1.1.2 | session-restore.ts minimum-viable; v1.1.3 multi-workspace extension |
| BUG-V1.1.3-01 BRIDGE → SIGMA label | v1.1.3 | ChatTranscript.tsx:26 `assistant: 'SIGMA'` |
| BUG-V1.1.3-02 destructive workspace switch | v1.1.3 | `openWorkspaces[]` state model |
| BUG-V1.1.3-03 workspaces don't restore | v1.1.3 | SessionSnapshotSchema array of workspaces |
| BUG-V1.1.3-04 PTY panes don't resume | v1.1.3 | session-id-extractor + resume-launcher |
| BUG-V1.1.3-05 swarm count locked | v1.1.3 | swarms.addAgent RPC + `add_agent` Sigma tool |
| BUG-V1.1.3-06 Ruflo lazy + unverified | v1.1.3 | rufloSupervisor.ensureStarted + verifyForWorkspace |
| BUG-V1.1.3-07 skills not verified per-CLI | v1.1.3 | skillsManager.verifyFanoutForWorkspace |
| BUG-V1.1.4-A "damaged" Gatekeeper verdict | v1.1.5 | scripts/adhoc-sign.cjs |
| BUG-V1.1.5-A unverified-developer dialog | v1.1.7 (curl-bash bypass) + v1.1.6 (in-DMG README) | |
| Bundle bloat (97 KB gzip) | v1.1.8 | React.lazy() room split |
| pty:data 32-listener fan-out | v1.1.8 | renderer/lib/pty-data-bus.ts |
| 3 stub schemas | v1.1.8 | rpc/schemas.ts promoted to real zod |
| Dead `utils.ts` exports | v1.1.8 | parseAnsi/mockPTYBridge/generateId/formatDuration deleted |
| 6 NMV-blocked tests | v1.1.8 | vi.mock pattern + src/test-utils/db-fake |

---

## How to use this doc

- **Filing a new bug**: add it to [`OPEN.md`](OPEN.md) using the format at the top of that file; reference it here in the next v1.1.x sweep.
- **Picking work for the next release**: start with `## v1.1.9` sections, ordered by effort-to-impact. Tag the release notes file with the BACKLOG.md entries it closes.
- **Updating this doc**: after each release, move the closed items from their P0..P3 / v1.1.x section into "Shipped & verified" with a row in the table.
- **Long-term planning**: the `## Waiting on external` items only unblock when funding / external CLI updates land. Don't put effort there until the blocker is resolved.
