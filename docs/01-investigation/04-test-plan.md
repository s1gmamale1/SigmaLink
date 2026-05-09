# 04 - Test Plan

This is the verification matrix to run once the fixes from `01` and the P1/P2 items from `02` are applied. Each test specifies preconditions, exact steps, expected result, and OS-specific notes. Aim is zero unknown unknowns; every fix in this round has at least one test attached.

---

## Environment matrix

- **Win11/x64** (primary, the user's environment): Windows 11 Pro 10.0.26100, Node 20+, Git for Windows 2.40+, Claude Code/Codex/Gemini/Kimi installed via `npm i -g`.
- **macOS** (sanity): 14.x or 15.x, Node 20+, same CLIs.
- **Linux** (smoke): Ubuntu 22.04+, Node 20+, same CLIs.

For each test below, the OS-specific notes section calls out where behaviour diverges.

---

## T0 — Bootstrap

### T0.1 Build succeeds and the app launches

- Steps: `npm i`, `npm run electron:dev`.
- Expected: window opens, no red console errors, Workspaces room renders.
- All OS: same.

### T0.2 Database file is created on first run

- Steps: launch once, then close.
- Verify: `<userData>/sigmalink.db` exists, plus `-wal` and `-shm` siblings (WAL mode).
- Win path: `%APPDATA%\SigmaLink\sigmalink.db`.
- macOS path: `~/Library/Application Support/SigmaLink/sigmalink.db`.
- Linux path: `~/.config/SigmaLink/sigmalink.db`.

---

## T1 — P0-PTY-WIN-CMD: Windows agent launch

### T1.1 Claude Code launches and shows interactive UI in pane

- Pre: `npm i -g @anthropic-ai/claude-code` so `where claude` resolves.
- Steps: pick `C:\Users\DaddysHere\Documents\Homeworks`, preset `1 pane`, provider `Claude Code`, click Launch.
- Expected: Command Room opens. Pane shows the Claude Code TUI (welcome/prompt). No red `Cannot create process, error code: 2` text.
- Failure: any text "error code: 2" in the pane = bug not fixed.
- Win11: validates the fix.
- macOS/Linux: should already work since the bug is Windows-only; run as regression sentinel.

### T1.2 Codex / Gemini / Kimi each launch the same way

- Repeat T1.1 once per provider that is installed locally.
- Expected: each TUI appears.

### T1.3 Mixed grid 4 panes (claude, codex, gemini, kimi)

- Steps: preset `4 panes`, assign one provider per pane, Launch.
- Expected: 4 separate TUIs render in the mosaic. Each pane has its own worktree directory under `<userData>/worktrees/<repoHash>/...` (verify via Explorer/Finder/`ls`).
- Win11: also confirm the 4 git worktrees show in `git worktree list` from the repo root.

### T1.4 Probe shows checkmark in Launcher

- Steps: Workspaces room → "3 · Assign a provider per pane".
- Expected: each installed provider shows ✓ in the dropdown.
- Validates P1-PROBE-EXEC-WIN.

### T1.5 Probe version string is non-empty

- Pre: open dev tools → Network or eyeball the renderer state.
- Steps: `await rpc.providers.probeAll()` from devtools console.
- Expected: each `found: true` probe also has `version: "x.y.z"`.
- Validates P1-PROBE-EXEC-WIN beyond T1.4.

### T1.6 Shell provider always launches

- Steps: pick any folder, preset 1, provider `Shell`, Launch.
- Expected: a powershell.exe / bash prompt appears.
- All OS: regression sentinel for the empty-command fall-through.

---

## T2 — Worktree lifecycle

### T2.1 Worktree created on launch (Git repo)

- Pre: `Homeworks` is a git repo (verified by user).
- Steps: launch any provider, observe `<userData>/worktrees/<repoHash>/<sanitised-branch>/` exists, contains a `.git` file (worktree pointer).
- Verify: `git worktree list` from the repo root lists it.

### T2.2 Worktree NOT created on launch (plain folder)

- Pre: pick a non-git folder.
- Steps: launch provider.
- Expected: pane uses the workspace root as cwd. No worktree directory created.

### T2.3 Worktree removed when commit-and-merge succeeds

- Steps: cd into the worktree dir, edit a file, run `rpc.git.commitAndMerge(...)` from devtools (or via a future Review Room UI).
- Expected: merge into the workspace root, worktree dir removed by `worktreeRemove`.
- Validates `git-ops.ts:188-194`.

### T2.4 Worktree NOT leaked when launch fails

- Pre: corrupt a provider's command in `providers.ts` to a non-existent name (or temporarily un-install it).
- Steps: launch.
- Expected: error surfaces in launcher, no worktree directory left under `<userData>/worktrees/...`.
- Validates P1-WORKTREE-LEAK fix.

---

## T3 — PTY lifecycle and registry

### T3.1 Stop button kills session

- Steps: launch any provider, click the Stop (square) icon on the pane header.
- Expected: pane status badge turns red ("exited"), terminal shows `[session exited code=...]`.

### T3.2 Session row updated to 'exited' in DB

- Steps: after T3.1, query SQLite: `SELECT status, exit_code FROM agent_sessions WHERE id=?`.
- Expected: `status='exited'`, `exit_code` populated.

### T3.3 Session removed from registry after close

- Pre: requires P1-PTY-REGISTRY-LEAK fix and a "close pane" UI.
- Steps: close pane via the new affordance.
- Expected: `await rpc.pty.list()` no longer includes the session id.
- Validates W2.

### T3.4 Spawn-time failure surfaces as exited pane

- Pre: install no CLI, attempt to launch claude.
- Expected (after fix): pane immediately shows `[session exited code=-1]` and DB row marked `'error'` (not stuck `'running'`).
- Validates P1-PTY-FAILURE-NOT-DETECTED.

### T3.5 Multiple kills are idempotent

- Steps: click Stop twice on a session that already exited.
- Expected: no error in console, no second exit event.

---

## T4 — Ring buffer and replay

### T4.1 Re-mount preserves history

- Steps: launch claude, type some output (run `ls` inside the TUI), switch to another room, switch back.
- Expected: terminal re-renders the previous output. No double-replay.

### T4.2 256 KiB cap is enforced

- Steps: launch shell, run `seq 1 50000` to flood output, switch rooms, return.
- Expected: replay shows only the last ~256 KiB; no crash.

### T4.3 Unicode is not split across replays

- Pre: requires the P2 unicode-safe trim.
- Steps: print 100 KiB of emoji, force a trim, re-mount.
- Expected: no � (replacement character) at the start of replay.

---

## T5 — Workspace persistence

### T5.1 Workspace appears in "Recent" after first open

- Steps: pick folder, return to Workspaces room.
- Expected: it appears in the Recent list with the correct name and path.

### T5.2 Re-opening updates lastOpenedAt and reuses the row

- Steps: open same folder twice; query `SELECT id, last_opened_at FROM workspaces WHERE root_path=?`.
- Expected: same id, last_opened_at advanced.

### T5.3 Removing a workspace via trash icon

- Steps: hover row in Recent, click trash icon.
- Expected: row removed from UI, DB row gone.
- Note: any existing worktrees for that repo are NOT removed by this action (intentional: agents may still own them).

### T5.4 Opening a workspace where the path no longer exists

- Steps: rename the directory on disk, re-open via Recent.
- Expected: error shown in launcher, no crash.
- Validates `factory.ts:25-28` (`Not a directory: <abs>`).

---

## T6 — RPC, IPC, and security

### T6.1 RPC envelope unwrapping

- Steps: from devtools, `rpc.app.getVersion()`.
- Expected: returns the version string. If you call a non-existent method, it throws with a useful message ("`app.bogus` failed").

### T6.2 Preload channel allowlist (after fix)

- Steps: `await window.sigma.invoke('not.a.channel')`.
- Expected: rejected with "channel not allowed" or similar; not silently invoked.
- Validates W4.

### T6.3 Cross-pane data leakage scoped (after subscription registry fix)

- Steps: launch 4 panes, then DevTools → Performance → record IPC for 5s.
- Expected: each Terminal receives only its own pane's `pty:data` events.
- Validates W6.

### T6.4 Error stack is included in dev builds

- Steps: trigger an error in main (e.g. open a non-directory path), inspect renderer console.
- Expected: dev build shows stack; prod build shows just the message.
- Validates P2-RPC-ERROR-STACK-LOST.

---

## T7 — Database lifecycle

### T7.1 Graceful close on quit

- Steps: launch app, launch a provider, then quit via Cmd-Q / Alt-F4.
- Expected: in DB, session row is updated to `'exited'` (or `'error'` if PTY didn't terminate cleanly). Worktrees are pruned.
- Validates W7.

### T7.2 Foreign keys ON

- Steps: from devtools, `rpc.git.runCommand` cannot be used; instead query `PRAGMA foreign_keys` via the raw DB if exposed.
- Note: today this isn't directly exposed via RPC; verify by inspecting `client.ts:58`.

### T7.3 No duplicate workspace on opening twice

- Steps: open same folder twice rapidly.
- Expected: same row id, no unique-index violation in logs.

---

## T8 — Renderer state and reducer

### T8.1 ADD_SESSIONS dedupes

- Steps: launch, then launch again with the same workspace; inspect `state.sessions`.
- Expected: no duplicate ids.

### T8.2 SET_ACTIVE_WORKSPACE auto-routes to Command Room

- Steps: from Workspaces room, set workspace; ensure `state.room === 'command'`.

### T8.3 MARK_SESSION_EXITED reflects in UI

- Steps: kill a pane.
- Expected: pane badge turns red instantly (driven by `pty:exit` event listener in `state.tsx:106-112`).

### T8.4 REMOVE_SESSION (after fix)

- Steps: close a pane via the new affordance.
- Expected: session removed from `state.sessions`, pane disappears from grid.

---

## T9 — UI / Layout / a11y

### T9.1 Mosaic / Columns / Focus toggles

- Steps: launch 6 panes; toggle each layout.
- Expected: grid recomputes (`gridClassFor` in `CommandRoom.tsx:11-26`); Focus shows only the selected pane.

### T9.2 Resize is debounced

- Steps: drag the window edge for 5s.
- Expected: `pty.resize` IPC fires at most every ~50ms (verify via DevTools).
- Validates P2-RESIZE-DEBOUNCE.

### T9.3 First fit no longer flickers

- Steps: launch a single pane.
- Expected: terminal renders sized correctly on first paint; no zero-size flash.

### T9.4 Sidebar disabled phases are unclickable and show phase chip

- Steps: try clicking Swarm/Review/Memory/Browser/Skills.
- Expected: nothing happens, opacity-40, P2/P3/P4 chip visible.

### T9.5 Aria labels present

- Steps: tab through the launcher and command room.
- Expected: every button announces (Stop session, Focus pane, Restore grid, Forget workspace, layout buttons).
- Validates P2-A11Y-MISSING-LABELS.

---

## T10 — Cross-OS regression sweeps

### T10.1 macOS — full launch path

- Repeat T1.1, T1.3, T2.1, T3.1, T7.1.
- Expected: all pass; default shell falls through to `$SHELL ?? /bin/bash` (`local-pty.ts:30-31`).

### T10.2 Linux — full launch path

- Same as macOS.
- Verify: `node-pty` prebuilt for the host's libc; `better-sqlite3` rebuilt for Electron.

### T10.3 Windows ia32 build (if shipping)

- Build with `electron-builder --win --ia32`.
- Expected: install and launch on a 32-bit Windows VM.
- Note: better-sqlite3 may not have ia32 prebuilt for the bundled Electron version; if not, drop ia32 (P3).

---

## T11 — Build and packaging

### T11.1 `npm run build` succeeds

- Expected: `dist/` populated, no TypeScript errors.

### T11.2 `npm run electron:compile` succeeds

- Expected: `electron-dist/main.js` and `electron-dist/preload.cjs` exist.

### T11.3 Electron Builder packages on Win

- Steps: `npm run electron:pack:win`.
- Expected: NSIS installer in `release/`, portable EXE in `release/`.
- Verify: `better-sqlite3` and `node-pty` rebuilt for Electron's Node ABI (check `electron-builder install-app-deps` ran during `postinstall`).

### T11.4 Electron Builder packages on macOS

- Steps: `npm run electron:pack:mac`.
- Expected: dmg + zip for both x64 and arm64.

### T11.5 Native modules resolved at runtime

- Steps: launch the packaged build; trigger DB write (open a workspace) and PTY spawn.
- Expected: no `Cannot find module` errors. (esbuild keeps `better-sqlite3` and `node-pty` external; they must be in `app.asar.unpacked`.)
- Win/mac/Linux: same.

---

## T12 — Stress + edge

### T12.1 16-pane mosaic launches

- Steps: preset 16, mix providers (or all Shell on machines without 16 CLI installs).
- Expected: 16 panes spawn, IPC stays responsive, RAM stays bounded.

### T12.2 Rapid kill/relaunch

- Steps: launch 4 panes, kill all, launch 4 again, repeat 10 times.
- Expected: no growth in `pty.list()` after each cycle (after W2 fix); no growth in worktree directory count.

### T12.3 Quitting mid-launch

- Steps: click Launch, immediately Cmd-Q.
- Expected: clean shutdown; no lingering processes in Task Manager / `ps`.

### T12.4 Disk full during worktree create

- Steps: simulate by pointing `userData` at a small volume.
- Expected: error surfaces in launcher; partial state cleaned up.

### T12.5 PATHEXT-only resolution

- Win11 only.
- Steps: temporarily set `PATHEXT=.EXE` (no `.CMD`).
- Expected: claude/codex/gemini/kimi launches fail with a clear error; reverting PATHEXT restores function.
- Validates the resolver logic in W1 fix.

---

## OS-specific notes summary

| Test | Win11 | macOS | Linux |
|---|---|---|---|
| T1.* | Critical (the bug) | Regression sentinel | Regression sentinel |
| T2.* | All pass | All pass | All pass |
| T3.* | All pass; T3.4 most relevant on Win | All pass | All pass |
| T7.1 | Critical | Pass | Pass |
| T9.2 | All | All | All |
| T11.3 | Win-only | n/a | n/a |
| T11.4 | n/a | mac-only | n/a |
| T12.5 | Win-only | n/a | n/a |

---

## Exit criteria for "Phase 1 ships"

All P0 fixed and verified by T1.*. All P1 fixed and verified by their corresponding T-tests (T1.4-T1.5 for probe; T2.4 for worktree leak; T3.3-T3.4 for PTY lifecycle; T6.2 for preload allowlist; T7.1 for DB shutdown; T8.4 for remove session). P2 set is acceptable to defer if individually triaged. P3 entirely deferable.
