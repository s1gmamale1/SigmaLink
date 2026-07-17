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
