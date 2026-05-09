# Architecture Critique

Compiled: 2026-05-09
Reviewer persona: principal architect, Electron + Node + SQLite + IPC.
Scope: `docs/03-plan/PRODUCT_SPEC.md`, `docs/03-plan/BUILD_BLUEPRINT.md`, `docs/03-plan/UI_SPEC.md`, with cross-references to `docs/01-investigation/02-bug-sweep.md` and `03-architecture-notes.md`.

## Summary

- 5 CRITICAL, 7 HIGH, 4 MEDIUM, 0 LOW.
- The spec is detailed and internally consistent, but it leaves several load-bearing concurrency, lifecycle, and security questions unanswered. Most are not "the spec is wrong" — they are "the spec is silent, and silence in these places will produce data loss, dangling subprocesses, or corrupted user files."

**Top 5 actionable changes the spec should adopt before Phase 2:**

1. Replace the generic `invoke` envelope with per-channel zod-validated request/response types and a streaming/cancellable variant for long-running calls (PTY data, MCP tool calls, swarm tails). Without this, the proxy is a string-typed soup at runtime even though it looks typed at compile time.
2. Define the mailbox concurrency contract explicitly: `O_APPEND` is not enough on Windows (NTFS + Node `fs.appendFile` does not always serialise across processes), and "atomic read-and-truncate" is not specified at all. Either move to a SQLite-only bus with the JSONL as a debug mirror, or specify a real lock file + offset cursor.
3. Specify the SigmaMemory MCP server lifecycle — process boundary, transport, discovery, restart policy, cleanup on workspace close. The current spec says "in-process stdio" *and* "per workspace" *and* "exposed to spawned agent CLIs" without resolving the contradictions.
4. Add a migrations strategy (Drizzle Kit + checksum table) before Phase 2. The spec promises Drizzle but ships hand-rolled CREATE TABLE in Phase 1 and adds tables every phase; without versioned migrations, every schema change after v1 ships will corrupt user data.
5. Define a credential storage policy (Electron `safeStorage` + OS keychain fallback) and a PTY-env policy (inherit shell env, redact known secret keys from logs). The spec lists 11 providers each with their own auth env vars and never says where they live.

---

## Critiques

### A1. Generic `invoke` proxy without per-channel schemas [CRITICAL]

**Spec ref**: PRODUCT_SPEC §11; architecture-notes §S1, W4.

**Concern**: The proxy in `src/shared/rpc.ts` accepts any string-keyed call over one IPC channel. "Type safety" is a TypeScript fiction — at runtime the renderer can pass any payload to any controller, and controllers receive `any`. No input validation, no streaming, no cancellation, no collision detection across the ~75 methods.

**Evidence**:
- §11 lists ~75 methods multiplexed through `invoke(channel, ...args)`.
- Bug-sweep W4/P1-RPC-PRELOAD already cover the security angle; type-shape is worse because main-side destructures `undefined` silently.
- `pty.subscribe` returns `{snapshot, cols, rows}` while live data flows on a separate `pty:data` event with no correlation id; cancellation impossible.
- Long-running calls (`workspaces.launch` for 16 panes, `swarms.create` Legion-50, `skills.ingest` multi-skill plugin) block on one promise with no progress.

**Remedy**:
1. Generate per-channel zod schemas from `router-shape.ts`; validate on both sides; reject mismatches with `{ok:false, error:{code:'BAD_INPUT', issues}}`.
2. Three envelope variants: `unary` (validated request/response), `stream` (returns `streamId`; main emits `rpc:stream {streamId, chunk}` then `{streamId, done}` — used for `swarms.tail`, `pty` snapshot replay, `review.runCommand`, `skills.ingest`), `cancellable` (returns `requestId` cancelled via `rpc.cancel`; main uses `AbortController`).
3. Auto-generate the preload allowlist from the schema registry so a typo fails the build.
4. Replace generic `invoke` with namespaced surfaces: `window.sigma.workspaces.launch(plan)` instead of `window.sigma.invoke('workspaces.launch', plan)`.

