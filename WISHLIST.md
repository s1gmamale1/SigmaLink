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

_(Phase 3 bugs `+ Pane`/`launch_pane`/screenshot/copy-paste shipped in #137 and RELEASED in v2.1.0 — see CHANGELOG `[2.1.0]`; removed from inbox.)_

_(Phase 3 follow-ups — `usePaneImageStaging` extract, staged-image janitor, and `add_agent`/`create_swarm` echo — all SHIPPED in #150 (`ee89fb4`), 2026-06-11; removed from inbox. The echo verify found a real gap (those tools emitted no echo) and fixed it via a shared `emitDispatchEchoes()` helper.)_

- **[perf/UX] `create_swarm` dispatch-echo storm** — Jorvis `create_swarm` emits one `assistant:dispatch-echo` per agent (#150), so a large preset (battalion = 20) fires up to ~20 `panes.list`+`swarms.list` refetches, 20 success toasts, 20 dings, and 20 racing focus-jumps. (`launch_pane` has the same pattern, capped at 8.) Fix: emit ONE consolidated echo from `create_swarm` (or echo only the queen/first agent for focus + let the single refetch hydrate the rest), or add a short coalescing window in `app/src/renderer/features/jorvis-assistant/use-jorvis-dispatch-echo.ts`. Effort: S. [[grep-sibling-call-sites]] (Opus review #150)

- **[cleanup] `create_swarm` echo `error` field + impossible-state test** — the `create_swarm` echo hardcodes `error: null` (#150) while `launch_pane`/`add_agent` carry the real `session.error`; harmless today (the `sessionId !== null` filter excludes failed agents) but `app/src/main/core/assistant/tools.create-swarm-echo.test.ts` asserts an impossible `status:'error'`+non-null-`sessionId` state. Thread the real error if `SwarmAgent` ever carries one, or drop the impossible-state test case. Effort: S. (Opus review #150)
