# v1.4.7 Bundle — Orchestration Index

> **Release theme**: WISHLIST closure — release v1.4.6 plumbing + finish remaining wishlist items in one tag.
> **Source of truth** for the 11 packets composing v1.4.6-plumbing-then-v1.4.7-content. Each per-packet MD is a stand-alone delegate brief.
> **Estimated effort**: ~5-7 dev days across 4 delegation clusters.
> **Bundle commit**: see `git log docs/03-plan/v1.4.7-bundle/` (this file landed first).

---

## TL;DR — what ships

This bundle has **two halves**:

### Half A — v1.4.6 plumbing (CHANGELOG + version + tag)
Everything in this half is already merged to `main` across 15+ commits since v1.4.5. We only need to capture the release: bump version, write CHANGELOG, write release notes, tag, push.

### Half B — v1.4.7 content (close the WISHLIST)

| # | Title | Tier | Effort | File |
|---|---|---|---|---|
| 01 | v1.4.6 release plumbing | Plumbing | XS | [01-v1.4.6-release-plumbing.md](01-v1.4.6-release-plumbing.md) |
| 02 | Deferred e2e fixes (3 tests from PR #36 follow-up) | P1 (CI) | S | [02-deferred-e2e-fixes.md](02-deferred-e2e-fixes.md) |
| 03 | Pre-existing e2e timeouts (2 tests) | P1 (CI) | M | [03-preexisting-e2e-timeouts.md](03-preexisting-e2e-timeouts.md) |
| 04 | opencode-Qwen silent-fail probe | Info | XS | [04-opencode-qwen-probe.md](04-opencode-qwen-probe.md) |
| 05 | Windows auto-update verification flow | v1.3 platform | S | [05-windows-autoupdate-verify.md](05-windows-autoupdate-verify.md) |
| 06 | OpenCode SQLite direct read | v1.3 feature | S | [06-opencode-sqlite-direct.md](06-opencode-sqlite-direct.md) |
| 07 | Provider auto-install ("kimi not found → install?") | v1.3 feature | M | [07-provider-auto-install.md](07-provider-auto-install.md) |
| 08 | Notifications system + top-right bell | v1.3 feature | L | [08-notifications-bell.md](08-notifications-bell.md) |
| 09 | Native Windows SAPI5 voice binding | v1.3 platform | L | [09-windows-sapi5-voice.md](09-windows-sapi5-voice.md) |
| 10 | Cross-machine session sync | v1.3 feature | L | [10-cross-machine-sync.md](10-cross-machine-sync.md) |
| 11 | v1.4.7 release plumbing | Plumbing | XS | [11-v1.4.7-release-plumbing.md](11-v1.4.7-release-plumbing.md) |

**Funded-only / won't-do (documented, not shipped):**
- EV/OV Authenticode cert ($300-700/yr) — open, no committed funding
- Microsoft Store / WinGet — gated on EV cert
- Apple Developer ID + notarisation — explicitly dropped 2026-05-18 (commit `dd8a42f`)

---

## Release narrative

v1.4.6 quietly shipped 15+ improvements across 5 themes (frameless chrome, x64 macOS voice, CI polish, parchment contrast verify, e2e refresh) but never received a CHANGELOG entry or a tagged release. v1.4.7 fixes this debt and closes the remaining WISHLIST in the same tag.

### Headline content for v1.4.7

- **CI is now reliably green.** All 11 Playwright e2e tests pass (or skip with a documented reason). The 3 e2e tests deferred from PR #36 Followup-2 are fixed; the 2 pre-existing timeout tests (`assistant-cli.spec.ts:27`, `dogfood.spec.ts:357 BUG-W7-006`) are triaged and either fixed or quarantined.
- **Notifications + bell** — the long-deferred v1.3 feature. Three notification sources (PTY exits, swarm broadcasts, Sigma Assistant tool errors), persistent dropdown with read/unread state, top-right Breadcrumb bell.
- **Native Windows SAPI5 voice** — closes the air-gapped/offline voice gap for Windows users. macOS Speech.framework path unchanged; Web Speech API stays as the cross-platform fallback.
- **Cross-machine session sync** — opt-in, push-only, e2ee-via-age. Sigma's conversations + agent_sessions table sync to a user-supplied git remote. Conflict-free via CRDT timestamps (Lamport clock on the snapshot row).
- **Smaller wins**: Windows auto-update verification flow, OpenCode SQLite direct read (skip subprocess), provider auto-install prompt, opencode-Qwen silent-fail finally probed and documented.

### v1.4.6 content (already shipped on main; just needs release plumbing)

- **Frameless chrome cross-platform** — `titleBarStyle: 'hidden'` + WCO insets via `useWcoInsets()` (`145ade8`, `f52a768`)
- **x64 macOS DMG ships working Speech.framework voice** — separate arm64/x64 rebuild path so dlopen no longer fails on Intel Macs (`87b51ba`); installer now serves both arches (`a8920cf`)
- **CI pnpm cache, Electron ABI rebuild, native voice workflow disabled** (`93abe63`, `38964f4`, `fe35ee2`, `f12c656`)
- **Parchment Launch CTA contrast verified WCAG AA** (`b1c533d`)
- **vitest coverage thresholds verified-and-closed** (`df698bd`)
- **Terminal.tsx mount race covered by regression test** (`64f781d`)
- **Playwright e2e smoke refresh** — 4 navTo fixes + native-module ABI doc + Ruflo MCP canonical args test fix (`f546c1d`, `25f2017`, `9211385`)

---

## Delegation matrix

**Cost-aware allocation**: Sonnet drives the data-layer / security-adjacent work (#06, #10). Opus picks the architecture-sensitive feature design (#08 notifications). Qwen carries mechanical bulk (#01 plumbing, #04 probe, #11 plumbing). External CLIs (codex, gemini, kimi, opencode-Qwen) handle the smaller items where input dependence is bounded.

| Cluster | Packets | Primary delegate | Cleanup if needed | Why |
|---|---|---|---|---|
| **α — Plumbing + small wins (parallel-safe)** | #01 + #04 + #05 | **opencode-Qwen** (mechanical) | Sonnet | Plumbing is template-driven (see v1.4.5 plumbing PR). #04 is a 1-hour probe with a deterministic outcome. #05 is documentation-heavy. |
| **β — CI hardening (e2e tests)** | #02 + #03 | **Sonnet** | self | Already triaged in PR #36 Followup-2. The 3 deferred fixes are well-understood; the 2 pre-existing timeouts need real debugging. |
| **γ — Feature work (sequential within cluster)** | #06 → #07 | **Codex via OpenCode** | Sonnet | #06 (OpenCode SQLite) unblocks #07 (auto-install prompt for missing CLIs) because both touch the provider-detection layer. |
| **δ — Big features (parallel-safe)** | #08, #09, #10 | mixed (see per-packet) | Sonnet | Each is L-effort and touches disjoint files. #08 needs Opus for taxonomy decisions. #09 needs Sonnet for node-gyp binding. #10 needs Sonnet for the CRDT design. |
| **ε — Final plumbing** | #11 | **opencode-Qwen** | Sonnet | Same template as #01. Runs LAST after all γ/δ packets land. |

**5 PRs across the bundle.** α can ship as one PR. β, γ as separate PRs. δ as one PR per packet (3 PRs). ε is the closing PR.

---

## Sequencing (what blocks what)

```
#01 (v1.4.6 plumbing — CHANGELOG entry + version) ─── BLOCKING for tag push
   │
   └─→ #02 + #03 + #04 + #05 (parallel-safe; non-blocking)
   │
   └─→ #06 → #07 (sequential; share provider-detection layer)
   │
   └─→ #08 + #09 + #10 (parallel-safe; disjoint files)
   │
   └─→ #11 (v1.4.7 release plumbing — runs LAST after all above merge)
```

Wall-clock: **~5-7 days** with 4 parallel delegates; **~10-14 days** sequential.

---

## Cross-file overlap map (critical — read before delegating)

**Cluster β — e2e tests (#02 + #03)** both touch:
- `app/tests/e2e/dogfood.spec.ts`
- `app/tests/e2e/multi-workspace.spec.ts`
- `app/tests/e2e/assistant-cli.spec.ts` (#03 only)

**Cluster γ — provider layer (#06 + #07)** both touch:
- `app/src/shared/providers.ts`
- `app/src/main/core/providers/launcher.ts`
- `app/src/main/core/providers/detect.ts` (NEW for #07)
- `app/src/main/core/opencode/sqlite-reader.ts` (NEW for #06)

**Cluster δ — big features (#08 + #09 + #10)** touch disjoint files:
- #08 (notifications): `app/src/main/core/notifications/*` (NEW), `app/src/renderer/features/notifications/*` (NEW), `app/src/renderer/features/breadcrumb/Breadcrumb.tsx`
- #09 (SAPI5 voice): `app/src/main/core/voice/native-win.ts` (NEW), `native/voice-win/*` (NEW node-gyp binding), `app/src/main/core/voice/dispatcher.ts`
- #10 (cross-machine sync): `app/src/main/core/sync/*` (NEW), `app/src/main/core/db/migrations/0017_sync_metadata.ts` (NEW), `app/src/renderer/features/settings/SyncTab.tsx` (NEW)

No file overlap among α, β, γ, δ → all four clusters can run fully in parallel after #01 lands.

---

## Critical reuse callouts (DO NOT reinvent)

- **#01 + #11 release plumbing template** — copy v1.4.5's release plumbing PR (`54fb1bb`). Same shape: bump version, write CHANGELOG entry from `git log v1.4.5..HEAD --oneline`, write `docs/09-release/release-notes-1.4.6.txt` (or 1.4.7), update WISHLIST "Recently shipped", append phase to `docs/10-memory/master_memory.md`, push tag.
- **#06 OpenCode SQLite reader** — OpenCode stores sessions at `~/.local/share/opencode/sessions.db` (or `%LOCALAPPDATA%/opencode/sessions.db` on Windows). Schema documented at `~/.claude/skills/orchestrator/SKILL.md` under "OpenCode session storage". Use `better-sqlite3` (already a dep) read-only mode.
- **#08 notifications taxonomy** — reuse the v1.4.1 `sigma_pane_events` table pattern from migration 0014. Notification source events: `pty:exit` (`use-live-events.ts:27`), `swarm:message` (line 39), `assistant:tool-error` (NEW, fire from `runClaudeCliTurn.ts` catch).
- **#09 SAPI5 binding** — mirror `native/voice-mac/` structure for `native/voice-win/`. Node-gyp `binding.gyp` template available at `native/voice-mac/binding.gyp`. SAPI5 COM interface: `ISpVoice` for synthesis, `ISpRecognizer` for STT (offline via `Microsoft Speech Recognizer 5.4` engine).
- **#10 sync CRDT** — Lamport timestamp on each row + last-write-wins per row. NO operational transform; conflicts are tolerated (most recent timestamp wins, both ends keep their version in a `sync_conflicts` table). Use `age` (already considered in v1.3 backlog for encrypted secrets) for e2ee.
- **#02 / #03 e2e fixes** — `app/tests/e2e/smoke.spec.ts:43` has the canonical `navTo()` helper after the v1.4.6 refresh. Copy that into `dogfood.spec.ts`. The `invoke()` helper unwrap pattern is in `app/src/renderer/lib/rpc.ts:16-29`.

---

## Critical gotchas

1. **#01 — v1.4.6 commits cross THREE distinct themes** (frameless chrome, voice x64, CI polish). The CHANGELOG entry must group them under sub-headers: `### Added` (frameless), `### Fixed` (Intel Mac voice + Ruflo MCP test), `### CI` (pnpm cache, electron ABI rebuild, native-prebuild disable), `### Verification` (parchment contrast, vitest thresholds, snapshot race test). Use v1.4.2's structure as the closest template.
2. **#02 — Test 3 (multi-workspace.spec.ts:72) needs an app-side hook.** Either (a) add `sigma:test:reload-sessions` event to `state.tsx` (3 LOC) that calls `panes.listForWorkspace` + dispatches `ADD_SESSIONS`, OR (b) redesign the test to go through the Launcher UI (much more work). Pick (a).
3. **#03 — `assistant-cli.spec.ts:27` 30s composer.fill timeout** — the composer textarea selector `'textarea, [contenteditable="true"]'` matches multiple elements; `.last()` may not be the active composer post-v1.4.1 SigmaRoom split. Inspect the current SigmaRoom DOM and tighten the selector. The `BUG-W7-006` 3-min test timeout in dogfood is harder — `swarms.create` after `workspaces.open` hangs, but the test passed pre-v1.4.5; bisect.
4. **#06 — OpenCode SQLite read MUST be read-only.** Open with `readonly: true` flag; never write. OpenCode may upgrade the schema on its own restart; our reader must tolerate unknown columns and missing tables.
5. **#07 — provider auto-install must NEVER run a network command without explicit user consent.** Show a modal with the exact command (`brew install kimi` / `pip install opencode-cli`) and a single "Install now" button. Track consent per-CLI in `kv['provider.autoinstall.consent.<cliId>']`.
6. **#08 — notification persistence must survive app restart.** New table `notifications` (migration 0017) + an `unread` boolean column. GC: drop read notifications older than 30 days at boot.
7. **#09 — SAPI5 binding loads on app boot, NOT lazy.** The `dispatcher.ts` resolves the native module at module-load time so a corrupted DLL doesn't poison only the first voice action. Match the macOS pattern.
8. **#10 — sync writes MUST be append-only on the remote.** No `git push --force`. Conflicts surface in the renderer as a "review and merge" UX, not a silent overwrite. The user owns the remote (their git account).
9. **#11 — tag push triggers BOTH release-macos.yml AND release-windows.yml.** Don't tag until BOTH the Windows and macOS builds have passed at least one full CI run on `main` (lint+build green, e2e-matrix passing on both runners).

---

## Per-bundle verification gate (pre-tag)

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false             # clean
pnpm exec vitest run                          # baseline + per-packet new tests
pnpm exec eslint .                            # 0 errors, ≤1 pre-existing warning
pnpm run build                                # clean
node scripts/build-electron.cjs               # clean
pnpm exec playwright test tests/e2e/          # ALL 11 tests pass or skip with a documented reason
```

Plus per-packet manual smoke (see each per-packet MD's "Verification" section).

---

## Tag + release sequence (for #11)

After all 10 content packets (#01-#10) merge to `main` and Opus 4.7 reviewer approves each PR:

1. Bump `app/package.json` 1.4.5 → 1.4.7 (skip 1.4.6 — its content rolled in)
2. Prepend `CHANGELOG.md [1.4.6]` entry (everything already on main between v1.4.5 and the start of v1.4.7 work)
3. Prepend `CHANGELOG.md [1.4.7]` entry
4. Write `docs/09-release/release-notes-1.4.6.txt` AND `docs/09-release/release-notes-1.4.7.txt` user-facing 1-pagers
5. Update `docs/03-plan/WISHLIST.md`:
   - Add v1.4.6 + v1.4.7 rows to "Recently shipped"
   - Empty "🔥 In progress"
   - Empty "🔴 P1 — CI is currently red"
   - Empty "🟡 v1.2.x deferred polish"
   - Trim "🟢 v1.3 — User-facing feature work" to only the remaining items (Cross-machine sync if not shipped, etc.)
6. Append Phase 33 (v1.4.6 ship) + Phase 34 (v1.4.7 ship) to `docs/10-memory/master_memory.md`
7. Add T-row entries to `docs/10-memory/memory_index.md`
8. Move `docs/03-plan/v1.4.7-bundle/` to `docs/03-plan/archive/v1.4.7-bundle/`
9. Push `v1.4.7` annotated tag → triggers `release-macos.yml` + `release-windows.yml`
10. Store v1.4.6 + v1.4.7 ship patterns in AgentDB

NOTE: We deliberately skip a separate v1.4.6 tag. The user community is small (Sigma the only operator); double-tagging creates artifact churn for zero gain. v1.4.7's CHANGELOG covers both ship contents in two adjacent sections.

---

## Files in this bundle

```
docs/03-plan/v1.4.7-bundle/
├── 00-INDEX.md                         ← this file
├── 01-v1.4.6-release-plumbing.md
├── 02-deferred-e2e-fixes.md
├── 03-preexisting-e2e-timeouts.md
├── 04-opencode-qwen-probe.md
├── 05-windows-autoupdate-verify.md
├── 06-opencode-sqlite-direct.md
├── 07-provider-auto-install.md
├── 08-notifications-bell.md
├── 09-windows-sapi5-voice.md
├── 10-cross-machine-sync.md
└── 11-v1.4.7-release-plumbing.md
```

## Cross-references

- v1.4.5 ship commit: `54fb1bb` (closest plumbing template)
- v1.4.5 release: 2026-05-17/18
- v1.4.6 work on main: commits `145ade8`..`9211385` (15+ commits)
- WISHLIST snapshot at plan time: `docs/03-plan/WISHLIST.md` (after `dd8a42f`)
- PR #36 Followup-2 deferral details: `BRIEF.md ## Followup-2` in `feat/v1.4.6-playwright-e2e` worktree
- Orchestrator skill: `~/.claude/skills/orchestrator/SKILL.md` (delegation matrix patterns)

---

## Won't-do tier (documented for reviewer)

These wishlist rows do NOT ship in v1.4.7. Reasoning captured here so a future reviewer doesn't reopen them:

| Item | Reason |
|---|---|
| Apple Developer ID + notarisation | Explicitly dropped 2026-05-18 (commit `dd8a42f`) — not selling, won't pay $99/yr. Ad-hoc signing + Gatekeeper README workaround remain canonical. |
| EV/OV Authenticode cert ($300-700/yr) | Funded-only. No committed funding source. PowerShell installer's `Unblock-File` flow remains the documented workaround. |
| Microsoft Store / WinGet distribution | Gated on EV cert. Reopen when EV cert lands. |
| Linux AppImage / .deb | Closed as wontfix 2026-05-16 (architectural decision in WISHLIST.md). |
| React-compiler lint wave (31 errors) | Verified-and-closed in v1.4.5 — already done in v1.1.9 (`d824c42`). Stale BACKLOG row. |
| "Hey Sigma" wake-word | Porcupine licensing forbids bundled key. Decision deferred until monetisation lands. |