**Effort**: medium. Do it before Phase 2 or it becomes load-bearing.

---

### A2. Mailbox concurrency and crash-safety underspecified [CRITICAL]

**Spec ref**: PRODUCT_SPEC §5.3; BUILD_BLUEPRINT Phase 2.

**Concern**: Spec promises "append-only via POSIX `O_APPEND` for crash safety." Not portable to Windows as implied, and atomic read-and-truncate, restart offsets, and fsync policy are not addressed.

**Evidence**:
- On Windows, `O_APPEND` maps to `FILE_APPEND_DATA` — atomic per-write only with `FILE_SHARE_WRITE` and within sector size. Multi-process 8 KiB envelopes can interleave.
- Legion = 50 agents, 4 coordinators, all writing the outbox + per-agent inboxes simultaneously. Chokidar fires asynchronously; if renderer reads SQLite before watcher catches up, messages disappear from side-chat.
- "Atomically read-and-truncate" is standard inbox-queue semantics; the spec never says how agent CLIs (not our code) should do this. Coordinators will use offset-cursor tails, not truncation.
- Phase 2 AC5 rebuilds `swarm_messages` from JSONL, but each agent CLI has its own offset; orchestrator truncation loses history.

**Remedy**:
1. Make SQLite the system of record for the bus; JSONL becomes append-only debug mirror. Agent writes route through `swarms.send` RPC; main serialises into SQLite. Agents tail via `swarms.tail(swarmId, {sinceId})` or per-agent named pipe / unix socket opened by the supervisor.
2. If keeping JSONL as bus: per-file lockfile via `proper-lockfile`, never truncate, add `<inbox>.cursor` files per consumer.
3. fsync on every envelope write (~0.5–2 ms; tolerable at ~50 agents × ~1 msg/s).
4. Assign envelope ids on receive in the orchestrator; ULIDs are monotonic per-process only.

**Effort**: medium. SQLite-as-bus path is smaller.

---

### A3. SigmaMemory MCP server lifecycle is contradictory [CRITICAL]

**Spec ref**: PRODUCT_SPEC §6.1, §6.4; BUILD_BLUEPRINT Phase 5; §3.10.

**Concern**: §6.1 says "thin in-process server lives in `core/memory/server.ts`" with stdio transport. An in-process server has no stdio for *external* CLI agents. Spawned CLIs need a real transport. Spec never resolves: per-workspace vs global; renderer reload mid-tool-call; or 50-concurrent-agent contention.

**Evidence**:
- §6.1 says in-process stdio. §7 (skills fan-out) + per-agent MCP config writer in Phase 3/4 imply spawned CLIs see SigmaMemory as a server — impossible via in-process transport.
- 50 agents × 12 tools = up to ~600 inflight calls. SQLite serialises via `db.transaction(...)`, but §6.4 says "disk write first, then DB" — a slow NTFS/OneDrive rename holds the SQLite write lock.

**Remedy**:
1. Run SigmaMemory as a child process per workspace: stdio for the in-app assistant; loopback HTTP (ephemeral port) for spawned agent CLIs. Phase 4 agent-config writer injects the URL into `.mcp.json`/`config.toml`/Gemini manifest.
2. Supervisor lives in main and survives renderer reload. Persist port in `workspaces.memory_port`; restart supervisor and have CLIs reconnect on next launch.
3. Reverse §6.4 order: SQLite tx first (row + parse wikilinks + edges), disk write (atomic temp+rename) inside the tx commit hook. Disk failure rolls the tx back; slow rename does not hold the write lock alone.
4. Per-workspace async lock keyed on `(workspaceId, title)` prevents agents racing on the same memory file.

**Effort**: medium. In-process vs child-process is the load-bearing change.

---

### A4. Schema migrations strategy missing [CRITICAL]

**Spec ref**: PRODUCT_SPEC §10; BUILD_BLUEPRINT migrations `0002`..`0007`; architecture-notes W10.

