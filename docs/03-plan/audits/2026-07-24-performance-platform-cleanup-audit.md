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
| C-002 | perf/test safety | Nine of twelve Electron launch expressions use the operator's real profile and can migrate the live database, run janitors, restore workspaces, and respawn panes. | Confirmed source/data-flow trace | Electron test launch enumeration → `rpc-router.ts:444-509` → database/session restore | Verified critical safety defect; remediation pending |
| C-003 | PTY/protocol memory | An unterminated PTY line can grow `ProtocolLineBuffer.acc` without a bound; every normal pane feeds one prompt-sink buffer and swarm panes feed a second protocol buffer. | Confirmed | `app/src/main/core/swarms/protocol.ts:112-130`; `app/src/main/core/pty/registry.ts:352-354`; `app/src/main/core/swarms/factory-spawn.ts:541-554` | Verified; remediation pending |
| C-004 | process lifecycle | Both Ruflo daemon supervisors test `child.killed` before SIGKILL escalation, but Node sets it when a signal is sent rather than when the child exits. | Confirmed | `app/src/main/core/ruflo/http-daemon-supervisor.ts:841-864`; `app/src/main/core/ruflo/supervisor.ts:150-173` | Verified; remediation pending |
| C-005 | Memory MCP lifecycle | Electron-owned Memory MCP children receive only synchronous SIGTERM and are forgotten immediately; app shutdown does not await their exit before closing the database. | Strong static evidence | `app/src/main/core/memory/mcp-supervisor.ts:79-95`; `app/src/main/rpc-router.ts:3747-3750,3841-3844` | Verified; remediation pending |
| C-006 | process performance | Batch process-tree stop enumerates the entire process table once per root instead of once per batch. | Confirmed | `app/src/main/core/process/process-tree.ts:169-177` | Verified; remediation pending |
| C-007 | shutdown lifecycle | POSIX descendant escalation can run after the shutdown wait and database close because tree-stop returns immediately, schedules SIGKILL at 5 s, and shutdown waits only captured root PIDs for 2.5 s. | Strong static evidence | `app/src/main/core/process/process-tree.ts:205-236`; `app/src/main/core/pty/registry.ts:642-663`; `app/src/main/rpc-router.ts:3728-3739,3826-3844` | Verified; remediation pending |
| C-008 | account-switch lifecycle | A timed-out Claude account switch leaves `expectedExit` set; a later real exit then bypasses normal persistence/cleanup. | Strong static evidence | `app/src/main/core/pty/claude-account-watch.ts:288-293`; `app/src/main/core/pty/registry.ts:528-531`; `app/src/main/core/pty/resume-launcher.ts:303-308` | Verified; remediation pending |
| C-009 | startup/network | Idle prefetch invokes every lazy room loader after first paint, converting code-splitting into deferred full-app loading. | Strong static evidence | `app/src/renderer/app/room-loaders.ts:25-86,99-125`; `app/src/renderer/app/App.tsx:290-293` | Verified optimization candidate |
| C-010 | renderer lifecycle | With the default-enabled rail and default Browser tab, Editor and Jorvis bodies still mount inside CSS-hidden panels and start KV, filesystem, conversation, health, and event work. | Strong static evidence | `app/src/renderer/features/right-rail/use-right-rail-enabled.ts:9-18`; `RightRailContext.data.ts:10-15`; `RightRail.tsx:188-242`; `RightRailTabs.tsx:83-103` | Verified; remediation pending |
| C-011 | editor correctness | A dirty Editor mounted in a hidden rail panel intercepts the global Cmd/Ctrl+S shortcut and saves/prevents the event. | Strong static evidence | `app/src/renderer/features/editor/EditorTab.tsx:247-265`; C-010 mount trace | Verified; remediation pending |
| C-012 | renderer leak | Editor sidebar drag installs window pointer listeners, an animation-frame callback, and a body flag with cleanup only on pointer-up, not component unmount. | Strong static evidence | `app/src/renderer/features/editor/EditorTab.tsx:171-225` | Verified; remediation pending |
| C-013 | renderer memory | Renderer-mode resolutions and the set of sessions that ever produced PTY data retain closed session IDs for the renderer lifetime; production teardown has no delete path. | Strong static evidence | `app/src/renderer/lib/renderer-flag.ts:30-71`; `app/src/renderer/lib/pty-data-bus.ts:25-33,53-65,92-113` | Verified low-severity accumulation |
| C-014 | assistant scalability | Conversation hydration loads every message and the transcript mounts every row; there is no page/window boundary. | Strong static evidence | `app/src/main/core/assistant/conversations.ts:162-177`; `app/src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts:103-134`; `ChatTranscript.tsx:118-181` | Verified; remediation pending |
| C-015 | assistant scalability | Active-conversation pane events are unbounded; every append clones the full array and the room renders every event card. | Strong static evidence | `app/src/renderer/features/jorvis-assistant/use-jorvis-pane-events.ts:14-69`; `JorvisRoom.tsx:427-435` | Verified; remediation pending |
| C-016 | hidden work | Once activated, the hidden Swarm rail remains subscribed and repeats full-message derived scans on updates. | Strong static evidence | `app/src/renderer/features/right-rail/RightRail.tsx:119-123,216-227`; `SwarmRailTab.tsx:22-106` | Verified low-severity optimization candidate |
| C-017 | terminal memory | Permanent pane and scratch cleanup disposes only cached xterm terminals, not default DOM engines; those engines retain parsed scrollback and subscriptions until LRU eviction. | Strong static evidence | `app/src/renderer/app/state-hooks/use-terminal-cache-gc.ts:17-73`; `app/src/renderer/lib/scratch-tabs.ts:20-88`; `app/src/renderer/lib/engine-cache.ts:20-53,73-100,131-151` | Verified; remediation pending |
| C-018 | terminal render performance | FlowView materializes the entire headless scrollback on every coalesced output render and only then slices to 1,500 logical lines. | Confirmed | `app/src/renderer/features/command-room/FlowView.tsx:202-235`; `app/src/renderer/lib/terminal-engine.ts:211-240` | Verified; remediation pending |
| C-019 | terminal hidden work | CSS-hidden panes may continue presenter subscriptions and retain xterm WebGL resources while not visible. | Hypothesis | Presenter keep-alive design and hidden pane layout | Requires renderer/GPU profiling; not promoted |
| C-020 | renderer switch | DOM/xterm mutual exclusion is enforced in a parent passive effect after the replacement host creates its cache entry, allowing a brief dual-subscription interval. | Strong static evidence | `app/src/renderer/features/command-room/Terminal.tsx:240-280`; `DomTerminalView.tsx:58-79` | Verified low-frequency correctness risk |
| C-021 | persistence correctness | The 256 KiB persisted scrollback cap compares UTF-8 bytes but truncates UTF-16 code units, so multibyte content can exceed the documented cap. | Confirmed | `app/src/main/core/pty/scrollback-store.ts:16,41-43` | Verified; remediation pending |
| C-022 | database restore | Live database restore can leave the process uninitialized on lock failure and leaves process-lifetime consumers holding the closed pre-restore handle on success. | Confirmed | `StorageTab.tsx:87-101`; `memory/controller.ts:180-198`; `db/client.ts:414-454`; `sync/engine.ts:159-169` | Critical; redesign required before enabling live restore |
| C-023 | Memory MCP overhead | Electron starts an idle Memory MCP child per workspace even though configured clients launch their own stdio server; workspace removal does not stop the resident child. | Confirmed | `memory/mcp-supervisor.ts:97-164`; workspace launcher call sites | Verified high-severity overhead; remediation pending |
| C-024 | memory cache consistency | The legacy in-process `MemoryIndex` retains full note bodies/tokens and becomes stale when another Memory MCP process writes the database. | Confirmed | `memory/manager.ts`; `memory/index.ts`; MCP write paths | Verified high-severity correctness/memory issue; remediation pending |
| C-025 | memory persistence | Concurrent Memory MCP processes can interleave independent database-first and file-second writes, leaving the database and Markdown source divergent. | Strong static evidence plus controlled interleaving | `memory/manager.ts` write/persist ordering; no inter-process mutex | Verified; transactional design required |
| C-026 | query performance | Mission event reads load and sort the complete event history in JavaScript before slicing the requested limit despite a supporting SQL index. | Confirmed | `missions/dao.ts:300-308`; schema index at `schema.ts:626-636` | Verified low-risk optimization candidate |
| C-027 | main-process memory | `conversationWorkspaceCache` is lifetime-unbounded and conversation deletion has no eviction path. | Strong static evidence | `rpc-router.ts:350-359`; `assistant/conversations.ts:259-265` | Verified low-severity accumulation |
| C-028 | startup latency | Router registration blocks first-window creation on serial worktree pruning and recursive janitor/image cleanup whose time budgets do not preempt an in-progress repository operation. | Strong static evidence | `electron/main.ts:1007-1008`; `rpc-router.ts:486-503`; `worktree-cleanup.ts:159-176,235-244`; `janitor.ts:103-115` | Verified; ordering/correctness design required |
| C-029 | packaged voice | Root production dependencies and builder inputs omit the macOS/Windows voice packages that runtime loaders expect. | Strong static packaging evidence | `package.json:50-51`; `packages/voice-core/package.json:21-25`; `electron-builder.yml:7-10` | High; packaged-artifact/device verification required |
| C-030 | startup composition | Optional sync is constructed on every router boot, and static imports pull `isomorphic-git` and `libsodium` into startup. | Confirmed composition; directional import timing only | `rpc-router.ts:3244-3248`; `sync/controller.ts`; `sync/engine.ts` | Verified optimization candidate; Electron boot benchmark required |
| C-031 | release build | Native dependency rebuilds are requested by postinstall, release scripts, and electron-builder's default `npmRebuild: true`. | Confirmed configuration | `package.json`; release workflows; installed electron-builder `packager.js` | Verified build-time duplication |
| C-032 | package size | Linked source maps are included in `electron-dist`, renderer `dist` is copied both as application files and `extraResources`, and `asar` is disabled. | Confirmed configuration/artifact measurement | build scripts; `electron-builder.yml`; local artifact sizes | Verified package-size candidates; packaged diff required |
| C-033 | macOS release | The release workflow checks `app/native/voice-mac/...` while already running with `app` as its working directory. | Confirmed | `.github/workflows/release-macos.yml:33-35,89-94` | Verified low-risk path fix |
| C-034 | Windows voice | The Windows fallback stub reports itself unavailable, but the wrapper treats module presence as availability and selects the unusable native path in auto mode. | Confirmed injected platform branch | `native/voice-win/index.js:18-48`; `voice/native-win.ts:80-130`; `voice/adapter.ts:195-208` | Verified high-severity platform bug |
| C-035 | packaged icons | Tray and notification code reads `build/icon*` at runtime, but builder resources are not automatically application files and `build` is excluded. | Strong static packaging evidence | `electron/main.ts:155-158`; `notifications/os-notify.ts:144-150`; `electron-builder.yml:4-10` | Medium; packaged-artifact verification required |
| C-036 | review process lifecycle | ReviewRunner stops only the spawned root process, allowing descendants to survive Stop and app shutdown. | Confirmed on POSIX | `review/runner.ts:52-85,166-183`; router shutdown call | Verified medium-high; Windows branch verification pending |
| C-037 | macOS environment | Interactive-login shell banner output is accepted as the discovered PATH and cached verbatim. | Confirmed injected parser path | `util/shell-path.ts:58-73,103`; `electron/main.ts:973` | Verified medium; remediation pending |
| C-038 | Windows multi-instance | Boot orphan sweep matches every memory-server command line except the current main PID, so another SigmaLink profile can be force-killed. | Confirmed injected matching; strong kill trace | `process/orphan-sweep.ts:30-49,73-101`; router boot ordering | Verified medium-high; ownership design required |
| C-039 | Windows path handling | `%VAR%` expansion in legal directory names may alter shell-open paths. | Hypothesis | `util/windows-spawn.ts:181` | Deferred for Windows device confirmation |
| C-040 | test isolation | Isolating only Electron `userData` still permits workspace `.mcp.json`/`CLAUDE.md` and operator home configuration writes. | Strong static evidence | `workspaces/factory.ts:324-371`; `workspaces/mcp-autowrite.ts:113-195`; `seed-workspace-memory.ts:115-150` | Critical verification-infrastructure fix |
| C-041 | smoke coverage | The broad smoke test treats raw RPC envelopes as arrays, swallows failures, logs duplicate frames, and gates only on the count of attempted screenshots. | Confirmed source contract mismatch | `rpc-router.ts:3476-3510`; `preload.ts:33-39`; `tests/e2e/smoke.spec.ts` | Verified false-green risk |
| C-042 | performance gate | The perf test starts after boot, ignores navigation failures, records metrics without budgets, has no memory/child-count soak, and is absent from CI. | Confirmed | `tests/perf/jank-review.spec.ts`; workflow search | Verified high-severity blind spot |
| C-043 | lifecycle coverage | Exact pane-preservation regressions are skipped or environment-gated, and pane-split uses a stale RPC shape before reaching pane behavior. | Confirmed | `multi-workspace.spec.ts:175-188`; `pane-split.spec.ts:42-69`; workflow search | Verified high-severity blind spot |
| C-044 | process test fidelity | Supervisor child fakes do not model Node's `child.killed` semantics, shutdown ordering is source-text-only, and Memory MCP has no direct lifecycle suite. | Confirmed | supervisor and router shutdown tests | Verified gap explaining C-004/C-005 |
| C-045 | E2E lifecycle | Several Electron tests close the application only on the success path, so failed assertions can leak processes and locks. | Strong static evidence | perf, smoke, sync, and dogfood specs | Verified medium-severity test leak |
| C-046 | release validation | CI has unpackaged OS breadth but no packaged app launch, performance, crash-recovery, or pane-split gate. | Confirmed workflow inspection | `.github/workflows/e2e-matrix.yml`; release workflows | Verified validation gap |
| C-047 | Windows test scripts | Inline POSIX environment assignments make opt-in perf/crash scripts fail under normal Windows npm-script execution. | Confirmed | `package.json:20-21` | Verified medium platform issue |
| C-048 | provider archaeology | No current registry row is legacy/coming-soon/fallback, yet per-launch KV reads and compatibility branches remain live. | Strong static evidence | `shared/providers.ts`; provider/workspace/swarm launchers; settings tab | Verified cleanup candidate; external compatibility decision required |
| C-049 | navigation consistency | The duplicated room registries have drifted: Rooms omits Git and the command palette omits Missions while both remain reachable elsewhere. | Confirmed registry comparison | `state.types.ts`; `rooms-menu-items.ts`; `CommandPalette.tsx` | Verified product-surface defect; canonical registry recommended |
| C-050 | voice bundle duplication | Two independently maintained Whisper model registries are both included in the Electron main bundle. | Confirmed source-map/artifact inspection | app and `packages/voice-core` model registries; Electron main imports | Verified consolidation candidate |
| C-051 | voice maintenance | Voice dictionary normalization is duplicated between app shared code and voice-core global capture. | Confirmed source comparison | `shared/voice-dictionary.ts`; `voice-core/src/global-capture.ts` | Verified drift risk; low runtime impact |
| C-052 | rail archaeology | `rightRail.enabled` is read on boot but has no production setter/UI, while `normalizeTabId` is an identity compatibility shim. | Confirmed reachability search | `use-right-rail-enabled.ts`; `RightRailContext.data.ts`; `App.tsx` | Verified cleanup candidate; migration/product decision required |
| C-053 | product-surface duplication | Browser, Jorvis, Skills, and Swarm exist as both rooms and rail tabs; Skills/Swarm equivalents can render simultaneously and activated tabs stay mounted. | Strong static evidence | `room-loaders.ts`; `RightRailContext.data.ts`; `RightRailTabs.tsx` | Verified noise/overhead; product decision required |
| C-054 | dormant migration | Migration 0026 is deliberately unregistered and test-maintained pending operator sign-off; migration 0032 does not repair its historical rows. | Confirmed | `db/migrate.ts`; `db/__tests__/migrate.spec.ts`; pending migration | Not dead code; resolve or archive after data decision |
| C-055 | repository archaeology | A stale docs marketplace manifest and obsolete SigmaVoice build instructions conflict with active canonical sources. | Confirmed reachability/content comparison | `docs/marketplace/skills.json`; public manifest; `sigma-voice/README.md`; workspace config | Verified documentation cleanup |
| C-056 | repository weight | Historical research frames account for about 54 MB and 1,107 tracked images; unreferenced root backgrounds add about 892 KB, but neither is packaged. | Confirmed filesystem/reachability measurement | `docs/02-research/frames/v3`; `bg`; builder config | Repository-only archival decision; no runtime claim |
| C-057 | assistant dead code | Both production `runStubTurn` calls provide `forcedReply`, making the generic stale reply composer unreachable. | Strong static evidence | `assistant/controller.ts` call-site search | Verified small cleanup candidate |

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

