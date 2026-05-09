# Engineering Risk Critique

Compiled: 2026-05-09. Pre-mortem of `BUILD_BLUEPRINT.md` + `PRODUCT_SPEC.md` against the `02-bug-sweep.md` defect inventory and the `CONFLICTS.md` resolutions. Treat this as the sequence of failures most likely to derail v1.

## Summary

- 5 CRITICAL, 7 HIGH, 6 MEDIUM, 4 LOW.
- Top 5 risks that could derail the build:
  1. **R1** — Phase 1.5 understates the foundation work. Several "Phase 4/5/6" features depend on plumbing the blueprint never schedules (MCP config writer, structured logger, settings RPC). These will be discovered during integration, not planning.
  2. **R2** — The preload allowlist in Phase 1.5 is one half of a two-half job. Without zod payload validation in the main router, a renderer-side compromise still gets RCE through allowed channels (`git.runArgv`, `workspaces.launch`, `pty.create`).
  3. **R3** — Native module rebuild (`better-sqlite3`, `node-pty`) is "configured" but never reproduced from a clean machine in the plan. The first user installer will be the first real test.
  4. **R4** — The visual-test phase assumes Playwright can drive the Electron app, but the build script keeps native deps `external` and the e2e harness for `electron.launch()` is undocumented. Phase 8 will block on Phase 1.5+8 plumbing nobody owns.
  5. **R5** — Sub-agent merge contention on `schema.ts`, `router-shape.ts`, `preload.ts`, `Sidebar.tsx`, and `state.tsx` is unaddressed. With 5–8 agents per phase, the integration agent becomes the single longest critical path.

---

## Risks

### R1. Foundation patches under-scoped vs. downstream demand [CRITICAL]
**Spec ref**: BUILD_BLUEPRINT Phase 1.5; PRODUCT_SPEC §3.9, §6, §8.2
**Risk**: Phase 1.5 lists 14 bug fixes plus an allowlist plus a quit-cleanup. It does not include: a structured `log.ts` (P2-LOGGER-ABSENT in the bug sweep), a `settings.get/set` RPC pair (Phase 7 introduces it but Phase 4/5 already need it for "Disabling deletes the fan-out copy"), a `kv` typed accessor, the `MCP server catalog table` (`mcp_servers` in §10) which Phase 5 silently depends on, or a generic event-subscription registry that Phase 2 (`swarm:message`), Phase 3 (`browser:driving`), Phase 4 (`skills:changed`), Phase 5 (`memory:changed`), Phase 6 (`review:changed`, `tasks:changed`) all need. Phase 1.5 only fixes `pty:data` per-window emission. Each later phase will re-invent the per-window subscription wheel, locally and inconsistently.
**Likelihood**: high
**Impact**: high — re-base storms across every renderer feature when the registry is finally extracted.
**Mitigation**: Expand Phase 1.5 to ship: (a) `core/lib/log.ts` (a thin pino-or-bust wrapper writing to `<userData>/logs/sigmalink.log` with rotation); (b) a generic `events.subscribe(channel, predicate)` pattern in main + preload, parameterised on `(webContentsId, sessionId | swarmId | workspaceId)`; (c) the `mcp_servers`, `providers_state`, and `kv` tables as one bundled migration `0002_phase15_patches`; (d) `settings.get/set` RPCs reading/writing `kv`. None of these are scope creep — they are prerequisites the blueprint elsewhere assumes.
**Owner-agent prompt**: "You are Builder-Foundation-Plus. In Phase 1.5, in addition to the 14 bug fixes, ship `app/src/main/core/lib/log.ts` (file rotation at 5 MiB × 5 files), `app/src/main/core/lib/event-bus.ts` (per-webContents subscription registry parameterised on a key path), `app/src/main/controllers/settings.ts` (`settings.get(key)`, `settings.set(key,value)`), and bundle migrations for `mcp_servers`, `providers_state`, `kv` into `0002_phase15_patches`. Add unit tests proving the event bus emits only to subscribed webContents and rotates logs at the size threshold."

### R2. Preload allowlist without payload validation is a half-fix [CRITICAL]
**Spec ref**: BUILD_BLUEPRINT Phase 1.5 row P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST; PRODUCT_SPEC §4 (mentions resolveForCurrentOS but not channel zod)
**Risk**: The blueprint generates ALLOWED_CHANNELS from `router-shape.ts`, but a renderer compromise (XSS in any imported npm package, dev-server hijack, or an untrusted clipboard paste rendered as HTML) can still call `git.runArgv(cwd, ["rm", "-rf", "/"])`, `workspaces.launch(plan)` with arbitrary `command`, `pty.write(sessionId, ...)` against a privileged session, or `skills.ingest(path)` with a path that's actually a fan-out target. The preload validates *channel names*, not *arguments*. Channel names are a denylist of typos, not a security boundary.
**Likelihood**: med (renderer XSS surface is small today but grows with markdown render in Memory, browser address bar autocomplete, Bridge Assistant chat, palette descriptions).
**Impact**: critical — RCE on host with arbitrary cwd.
**Mitigation**: Mandate per-channel zod schema validation in main. Each entry in `router-shape.ts` carries a zod input schema; the router rejects with `INVALID_PAYLOAD` before calling the controller. Forbid `git.runArgv` from the renderer entirely (no UI calls it); expose only via the Review Room runner with hard-coded subcommand allowlist (`test`, `lint`, `build`, project-relative scripts under `scripts/`).
**Owner-agent prompt**: "You are Builder-Sec-2. Extend `router-shape.ts` so each entry carries a zod input schema. Wire the router to validate arguments and reject with `INVALID_PAYLOAD` before dispatch. Audit every controller for callers that accept free-form strings and either zod-restrict them (paths to files inside `<userData>` or the workspace root) or remove the channel from the renderer surface. Specifically: `git.runArgv` must be unreachable from the renderer; the Review runner exposes a separate `review.runCommand(reviewItemId, presetId)` that picks from a server-side allowlist."