**Concern**: Blueprint references six migrations; §10 says "Drizzle-managed." But runtime path is not specified — no bootstrap-vs-migrate discrimination, no checksum check, no policy for opening a v1.0 DB with a v1.1 binary.

**Evidence**:
- W10 already flags drift between bootstrap SQL and Drizzle schema.
- FK audit: `agent_sessions.workspace_id` cascades, but `worktrees.session_id` is SET NULL — workspace deletion leaves orphan worktree directories on disk.
- "WAL mode; busy timeout 5000ms" but no `wal_autocheckpoint` schedule. A 24h Legion run (~100k swarm_messages) balloons WAL to hundreds of MiB.
- Backup/restore unmentioned.

**Remedy**:
1. Adopt Drizzle Kit with versioned migrations and a `migrations` table holding `(id, applied_at, description, checksum)`.
2. On boot, compare applied checksums to disk; fail closed on mismatch.
3. Add `ON DELETE CASCADE` consistently for parent tables. Where SET NULL is intentional (`worktrees.session_id`), specify the janitor invariant: remove orphan worktree dirs whose `session_id` is null AND `removed_at` is null AND path is not in `git worktree list`.
4. `PRAGMA wal_autocheckpoint=1000;` plus daily `PRAGMA wal_checkpoint(TRUNCATE);` at idle.
5. `Settings → Backup database` using SQLite's online backup API, never `cp`.
6. Forward-only migrations; release notes for every schema change.

**Effort**: medium. Do this before Phase 2 ships any new table.

---

### A5. Credential storage policy absent [CRITICAL]

**Spec ref**: PRODUCT_SPEC §4, §15. Not explicitly covered.

**Concern**: 11 providers, each with its own auth (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `gh auth login`, kimi opaque token, cursor session, aider env reuse). Spec never says where these live, who reads them, how PTY inherits them, or how they appear in logs.

**Evidence**:
- §3.9 Settings has provider `command_override` but no credential field.
- §15 says "no accounts" but says nothing about local per-provider credentials.
- PTY spawn uses `process.env`. On macOS, an Electron app launched from Finder does not see `~/.zshrc` exports (classic "shell env invisible to GUI app" foot-gun).

**Remedy**:
1. Add `provider_credentials (provider_id, key_name, value_encrypted)` encrypted via Electron `safeStorage.encryptString` (OS keychain on mac/Windows; kwallet/gnome-keyring on Linux).
2. Settings → Credentials sub-panel per provider with masked inputs and a Test button (no-op probe).
3. Specify env-resolution order at spawn: (a) per-session overrides, (b) workspace-scoped vars, (c) decrypted credentials, (d) inherited `process.env`.
4. macOS: probe interactive shell env via one-shot `launchctl`/login-shell sourcing at first boot.
5. Redact known credential key names in the logger (W3 logger should bake this in).
6. Add new §16 "Credentials and PTY env" to the product spec.

**Effort**: medium.

---

### A6. PTY ring buffer + ANSI/Unicode + reconnect semantics underspecified [HIGH]

**Spec ref**: PRODUCT_SPEC §3.2, §10 table 4; bug-sweep P2-RING-BUFFER-CHAR-LIMIT, -UNICODE-SPLIT.

**Concern**: 256 KiB is small for verbose agents (Codex `/test` pasting a 50k-line stack trace). ANSI escapes split across the trim boundary leave dangling `\x1b[` bytes that mis-render in xterm. Reconnect semantics for renderer reloads after multi-MiB output are not specified.

**Evidence**:
- Bug-sweep flags both unicode-split and char-vs-byte.
- §10 caps at 256 KiB on flush; runtime in-memory cap unspecified.
- §10 table 4 stores last 256 KiB on flush, but says nothing about output between flush and reload.

