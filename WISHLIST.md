# SigmaLink — Active Wishlist

> Rebuilt from verified evidence on 2026-07-24. This is an active queue, not a history log.
> The complete evidence ledger is [the performance/platform audit](docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md).
> The prior wishlist is preserved verbatim in [the pre-audit archive](docs/03-plan/archive/WISHLIST-pre-performance-audit-2026-07-24.md).
>
> Promote an item to `ROADMAP.md` only after assigning an owner and acceptance gate. Remove it from this file when shipped or rejected; completed work belongs in the audit/change history.

## P0 — Safety and release integrity

- **Rebuild deterministic dependency installation (C-001).** Track a current lockfile, align the pnpm version/build approvals across local and CI, then prove `pnpm install --frozen-lockfile` plus native rebuilds from a clean clone. Acceptance: clean macOS and Windows jobs install the identical graph and launch the built app.
- **Redesign live database restore (C-022).** A failed restore must retain a usable original connection; a successful restore must reconstruct every DB-owning service instead of leaving captured closed handles. Acceptance: lock-failure rollback and successful service rebind integration tests using the production SQLite ABI.
- **Make Memory Markdown/SQLite persistence process-safe (C-024/C-025).** Remove or coherently invalidate the duplicate full-body index and serialize cross-process DB/file commits with recovery. Acceptance: two-process write/search/interleaving tests cannot return stale search results or divergent file/DB bodies.
- **Prove packaged native voice and runtime icons (C-029/C-035).** Include the intended macOS/Windows modules and icon resources at the paths production resolves. Acceptance: unpacked-artifact smoke-load on both target OSes, including native availability and tray/notification icon checks.
- **Replace false-green smoke/performance coverage (C-041/C-042).** Smoke must unwrap/assert RPC results; perf must enforce repeated per-platform budgets and a pane create/close memory/child-count soak. Acceptance: CI fails on a failed RPC/navigation, exceeded budget, or retained pane resources. Test profile/home/workspace isolation is now enforced by the main-process boot guard.

## P1 — Lifecycle and startup

- **Unify awaited child-tree shutdown (C-007/C-036).** PTY descendants, ReviewRunner, and router shutdown need one TERM→bounded wait→tree KILL contract that finishes before database close. Acceptance: real trapped-child and descendant tests on POSIX plus Windows CI coverage leave zero owned descendants. Electron no longer owns the previously idle Memory MCP child.
- **Move non-critical cleanup off the first-window critical path (C-028).** Preserve recovery invariants while scheduling bounded worktree/image cleanup after the UI is usable. Acceptance: measured cold-start trace shows first window is not blocked by repository count or one slow Git prune.
- **Lazily compose optional sync (C-030).** Construct/import Git and crypto services only when sync is enabled or invoked. Acceptance: production Electron startup benchmark across repeated runs shows the change and sync behavior remains covered.
- **Fix account-switch late-exit state (C-008).** Clear or token-scope `expectedExit` after timeout/continue so later genuine exits persist normally. Acceptance: deterministic delayed-exit test.
- **Give cross-instance process cleanup explicit ownership (C-038).** Replace command-substring orphan matching with a userData/profile PID registry or equivalent identity. Acceptance: two concurrent Windows profiles cannot terminate each other's servers.

## P1 — Renderer, panes, and long sessions

- **Bound Jorvis history and pane-event rendering (C-014/C-015).** Add database pagination/transcript virtualization and a bounded or persisted event window. Acceptance: long-history tests and heap/interaction measurements at an agreed message/event scale.
- **Stop hidden rail work (C-010/C-011/C-012/C-016).** Inactive Editor/Jorvis/Swarm panels must not register global shortcuts, filesystem/health/event subscriptions, pointer listeners, or derived scans. Acceptance: inactive-tab lifecycle tests show zero relevant listeners/RPC calls and unmount during drag restores global state.
- **Make renderer-mode switching atomic and profile hidden GPU cost (C-019/C-020).** Eliminate the dual-subscription interval; only change hidden-pane retention after renderer/GPU memory traces establish a useful bound. Acceptance: switch test proves one live presenter and repeated hide/show profiling shows stable resources.
- **Bound renderer lifetime metadata and route caches (C-013/C-027).** Evict closed sessions/conversations or use lifecycle-scoped storage. Acceptance: repeated create/close/delete soak returns maps to their baseline size.
- **Revisit full-app idle prefetch (C-009).** Replace all-room prefetch with evidence-based likely-next or input/viewport-triggered warming. Acceptance: cold/idle bundle and first-navigation measurements on representative hardware.

## P2 — Product surface and archaeology decisions

- **Choose canonical room metadata and surfaces (C-049/C-053).** One typed registry should drive loaders, menus, and palette; decide whether Browser/Jorvis/Skills/Swarm are rooms, companion rails, or deliberately both. Acceptance: completeness test against `RoomId` and no accidental duplicate same-surface mounts.
- **Retire provider compatibility scaffolding only after compatibility sign-off (C-048).** Check persisted/external provider definitions, then remove unused legacy/coming-soon/fallback gates and per-spawn KV reads if safe.
- **Resolve the historical right-rail enable flag (C-052).** Migrate or explicitly preserve operators with `rightRail.enabled=0`, then remove the read-only flag and identity tab shim.
- **Consolidate voice implementation twins (C-050/C-051).** Rewire to one model registry and one dictionary normalizer before deleting either live copy. Acceptance: download, abort, tiny-path, and normalization parity tests plus bundle diff.
- **Decide migration 0026 (C-054).** Audit affected databases, then either sign off and ship the repair or archive the pending migration and its dormancy test with a written data decision.
- **Archive repository-only noise (C-055/C-056).** Remove the stale docs marketplace manifest, repair SigmaVoice build instructions, and decide LFS/release storage for 1,107 historical frames plus ownership of unreferenced root backgrounds. No runtime-performance claim is attached.
- **Remove unreachable assistant stub prose (C-057).** Delete the forced-reply-bypassed composer after a focused controller regression test.

## Target-OS verification owed

- Windows packaged voice, installer, tray/notification resources, ReviewRunner tree-stop, concurrent-profile ownership, and legal `%VAR%` directory behavior (C-029/C-035/C-036/C-038/C-039).
- macOS packaged voice/notarized artifact and noisy interactive-shell profile coverage (C-029/C-037).
- Packaged `.app`, `.exe`, and Linux artifact launch jobs plus crash-recovery and pane-split CI gates (C-043/C-046/C-047).