### R3. Native module rebuild is undocumented for end users [CRITICAL]
**Spec ref**: BUILD_BLUEPRINT Phase 8 (no rebuild guidance); P3-NATIVE-DEPS-REBUILD
**Risk**: `better-sqlite3` and `node-pty` are platform+Electron-version specific. The plan relies on `electron-builder install-app-deps` running as a `postinstall` hook, but: (a) on first `npm install` the Electron version is read *after* deps install on some setups, requiring a second pass; (b) corporate proxies block prebuilt-binary downloads (`https://github.com/<...>/releases`) and silently fall back to source builds requiring Visual Studio Build Tools / Xcode CLT / build-essential; (c) ia32 Windows is configured (`electron-builder.yml: arch: [x64, ia32]`) but better-sqlite3 ia32-Electron prebuilds are inconsistent (P3-WIN-IA32-SUPPORT). A failed rebuild produces a runtime `better_sqlite3.node is not a valid Win32 application` that the renderer surfaces as a blank screen.
**Likelihood**: high (especially on macOS arm64 + first-launch corporate networks)
**Impact**: high — installer ships, app refuses to start, no diagnostic.
**Mitigation**: (1) Drop `ia32` from `arch` matrix unless explicitly tested. (2) Add a startup self-check in `electron/main.ts` that `require()`s `better-sqlite3` and `node-pty` inside try/catch; on failure, render a known-good HTML page from disk that explains the rebuild step and links to `npx electron-rebuild -f -w better-sqlite3,node-pty`. (3) Bundle prebuilt `node-pty` and `better-sqlite3` per supported (OS,arch,electron) tuple under `app/native-prebuilds/` and prefer that over runtime download. (4) CI matrix in Phase 8 must include a macOS arm64 *and* x64 runner to catch the universal-binary mismatch.
**Owner-agent prompt**: "You are Builder-Native. Add a startup self-check in `electron/main.ts` that loads `better-sqlite3` and `node-pty` inside try/catch and, on failure, opens a diagnostic window showing the resolved binding paths, Electron + Node ABI versions, and the suggested `npx electron-rebuild` command. Drop `ia32` from `electron-builder.yml`. Document the rebuild fallback in `docs/05-build/native-rebuild.md`."

### R4. Visual test harness for Electron is unspecified [CRITICAL]
**Spec ref**: BUILD_BLUEPRINT Phase 8
**Risk**: Phase 8 says "Playwright-driven Electron E2E" but does not pick the API (`@playwright/test` exposes `electron` fixture via `_electron.launch({ args: ['./dist/electron/main.js'] })`); does not specify how dist artifacts (compiled main + preload + renderer) are produced before tests run; does not mention native-module rebuild for the test Electron version (often different from the runtime Electron version); and does not mention preload context isolation on the test path. With esbuild leaving native modules `external`, the test harness has to point at a directory where `node_modules/better-sqlite3/build/Release/better_sqlite3.node` exists *for the test Electron's ABI*. CI runs on three OS images each with a different default Node ABI.
**Likelihood**: high
**Impact**: high — Phase 8 stalls; visual regressions ship.
**Mitigation**: Bake the smoke flow into the blueprint: `npm run build:e2e` (esbuild + vite + electron-builder unpacked) → `playwright test` against `_electron.launch({ args: [path.join(__dirname, '../dist-electron/main.js')], env: { SIGMA_TEST: '1' } })`. The first spec opens the app, asserts the Workspaces room renders, creates a temp workspace pointing at a fixture repo, launches one Claude Code pane (mocked provider that echoes), waits for `pty:data` event, screenshots the Command room, closes pane, asserts no orphan worktree on disk. Define the screenshot baseline directory (`app/tests/visual/__screenshots__/<os>-<theme>/<spec>.png`) and the tolerance (`maxDiffPixelRatio: 0.005`).
**Owner-agent prompt**: "You are Builder-E2E. Stand up `app/tests/e2e/smoke.spec.ts` using `@playwright/test`'s `_electron` API. The test must: launch the packaged app from `dist-electron/`, create a workspace via the UI, launch one pane using a mock provider executable (a tiny `.cmd`/`.sh` that echoes input), wait for the first `pty:data` round-trip, take a screenshot, close the pane via the new Close button, and assert (via SQLite read) that the worktree row has `removed_at IS NOT NULL`. Document the prebuilt rebuild step in the spec preamble."