**Remedy**:
1. Bump in-memory ring to 1 MiB; configurable per `agent_sessions.buffer_limit`. 256 KiB fine for disk flush.
2. Maintain a vt100 parser state alongside the ring (`node-ansiparser`); trim only at sequence boundaries.
3. Trim to UTF codepoint boundaries, not byte/code-unit boundaries.
4. Reconnect: registry keeps live ring + session-epoch counter; `pty.subscribe` returns both; renderer replays-or-reattaches based on epoch.
5. Sessions whose output exceeds 1 MiB also tee to `<userData>/sessions/<id>.log`; expose via Settings → Open session log.

**Effort**: small to medium.

---

### A7. Browser supervisor lifecycle and CDP version coupling [HIGH]

**Spec ref**: PRODUCT_SPEC §8.2; BUILD_BLUEPRINT Phase 3.

**Concern**: (a) `WebContentsView` uses bundled Chromium — WebView2 is not in the path; the user prompt's WebView2 question is a false alarm. (b) Electron's CDP version vs Playwright MCP's expected CDP can diverge across upgrades and break silently. (c) `npx @playwright/mcp@latest` fails offline. (d) Workspace-close ownership undefined when two windows share a workspace.

**Evidence**:
- §8.2 uses `npx ... @latest`; first-run requires network.
- AC4 needs a 100 ms signal back to main for the drive indicator; mechanism unspecified (likely stdout parsing — brittle).

**Remedy**:
1. Drop WebView2 from the threat model; the embedded browser is Electron's Chromium.
2. Bundle `@playwright/mcp` as a pinned dependency; do not `npx` latest at runtime.
3. Pin expected CDP version; probe `Browser.getVersion` at supervisor start; abort with a clear error on mismatch.
4. Drive-indicator signal flows over a named pipe / unix socket the supervisor opens — not stdout parsing.
5. Define `WorkspaceLifecycle { supervisor, sessions, browserTabs, mcpClients }` with `dispose()` called on close/quit/crash recovery; ref-count when shared across windows.
6. Document the `--cdp-endpoint` choice so future agents do not "fix" the missing Playwright Chromium download.

**Effort**: medium.

---

### A8. Skills fan-out collisions and OneDrive locks [HIGH]

**Spec ref**: PRODUCT_SPEC §7.2, §7.3; BUILD_BLUEPRINT Phase 4.

**Concern**: Fan-out copies into `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/extensions` collide with user-authored skills. On Windows these paths are commonly under OneDrive-synced `%USERPROFILE%`, which is sync-locked unpredictably. Disabling silently overwrites hand-edited fan-out copies.

**Evidence**:
- §7.3 says "hard copy" for Claude; no collision detection.
- OneDrive Files On-Demand can render writes as `EACCES`/`EBUSY`.
- "Disabling deletes the fan-out copy but keeps the canonical" — silent if user edited it.

**Remedy**:
1. Hash existing target before write; on diff vs canonical, emit a "skill conflict" badge with {keep theirs / replace / merge} options.
2. Detect OneDrive paths on Windows; retry with backoff and surface a one-time onboarding warning.
3. Tag fan-out copies with `x-sigma-managed: <hash>` frontmatter; on disable, only delete if hash unchanged.
4. Add `skills.dryRun(path)` RPC returning planned writes + collisions; UI shows a confirmation summary.
5. Document canonical-vs-fan-out invariant in §7.

**Effort**: small to medium.

---

### A9. Worktree pool: detached HEAD, submodules, LFS, large repos [HIGH]

**Spec ref**: PRODUCT_SPEC §C-001; BUILD_BLUEPRINT Phase 1.5; bug-sweep P1-WORKTREE-PATH-COLLISION.

**Concern**: Spec assumes a clean named HEAD. Does not address detached HEAD, submodules, Git LFS, or 5 GB monorepos where `git worktree add` takes 30–120 s and blocks the UI.

**Evidence**:
- §10 has `base_branch DEFAULT 'HEAD'` but no behaviour when HEAD is detached.
- Submodules are not mentioned; `git worktree add` does not auto-init them.
- LFS pointer files copy; `git lfs pull` is never run.
- No streaming of `git worktree add` progress.

