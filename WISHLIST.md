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

- **[pane-rendering] pane terminal text-reflow on resize — still not fully finished** — PR #133 (`66ffce4` restored `_renderService.clear()` via `fit.fit()`; `45a558e` suppressed the ResizeObserver refit during a divider drag) killed the ghosting + the mid-drag SIGWINCH storm, and the operator confirmed it "working fine for now" — but it is NOT fully polished. Residuals, each with a cited deferred fix from the 4-agent root-cause sweep (plan: `app/docs/superpowers/plans/2026-06-09-pane-content-reflow-keystone.md`):
  - 🐞 **[low] coalescer mixes old/new-width bytes around a resize + double-writes the snapshot on first mount.** `app/src/main/rpc-router.ts:989` (resize handler) and the `pty.snapshot` handler never call `ptyDataCoalescer.flush(sessionId)` (`app/src/main/core/pty/pty-data-coalescer.ts:66`). Fix: flush before `pty.resize` and before `pty.snapshot`. Effort: S.
  - 🐞 **[low] `reflowCursorLine` defaults false** → the cursor line is skipped during a column-shrink reflow → cursor desync/overlap while a TUI streams. `app/src/renderer/lib/terminal-cache.ts` `buildTerminalOptions`: set `reflowCursorLine: true` — but it has side-effects on cursor-redraw programs, so test against Claude Code's prompt first. Effort: S, risk: M.
  - **1-frame repaint flicker at release for a full-screen TUI** — the CLI's own redraw after SIGWINCH; likely NOT fixable our side (accept as inherent unless a paint-coalescing trick is found).
  Trigger: build when resize text-rendering roughness is reported again, or before claiming the pane terminal "fully polished." Severity: low. Effort: S–M.

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

- **[mcp] detect repeated stdio MCP starts under one Codex/Claude pane** — a single pane can accumulate multiple `@claude-flow/cli mcp start` descendants. Investigate whether this is Codex plugin behavior, config reload behavior, or a leaked child cleanup issue once diagnostics can show child process history.

- ~~🐞 **[medium] `+ Pane` dead on a resumed/restored workspace — swarm comes back `paused`**~~ → **promoted to ROADMAP Phase 3** (2026-06-10). Design fork settled: auto-resume on `+ Pane` click via new `swarms.resume` RPC (`completed` stays gated); PR #134's `unfailZombieSwarms` already covers the common zombie case. Spec: `app/docs/superpowers/specs/2026-06-10-command-room-interaction-reliability-design.md`.

- ~~🐞 **[high] Jorvis `launch_pane` tool spawns panes that never appear in the Command Room**~~ → **promoted to ROADMAP Phase 3** (2026-06-10). Approach settled: thread `emit` into `ToolContext` and echo `assistant:dispatch-echo` per spawned session (option A — keeps the tool's workspaceRoot contract). Spec: `app/docs/superpowers/specs/2026-06-10-command-room-interaction-reliability-design.md`.

- ~~🐞 **[medium] dropping/pasting a screenshot into a terminal pane never reaches the agent as an image**~~ → **promoted to ROADMAP Phase 3** (2026-06-10). Mechanism settled: stage-to-temp-file + absolute `@path` (clipboard-write is upstream-broken for Claude Code — `«class PNGf»` bug, see ROADMAP ADR-003). Full root cause + research citations preserved in the spec: `app/docs/superpowers/specs/2026-06-10-command-room-interaction-reliability-design.md`.

- ~~🐞 **[medium] no Copy/Paste on right-click inside a terminal pane**~~ → **promoted to ROADMAP Phase 3** (2026-06-10). Settled: Copy/Paste menu items via new `getCached()` accessor + `copyOnSelect:true` (operator opted in). Full wiring plan in the spec: `app/docs/superpowers/specs/2026-06-10-command-room-interaction-reliability-design.md`.

- **[refactor] extract `usePaneImageStaging` hook from `PaneShell.tsx`** — Phase 3 (#137) pushed `app/src/renderer/features/command-room/PaneShell.tsx` to ~732 lines (>500 guideline; pre-existing debt + ~80 new lines from copy/paste + image drop/paste). Extract the image-staging concern (`arrayBufferToBase64`, `stageAndInsertImages`, the drop image-branch, the capture-phase paste effect) into `usePaneImageStaging.ts` to shrink PaneShell + give the image feature its own testable unit. Pure mechanical move; no behavior change. Effort: S.

- **[cleanup] janitor sweep for `<userData>/staged-images/`** — `panes.stageImage` (#137, ADR-003) writes dropped/pasted screenshots to `<userData>/staged-images/sigmalink-img-*.<ext>` and never deletes them → unbounded growth (transient prompt inputs). Add a boot-janitor sweep (e.g. delete files older than 7d) mirroring the existing worktree reaper. Handler: `app/src/main/core/workspaces/stage-image.ts` (dir owner) + the boot janitor. Effort: S.

- 🐞 **[low] verify `add_agent` / `create_swarm` Jorvis panes render live without a workspace reopen** — Phase 3 fixed `launch_pane` to emit `assistant:dispatch-echo`, but `add_agent` (`tools.ts`) and `create_swarm` also spawn panes and emit NO echo (the same sibling gap). Likely masked because the echo handler's swarm-refetch path (`use-jorvis-dispatch-echo.ts`) also hydrates swarm panes on workspace events — but confirm a Jorvis `add_agent`/`create_swarm` surfaces the pane in the grid LIVE (no reopen). If not, emit the echo from those handlers too. Severity: low (mitigated). Effort: S. [[grep-sibling-call-sites]]
