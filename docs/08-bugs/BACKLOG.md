# SigmaLink Backlog — Open Bugs + Optimization Targets

> Snapshot at **v1.5.2** (2026-05-20).
> Latest sweep: 2026-05-20 v1.5.2 — closed DOGFOOD-V1.4.2-01 + -02 (former was UX work in v1.5.2; latter was already shipped in v1.4.2 packet-07 and BACKLOG was stale) + **critical v1.5.0 cross-sync renderer regression hotfix** (8 `sync.*` IPC channels absent from CHANNELS allowlist since v1.5.0 packet 09).
> v1.5.1 catch-up sweep (2026-05-20): closed ~14 stale items across v1.3 platform / v1.1.9 perf+quality+lint / P3 polish / BUG-W7-000. See [v1.4.x + v1.5.x catch-up](#shipped--verified--v14x--v15x-catch-up-sweep-2026-05-20).
> Bug ledger details live in [`OPEN.md`](OPEN.md); the v1.1.1 / v1.1.2 / v1.1.3 entries there are CLOSED — see "Shipped & verified" at the bottom of this file. `DEFERRED.md` is currently empty.
> History: v1.1.8 (5-coder optimization swarm, bundle -61% gzip), v1.1.9 (perf + lint 0/0), v1.1.10 (Gemini P1), v1.1.11 (Kimi P1 + state-hook), v1.2.0 (Windows port), v1.2.4 (auto-update), v1.2.5 (post-install sweep), v1.2.6 (browser MCP stdio), v1.2.7 (multi-workspace state), v1.2.8 (session-capture rewrite), v1.3.x (W-1/W-3 session picker + Ruflo auto-bind), v1.4.0 (Sigma orchestrator), v1.4.1 (Bridge→Sigma rename), v1.4.2 (stability + Windows compat), v1.4.3 (Gemini bridge + Pane Split/Minimise), v1.4.4 (paper-cut sweep), v1.4.5 (tech-debt + file splits), v1.4.6 (frameless chrome + x64 voice + CI hardening), v1.4.7 (CI fully green + OpenCode SQLite fast path), v1.4.8 bundle (Sessions A/B/C = #45-#54), v1.4.9 (notifications + voice mac + provider auto-install), v1.5.0 (cross-machine sync + voice Win/Linux + SAPI5), v1.5.1 (cleanup packet — wishlist closed).

## Index

| Bucket | Count | Lives where |
|---|---|---|
| P0 critical | 0 | — |
| P1 functional bugs | 0 | — |
| P2 functional bugs / UX | 0 | DOGFOOD-V1.4.2-01 closed v1.5.2 (visibility pill + error chip); DOGFOOD-V1.4.2-02 closed v1.4.2 packet-07 (rAF coalescing — BACKLOG was stale, confirmed by v1.5.2 Cluster A investigation) |
| P3 polish | 0 | — (Tooltip "Coming in v1.2" closed v1.4.3; Gemini resume closed v1.4.3 #01) |
| Provider registry cleanup | 0 (shipped v1.2.4) | [v1.1.10 providers](#v1110--provider-registry-cleanup--shipped--verified--v124) |
| Perf — sustained runtime | 0 (shipped v1.1.9 + v1.4.5) | — |
| Quality — refactor | 0 (factory.ts + runClaudeCliTurn.ts split v1.4.5) | — |
| Tests / CI | 0 (smoke refresh v1.4.6 + v1.4.7) | — |
| Platform / distribution | 3 funded-only (EV cert + WinGet + Microsoft Store) | [v1.3 platform](#v13--platform--distribution) — Apple Dev ID dropped 2026-05-18; Linux wontfix 2026-05-16 |
| Lint — React-compiler family | 0 (closed v1.4.5) | — |
| Funded-only (EV cert, WinGet, Microsoft Store, Porcupine) | 4 | [Waiting on external](#waiting-on-external--needs-funding) |
| v1.5.2 latent caveats (none ship-critical) | 11 | [WISHLIST.md v1.5.2 backlog](../03-plan/WISHLIST.md) |
| V3-W15-006 dogfood (HUMAN QA) | 1 | [WISHLIST.md v1.5.2 backlog](../03-plan/WISHLIST.md) |

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

### ~~BUG-W7-000 — Test-runner reports "Electron app failed to launch" intermittently~~ — **Shipped & verified — v1.4.6 + v1.4.7**
- **Surface**: `tests/e2e/*.spec.ts` against a fresh kv install.
- **Closed by**: v1.4.6 Playwright smoke refresh (4 navTo selector fixes + 1 stale-args assertion) + v1.4.7 e2e cleanup (3 deferred from PR #36 Followup-2 + 2 pre-existing timeouts).
- **Final state (v1.4.7)**: 11 e2e tests, 0 fail, 3 documented skips.
- **Source**: [`OPEN.md`](OPEN.md) → BUG-W7-000 (entry stays for historical context).

---

## v1.4.2 — dogfood items (2026-05-17, opened) → **Both Shipped & verified by v1.5.2 (2026-05-20)**

### ~~DOGFOOD-V1.4.2-01 — "+ Pane" button reported as not working~~ — Shipped & verified v1.5.2 (#59)
**Closed by**: hypothesis 1 + 3 fixes — visibility pill `data-testid="add-pane-disabled-reason"` renders alongside disabled button (replaces hover-only tooltip); persistent error chip `data-testid="add-pane-error-chip"` for 10s on `addAgentToSwarm` rejection with × dismiss + unmount cleanup. Hypothesis 2 (split-button) deferred — needs UX call. Historical investigation preserved below.

### ~~DOGFOOD-V1.4.2-02 — Window responsiveness audit on pane re-adjustment~~ — Shipped & verified v1.4.2 packet-07 (BACKLOG was stale)
**Closed by**: GridLayout `startDrag` already implements rAF coalescing (`pendingRaf`/`latest`/`flush` pattern) from v1.4.2 packet-07. v1.5.2 Cluster A investigation confirmed via grep + existing test suite. Original BACKLOG entry was stale. Historical investigation preserved below.

### Historical entries for context

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

### ~~Tooltip text "Coming in v1.2" on disabled pane icons~~ — **Shipped & verified — v1.4.3 (#06)**
- **Surface**: PaneHeader Split + Minimise icons.
- **Closed by**: v1.4.3 #06 — Pane Split (H/V) + Pane Minimise are now functional. Tooltip copy refreshed at the same change.

### ~~Gemini pane resume — CLI lacks `--resume`~~ — **Shipped & verified — v1.4.3 (#01)**
- **Surface**: `src/main/core/pty/resume-launcher.ts` + provider registry.
- **Closed by**: v1.4.3 #01 — `projects.json` alias bridge unblocks gemini in per-pane worktrees. Resume launcher now threads gemini panes correctly (workspace-slug ↔ worktree-slug symlink, parallel to Claude bridge).

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

## v1.1.9 — paired perf refactor → **Shipped & verified — v1.1.9 (then re-verified through v1.4.5)**

> Both items shipped in v1.1.9. Re-verified clean in v1.4.5 tech-debt sweep. Detailed records preserved below for historical context.

### ~~`useAppStateSelector<T>` built on `useSyncExternalStore`~~ — Shipped v1.1.9
- **Surface**: `src/renderer/app/state.tsx` + `state.hook.ts` + 27 consumer files.
- **Issue today**: `useAppState()` returns `{ state, dispatch }` whose ref flips on every reducer call. 27 consumers re-render on EVERY dispatch (PTY exit, swarm message, browser state, 250ms snapshot timer, ephemeral UI flags). 24 of those destructure the full state.
- **Fix sketch**: New `useAppStateSelector<T>(sel, eq?)` built on `useSyncExternalStore` over a tiny event emitter the reducer fans out to. Keep `useAppState()` as a thin alias for migration; opt-in conversion of consumers over time.
- **2026-05-12 status**: Implemented additive `useAppStateSelector` + `useAppDispatch`; converted Command Room, Command Palette, Swarm Room, and Operator Console as the first high-churn consumer wave.
- **Effort**: M (~1d for the hook + emitter; +0.5d per consumer wave of conversions).
- **Risk**: Med — additive (old hook stays), but touches global state. Land alongside the precomputed slice work below for combined acceptance.

### ~~Precomputed `sessionsByWorkspace` + `swarmsByWorkspace` slices~~ — Shipped v1.1.9
- **Surface**: `src/renderer/app/state.reducer.ts` + 4 consumer files (CommandRoom, CommandPalette, SwarmRoom, OperatorRoom).
- **Issue today**: Reducer rebuilds `Map(state.sessions)` on every `ADD_SESSIONS` / `MARK_SESSION_EXITED`. Four consumers run linear `sessions.filter(s => s.workspaceId === ...)` on every render. Combined with the selector issue above, that's O(N×consumers) wasted work per dispatch.
- **Fix sketch**: Add `sessionsByWorkspace: Record<string, AgentSession[]>` derived slice maintained by the reducer (rebuild on add/remove/exited). Same for `swarmsByWorkspace`. Consumers read the precomputed slice. Additive — old `state.sessions` array preserved.
- **2026-05-12 status**: Implemented and covered by reducer tests for add/exit/remove session paths and set/upsert/end swarm paths.
- **Effort**: S (~3hr).
- **Risk**: Low (additive).
- **Pair with**: `useAppStateSelector` above — together they eliminate the worst sustained-runtime overhead.

---

## v1.1.9 — quality / file size → **Shipped & verified — v1.4.5**

### ~~Split `swarms/factory.ts` (713 LOC)~~ — Shipped v1.4.5
- Closed by factory.ts 443→271 LOC + new factory-add-agent.ts sibling.

### ~~Split `runClaudeCliTurn.ts` (709 LOC)~~ — Shipped v1.4.5
- Closed by runClaudeCliTurn.ts 426→324 LOC + new runClaudeCliTurn.args.ts sibling.

---

---

## v1.1.9 — React-compiler lint wave → **Shipped & verified — v1.1.9 (re-verified v1.4.5)**

> Closed in v1.1.9. Re-verified clean in v1.4.5: "React-compiler lint wave found already closed by v1.1.9 work — no action needed." Current ESLint state: 0 errors, 1 pre-existing exhaustive-deps warning in `use-session-restore.ts:277` (intentional — wsId dep would re-fire snapshot timer).

### Historical record (v1.1.9 sweep)

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

## v1.1.10 — Playwright e2e refresh → **Shipped & verified — v1.4.6 + v1.4.7**

> Closed by v1.4.6 Playwright smoke refresh (4 navTo selector fixes + 1 stale-args assertion) + v1.4.7 e2e cleanup (5 tests closed: 3 deferred from PR #36 Followup-2 + 2 pre-existing timeouts). BUG-W7-000 closed at the same time. Final state: 11 e2e tests, 0 fail, 3 documented skips. Historical record below.

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

> v1.2.0 closed the Windows platform port at the unsigned-NSIS + PowerShell-installer + Web-Speech-fallback level. Most of this wave shipped piecemeal across v1.4.x-v1.5.0. **The 3 remaining items are funded-only** (EV cert, Microsoft Store, WinGet) — see [Waiting on external](#waiting-on-external--needs-funding).

### ~~Native Windows SAPI5 voice binding~~ — **Shipped & verified — v1.5.0 (#53)**
- Closed by `@sigmalink/voice-win` native module: `CLSID_SpSharedRecognizer` + STA worker + Win32 message pump + hidden `HWND_MESSAGE` + `SetNotifyWindowMessage(WM_APP+1)`. v1.5.1 further refactored Sleep(50) → event-signal + IsAvailable async + napi cleanup hook.

### ~~`windowsControlsOverlay` frameless chrome~~ — **Shipped & verified — v1.4.6 (#33)**
- Closed by cross-platform `titleBarStyle: 'hidden'` everywhere with WCO insets. The 140px shim is gone; Breadcrumb is fully WCO-aware.

### EV/OV Authenticode certificate — **STILL OPEN (funded-only)**
- Cost: $300-700/yr (EV) or $80-200/yr (OV). Documented in [Waiting on external](#waiting-on-external--needs-funding).
- Workaround in place: `app/build/nsis/README — First launch.txt` documents SmartScreen recovery; PowerShell installer auto-`Unblock-File`s.

### Linux AppImage / .deb — **WONTFIX (2026-05-16)**
- Closed as wontfix per user decision. SigmaLink ships macOS arm64 + Windows x64 only. `electron-builder.yml` still has a `linux:` target block for local-build completeness, but no CI, no smoke, no docs.

### Microsoft Store / WinGet distribution — **STILL OPEN (gated on EV cert)**
- Cannot proceed until EV cert lands.

### ~~Windows auto-update~~ — **Shipped & verified — v1.4.8 (#45)**
- Closed by `electron-updater` differential feed via GitHub Releases (no Microsoft Store needed). UAC-denied fallback + warning copy. Opt-in toggle in Settings → Updates.

### Apple Developer ID + notarisation — **DROPPED 2026-05-18**
- User decision: not selling, won't pay $99/yr. Ad-hoc signing + Gatekeeper README workaround remain canonical.

### ~~x64 macOS DMG via CI matrix~~ — **Shipped & verified — v1.4.6 (#34)**
- Closed by Electron-ABI rebuild in all CI lanes (was rebuilding host Node ABI, root cause of CI red since v1.4.3). Intel-Mac users now get x64 DMG with Speech.framework binding bundled.

### ~~`Split` + `Minimise` pane actions become functional~~ — **Shipped & verified — v1.4.3 (#06)**
- Closed by Pane Split (H/V) + Pane Minimise functional.

### ~~Pane Focus → true fullscreen~~ — **Shipped & verified — v1.4.2 (#12)**
- Closed by `focusedPaneId` state + sibling-hide CSS + Esc handler.

### ~~Notifications system + bell in top-right~~ — **Shipped & verified — v1.4.9 (#51)**
- Closed by migration 0018 + 4-level severity taxonomy (info/warn/error/critical) + dedup 30s + IPC delta-only + OS-notification opt-in. v1.5.1 added soft-cap collapse (D2) + deep-link navigation (D5).

### ~~v1.2.1 polish: replace `nsis.license` with custom NSIS welcome page~~ — **Shipped & verified — v1.4.2 (#11)**
- Closed by `nsis.include: build/nsis/welcome.nsh` + custom MUI2 informational page (no radio gate).

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

## Shipped & verified — v1.4.x + v1.5.x catch-up sweep (2026-05-20)

Catch-up audit covering items that shipped piecemeal across v1.3.x-v1.5.1 but were never moved out of their stale "planned" sections above. CHANGELOG and master_memory are the authoritative source of truth; this table indexes which CHANGELOG entry closed each row.

### v1.3.x — picker + Ruflo (2026-05-16)

| Item | Closed in | Evidence |
|---|---|---|
| Session picker in Workspace Launcher (W-1) | v1.3.0 | `Launcher.tsx` per-pane chip + smart default + bulk bar + Scenario B pre-population |
| `pane_index` migration race | v1.3.1 | migration 0012 dedup + Launcher top-level `paneResumePlan` |
| Claude resume across worktrees | v1.3.2 + v1.3.4 | `claude-resume-bridge` symlink + workspace-slug ↔ worktree-slug + per-pane cwd mapping |
| Workspace switching → Command Room | v1.3.3 | reducer-level per-workspace room recall |
| Claude blank-pane silent-exit | v1.3.3 | visible error UI within 1.5s |
| Session-restore snapshot timer no-op cancels | v1.3.3 | timer guard |
| Ruflo MCP auto-bind for 5 CLIs (W-3) | v1.3.5 | canonical `mcp start` args + self-heal on next openWorkspace + readiness pill |

### v1.4.x — feature wave (2026-05-16..2026-05-19)

| Item | Closed in | Evidence |
|---|---|---|
| Sigma Assistant session resume (W-2) | v1.4.0 | Claude `system.init` capture + `--resume` chaining + retry-once stale-id fallback + right-rail pill |
| Bridge → Sigma rename | v1.4.1 | mailbox back-channel (`sigma_pane_events`, `monitor_pane`, `assistant:pane-event`); SigmaRoom 922→283 LOC split |
| Windows spawn ENOENT | v1.4.2 #01 | `resolveWindowsCommand` |
| Settings blocks workspace routing | v1.4.2 #02 | route deflection |
| xterm preservation | v1.4.2 #03 | retention across workspace switch |
| Worktree location UX | v1.4.2 #06 | path normalisation |
| Disk-scan workspace scoping | v1.4.2 #10 | scoped externalSessionScan |
| NSIS welcome page | v1.4.2 #11 | custom MUI2 informational page |
| Pane Focus fullscreen | v1.4.2 #12 | `focusedPaneId` + sibling-hide CSS + Esc |
| rAF resize coalesce | v1.4.2 #07 | divider drag throttling |
| state.tsx verify-close | v1.4.2 #08 | dispose audit |
| shellcheck CI fix | v1.4.2 #24 | macOS runner fix |
| Gemini resume bridge | v1.4.3 #01 | `projects.json` alias bridge |
| Workspace pane state persistence | v1.4.3 #02 | `panes.listForWorkspace` RPC + ADD_SESSIONS dispatch |
| Stale `status=running` cleanup | v1.4.3 #03 | migration 0016 marks > 24h-old as exited |
| Orphan worktree cleanup | v1.4.3 #04 | cleanup on workspace open |
| Pane Split + Pane Minimise functional | v1.4.3 #06 | sub-grid + collapse-to-chip + state slice |
| Inline "+ Add first pane" in EmptyState | v1.4.3 #05 | CommandRoom EmptyState |
| 7 reviewer followups | v1.4.4 | F-1..F-4 + INFO + LOW closures |
| Playwright smoke navTo refresh | v1.4.4 | v1.1.4+ Rooms dropdown selector update |
| proper-lockfile race fix | v1.4.5 | PR27 F-2 v1.4.5 followup |
| SessionStep flake closure | v1.4.5 | `vi.resetModules` v1.4.5 followup |
| factory.ts 443→271 LOC split | v1.4.5 | new factory-add-agent.ts sibling |
| runClaudeCliTurn.ts 426→324 LOC split | v1.4.5 | new runClaudeCliTurn.args.ts sibling |
| Frameless chrome cross-platform | v1.4.6 #33 | titleBarStyle:'hidden' + WCO insets |
| x64 macOS Speech.framework binding | v1.4.6 #34 | Intel DMG carries voice-mac |
| Electron-ABI rebuild in CI lanes | v1.4.6 | root cause of CI red since v1.4.3 |
| Parchment contrast (BUG-W7-015) | v1.4.6 | WCAG AA verify |
| Terminal snapshot race (R-1.2.7-1) | v1.4.6 | regression test added |
| Vitest coverage thresholds verified | v1.4.6 | thresholds met |
| Playwright smoke refresh | v1.4.6 | 4 navTo selector fixes + 1 stale-args assertion |
| 5 e2e tests closed | v1.4.7 | 3 deferred from PR #36 + 2 pre-existing timeouts |
| `panes.listForWorkspace` channel allowlist gap | v1.4.7 #37 | production regression fix (rehydration silently broken since v1.4.3) |
| OpenCode SQLite direct read | v1.4.7 #39 | session picker cold-start ~400ms → <100ms |

### v1.4.8 bundle — Sessions A/B/C (2026-05-20, single working day)

| Item | Closed in | Evidence |
|---|---|---|
| Drag-drop file → pane `@-mention` | v1.4.8 #48 | Session A Packet 03 |
| Sidebar resize handles (IDE Editor + main Sidebar) | v1.4.8 #47 | Session A Packet 02; kv persistence |
| Browser EmptyState + `about:` normalization | v1.4.8 #46 | Session A Packet 01 |
| Windows auto-update + UAC denied fallback | v1.4.8 #45 | Session A Packet 05; warning copy |
| Global voice capture macOS | v1.4.9 #50 | Session B Packet 04; Cmd+Option+Space + Tray + pane-focus-aware paste via NSWorkspace |
| Provider auto-install with consent gating | v1.4.9 #49 | Session B Packet 06; `providers.spawnInstall` RPC + ProviderInstallModal |
| Notifications + top-right bell | v1.4.9 #51 | Session B Packet 07; migration 0018 + 4-level severity + dedup 30s + IPC delta + OS-notification opt-in |
| Cross-machine session sync (e2ee, opt-in, git-backed) | v1.5.0 #54 | Session C Packet 09; migration 0019; libsodium XChaCha20-Poly1305 + AAD; HLC + LWW; BIP-39 mnemonic; isomorphic-git transport; `credentials` HARD-DENY |
| Voice capture Windows + Linux fan-out | v1.5.0 #52 | Session C Packet 04-Win+Linux; Ctrl+Alt+Space + Tray + clipboard-only |
| Native Windows SAPI5 voice binding | v1.5.0 #53 | Session C Packet 08; `@sigmalink/voice-win` via CLSID_SpSharedRecognizer + STA worker + Win32 message pump |

### v1.5.2 — Cleanup packet + critical v1.5.0 cross-sync renderer hotfix (2026-05-20)

| Item | Closed in | Evidence |
|---|---|---|
| **🚨 v1.5.0 cross-sync renderer regression** — `sync.*` IPC channels absent from CHANNELS allowlist since v1.5.0 packet 09; preload hard-rejected with error banners; Settings → Sync + SetupWizard + pending_upgrade badge ALL unreachable from renderer for ~14hr between v1.5.0 and v1.5.2 ship | v1.5.2 #60 | 8 channels added to `rpc-channels.ts` CHANNELS set 1:1 with `syncCtl` methods (controller.ts:38-74); reviewer-pr60 verified no over-exposure, no missing entries |
| DOGFOOD-V1.4.2-01 +Pane button defensive UX | v1.5.2 #59 | hypothesis 1 visibility pill `data-testid="add-pane-disabled-reason"` + hypothesis 3 persistent error chip `data-testid="add-pane-error-chip"` (10s timer + dismiss × + unmount cleanup) |
| DOGFOOD-V1.4.2-02 GridLayout responsiveness (already shipped v1.4.2 #07; BACKLOG stale) | v1.5.2 confirmation | rAF coalescing pattern in startDrag (`pendingRaf`/`latest`/`flush`) verified intact |
| v1 legacy decrypt round-trip test | v1.5.2 #58 | 2 new crypto.test.ts cases — positive round-trip (full discriminated-union shape assertion) + tampered-byte AEAD-integrity negative; uses libsodium directly to construct real v1 wire blob |
| STAThreadState heap-leak guard on CreateThread NULL | v1.5.2 #58 | recognizer.cc — CloseHandle(ready) + delete state before failure return; symmetric to success-path teardown |
| `browser-view-mount` production testid | v1.5.2 #58 | added to BrowserViewMount.tsx wrapper div |
| Engine-level integration tests for v2/skew/allowlist/anonymise | v1.5.2 #60 | 4 new tests in engine-integration.test.ts using real crypto (not mocked) + MockDb covering engine SQL patterns |
| Column allowlist drift detector | v1.5.2 #60 | allowlist-drift.test.ts via Drizzle's `getTableColumns().col.name`; 0 drift found across 19 synced tables |
| `sync_pending_upgrade` count visibility | v1.5.2 #60 | existing badge in SyncTab.tsx now reachable (was blocked by absent CHANNELS entry) |

### v1.5.1 — Cleanup packet (2026-05-20)

| Item | Closed in | Evidence |
|---|---|---|
| ~28 deferred caveats from Sessions A/B/C | v1.5.1 #55+#56+#57 | 3 cluster PRs + Opus reviewer round + lead-fold-then-merge |
| `CommandRoom.tsx` 878 → 483 LOC | v1.5.1 #55 | PaneShell + SplitGroupCell extractions |
| `normalizeUrl` / `insertMention` / `pathRelative` test-import refactor | v1.5.1 #55 | extracted to sibling files |
| `MnemonicConfirm` drag-drop bypass | v1.5.1 (3717e9e reviewer fold) | onDrop + onDragOver preventDefault |
| `BrowserViewMount` flex-row layout regression | v1.5.1 (3717e9e reviewer fold) | display:none on placeholder when !visible |
| `whisper.cpp` submodule registered properly | v1.5.1 #56 | v1.7.4 canonical ggml-org URL |
| Real whisper.cpp model SHA-256 hashes (4 sizes) | v1.5.1 #56 | HuggingFace LFS verified |
| `PcmAccumulator` AVAudioEngine PCM tap wire-up | v1.5.1 #56 | voice-mac installTap export |
| SAPI5 Sleep(50) → Win32 event-signal | v1.5.1 #56 | CreateEventW auto-reset + bounded WaitForSingleObject |
| SAPI5 IsAvailable() async | v1.5.1 #56 | WM_SAPI_PROBE + TSFN |
| SAPI5 napi_add_env_cleanup_hook | v1.5.1 #56 | bounded shutdown wait |
| proper-lockfile sync push/pull guard | v1.5.1 #57 | realpath:false + finally-release |
| Sync "anonymise paths" Settings toggle | v1.5.1 #57 | `kv['sync.anonymisePaths']` |
| Crypto wire format v1 → v2 (backward-compat) | v1.5.1 #57 | _schema OUTSIDE AAD; v1 decoder preserved |
| SQL column allowlist defense-in-depth | v1.5.1 #57 | 19 per-table allowlists |
| Notifications D2 soft-cap collapse | v1.5.1 #57 | 200-per-(workspace,kind) → oldest 50 → summary row |
| Notifications D5 deep-link nav | v1.5.1 #57 | source-specific routing + missing-pane fallback |
| `CRITICAL_TOOL_NAMES` expansion | v1.5.1 #57 | DB-mutating tools covered |
| PowerShell → N-API foreground detection | v1.5.1 #57 | uses Cluster B's `getFrontmostAppExePath` |
| Completion ding Settings toggle (V3-W13-015) | v1.5.1 paper-cut fold | `notifications.ding` kv exposed in NotificationsSettings.tsx |
| 3 native prebuild workflows soft-failed | v1.5.1 (04b3b41 + 33af93a) | continue-on-error on build + if-no-files-found:warn |

### V3 parity audit closure (2026-05-20)

| Bucket | Count | Status |
|---|---|---|
| V3-W12-001..018 (Wave 12) | 18 | 4 obsoleted (by v1.2.4 cleanup); 14 shipped-verified |
| V3-W13-001..015 (Wave 13) | 15 | 13 shipped-verified; W13-013 partial (dispatchBulk/refResolve = feature-enhancement, deferred); W13-015 folded into v1.5.1 |
| V3-W14-001..009 (Wave 14) | 9 | All shipped-verified |
| V3-W15-001..007 (Wave 15) | 7 | 5 shipped-verified; W15-004 superseded by Linux-not-supported ADR; W15-006 unfinished (human dogfood, not codeable) |

Net: 35 shipped + 4 obsoleted + 3 partial handled + 1 human-only unfinished = wishlist closed.

### Funded-only items still open

| Item | Cost | Status |
|---|---|---|
| EV/OV Authenticode cert | $300-700/yr (EV) | Funded-only |
| Microsoft Store / WinGet distribution | M setup + EV cert prereq | Gated on EV cert |
| Apple Developer ID + notarisation | ~~$99/yr~~ | **Dropped 2026-05-18** — not selling, ad-hoc signing + Gatekeeper README workaround remain canonical |
| Picovoice Porcupine "Hey Sigma" wake-word | ~$200/mo for 1k users | Funded-only |

---

## How to use this doc

- **Filing a new bug**: add it to [`OPEN.md`](OPEN.md) using the format at the top of that file; reference it here in the next v1.1.x sweep.
- **Picking work for the next release**: start with `## v1.1.9` sections, ordered by effort-to-impact. Tag the release notes file with the BACKLOG.md entries it closes.
- **Updating this doc**: after each release, move the closed items from their P0..P3 / v1.1.x section into "Shipped & verified" with a row in the table.
- **Long-term planning**: the `## Waiting on external` items only unblock when funding / external CLI updates land. Don't put effort there until the blocker is resolved.
