# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.** Low ceremony.
> Promote an item into [ROADMAP.md](ROADMAP.md) when it gets scoped into a phase.
>
> Buckets: **Deferred by design** (consciously out of scope) and **Future enhancements**
> (planned-later upgrades). **New ideas** is the untriaged inbox.

---

## 🚫 Deferred by design (out of scope for now)

_(consciously NOT built — each is a separate track or a non-goal, not a gap)_

- **[desktop-runtime] Tauri migration for host-shell footprint** — replacing Electron with Tauri may reduce baseline app overhead, but the current RAM bottleneck is per-pane Claude/Codex/MCP process trees. Defer until shared MCP, lazy resume, and process-tree cleanup prove the remaining host overhead is worth a platform migration.

- **[dev-workspace] multiple SigmaLink Dev instances / custom cwd / agent panes in it** — operator chose a singleton at `~` with plain shells only (AskUserQuestion 2026-06-11, Phase 14 design); revisit only if a second fixed-cwd terminal bench is requested. (`+ Pane` will technically work there — tolerated, not designed for.)

---

## ✨ Future enhancements (planned-later upgrades)

_(real upgrades to build once the current system is production-grade)_

- **[pane-lifecycle] automatic idle suspend for completed agents** — park idle/completed panes by preserving scrollback/session metadata and killing the live process tree. Build after the shared Ruflo HTTP and explicit lazy-resume path is stable, because automatic suspension needs clear pinned/keep-alive semantics.
- **[pane-lifecycle] pinned keep-alive policy for remote/autopilot agents** — mark panes that must never be parked by idle cleanup, especially Telegram/remote/autopilot lanes. Build when idle suspend is implemented.
- **[pane-lifecycle] Pane Hibernate: pause/resume-like RAM offload for inactive finished panes** — make the current "inactive/blurred/resuming" pane concept into a real memory feature: keep the pane visible as a cheap frozen shell, but stop the provider/MCP process tree so idle Claude/Codex panes no longer keep 300 MB-1 GB resident.
  Proposed behavior: add a `sleeping`/`hibernated` pane runtime state that preserves `sessionId`, provider, cwd/worktree, branch, runtime profile, external provider session id, scrollback snapshot, last RSS/process breakdown, and the visible pane card. On sleep, stop the PTY process tree and dispose or downgrade the renderer xterm cache; on resume, respawn the provider through the existing resume path and restore the pane to `running`.
  Why it matters: CSS blur/minimize only changes presentation and does not reduce Claude/MCP RSS. Raw OS pause (`SIGSTOP`/`SIGCONT`) is tempting but does not reliably free memory and may break network streams/MCP children. Hibernate is the reliable RAM win because it removes the live process tree until the user needs the pane again.
  Expected impact: in an 8-pane workspace where idle Claude panes average ~500 MB RSS, hibernating 6 finished panes can reduce provider-process RSS from roughly ~4 GB to roughly the 2 active panes plus lightweight pane metadata/scrollback. MCP-heavy panes benefit more because child MCP servers are terminated too.
  Likely touchpoints: `app/src/main/core/pty/registry.ts:401` and `app/src/main/core/pty/registry.ts:411` already expose tree-aware kill/stop; add a hibernate-specific stop path that persists a sleeping state instead of treating the pane as removed. `app/src/renderer/lib/terminal-cache.ts:31` and `app/src/renderer/lib/terminal-cache.ts:367` distinguish parking vs destroy; sleeping panes should probably destroy live xterm/subscriptions after persisting scrollback, while normal workspace switches still park. `app/src/main/core/pty/resume-launcher.ts:460` already supports subset resume by session id; reuse/extend it for explicit pane wake. `app/src/renderer/features/command-room/CommandRoom.tsx:294` and `app/src/renderer/features/command-room/CommandRoom.tsx:301` currently only remove or stop; add Sleep/Wake actions and a header badge.
  Safety policy: manual "Sleep pane" first; later auto-sleep only when there is a clear finished/idle signal, no active prompt, no recent output, low CPU, and the pane is not pinned keep-alive. Never auto-sleep remote/autopilot/Telegram or explicitly pinned panes. On wake failure, keep the frozen pane and show a resumable error rather than deleting the session.
  Trigger: build after the current RAM brake and strict MCP launch defaults have been dogfooded, and after we can reliably persist/restore scrollback for sleeping panes. Effort: L.

