# Master Memory — SigmaLink Project Log

## Phase 28 — v1.4.2 Bundle (2026-05-17)

Phase 28 consolidates the v1.4.2 fix bundle: 8 merged packets addressing
Windows compatibility, workspace routing, xterm preservation, worktree
discoverability, disk-scan scoping, NSIS installer UX, and a docs cleanup
sweep. The delegation matrix was rebalanced so Qwen carries mechanical bulk
(docs, verify-and-close) while Sonnet/Opus handle architecture-critical packets.

### Packet 01 — Sigma Assistant Windows spawn ENOENT (dc5818c)

Root cause: `runClaudeCliTurn.ts` called `child_process.spawn` directly with
a resolved CLI path. On Windows, npm shims are `.cmd` files and Node's
`CreateProcessW` cannot execute them with a bare arg array, producing ENOENT.
Fix: new `spawn-cross-platform.ts` exports `spawnExecutable()` that wraps
`.cmd`/`.bat` via `cmd.exe /d /s /c` and `.ps1` via `powershell.exe`,
mirroring the private `platformAwareSpawnArgs()` in `local-pty.ts`. The
`shell: true` option was explicitly rejected for argv-quoting/injection safety.
7 new tests cover the cross-platform dispatch matrix.

### Packet 02 — Workspace routing: Settings blocks workspace click (d9f2d91)

P1 bug: clicking a workspace in the sidebar after visiting Settings kept the
user stuck on Settings instead of routing to Command Room. Root cause:
`SET_ROOM` only excluded `'workspaces'` from `roomByWorkspace` persistence,
so visiting Settings wrote `roomByWorkspace[wsId] = 'settings'`. Fix:
introduced `GLOBAL_ROOMS = ['workspaces', 'settings']` guard applied
consistently across three dispatch paths (SET_ROOM writer, SET_ROOM_FOR_WORKSPACE,
SET_ACTIVE_WORKSPACE_ID). 2 new regression tests added.

### Packet 03 — xterm preservation across room/workspace switch (d970820)

Two-layer fix for the dogfood report of "sessions getting frozen" on switch.
Layer 1: mount-race quick-win reorders the xterm host so `pty:data` bus
subscription attaches before `rpc.pty.snapshot` IPC roundtrip, closing the
1-5 ms drop window. Layer 2 (chosen approach): renderer-side terminal-instance
cache keyed by sessionId survives both room and workspace switches, unlike
React 19 `<Activity>` which would unmount children on workspace key change.
The cache moves terminal instances between hosts rather than recreating them.

### Packet 06 — Worktree location UX — Option D (494ff1d)

Additive discoverability affordances for pane worktrees without relocating them.
Pane right-click context menu adds "Reveal worktree in Finder/Explorer" (via
`shell.showItemInFolder` RPC) and "Open shell here" (spawns OS-default terminal).
Per-pane tooltip shows full worktree path. First-launch info banner explains
where worktrees live (`<userData>/worktrees/<repoHash>/`) with dismiss state.
New Settings → Storage tab lists all worktrees with async-computed sizes and
reveal buttons. Zero changes to `rpc-router.ts:144` baseDir wiring.

### Packet 08 — state.tsx LOC verify-and-close (c2268d2)

Verified that `state.tsx` is already at 97 LOC — well under the 500-LOC budget.
The planned split was completed in v1.1.9 (commit `d824c42`). Stale BACKLOG
and WISHLIST rows removed. No source code changes.

### Packet 09 — Backlog verify-and-close sweep (11086dd)

Four backlog items verified: BUG-W7-015 launch button contrast (already fixed
on main with `bg-accent` + darker Parchment tokens), CI cache-dependency-path
(correct), vitest coverage thresholds (present with 22% lines floor), and
shellcheck CI step (escalated — runs `apt-get` on `macos-14` runner). Added
`[1.4.2]` CHANGELOG section. No source code changes.

### Packet 10 — Disk-scan provider scoping via agent_sessions whitelist (5bbf52c)

Closes open risk R-1.2.8-2: the disk scanner now rejects candidate sessions
whose external id is already claimed by a *different* workspace, preventing
foreign sessions spawned in another repo from being captured by the current
workspace's pane. Uses `agent_sessions` whitelist (Option B) — simpler than
project-hash env vars and has no provider session format dependency. New
`listSessionExternalIdsForWorkspace()` and `findWorkspaceForExternalId()`
helpers gate `findLatestSessionId`. Backward-compatible when no workspaceId
is passed.

### Packet 11 — NSIS welcome page with SmartScreen workaround (93f16df)

Replaced `nsis.license` (external license file) with `nsis.include` pointing
to new `build/installer.nsh` that defines `MUI_WELCOMEPAGE_TITLE` and
`MUI_WELCOMEPAGE_TEXT` with inline SmartScreen / Mark-of-the-Web workaround
instructions. The welcome page explains why unsigned EXEs trigger Defender,
provides Option A (click through SmartScreen) and Option B (right-click →
Properties → Unblock), and links to releases/source/issues.