**Remedy**:
1. Detect detached HEAD via `git symbolic-ref -q HEAD`; force the launcher dialog to require an explicit base branch.
2. Workspace-level `recurse_submodules` setting; run `git submodule update --init --recursive` after add.
3. Detect `filter=lfs` in `.gitattributes`; run `git lfs pull` with progress events.
4. Stream `git worktree add --progress`; emit `workspace:worktreeProgress`; launcher shows per-pane progress bars.
5. Document shared-object-pool semantics in the spec to dispel disk-cost worries.
6. Reject `--force` / `--force-with-lease` at orchestration layer; add `git config worktree.guessRemote false`.

**Effort**: medium.

---

### A10. Failure modes lack a janitor [HIGH]

**Spec ref**: PRODUCT_SPEC §3.9; BUILD_BLUEPRINT Phase 1.5 AC7; architecture-notes W7.

**Concern**: BP Phase 1.5 AC7 covers graceful quit only. Hard quit (kill -9, OS crash, power loss) leaves stuck `running` rows, orphan worktrees, stale MCP supervisor PIDs. Missing `git user.email` causes silent commit failure.

**Remedy**:
1. `bootJanitor()` runs before RPC registration: mark stale `running` sessions as `error`; reconcile `worktrees` rows against `git worktree list --porcelain`; refresh `providers_state.found`; check `git config user.email` and prompt to set; `PRAGMA integrity_check` and prompt for backup restore on failure.
2. Periodic janitor (5 min) for in-flight workspaces.
3. Settings → Diagnostics → Run Health Check.
4. `docs/RECOVERY.md` operator runbook.

**Effort**: small to medium.

---

### A11. Multi-window concurrency is undefined [HIGH]

**Spec ref**: PRODUCT_SPEC §3; architecture-notes §S1.

**Concern**: §3 implies one `BrowserWindow`. Bug-sweep P1-IPC-EVENT-RACE-CROSSWINDOW shows multi-window has been considered tactically (PTY events broadcast to every window) but not architecturally.

**Remedy**:
1. Decide: v1 ships single-window — disable Cmd+Shift+N; document "multi-window deferred to v1.1" in §15.
2. Or spec the model: PtyRegistry/DB/MCP supervisors are main-side singletons; each window has its own renderer state + per-window event subscriptions (W6 fix); same workspace can open in N windows; an in-memory `windows` registry tracks `(windowId, workspaceId)` so `workspace.close` only disposes when refcount = 0.

**Effort**: small if deferred; large if shipped in v1.

---

### A12. Native module distribution and rebuilds [HIGH]

**Spec ref**: PRODUCT_SPEC §15; BUILD_BLUEPRINT Phase 8.

**Concern**: `better-sqlite3` and `node-pty` need rebuilds for the exact Electron ABI. Spec says nothing about pipeline, prebuilt binaries, or first-run-binary-missing UX. node-pty has had Windows ConPTY churn across Electron 30..32; the spec pins nothing.

**Remedy**:
1. Phase 8 CI matrix gains `electron-rebuild` per OS×arch (win-x64, mac-arm64, mac-x64, linux-x64); pin Electron version.
2. `electron-builder` `nodeGypRebuild: true` + `prebuild-install` cache.
3. CI smoke test: import both modules, assert version strings.
4. Boot version check: if installed app is older than `migrations.id MAX`, block with "please update."

**Effort**: small.

---

### A13. Concurrency in the swarm — SQLite single-writer + filesystem [HIGH]

**Spec ref**: PRODUCT_SPEC §5; BUILD_BLUEPRINT Phase 2 AC5.

**Concern**: 50 agents writing memories + mailbox + skills + history + task events bottleneck on SQLite's single-writer property. Spec names no queue/serialiser. Phase 2 AC5 reconstruction (~100k JSONL lines at once) is a write storm.

