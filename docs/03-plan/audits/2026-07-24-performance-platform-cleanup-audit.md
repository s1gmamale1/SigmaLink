# SigmaLink Performance, Reliability, and Platform Audit

**Date:** 2026-07-24
**Branch:** `audit/performance-platform-cleanup-2026-07-24`
**Baseline commit:** `d265d7e`
**Design:** [2026-07-24-performance-platform-cleanup-audit-design.md](../../superpowers/specs/2026-07-24-performance-platform-cleanup-audit-design.md)

## Scope and evidence rules

This audit covers SigmaLink's Electron main process, React renderer, pane and terminal stack, PTY/process lifecycle, database and memory systems, macOS/Windows behavior, startup/build/dependency overhead, product-surface reachability, and verification blind spots.

Evidence classes:

- **Confirmed:** a deterministic test, command, runtime trace/profile, benchmark, or direct state inspection demonstrates both cause and effect.
- **Strong static evidence:** the full reachable ownership/data-flow path demonstrates an invariant violation, but a safe runtime reproduction is unavailable.
- **Hypothesis:** plausible and cited, but missing enough evidence that it must not be described as a defect or optimization win.
- **Rejected:** disproved, already mitigated, unreachable, immaterial at current scale, or based on an incorrect assumption.

A specialist report is only a candidate. The primary agent must inspect the cited source and independently reproduce, measure, or trace the claim before it can move into **Verified findings**.

## Environment and baseline

### Host and worktree

- Worktree: `/Users/aisigma/projects/SigmaLink-wt-audit-2026-07-24`
- Branch: `audit/performance-platform-cleanup-2026-07-24`
- Host: Apple Silicon, macOS 26.4 (25E246), Darwin 25.4.0
- Node: `v22.22.3`
- pnpm: `11.0.9`
- Git status before dependency setup: clean

### Dependency setup receipt

The repository does not provide a reproducible clean-worktree install on this host:

1. `pnpm install --frozen-lockfile` exited 1 with `ERR_PNPM_NO_LOCKFILE`. The only app lockfile path is ignored by `.gitignore` (`.gitignore:123`), and no lockfile is tracked.
2. A read-only attempt using the original checkout's ignored lockfile (SHA-256 `d1cd213d46a407b4bf49538eb0d9868c21c166487d41a73cf03ed021fa7358b3`) exited 1 with `ERR_PNPM_OUTDATED_LOCKFILE`: three current dependencies were absent and three removed dependencies remained.
3. An isolated `pnpm install --no-frozen-lockfile` resolved 878 packages, generated an ignored lockfile (SHA-256 `be659277297615b0db014c6d4130e1148782d75c92128cf29bf115eb5aaf3bcd`), then exited 1 because pnpm 11 blocked required native build scripts and the app postinstall could not rebuild `better-sqlite3`.
4. A temporary, worktree-only build approval let `esbuild`, `node-pty`, `better-sqlite3`, and Electron install scripts run, but the rebuild exited 228 with `ENOSPC`. The temporary tracked configuration was removed. The 790 MB generated `node_modules` was moved to macOS Trash as `~/.Trash/node_modules` and remains recoverable.
5. To continue source verification without touching the original dependencies, the audit worktree's ignored `app/node_modules` is a symlink to `/Users/aisigma/projects/SigmaLink/app/node_modules`.

The reused dependency tree is sufficient for the baseline gates but is stale relative to the current manifest: `pnpm list --depth 0` includes removed direct dependencies (`@radix-ui/react-separator`, `monaco-editor`, `recharts`) and does not reflect all newly declared direct dependencies. Therefore, the green build proves the checked-out source compiles against the operator's existing install; it does not prove a fresh clone resolves the same graph.

### Pre-change gates

| Command | Result | Receipt |
|---|---:|---|
| `pnpm test` | PASS | 477 files passed; 5,013 tests passed; 2 skipped; Vitest duration 69.58 s. Repeated jsdom canvas warnings and per-worker `NO_COLOR`/`FORCE_COLOR` warnings were non-fatal. |
| `pnpm lint` | PASS | ESLint exited 0 with no findings. |
| `pnpm build` | PASS | TypeScript project build and Vite production build exited 0; 2,131 modules transformed; Vite phase 5.39 s. |
| `pnpm electron:compile` | PASS | Main, preload, and three MCP entry bundles built successfully. |
| `pnpm test:perf` | NOT RUN | Safety hold: the perf spec launches Electron without a throwaway `--user-data-dir` (`app/tests/perf/jank-review.spec.ts:76-80`), while router boot opens the database under `app.getPath('userData')` (`app/src/main/rpc-router.ts:444-455`). This candidate requires independent trace/review before execution. |

### Artifact baseline

- Renderer `dist/`: 2.0 MB total.
- Largest renderer asset: `vendor-xterm-*.js`, 607.27 kB raw / 155.10 kB gzip.
- Main renderer entry chunk: `index-*.js`, 349.64 kB raw / 102.59 kB gzip.
- Settings chunk: 142.77 kB raw / 32.85 kB gzip.
- Electron `electron-dist/`: 14 MB total, including source maps.
- Electron main bundle: 4.1 MB; main source map: 8.2 MB.
- MCP memory server bundle: 421.4 kB; source map: 978.9 kB.

## Candidate ledger

