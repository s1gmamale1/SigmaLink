# SigmaLink — Execution Roadmap (next-phase whiteboard)

> **Ephemeral working doc.** The priority-ordered execution sequence for the
> CURRENT phase, derived from findings captured in `WISHLIST.md`. This is a
> whiteboard — refreshed each phase, **not permanent documentation**. The
> permanent record lives in `CHANGELOG.md`, the master memory
> (`~/.claude/projects/.../memory/`), and the Ruflo AgentDB.
>
> **Shipped baseline: v1.35.0 (2026-05-28). H-7 transactional migrations landed on main untagged (`2da0622`, 2026-05-28) — rides the next tagged release.** Work top-down.

---

## 🎯 Sequence (priority order — operator-set 2026-05-28; SF-12 Tier1+2 shipped v1.35.0 + H-7 landed untagged on main)

| # | Item | Type | Status |
|---|------|------|--------|
| **P0** | SF-14 follow-up — bundle the `ruflo` daemon binary | product decision | queued |
| **P1** | R-2 follow-up — cursor skill fan-out | small feature | queued |
| **P2** | W-4 P8–P9 + win32 shell-first dogfood | cleanup | deferred (needs win32 dogfood) |
| **P3** | FE-4 a11y follow-ups + blocked voice items | polish | low |
| (op)   | SF-12 migration `0026` register + ship | operator-owned | dormant pending diagnostic-SQL sign-off |

---

### ▶ P0 — SF-14 follow-up — bundle the `ruflo` daemon binary  ·  product decision

Daemon resolves `ruflo` on PATH → else `npx -y @claude-flow/cli@latest` (loud "DAEMON UNAVAILABLE" when neither). Binary isn't bundled → first-run depends on npx/network. Decide: (a) bundle `ruflo` on PATH, or (b) point the daemon at the lazy-installed CLI (`<userData>/ruflo/...`) — needs verifying that bin's HTTP support + `-t http`.

### ▶ P1 — R-2 follow-up — cursor skill fan-out  ·  small

`skills/types.ts` `ProviderTarget` is a fixed `claude|codex|gemini` enum (exhaustive `never` in `fanout.ts::targetDirFor`). Verify cursor's on-disk skill layout (`.cursor/rules/` vs a Claude-style skill dir — may be a no-op if cursor doesn't consume the format), then extend the enum + `PROVIDER_TARGETS` + `isProviderTarget` + a cursor `targetDirFor` branch + renderer badges.

### ▶ P2 — W-4 P8–P9 + win32 shell-first dogfood  ·  deferred

Shell-first is the default since v1.14.0. Remaining: **P8** resume simplification + **P9** drop `external_session_id` (~150 refs) — held until post-flip stability confirmed. **win32 shell-first un-dogfooded** (P5 shipped flagged; H-6 win32 sentinel fixed v1.27.0) — needs an operator Windows dogfood before trusting it. Revert path = `pty.spawnMode='direct'`.

### ▶ P3 — FE-4 a11y follow-ups + blocked voice  ·  low

FE-4 a11y: Tab-containment focus-trap on Task drawers (`TODO(a11y)`); device VoiceOver/Switch-Control QA; `prefers-reduced-transparency` for non-glass surfaces; breadcrumb ~4.3:1 → AA. Voice (blocked behind unshipped builds): PCM sample-rate mismatch; whisper.cpp v1.7.x port; voice-{mac,win} prebuildify silent-no-output; voice-win `IsAvailable()` HMR race.

---

## Operator-owned smokes (parallel, human-QA)
SF-12 diagnostic SQL on real `agent_sessions` dump (unblocks migration `0026` registration; SQL in `docs/09-release/release-notes-1.35.0.txt`) · win32 shell-first dogfood (unblocks P3) · real-bot/real-phone (R-1) · `cursor-agent` login (R-2) · H-19 ingestion-redaction.

## When an item ships
→ move its one-line note to `CHANGELOG.md` + the master-memory project entry + (reusable lessons) Ruflo AgentDB; delete it from this whiteboard. Keep `WISHLIST.md` for new raw findings/ideas.
