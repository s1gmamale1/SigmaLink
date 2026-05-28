# SigmaLink — Execution Roadmap (next-phase whiteboard)

> **Ephemeral working doc.** The priority-ordered execution sequence for the
> CURRENT phase, derived from findings captured in `WISHLIST.md`. This is a
> whiteboard — refreshed each phase, **not permanent documentation**. The
> permanent record lives in `CHANGELOG.md`, the master memory
> (`~/.claude/projects/.../memory/`), and the Ruflo AgentDB.
>
> **Shipped baseline: v1.34.0 (2026-05-28).** Work top-down.

---

## 🎯 Sequence (priority order — operator-set 2026-05-28)

| # | Item | Type | Status |
|---|------|------|--------|
| **P0** | SF-12 — pane/worktree/registry confusion | Critical bug | IN FLIGHT |
| **P1** | H-7 — transactional migrations | hardening | next (DB; pair with P0) |
| **P2** | SF-14 follow-up — bundle the `ruflo` daemon binary | product decision | queued |
| **P3** | R-2 follow-up — cursor skill fan-out | small feature | queued |
| **P4** | W-4 P8–P9 + win32 shell-first dogfood | cleanup | deferred (needs win32 dogfood) |
| **P5** | FE-4 a11y follow-ups + blocked voice items | polish | low |

---

### ▶ P0 — SF-12 (CRITICAL) — panes/worktrees/registry mixed up  ·  IN FLIGHT

New finding (operator 2026-05-28), **old latent defect** (predates recent SF waves — not a regression). Two defects:
- **A — wrong/stale session in a slot.** `pane_index` allocated position-based `0..N-1`, never reconciled → reuse. `panes.listForWorkspace`/`lastResumePlan` (`rpc-router.ts`) resolve a `(workspace_id,pane_index)` slot by **status-blind `MAX(started_at)`**; `started_at` is **mutated on resume** (`markResumeRunning`, `pty/resume-launcher.ts`) → exited/older session outranks live; ties → 2 rows/slot. Launcher UNIQUE-violation branch (`workspaces/launcher.ts`) leaves an orphan PTY (no DB row).
- **B — panes vanish on reopen.** `+Pane`/swarm panes inserted with `pane_index = NULL` (`swarms/factory-spawn.ts`) → filtered out by `listForWorkspace`.

**Tier 1 — low-risk, NO sign-off (do first):** (a) read-path status-aware + deterministic (prefer live, tiebreak `started_at DESC, id DESC`, dedup 1 row/slot); (b) launcher UNIQUE-suppression → kill+forget orphan PTY (mirror factory-spawn). Pure code, no data mutation. Overlaps `launcher.ts`/`factory-spawn.ts` (carry SF-15 edits) — apply on top.
**Tier 2 — needs OPERATOR SIGN-OFF:** pane_index allocation reconciliation (lowest-free/`MAX+1` in a txn) + persist pane_index for +Pane/swarm (fixes B) + **reversible no-blind-delete repair migration** (preimage backup → re-slot live rows, null terminal slots). Diagnostic SQL in memory `project_sf11_15_breakage_batch`.

### ▶ P1 — H-7 — transactional migrations  ·  next (pair with P0)

`core/db/migrate.ts` runs `m.up()` + the `schema_migrations` insert with no wrapping txn → half-applied migration re-runs on a dirty schema. **Known-hard:** naive outer `db.transaction()` crashes fresh-DB startup (migrations 0003/0006/0015/0018 self-`BEGIN`/`COMMIT` → nested-BEGIN throw; tried + reverted; only full e2e caught it). Proper fix = strip each migration's own BEGIN/COMMIT so the runner owns one txn + add `busy_timeout`. Real-DB-tested. DB-adjacent to P0.

### ▶ P2 — SF-14 follow-up — bundle the `ruflo` daemon binary  ·  product decision

Daemon resolves `ruflo` on PATH → else `npx -y @claude-flow/cli@latest` (loud "DAEMON UNAVAILABLE" when neither). Binary isn't bundled → first-run depends on npx/network. Decide: (a) bundle `ruflo` on PATH, or (b) point the daemon at the lazy-installed CLI (`<userData>/ruflo/...`) — needs verifying that bin's HTTP support + `-t http`.

### ▶ P3 — R-2 follow-up — cursor skill fan-out  ·  small

`skills/types.ts` `ProviderTarget` is a fixed `claude|codex|gemini` enum (exhaustive `never` in `fanout.ts::targetDirFor`). Verify cursor's on-disk skill layout (`.cursor/rules/` vs a Claude-style skill dir — may be a no-op if cursor doesn't consume the format), then extend the enum + `PROVIDER_TARGETS` + `isProviderTarget` + a cursor `targetDirFor` branch + renderer badges.

### ▶ P4 — W-4 P8–P9 + win32 shell-first dogfood  ·  deferred

Shell-first is the default since v1.14.0. Remaining: **P8** resume simplification + **P9** drop `external_session_id` (~150 refs) — held until post-flip stability confirmed. **win32 shell-first un-dogfooded** (P5 shipped flagged; H-6 win32 sentinel fixed v1.27.0) — needs an operator Windows dogfood before trusting it. Revert path = `pty.spawnMode='direct'`.

### ▶ P5 — FE-4 a11y follow-ups + blocked voice  ·  low

FE-4 a11y: Tab-containment focus-trap on Task drawers (`TODO(a11y)`); device VoiceOver/Switch-Control QA; `prefers-reduced-transparency` for non-glass surfaces; breadcrumb ~4.3:1 → AA. Voice (blocked behind unshipped builds): PCM sample-rate mismatch; whisper.cpp v1.7.x port; voice-{mac,win} prebuildify silent-no-output; voice-win `IsAvailable()` HMR race.

---

## Operator-owned smokes (parallel, human-QA)
SF-12 repro + `agent_sessions` DB dump (unblocks P0 Tier-2 sign-off) · win32 shell-first dogfood (unblocks P4) · real-bot/real-phone (R-1) · `cursor-agent` login (R-2) · H-19 ingestion-redaction.

## When an item ships
→ move its one-line note to `CHANGELOG.md` + the master-memory project entry + (reusable lessons) Ruflo AgentDB; delete it from this whiteboard. Keep `WISHLIST.md` for new raw findings/ideas.