| ID | Area | Candidate | Initial class | Primary evidence | Status |
|---|---|---|---|---|---|
| C-001 | dependency/build | A fresh clone cannot perform a deterministic locked install; the ignored local lock is stale and pnpm 11 build approvals are not encoded. | Confirmed setup reproduction | `.gitignore:123`; `app/package.json:35-109`; three literal install failures in the baseline receipt | Verified critical release risk; remediation blocked on a clean install/artifact gate |
| C-002 | perf/test safety | Nine of twelve Electron launch expressions use the operator's real profile and can migrate the live database, run janitors, restore workspaces, and respawn panes. | Confirmed source/data-flow trace | Electron test launch enumeration → `app/src/main/rpc-router.ts:444-509` → database/session restore | Fixed: all launch expressions use enforced isolated profile/home/workspace roots |
| C-003 | PTY/protocol memory | An unterminated PTY line can grow `ProtocolLineBuffer.acc` without a bound; every normal pane feeds one prompt-sink buffer and swarm panes feed a second protocol buffer. | Confirmed | `app/src/main/core/swarms/protocol.ts:112-151`; `app/src/main/core/pty/registry.ts:352-354`; `app/src/main/core/swarms/factory-spawn.ts:541-554` | Fixed: an overlong logical line is discarded through its newline; later lines recover normally |
| C-004 | process lifecycle | Both Ruflo daemon supervisors test `child.killed` before SIGKILL escalation, but Node sets it when a signal is sent rather than when the child exits. | Confirmed | `app/src/main/core/ruflo/http-daemon-supervisor.ts:841-864`; `app/src/main/core/ruflo/supervisor.ts:150-173` | Fixed: exit state/event controls escalation |
| C-005 | Memory MCP lifecycle | Electron-owned Memory MCP children receive only synchronous SIGTERM and are forgotten immediately; app shutdown does not await their exit before closing the database. | Strong static evidence | historical path at `git show 80065c3:app/src/main/core/memory/mcp-supervisor.ts` lines 79-95; `app/src/main/rpc-router.ts:3747-3750,3841-3844` | Eliminated with C-023: Electron no longer owns this child |
| C-006 | process performance | Batch process-tree stop enumerates the entire process table once per root instead of once per batch. | Confirmed | `app/src/main/core/process/process-tree.ts:169-177` | Fixed: one snapshot per batch |
| C-007 | shutdown lifecycle | POSIX descendant escalation can run after the shutdown wait and database close because tree-stop returns immediately, schedules SIGKILL at 5 s, and shutdown waits only captured root PIDs for 2.5 s. | Strong static evidence | `app/src/main/core/process/process-tree.ts:205-236`; `app/src/main/core/pty/registry.ts:642-663`; `app/src/main/rpc-router.ts:3728-3739,3826-3844` | Verified; remediation pending |
| C-008 | account-switch lifecycle | A timed-out Claude account switch leaves `expectedExit` set; a later real exit then bypasses normal persistence/cleanup. | Strong static evidence | `app/src/main/core/pty/claude-account-watch.ts:288-293`; `app/src/main/core/pty/registry.ts:528-531`; `app/src/main/core/pty/resume-launcher.ts:303-308` | Verified; remediation pending |
| C-009 | startup/network | Idle prefetch invokes every lazy room loader after first paint, converting code-splitting into deferred full-app loading. | Strong static evidence | `app/src/renderer/app/room-loaders.ts:25-86,99-125`; `app/src/renderer/app/App.tsx:290-293` | Verified optimization candidate |
| C-010 | renderer lifecycle | With the default-enabled rail and default Browser tab, Editor and Jorvis bodies still mount inside CSS-hidden panels and start KV, filesystem, conversation, health, and event work. | Strong static evidence | `app/src/renderer/features/right-rail/use-right-rail-enabled.ts:9-18`; `app/src/renderer/features/right-rail/RightRailContext.data.ts:10-15`; `app/src/renderer/features/right-rail/RightRail.tsx:188-242`; `app/src/renderer/features/right-rail/RightRailTabs.tsx:83-103` | Verified; remediation pending |
| C-011 | editor correctness | A dirty Editor mounted in a hidden rail panel intercepts the global Cmd/Ctrl+S shortcut and saves/prevents the event. | Strong static evidence | `app/src/renderer/features/editor/EditorTab.tsx:247-265`; mount path at `app/src/renderer/features/right-rail/RightRail.tsx:195-242` | Verified; remediation pending |
| C-012 | renderer leak | Editor sidebar drag installs window pointer listeners, an animation-frame callback, and a body flag with cleanup only on pointer-up, not component unmount. | Strong static evidence | `app/src/renderer/features/editor/EditorTab.tsx:171-225` | Verified; remediation pending |
| C-013 | renderer memory | Renderer-mode resolutions and the set of sessions that ever produced PTY data retain closed session IDs for the renderer lifetime; production teardown has no delete path. | Strong static evidence | `app/src/renderer/lib/renderer-flag.ts:30-71`; `app/src/renderer/lib/pty-data-bus.ts:25-33,53-65,92-113` | Verified low-severity accumulation |
| C-014 | assistant scalability | Conversation hydration loads every message and the transcript mounts every row; there is no page/window boundary. | Strong static evidence | `app/src/main/core/assistant/conversations.ts:162-177`; `app/src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts:103-134`; `app/src/renderer/features/jorvis-assistant/ChatTranscript.tsx:118-181` | Verified; remediation pending |
| C-015 | assistant scalability | Active-conversation pane events are unbounded; every append clones the full array and the room renders every event card. | Strong static evidence | `app/src/renderer/features/jorvis-assistant/use-jorvis-pane-events.ts:14-69`; `app/src/renderer/features/jorvis-assistant/JorvisRoom.tsx:427-435` | Verified; remediation pending |
| C-016 | hidden work | Once activated, the hidden Swarm rail remains subscribed and repeats full-message derived scans on updates. | Strong static evidence | `app/src/renderer/features/right-rail/RightRail.tsx:119-123,216-227`; `app/src/renderer/features/right-rail/SwarmRailTab.tsx:22-106` | Verified low-severity optimization candidate |
| C-017 | terminal memory | Permanent pane and scratch cleanup disposes only cached xterm terminals, not default DOM engines; those engines retain parsed scrollback and subscriptions until LRU eviction. | Strong static evidence | `app/src/renderer/app/state-hooks/use-terminal-cache-gc.ts:17-73`; `app/src/renderer/lib/scratch-tabs.ts:20-88`; `app/src/renderer/lib/engine-cache.ts:20-53,73-100,131-151` | Fixed: both renderer caches disposed |
| C-018 | terminal render performance | FlowView materializes the entire headless scrollback on every coalesced output render and only then slices to 1,500 logical lines. | Confirmed | `app/src/renderer/features/command-room/FlowView.tsx:202-235`; `app/src/renderer/lib/terminal-engine.ts:211-240` | Fixed: bounded reverse logical-tail scan |
| C-019 | terminal hidden work | CSS-hidden panes may continue presenter subscriptions and retain xterm WebGL resources while not visible. | Hypothesis | `app/src/renderer/features/command-room/PaneGrid.tsx:314-337`; `app/src/renderer/features/command-room/PaneShell.tsx:599-610`; `app/src/renderer/lib/terminal-cache.ts:539-569` | Verification candidate only; renderer/GPU profiling required |
| C-020 | renderer switch | DOM/xterm mutual exclusion is enforced in a parent passive effect after the replacement host creates its cache entry, allowing a brief dual-subscription interval. | Strong static evidence | `app/src/renderer/features/command-room/Terminal.tsx:240-280`; `app/src/renderer/features/command-room/DomTerminalView.tsx:58-79` | Verified low-frequency correctness risk |
| C-021 | persistence correctness | The 256 KiB persisted scrollback cap compares UTF-8 bytes but truncates UTF-16 code units, so multibyte content can exceed the documented cap. | Confirmed | `app/src/main/core/pty/scrollback-store.ts:16,41-43` | Fixed: valid UTF-8 byte tail |
| C-022 | database restore | Live database restore can leave the process uninitialized on lock failure and leaves process-lifetime consumers holding the closed pre-restore handle on success. | Confirmed | `app/src/renderer/features/settings/StorageTab.tsx:87-101`; `app/src/main/core/memory/controller.ts:180-198`; `app/src/main/core/db/client.ts:414-454`; `app/src/main/core/sync/engine.ts:159-169` | Critical; redesign required before enabling live restore |
| C-023 | Memory MCP overhead | Electron starts an idle Memory MCP child per workspace even though configured clients launch their own stdio server; workspace removal does not stop the resident child. | Confirmed | historical child creation at `git show 80065c3:app/src/main/core/memory/mcp-supervisor.ts` lines 51-76 and 127-164 | Fixed: registry-only command lifecycle, no Electron child |
| C-024 | memory cache consistency | The legacy in-process `MemoryIndex` retains full note bodies/tokens and becomes stale when another Memory MCP process writes the database. | Confirmed | `app/src/main/core/memory/manager.ts:339-345`; `app/src/main/core/memory/index.ts:88-109,127-156`; `app/src/main/core/memory/mcp-server.ts:304-323` | Verified high-severity correctness/memory issue; remediation pending |
| C-025 | memory persistence | Concurrent Memory MCP processes can interleave independent database-first and file-second writes, leaving the database and Markdown source divergent. | Strong static evidence plus controlled interleaving | `app/src/main/core/memory/manager.ts:375-407`; `app/src/main/core/memory/db.ts:202-226`; `app/src/main/core/memory/storage.ts:124-159` | Verified; transactional design required |
| C-026 | query performance | Mission event reads load and sort the complete event history in JavaScript before slicing the requested limit despite a supporting SQL index. | Confirmed | `app/src/main/core/missions/dao.ts:300-308`; `app/src/main/core/db/schema.ts:626-636` | Verified low-risk optimization candidate |
| C-027 | main-process memory | `conversationWorkspaceCache` is lifetime-unbounded and conversation deletion has no eviction path. | Strong static evidence | `app/src/main/rpc-router.ts:350-359`; `app/src/main/core/assistant/conversations.ts:259-265` | Verified low-severity accumulation |
| C-028 | startup latency | Router registration blocks first-window creation on serial worktree pruning and recursive janitor/image cleanup whose time budgets do not preempt an in-progress repository operation. | Strong static evidence | `app/electron/main.ts:1017-1018`; `app/src/main/rpc-router.ts:484-503`; `app/src/main/core/workspaces/worktree-cleanup.ts:159-177,235-250`; `app/src/main/core/db/janitor.ts:103-115` | Verified; ordering/correctness design required |
| C-029 | packaged voice | Root production dependencies and builder inputs omit the macOS/Windows voice packages that runtime loaders expect. | Strong static packaging evidence | `app/package.json:50-51`; `app/packages/voice-core/package.json:21-25`; `app/electron-builder.yml:7-10` | High; packaged-artifact/device verification required |
| C-030 | startup composition | Optional sync is constructed on every router boot, and static imports pull `isomorphic-git` and `libsodium` into startup. | Confirmed composition; directional import timing only | `app/src/main/rpc-router.ts:165,3244-3248`; `app/src/main/core/sync/controller.ts:12-31`; `app/src/main/core/sync/engine.ts:21-36`; `app/src/main/core/sync/git-client.ts:26-29`; `app/src/main/core/sync/crypto.ts:40` | Verified optimization candidate; Electron boot benchmark required |
| C-031 | release build | Native dependency rebuilds are requested by postinstall, release scripts, and electron-builder's default `npmRebuild: true`. | Confirmed configuration | `app/package.json:24-32`; `app/electron-builder.yml:29-30`; `.github/workflows/release-macos.yml:81-94`; `.github/workflows/release-windows.yml:74-91`; `.github/workflows/release-linux.yml:65-68` | Verified build-time duplication |
| C-032 | package size | Linked source maps are included in `electron-dist`, renderer `dist` is copied both as application files and `extraResources`, and `asar` is disabled. | Confirmed configuration/artifact measurement | `app/scripts/build-electron.cjs:14-20`; `app/electron-builder.yml:7-10,25-33`; baseline artifact-size commands above | Verified package-size candidates; packaged diff required |
| C-033 | macOS release | The release workflow checks `app/native/voice-mac/...` while already running with `app` as its working directory. | Confirmed | `.github/workflows/release-macos.yml:33-35,89-94` | Fixed workflow path |
| C-034 | Windows voice | The Windows fallback stub reports itself unavailable, but the wrapper treated module presence or a pending probe as availability and selected an unusable native path in auto mode. | Confirmed injected platform branch plus deferred-Promise regression | `app/native/voice-win/index.js:18-48`; `app/src/main/core/voice/native-win.ts:80-153`; `app/src/main/core/voice/adapter.ts:125-226,305-366`; `app/src/main/core/voice/adapter-win.test.ts:1-150` | Fixed: first launch and auto engine selection await the cached real probe; live Windows device validation remains gated |
| C-035 | packaged icons | Tray and notification code reads `build/icon*` at runtime, but builder resources are not automatically application files and `build` is excluded. | Strong static packaging evidence | `app/electron/main.ts:165-185`; `app/src/main/core/notifications/os-notify.ts:144-153`; `app/electron-builder.yml:4-10` | Medium; packaged-artifact verification required |
| C-036 | review process lifecycle | ReviewRunner stops only the spawned root process, allowing descendants to survive Stop and app shutdown. | Confirmed on POSIX | `app/src/main/core/review/runner.ts:52-85,166-183`; `app/src/main/rpc-router.ts:3768-3786` | Verified high-severity lifecycle issue; Windows branch verification pending |
| C-037 | macOS environment | Interactive-login shell banner output is accepted as the discovered PATH and cached verbatim. | Confirmed injected parser path | historical parser at `git show 80065c3:app/src/main/core/util/shell-path.ts` lines 63-73; current boot call at `app/electron/main.ts:983-999` | Fixed: nonce-delimited PATH payload |
| C-038 | Windows multi-instance | Boot orphan sweep matches every memory-server command line except the current main PID, so another SigmaLink profile can be force-killed. | Confirmed injected matching; strong kill trace | `app/src/main/core/process/orphan-sweep.ts:30-49,69-101`; `app/src/main/rpc-router.ts:446-452` | Verified high-severity issue; ownership design required |
| C-039 | Windows path handling | `%VAR%` expansion in legal directory names may alter shell-open paths. | Hypothesis | `app/src/main/core/util/windows-spawn.ts:181` | Verification candidate only; deferred for Windows device confirmation |
| C-040 | test isolation | Isolating only Electron `userData` still permits workspace `.mcp.json`/`CLAUDE.md`, operator-home configuration, and a launch-failure reporter to write outside the disposable profile. | Strong static evidence | `app/src/main/core/workspaces/factory.ts:324-371`; `app/src/main/core/workspaces/mcp-autowrite.ts:113-195`; `app/src/main/core/ruflo/seed-workspace-memory.ts:115-150`; historical write at `git show 03c910e:app/tests/e2e/smoke.spec.ts` lines 171-174 | Fixed: helper owns home/platform/workspace roots and `be185c8` removes the tracked-source write |
| C-041 | smoke coverage | The broad smoke test treats raw RPC envelopes as arrays, swallows failures, logs duplicate frames, and gates only on the count of attempted screenshots. | Confirmed source contract mismatch | `app/src/main/rpc-router.ts:3476-3510`; `app/electron/preload.ts:33-39`; `app/tests/e2e/smoke.spec.ts:240-270,689-722` | Verified false-green risk |
| C-042 | performance gate | The perf test starts after boot, ignores navigation failures, records metrics without budgets, has no memory/child-count soak, and is absent from CI. | Confirmed | `app/tests/perf/jank-review.spec.ts:123-191`; literal workflow-absence receipt below | Verified high-severity blind spot |
| C-043 | lifecycle coverage | Exact pane-preservation regressions are skipped or environment-gated, and pane-split uses a stale RPC shape before reaching pane behavior. | Confirmed | `app/tests/e2e/multi-workspace.spec.ts:175-188`; `app/tests/e2e/pane-split.spec.ts:42-69`; `.github/workflows/e2e-matrix.yml:83-103` | Verified high-severity blind spot |
| C-044 | process test fidelity | Supervisor lifecycle tests use synthetic EventEmitter children, and router shutdown ordering is asserted by source-text position rather than real process behavior. | Confirmed | `app/src/main/core/ruflo/supervisor.test.ts:20-41`; `app/src/main/core/ruflo/http-daemon-supervisor.test.ts:121-145`; `app/src/main/rpc-router.shutdown-order.test.ts:20-24` | Verified fidelity gap; real trapped-child, descendant, and shutdown-order coverage remains pending |
| C-045 | E2E lifecycle | Several Electron tests closed the application only on the success path; `min-window` also launched before entering `try`, so launch rejection skipped profile cleanup. | Strong static evidence plus reviewer control-flow trace | historical launch at `git show 03c910e:app/tests/e2e/min-window.spec.ts` lines 52-59; fixed path in `app/tests/e2e/min-window.spec.ts:52-66` | Fixed: teardown/finally covers launch failure and post-launch assertions |
| C-046 | release validation | CI has unpackaged OS breadth but no packaged app launch, performance, crash-recovery, or pane-split gate. | Confirmed workflow inspection | `.github/workflows/e2e-matrix.yml:83-103`; `.github/workflows/release-macos.yml:113-139`; `.github/workflows/release-windows.yml:94-118`; `.github/workflows/release-linux.yml:71-95` | Verified validation gap |
| C-047 | Windows test scripts | Inline POSIX environment assignments make opt-in perf/crash scripts fail under normal Windows npm-script execution. | Confirmed | `app/package.json:20-21` | Verified medium platform issue |
| C-048 | provider archaeology | No current registry row is legacy/coming-soon/fallback, yet per-launch KV reads and compatibility branches remain live. | Strong static evidence | `app/src/shared/providers.ts:65-68,287-293`; `app/src/main/core/workspaces/launcher.ts:53-61,488`; `app/src/main/core/swarms/factory-spawn.ts:371-411`; `app/src/renderer/features/settings/ProvidersTab.tsx:19,123-178` | Verified cleanup candidate; external compatibility decision required |
| C-049 | navigation consistency | The duplicated room registries have drifted: Rooms omits Git and the command palette omits Missions while both remain reachable elsewhere. | Confirmed registry comparison | `app/src/renderer/app/state.types.ts:45-55`; `app/src/renderer/features/top-bar/rooms-menu-items.ts:30-47`; `app/src/renderer/features/command-palette/CommandPalette.tsx:105-126` | Verified product-surface defect; canonical registry recommended |
| C-050 | voice bundle duplication | Two independently maintained Whisper model registries are both included in the Electron main bundle. | Confirmed source-map/artifact inspection | `app/src/main/core/voice/model-registry.ts:65-138`; `app/packages/voice-core/src/model-registry.ts:56-127`; baseline Electron source-map receipt | Verified consolidation candidate |
| C-051 | voice maintenance | Voice dictionary normalization is duplicated between app shared code and voice-core global capture. | Confirmed source comparison | `app/src/shared/voice-dictionary.ts:45-70`; `app/packages/voice-core/src/global-capture.ts:41-88,609-610` | Verified drift risk; low runtime impact |
| C-052 | rail archaeology | `rightRail.enabled` is read on boot but has no production setter/UI, while `normalizeTabId` is an identity compatibility shim. | Confirmed reachability search | `app/src/renderer/features/right-rail/use-right-rail-enabled.ts:9-37`; `app/src/renderer/features/right-rail/RightRailContext.data.ts:23-31`; `app/src/renderer/app/App.tsx:188-205` | Verified cleanup candidate; migration/product decision required |
| C-053 | product-surface duplication | Browser, Jorvis, Skills, and Swarm exist as both rooms and rail tabs; Skills/Swarm equivalents can render simultaneously and activated tabs stay mounted. | Strong static evidence | `app/src/renderer/app/room-loaders.ts:25-60`; `app/src/renderer/features/right-rail/RightRailContext.data.ts:8-21`; `app/src/renderer/features/right-rail/RightRailTabs.tsx:83-102` | Verified noise/overhead; product decision required |
| C-054 | dormant migration | Migration 0026 is deliberately unregistered and test-maintained pending operator sign-off; migration 0032 does not repair its historical rows. | Confirmed | `app/src/main/core/db/migrate.ts:91-98`; `app/src/main/core/db/__tests__/migrate.spec.ts:203-221`; `app/src/main/core/db/migrations/0026_sf12_pane_slot_repair.pending.ts:20` | Not dead code; resolve or archive after data decision |
| C-055 | repository archaeology | A stale docs marketplace manifest and obsolete SigmaVoice build instructions conflict with active canonical sources. | Confirmed reachability/content comparison | `docs/marketplace/skills.json:1-4`; `app/public/marketplace/skills.json:1-5`; `sigma-voice/README.md:9-30`; `sigma-voice/package.json:1-18` | Verified documentation cleanup |
| C-056 | repository weight | Historical research frames account for about 54 MB and 1,107 tracked images; unreferenced root backgrounds add about 896 KiB, but neither is packaged. | Confirmed filesystem/reachability measurement | literal `find`/`du`/`git ls-files` receipt below; `app/electron-builder.yml:7-10` | Repository-only archival decision; no runtime claim |
| C-057 | assistant dead code | Both production `runStubTurn` calls provide `forcedReply`, making the generic stale reply composer unreachable. | Strong static evidence | `app/src/main/core/assistant/controller.ts:632-643,1011-1020` | Verified small cleanup candidate |