**Remedy**:
1. Single main-side write queue per DB (microtask FIFO). All write RPCs await `queue.run(() => db.transaction(...))`. Reads bypass.
2. `swarm_messages` reconstruction streams `INSERT OR IGNORE` in batches of 1000 with progress events.
3. Per-workspace filesystem queue (`p-queue`, concurrency 4–8) for `<userData>/swarms/...` and `.sigmamemory/`.
4. Skills fan-out queue concurrency 1 per provider target to avoid `~/.claude/skills` Spotlight thrash.
5. Document budget: ~500 writes/s sustained on commodity SSD.

**Effort**: small.

---

### A14. "Launch 16 agents <1s" budget is optimistic [MEDIUM]

**Spec ref**: BUILD_BLUEPRINT Phase 1.5 (no time budget); marketing copy.

**Concern**: 16 worktree creations (~50–500 ms each) + 16 ConPTY spawns (80–250 ms each on Windows) + 16 DB inserts. Worst-case dominated by NTFS latency and ConPTY startup. `[speculation]` ConPTY 80–250 ms — based on prior measurements; should be confirmed by Phase 8 perf benchmark.

**Remedy**:
1. Explicit budget: P50 < 1.5 s, P95 < 3 s on Windows. Surface per-pane spinner from click to first byte.
2. `Promise.all` for worktrees, capped at `min(4, cpu)` to avoid disk thrash.
3. PTY spawns in parallel; do not await initial-prompt write.
4. Add launch-16 P50/P95 benchmark to the CI test plan.
5. Fallback "lazy worktree" mode — pane spawns against workspace root; `worktree add` on first write.

**Effort**: small.

---

### A15. Test infrastructure — PTY and MCP in CI [MEDIUM]

**Spec ref**: BUILD_BLUEPRINT Phase 8.

**Concern**: Vitest runs in Node, not Electron; node-pty's ABI differs. Phase 8 does not split test rings. Windows CI ConPTY quirks fail unrelated tests.

**Remedy**:
1. Three rings: **unit (Vitest)** for pure logic (`spawn-resolve`, `wikilinks`, `validator`, `locks`, mailbox parser); **integration** in Electron's Node ABI via `electron-mocha` or `playwright._electron.launch` for PTY happy-path, DB tx, MCP roundtrip; **e2e (@playwright/test)** for renderer flows.
2. MCP server mocked via stdin/stdout pipes; tests assert envelopes against the same zod schemas used in production.
3. CI matrix: {win, mac, linux} × {unit, integration}; e2e on Linux only.
4. Synthetic `echo-shim` provider for integration; do not depend on real CLIs in CI.

**Effort**: small to medium.

---

### A16. Telemetry [MEDIUM]

**Spec ref**: PRODUCT_SPEC §3.9, §15.

**Concern**: Spec is explicit (off by default, opt-in). Remaining question: what would opt-in even collect, given local-only with no backend?

**Remedy**:
1. v1 ships zero telemetry, no toggle. Defer to v1.1 when a concrete backend exists.
2. Document in `PRIVACY.md`: the app makes zero unsolicited network requests outside user-installed provider CLIs.
3. Network-call audit test intercepts `net`/`https` and asserts no outbound requests during a fresh-install flow.

**Effort**: small.

---

## Recommended spec edits

