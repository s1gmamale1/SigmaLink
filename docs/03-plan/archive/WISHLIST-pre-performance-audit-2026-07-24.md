# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.** Low ceremony.
> Promote an item into [ROADMAP.md](ROADMAP.md) when it gets scoped into a phase.
>
> Buckets: **Deferred by design** (consciously out of scope) and **Future enhancements**
> (planned-later upgrades). **New ideas** is the untriaged inbox.
>
> **Cleared 2026-07-17** after the v3.0.0 cycle closed out (#238 merged). The previous inbox
> (PR #238 review minors, the claude account-switch deep-review findings) is preserved verbatim in
> [docs/03-plan/archive/WISHLIST-v3.0.0-cycle-2026-07-17.md](docs/03-plan/archive/WISHLIST-v3.0.0-cycle-2026-07-17.md)
> — still-alive items get re-promoted from there when they come up.

---

## 🚫 Deferred by design (out of scope for now)

_(consciously NOT built — each is a separate track or a non-goal, not a gap)_

---

## ✨ Future enhancements (planned-later upgrades)

_(real upgrades to build once the current system is production-grade)_

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

### Parked from the pane stale-render fix (2026-07-18, branch `fix/pane-stale-render-esc-focus`)

Four causes were fixed and shipped on that branch (reveal repaint · `window:restored` wiring ·
DECSET 1004 focus reporting · engine notify-loop isolation). These are the **unproven** suspects
that were investigated and deliberately NOT acted on — do not re-derive them from scratch:

- **`content-visibility: auto` steady-state raster (UNPROVEN, low confidence).** FlowView sets
  `content-visibility: auto` + `contain-intrinsic-size` on every row. Theory was that Chromium
  skips re-rastering a row it considers offscreen while the engine keeps rewriting it, stranding
  a stale frame. **Repro attempt failed to reproduce**: a testbed (`electron@30.5.1`, same
  Chromium as the app) replicating FlowView's exact CSS + 50ms live-region repaints + row
  churn + 700↔520px width oscillation for 38s produced clean frames at every capture. So this
  is NOT a steady-state raster bug — which is what pushed the root cause toward the
  reveal/restore path instead. Re-open only if the garbling survives the shipped fixes.
- **Electron 30 → newer bump.** App is pinned at `electron@30.5.1` (May 2024 Chromium). Several
  compositor/`content-visibility` fixes landed upstream since. Not attempted — a major-version
  Electron bump is a release-scale change with native-module (better-sqlite3, node-pty, whisper)
  rebuild blast radius, not a bug-fix-branch move. Worth scoping as its own phase.
- **Live operator verification still owed.** The four fixes are proven by unit tests + a green
  gate, NOT by watching the bug fail to happen. jsdom cannot prove a repaint. Needs: run a
  claude pane, reproduce the garble (resize / minimise-restore / cmd+H), confirm it self-heals
  or never appears. If it STILL garbles, the next suspect is the `LineRow` memo comparator —
  a style-only change outside the 64-row live tail does not re-render (a documented P1b
  limitation, `FlowView.tsx:12-15`), which would strand recolored scrollback specifically.

---

## 🔬 Deep review findings (2026-07-17) — codex pane shows "Pane crashed (exit unknown)" over a LIVE terminal

_Operator report + screenshot: a codex pane (`Lyra · high` / "ruflo superpower bug", `gpt-5.6-sol xhigh`,
cwd `~/projects/SigmaDevelopment`) renders the red **"Pane crashed (exit unknown) — Scrollback preserved
below."** banner + Relaunch button, while the terminal underneath is visibly alive and streaming
(`Working (3m 20s • esc to interrupt) · 1 background terminal running`, live prompt, live status line)._

### Root cause (CONFIRMED — hard receipt, not inference)

**A content scanner reports through the process-death channel. The PTY is never touched.**

`onCodexAuthError` (`app/src/main/rpc-router.ts:1169-1184`) reacts to a **regex match on pane output** by:

1. `getDb().update(agentSessions).set({ status: 'error' })` — status only; **no `exit_code`, no `exited_at`**;
2. `broadcast('pty:error', { sessionId, exitCode: null, signal: null })` — **hardcoded `exitCode: null`**.

…and never kills, stops, or signals the PTY. The renderer's `pty:error` contract is explicitly *"the PTY
started then died"* (`app/src/renderer/features/command-room/PaneShell.tsx:254-264`), so:

- `use-live-events.ts:387` coerces the non-number `exitCode` → `null` → `MARK_SESSION_ERROR`;
- `state.reducer.ts:519` coerces `null` → `undefined` → `CrashBanner` prints **`exit unknown`**
  (`PaneShell.tsx:775`);
- `crashed = errored && !session.error` (`PaneShell.tsx:264`) is true (no launch-error string on this path);
- the banner is designed to **float OVER a still-mounted `SessionTerminal`** (`PaneShell.tsx:763-765`) —
  which is precisely why the live process keeps streaming underneath it.

**Receipt — live DB row (`~/Library/Application Support/SigmaLink/sigmalink.db`, app running, `codex --yolo`
pid 43569 alive at the time of capture):**

| id | provider | status | exit_code | exited_at |
|---|---|---|---|---|
| `1b5582e4-8a4c-4caf-b062-76a35fcb21a9` | **codex** | **error** | **NULL** | **NULL** |
| every other `status='error'` row | shell / claude | error | `0` | `1784…` (set) |

`status='error'` **with both `exit_code` and `exited_at` NULL** is a signature only this path can produce:
grep-verified, the *only* other writers of `status:'error'` to `agent_sessions` are the three
**launch-failure INSERTs** in `core/workspaces/launcher.ts:205,593,759` (each carries an `error:` string →
routes to the *"Failed to launch"* surface, not this one), and `swarms/factory-add-agent.ts:190` writes the
`swarm_agents` table. Every real crash goes through `pty.onExit` and writes exit metadata.

### This is broken even when it is RIGHT

A codex auth error **does not kill the codex process** — codex prints the error and keeps running. So the
"crash" report is a lie *by construction*, 100% reproducible, not a race: **every** firing of this path —
true positive or false — paints "Pane crashed" over a healthy pane and offers a Relaunch button that would
restart a working process. The feature has no correct outcome as wired.

### The trigger (false positive — HIGH confidence)

`scanCodexAuthError` (`app/src/main/core/pty/auth-error-scan.ts`) regex-tests **every codex PTY data chunk**
(`registry.ts:382`). But a codex pane's stream is **the agent's own rendered output** — its reasoning, files
it prints, code and docs it writes — not a clean protocol channel. The patterns are generic enough to appear
in ordinary agent work:

- `/\btoken_expired\b/` — a bare JSON key; appears in any auth code/fixture the agent reads or writes.
- `/HTTP 401|could not be refreshed|sign in again/i` — **`sign in again` is plain English.**

The file header asserts these patterns *"only appear in the process's own error output"* — that assertion is
**false by construction**: `registry.ts:382` feeds the scanner `data`, the whole PTY stream, which conflates
the codex CLI's own stderr with the model's output. The same header records that a `\b401\b` catch-all was
*already* removed for false-positiving on user text — same bug class, incomplete fix. The observed pane was
doing "ruflo superpower bug" + *"Improve documentation in @filename"* — i.e. reading and writing prose.
Introduced in **#207** (`01c3d29`, "Task 5 — codex auth-error scan").

### Blast radius (beyond the cosmetic banner)

- 🐞 **[high] the false `status='error'` write orphans a LIVE pane from boot-resume** —
  `resume-launcher.ts:342-366` `listEligibleRows` resumes only `status='running'` OR
  (`status='exited'` AND `exit_code=-1`). An auth-scanner-flagged row is **neither** → on next boot the pane
  is silently never resumed. Effort: S (fold into the root fix).
- ⚠️ **[medium][UNVERIFIED] pane-slot collision via the partial unique index** — `agent_sessions_ws_pane_uq`
  is `ON (workspace_id, pane_index) WHERE pane_index IS NOT NULL AND status IN ('running','starting')`.
  Flipping a live pane to `'error'` **drops it out of the index**, freeing its `pane_index` slot while the
  PTY still runs → a new pane may be spawnable into the occupied slot. Follows from the index definition;
  **not reproduced**. Verify before scoping. Effort: S to test.
- 🧹 **[low] the flag is sticky with no recovery path** — `registry.ts:212,382,386` sets `authErrors` once per
  session and only clears it in `forget(id)` (`registry.ts:616`, i.e. on PTY death). A re-auth mid-session
  never clears the pane's error state; only a Relaunch does. Effort: S.
- ℹ️ **[low] the 'error' row is GC-immune** — `state.reducer.ts:505-509` deliberately exempts `'error'` from
  the exited-session GC (correct for real crashes), so a falsely-flagged pane lingers in the error state for
  the life of the window.

### Fix direction (not yet scoped — needs a call)

The structural fix is to **stop reporting a content detection on the process-death channel**. Options:

1. **Own channel (recommended)** — emit a distinct `pty:auth-error` → a *warning* chip/toast on a pane that
   stays `running`. Never writes `status`, never offers Relaunch. Kills the whole class: an advisory can't
   masquerade as a death.
2. **Narrow the scanner** — anchor patterns to codex's own error framing and/or only scan when the CLI is
   not mid-turn. Reduces false positives but does **not** fix "true positive still paints a crash".
3. **Drop the scan** — #207's Task 5 as wired has no correct outcome; deleting it is strictly better than
   today's behavior.

(1) is the standard-first fix; (2) alone is a symptom patch. Grep the sibling `pty:error` broadcast sites
(`rpc-router.ts:1729,1739,1785,2213,2888,3044,3127`) when touching the channel — they are the legitimate
crash-classifier callers and must keep their real payloads. Adding a channel = 4 mirror sites
(`shared/rpc-channels.ts:420` allowlist included) or preload silently rejects it.

### ✅ FIXED (2026-07-17, same branch) — option 1 built

TDD'd on `fix/codex-false-crash`: dedicated **`pty:auth-error` advisory channel**
(`{ sessionId, kind, atMs }`; EVENTS allowlist + SESSION_ROUTED_EVENTS + parity tests) →
`MARK_SESSION_AUTH_ERROR` sets `session.authError` only — **status/exitCode/exitedAt untouched, pane stays
`running`** → PaneShell renders a dismissible amber `AuthWarningBanner` (no Relaunch; a real crash wins the
surface). `onCodexAuthError` no longer writes the DB or broadcasts `pty:error`; detection + the control-plane
`authErrorSnapshot` surface are unchanged. Kills the false-crash banner AND the boot-resume orphan AND the
slot-collision window structurally (no status flip ever happens on this path). Residual (parked, low):
scanner patterns still generic (`sign in again` is plain English — advisory tier makes misfires cosmetic
now); registry `authErrors` first-detection-only per session (chip is dismissible; clears on relaunch).
Gate: tsc 0 · eslint 0 · vitest 4994/4996 (2 skipped) · build 0.

---

## 🔬 Deep review findings (2026-07-18) — DB session/workspace persistence audit (relaunch · force-quit · rename · perf)

_Full trace of pane persistence for claude/codex panes (spawn INSERT → quit → boot resume → rename), verified
against the LIVE operator DB read-only (291 `agent_sessions` rows, 17 workspaces). Headline: force-quit/crash
is the RELIABLE lane (no writes land → janitor heals → resume); graceful quit is a per-pane race._

### Confirmed bugs

> **2026-07-18 (same day):** the operator's "relaunch resumes an OLD irrelevant session" report led to a
> second investigation pass that found TWO MORE root causes stacked on the first one — (3) boot auto-resume
> was SLOT-BLIND (`listEligibleRows` respawned EVERY open running/exited(-1) row, so stale siblings'
> old conversations came back and out-ranked the operator's actual-latest stranded row; live-DB receipt:
> SigmasDashboard slot 0 had FIVE open rows, boot-eligible 7→3 after the fix) and (4) `handleRelaunch`
> (`CommandRoom.tsx:286`) never wrote `closed_at` on the crashed row (renderer-only REMOVE_SESSION) so
> stale siblings kept accumulating. All four fixed + gate-green on `fix/session-persistence-correctness`:
> quit-time `markAllExpectedExit`, slot-aware ranked eligibility (mirror of lastResumePlan), janitor
> supersession sweep (`closeSupersededPaneRows` — live-DB dry-run: 17 rows healed, 0 running rows touched),
> relaunch row-close, rename carry-forward. Plan:
> `docs/superpowers/plans/2026-07-18-session-persistence-correctness.md`.

- ~~🐞 **[high, S] quit-window race strands live panes as `status='error'`**~~ → **FIXED on
  `fix/session-persistence-correctness`** (2026-07-18): `registry.markAllExpectedExit()` before `killAll()`
  + SOURCE-ordering test (`rpc-router.shutdown-order.test.ts`). Original finding kept below for the record.

- 🐞 **[high, S] quit-window race strands live panes as `status='error'` — silently excluded from boot
  auto-resume AND the "Respawn fresh" bucket** — `shutdownRouter` (`app/src/main/rpc-router.ts:3671-3724`)
  flips `routerShuttingDown` (suppresses notifications only) then `killAll()`; `PtyRegistry.killAll`
  (`app/src/main/core/pty/registry.ts:635`) never sets `expectedExit`, and the quit sequence deliberately
  holds the DB open ≤2.5s (`waitForPidsExit`) for the win32 WAL checkpoint. Any pane whose process dies
  inside that window fires onExit → `isPtyCrash(false, code 0, signal 15)` → crash → `status='error'` LANDS
  (`app/src/main/core/workspaces/launcher.ts:678-702`; twin `resume-launcher.ts:296-339`). Boot auto-resume
  eligibility is `status='running' OR (exited AND exit_code=-1)` (`resume-launcher.ts:342-368`); the
  respawn-fresh bucket is `exited/-1` only (`resume-launcher.ts:474-502`) — `'error'` rows are in NEITHER,
  so the pane simply never comes back (no toast either — it's filtered out of the SQL, not "failed").
  Slow-dying panes escape (write lands after `closeDatabase` → swallowed → row stays `running` → boot
  janitor heals to exited/-1 → resumes fine). **Live-DB receipts: 128 open `exited/-1` rows (janitor lane,
  works) vs 3 open stranded `error/0` rows (race fired); 118 `error/0` rows with `closed_at` set are
  deliberate closes — harmless, the PR #221 shield working.** Fix (structural — one lane for ALL quits):
  mark every live record expectedExit before `killAll()` (e.g. `registry.markAllExpectedExit()`, mirroring
  `markExpectedExit` `registry.ts:528`) so quit-time exits skip the status write entirely and every pane
  rides janitor→exited/-1→resume. All three exit-writer twins already honor `rec.expectedExit`
  (`launcher.ts:684`, `resume-launcher.ts:308`, `swarms/factory-spawn.ts`). Win32 likely strands MORE
  (taskkill is faster than SIGTERM-drain).

- ~~🐞 **[medium, S-M] operator pane rename lost on the workspace-picker resume lane**~~ → **FIXED on
  `fix/session-persistence-correctness`** (2026-07-18): `name` + `display_provider_id` carry-forward inside
  the insert txn (`workspaces/launcher.ts`), keyed on `(workspace_id, external_session_id)`. Original
  finding kept below for the record.

- 🐞 **[medium, S-M] operator pane rename (`agent_sessions.name`) lost on the workspace-picker resume
  lane** — rename persists via `panes.rename` (`rpc-router.ts:1985-2007`, immediate DB write → crash-safe)
  and survives boot auto-resume because `resumeWorkspacePanes` reuses the SAME row in place
  (`markResumeRunning`, `resume-launcher.ts:284-294`). But reopening a workspace through the launcher
  picker (SessionStep → `panes.lastResumePlan` → `executeLaunchPlan`) INSERTs a brand-new row with
  `name: null` (`workspaces/launcher.ts:532-557`, explicit at `:664-666`); `lastResumePlan` doesn't even
  return `name` (`rpc-router.ts:1820-1858`). The new row wins rank-then-filter (`rn=1`: running + newest
  first) in `listForWorkspace` (`rpc-router.ts:1900-1923`), shadowing the old named row forever →
  "Wren → Frontend-Agent" reverts to the alias. Fix: inside the insert transaction, carry `name`
  (+ `display_provider_id`) forward from the newest open row with the same `external_session_id`
  (fallback key: same `workspace_id`+`pane_index`). NOTE: auto-label can NOT clobber names — NAME and
  SIGMA::LABEL are separate slots; the label is renderer-ephemeral (`PaneHeader.tsx:205-211`).

- 🐞 **[low, M] codex/kimi/opencode external-session-id capture window loses resume-by-id on an early
  crash** — claude's id is pre-assigned at spawn and lands in the INSERT itself (`launcher.ts:527,548`) →
  crash-safe from t=0. codex/kimi/opencode rely on the disk-scan retries at +2/+5/+15s
  (`rpc-router.ts:578-628`); a crash inside that window leaves `external_session_id` NULL → next boot
  deliberately spawns FRESH (session-collapse policy, `resume-launcher.ts:69-89`) → the conversation is
  orphaned (recoverable only via the CLI's own resume picker). Deterministic codex capture via its stdout
  banner is the already-noted follow-up (`resume-launcher.ts:735-738` comment).

### Verified-good (receipts, no action)

- **Force-quit/crash correctness** — deliberate closes write `closed_at` synchronously BEFORE the kill
  (`pty/mark-pane-closed.ts:14-22`); a crash never resurrects a closed pane, and the late `'error'` write
  can't un-close it. Boot janitor heals zombies (`db/janitor.ts:26-50`); PR #221 rank-then-filter
  ghost-resurrection fix intact at both mirror sites.
- **Workspace/room restore** — kv `app.lastSession`; 2s trailing-edge flush caps crash loss at ~2s
  (`session-restore.ts:53-98`); before-quit final flush correctly ordered BEFORE `closeDatabase`
  (`electron/main.ts:1104-1117`).
- **Renames are crash-safe in-session** — written synchronously at rename time; 17 named rows live, all
  currently-running named panes intact (Backend-Agent, Frontend-Agent, SAT-Agent, …).

### PR #240 review minors (parked 2026-07-18 — reviewer verdict GREEN 91/100, merged 255207d)

- 🐞 **[low, S] rename carry-forward misses a janitor-closed row** — `app/src/main/core/workspaces/launcher.ts`
  carry-forward SELECT filters `closed_at IS NULL`; if the boot janitor's `closeSupersededPaneRows` already
  soft-closed the row holding the operator's rename (non-winner sibling) and the operator later picks that
  OLD session from the disk picker, the SELECT matches nothing → name reverts to the alias. NOT a
  regression (this lane always lost the name pre-#240; the common live-winner case IS fixed). Fix: drop the
  `closed_at IS NULL` filter, or order open-first with a newest-closed fallback, so the name follows the
  session id regardless of the sweep — and add a test that actually exercises the WHERE (the current fake
  `get` ignores it).
- **[test, S] slot-rank CTE never runs on real SQLite** — validated via JS mirror + SQL-shape tripwires
  only (better-sqlite3 can't load under vitest); NULL-partition/collation semantics unverified by unit
  tests. Mitigated: byte-for-byte mirror of the shipped PR #221 queries + live-DB dry-runs during the
  audit. Build when a real-SQLite test harness lands.
- **[intended] `markAllExpectedExit` swallows a natural crash inside the ≤2.5s quit window** — the pane is
  auto-resumed next boot instead of surfacing a crash banner. Deliberate tradeoff (resume > stranded
  error at shutdown); recorded so nobody "fixes" it back.

### Optimizations (all LOW — the DB is healthy: 1.4MB, 342 pages, freelist 0, largest table 291 rows)

- **[db] `PRAGMA optimize` on close** — SQLite-recommended one-liner in `closeDatabase()`
  (`db/client.ts:368`). Effort: S.
- **[db] janitor row GC** — purge soft-deleted (`closed_at`) + ancient exited rows older than ~N days;
  keep-set must stay ⊇ resume/rehydrate reads (reaper rule). 291 rows in ~2 months — cosmetic today.
  Build when `agent_sessions` > ~5k rows. Effort: S.
- **[db] periodic `wal_checkpoint(PASSIVE)`** — the only checkpoint today is at quit, and the app now runs
  24/7 (Jorvis). WAL is 523KB — fine. Build when a WAL is observed >16MB mid-run. Effort: S.
- **[ram] non-finding** — main-process scrollback is bounded 256KiB/pane (`pty/ring-buffer.ts:4`, ≈4MB at
  15 panes); SQLite page cache is default (~2MB). DB layer is NOT where SigmaLink's RAM goes — renderer/
  xterm + child CLI processes are. No DB-side action.