### Retained-decision metadata

The ledger records evidence confidence and source ranges. This table records the
remaining prioritization and disposition decisions; the active `WISHLIST.md`
contains one concrete action and regression/build trigger for every ID below.
`deprecate-proposal` and `archive-proposal` require product/data sign-off and do
not authorize deletion.

| IDs | Severity | Effort | Disposition |
|---|---|---|---|
| C-001 | critical | M | wishlist |
| C-022 | critical | XL | wishlist |
| C-007, C-029, C-036, C-038, C-042 | high | L | wishlist |
| C-024, C-041, C-043 | high | M | wishlist |
| C-025, C-046 | high | XL | wishlist |
| C-008, C-011, C-012, C-047 | medium | S | wishlist |
| C-010, C-015, C-020, C-028, C-035, C-044, C-049 | medium | M | wishlist |
| C-014 | medium | L | wishlist |
| C-054 | medium | M | archive-proposal |
| C-053 | medium | L | deprecate-proposal |
| C-016, C-026, C-027, C-031 | low | S | wishlist |
| C-009, C-013, C-030, C-032 | low | M | wishlist |
| C-048, C-052 | low | M | deprecate-proposal |
| C-050 | low | L | deprecate-proposal |
| C-051, C-057 | low | S | deprecate-proposal |
| C-055 | low | S | archive-proposal |
| C-056 | low | L | archive-proposal |
| C-019 | low | M | wishlist verification candidate (hypothesis) |
| C-039 | low | S | wishlist verification candidate (hypothesis) |