- **C-002/C-040:** Primary `rg` enumeration reproduced 12 Electron launch expressions: only dogfood's shared launcher, crash recovery, and Ruflo autowrite set `--user-data-dir`; nine do not. Production router boot still opens and migrates `app.getPath('userData')` under `NODE_ENV=test`. The workspace factory defaults autowrite on and targets both workspace files and the real home directory, proving `userData` alone is insufficient isolation.
- **C-041:** The router's IPC contract always returns `{ok,data}` or `{ok,error}`, while raw preload `invoke` returns that envelope unchanged. Smoke casts several raw results to arrays, catches many failures, logs duplicate frames, and finally asserts only `stepLog.length > 5`.
- **C-042/C-043/C-046:** Primary workflow and test searches confirmed no CI variable enables perf, crash recovery, pane split, or assistant CLI; the perf spec explicitly states that its job is artifact production and asserts no metric budget. CI does retain a useful unpackaged Electron matrix on macOS, Windows, and Linux.
- **C-044:** C-004's real-child diagnostic is direct counter-evidence to the supervisor fake, which deliberately leaves `killed=false`. The router shutdown test compares source-string positions and no direct Memory MCP supervisor test was found.
- **C-045:** The cited launch specs assign Electron applications and close them only at the end of their success paths, without fixture/finally teardown.
- **C-047:** The two package scripts use POSIX `NAME=value command` syntax; this is incompatible with default Windows `cmd.exe` npm scripts.
- **C-048:** Primary registry and call-site search confirmed the registry comment says no current legacy/coming-soon/fallback provider, while live launchers still read `providers.showLegacy`. This is not removal approval: persisted/external definitions must be ruled out first.
- **C-049:** A direct comparison of the `RoomId` union and the two UI registries confirmed the omissions; both rooms have other live navigation paths, so neither room is called dead.
- **C-050/C-051:** Production imports and the existing main source map contain both model registries; both dictionary algorithms are separately reachable. Consolidation must precede deletion.
- **C-052/C-053:** Production search found the enable flag's reader and gate but no setter. Full-room and rail registrations are both reachable; therefore this is a product-surface decision, not an unused-feature claim.
- **C-054:** Migration tests intentionally enforce non-registration. It is classified as unresolved dormant work, not abandoned code.
- **C-055/C-056:** Reachability and builder checks confirm these affect contributor/repository weight, not runtime bundle size. SigmaVoice itself remains active and is explicitly rejected as an archival target.
- **C-057:** Both production calls to `runStubTurn` pass `forcedReply`; removal still requires a focused controller test.