### R5. Hidden phase dependency: Skills (Phase 4) needs MCP infra (Phase 5/3) [CRITICAL]
**Spec ref**: BUILD_BLUEPRINT Phase 4 → "the agent-config writer overlaps with Phase 4 fan-out conceptually"; Phase 3 introduces `agent-config-writer.ts`; Phase 5 introduces the MCP server runtime
**Risk**: Phase 4 fan-out writes per-provider skill files at `~/.claude/skills/<id>/`, `~/.codex/skills/<id>/`, `~/.gemini/extensions/<id>/`. But for those skills to actually work end-to-end (the acceptance criterion implied by §7.3) the per-provider MCP config must point at the workspace's MCP servers — which is the `agent-config-writer.ts` introduced in Phase 3. Worse, `mcp_servers` table is referenced in PRODUCT_SPEC §3.9 but is not in any phase's migration list — Phase 5 quietly assumes it exists. Building Phase 4 before Phase 3 ships, or Phase 5 before `mcp_servers` is created, will cause merge churn at integration.
**Likelihood**: high
**Impact**: high — re-work in two phases.
**Mitigation**: Move `agent-config-writer.ts` and the `mcp_servers` table forward into Phase 1.5 as part of R1's bundle. Then Phase 3 only adds the *Playwright entry*, Phase 4 only adds *skill entries*, and Phase 5 only adds the *memory MCP entry*. This decouples the three phases on the only file they all want to write.
**Owner-agent prompt**: "You are Builder-MCPCore. Ship `app/electron/core/mcp/agent-config-writer.ts` in Phase 1.5 with a generic API: `writeAgentConfig(workspaceId, providerId, entries: McpEntry[])` that idempotently merges entries into `~/.claude/.mcp.json`, `~/.codex/config.toml`, and the Gemini extension manifest. Phase 3, 4, 5 each call it with their own entries. Add the `mcp_servers` table to the Phase 1.5 migration."

### R6. Sub-agent merge contention on shared files [HIGH]
**Spec ref**: BUILD_BLUEPRINT (every phase)
**Risk**: Across phases, every parallel agent will want to edit the same five files: `app/src/main/core/db/schema.ts` (every phase's migration), `app/src/shared/router-shape.ts` (every phase's RPC), `app/electron/preload.ts` (allowlist regen + getPathForFile reuse in Phase 4), `app/src/renderer/features/sidebar/Sidebar.tsx` (un-grey each room's tile), `app/src/renderer/app/state.tsx` (every phase's reducer additions). With 5–8 agents per phase × 8 phases, the integration agent's merge cost dominates the timeline.
**Likelihood**: high
**Impact**: high
**Mitigation**: Treat these as **append-only registries** with a hand-off contract. (a) `schema.ts` is split into `schema/<phase>.ts` and re-exported from one `schema/index.ts`; agents add a new file, never edit the existing ones. (b) `router-shape.ts` is split into namespace-per-file shards (`router/swarms.ts`, `router/browser.ts`, …), each owned by exactly one phase. (c) `preload.ts` reads its allowlist from `router-shape.ts` aggregator at build time so no manual regeneration. (d) `Sidebar.tsx` reads room manifest from `routes/manifest.ts`; each phase appends a row. (e) `state.tsx` similarly takes a per-feature reducer module and combines them. Recommended phase order to minimise cross-feature dependencies: 1.5 → (2 + 5) parallel → 3 → 4 → 6 → 7 → 8. Reasoning: Memory (5) is independent of Swarm (2); Browser (3) needs the patched preload + per-workspace lifecycle from Phase 2 supervisor patterns; Skills (4) needs the agent-config writer from Phase 3 *only after* it's lifted to Phase 1.5 (R5). Review/Tasks (6) needs Phase 2's mailbox for rejection envelopes. Polish (7) requires all rooms to exist. Visual+bugfix (8) is the gate.
**Owner-agent prompt**: "You are Builder-Plumbing. Refactor `schema.ts`, `router-shape.ts`, the preload allowlist generator, the sidebar manifest, and the renderer reducer composition into append-only registries before any Phase 2+ work begins. Each new feature must register itself by adding *one new file*, never editing an existing one. Add an integration test that asserts every controller in `controllers/` is referenced from exactly one router shard."