## Verified findings

### Wave 1 independent receipts

- **C-003:** A primary-agent `tsx` diagnostic pushed eight 1 MiB chunks without a newline into the production `ProtocolLineBuffer` and directly observed `8,388,608` retained characters. Supplying one newline then emitted exactly one line. Existing protocol tests passed but contain no partial-line bound case.
- **C-004:** A real Node child trapped SIGTERM and remained alive. After `child.kill('SIGTERM')`, the parent observed `{ killed: true, exitCode: null, signalCode: null }`, proving both supervisor predicates suppress their own escalation while the process is still running. Existing supervisor fakes do not model Node's `killed` mutation.
- **C-005:** The production trace is complete: `start()` stores one child per workspace; `stopAll()` calls synchronous `stop()`; `stop()` sends SIGTERM and deletes the record; router shutdown immediately proceeds to database close. No exit/close promise or SIGKILL path exists.
- **C-006:** An injected Windows diagnostic called `stopProcessTrees([100, 200])` with a fake executor and observed `powershell.exe, powershell.exe, taskkill, taskkill`: two full process-list calls for two roots. The subtree builder already accepts a shared row set, so this is avoidable repeated work rather than a platform requirement.
- **C-007:** The primary trace confirmed that `stopProcessTrees` schedules its POSIX fallback timer with `unref()` and returns; `PtyRegistry.killAll()` discards `stoppedPids`; shutdown's shorter wait tracks only roots captured before the stop. This is static evidence, not a claim that a descendant was observed surviving on this host.
- **C-008:** Every timeout/continue branch was inspected through the late-exit consumers. No failure-path reset of `expectedExit` was found, and the later persistence listener explicitly returns when that flag is set.
- **C-009 through C-016:** Primary source tracing confirmed reachable mounts and update paths. The rail defaults enabled, the active tab defaults Browser, `RightRailTabs` renders every supplied body, and only Browser/Skills/Swarm/Sigma have activation latches. Focused renderer tests passed, but they do not assert inactive Editor/Jorvis resource behavior or long-history bounds.
- **C-017:** The permanent-session GC and scratch close paths import and call only xterm-cache destruction. Production calls to `destroyEngine` were found only in engine self-eviction and renderer-mode switching; there is no DOM-engine counterpart in the state GC. Existing tests mock only the xterm cache, which explains why the omission remains green.
- **C-018:** A primary-agent headless-engine diagnostic wrote 9,000 lines into the production `TerminalEngine`, yielding an 8,032-row buffer. Seven full `logicalLines()` scans had a 6.190 ms median on this host (2.606–8.751 ms); FlowView then retains only the tail 1,500 rows. This is a diagnostic, not a cross-machine benchmark.
- **C-020:** React render/effect ordering plus the cited code demonstrates the interval: the replacement child calls `getOrCreate*` during render, while the parent destroys the other cache in a passive effect. Existing tests explicitly wait for exclusion rather than proving atomicity.
- **C-021:** A primary-agent byte diagnostic applied the production truncation expression to `"界".repeat(262144)` and observed `262,144` UTF-16 code units but `786,432` UTF-8 bytes. The focused scrollback tests pass because they cover ASCII data.

