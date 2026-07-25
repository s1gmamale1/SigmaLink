# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.** Low ceremony.
> Promote an item into [ROADMAP.md](ROADMAP.md) when it gets scoped into a phase.
>
> Buckets: **Deferred by design** (consciously out of scope) and **Future enhancements**
> (planned-later upgrades). **New ideas** is the untriaged inbox.

---

## 🚫 Deferred by design (out of scope for now)

_(consciously NOT built — each is a separate track or a non-goal, not a gap)_

---

## ✨ Future enhancements (planned-later upgrades)

_(real upgrades to build once the current system is production-grade)_

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

---

## 🔬 Deep review findings (2026-07-24) — Kimi Code pane compatibility

Investigation into two user-reported Kimi Code issues, run on worktree
`SigmaLink-wt-kimi-code` (branch `fix/kimi-code-pane-rendering`).
Confirmed bugs below are `file:line`-cited with severity and effort.

### A. Pane DOM flickers while Kimi Code streams output

**Key mechanism:** Kimi Code's TUI (OpenTUI inline renderer, verified in the installed
`@moonshot-ai/kimi-code` binary) wraps every repaint frame in **synchronized output**
(`CSI ? 2026 h/l`) and repaints via erase-then-rewrite (`\r\x1B[2K`). It **never enters
the alternate screen** (no `1049`/`1047` in the binary) — so Kimi is the *only* major
provider that renders through SigmaLink's `FlowView`; claude/codex/opencode ride
`GridView` (alt screen), where the same artifacts are far less visible.
`@xterm/headless` 6.0.0 only *tracks* mode 2026 (`synchronizedOutput` flag, DECRQM
answer) — it does **not** defer buffer mutation between BSU/ESU. SigmaLink drops the
sync signal end-to-end.

- 🐞 **[high] Torn frames: 2026 sync-output frames painted mid-frame** — a Kimi repaint
  frame (erase line → rewrite line, tens of KB) is split across node-pty reads and the
  12 ms `PtyDataCoalescer` flush (`app/src/main/core/pty/pty-data-coalescer.ts:42-43,53`).
  The engine mutates the buffer as bytes arrive and the rAF notify
  (`app/src/renderer/lib/terminal-engine.ts:349-369`) can fire between the flush with
  the erases and the flush with the rewrites → FlowView paints the region **blank for
  one frame**, repeatedly, at token rate = persistent flicker.
  Fix: honor sync mode in the engine — register CSI handlers for `?2026h/l` (the
  `watch1006` pattern at `terminal-engine.ts:119-128` is the template) or read
  `term.modes.synchronizedOutputMode`; hold `scheduleNotify` while set, fire one notify
  on ESU. ~15 lines, single choke point. **Recommended first fix.** Effort: S.
- 🐞 **[medium] Scroll-pin churn in FlowView jiggles the whole transcript every frame** —
  `use-stick-to-bottom.ts:53-63` re-pins `scrollTop = scrollHeight` in a layout effect
  on every render plus a rAF re-assert; Kimi's live region re-wraps per token so
  `scrollHeight` oscillates, amplified by `content-visibility: auto` +
  `containIntrinsicSize: auto 17px` estimation (`FlowView.tsx:160-163`).
  Fix: only re-pin when scrollHeight grew beyond slop; drop the unconditional rAF
  re-assert during continuous output. Effort: S.
- 🐞 **[medium] Per-frame O(whole-buffer) extraction saturates the main thread** — every
  notify, `FlowView.tsx:233` calls `engine.logicalLines()` with **no window** (up to
  8000 scrollback rows re-stringified), then ~1500 `LineRow` memos re-compare freshly
  allocated strings (`FlowView.tsx:180-190`). Cost grows with transcript length; dropped
  frames read as flicker. Windowed extraction already exists
  (`terminal-engine.ts:211`) but is unused.
  Fix: window extraction to the render slice and/or cache logical lines between
  notifies; consider 30 fps notify throttle during streams. Effort: M.
- 🐞 **[low] Cursor visibility (DECSET 25) ignored — block cursor teleports during
  repaints** — both views render the block cursor unconditionally (`FlowView.tsx:129-159`,
  `GridView.tsx:38-67`); `terminal-engine.ts:196-202` doesn't even expose `cursorHidden`.
  Kimi hides the cursor while painting.
  Fix: expose `cursorHidden` in `modes`, gate the cursor span on it. Effort: S.
