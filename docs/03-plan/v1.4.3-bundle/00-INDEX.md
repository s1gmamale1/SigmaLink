# v1.4.3 Bundle — Orchestration Index

> **Release theme**: Gemini bridge + pane rehydration + housekeeping + Pane Split feature.
> **Source of truth** for the 6 fix packets composing v1.4.3. Each per-fix MD is a stand-alone delegate brief.
> **Estimated effort**: ~5-7 dev days across 3 delegation packets.
> **Bundle commit**: see `git log docs/03-plan/v1.4.3-bundle/` (this file landed first).

---

## TL;DR — what ships in v1.4.3

| # | Title | Severity | Effort | File |
|---|---|---|---|---|
| 01 | Gemini resume bridge | **P0** | S | [01-gemini-resume-bridge.md](01-gemini-resume-bridge.md) |
| 02 | Pane rehydration on workspace open | **P1** | M | [02-pane-rehydration.md](02-pane-rehydration.md) |
| 03 | Dead-row migration (0016) | **P1** | XS | [03-dead-row-migration.md](03-dead-row-migration.md) |
| 04 | Worktree dedupe / orphan cleanup | P2 | S | [04-worktree-dedupe.md](04-worktree-dedupe.md) |
| 05 | EmptyState defensive UX | P3 | XS | [05-empty-state-affordance.md](05-empty-state-affordance.md) |
| 06 | Pane Split + Minimise (feature) | Feature | L | [06-pane-split-minimise.md](06-pane-split-minimise.md) |

---

## Release narrative

v1.4.3 closes 3 dogfood findings from the v1.4.2 ship + brings forward the v1.4.2-deferred Pane Split feature. The headline fixes:

- **Gemini was broken on every spawn** — SigmaLink passed `gemini --resume <sigmalink-uuid>` but gemini wants `"latest"` or numeric index, AND each per-pane worktree had no session storage. Fixed via `gemini-resume-bridge.ts` mirroring the v1.3.2 Claude bridge.
- **Workspace pane state didn't persist** — was perceived as a v1.4.2 regression but is actually a **pre-existing missing wire**: the renderer never hydrated `state.sessions` from DB on workspace open. New `panes.listForWorkspace` RPC + 3 dispatch sites fix it.
- **"+Pane button broken / triangle box"** — same root cause as the persistence bug. The "triangle box" was the `EmptyState`'s "Go to Workspaces" action; once rehydration delivers sessions, the real button surfaces correctly.
- **Stale DB rows accumulated** — Electron's hard quit never fired the onExit handler, leaving ~30 `status='running'` rows. Migration 0016 marks rows older than 24h as exited; conservative; silent.
- **Orphan worktrees accumulated** — re-creates spawned new worktrees instead of dedupe. Best-effort cleanup on workspace open.
- **Pane Split + Minimise** — the long-overdue "Coming in v1.2" feature, brought forward from v1.4.2 deferred.

---

## Delegation matrix