Focused regression receipt after Wave 1: 10 selected test files / 90 tests passed across protocol, process-tree, scrollback, RightRail, Editor, terminal cache/engine, Jorvis conversation/events, and FlowView coverage. No production files were changed during discovery.

### Wave 2 independent receipts

- **C-022:** Two production-ABI Electron-as-Node diagnostics exercised the real SQLite restore path. With a second connection holding `BEGIN IMMEDIATE`, restore failed with `database is locked` and the global DB accessor then threw `Database not initialized`. A separate successful restore showed a process-lifetime consumer's captured old handle throwing `The database connection is not open` while the replacement global handle worked. Temporary profiles were moved to Trash.
- **C-023:** A production-ABI diagnostic started the real Memory MCP bundle with no stdin requests and observed it alive after 700 ms at 64.7 MiB RSS. Source tracing confirmed the configured clients launch the returned command independently, so the Electron-owned child is not serving their requests.
- **C-024:** Two real memory managers shared one production SQLite database. After manager B changed a note from `alphaunique` to `betaunique`, manager A's direct read returned the new body while its fallback index still returned an `alphaunique` search hit. This demonstrates cross-process staleness rather than merely theoretical cache growth.
- **C-025:** Primary tracing independently confirmed the specialist's controlled interleaving: each writer commits its database value before an unrelated atomic file rename, with no cross-process transaction or lock spanning both stores. The candidate is not labeled a runtime frequency estimate.
- **C-026:** A production-ABI in-memory diagnostic inserted 50,000 mission events. The current load/map/sort/slice path took 34 ms versus 0.07 ms for indexed `ORDER BY ... LIMIT`, with the same newest result on this host. This is a diagnostic, not a cross-machine benchmark.
- **C-028:** Primary source tracing confirmed that `registerRouter()` awaits janitor, all-repository worktree cleanup, and staged-image cleanup before `createWindow()`. Individual Git operations can consume their full timeout because the janitor budget is checked only between repositories.
- **C-029/C-035:** Builder's installed type definitions state `buildResources` are not packed unless explicitly included. The runtime loaders/icons address paths not present in the declared application files. These remain packaged-artifact findings until an installer is safely produced and inspected.
- **C-030:** Five fresh-process imports gave `isomorphic-git` a 36.211 ms median and `libsodium` a 12.542 ms median on this host, with directional RSS medians of about 21.77 MiB and 11.23 MiB. These isolated import costs support lazy composition but are not claimed as end-to-end Electron startup savings.
- **C-031/C-032:** Installed electron-builder code proceeds with dependency rebuild unless `npmRebuild` is false. Current local artifacts contain about 9.3 MiB of Electron source maps versus 4.6 MiB runtime JavaScript; renderer `dist` totals about 2.0 MiB. `asar: false` is an acknowledged product choice, not automatically a defect.
- **C-033:** The workflow's default working directory is already `app`; its existence check prepends another `app/`, while the native dependency is a tracked gitlink at `native/voice-mac`.
- **C-034:** An injected `win32` load of the production wrapper returned `{wrapperAvailable:true, rawIsAvailable:false, hasStart:true}`. The existing unit test forces only the Darwin path.
- **C-036:** A controlled POSIX parent/descendant process showed the descendant still alive after ReviewRunner's root-only SIGTERM behavior; the descendant was then explicitly cleaned up.
- **C-037:** Injecting `Welcome from zshrc\n/opt/homebrew/bin:/usr/bin` through the production merge path produced a PATH containing the banner.
- **C-038:** Injected process rows from two distinct profile paths both matched the boot sweep; only the supplied current PID was excluded. Windows force-kill execution remains device-deferred.

