# v1.4.2 Bundle — Orchestration Index

> **Release theme**: dogfood fixes + 3 retired ship-claims + completing the pane operations promise.
> **Source of truth** for the 13 fix packets that compose v1.4.2. Each per-fix MD is a stand-alone delegate brief.
> **Estimated effort**: ~7-8 dev days across 7 distinct delegation packets.
> **Bundle commit**: see `git log docs/03-plan/v1.4.2-bundle/` (this file landed first).

---

## TL;DR — what ships in v1.4.2

| # | Title | Severity | Effort | File |
|---|---|---|---|---|
| 01 | Sigma Assistant Windows spawn ENOENT | **P0** | S | [01-sigma-assistant-windows-spawn.md](01-sigma-assistant-windows-spawn.md) |
| 02 | Workspace routing: Settings → Workspace click | P1 | XS | [02-workspace-routing.md](02-workspace-routing.md) |
| 03 | Session freeze + xterm preservation | P1 | M | [03-session-freeze-xterm-preservation.md](03-session-freeze-xterm-preservation.md) |
| 04 | OpenCode pane 6 garbled render on Windows | P2 | S | [04-opencode-pane-font.md](04-opencode-pane-font.md) |
| 05 | "+ Pane" button UX polish | P2 | S | [05-add-pane-ux.md](05-add-pane-ux.md) |
| 06 | Worktree location UX (Option D — discoverability) | P2 | S | [06-worktree-location-ux-option-d.md](06-worktree-location-ux-option-d.md) |
| 07 | Window responsiveness rAF audit | P2 | S+M | [07-responsiveness-raf.md](07-responsiveness-raf.md) |
| 08 | state.tsx LOC split (553 → <500) | P3 | S | [08-statetsx-loc-split.md](08-statetsx-loc-split.md) |
| 09 | Backlog verify-and-close sweep (4 items) | P3 | S | [09-backlog-verify-sweep.md](09-backlog-verify-sweep.md) |
| 10 | Disk-scan provider scoping (R-1.2.8-2) | P3 | S | [10-disk-scan-provider-scoping.md](10-disk-scan-provider-scoping.md) |
| 11 | NSIS welcome page (SmartScreen workaround) | P3 | S | [11-nsis-welcome-page.md](11-nsis-welcome-page.md) |
| 12 | Pane Focus → true fullscreen | Feature | M | [12-pane-focus-fullscreen.md](12-pane-focus-fullscreen.md) |
| 13 | Pane Split + Minimise functional | Feature | L | [13-pane-split-minimise.md](13-pane-split-minimise.md) |

---

## Release narrative

v1.4.2 closes the gap between what v1.4.1 promised (Bridge → Sigma, mailbox back-channel, SigmaRoom split) and what dogfood on macOS + Windows surfaced as broken or under-finished. The bundle ships:

- **One P0 fix** that resurrects Sigma Assistant on Windows entirely (currently dead — `child_process.spawn` doesn't honor `.cmd` shims).
- **Two P1 fixes** that retire surprising user-visible regressions of v1.3.3 (routing) and v1.2.7 (perceived session freeze).
- **Four P2 fixes / UX polishes** including the long-requested +Pane discoverability fix (revelation: the button works; nobody knew how to use it).
- **Four P3 hygiene items** that close three pre-existing ship-claims (R-1.2.7-1 mount race, v1.1.8 state.tsx LOC, R-1.2.8-2 disk-scan scoping) and sweep 4 verify-and-close BACKLOG rows.
- **Two feature completions** (Pane Focus / Split / Minimise) that retire the long-standing "Coming in v1.2" tooltips.

Net effect: the project's "Known issues" section gets meaningfully smaller, the user's mental model of the app finally matches reality on every dogfood point, and the test suite grows from 368 baseline to ~390-400.

---

## Delegation matrix

**Cost-aware allocation**: Qwen is free → he carries the mechanical / refactor / verify / additive-UX bulk (6 packets). Paid models (Sonnet / Opus / Codex / Kimi) reserve their cycles for architecture-critical work AND **cleanup duty** if Qwen's first-pass needs reviewer-flagged fixes.

| Cluster | Packets | Primary delegate | Cleanup if needed | Why |
|---|---|---|---|---|
| **Mechanical refactor / verify / installer / additive-UX** | 02, 06, 08, 09, 10, 11 | **Qwen via OpenCode** | Sonnet | 6 packets that are well-scoped, low-architectural-risk, deterministic. Qwen does the first pass; Sonnet cleans up only if Opus 4.7 reviewer flags issues. |
| **Sigma Assistant cross-platform spawn** | 01 | **Sonnet (Claude Code)** | self | P0 surgical refactor; argv-quoting + cmd-injection surface on user prompt; tests already scaffolded in `runClaudeCliTurn.test.ts`. Don't risk Qwen on a P0 security-adjacent path. |
| **Pane-grid Cluster A** | 03, 12, 07 *(sequential)* | **Opus (single agent)** | self | xterm-preservation is architectural (React 19 `<Activity>` vs terminal-cache decision); fullscreen + rAF audit compose on the new mount semantics. Opus owns through landing. |
| **Pane-grid Cluster B** | 05, 13 *(one PR)* | **Codex via OpenCode** | Sonnet | Mid-complexity UI work + needs design judgment for Split modes (pane-tree vs flat-group). Codex has the right judgment level. |
| **Windows / OpenCode font** | 04 | **Kimi via OpenCode** | self | Windows VM diagnostic-gated, needs interpretation of font fallback / unicode glyph data. Kimi's strength. |

**5 delegate models** running **7 parallel packets** (sequential within Cluster A). **Qwen handles ~46% of packet volume**; paid models handle the architecture-critical 54%.

### Cleanup workflow (when reviewer flags Qwen's work)

1. Qwen ships a packet to a feature branch
2. Lead dispatches Opus 4.7 reviewer (standard quality gate, as we did on v1.4.0 / v1.4.1)
3. If verdict is APPROVE → lead merges. Done.
4. If verdict is APPROVE WITH CAVEATS or REQUEST CHANGES → lead dispatches the matching "cleanup" model (Sonnet for Qwen packets) to fix the flagged issues, then re-reviews. Same pattern as the H1/M1/M2 fix-coder → fix-tester → fix-reviewer chain we ran on PR #15.

This pattern keeps Qwen's free-tier productive without inheriting his ceiling on judgment calls.

---

## Sequencing (what blocks what)

```
01 (P0)  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ship first; unblocks Windows users
02 (P1)  ━━┓
03 (P1)  ━━┫━━━━ unblocks 12 + 07 (pane-grid Cluster A)
04 (P2)  ━━┫     (gated on Windows diagnostic data)
05 (P2)  ━━┫     (gated on user screen recording)
06 (P2)  ━━┫
08-11    ━━┛     parallel hygiene; bundle into one polish PR
                          │
07 (P2) ───────── after 03 lands (composes on new mount semantics)
12      ───────── after 03 lands
13      ───────── alongside 05 (same files, one PR)
```

Wall-clock: **~5 days** with 5 models running in parallel; **~7-8 days** sequential.

---

## Cross-file overlap map (critical — read before delegating)

The **Command-Room / pane-grid cluster** (files 03, 05, 07, 12, 13) all touch:
- `app/src/renderer/features/command-room/CommandRoom.tsx`
- `app/src/renderer/features/command-room/Terminal.tsx`
- `app/src/renderer/features/command-room/GridLayout.tsx`
- `app/src/renderer/features/command-room/PaneHeader.tsx`

**Do not parallel-delegate these 5 packets to 5 different models — they'll collide on merge.**

Sub-clustering:
- **Cluster A** (one Opus delegate, sequential): 03 (xterm preservation) → 12 (fullscreen) → 07 (rAF audit on new mount path)
- **Cluster B** (one Codex delegate, single PR): 05 (+Pane UX) + 13 (Split/Minimise)

Remaining packets (01, 02, 04, 06, 08, 09, 10, 11) share no files among themselves — full parallel.

---

## Critical reuse callouts (from Phase 1 helper-verify)

- `resolveWindowsCommand()` — `app/src/main/core/pty/local-pty.ts:47` (exported, used by `review/runner.ts:72`, `git/git-ops.ts:233`, and internally). **Does NOT gate on `process.platform`** — caller must branch or use `?? cmd` fallback.
- `resolvePosixCommand()` — same file line 101 (exported)
- `platformAwareSpawnArgs()` — same file line 175 (private; pattern to lift for #01)
- `RingBuffer` ctor accepts `limit` override at `ring-buffer.ts:4`; default is **256 KiB, NOT 64 KB** (correcting the original investigator report)
- `rpc.pty.snapshot → { buffer }` and `rpc.pty.subscribe → { history }` — same payload, different field names (`rpc/schemas.ts:81`)
- `shell.showItemInFolder` — already used in `UpdatesTab.tsx` for the DMG flow; reuse for #06
- `addPane()` at `CommandRoom.tsx:201` → `rpc.swarms.addAgent` → `addAgentToSwarm()` at `factory.ts:198` — #13 reuses this primitive

---

## Critical gotchas (from helper-verify)

1. **The "v1.3.3" tag in `state.reducer.ts` is misleading.** Commit `66b4fa6` only touched `Sidebar.tsx` (+11/-1). The reducer-side recall logic at lines 188-198 came in a separate later commit. #02 must not assume both are one fix.
2. **`Sidebar.tsx:62`'s `SET_ROOM: 'command'` is load-bearing** for the "open persisted workspace" path (which goes through `WORKSPACE_OPEN`, not `SET_ACTIVE_WORKSPACE_ID`). Removing it would break re-open. #02 must extend the guard at line 99, not remove line 62.
3. **`CommandRoom.tsx:182` is a THIRD `SET_ROOM` dispatch site** (`SET_ROOM: 'workspaces'`). #02 audit should be aware even though no fix needed there.
4. **Ring buffer is 256 KiB not 64 KB.** Any claim about "64KB ring buffer truncation" is wrong by 4×. Real issue is still IPC drop window + xterm remount, not buffer overflow.

---

## Per-bundle verification gate (pre-tag)

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false              # clean
pnpm exec vitest run                          # 368 baseline + ~20-30 new = ~390-400
pnpm exec eslint .                            # 0 errors, ≤1 pre-existing warning
pnpm run build                                # clean
node scripts/build-electron.cjs               # clean
```

Plus per-packet manual smoke (see each fix MD's "Verification" section).

---

## Tag + release

After all 14 packets merged to `main` and Opus 4.7 reviewer approves each PR:

1. Bump `app/package.json` 1.4.1 → 1.4.2
2. Prepend `CHANGELOG.md [1.4.2]` entry
3. Write `docs/09-release/release-notes-1.4.2.txt` user-facing 1-pager
4. Update `docs/03-plan/WISHLIST.md`:
   - Add v1.4.2 row to Recently shipped
   - Move closed items out of "v1.2.x deferred polish" and "v1.3 user-facing feature work"
5. Append Phase 28 to `docs/10-memory/master_memory.md`
6. Add T-row entries to `docs/10-memory/memory_index.md`
7. Push `v1.4.2` annotated tag → triggers `release-macos.yml` + `release-windows.yml`
8. Store v1.4.2 ship pattern + the bundle pattern in AgentDB

---

## Files in this bundle

```
docs/03-plan/v1.4.2-bundle/
├── 00-INDEX.md                              ← this file
├── 01-sigma-assistant-windows-spawn.md
├── 02-workspace-routing.md
├── 03-session-freeze-xterm-preservation.md
├── 04-opencode-pane-font.md
├── 05-add-pane-ux.md
├── 06-worktree-location-ux-option-d.md
├── 07-responsiveness-raf.md
├── 08-statetsx-loc-split.md
├── 09-backlog-verify-sweep.md
├── 10-disk-scan-provider-scoping.md
├── 11-nsis-welcome-page.md
├── 12-pane-focus-fullscreen.md
└── 13-pane-split-minimise.md
```

---

## Cross-references

- v1.4.1 ship commit: `1c4f71a release(v1.4.1)`
- Dogfood doc commit: `a0dc63d docs(v1.4.2): capture v1.4.1 dogfood findings`
- Bundle creation commit: this commit (see `git log`)
- WISHLIST: [`../WISHLIST.md`](../WISHLIST.md) — entry pointing here
- BACKLOG.md DOGFOOD-V1.4.2-01/02 rows: [`../../08-bugs/BACKLOG.md`](../../08-bugs/BACKLOG.md) — keep as ledger entries; implementation lives in this bundle
