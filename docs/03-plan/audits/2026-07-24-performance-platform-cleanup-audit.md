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
| C-001 | dependency/build | A fresh clone cannot perform a deterministic locked install; the ignored local lock is stale and pnpm 11 build approvals are not encoded. | Confirmed setup reproduction | `.gitignore:123`; `app/package.json:35-109`; three literal install failures in the baseline receipt | Awaiting startup/build specialist and primary remediation decision |
| C-002 | perf/test safety | The opt-in perf harness appears to use the operator's real Electron user data and may mutate the live database, logs, caches, or worktrees. | Strong static evidence | `app/tests/perf/jank-review.spec.ts:70-81` → `app/src/main/rpc-router.ts:444-455`; no `app.setPath('userData', ...)` found | Awaiting verification specialist and independent full boot trace |
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
