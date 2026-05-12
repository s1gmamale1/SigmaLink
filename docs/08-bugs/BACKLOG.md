# SigmaLink Backlog — Open Bugs + Optimization Targets

> Snapshot at **v1.1.8** (commit `74d33e4`, 2026-05-12).
> Last sweep: 5-coder optimization swarm (bundle -61% gzip, lint -28, tests 128/128).
> Bug ledger details live in [`OPEN.md`](OPEN.md); the v1.1.1 / v1.1.2 / v1.1.3 entries there are CLOSED — see "Shipped & verified" at the bottom of this file.
> Codex v1.1.9 branch update (2026-05-12): app-state selector/slice work, CI cache + coverage + shellcheck hardening, and the remaining React compiler lint wave are implemented in `codex/bug-backlog-pr`. The larger file-size refactors remain open.

## Index

| Bucket | Count | Lives where |
|---|---|---|
| P0 critical | 0 | — |
| P1 functional bugs | 0 | — |
| P2 functional bugs / UX | 2 | [P2 — bugs](#p2--functional--ux) |
| P3 polish | 2 | [P3 — polish](#p3--polish) |
| Provider registry cleanup | 1 | [v1.1.10 providers](#v1110--provider-registry-cleanup-user-requested-2026-05-12) |
| Perf — sustained runtime | 2 | [v1.1.9 perf](#v119--paired-perf-refactor) |
| Quality — refactor | 3 | [v1.1.9 quality](#v119--quality--file-size) |
| Tests / CI | 2 | [v1.1.9 ci](#v119--ci--test-infra) |
| Platform / distribution | 5 | [v1.2 platform](#v12--platform--distribution) |
| Lint — React-compiler family | 31 errors | [v1.1.9 lint](#v119--react-compiler-lint-wave) |
| Funded-only (Apple, Porcupine) | 2 | [Waiting on external](#waiting-on-external--needs-funding) |

---

## P2 — functional / UX

### BUG-W7-015 — "Launch N agents" button low-contrast in light themes
- **Surface**: Workspace Launcher light-theme variants (Parchment, etc.).
- **Issue**: primary CTA reads as a secondary button against the Parchment chrome; cancel/secondary actions look similar.
- **Effort**: XS (~30min) — adjust the variant token in `src/components/ui/button.data.ts` for the `parchment` theme.
- **Defer to**: v1.1.9 polish pass.
- **2026-05-12 check**: Current branch already uses the accent-filled launch CTA and darker Parchment accent tokens; no additional code change was needed in this PR.
- **Source**: [`OPEN.md`](OPEN.md) → BUG-W7-015.

### BUG-W7-000 — Test-runner reports "Electron app failed to launch" intermittently in Phase 3 visual sweep
- **Surface**: `tests/e2e/*.spec.ts` against a fresh kv install.
- **Issue**: Playwright cannot reliably bring the app up cold; first run sometimes hangs on better-sqlite3 module load. Repeating the test in the same run passes.
- **Hypothesis**: race between `electron-builder install-app-deps` rebuild and the test's Electron spawn. Already mitigated by v1.1.5 ad-hoc-sign hook + v1.1.8 NMV test-isolation, but never closed formally.
- **Effort**: S (~2hr) — verify on a clean CI runner with the v1.1.8 install path; close or refile.
- **Defer to**: v1.1.10 — paired with the [Playwright e2e refresh](#v1110--playwright-e2e-refresh) because the focused smoke fails on stale selectors before it can re-verify launch.
- **2026-05-12 check**: Launch step now works locally after `node scripts/build-electron.cjs`; focused smoke still fails later on v1.1.4-stale selectors (see v1.1.10 entry).
- **Source**: [`OPEN.md`](OPEN.md) → BUG-W7-000.

---

## P3 — polish

### Tooltip text "Coming in v1.2" on disabled pane icons
- **Surface**: PaneHeader (v1.1.4) — `Split` (Columns2) + `Minimise` (Minimize2) icons are visual-only placeholders with `disabled` + tooltip.
- **Issue**: V3 mockup showed both as functional. Today they're decoration.
- **Effort**: M (~1d each) — pane splitting needs sub-grid inside one cell; minimise needs collapse-to-footer-chip animation + state slice.
- **Defer to**: v1.2 (alongside notifications + V3 orange brand).

### Gemini pane resume — CLI lacks `--resume`
- **Surface**: `src/main/core/pty/resume-launcher.ts` + provider registry.
- **Issue**: Gemini CLI v0.41+ has no documented resume protocol. SigmaLink's resume launcher skips gemini panes (they respawn fresh on restart).
- **Effort**: External dependency — file an upstream gemini-cli issue. Until then, claude + codex panes resume; gemini doesn't.
- **Defer to**: when upstream lands `gemini --resume <session_id>`.

---

## v1.1.10 — provider registry cleanup (user-requested 2026-05-12)

> Trim the provider registry to the 5 CLIs SigmaLink actually targets. Remove BridgeCode placeholder + Cursor Agent + Shell entry + Aider + Continue. Add Kimi Code CLI as a first-class provider.

### Final provider set

| Provider | Command | Install hint | Notes |
|---|---|---|---|
| Claude Code | `claude` | `npm i -g @anthropic-ai/claude-code` | Already shipping |
| Codex CLI | `codex` | `npm i -g @openai/codex` | Already shipping |
| Gemini CLI | `gemini` | `npm i -g @google/gemini-cli` | Already shipping; `--resume` missing upstream |
| OpenCode CLI | `opencode` | `npm i -g opencode` | Already shipping |
| **Kimi Code CLI** | `kimi` (verify) | TBD — verify npm package name | **NEW** — Moonshot AI's CLI. Was previously documented as "model only, picked per-provider"; promoting to first-class provider |

### Remove

- **BridgeCode** — placeholder for the BridgeMind hosted CLI that never materialised. Currently `bridgecode` entry in `providers.ts` falls back to Claude at spawn time. Drop entirely (registry + README + onboarding + V3-W12-001/002/003 parity tickets).
- **Cursor Agent** — `cursor-agent` binary. Drop.
- **Shell entry** (operator-supplied) — drop the always-available "Shell" pseudo-provider.
- **Aider** — `aider` legacy toggle. Drop.
- **Continue** — `continue` legacy toggle. Drop.

### Touch points (concrete file checklist)

1. `app/src/shared/providers.ts` — provider registry. Drop 5 rows (BridgeCode, Cursor, Shell, Aider, Continue). Add `kimi` row with command + install hint + resumeArgs (verify Kimi CLI supports `--resume <id>`; if not, leave resumeArgs undefined like gemini).
2. `app/src/shared/types.ts` — `ProviderId` union (if string-typed). Update if discriminated.
3. `README.md` provider table at line ~41-51 (Supported agents section). Replace with the 5-row table above. Remove the "kimi-is-a-model-not-a-CLI" paragraph.
4. `app/src/main/core/providers/probe.ts` — version detection probe. Add kimi probe, drop the 5 removed entries.
5. `app/src/main/core/providers/launcher.ts` — `resolveAndSpawn` provider switch. Drop dead branches.
6. `app/src/renderer/features/workspace-launcher/` — provider picker step. Re-test wizard with new 5-provider set.
7. `app/src/renderer/features/onboarding/OnboardingModal.tsx` — provider preflight checks. Drop BridgeCode "coming soon" copy.
8. `app/src/renderer/features/settings/ProvidersTab.tsx` — provider toggles + per-provider config UI. Audit for removed rows.
9. `app/src/main/core/skills/manager.ts` — skills fanout currently targets `~/.claude/`, `~/.codex/`, `~/.gemini/`. Add kimi target path (verify Kimi CLI skill location; default to `~/.kimi/skills/` if undocumented).
10. `app/src/main/core/workspaces/mcp-autowrite.ts` — currently autowrites `.mcp.json` (claude), `~/.codex/config.toml`, `~/.gemini/settings.json`. Add kimi config write if Kimi CLI supports MCP (verify upstream).
11. `app/src/main/core/ruflo/verify.ts` — Ruflo `fast` mode reads back per-CLI MCP entries. Add kimi check.
12. `docs/03-plan/V3_PARITY_BACKLOG.md` — V3-W12-001/002/003 (BridgeCode stub + Kimi demote + Aider/Continue hide). Mark "obsoleted by v1.1.10 cleanup" and close.
13. `docs/03-plan/PRODUCT_SPEC.md` section 4 — provider inventory. Replace.
14. Provider color palette in pane chrome — verify Kimi has a distinct colour (or hash-derive like workspace dots).

### Verify before implementing

- **Kimi CLI install hint** — confirm the actual npm package name. Possibilities: `@moonshotai/kimi-cli`, `kimi-cli`, `@kimicc/kimi-cli`. Run a quick web search OR check `kimi --version` if installed locally.
- **Kimi `--resume` support** — like gemini, may not have a resumable session ID yet.
- **Kimi MCP config** — does Kimi CLI support MCP `mcpServers` in a config file? If not, the autowrite + ruflo verify entries get skipped for kimi.
- **Kimi skills fanout target** — where does Kimi CLI read prompt/extension files? If it has none, skills fanout skips kimi.

### Effort + risk

- **Effort**: M (~1d) — mostly mechanical deletes + one new registry row + README rewrite + 2-3 tests.
- **Risk**: Med — removing the "Shell" pseudo-provider could break the workspace-launcher "blank workspace" flow. Verify Onboarding still works without it.
- **Migration**: existing kv state referencing dropped providers should silently fall back to Claude (already does for BridgeCode). Add a one-time migration that rewrites any `provider_id = 'bridgecode'|'cursor-agent'|'aider'|'continue'|'shell'` rows in `agent_sessions` to `provider_id = 'claude'` so historical workspaces still load.

### Acceptance

- README provider table shows exactly 5 rows: Claude, Codex, Gemini, OpenCode, Kimi.
- `pnpm exec tsc -b` clean (no orphan ProviderId references).
- `pnpm exec vitest run` green; provider-related tests updated.
- Workspace launcher wizard offers 5 providers in the picker.
- Settings → Providers tab lists 5 providers.
- No string `'bridgecode'` / `'cursor-agent'` / `'aider'` / `'continue'` / `'shell'` left in `src/`.

---

## v1.1.9 — paired perf refactor

> Flagged by Phase-1 `perf-investigator` during the v1.1.8 swarm as "higher impact for sustained runtime, but better landed together". Deferred so v1.1.8 could ship cold-boot wins fast.

### `useAppStateSelector<T>` built on `useSyncExternalStore`
- **Surface**: `src/renderer/app/state.tsx` + `state.hook.ts` + 27 consumer files.
- **Issue today**: `useAppState()` returns `{ state, dispatch }` whose ref flips on every reducer call. 27 consumers re-render on EVERY dispatch (PTY exit, swarm message, browser state, 250ms snapshot timer, ephemeral UI flags). 24 of those destructure the full state.
- **Fix sketch**: New `useAppStateSelector<T>(sel, eq?)` built on `useSyncExternalStore` over a tiny event emitter the reducer fans out to. Keep `useAppState()` as a thin alias for migration; opt-in conversion of consumers over time.
- **2026-05-12 status**: Implemented additive `useAppStateSelector` + `useAppDispatch`; converted Command Room, Command Palette, Swarm Room, and Operator Console as the first high-churn consumer wave.
- **Effort**: M (~1d for the hook + emitter; +0.5d per consumer wave of conversions).
- **Risk**: Med — additive (old hook stays), but touches global state. Land alongside the precomputed slice work below for combined acceptance.

### Precomputed `sessionsByWorkspace` + `swarmsByWorkspace` slices
- **Surface**: `src/renderer/app/state.reducer.ts` + 4 consumer files (CommandRoom, CommandPalette, SwarmRoom, OperatorRoom).
- **Issue today**: Reducer rebuilds `Map(state.sessions)` on every `ADD_SESSIONS` / `MARK_SESSION_EXITED`. Four consumers run linear `sessions.filter(s => s.workspaceId === ...)` on every render. Combined with the selector issue above, that's O(N×consumers) wasted work per dispatch.
- **Fix sketch**: Add `sessionsByWorkspace: Record<string, AgentSession[]>` derived slice maintained by the reducer (rebuild on add/remove/exited). Same for `swarmsByWorkspace`. Consumers read the precomputed slice. Additive — old `state.sessions` array preserved.
- **2026-05-12 status**: Implemented and covered by reducer tests for add/exit/remove session paths and set/upsert/end swarm paths.
- **Effort**: S (~3hr).
- **Risk**: Low (additive).
- **Pair with**: `useAppStateSelector` above — together they eliminate the worst sustained-runtime overhead.

---

## v1.1.9 — quality / file size

### Split `swarms/factory.ts` (713 LOC)
- **Surface**: `src/main/core/swarms/factory.ts`.
- **Fix sketch**: Keep `createSwarm`, `addAgentToSwarm`, `listSwarmsForWorkspace`, `loadSwarm`, `killSwarm`, and the public `SwarmFactoryDeps` / `AddAgentToSwarm*` types. Move `spawnAgentSession` + `pickCoordinatorId` + `buildExtraArgs` + `loadAgentSession` into a new `factory-spawn.ts` (private). Target: factory.ts ≈ 380 LOC, factory-spawn.ts ≈ 330 LOC.
- **Effort**: M (~1d).
- **Risk**: Med — internal-API surface change; relies on the existing `factory.test.ts` (added in v1.1.8) plus the v1.1.4 swarm tests to guard.

### Split `runClaudeCliTurn.ts` (709 LOC)
- **Surface**: `src/main/core/assistant/runClaudeCliTurn.ts`.
- **Fix sketch**: Keep `runClaudeCliTurn`, `cancelClaudeCliTurn`, public types, `__reset*` test helpers. Move emit/persist helpers (`streamDelta`, `emitDelta`, `emitState`, `emitFinal`, `emitErrorFinal`, `persistFinal`, `createStdinWriter`, `withTimeout`) into `runClaudeCliTurn.emit.ts`. Trajectory helpers (`recordTrajectoryStep`, `endTrajectory`, `routeToolUse`, `traceToolUse`) into `runClaudeCliTurn.trajectory.ts`. Target: main ≈ 320 LOC.
- **Effort**: M (~1d).
- **Risk**: Med — guarded by `runClaudeCliTurn.test.ts` (830 LOC).

### Reduce `state.tsx` residual from 553 → < 500 LOC
- **Surface**: `src/renderer/app/state.tsx` after v1.1.8 split.
- **Issue today**: provider + IPC-listener effects are 553 LOC — still over budget. Cannot be split without breaking React lifecycle cohesion (useReducer + refs + 14 effects must stay together).
- **Fix sketch**: Extract IPC-event-listener effects into custom hooks: `useSessionRestore`, `useWorkspaceMirror`, `useLiveEvents` (PTY/swarm/browser/skills/memory/review/tasks). Provider becomes ~150 LOC orchestrator, custom hooks ~80 LOC each.
- **Effort**: M (~1d).
- **Risk**: Med — React lifecycle nuances; needs careful effect-dep verification.

---

## v1.1.9 — CI / test infra

### CI workflow `cache-dependency-path` resolves to stale path
- **Surface**: `.github/workflows/lint-and-build.yml`, `e2e-matrix.yml`.
- **Issue**: 4 jobs fail at "Setup Node" because the cache-dependency-path points at a moved lockfile. Local gates all green. Tracked in v1.1.4 release notes, never fixed.
- **2026-05-12 status**: CI cache path now targets `app/package.json`; workflows install with `--no-frozen-lockfile` because this repo ignores `app/pnpm-lock.yaml`.
- **Effort**: XS (~30min) — update the path glob.
- **Risk**: Zero.

### Add `vitest run --coverage` + threshold
- **Surface**: `app/vitest.config.ts` + new CI job.
- **Issue**: 16 test files cover 17/55 main-process modules; the v1.1.8 swarm grew that to maybe 19/55, but no enforcement floor. Future regressions can silently drop coverage.
- **Fix sketch**: `@vitest/coverage-v8` is already bundled. Add baseline threshold (start lenient, e.g. 40% lines), upgrade quarterly. Expose `coverage/index.html` artifact in CI.
- **2026-05-12 status**: Added `pnpm run coverage` and an initial repo-wide ratchet matching the current baseline: 22% lines, 21% statements/functions, 18% branches.
- **Effort**: S (~2hr).
- **Risk**: Low — additive.
- **Source**: v1.1.8 `test-investigator` Win 2.

### Add `shellcheck` step for `app/scripts/install-macos.sh`
- **Surface**: CI workflow.
- **Issue**: today only `bash -n` syntax check guards the install script. `shellcheck` catches real lint (quoting, exit-code handling, etc.).
- **2026-05-12 status**: Added a CI step that installs ShellCheck on Ubuntu and checks `app/scripts/install-macos.sh`.
- **Effort**: Trivial (~10min) — single `shellcheck app/scripts/install-macos.sh` step.
- **Risk**: Zero.
- **Source**: v1.1.8 `test-investigator` finding.

---

## v1.1.9 — React-compiler lint wave

> 31 of the 32 remaining lint errors are React-compiler structural family. They need a dedicated wave because each fix can subtly change render behaviour; not non-breaking-line-edit territory.

| Family | Count | Notes |
|---|---|---|
| `react-hooks/set-state-in-effect` | 16 | Calls `setState` synchronously inside `useEffect`. Most can be replaced by `useMemo` derived state or moved to `useReducer`. |
| `react-hooks/immutability` | 8 | Reassigning props or mutating arrays/objects in renders. Each is a real correctness risk under React Compiler. |
| `react-hooks/exhaustive-deps` | 2 | Stale closure risks. Usually intentional — needs `useCallback` + dep audit. |
| `react-hooks/purity` | 1 | Side effect inside a render path. Hardest to refactor; usually a downstream signal. |
| `@typescript-eslint/no-var-requires` | 1 | One stray `require()` in a `.cjs` shim. |
| `@typescript-eslint/no-explicit-any` | 1 | Remaining `any` after the v1.1.8 cleanup (probably `shared/rpc.ts:5`). |

### Plan
1. Fix `no-var-requires` + `no-explicit-any` first (XS each).
2. Then `exhaustive-deps` + `purity` (S total).
3. Tackle `set-state-in-effect` in 3 sub-waves of ~5 each — easiest first (cached value derivations), hardest last (Composer.tsx + BridgeRoom).
4. `immutability` last — usually exposes deeper architecture issues.

**Total effort**: L (~3-5d sustained).

**2026-05-12 status**: `pnpm run lint` is clean on `codex/bug-backlog-pr`. The fixes cover the remaining `set-state-in-effect`, `purity`, `immutability`, `exhaustive-deps`, and `no-explicit-any` findings from this snapshot. The two canvas physics surfaces retain narrow lint disables for intentional per-frame mutable layout state.

---

## v1.1.10 — Playwright e2e refresh

> Surfaced during the v1.1.9 finalisation pass (2026-05-12). The v1.1.4 V3 visual parity layout broke several smoke-suite selectors; the v1.1.1 BRIDGE→SIGMA rebrand broke the assistant aria-label. The launch path itself now works after `node scripts/build-electron.cjs`, but the in-suite assertions are stale, so BUG-W7-000 cannot be re-verified end-to-end yet.

### Stale selectors in `tests/e2e/smoke.spec.ts`

- `aria-label="Bridge Assistant"` → should be `Sigma Assistant` (v1.1.1 rebrand).
- `Swarm Room` / `Operator Console` direct sidebar lookups → these moved into the top-left `RoomsMenuButton` dropdown in v1.1.4. Selectors need to open the dropdown first.
- `conversationsPanelCount > 0` expectation → the conversations panel surface changed in v1.1.4; assertion no longer matches the new layout.

### Plan

1. Inventory every selector in `tests/e2e/*.spec.ts` against the current `Sidebar` + `Breadcrumb` + `RoomsMenuButton` markup.
2. Replace direct nav lookups with `RoomsMenuButton`-opening flows.
3. Update aria-labels (`Bridge Assistant` → `Sigma Assistant`).
4. Re-verify BUG-W7-000 closure on a clean CI runner: `node scripts/build-electron.cjs` already unblocks the launch step locally; need to confirm in CI matrix.
5. Move BUG-W7-000 to the "Shipped & verified" table once the focused smoke passes a full sweep.

**Effort**: S (~1d) — selector audit + smoke rerun.
**Risk**: Low — test-only changes.

---

## v1.2 — platform / distribution

### Apple Developer ID + notarisation
- **Issue**: every v1.1.x DMG carries an ad-hoc signature (`scripts/adhoc-sign.cjs` from v1.1.5). On first Gatekeeper assessment of a browser-downloaded DMG, macOS surfaces "Apple could not verify SigmaLink..." — recoverable via `xattr -cr` or System Settings → Privacy & Security → Open Anyway, OR bypassed entirely via the v1.1.7 `curl | bash` installer. Real fix is notarisation.
- **Cost**: $99/year Apple Developer Program. No free tier. No open-source exception (FSFE petitioned Nov 2025; no movement).
- **Setup once funded**:
  1. Generate "Developer ID Application" cert via Apple Developer portal; export as .p12.
  2. CI secrets: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK` (base64-encoded .p12), `CSC_KEY_PASSWORD`.
  3. `electron-builder.yml`: `mac.identity: "Developer ID Application: <NAME>"`, `hardenedRuntime: true`, `notarize: true`.
  4. Drop `scripts/adhoc-sign.cjs` + `build/dmg/README — Open SigmaLink.txt` + `scripts/install-macos.sh` (no longer needed).
- **Bonus once shipped**: SigmaLink becomes eligible for Homebrew Cask submission (un-notarised casks removed by Sept 2026 anyway).

### x64 macOS DMG via CI matrix
- **Issue**: every v1.1.x release is arm64-only (Intel-Mac users stuck on v1.0.1). The current local build dance uses `--config.npmRebuild=false` + manual `electron-rebuild` against pinned Electron 30.5.1 — works for one arch at a time.
- **Fix sketch**: GitHub Actions matrix with macOS arm64 + macOS x64 runners, each rebuilding native modules for its arch, then `electron-builder` packs both into a fat DMG OR two arch-specific DMGs.
- **Effort**: M (~1d setup + debug).
- **Pair with**: notarisation (otherwise the x64 DMG hits the same Gatekeeper wall).

### `Split` + `Minimise` pane actions become functional
- **Surface**: PaneHeader (v1.1.4). Today disabled with "Coming in v1.2" tooltip.
- **Effort**: M (~1d each).
- **Risk**: Med — pane grid layout already complex; splitting needs sub-grid; minimise needs collapse-to-chip animation + state slice.

### Notifications system + bell in top-right
- **Surface**: top-right corner of Breadcrumb (v1.1.4 deferred). V3 BridgeMind showed a bell next to the settings gear; SigmaLink doesn't have one because no notification source exists yet.
- **Required first**: define what generates notifications (PTY exits? swarm broadcasts? Ruflo readiness changes? Sigma Assistant tool errors?). Then surface (bell badge → dropdown of recent items).
- **Effort**: L (~3d for source taxonomy + dropdown UI + persistence layer).

### Win SAPI + Linux Whisper.cpp voice
- **Surface**: `src/main/core/voice/*` (currently macOS Speech.framework only).
- **Effort**: L (~3-5d Win SAPI + same for Whisper.cpp).
- **Pair with**: cross-platform installer scripts (v1.1.7 install-macos.sh is mac-only).

---

## Waiting on external — needs funding

### "Hey Sigma" wake-word
- **Blocker**: Porcupine licensing forbids bundled key.
- **Options**:
  1. **Picovoice paid license** — ~$200/mo for 1k users. Bundled key OK.
  2. **whisper.cpp continuous mode** — open source, runs locally, but ~5% CPU per active wake-word listener.
  3. **OS-level integration** — macOS dictation + custom shortcut. No wake-word, but free.
- **Decision needed**: pick option 1, 2, or 3 once monetisation lands.

### Apple Developer Program ($99/year)
- Documented in [v1.2 platform](#v12--platform--distribution) above.

---

## Shipped & verified — closed entries in OPEN.md

These OPEN.md entries still show `**Status**: open` but were resolved by their named version. Verified via release notes + commit history at v1.1.8 (commit `74d33e4`). OPEN.md will be cleaned up in v1.1.9.

| Entry | Closed in | Shipping evidence |
|---|---|---|
| BUG-V1.1.1-01 launch_pane PTY spawn | v1.1.2 | `tools.ts` wired to factory; v1.1.2 release notes |
| BUG-V1.1.1-02 list_active_sessions | v1.1.2 | tools.ts list_* tools added |
| BUG-V1.1.1-03 inter-agent broadcast | v1.1.2 | mailbox group-broadcast fix |
| BUG-V1.1.1-04 Ruflo MCP auto-connect | v1.1.3 | mcp-autowrite + Ruflo supervisor.ensureStarted |
| BUG-V1.1.2-01 Sigma dispatch dead-letter | v1.1.2-rev3 | `mcp-host-server.cjs` MCP stdio bridge |
| BUG-V1.1.2-02 session state not persisted | v1.1.2 | session-restore.ts minimum-viable; v1.1.3 multi-workspace extension |
| BUG-V1.1.3-01 BRIDGE → SIGMA label | v1.1.3 | ChatTranscript.tsx:26 `assistant: 'SIGMA'` |
| BUG-V1.1.3-02 destructive workspace switch | v1.1.3 | `openWorkspaces[]` state model |
| BUG-V1.1.3-03 workspaces don't restore | v1.1.3 | SessionSnapshotSchema array of workspaces |
| BUG-V1.1.3-04 PTY panes don't resume | v1.1.3 | session-id-extractor + resume-launcher |
| BUG-V1.1.3-05 swarm count locked | v1.1.3 | swarms.addAgent RPC + `add_agent` Sigma tool |
| BUG-V1.1.3-06 Ruflo lazy + unverified | v1.1.3 | rufloSupervisor.ensureStarted + verifyForWorkspace |
| BUG-V1.1.3-07 skills not verified per-CLI | v1.1.3 | skillsManager.verifyFanoutForWorkspace |
| BUG-V1.1.4-A "damaged" Gatekeeper verdict | v1.1.5 | scripts/adhoc-sign.cjs |
| BUG-V1.1.5-A unverified-developer dialog | v1.1.7 (curl-bash bypass) + v1.1.6 (in-DMG README) | |
| Bundle bloat (97 KB gzip) | v1.1.8 | React.lazy() room split |
| pty:data 32-listener fan-out | v1.1.8 | renderer/lib/pty-data-bus.ts |
| state.tsx > 500 LOC | v1.1.8 partial (553) | state.types/reducer/hook split; v1.1.9 closes the gap |
| 3 stub schemas | v1.1.8 | rpc/schemas.ts promoted to real zod |
| Dead `utils.ts` exports | v1.1.8 | parseAnsi/mockPTYBridge/generateId/formatDuration deleted |
| 6 NMV-blocked tests | v1.1.8 | vi.mock pattern + src/test-utils/db-fake |

---

## How to use this doc

- **Filing a new bug**: add it to [`OPEN.md`](OPEN.md) using the format at the top of that file; reference it here in the next v1.1.x sweep.
- **Picking work for the next release**: start with `## v1.1.9` sections, ordered by effort-to-impact. Tag the release notes file with the BACKLOG.md entries it closes.
- **Updating this doc**: after each release, move the closed items from their P0..P3 / v1.1.x section into "Shipped & verified" with a row in the table.
- **Long-term planning**: the `## Waiting on external` items only unblock when funding / external CLI updates land. Don't put effort there until the blocker is resolved.