### R7. Acceptance criteria are mostly manual / observational [HIGH]
**Spec ref**: BUILD_BLUEPRINT every phase's acceptance criteria
**Risk**: Phase 2 AC2 ("appears in every inbox JSONL within 200 ms"), Phase 3 AC4 ("warm-amber within 100 ms"), Phase 5 AC6 ("1,000 nodes at 30+ FPS"), Phase 7 AC1 ("within one frame; no layout shift") are time-bounded UI claims that nobody is wired to assert. Phase 8 lists Playwright but does not pin these specific assertions.
**Likelihood**: high
**Impact**: med — phases will be marked "done" on visual inspection; regressions creep in silently.
**Mitigation**: For each phase, identify the weakest AC and replace with an automated assertion:
- **Phase 1.5**: weakest is AC8 ("New unit tests pass"). Stronger: "An e2e spec launches the app, opens a workspace pointing at a fixture repo with a mocked Claude provider stub, asserts the pane reaches `pty:data` within 5s on Win11 *and* macOS *and* Ubuntu in CI."
- **Phase 2**: weakest is AC4 ("SideChat live-updates without polling"). Stronger: "An e2e spec writes 100 envelopes via the operator broadcast and asserts the SideChat virtual-list renders all 100 within 2s, and that file-watcher events were the trigger (not interval polling — assert no `setInterval` registered for the side-chat component via a `__SIGMA_TEST_INTROSPECT__` global)."
- **Phase 3**: weakest is AC4 (warm-amber timing). Stronger: "An e2e spec spawns a stub MCP client, calls `browser_navigate`, and asserts the indicator's computed style transition starts within 100 ms via `performance.mark`."
- **Phase 4**: weakest is AC7 (per-provider partial fan-out). Stronger: "An e2e spec drops a fixture skill folder, monkey-patches the Codex writer to throw, asserts `~/.claude/skills/<id>` exists, `~/.gemini/extensions/<id>` exists, the `skills.list` row reports `enabledProviders=['claude','gemini']` and a per-provider error for codex."
- **Phase 5**: weakest is AC6 (1000 nodes 30 FPS). Stronger: "A perf benchmark loads 1,000 fixture memories with realistic edge density, runs a fixed 5-second pan-and-zoom recording, and asserts the median frame time on the GH-Actions runner is < 33 ms (with a tolerance for slower CI hardware encoded as a separate threshold)."
- **Phase 6**: weakest is AC4 (lock conflict surfacing). Stronger: "Property test: 100 random task-creation orders with random file overlaps; assert that exactly the locking conflicts the model expects are reported and no other inserts succeed."
- **Phase 7**: weakest is AC1 ("within one frame; no layout shift"). Stronger: "A Playwright spec switches between three themes 10 times, asserts cumulative layout shift via `PerformanceObserver({ type: 'layout-shift' })` is 0."
- **Phase 8**: weakest is AC3 (≥70% coverage on pure logic). Stronger: "Coverage gate is enforced as a CI failure with per-module thresholds: `spawn-resolve` ≥ 90%, `mailbox` ≥ 85%, `wikilinks` ≥ 90%, `validator` ≥ 90%, `locks` ≥ 90%; aggregate ≥ 70%."

### R8. Five-attempt bug-fix loop has no operational definition [HIGH]
**Spec ref**: not in BUILD_BLUEPRINT; user-supplied policy
**Risk**: "Five attempts then defer" without definitions becomes either (a) builders rewrite the same broken patch five times because each rewrite is one "attempt", or (b) builders never declare an attempt and loop indefinitely.
**Likelihood**: high
**Impact**: med — wall-clock waste and false sense of progress.
**Mitigation**: Hard criteria:
- An **attempt** is one CI green-or-red signal on a branch named `fix/<bug-id>/<n>`. The PR must contain (i) a failing regression test that captures the bug, (ii) the patch, (iii) the now-passing test. A push without a regression test does not count and is rejected by a pre-merge bot.
- A **fix is confirmed** when: (i) the regression test passes; (ii) the full unit + e2e matrix on the bug's affected OS passes; (iii) for P0/P1 bugs, an operator (or the orchestrator) checks the smoke flow end-to-end and signs the PR with `Sigma-Verified: <bug-id>`. Single-run is *not* sufficient — the test must run twice in CI separated by at least one unrelated commit, to flush flake.
- After 5 attempts, the bug is moved to `docs/07-bugs/deferred/<bug-id>.md` with the last failing diff, the test, and a written hypothesis of what's actually wrong. Deferred P0/P1 bugs block the release. Deferred P2/P3 do not.
**Owner-agent prompt**: "You are Builder-BugLoop-Policy. Add `docs/05-build/bugfix-policy.md` and a CI rule (`.github/workflows/bugfix-policy.yml`) that rejects PRs claiming to fix a bug-id without a regression test in the diff, and counts attempts via PR labels `fix/<bug-id>/attempt-1..5`."