Focused Wave 2 receipts: the database/memory specialist ran 9 files / 88 tests; the primary ran the current platform suites for native Windows voice, shell PATH, and orphan sweep (3 files / 35 tests). No ReviewRunner unit test exists in the current tree, so the specialist's broader 4-file count is not substituted for primary evidence.

### Wave 3 independent receipts

- **C-002/C-040:** Primary `rg` enumeration reproduced 12 Electron launch expressions: only dogfood's shared launcher, crash recovery, and Ruflo autowrite set `--user-data-dir`; nine do not. Production router boot still opens and migrates `app.getPath('userData')` under `NODE_ENV=test`. The workspace factory defaults autowrite on and targets both workspace files and the real home directory, proving `userData` alone is insufficient isolation. A later primary source-write audit also found the smoke launch-failure handler appending directly to tracked `docs/08-bugs/OPEN.md`; `git show 03c910e:app/tests/e2e/smoke.spec.ts` lines 171-174 preserves that pre-fix evidence.
- **C-041:** The router's IPC contract always returns `{ok,data}` or `{ok,error}`, while raw preload `invoke` returns that envelope unchanged. Smoke casts several raw results to arrays, catches many failures, logs duplicate frames, and finally asserts only `stepLog.length > 5`.
- **C-042/C-043/C-046:** `rg -n "RUN_PERF|RUN_CRASH_E2E|RUN_PANE_SPLIT|jank-review|crash-recovery|pane-split" .github/workflows` returned no matches. The perf spec explicitly states that its job is artifact production and asserts no metric budget. CI does retain a useful unpackaged Electron matrix on macOS, Windows, and Linux.
- **C-044:** C-004's real-child diagnostic demonstrated the behavior the synthetic EventEmitter children cannot prove. The corrected fakes now mutate `killed=true` when a signal is sent, but still cannot exercise real exit events or descendants; the router shutdown test still compares source-string positions rather than runtime ordering.
- **C-045:** The cited launch specs assigned Electron applications and closed them only at the end of their success paths, without fixture/finally teardown. Independent review then found a narrower failed-launch edge: `min-window` created its disposable profile and awaited `electron.launch()` before entering `try`, so launch rejection bypassed `profile.cleanup()`.
- **C-047:** The two package scripts use POSIX `NAME=value command` syntax; this is incompatible with default Windows `cmd.exe` npm scripts.
- **C-048:** Primary registry and call-site search confirmed the registry comment says no current legacy/coming-soon/fallback provider, while live launchers still read `providers.showLegacy`. This is not removal approval: persisted/external definitions must be ruled out first.
- **C-049:** A direct comparison of the `RoomId` union and the two UI registries confirmed the omissions; both rooms have other live navigation paths, so neither room is called dead.
- **C-050/C-051:** Production imports and the existing main source map contain both model registries; both dictionary algorithms are separately reachable. Consolidation must precede deletion.
- **C-052/C-053:** Production search found the enable flag's reader and gate but no setter. Full-room and rail registrations are both reachable; therefore this is a product-surface decision, not an unused-feature claim.
- **C-054:** Migration tests intentionally enforce non-registration. It is classified as unresolved dormant work, not abandoned code.
- **C-055/C-056:** Reachability and builder checks confirm these affect contributor/repository weight, not runtime bundle size. Literal receipts were `find docs/02-research/frames/v3 -type f | wc -l` → 1,107, `du -sk docs/02-research/frames/v3` → 54,936 KiB, `find bg -type f | wc -l` → 4, and `du -sk bg` → 896 KiB; `git ls-files` returned the same 1,107 and 4 tracked-file counts. SigmaVoice itself remains active and is explicitly rejected as an archival target.
- **C-057:** Both production calls to `runStubTurn` pass `forcedReply`; removal still requires a focused controller test.

