# SigmaLink — Roadmap

SigmaLink is an Electron desktop workspace for launching and coordinating live Claude/Codex/Gemini/Kimi/OpenCode agent panes with worktrees, Ruflo memory/orchestration, browser tools, voice, and review workflows. The immediate operational concern is RAM pressure from live multipane agent process trees.

This ROADMAP is the single source of truth for what to build next.

> **Release status (2026-06-18).** Phases 1–18 have all SHIPPED — their permanent record lives in CHANGELOG + master memory + Ruflo; the shipped phase bodies have been cleared from this doc, which is the ephemeral *next-up* whiteboard, not an archive. Released through **v2.7.1** (`9dbc833`). **Merged on `main`, not yet released (the next tag bundles them all):** pane crash isolation (#179) · first-class Linux Ubuntu x64 support (#180) · pane focus + click-flicker fix (Phase 18, #182) · v2.7.2 prep / default-theme revert to 'glass' (#183) · file-viewer create/delete/rename/move (#184) · pane auto-scroll + jump-to-bottom (#185) · provider-aware Shift+Enter (#187) · **External Control MCP — external-agent control plane: Phase 1 gateway + Phase 2 human-parity surface (#188, CI-green; standalone bridge published at [s1gmamale1/Sigma-Control](https://github.com/s1gmamale1/Sigma-Control))**. ⚠️ If the next tag is the **maiden Linux release**, `workflow_dispatch`-run `release-linux.yml` first — the Linux packaging path has never executed in CI (see the 2026-06-17 findings in [WISHLIST.md](WISHLIST.md)).

---

## How to read this

- **Phases are ordered by value/effort**, with cross-phase prerequisites called out.
- **Effort** is S (≤½ day), M (1–2 days), L (3–5 days), XL (>1 week).
- Confirmed bugs are fixed before new feature phases.
- Shipped phases are archived in CHANGELOG and removed here; unscoped ideas + out-of-scope review findings live in [WISHLIST.md](WISHLIST.md).

---

## Open / next work

Everything previously sequenced here (Phases 1–18) has shipped (Phase 18 — pane focus + click-flicker — landed in #182; External Control MCP, a major new external-agent control surface, shipped via #188 and is recorded in CHANGELOG + master memory, not re-listed here as it was never a sequenced phase). One scoped item remains:

## Phase 13 (Part B) — Recently-closed panes (reopen)

**Goal.** An accidentally-closed pane is recoverable — the operator reopens it from a "Recently closed" list and it returns live (resumed if eligible, else relaunched fresh).

**Deliverables.**
- `panes.listClosed` RPC — soft-deleted (`closed_at IS NOT NULL`) rows from the `listRecents` surface (mig 0033), mirrored across the router-shape / rpc-channels CHANNELS / `rpc-channels.test.ts` TYPED_ROUTER_CHANNELS / `core/rpc/schemas.ts` sibling surfaces.
- `panes.reopen` RPC — `clearClosedMarker(sessionId)` (inverse of `markPaneClosed`) + an extracted `respawnSessionById`.
- A "Recently closed" UI affordance in the Command Room, mirroring the browser-tab recents component.

**Why now.** Part A (PR #161, ADR-007) made deliberate close durable — no resurrection on restart, no spurious "Pane exited" toast — but an *accidental* × is currently unrecoverable: the soft-deleted row exists with no reopen path. Cheap follow-on that closes the lifecycle.

**Scope.** `panes.listClosed`/`panes.reopen` at the `rpc-router.ts` panes block (grep the `panes.close` mirror sites added in Part A); `clearClosedMarker` next to `markPaneClosed` (`src/main/core/pty/mark-pane-closed.ts`); extract `respawnSessionById` from the existing resume path; a recents dropdown/list mirroring the browser-tab recents.

**Findings + recommendation.** Part A already added the `closed_at` column + the `listRecents` surface (mig 0033) and routes all three close paths through `markPaneClosed`; reopen is the inverse (clear marker + resume/relaunch). DB-touching code is MockDb/SQL-shape tested (better-sqlite3 won't load under vitest).

**Risks.** New RPCs touch the router-shape / rpc-channels / schemas sibling surfaces — grep-and-mirror (the allowlist-drift class; add a membership test). Reaper GCs closed rows on the normal window — re-verify keep⊇use (ADR-004) holds with the narrower resume predicate (the use-set shrank → holds trivially). e2e deferred to CI.

**Definition of done.** Operator closes a pane by mistake, opens "Recently closed", clicks it, and the pane returns live; reaped rows age out of the list on the normal window; full local gate (`tsc -b`/vitest/eslint/build) + CI e2e-matrix green.

_(Unscoped future enhancements, deferrals, and out-of-scope review findings — including the 2026-06-17 pre-release findings for #179/#180 — are parked in [WISHLIST.md](WISHLIST.md).)_

---

## Phase 17 — Theme families: Aurora + Cupertino (+ per-theme terminal palettes)

**Goal.** Two new material theme families — not color swaps — and a theme that finally governs the WHOLE surface: chrome, panes, and terminal content recolor together.

**Deliverables.**
- `app/src/styles/aurora-material.css` — sigma-designs living light: breathing blooms-on-velvet atmosphere, 4-independent-light rim on the focused pane, asymmetric attention flare; reduced-motion/transparency collapse.
- `app/src/styles/cupertino-material.css` — apple-design HIG light-first: chrome-only frost, hairlines, one systemBlue accent, crisp focus ring; ≤300ms motion budget.
- `app/src/renderer/lib/terminal-palette.ts` — `TerminalPalette` per theme (xterm + DOM presenter both read it; live re-color of open terminals on switch; light terminals for cupertino-light/parchment/clean-light; dark legacy byte-identical).
- 5 registry entries (`aurora`/`aurora-ember`/`aurora-ice`/`cupertino-light`/`cupertino-dark`) in `app/src/renderer/lib/themes.ts` + token blocks in `app/src/index.css`.
- Extended all-themes xterm↔DOM parity test.

**Why now.** Operator-requested (2026-07-02); the existing 15 themes reduce to 2 material families + hue swaps, and terminals ignore theming entirely — the single biggest "themes feel cosmetic" gap.

**Scope.** Per the implementation plan `app/docs/superpowers/plans/2026-07-03-theme-families-aurora-cupertino.md` (Tasks 1–10): palette lib → registry → xterm live-apply (`terminal-cache.ts:174,240`) → DOM presenter active-palette reads (`ansi-palette.ts`, presenters remount on epoch) → ThemeProvider pairing → token blocks + chrome-tint exclusions (`index.css:183,831`) → the two material files → full gate.

**Findings + recommendation.** Recon 2026-07-02: mature `data-theme` plumbing (registry/gallery/KV) makes families cheap to add via the proven `[data-theme^='family']` material pattern (glass-material.css); the terminal gap traces to two hardcoded constants with a byte-parity test between them — moving both onto one `TerminalPalette` source makes parity structural. Spec: `app/docs/superpowers/specs/2026-07-02-theme-families-aurora-cupertino-design.md`.

**Risks.** Living-rim GPU cost (bounded: focused pane only, `@property` angle animation, pauses on window blur; live-dial verify); light-terminal legibility (GitHub-Light-derived ANSI, not naive inversion); the palette map is a new mirror surface (extended parity test is the guard); presenter remount on theme switch snaps scroll to tail (rare path, documented).

**Definition of done.** Operator switches to each new theme and sees the family material (aurora rim alive with 4 mixed-direction lights; cupertino frost + hairlines) AND an OPEN terminal recolors live; parity test passes for all 20 themes; existing dark themes render byte-identically; full local gate (`tsc -b`/vitest/`eslint .`/build) + CI green. Deferred extensions (macOS vibrancy, window-chrome bg sync, SFX, extra variants) parked in WISHLIST.

---

## Architecture decisions (ADRs)

### ADR-001 — Prefer shared Ruflo HTTP over per-pane stdio
**Decision.** Ruflo is treated as a per-workspace shared HTTP daemon for normal pane launches, with per-pane stdio MCP retained only as a degraded fallback. **Context.** Per-pane stdio MCP duplicates `npx/node` process trees and can dominate pane RSS. **Consequences.** (+) Lower RAM and faster warm pane launches. (+) Existing pane functionality survives through fallback. (-) Launch now depends on daemon readiness when possible, so the helper must be fail-open and testable.

### ADR-002 — Keep Tauri migration out of the RAM hot path
**Decision.** Do not migrate the backend to Tauri as the first RAM optimization. **Context.** Electron host overhead is real, but the observed 300 MB-1 GB pane costs are mostly child Claude/Codex/MCP trees. **Consequences.** (+) Directly addresses the largest avoidable memory source. (-) Baseline Electron overhead remains until a separate runtime migration phase is justified.

### ADR-003 — Image-to-agent via staged temp file + absolute @path, not clipboard-write
**Decision.** Pane screenshot drop/paste hands an image to the CLI by staging the bytes to `<userData>/staged-images/` and injecting the absolute path into the prompt — never by writing the image to the system clipboard. **Context.** Both Claude Code and Codex read images CLI-side from the OS clipboard on Ctrl+V (the PTY is a text pipe; terminal graphics protocols like OSC 1337 are display-only, not input). But Electron's `clipboard.writeImage` writes `public.png` while Claude Code's reader is `osascript 'the clipboard as «class PNGf»'` (legacy type) — the write silently misses (anthropics/claude-code#30936, open as of 2026-06). Both CLIs DO read an image file path from the prompt. **Consequences.** (+) Works today for both CLIs, no upstream dependency, no clipboard-type gymnastics; staging is validated (ext allowlist, 20 MB cap, server-generated filename). (+) Gated per provider via `IMAGE_CAPABLE_PROVIDERS`. (−) Bypasses the CLIs' native `[Image #N]` paste UX — the image arrives as a path mention. (−) Staged files accumulate in userData until a future janitor sweep (transient inputs; acceptable).

### ADR-004 — One shared worktree keep-predicate; keep⊇use is a CI-enforced invariant
**Decision.** Every worktree GC/prune path consumes a single exported keep-predicate (`worktree-cleanup.ts`), and a dedicated test asserts the keep-set is a superset of every resume/respawn use-predicate, with a source tripwire pinning `resume-launcher.ts`'s eligibility rules. **Context.** The fence drifted twice (the `93fbca6` pane-resume regression, then the SF-13 cleanup twin) because two files re-encoded eligibility independently; the second drift also crossed workspace boundaries in the shared `repoHash` dir. **Consequences.** (+) Predicate drift becomes a CI failure instead of a data-loss incident. (+) Sweeps spare sibling workspaces by construction. (−) The reaper keeps more disk (bounded by the 7-day window).

### ADR-005 — Scratch-tab state is module-scope with one teardown choke point
**Decision.** Scratch terminal tabs live in a module-scope store keyed by parent session (the terminal-cache pattern), torn down only via `closeScratchTab` — on pane close or GC of vanished parents — never implicitly by component unmount. **Context.** Per-mount `useState` reset on every room/workspace switch, orphaning PTYs and xterm/WebGL cache entries the GC couldn't see; unmount-as-close was rejected because a room switch must not kill the user's shell. **Consequences.** (+) Scratch shells survive navigation and leaks become structurally impossible (the GC enumerates them). (−) One more module-scope store to reason about (same family as terminal-cache/PaneSplash).

### ADR-006 — win32 spawn = verbatim command line + cross-spawn escaping, proven by a CI stub-shim
**Decision.** Windows spawns hand cmd.exe a single hand-built verbatim command line (`windowsVerbatimArguments` / node-pty string `commandLine`) escaped with cross-spawn's caret-escape-everything algorithm, and CI gains a windows-latest vitest leg whose stub `.cmd` shim round-trips argv. **Context.** PR #134 shipped the verbatim plumbing, but `cmdQuoteArg` still corrupts `^ % !` and odd quotes (quote-state toggle = injection risk); vitest had never executed on the Windows CI leg, so the entire class stayed invisible behind green e2e. **Consequences.** (+) The primary provider (`claude.cmd`) becomes launchable on stock Windows and regressions fail CI. (−) A slightly slower CI matrix and a cmd.exe escaping table to maintain.

### ADR-007 — `closed_at` is the durable deliberate-close axis; one shared close primitive
**Decision.** A deliberately-closed pane is marked by a nullable `agent_sessions.closed_at` soft-delete column (parity with `browser_tabs`, mig 0033), written by ONE shared primitive (`markPaneClosed`) BEFORE the PTY kill, and consumed by every lifecycle decision: the exit-notification source suppresses the toast when it is set, and both boot read-paths (`listForWorkspace` grid rehydrate + `listEligibleRows`/`listRespawnableRows` resume) exclude `closed_at IS NOT NULL`. The × button, context-menu close, and the `close_pane` tool all route through the same primitive. **Context.** Manual close and `close_pane` had diverged into three close paths; manual close wrote nothing the boot read-paths excluded (resurrection) and raised a crash-style toast (no intentional-close marker). `status` is unusable as the marker because the launcher's late `onExit` write overwrites a killed `running` pane's status to `'error'`/143, and a clean `exited/0` is indistinguishable from an agent finishing on its own. **Consequences.** (+) Both bugs fixed by one durable marker; `close_pane`'s latent half-resurrection is fixed too; future close-sites can't drift (single choke point). (+) Closed rows are retained for a Recents/reopen affordance and reaped on the normal window (keep⊇use, ADR-004, holds trivially — the use-set shrank). (−) A new column + migration, and a mark-before-kill ordering invariant that every close site must honor.

### ADR-008 — Special workspaces are KV-marked, not schema-typed
**Decision.** The "SigmaLink Dev" singleton is identified by a KV pointer (`workspace.devWorkspace.id`) plus forced `repoMode:'plain'`/`repoRoot:null` — NOT by a new `kind`/`type` column on `workspaces`. **Context.** Only one special flavor exists; `repoMode:'plain'` already short-circuits every worktree/git/janitor path (both spawn gates, boot janitor, orphan cleanup, auto-checkpoint), and the shared-KV-contract pattern is established (`shared/worktree-mode.ts`). A migration would buy nothing today. **Consequences.** (+) Zero migration risk; reuses both existing spawn gates unchanged; a deleted row self-heals (recreate + repoint). (−) Specialness is invisible in the `workspaces` table itself (must join KV to see it); a second special flavor later would justify revisiting a `kind` column.

### ADR-009 — Multi-window = full SPA per window + main-side ownership registry; detach is a MOVE, never a mirror
**Decision.** Secondary windows load the SAME renderer bundle scoped via a preload-injected `workspaceScope`; a main-process WindowRegistry is the sole source of truth for workspaceId→windowId ownership; a workspace's xterm instances exist in exactly ONE window, and session-scoped PTY events are routed only to that window. Renderer echoes of the open-workspace list come ONLY from the main window; the global list is the union of that echo and registry-detached workspaces. **Context.** Two xterms attached to one PTY fight over SIGWINCH/cols and double-echo input, so mirroring is structurally unsafe. A thin secondary renderer root would duplicate App.tsx provider wiring (the sibling-drift class that has bitten repeatedly); N un-scoped windows give no detach semantics while still needing every ownership guard. The move path is cheap because `pty.snapshot` + the pty-data-bus first-attach already rebuild a terminal against a RUNNING PTY (`terminal-cache.ts:337-413`), and the BSP-B2 browser detach proved secondary-window lifecycle in-repo (`browser/manager.ts:395`). **Consequences.** (+) One renderer codebase, process isolation gives each window its own terminal cache for free, and pty:data routing CUTS total IPC versus broadcast (supersedes PERF-11). (+) Re-dock-on-close keeps PTYs alive (ADR-007-consistent). (−) Every direct `mainWindow.webContents.send` becomes a routing decision (audited class); per-window renderer processes cost RSS; ring-buffer-bounded scrollback on move until the DOM-presenter engine serializes buffers.

### ADR-010 — Linux support contract: AppImage+deb x64 only, manual update, user-owned CLI installs
**Decision.** Ship Linux as Ubuntu 22.04/24.04 x64 via AppImage + deb only; auto-update is a manual download + reveal-in-folder (no in-place apply); provider CLI installs are rewritten to a user-owned npm prefix (`$HOME/.npm-global`) / pipx-first python (never sudo). **Context.** Linux was BACKLOG WONTFIX; electron-updater cannot safely re-apply an AppImage/deb in place; global npm/pip installs otherwise need root or pollute system dirs; Wayland has no reliable paste-injection. **Consequences.** (+) A real, CI-gated Linux target with predictable install/update UX and no sudo for CLIs. (+) mac/win paths untouched (third branch per seam, independently unit-tested). (−) No snap/flatpak/rpm/arm64, no auto-apply updates, Wayland gets clipboard-fallback only — all explicit non-goals.

---

## Effort / impact table

| Item | Phase | Effort | Impact | Notes |
|------|-------|--------|--------|-------|
| Recently-closed panes (listClosed + reopen + UI) | Phase 13 (Part B) | M | Medium | Recoverable accidental close; mirrors browser-tab recents; reuses Part A's `closed_at` + `listRecents` surface (ADR-007). |
| Theme families Aurora + Cupertino + per-theme terminal palettes | Phase 17 | L | Medium | Spec 2026-07-02 + plan 2026-07-03; branch `feat/theme-families-aurora-cupertino`; terminal follow-through is the structural win. |