**Cost-aware allocation**: Sonnet drives the critical data-layer / security-adjacent work (#01, #02, #03, #04). Qwen carries the cosmetic defensive UX. Codex handles the pane-grid feature.

| Cluster | Packets | Primary delegate | Cleanup if needed | Why |
|---|---|---|---|---|
| **C — Gemini bridge** | #01 | **Sonnet (Claude Code)** | self | Surgical refactor mirroring `claude-resume-bridge.ts`. Security-adjacent (writes to `~/.gemini/projects.json`) — don't risk Qwen. |
| **B — Pane lifecycle (sequential within)** | #02 + #03 + #04 *(one PR)* | **Sonnet (Claude Code)** | self | Critical data layer. #03 migration must land WITH #02 (otherwise boot-restore tries to resume dead sessions). #04 layers on top. Single PR keeps the change atomic. |
| **A — Pane-grid features** | #05 + #06 *(one PR)* | **Codex via OpenCode** OR **Opus** | Sonnet | #05 is XS UX. #06 is L-effort feature; needs design judgment for Split modes. Both touch `CommandRoom.tsx` / `PaneHeader.tsx` / `GridLayout.tsx` so bundle into one PR. |

**3 PRs** across 2-3 model classes. Cluster C parallel-safe with both A and B. B is internally sequential.

---

## Sequencing (what blocks what)

```
#03 (migration) ──┐
                  ├─→ #02 (rehydration, builds on clean DB)
                  │     │
                  │     └─→ #05 (EmptyState — defensive UX after #02 delivers sessions)
                  │
                  └─→ #04 (worktree cleanup — depends on #02's accurate session state)

#01 (Gemini bridge) ─── full parallel; different files entirely

#06 (Pane Split) ─── full parallel with everything else; modifies pane-grid files but not pane-lifecycle
```

Wall-clock: **~3-4 days** with 3 parallel delegates; **~6-7 days** sequential.

---

## Cross-file overlap map (critical — read before delegating)

**Cluster A — pane-grid (#05 + #06)** both touch:
- `app/src/renderer/features/command-room/CommandRoom.tsx`
- `app/src/renderer/features/command-room/GridLayout.tsx`
- `app/src/renderer/features/command-room/PaneHeader.tsx`

**Cluster B — pane-lifecycle (#02 + #03 + #04)** all touch:
- `app/src/main/core/db/schema.ts` (#03 migration registration)
- `app/src/main/core/db/migrate.ts` (#03 migration registration)
- `app/src/main/rpc-router.ts` (#02 new RPC + #04 workspace-open hook)
- `app/src/main/core/db/migrations/0016_*.ts` (#03 NEW file)
- `app/src/main/core/workspaces/worktree-cleanup.ts` (#04 NEW file)

**Cluster C — independent (#01)** touches:
- `app/src/main/core/pty/gemini-resume-bridge.ts` (NEW)
- `app/src/main/core/workspaces/launcher.ts:188-224`
- `app/src/main/core/pty/resume-launcher.ts:73-76, 401-420`
- `app/src/main/core/pty/session-disk-scanner.ts:620-622`

No file overlap among A, B, C → all three PRs can run fully in parallel.

---

## Critical reuse callouts (DO NOT reinvent)

- `claude-resume-bridge.ts` at `app/src/main/core/pty/claude-resume-bridge.ts` — direct template for #01 Gemini bridge. Same shape of helper signatures (`<provider>SlugForCwd`, `prepare<Provider>Resume`, `ensure<Provider>ProjectDir`).
- `lastResumePlan` per-pane `MAX(started_at)` join in `rpc-router.ts` — reuse the SQL shape for `panes.listForWorkspace` in #02. **DO NOT** invent a new query; copy the existing one.
- `WorktreePool` at `app/src/main/core/git/worktree.ts` — #04 reads its `baseDir` config to know where worktrees live.
- `addAgentToSwarm()` at `factory.ts:198` — #06's `splitPane` RPC reuses this for the spawn primitive.
- `terminal-cache.ts` from v1.4.2 #03 — #06 sub-panes are real `<SessionTerminal>` instances with own sessionIds; the cache handles their lifecycle transparently.
- Idempotent migration pattern from `0014_sigma_pane_events.ts` + `0015_agent_session_sigma_monitor.ts` — #03 and #06 follow the same `CREATE TABLE IF NOT EXISTS` / PRAGMA introspection style with `BEGIN/COMMIT` + `ROLLBACK` on error.
- `writeFileAtomic` helper (used in `mcp-autowrite.ts`) — #01 uses for atomic `projects.json` writes.

---

## Critical gotchas

1. **#01 — `--resume latest` is NOT a safe fallback for gemini.** Claude's bridge falls through to `--continue` on missing source; gemini has no analog. If `prepareGeminiResume` returns `'missing'`, the launcher MUST drop resume args entirely. Otherwise gemini still exits 1.
2. **#02 — the rehydration RPC must use `MAX(started_at)` per `(workspace_id, pane_index)`.** Without it, multiple historical rows for the same paneIndex (a real issue today per investigation — 24+ rows for one workspace) produce duplicate renderer sessions.
3. **#03 must land BEFORE or WITH #02.** If #02 ships alone, boot-restore tries to resume ~30 dead sessions on first boot. Ordering enforced via the single-PR bundle.
4. **#04 — `agent_sessions.worktree_path` is the link.** Don't delete by directory age — check DB references. Skip cleanup if workspace has NEVER opened (cold install) since worktree dirs may not yet match DB.
5. **#05 — `addPane(defaultProviderId)`**: the existing `addPane` function accepts a providerId; pick the first entry from `rpc.providers.list()` for the empty-state inline button. Cache the result.
6. **#06 — share worktree with parent for split sub-panes.** Each sub-pane has its own PTY + agent_sessions row, but `worktree_path` is the same as the parent. Document explicitly in the per-fix MD.
7. **#01 — Gemini's `projects.json` schema is undocumented.** READ first, MERGE in the new alias, WRITE atomically. If a future gemini release breaks the schema, fail gracefully and spawn fresh (don't crash the pane).

---

## Per-bundle verification gate (pre-tag)

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false             # clean
pnpm exec vitest run                          # 417 baseline + ~25-35 new = ~445-455
pnpm exec eslint .                            # 0 errors, ≤1 pre-existing warning
pnpm run build                                # clean
node scripts/build-electron.cjs               # clean
```

Plus per-packet manual smoke (see each fix MD's "Verification" section).

---

## Tag + release

After all 6 packets merged to `main` and Opus 4.7 reviewer approves each PR:

1. Bump `app/package.json` 1.4.2 → 1.4.3
2. Prepend `CHANGELOG.md [1.4.3]` entry
3. Write `docs/09-release/release-notes-1.4.3.txt` user-facing 1-pager
4. Update `docs/03-plan/WISHLIST.md`:
   - Add v1.4.3 row to "Recently shipped"
   - Remove v1.4.3 from "In progress"
5. Append Phase 29 to `docs/10-memory/master_memory.md`
6. Add T-row entries to `docs/10-memory/memory_index.md`
7. Push `v1.4.3` annotated tag → triggers `release-macos.yml` + `release-windows.yml`
8. Store v1.4.3 ship pattern + Gemini bridge pattern in AgentDB

---

## Files in this bundle

```
docs/03-plan/v1.4.3-bundle/
├── 00-INDEX.md                         ← this file
├── 01-gemini-resume-bridge.md
├── 02-pane-rehydration.md
├── 03-dead-row-migration.md
├── 04-worktree-dedupe.md
├── 05-empty-state-affordance.md
└── 06-pane-split-minimise.md
```

## Cross-references

- v1.4.2 ship commit: `b638082`
- v1.4.2 release: 2026-05-17, 11 assets
- WISHLIST: [`../WISHLIST.md`](../WISHLIST.md) — entry pointing here
- v1.3.2 Claude bridge precedent: `app/src/main/core/pty/claude-resume-bridge.ts`