Specialist count: eight read-only specialists across three waves, followed by a ninth distinct adversarial code-review agent. Every promoted claim above has a separate primary receipt or complete source/data-flow trace; unsupported impact estimates were downgraded or deferred.

## Rejected or downgraded hypotheses

- **Per-pane PTY event-listener fan-out leak:** rejected. `pty-data-bus.ts` uses one process-wide listener, deletes empty per-session listener sets, and tests cover unsubscribe behavior.
- **Terminal engine/add-on disposer leak:** rejected for normal destroy paths. `TerminalEngine.dispose()` clears subscribers, disposes parser/data handlers, and disposes the headless terminal; the reachable omission is C-017, not broken disposal itself.
- **Swarm-message unbounded global state:** rejected. Mailbox tails and renderer message state have explicit bounds; C-016 is limited to avoidable hidden derived work over those bounded arrays.
- **Jorvis pane-event cross-conversation retention:** rejected. The store clears on conversation change and unmount; C-015 is specifically unbounded growth within one active conversation.
- **Hidden-pane GPU leak as an established defect:** downgraded to C-019. Keep-alive is intentional and no GPU/process-memory profile has yet demonstrated excessive hidden cost.

## Implemented low-risk fixes

### Process, protocol, and persistence — `289136e`

- **C-003:** `ProtocolLineBuffer` bounds an unterminated logical line at 65,536 UTF-16 code units and, once exceeded, discards that entire line through its newline. It never emits a retained suffix as a new protocol boundary, and later lines recover normally. Initial TDD receipt: 1 failing / 10 passing before the bound; adversarial follow-up: 12/12 protocol tests passed.
- **C-004:** both Ruflo supervisors now use exit state/events for TERM→KILL escalation, not Node's signal-sent `child.killed` flag. One existing fake was corrected to Node semantics and a missing stdio-supervisor suite was added.
- **C-006:** `stopProcessTrees` takes one point-in-time process-table snapshot per batch. TDD receipt observed two Windows enumeration calls before and one after.
- **C-021:** scrollback persistence takes a valid UTF-8 tail at or below 256 KiB without splitting a code point.

Primary re-verification after the specialist commit: 5 focused files / 68 tests passed. The primary read each changed production path; the buffer bound, shared snapshot, exit-state predicate, and UTF-8 boundary directly address the reproduced mechanisms. The remaining asynchronous PTY descendant ordering is still C-007 and is not claimed fixed.

### Platform compatibility — `74def30`

- **C-033:** the macOS release workflow now probes `native/voice-whisper` relative to its existing `app` working directory.
- **C-034:** Windows native availability now returns and caches a real Promise. First-launch persistence and `auto` engine selection await it; rejection/unavailability falls back to renderer speech, a pending start reserves the single-session slot, and an explicit mode change cannot be overwritten by a late probe. Live Windows device validation remains required.
- **C-037:** shell PATH discovery prints and parses a UUID-delimited payload, ignoring startup/logout banners.

Primary re-verification: the focused native-Windows and shell-PATH suites passed 2 files / 24 tests, including the real bundled stub under an injected `win32` platform and an executable noisy-shell fixture. The workflow cwd/path pair was independently inspected. No live Windows claim is made.

### Terminal lifecycle and render work — `6f89727`

- **C-017:** permanent-pane and scratch cleanup now destroy both xterm cache entries and DOM/headless engines, including their subscriptions and parsed scrollback.
- **C-018:** `TerminalEngine.tailLogicalLines(1500)` walks backward from the buffer tail; FlowView no longer materializes all scrollback before slicing.