### R9. Secrets handling is undefined [HIGH]
**Spec ref**: PRODUCT_SPEC §4 (provider list with no auth detail); §3.9 (Settings has no secrets surface)
**Risk**: Provider CLIs (Claude Code, Codex, Gemini, Copilot) authenticate via env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GH_TOKEN`) or via per-CLI config files. The plan does not say where SigmaLink stores these. If the operator types a key into a Settings field, plaintext-in-`kv` is the path of least resistance and the worst outcome — the SQLite file is in `<userData>` and trivially readable by any other process running as the user.
**Likelihood**: med (more likely once non-power-users adopt)
**Impact**: high — credential disclosure.
**Mitigation**: (1) Decision: **never** store provider API keys inside SigmaLink. The operator authenticates each CLI through that CLI's own flow (Claude Code login, `gh auth login`, etc.) and SigmaLink reads only what's already in env / each CLI's config. (2) For workspace-scoped secrets the operator wants SigmaLink to inject (e.g., a per-workspace `OPENAI_API_KEY` for Codex), use Electron's `safeStorage` API, which delegates to OS keychain (DPAPI on Windows, Keychain on macOS, libsecret on Linux). (3) Encrypted blob lives in `<userData>/secrets.enc`, never in SQLite. (4) `safeStorage.isEncryptionAvailable()` must be checked at startup; on Linux without libsecret, refuse to store secrets and fall back to env-only.
**Owner-agent prompt**: "You are Builder-Secrets. Implement `app/src/main/core/secrets/store.ts` using `safeStorage.encryptString` and write to `<userData>/secrets.enc`. Add `secrets.set(key,value)`, `secrets.get(key)`, `secrets.list()`, `secrets.delete(key)` RPCs gated by an explicit user gesture (a renderer modal that requires a click, not programmatic). Document the policy in `docs/05-build/secrets-policy.md`. Refuse to persist anything if `safeStorage.isEncryptionAvailable()` returns false; surface this in Settings with a yellow badge."

### R10. Cross-platform debt larger than one phase can absorb [HIGH]
**Spec ref**: BUILD_BLUEPRINT Phase 8 ("matrix of {win-latest, macos-latest, ubuntu-latest}")
**Risk**: Predictable surprises:
- **PTY**: `node-pty` on macOS uses `forkpty(3)`; on Windows uses ConPTY since node-pty 1.x. macOS pty inherits the parent's controlling terminal default which can leak `SIGTTOU` if the parent is a TTY (it is during `npm run dev`). Linux: ConPTY equivalents don't apply but `TERM=xterm-256color` defaults differ; some agents (Claude Code older builds) misinterpret `xterm-color`.
- **Path case sensitivity**: macOS HFS+ is case-preserving but case-insensitive by default; APFS too unless the volume is set otherwise. The skill loader's "exact title match" for `[[Title]]` and the worktree path sanitiser must agree on normalisation. Linux is case-sensitive everywhere.
- **Keychain**: `safeStorage` works on macOS (Keychain), Windows (DPAPI). On Linux it requires `libsecret` *and* a running secret service (gnome-keyring or kwallet). Headless Linux servers fail at this.
- **Signing/notarization**: Windows requires an Authenticode cert (an EV cert if SmartScreen pain is unacceptable); macOS requires Apple Developer ID + notarization (which now requires hardened runtime entitlements that conflict with `nodeIntegration`). Linux is unsigned but distros vary on AppImage vs Flatpak vs snap.
- **DevTools detach**: `webContents.debugger.attach('1.3')` for Playwright supervisor (Phase 3 §8.2) competes with the user pressing F12. Pick one or implement re-attach.
**Likelihood**: high
**Impact**: high
**Mitigation**: Add `docs/05-build/cross-platform.md` listing each surface above with the explicit decision. Phase 8 must include CI runs that exercise the smoke flow on macOS arm64, macOS x64, Win11 x64, and Ubuntu 22.04. Defer signing/notarization to a Phase 8.5 if needed; the plan should explicitly mark whether v1 ships unsigned (acceptable for a power-user audience) or signed.
**Owner-agent prompt**: "You are Builder-CrossPlatform. Produce `docs/05-build/cross-platform.md` enumerating each cross-platform decision (PTY shell defaults, path normalisation strategy in skills + worktrees + memory titles, keychain availability, signing posture). For each, add a CI assertion to Phase 8."

### R11. Auto-update strategy missing [HIGH]
**Spec ref**: not present
**Risk**: Without auto-update, a v1 user running a 4-week-old build will be on a known-bad PTY resolver if R10 needs a follow-up patch. Hand-rolling auto-update for an Electron app of this surface is non-trivial.
**Likelihood**: med
**Impact**: med — users stuck on broken versions; support cost.
**Mitigation**: Decision (record explicitly in the blueprint): **v1 ships without auto-update**, with a documented manual update flow ("download new installer from <url>, run, settings preserved in `<userData>`"). v1.1 introduces `electron-updater` with a static feed file at a project-controlled URL. Document the decision in `docs/05-build/updates.md` so it is a deliberate non-feature, not an oversight.
**Owner-agent prompt**: "You are Builder-Updates-Doc. Add `docs/05-build/updates.md` recording the v1 decision (no auto-update, manual installer) and the v1.1 plan (`electron-updater` against a static feed). Add a tiny in-app 'Check for updates' button in Settings that opens the project releases page in the user's default browser."

### R12. Logging + diagnostics absent at phase 1 [HIGH]
**Spec ref**: P2-LOGGER-ABSENT in bug sweep; not promoted
**Risk**: When an agent fails to spawn (R1, R3, R10 all flow into this), the user sees a "exit code -1" toast. There is no log file, no structured event trail, no way for the user to send a bug report with reproducible artefacts.
**Likelihood**: high (this fires on every install hiccup)
**Impact**: high — support cost, bad first impression.
**Mitigation**: Promote `P2-LOGGER-ABSENT` to P1 and ship a log module in Phase 1.5 (covered by R1). UX surfaces:
- Centralized log file at `<userData>/logs/sigmalink.log` (JSON-lines, rotated 5MiB×5).
- A renderer toast on PTY/error events with a "Copy diagnostics" button that copies a JSON blob (last 200 log lines + provider probe results + Electron/Node/OS versions) to clipboard.
- Settings → "Open log file" + "Copy diagnostics".
- A devtools console mirror gated on `SIGMA_DEV=1` env var.
**Owner-agent prompt**: "You are Builder-Diag. Ship `core/lib/log.ts` (Phase 1.5; see R1), the toast-on-error renderer hook with a Copy-Diagnostics action, and the Settings affordances. Diagnostics blob format documented in `docs/05-build/diagnostics.md`."

### R13. Error budget / release-blocker policy undefined [MEDIUM]
**Spec ref**: not present
**Risk**: Without an explicit policy, "ship" devolves to "no critical bugs that I personally noticed", which fluctuates with reviewer mood.
**Likelihood**: med
**Impact**: med — endless beta.
**Mitigation**:
- A bug becomes a release-blocker if it is P0 (any time) or P1 (after 5 failed fix attempts → it's then deferred and the deferral itself blocks if the bug is on a smoke path).
- Tolerable open count at v1 ship: 0 P0, 0 P1 on smoke paths, ≤5 P1 off smoke paths (each with a written workaround), ≤25 P2, no cap on P3.
- A bug on a "smoke path" is one that touches any of the Definition-of-Done flows below.
**Owner-agent prompt**: "You are Builder-ReleasePolicy. Document the budget in `docs/05-build/release-policy.md`. Add a release-blocker view in `docs/07-bugs/` that lists any P0 or any P1-on-smoke-path with the deferral rationale."

### R14. Phase 7 polish before Phase 8 stabilisation is risky [MEDIUM]
**Spec ref**: BUILD_BLUEPRINT Phase 7 → Phase 8
**Risk**: Polish (themes, animations, command palette) lands before E2E baselines exist; visual baselines in Phase 8 will be polluted by motion timing flakes (framer-motion + Playwright screenshot comparisons require `prefers-reduced-motion` honoured in tests; not in the spec).
**Likelihood**: med
**Impact**: med — Phase 8 visual regressions become noise.
**Mitigation**: Add an `animations: 'disabled' | 'reduced' | 'full'` setting that visual tests force to `disabled`. Use CSS variables in `motion.css` that resolve to `0ms` when `data-motion="disabled"`. Bake into the e2e fixture.
**Owner-agent prompt**: "You are Builder-MotionTest. Ensure every animation in Phase 7 reads its duration from a CSS variable that resolves to `0ms` when the document carries `data-motion='disabled'`. Phase 8 sets that attribute in the test fixture."

### R15. Schema migration ordering is fragile [MEDIUM]
**Spec ref**: BUILD_BLUEPRINT migrations 0002 (Phase 1.5) → 0007 (Phase 6); §10 of PRODUCT_SPEC
**Risk**: The blueprint orders migrations 0002 → 0007 by phase, but parallel agents may produce 0003 (swarm) and 0004 (browser) simultaneously, then merge with conflicting numbers. Drizzle's `meta/_journal.json` will have hash drift. Re-numbering mid-phase invalidates anyone who already migrated their dev DB.
**Likelihood**: med
**Impact**: med — corrupted dev DBs, repeated `rm -rf <userData>` on team machines.
**Mitigation**: Migrations are named by ULID, not sequential integers: `0002_phase15_<ulid>.sql`. The Drizzle journal sorts lexicographically by ULID timestamp, which preserves insertion order without coordination. Agents never collide on filenames. Document in `docs/05-build/migrations.md`.

### R16. PTY ring-buffer replay across restarts is leaky [MEDIUM]
**Spec ref**: PRODUCT_SPEC §3.2 ("`terminals` (ring-buffer flushes for replay across restarts)"); not phase-scheduled
**Risk**: §3.2 promises replay across restarts via the `terminals` table BLOB column, but Phase 1.5 does not include the flush-on-exit logic, and Phase 8 does not have an e2e for it. Without scheduled work, this becomes a "spec said it but nobody built it" surprise.
**Likelihood**: high
**Impact**: low — not a smoke path, but a documented promise that fails silently.
**Mitigation**: Either schedule it explicitly in Phase 1.5 (flush on `pty:exit` + on `before-quit`) or remove the promise from §3.2 and the `terminals` table (defer to v1.1).
**Owner-agent prompt**: "You are Builder-Replay. In Phase 1.5, write `pty.flushBuffer(sessionId)` that compresses the ring-buffer to `terminals.buffer` on `pty:exit` and on `before-quit`. On `Terminal` mount, prefer the in-memory ring; if absent, hydrate from `terminals.buffer`. Add an e2e in Phase 8 that kills the app mid-output and verifies the replayed buffer."

### R17. Bridge Assistant tool surface is dangerously broad [MEDIUM]
**Spec ref**: PRODUCT_SPEC §3.10 ("`launch_pane(provider,count,initialPrompt?)`, `prompt_agent(sessionId,text)`, …, `broadcast_to_swarm`, `roll_call`")
**Risk**: The Bridge Assistant has tools that mutate the workspace, launch processes, and broadcast to swarms. A prompt-injection in any document the assistant reads (R: `read_files(globs)`) can chain into `launch_pane` and `broadcast_to_swarm` to amplify attacker-controlled instructions across the swarm. This is the canonical *prompt injection → tool execution* chain.
**Likelihood**: med (hostile content is one `git clone` away)
**Impact**: high — silent multi-agent compromise.
**Mitigation**: Every Bridge Assistant tool that mutates state requires explicit operator confirmation in the chat panel (a `pending` state with an Approve button) before execution. `read_files` is allowed without confirmation but its results are tagged in the LLM context as `<untrusted>`. The blueprint should add this to the assistant phase (currently not scheduled — another hidden dependency).
**Owner-agent prompt**: "You are Builder-Assistant-Safety. The Bridge Assistant tool surface ships in two tiers: (i) read-only tools (`read_files`, `search_memories`) execute immediately; (ii) mutating tools (`launch_pane`, `prompt_agent`, `create_swarm`, `broadcast_to_swarm`, `roll_call`, `create_task`) emit a renderer card the operator must click Approve on. Document in `docs/05-build/assistant-safety.md`."

### R18. SQLite `terminals` BLOB and FTS5 carry size risk [LOW]
**Spec ref**: §10 tables 4 and 15
**Risk**: `terminals.buffer BLOB` ≤ 256 KiB times potentially 16 sessions × N restarts grows the SQLite file. FTS5 over `memories.body` doubles disk for memory text. Not catastrophic for power users, but unbounded.
**Likelihood**: low
**Impact**: low
**Mitigation**: TTL job at app start: delete `terminals` rows older than 30 days; rebuild FTS5 after `delete_memory` to reclaim space. Document in `docs/05-build/db-maintenance.md`.

### R19. `sandbox: false` widens renderer privilege [LOW]
**Spec ref**: bug sweep "Security: ... sandbox is off (`electron/main.ts:29`)"
**Risk**: Sandbox-off is required because the preload uses `webUtils.getPathForFile`, but it widens the blast radius of any preload bug.
**Likelihood**: low
**Impact**: med
**Mitigation**: Document why sandbox is off; minimise preload surface; ensure context isolation is on (it is). Re-evaluate in v1.1 whether `webUtils` can be replaced with a renderer-side `dataTransfer.files[i].path` (deprecated but still works on Electron 28+).

### R20. Drizzle ORM + raw SQL drift [LOW]
**Spec ref**: §10 ("Drizzle-managed, one source of truth, no hand-rolled CREATE TABLE drift")
**Risk**: The bootstrap SQL referenced in P1-DRIZZLE-DEFAULT-OVERRIDE coexists with Drizzle definitions. If they diverge again, dev DBs and prod DBs differ.
**Likelihood**: low
**Impact**: low (if R15's ULID-named migrations are adopted)
**Mitigation**: Delete the bootstrap SQL fast-path; Drizzle is the only writer. CI gate: `drizzle-kit check` must pass.

### R21. Probe parallelism startup hitch [LOW]
**Spec ref**: P3-PROBE-CONCURRENCY
**Risk**: 9 providers × N alt-commands × `where` at startup → noticeable Win11 hitch.
**Likelihood**: med
**Impact**: low
**Mitigation**: Cache `providers_state` for 24h; only re-probe on user request or when `command_override` changes. Already implied by `last_probed_at`.

### R22. Cmd+K registry leakage [LOW]
**Spec ref**: BUILD_BLUEPRINT Phase 7 ("`registry.ts` — palette action contributions per room")
**Risk**: A global registry that every room mutates becomes the next merge hot-spot (R6).
**Likelihood**: low (mitigated by R6 plumbing)
**Impact**: low
**Mitigation**: Each room declares its actions in `routes/<room>/palette.ts` and the registry composes them at module load.

---

## Re-sequencing recommendation

The blueprint's linear order (1.5 → 2 → 3 → 4 → 5 → 6 → 7 → 8) is workable but not optimal. The proposed order, justified by the dependency analysis above:

1. **Phase 1.5+** (expanded per R1, R5, R12, R16): bug fixes + log + event-bus + agent-config-writer + `mcp_servers`/`providers_state`/`kv` migrations + secrets store + replay flush. Single integration agent at end. ~5 builders + 1 reviewer.
2. **Phase 2 (Swarm)** and **Phase 5 (Memory)** in parallel — they share no files and exercise the new event-bus from two sides. ~12 builders + 2 reviewers concurrently.
3. **Phase 3 (Browser)** — depends on Phase 1.5 supervisor patterns and `agent-config-writer`. ~5 builders.
4. **Phase 4 (Skills)** — depends on Phase 3's `agent-config-writer` lift (R5) and Phase 1.5 `getPathForFile`. ~4 builders.
5. **Phase 6 (Review + Tasks)** — depends on Phase 2 mailbox for rejection envelopes. ~6 builders.
6. **Phase 7 (Polish)** — last, because the palette indexes everything else. ~5 builders.
7. **Phase 8 (Stabilise)** — release gate. ~8 builders.

Hot-spot files (R6) are refactored to append-only registries before Phase 2 begins.

## Time / cost estimate

Per phase, in **agent-runs** (one builder × one focused work session, ~2–4h of wall-clock per run on a competent agent). "Optimistic" assumes no rework; "pessimistic" applies a 1.6× rework multiplier and one full retry per critical risk that lands on the phase.

| Phase | Builders × Runs (opt) | Reviewer runs | Pessimistic total |
|---|---|---|---|
| 1.5+ | 6 × 4 = 24 | 4 | ~45 |
| 2 | 6 × 5 = 30 | 5 | ~56 |
| 3 | 5 × 4 = 20 | 4 | ~38 |
| 4 | 4 × 3 = 12 | 3 | ~24 |
| 5 | 6 × 5 = 30 | 5 | ~56 |
| 6 | 6 × 5 = 30 | 5 | ~56 |
| 7 | 5 × 3 = 15 | 3 | ~29 |
| 8 | 8 × 6 = 48 | 6 | ~86 |
| **Total** | **~209** | **35** | **~390** |

Reading: optimistic ~245 agent-runs to ship; pessimistic ~390. With 6 agents in parallel and ~3h per run, that's 122 → 195 wall-clock-hours of agent capacity, modulo integration serialisation.

## Known unknowns (answer before any build agent codes)

1. Which Electron version is the target? (Affects native-module ABI, `WebContentsView` availability, `safeStorage` API surface.) Pin in `package.json` engines.
2. Is the v1 audience expected to install Visual Studio Build Tools / Xcode CLT? Or do we ship prebuilds for every supported tuple?
3. What Playwright + node-pty test ABI matches our runtime ABI? Can `@playwright/test` `_electron` launch our packaged app, or do we need to spawn against `dist-electron/main.js` directly with the source `node_modules`?
4. macOS notarization: ship signed v1 or unsigned with a Gatekeeper-bypass-instructions doc?
5. Is the `mcp_servers` table the registry of *configured* servers, or *running* servers? (PRODUCT_SPEC implies the former; Phase 5 implies live state.)
6. Where does the Bridge Assistant get its API key? (R9, R17 — assistant cannot work without one, but we said no key storage. Decision needed: env-only, or `safeStorage` exception?)
7. What is the exact CI runner profile for Phase 5 AC6 (1,000 nodes 30 FPS)? GH Actions free runners are slower than the "2024-class laptop" the AC names.
8. Are skills sandboxed when executing shell snippets, or is "validation badge" the only enforcement? (PRODUCT_SPEC §7.4 implies static allowlist only — fine for v1 if explicit.)
9. What happens to in-flight swarm messages when the operator closes the workspace? Drained, persisted, dropped?
10. Is `electron-builder install-app-deps` run *also* during dev (`npm run dev`)? If not, dev contributors hit the same rebuild trap CI does.

## Definition of done (Wave 7 acceptance smoke flow)

If all of these pass on Win11 x64, macOS arm64, macOS x64, and Ubuntu 22.04 in CI, we ship:

- [ ] **smoke 1 — install + launch**: Fresh `npm install && npm run build && electron-builder --publish=never` produces an installer; first launch on a clean user profile shows the Workspaces room within 3s; native-module self-check passes.
- [ ] **smoke 2 — Bridge Space launch**: Create workspace pointing at a fixture Git repo; launch 4 panes (Claude × 2, Codex × 2 — using mocked-or-real CLIs); all 4 panes reach `pty:data` within 5s; each lives in a distinct worktree; Close pane removes worktree, DB row, and registry entry.
- [ ] **smoke 3 — Swarm round trip**: Create Bridge Swarm with Squad preset (5 agents); broadcast "ping"; within 1s every inbox JSONL contains the broadcast and SideChat shows it; Roll Call returns one aggregate `status` envelope within 60s; killing the app mid-swarm and restarting reconstructs `swarm_messages` from JSONL with no loss.
- [ ] **smoke 4 — Browser drive**: Open Browser room; supervisor spawns; mock MCP client calls `browser_navigate("https://example.com")`; tab navigates; warm-amber indicator appears within 100ms and clears within 500ms; CDP port released on workspace close.
- [ ] **smoke 5 — Skill ingest + fanout**: Drop a fixture multi-skill plugin folder; both skills appear; Claude fan-out copy exists at `~/.claude/skills/<id>/`; Gemini extension manifest is syntactically valid; Codex translation preserves `allowed-tools`; toggling Claude off removes only the Claude copy.
- [ ] **smoke 6 — Memory transactional write**: Create memory A with body containing `[[B]]`; B does not exist (dangling edge reported); create B; backlinks panel for B shows A; force-fail the disk write on `update_memory` and verify both DB and file roll back.
- [ ] **smoke 7 — Review + commit**: Run a synthetic agent that touches 3 files in a worktree; open Review room; run a fixture test command (passes); approve; assert worktree branch merged into base, worktree removed, `review_items.status='approved'`.
- [ ] **smoke 8 — Tasks + locks**: Create Task A locking files `[x.ts, y.ts]`; create Task B locking `[y.ts, z.ts]` — fails with the conflict surfaced in the side panel; transition A to `done`; B's lock now succeeds.
- [ ] **smoke 9 — Theme + palette**: Switch from `obsidian` to `solarized-light` and back 10 times; cumulative layout shift = 0; Cmd+K opens within 50ms and finds rooms, recent workspaces, providers, skills, tasks, memory titles.
- [ ] **smoke 10 — Quit cleanup**: With 4 running panes, Cmd-Q; sessions transition to `exited` or `error`; orphan worktrees removed; SQLite WAL flushed; relaunch shows correct `lastOpenedAt` and no orphan rows.
- [ ] **smoke 11 — Diagnostics + secrets**: Force a PTY spawn failure; toast appears with Copy Diagnostics button; clipboard contains last 200 log lines + provider probe results + ABI versions; Settings → Open log file opens the rotating log; `safeStorage.isEncryptionAvailable()` is honoured.
- [ ] **smoke 12 — Channel allowlist**: From the renderer DevTools, calling `window.sigma.invoke('not.a.channel')` rejects client-side; calling `window.sigma.invoke('git.runArgv', ...)` is rejected because the channel is not on the renderer surface; calling `pty.create` with a payload that fails zod returns `INVALID_PAYLOAD` without spawning anything.

If any of these flake more than 1 in 10 runs, that's a blocker until the flake is rooted out. Stability of the smoke path is the release gate, not a coverage percentage.