- **Ruled out:** missing batching (present at both layers: 12 ms main coalescer + rAF
  engine notify); React per-chunk state churn; remount/dispose cycles; Kimi-specific
  env/TERM handling (identical spawn env for all providers, `local-pty.ts:543-548`).
  The current branch `fix/pane-stale-render-esc-focus` is orthogonal — it targets
  restore-from-hidden/focus, not the streaming path (verified via diff).

### B. Pane label resets to the SigmaLink default when Kimi Code renames its session

**Context:** the header shows two slots (`PaneHeader.tsx:210-211`): **NAME**
(persisted `agent_sessions.name`, written only by `rpc.panes.rename` /
`set_pane_label`) and **LABEL** (ephemeral store `app/src/renderer/lib/pane-labels.ts:36-75`,
fed by (1) `pane-prompt-capture.ts` → cloud summarizer on every typed Enter, and
(2) `label-reader.ts` → `onAgentLabel` on a `SIGMA::LABEL` sentinel — **now dead code**,
the claude-only injection was removed and Kimi never emits it).

- 🐞 **[high] OSC 0/1/2 terminal titles are ingested nowhere** — the only OSC handler in
  the codebase is OSC 133 shell integration (`app/src/renderer/lib/terminal-engine.ts:134`).
  No `registerOscHandler(0|1|2)`, no `onTitleChange` anywhere; main-process byte scanners
  explicitly skip OSC. Kimi's rename title is consumed by xterm internally and dropped —
  the label stays whatever SigmaLink computed.
  Fix: add an OSC title sink mirroring the OSC-133 pattern (`registerOscHandler(2 /*and 0*/)`,
  sanitize, feed `onAgentLabel` — reuses the existing "agent override supersedes in-flight
  summary" plumbing, `pane-title-orchestrator.ts:47-51`). Effort: S–M.
- 🐞 **[high] Prompt-capture titler is last-writer-wins with no lock — renames get
  clobbered** — typing `/rename …` commits as a "prompt" (`pane-prompt-capture.ts:61-73`)
  and the summarizer retitles from it; the next substantive Enter overwrites it
  (`pane-title-orchestrator.ts:42`), and the generation counter (`:23-25,40-41`) can drop
  the rename-derived summary entirely inside the ~2 s window. No
  `labelLocked`/`customLabel`/`titleSource` concept exists.
  Fix: (a) give agent-provided titles a precedence tier above prompt summaries
  (`titleSource` flag in `pane-labels.ts` blocking `onPrompt` overwrites until a genuinely
  new task); (b) skip slash-command lines in `pane-prompt-capture.commit()` — a leading
  `/` is a CLI command, not a task, and shouldn't reach the cloud titler (privacy win too).
  Effort: S–M.
- 🐞 **[medium] Label-store GC clear can resurrect the default floor** — `clearAgentLabel`
  in `use-terminal-cache-gc.ts:56` fires when a session id transiently vanishes from
  `state.sessionsByWorkspace`; header then falls back to
  `summarizePrompt(session.initialPrompt)` = the SigmaLink default. A PTY burst →
  session-list refresh that transiently omits the session would produce exactly the
  reported "reset to default name".
  Fix: require N consecutive absent ticks before clearing. Effort: S.
- 🐞 **[low] NAME slot never agent-writable** — `PaneHeader.tsx:131-137` resyncs
  `localName` from the `session.name` prop on every session-prop change; Kimi's on-disk
  session name (`~/.kimi/sessions/<uuid>/state.json`) is read only for the resume picker
  (`session-disk-scanner.ts:617` maps `data.model`→`title`, never the session name).
  Fix: extend the kimi disk-scan capture to write `agent_sessions.name` only when the
  operator hasn't manually renamed. Effort: M.
- **Open question (needs a live probe):** what Kimi CLI actually emits on rename
  (OSC 0 vs 2 vs buffer text) — register a temporary OSC handler and log before
  implementing the OSC sink. Effort: S.

### C. `+` pane / Workspaces launch of kimi fails after updating Kimi Code (typed `kimi` in a plain terminal works)

**What changed on the kimi side (verified on disk):** Kimi migrated from the old Python
`kimi-cli` (config in `~/.kimi`) to a single-binary `kimi-code` v0.29.1 living **only**
at `~/.kimi-code/bin/kimi` (`which -a kimi` = exactly one hit; `~/.kimi/.migrated-to-kimi-code`
+ migration report confirm it ran Jul 24 02:03 local). The migration added
`export PATH="$HOME/.kimi-code/bin:$PATH"` to `~/.zshrc:30`. That dir is in **no**
system/default PATH — only fresh login shells see it.

- 🐞 **[critical] Stale `PATH` in the Electron main process — pre-flight ENOENT before
  any PTY spawns** — the app spawns kimi by bare name (`command: 'kimi'`,
  `app/src/shared/providers.ts:168-190`), and `spawnLocalPty` does a **synchronous
  pre-flight PATH resolution against Electron's own `process.env.PATH`**, throwing
  ENOENT before spawning: direct mode `app/src/main/core/pty/local-pty.ts:520-535`,
  shell-first mode (the default) `local-pty.ts:713-727` (H-9). `resolveAndSpawn` then
  throws `ProviderLaunchError('spawn-failed')` (`app/src/main/core/providers/launcher.ts:403-410`)
  → pane error banner via `app/src/main/core/workspaces/launcher.ts:746-756`. The PTY
  never starts. Electron's PATH is only enriched with the login-shell PATH by
  `startShellPathBootstrap`, which is a **no-op in dev**
  (`app/src/main/core/util/shell-path.ts:87-90` `isDev` check; wired at
  `electron/main.ts:978-989`) — a dev app keeps the PATH of whatever shell started it.
  The packaged app is also suspect: its cache
  `~/Library/Application Support/SigmaLink/shell-path-cache.json` (dated Jul 21)
  predates the migration, a warm boot applies it instantly (`shell-path.ts:92-101`),
  and `whenShellPathReady()` resolves immediately on a cache hit (`shell-path.ts:116`).
  A **plain terminal pane works** because it spawns `zsh -l` (`local-pty.ts:128-131`),
  which sources `~/.zshrc` itself. Verified: fresh `zsh -ilc` PATH has
  `~/.kimi-code/bin` at #1; the app's cached PATH lacks it entirely.
  Fix: don't let Electron's PATH hard-gate a binary the pane's own login shell can
  resolve — in shell-first mode either (a) skip/downgrade the H-9 pre-flight ENOENT
  throw (the injected `kimi` line resolves via `.zshrc`; the existing sentinel/exit-127
  path already handles genuine not-found), or (b) on pre-flight miss, lazily re-resolve
  PATH via a `zsh -ilc` probe before giving up. Also make `whenShellPathReady` wait for
  the live resolve instead of resolving instantly on cache hit. Effort: S–M.
  **User workaround until fixed:** restart the app from a fresh login shell (or, for the
  packaged app, wait a few seconds after boot before the first spawn).

**Migration fallout (same root: paths moved `~/.kimi` → `~/.kimi-code`):**

- 🐞 **[medium] MCP autowrite targets the old home** — `app/src/main/core/workspaces/mcp-autowrite.ts:135`
  writes `~/.kimi/mcp.json`; the new binary reads `~/.kimi-code/mcp.json`. Ruflo MCP
  silently stops being injected for kimi. Fix: target the new path with legacy fallback.
  Effort: S.
- 🐞 **[medium] Resume picker scans the old sessions dir** — `app/src/main/core/pty/session-disk-scanner.ts`
  reads `~/.kimi/sessions/<uuid>/state.json`; new sessions live under
  `~/.kimi-code/sessions/` with a different layout (`wd_<name>_<hash>/` buckets +
  `session_index.jsonl`, no `<uuid>/state.json`). Kimi resume-from-picker finds nothing.
  Fix: add the `~/.kimi-code` layout to the scanner. Effort: M.
- 🐞 **[low] Stale install metadata** — `app/src/shared/providers.ts:178-189` still
  claims kimi ships via PyPI (`pip install kimi-cli`); the new distribution is the
  `@moonshot-ai/kimi-code` single binary. The Install button would install the legacy
  package. Effort: S.
- **Ruled out:** version-probe gating (probe is UI-only, doesn't gate `resolveAndSpawn`);
  launch args/env mismatch (identical spawn env to plain panes, no `KIMI_*`/`MOONSHOT_*`
  in shell init); early-death/output sniffing (spawn throws before any PTY exists).

### Related cleanup

- **[kimi-code] Dead `SIGMA::LABEL` label-reader path** — `label-reader.ts` /
  `pane-label-scan.ts:11` scan for a sentinel nothing emits anymore (injection removed,
  per `pane-title-orchestrator.ts:10-11`). Either re-emit the sentinel for supported
  agents or remove the path. Effort: S.

---

## ✅ Promotions + 🔬 follow-up findings (2026-07-24, Phase 1 executed)

Phase 1 ([ROADMAP.md](ROADMAP.md)) was executed via subagent-driven development,
commits `608e062..7d89668` on branch `fix/kimi-code-pane-rendering`
(plan: `app/docs/superpowers/plans/2026-07-24-kimi-code-pane-compatibility.md`).

**Promoted & implemented** (kept above as history):

- ~~**[critical] Stale PATH pre-flight ENOENT breaks kimi launch**~~ → Phase 1 Task 1 (`608e062`).
- ~~**[high] Torn frames: 2026 sync-output painted mid-frame**~~ → Phase 1 Task 2 (`4bdcb39`).
- ~~**[high] OSC 0/1/2 titles ingested nowhere**~~ → Phase 1 Task 3 (`1e49560`) + post-review gate fix (`7d89668`).
- ~~**[high] Prompt-capture titler clobbers renames**~~ → Phase 1 Task 4 slash-skip (`2e9c2c1`);
  the `titleSource` precedence-tier half was superseded by the OSC sink's generation-bump override.
- ~~**[medium] Label-store GC clear resurrects the default floor**~~ → Phase 1 Task 5 (`c17e2f4`).
- ~~**[medium] MCP autowrite targets the old home**~~ → Phase 1 Task 6 (`73d7576`).
- ~~**[medium] Resume picker scans the old sessions dir**~~ → Phase 1 Task 7 (`4838a12`).
- ~~**[low] Stale install metadata**~~ → Phase 1 Task 8 (`cfa452a`).

**Still parked above (not in Phase 1):** FlowView scroll-pin churn, `logicalLines()`
windowing, DECSET-25 `cursorHidden` gating, NAME-slot sync from `state.json`,
shell-path cache freshness, dead `SIGMA::LABEL` reader removal.

**New findings captured during Phase 1 execution:**

- 🐞 **[medium] `verify.ts` + `mcp-diagnostic.ts` still read only legacy `~/.kimi/mcp.json`** —
  `app/src/main/core/ruflo/verify.ts:92`, `app/src/main/core/workspaces/mcp-diagnostic.ts:149`;
  on migrated installs the ruflo verify/diagnostic checks the dead path while autowrite now
  writes `~/.kimi-code/mcp.json`. Fix: mirror the Task 6 modern-first target selection. Effort: S.
- 🐞 **[low] Genuinely-missing CLI now shows a dead pane instead of the install hint** —
  Task 1's soft-miss means POSIX shell-first never reaches the launcher's
  `No usable command found … Install the CLI` error (`launcher.ts:405-410`); a missing
  binary prints `command not found` + exit 127 in the pane. Fix: watch for an immediate
  exit-127 sentinel and surface the provider's install hint in the pane/banner. Effort: M.
- 🐞 **[low] Codex `$`-prefixed skill commands still reach the pane titler** —
  `pane-prompt-capture.ts` skips `/` only; codex skill commands use `$`
  (`insertSkillCommand.ts`). Fix: extend the command-prefix skip to `$`. Effort: S.
- **[hardening] Fix-later batch from the whole-branch review** (all ≤5 lines, one PR):
  prune `missCount` with `everSeen` (`use-terminal-cache-gc.ts:86-88`); one-line `resize()`
  comment re: notify during held sync frame; `onTitleChange` docstring ("raw" → trimmed);
  scanner dedupe root order so modern metadata wins; restore `process.env.PATH` in the
  rewritten local-pty test; OSC 1 handler parity in the engine path (xterm path already
  fires for it); record the node-pty `spawn-helper` chmod env quirk for fresh worktrees
  (a reinstall loses the execute bit and real-spawn tests get the fake `pid:-1` handle).
- **[testing] Cross-task composition tests** — pin the interactions this branch is about:
  a title arriving mid-sync-frame (Tasks 2×3), an OSC rename surviving a transient GC
  miss (Tasks 3×5), and a gated shell pane not forwarding titles end-to-end (Task 3-fix).