- **[pane-rendering] residual watches after the 2026-06-11 four-PR arc (operator-verified end-to-end)** — SHIPPED: restore-from-hidden reveal + `window:restored` + #133 residuals (#152), same-frame ⤢ refit + zero-size fit guard (#156), LIVE drag re-wrap with single-SIGWINCH-per-gesture (#159), claude `--settings '{"tui":"fullscreen"}'` killing the upstream Ink scrollback dup (#160, operator: "I see no duplicates"). Spec `docs/superpowers/specs/2026-06-11-pane-refit-controller-design.md`. Still open, all low, all watch-only:
  - **Fullscreen-renderer feel** — line-by-line scroll lag inside claude panes (upstream anthropics/claude-code#56546) and one CJK copy-mojibake report (#66269). Revert = drop the `--settings` pair in `src/shared/providers.ts` (one line).
  - **1-frame repaint flicker at drag release for a full-screen TUI** — the CLI's own redraw after SIGWINCH; not fixable our side.
  - **Snapshot/live overlap dedup caps its scan at 64 KiB** (`app/src/renderer/lib/terminal-cache.ts` MAX_OVERLAP_SCAN) — a >64 KiB pending burst at first-attach can double-write the overlap window. Bump or chunk-hash if duplicated text is ever reported ON FIRST ATTACH (not on resize).
  - **Suppressed window-restore + same-dims drag-end leaves a stale frame** (near-impossible interleaving) — fix if ever seen: latch a `pendingReveal` flag that upgrades the drag-end fit to a reveal.
  Trigger: only if re-reported. Severity: low. Effort: S.

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

- **[notifications] agent-attention — two LOW review follow-ups (deferred from the 2026-06-14 final review)** — both ride a follow-up, neither blocks the feature. (1) **idle/bell dedupe ceiling**: the bell-vs-idle dedupe window is fixed at 6000ms while `notifications.idleMs` is KV-tunable with only a 500ms floor (no ceiling). If an operator sets `idleMs` above ~6000, a single waiting moment can fire BOTH a bell and an idle event (the 2s sound throttle masks the audio but two glows/dispatches still occur). Fix: derive `dedupeMs = max(6000, idleMs() + slack)` at arm time, or clamp the `idleMs` gate to a ceiling below the dedupe. Files: `app/src/main/core/pty/idle-detector.ts`, `app/src/main/core/pty/attention-detector.ts`, the `idleMs` gate in `app/src/main/rpc-router.ts`. (2) **drag-indicator vs `.sl-attention` box-shadow collision**: dragging a glowing workspace row mid-reorder — the drop-line `shadow-[inset_…]` and the `.sl-attention` glow are both `box-shadow` (not additive), so one replaces the other for the duration of the drag. Cosmetic, transient, self-resolves on drop. Fix (if ever bothered): render the drop indicator as an outline/border instead of box-shadow in `WorkspacesPanel.tsx`. Trigger: only if reported. Effort: S.

- **[mcp] detect repeated stdio MCP starts under one Codex/Claude pane** — a single pane can accumulate multiple `@claude-flow/cli mcp start` descendants. Investigate whether this is Codex plugin behavior, config reload behavior, or a leaked child cleanup issue once diagnostics can show child process history.

- **[panes/C-class] custom DOM terminal renderer / structured Claude pane (the BridgeSpace counter)** — 2026-06-11 operator screenshot + behavior analysis of BridgeSpace v3.1.12 (Tauri + React + own terminal renderer + `osc133-parser.ts`, self-evidenced in their on-stream code review). CORRECTED 2026-06-11 (operator: you can exit claude and run any CLI in their panes; the genuine CC TUI footer is visible): their panes ARE real PTY terminals — under a **custom DOM/React terminal renderer** (Warp-style: parse PTY bytes into logical lines/blocks, let CSS wrap them) instead of an xterm character grid. That's why resize can't glitch: visual reflow is a CSS operation decoupled from the PTY cols contract, and THEY choose when the app gets SIGWINCH (settle-only/quantized → Ink never spams duplicates); no grid buffer/glyph atlas to corrupt. Their cost: they maintain a whole terminal emulator (VT coverage strain on vim/htop-class grid apps; DOM layout cost on huge output — their own "terminal renderer perf" review task). **RESOLVED 2026-06-12: shape (a) BUILT** — the DOM terminal presenter (spec 2026-06-12, PRs #162–#168, default since v2.4.1) is exactly this: headless-xterm engine + FlowView/GridView DOM presenters over our PTYs, settle-only SIGWINCH, per-pane worktrees edge intact. Shape (b) DOM-chat pane remains optional future work. Original framing: (a) **custom DOM renderer over our PTYs** — full structural parity, Warp-sized bet; (b) **opt-in DOM-chat claude pane** via `claude -p --output-format stream-json` + Jorvis `ChatTranscript` components — cheaper, claude-only, real scope (tool-permission UI, slash surface, resume). Their remaining structural weakness either way: all agents share one working dir (our per-pane worktrees remain the edge — see `agentic-de-design-patterns`). Trigger: claude-pane scroll-feel complaints persisting after the #160 fullscreen dogfood, or competitive pressure. Effort: (a) XXL · (b) XL.

- **[perf/UX] `create_swarm` dispatch-echo storm** — Jorvis `create_swarm` emits one `assistant:dispatch-echo` per agent (#150), so a large preset (battalion = 20) fires up to ~20 `panes.list`+`swarms.list` refetches, 20 success toasts, 20 dings, and 20 racing focus-jumps. (`launch_pane` has the same pattern, capped at 8.) Fix: emit ONE consolidated echo from `create_swarm` (or echo only the queen/first agent for focus + let the single refetch hydrate the rest), or add a short coalescing window in `app/src/renderer/features/jorvis-assistant/use-jorvis-dispatch-echo.ts`. Effort: S. [[grep-sibling-call-sites]] (Opus review #150)

- **[cleanup] `create_swarm` echo `error` field + impossible-state test** — the `create_swarm` echo hardcodes `error: null` (#150) while `launch_pane`/`add_agent` carry the real `session.error`; harmless today (the `sessionId !== null` filter excludes failed agents) but `app/src/main/core/assistant/tools.create-swarm-echo.test.ts` asserts an impossible `status:'error'`+non-null-`sessionId` state. Thread the real error if `SwarmAgent` ever carries one, or drop the impossible-state test case. Effort: S. (Opus review #150)

- **[security/hardening] clamp zoom factor at the preload trust boundary** — `app/electron/preload.ts` `setZoomFactor` is a thin pass-through. The renderer clamps to 0.5–2.0 (`app/src/renderer/lib/zoom.ts` `clampZoom`) on every real path, but a compromised renderer could call `window.sigma.setZoomFactor` directly with an arbitrary/`NaN` value (worst case: a self-inflicted unreadable own window — usability, not privilege/data). Fix: `Math.min(2, Math.max(0.5, Number.isFinite(factor) ? factor : 1))` inside the preload method so the boundary self-protects. Effort: S. Build when tightening the preload trust boundary. (Opus review PR #153)
- **[UX] bind Cmd/Ctrl + `+` (shifted) for zoom-in parity** — only `mod+=` is bound (`app/src/renderer/app/useZoomControls.ts`); shifted `+` (`e.key='+'`, `shiftKey=true`) is rejected by the strict `matches()` (`app/src/renderer/lib/shortcuts.ts`), so Chrome-style `Cmd++` doesn't zoom in. Wheel + `=`/`-`/`0` already cover it. Fix: add `bindShortcut('mod+shift+=', …) → zoomIn`. Effort: S. Deferred by design (minor convenience). (Opus review PR #153)
- 🐞 **[low] `app.fontSize` boot-restore is unclamped** — `app/src/renderer/app/ThemeProvider.tsx` applies any finite stored `app.fontSize` directly (pre-existing; not introduced by #153). Settings only writes bounded presets (12/13/14/16) so it's safe today, but a corrupt KV value would apply an unbounded root font size. Fix: clamp to a sane px range before `applyFontSize`. Effort: S. (Opus review PR #153)

- **[windows] multi-window follow-ups (PR #169 review residue, 2026-06-12)** — Phase 16 SHIPPED (`2344093`); these are the non-blocking items its two-stage + final reviews filed:
  - **[routing] launcher `forgetSession`/prime after the `agent_sessions` INSERT** — a session whose first pty chunk beats its INSERT caches a null route and broadcasts-to-all for its lifetime (correct, just unrouted); evict at the INSERT site to upgrade it. Effort: S.
  - **[arch] extract `electron/windows.ts`** — `electron/main.ts` is ~1000 lines post-B1; move `buildWindow`/`createSecondaryWindow`/`asHandle` out before the next main.ts feature. Effort: S.
  - **[windows/UX] window-layout boot restore** — design phase 3: persist kv `ui.windows.layout`, restore detached windows on boot (today: always boots single-window). Promote with its own plan after dogfood. Effort: M.
  - **[windows/UX] explicit redock affordance** — `windows.redockWorkspace` RPC exists with no UI caller (redock = close the window today); add a scoped-shell button or main-sidebar action if dogfood wants it. Effort: S.
  - **[voice] window-aware voice focus** — `voice:focused-session` is last-writer-wins across windows; focusing main without changing its session leaves dictation pointed at the secondary window's pane. Scope to the OS-focused window. Effort: S–M.
  - **[state/low] exited-session GC drops a detached ws's exited rows from main's state** (`use-exited-session-gc.ts`) — transient; self-heals via the redock refetch. Fix only if a ghost is ever reported. Effort: S.
  - **[hardening] secondary-window cap + preload `argValue` unit test** — resource-exhaustion belt-and-braces + the one un-unit-tested preload parse. Effort: S.

- **[panes] pane auto-scroll + Shift+Enter follow-ups (PR #185 + #187 review residue, 2026-06-18)** — both features SHIPPED to the DOM presenter (auto-scroll robustness + jump-to-bottom button `#185`; provider-aware Shift+Enter newline `#187`). Non-blocking residue the Opus reviews + the verification step filed:
  - **[verify] on-device confirm Shift+Enter inserts a newline in a real Codex pane** — the mapping is provider-aware: `claude → \x1b\r` (meta-Enter, authoritative from claude's own `/terminal-setup`) vs `codex`/others → `\n` (Ctrl+J). Codex's `\n` is strong (its footer + kitty-fallback) but NOT yet live-confirmed. If it submits instead of newlining, it's a one-line tweak in `shiftEnterNewline` (`app/src/renderer/features/command-room/input-encoder.ts`). [[reference_shift_enter_newline_per_tui]] Effort: S.
  - **[a11y] jump-to-bottom "↓" button has no `:focus-visible` outline** — `FlowView.tsx` renders the button with inline styles (no pseudo-class), so keyboard focus is invisible. Pane is mouse-driven so cosmetic. Fix needs a CSS class or onFocus/onBlur (inline can't do `:focus-visible`). Effort: S.
  - **[xterm parity] neither feature covers the xterm renderer** (one KV away, not default since v2.4.1). xterm scrolls-on-output natively but has no jump-to-bottom button; it encodes Enter inside `term.onData`, so provider-aware Shift+Enter there needs `attachCustomKeyEventHandler` in `terminal-cache.ts`. Build only if a pane is flipped to xterm and parity is wanted. Effort: M.
  - **[test] DomTerminalView undefined-provider Shift+Enter fallback** — the `providerId===undefined` (session not yet in state) → LF path is covered by the pure golden but not a DomTerminalView integration test; cheap to add. Effort: S.

---

## 🔬 Deep review findings (2026-06-11) — win32 DB lifecycle (Phase 15 grounding)

_Found while root-causing the Windows reopen crash (ROADMAP Phase 15). The crash itself + WAL bloat are fixed there; these are the adjacent design debts deliberately NOT fixed in that PR._

- **[db/arch] memory MCP server runs FULL `initializeDatabase()` per CLI spawn** — every agent pane's CLI spawns its own `mcp-memory-server.cjs`, and `mcp-server.ts:191` runs the complete bootstrap (BOOTSTRAP_SQL DDL + `migrate()` + kv migrations) as a persistent WRITER on the live `sigmalink.db`. N panes = N concurrent DDL writers by design — DDL races between fresh children are possible (duplicate-column throws), and every spawned CLI holds a write-capable handle the quit path must chase. Redesign: open the child connection WITHOUT DDL (schema is main's job; add a `SIGMALINK_SKIP_BOOTSTRAP=1` path or a readonly+`busy_timeout` open with lazy write), or share one supervised server instead of per-CLI copies. Effort: M. [[grep-sibling-call-sites]]

- **[db/obs] WAL-size telemetry + boot log line** — devices accumulated tens-of-MB `-wal` files silently for weeks (quit checkpoint failing on win32). Log `-wal` size at boot (before/after the Phase-15 TRUNCATE reclaim) and surface a diagnostics counter so a regressing checkpoint is visible instead of silent. Effort: S.

---

## 🔬 Deep review findings (2026-06-11 — Jorvis terminal-access debugging)

_(out-of-scope findings from the `fix/jorvis-terminal-access` root-cause session; the in-scope fixes — catalogue triple-drift, `read_pane`, `prompt_agent` liveness — SHIPPED in PR #157 `5ac6e3a` (2026-06-11, rides the next release), spec `app/docs/superpowers/specs/2026-06-11-jorvis-terminal-access-design.md`)_

- 🐞 **[medium] swarm-roster ghost entries — no healing** — live DB shows `swarm_agents` row `builder-1` (session `1580b8c7…`) with NO live/DB-running session; `list_swarms` (`app/src/main/core/assistant/tools.ts:763`) serves it to Jorvis as a real roster member, and mailbox broadcasts/roll-calls target it. The `prompt_agent` liveness guard now surfaces the ghost on direct prompts, but the roster itself never self-heals. Fix: a roster sweep that cross-checks `swarm_agents` against live sessions and marks orphans `status='lost'` (reaper keep⊇use rule applies). Effort: M.
- **[UX/low] deferred-MCP-tools flow reads as "host reconnecting" to the model** — the Claude CLI defers `mcp__jorvis-host__*` schemas (model must ToolSearch-load them; traces 2026-06-11 19:21:59 + 02:31:32), and the model narrates it as "the host is reconnecting", alarming the operator. Options: a system-prompt line ("tools may need ToolSearch — this is normal, not an outage") or investigate pre-loading via the CLI's MCP eager-load config if/when exposed. Effort: S.

---

## 🔬 Deep review findings (2026-06-11) — manual pane-close lifecycle

> **→ SHIPPED in PR #161 `a0e9bee` (2026-06-12), ADR-007:** the spurious "Pane exited" toast on deliberate close (#14), closed-pane resurrection on restart (#13), and the unified mark-then-kill close primitive (`closed_at` soft-delete; × / context-menu / `close_pane` all routed through it). Plan: `app/docs/superpowers/plans/2026-06-11-pane-close-lifecycle.md`. Remaining open follow-ups (deferred from Part A; Part B Recents below):

- 🐞 **[low] `handleRelaunch` still drops the old session with NO close-write** (deferred from Phase 13 Part A — out of plan scope, pre-existing): the crashed row keeps `pane_index`/`status='error'`; if the replacement takes a different slot the old row can rehydrate as a ghost tile on restart. Fix: route the drop through `rpc.panes.close` (marker write is now one call). Effort: S. (Opus review, PR #161.)

- **[ux] `panes.close` failure after the optimistic `REMOVE_SESSION` is silent** — fire-and-forget `.catch(() => undefined)` in `CommandRoom.handleRemove`; a bridge failure leaves the row unmarked → resurrects on restart with no operator signal. Pre-existing shape; add a `toast.error` in the catch. Effort: S. (Opus review, PR #161.)

- **[pane-lifecycle] Recents recoverability for closed panes** — keep the soft-deleted (`closed_at IS NOT NULL`) row and surface it in `listRecents` (mig 0033 added the recents surface) so an accidental × is reopenable (reopen = clear `closed_at` + resume/relaunch). Reaper GCs after the normal window; verify keep-set ⊇ use-set still holds with the narrower resume predicate. Effort: M.

---

## 🔬 Deep review findings (2026-06-11) — SigmaLink Dev plan grounding

_Found by the 4-lane recon + lead verification while grounding the Phase 14 plan._

- **[test-infra] make `TYPED_ROUTER_CHANNELS` self-maintaining** — the v1.5.3-B CHANNELS-vs-AppRouter defensive test's enumeration (`app/src/shared/rpc-channels.test.ts:67+`) is hand-maintained, so it drifts in tandem with the allowlist it guards (exactly how the rename/openNew hole above stayed green). Replace the hand-list with a derivation from the live registration source (enumerate `rpc-router.ts`'s registered handler map at test time, or generate from `router-shape.ts` via a type-level/codegen check) so a registered-but-unlisted channel FAILS the test instead of silently joining the drift. Found by Opus quality review during Phase 14 U2 (PR #158). Effort: M. [[grep-sibling-call-sites]]

---

## 🔬 Deep review findings (2026-06-17) — pre-release verification of #179 + #180

_Independent 3-agent (Opus) release-readiness review of the two merged-but-unreleased PRs on `origin/main`: **pane crash isolation #179 (`56f9994`)** + **Linux Ubuntu x64 support #180 (`80b5fd2`)**. Verdict: both do what they claim; CI green on macOS+Windows+Ubuntu (full vitest runs in CI via `lint-and-build.yml` `coverage` step); rpc-channels allowlist confirmed purely additive (no dropped members despite the stale-base authorship). **No release-blockers.** All findings below are non-blocking, ranked by severity._

- 🐞 **[medium] Linux release packaging has never executed in CI — first real run is the maiden Linux tag** — no CI job runs `electron-builder --linux` (`lint-and-build.yml` `linux-product-check` is build+compile only; the `e2e-matrix` ubuntu lane builds+smokes but never packages). The deb `artifactName`↔`install-linux.sh` match (both resolve to `SigmaLink_<ver>_amd64.deb`) and the `latest-linux.yml` emission are verified by inspection only; an electron-builder `${arch}`/naming surprise would 404 the one-line `.deb` installer post-tag. Fix: `workflow_dispatch`-run `.github/workflows/release-linux.yml` before the first Linux `v*` tag, then `curl -fIL` the produced deb URL. Effort: S. (Only matters when a tag actually publishes Linux artifacts.)
- 🐞 **[low] Linux auto-update `dest` filename trusts the manifest `file.url` — theoretical path-traversal** — `app/electron/auto-update.ts:119` uses `appImage.name` (raw `UpdateInfo.files[].url`) as the download filename; the macOS sibling hardcodes a clean `SigmaLink-${version}.dmg`. Benign for the real signed first-party `latest-linux.yml` (bare filenames), but a `../`/absolute value would resolve outside Downloads. Fix: `path.basename(file.url)` for the Linux dest, mirroring mac. Effort: S.
- 🐞 **[low] `defaultShell` Linux fallback hardcodes `/bin/bash` with no `/bin/sh` fallback** — `app/src/main/core/pty/local-pty.ts:135` returns `/bin/bash -l` when `SHELL` is non-POSIX/absent; a bash-less/minimal/musl image → PTY spawn ENOENT. Safe for the stated Ubuntu 22.04/24.04 desktop target (always ships bash); flag only for minimal images. Fix: fall back to `/bin/sh` when bash is absent. Effort: S.
- 🐞 **[low] `release-linux.yml` does not checkout the `vendor/whisper.cpp` submodule → whisper voice silently stubbed on every Linux build** — `actions/checkout@v4` (`release-linux.yml:30-31`) omits `submodules: true`, so `install-or-stub.cjs` finds no sources and installs the JS no-op stub. Intended per ADR-010 (whisper stubbed on Linux), but the only signal is an install-time `console.warn`. If Linux voice is ever wanted: add `submodules: recursive` + the native rebuild. Effort: S.
- 🐞 **[low] `release-linux.yml:69-71` dead voice-whisper rebuild step** — `npx @electron/rebuild -f -w @sigmalink/voice-whisper` with `continue-on-error: true` is a guaranteed swallowed no-op while the submodule is absent (above). Cosmetic/misleading; drop it or gate it on the submodule presence. Effort: S.
- **[doc/low] ADR-010 "no sudo" wording vs the deb installer's `sudo`** — `install-linux.sh:67-71` correctly uses `sudo` for `dpkg`/`apt` (a `.deb` needs root); ADR-010's "no sudo" refers only to provider CLI installs (npm prefix / pipx-first). No real inconsistency — just ensure README/ADR isn't read as "the app installs without sudo." Effort: S.
- **[test-gap/low] #179 `PaneErrorBoundary` recover-path coverage is thin** — `ErrorBoundary.test.tsx` proves contain-and-survive (a sibling pane still renders while one throws) but does NOT assert the Relaunch/Close buttons render or that clicking invokes the handlers, and there's no integration test of the unmount-by-key recovery flow in `CommandRoom`. Add button-present + recovery-flow tests. Effort: S.
- **[trivial] #179 diagnostics-log byte-trim can sever the oldest surviving line mid-string** — `app/src/main/diagnostics-log.ts:21-24` trims by bytes, not line boundaries, so the first surviving entry after a trim may be a fragment. Harmless. Effort: S.

_(Not new / already tracked: `handleRelaunch` no close-write — see the pane-close section above (byte-identical to v2.7.1, not introduced by #179); the `uncaughtException` handler not calling `process.exit` is the intended "log instead of dying" for a GUI, not a bug.)_

---

## 🔬 Operator-reported bug (2026-06-17) — pane focus + click-flicker

_Operator: pane windows need 3-4 clicks to focus and flicker when clicked. Disambiguated via AskUserQuestion: **all panes**, **both main + popped-out windows**, **flicker only on click**, **both ring + keystroke focus feel stuck**. Root-caused against `origin/main` (read-only); confirm-first plan written._

- ~~🐞 **[high] DOM-presenter panes need 3-4 clicks to focus + flicker on click**~~ → **promoted to [ROADMAP.md](ROADMAP.md) Phase 18** (2026-06-17). Plan: `app/docs/superpowers/plans/2026-06-17-pane-focus-flicker.md`. Root cause (code-evidenced, default DOM presenter since v2.4.1): keystrokes go to a hidden 1×1 `<textarea>` focused on `mouseUp` **gated behind a `!sel.isCollapsed` early-return** (`app/src/renderer/features/command-room/DomTerminalView.tsx:386-390`) → a micro-movement click doesn't focus + clobbers the clipboard; plain `.focus()` with no `{ preventScroll }` (`:171,274,393`) scroll-jumps the `overflowY:auto` FlowView (textarea pinned `bottom:0`) → the flicker. Activation fires on mousedown-capture (`PaneGrid.tsx:315`→`CommandRoom.tsx:434`) with no static remount, so the "ring lag" is confirm-first (likely perceived failed-focus). Fix: focus on `pointerdown` + `preventScroll`, decouple copy-on-select; xterm path untouched. Effort: M.