- [ ] `PRODUCT_SPEC.md` §11 — replace "all RPC follows `<namespace>.<method>` and returns `{ ok: true, data } | { ok: false, error }`" with a three-envelope spec (unary/stream/cancellable), require zod schemas per channel, and reference an auto-generated preload allowlist.
- [ ] `PRODUCT_SPEC.md` §5.3 — replace the bare `O_APPEND` claim with an explicit concurrency contract: SQLite-as-bus (preferred) OR locked-JSONL with per-consumer cursor files. Document fsync policy.
- [ ] `PRODUCT_SPEC.md` §6 — add a §6.5 SigmaMemory process model: child process per workspace, stdio for in-app callers, loopback HTTP for spawned CLIs, port persisted in `workspaces.memory_port`. Reverse §6.4 transaction order (DB first, disk second, both in one tx).
- [ ] `PRODUCT_SPEC.md` §10 — add a `provider_credentials` table; add `workspaces.memory_port`; tighten `ON DELETE` clauses for `worktrees`, `agent_sessions`, `tasks` parent links.
- [ ] `PRODUCT_SPEC.md` add §16 "Credential storage and PTY env" covering safeStorage, env resolution order, and macOS shell-env probe.
- [ ] `PRODUCT_SPEC.md` add §17 "Boot janitor and recovery" covering crash recovery, orphan worktrees, stuck DB rows.
- [ ] `PRODUCT_SPEC.md` §3 — clarify single-window vs multi-window. If single-window, document; if multi-window, spec the lifecycle owner.
- [ ] `PRODUCT_SPEC.md` §15 — drop telemetry opt-in until v1.1; add explicit "no outbound network traffic" guarantee.
- [ ] `BUILD_BLUEPRINT.md` Phase 1.5 — add task: introduce migrations framework (Drizzle Kit), commit `0001_init.sql`, ship `migrations` runner; remove hand-rolled CREATE TABLE.
- [ ] `BUILD_BLUEPRINT.md` Phase 1.5 — add task: zod schemas per channel + preload allowlist generator + RPC envelope refactor.
- [ ] `BUILD_BLUEPRINT.md` Phase 2 — add task: SQLite-as-bus primary path; JSONL becomes a debug mirror. Define ULID-on-receive ordering invariant.
- [ ] `BUILD_BLUEPRINT.md` Phase 2 — add task: write queue / per-workspace filesystem queue.
- [ ] `BUILD_BLUEPRINT.md` Phase 3 — pin `@playwright/mcp` as a real dep, not `npx`-latest. Add CDP version probe at supervisor start.
- [ ] `BUILD_BLUEPRINT.md` Phase 4 — add collision detection + OneDrive heuristic + managed-by-SigmaLink frontmatter tag.
- [ ] `BUILD_BLUEPRINT.md` Phase 5 — split the in-process server into a child-process supervisor; persist port in DB; reverse transaction order.
- [ ] `BUILD_BLUEPRINT.md` Phase 6 — add detached-HEAD / submodule / LFS / large-repo paths to the worktree pool. Stream worktree-add progress.
- [ ] `BUILD_BLUEPRINT.md` Phase 8 — split tests into unit/integration/e2e; add `electron-rebuild` step; add network-call audit test; add launch-16 perf benchmark.
- [ ] `UI_SPEC.md` add a new component group "Progress & Recovery" — pane-spawn spinner, worktree progress bar, skill conflict resolver, health-check banner, per-provider credential editor.
- [ ] `UI_SPEC.md` Components — define `RpcProgress` (streamed RPC progress UI), `JanitorBanner` (boot-janitor results), `CredentialField` (safeStorage-backed input).

---

## Speculation flags

- `[speculation]` ConPTY 80–250 ms per spawn on Windows 11 — based on prior measurements on similar hardware; should be confirmed by Phase 8 perf benchmark.
- `[speculation]` Electron 30 CDP version 1.3 — Electron tracks Chromium's CDP; the exact version pin should be verified at Phase 3 kickoff.
- `[speculation]` OneDrive `EBUSY` failures on `~/.claude` writes — based on user reports; reproducibility varies. The OneDrive heuristic is a defensive measure; whether it triggers in practice is empirical.
- `[speculation]` Playwright MCP CDP compatibility window — Playwright's release cadence is faster than Electron's; the supervisor pin protects against this but does not eliminate the risk that a Chromium upstream change breaks both.

---

## Closing note

The spec is in good shape relative to most pre-Phase-2 efforts I have reviewed. It is internally consistent, names its decisions, and tracks open questions. The five CRITICAL items above are the load-bearing ones — fix RPC envelopes, mailbox concurrency, MCP server lifecycle, migrations, and credential storage before Phase 2 ships, and the rest of the architecture has room to evolve. Leaving any of those five for "later" will make Phase 2 a refactor disguised as a feature.