Specialist count: eight read-only specialists across three waves. Every promoted claim above has a separate primary receipt or complete source/data-flow trace; unsupported impact estimates were downgraded or deferred.

## Rejected or downgraded hypotheses

- **Per-pane PTY event-listener fan-out leak:** rejected. `pty-data-bus.ts` uses one process-wide listener, deletes empty per-session listener sets, and tests cover unsubscribe behavior.
- **Terminal engine/add-on disposer leak:** rejected for normal destroy paths. `TerminalEngine.dispose()` clears subscribers, disposes parser/data handlers, and disposes the headless terminal; the reachable omission is C-017, not broken disposal itself.
- **Swarm-message unbounded global state:** rejected. Mailbox tails and renderer message state have explicit bounds; C-016 is limited to avoidable hidden derived work over those bounded arrays.
- **Jorvis pane-event cross-conversation retention:** rejected. The store clears on conversation change and unmount; C-015 is specifically unbounded growth within one active conversation.
- **Hidden-pane GPU leak as an established defect:** downgraded to C-019. Keep-alive is intentional and no GPU/process-memory profile has yet demonstrated excessive hidden cost.

## Implemented low-risk fixes

None yet.

## Deferred platform verification

- Windows live runtime and installer behavior cannot be exercised on this macOS host. Windows claims will be labeled as unit-tested branch, CI-covered, or static-only.
- The perf harness is deferred until its user-data isolation is proven or fixed; protecting operator data takes precedence over producing a baseline video.

## Final verification

Pending completion of specialist discovery, independent validation, any accepted TDD fixes, and the rebuilt wishlist.
