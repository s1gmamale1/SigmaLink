# Phase-0 Crash-Recovery Smoke — Operator Runbook

The "force-quit → relaunch" manual smoke. This is the human/hardware version of
the automated `crash-recovery.smoke.spec.ts` e2e. Run it on a **real machine**
before tagging a Phase-0 release — the e2e covers the core logic, but only a
hardware force-quit fully exercises the OS-level SIGKILL path (Activity Monitor /
Task Manager) and real on-disk worktree growth.

> The core of this runbook is automated: `npm run test:smoke:crash` (from
> `app/`). Use that first; do the manual steps below to confirm on real
> hardware + a real provider CLI.

## What we're gating (the incident)

A hard kill (SIGKILL) skips Electron's `before-quit`, which causes three
failures unless Phase-0 fixes are in place:

- **CRIT-3 — workspaces / session-restore lost.** `app.lastSession` is only
  written in `before-quit`, so a crash loses the restore context. (Workspace
  ROWS themselves persist immediately, so the picker should still list them.)
- **CRIT-2 — pane lockout.** Dead `agent_sessions` rows keep `status='running'`
  and their `pane_index`. The status-agnostic unique index treats them as still
  occupying the slot, so every fresh spawn collides →
  `"duplicate spawn suppressed"` → no pane appears (or a `-1` pane index).
- **CRIT-1 — worktree disk leak.** A spawn-retry loop leaks git worktrees
  (the real incident reached **49 GB**).

## Prerequisites

1. Build the app from the release commit:
   ```bash
   cd app
   pnpm build && pnpm electron:compile
   # (npm equivalents: npm run build && npm run electron:compile)
   ```
2. Have a throwaway git repo to open as a workspace (NOT a repo you care about —
   the launcher creates worktrees under it).
3. Know where the app stores its data:
   - macOS: `~/Library/Application Support/SigmaLink/` (dev builds may use
     `~/Library/Application Support/Electron/`)
   - Windows: `%APPDATA%\SigmaLink\`
   - Linux: `~/.config/SigmaLink/`

## Steps

1. **Launch** the built app. Open the throwaway repo as a workspace.
2. **Spawn ≥2 panes** (Launcher → e.g. "2 panes" → Launch). Confirm both panes
   reach a live terminal. Type something in each so you know they're alive.
3. **Note baseline worktree size:**
   ```bash
   du -sh ~/Library/Application\ Support/SigmaLink/worktrees   # macOS
   ```
4. **Force-quit (the real crash — do NOT use Cmd+Q / clean quit):**
   - macOS: **Activity Monitor → select "SigmaLink" → Force Quit (the ⊗ button)**,
     or in a terminal: `pkill -9 SigmaLink` (dev build: `pkill -9 Electron`).
   - Windows: **Task Manager → SigmaLink → End Task.**
   - Linux: `pkill -9 sigmalink` (or the Electron process name).
5. **Relaunch** the app (same machine, same userData).
6. **Verify:**
   - **CRIT-3:** the workspace picker still lists your workspace (it did not
     vanish), and re-opening it restores the prior room/panes.
   - **CRIT-2:** click **+Pane** (and/or resume the prior panes). A NEW pane
     must spawn and reach a live status. There must be **no**
     `"duplicate spawn suppressed"` in the logs and **no** stuck/empty pane.
   - **CRIT-1:** repeat the force-quit → relaunch → +Pane loop **3-4 times
     rapidly**, then re-check:
     ```bash
     du -sh ~/Library/Application\ Support/SigmaLink/worktrees
     ```
     The size must stay **small and bounded** (a handful of worktrees), NOT grow
     each cycle toward gigabytes.

## Expected results

| Check | Pass | Fail (the bug) |
|-------|------|----------------|
| CRIT-3 workspaces | Workspace still listed; prior session restores | Empty picker / workspace gone |
| CRIT-2 +Pane | New pane spawns + goes live | "duplicate spawn suppressed", no pane, or -1 pane index |
| CRIT-1 worktrees | `du -sh worktrees` stays small across cycles | Grows unboundedly (→ GB) |

## Notes

- On a **Lane-A-only** build (disk-safety net merged, DB lockout fix NOT yet
  merged), CRIT-1 passes but **CRIT-2 / CRIT-3 are expected to FAIL** — that is
  the reproduction. Both go green once the Lane B fix lands (status-aware unique
  index + per-boot janitor reconcile of dead rows + adopt/replace on slot
  conflict + a session-snapshot persistence flush).
- The automated `npm run test:smoke:crash` reproduces the same three checks with
  shell panes + a temp userData (it never touches your real profile). Use it for
  fast CI-style verification; use this runbook for the hardware sign-off.