Primary re-verification: 6 focused files / 66 tests passed. The real-engine regression proves removed sessions/scratch tabs leave no cached engine; the tail regression proves equality with the full-scan tail and records no reads older than the requested logical window. The specialist's microbenchmark is directional evidence, not used as a primary cross-machine performance claim.

### Enforced Electron test isolation — `3d316ab`, `d841682`

- **C-002/C-040:** one helper now owns disposable Electron user data, home, Windows app-data roots, XDG roots, and a workspace. All 12 launch expressions use it. Main boot under `NODE_ENV=test` refuses to register production services without both the explicit isolation marker and `--user-data-dir`. Commit `be185c8` also removes the smoke harness's launch-failure append to tracked `docs/08-bugs/OPEN.md`; remaining E2E/perf writes target disposable repositories or ignored artifact roots.
- **C-045:** every launch is closed by `finally`, helper teardown, or the dogfood `afterEach`; roots are deleted only after the application close attempt. In `min-window`, launch itself is now inside `try`, closing the failed-launch cleanup edge.
- Tests that formerly opened this checkout now open the helper-owned `SigmaLink` directory, so workspace autowrite cannot mutate tracked files even if an RPC assertion fails.

TDD receipts: the helper/guard began at 4 failures / 1 pass, the main wiring test failed on a missing guard call, and the disposable-workspace test failed on a missing root. Final focused result was 3 files / 6 tests plus the workspace helper's 2 tests; TypeScript and Playwright discovery passed for 14 E2E tests and the opt-in perf test. C-041/C-042 remain open: isolation makes the harness safe, not truthful or budget-enforcing.

### Removed idle Memory MCP process — `9e3b416`

- **C-005/C-023:** `MemoryMcpSupervisor` is now a workspace command registry. It no longer spawns, drains, restarts, or stops a private stdio child that no configured client could use; clients still receive the same executable/args/environment and own their point-to-point server.

TDD receipt: the new real supervisor test first failed because `spawn` was called once, then passed with no spawn and an unchanged command envelope. Primary related-path verification passed 3 files / 77 tests across the supervisor, workspace launcher, and swarm factory; TypeScript passed. The earlier idle diagnostic measured 64.7 MiB RSS for one such child on this host, so this removes a demonstrated resident process rather than a hypothetical optimization.

### Adversarial review corrections — `a45ed13`, `be185c8`

The ninth agent reported no critical finding and four important correctness or
evidence gaps. The primary agent independently reproduced each mechanism before
accepting it:

- An overlong-line suffix could have become a forged `SIGMA::` command boundary. A red adversarial regression now proves the whole line is dropped and the next real line still parses.
- The Windows SAPI availability Promise was treated optimistically while pending. Five deferred-Promise tests were red before the correction and now cover unavailable fallback, delayed auto-enable, native start, explicit-mode cancellation, and concurrent starts.
- `min-window` could leak its disposable profile when Electron launch itself rejected. The launch now occurs within the cleanup `try`.
- Audit prioritization and source citations were incomplete. The retained-decision table and rebuilt wishlist now record evidence class, severity, effort, disposition, exact source ranges, concrete action, and a verification/build trigger.

Focused post-correction receipt: 3 test files / 31 tests passed, followed by a
clean TypeScript build and scoped ESLint. The real Electron and repository-wide
gates are recorded below after a fresh rerun.

## Deferred platform verification

- Windows live runtime and installer behavior cannot be exercised on this macOS host. Windows claims will be labeled as unit-tested branch, CI-covered, or static-only.
- The Electron performance harness now launches through a disposable user-data/home/workspace profile, but C-041/C-042 remain: it does not enforce metric budgets and parts of the smoke contract can still false-green. It is safe to run, but is not used as performance proof in this audit.
- Packaged installer inspection remains deferred because the checkout has no reproducible tracked lockfile and the fresh-install attempt exhausted the host's available disk before native-dependency reconstruction completed. C-001/C-029/C-035/C-046 therefore remain explicit release-gate work rather than inferred packaged-runtime claims.

## Final verification

- Shipping-candidate verification after synchronization with `origin/main` and the sigma-check test-harness repairs: `pnpm test` passed 484 files with 5,001 tests passed and 3 skipped out of 5,004. The suite emitted its pre-existing jsdom canvas and `NO_COLOR`/`FORCE_COLOR` warnings but no test failure.
- `pnpm lint`: passed with no ESLint findings.
- `pnpm build`: TypeScript and Vite passed; 2,131 modules transformed in 5.58 s. The emitted renderer includes a 349.48 kB entry chunk, 607.27 kB xterm chunk, and route/feature chunks. These are artifact sizes, not a measured runtime-memory improvement.
- `pnpm electron:compile`: passed; emitted the 4.1 MB main bundle plus preload and three MCP server bundles.
- `pnpm exec playwright test tests/e2e/min-window.spec.ts --project=e2e`: 1/1 passed in 5.7 s through the disposable Electron profile, directly exercising the launch guard and normal cleanup path. The sigma-check reproducer for the newly isolated Sync and Voice settings specs failed 2/2 before deterministic onboarding dismissal and passed 2/2 afterward in 10.4 s.
- Playwright discovery found 14 E2E tests in 11 files. `PERF=1 pnpm exec playwright test --list --project=perf` found the one opt-in performance spec; omitting `PERF=1` correctly rejects the absent project by design.
- Wishlist metadata validation found 41/41 action items with evidence/severity/effort, concrete action, and verification/build trigger. Every cited current-worktree file and numeric line range exists, and every unresolved accepted/hypothesis ID is present.
- The archive body from line 9 has SHA-256 `50de5462ac1f5a3b39334d79fafd439a8739a1a1f6a6d8194b5f62a3027418c0`, exactly matching `origin/main`'s pre-audit `WISHLIST.md`; unrelated wishlist content from the original checkout's unmerged pane branch is excluded.
- `rg` found no remaining E2E/perf write to `docs/08-bugs/OPEN.md`; remaining result roots are disposable or ignored. `git diff --check 80065c3` passed after documentation reconciliation.

The full gate supports the implemented remediations on this macOS host. It does not close the explicitly device-, package-, or budget-gated candidates in the rebuilt wishlist.
