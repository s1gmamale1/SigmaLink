# Bug: panes don't resume (black / crashing) after a force-quit + relaunch

**Status:** PART A FIXED + operator-GUI-confirmed (2026-06-05) — panes recovered live after force-quit→relaunch. Part B (resume self-heal of a missing worktree) DEFERRED — see §12 Resolution.
**Filed:** 2026-06-05
**Repo:** `/Users/aisigma/projects/SigmaLink/app` (branch `main`, current HEAD `f4e6f02`)
**Owner of fix:** Codex (investigate → confirm root cause → fix → test). **Do NOT merge/push/tag.**

---

## TL;DR

After the SigmaLink app is hard-killed (`kill -9`, simulating a crash) and relaunched, the workspaces and pane **layouts** come back, but the agent panes are **black / dead** — they "struggle to resume and then crash" instead of coming back as live terminals. A benign `ResizeObserver loop … undelivered notifications` error also pops as a fatal-looking toast (secondary, see §10).

This **previously worked** (panes resumed live after a crash) and **regressed**. The regression window is a just-landed change set called **"Phase 0 Lane B"** (commits listed in §5). The two new behaviors most likely responsible:
1. The boot **janitor** is now `await`ed and marks crashed sessions `exited, exit_code=-1` (was: not awaited; sessions stayed `running` through resume).
2. A boot-time **all-repo worktree sweep** (`sweepAllReposOnBoot`) now runs on **every launch** — it was **dead code (never called) before**. It may be deleting the per-pane git worktrees that the resume flow re-spawns into → CLI spawns in a missing cwd → early-death → black pane.

**Your job:** confirm the *exact* failing mechanism (don't assume), then fix it so a force-quit → relaunch resumes panes as live terminals — **without** reintroducing the post-crash launch lockout that Phase 0 fixed.

---

## 1. How to build & run

```bash
cd /Users/aisigma/projects/SigmaLink/app
npm run electron:dev   # builds + compiles electron main + launches the app
```
- Electron desktop app (TypeScript, better-sqlite3 + Drizzle ORM, node-pty, React renderer, vitest, Playwright e2e).
- `better-sqlite3` **cannot load under vitest** (Electron ABI) — DB code is tested with hand-rolled Mock/RecordingDb classes (see existing migration tests for the pattern).
- App userData (the live DB + worktrees) on this machine:
  - DB: `~/Library/Application Support/SigmaLink/sigmalink.db`
  - Worktree pool: `~/Library/Application Support/Electron/worktrees/<sessionId>/<pane-name>/`
  - **Read the DB only while the app is NOT running** (WAL + read-only open fails while it holds the lock): use `sqlite3 "$DB" "<query>"` after quitting, or `sqlite3 -readonly "$DB"` (avoid the `file:…?mode=ro` URI — it breaks on the spaces in "Application Support").

---

## 2. Symptom (operator-observed)

1. Open one or more workspaces, each with several agent panes (claude/codex/gemini/shell). Let them spin up.
2. Hard-kill the app: `pkill -9 -f "electron-dist/main.js"` (simulates a crash; `before-quit` does NOT run).
3. Relaunch (`npm run electron:dev` or `electron electron-dist/main.js`).
4. **Observed:** workspaces + pane layouts restore (headers, branch pills, agent IDs all present), but the pane bodies are **black**; the swarm shows *"Swarm is paused — resume it to add panes"*; panes "struggle to resume and crash." `MCP: — not started`.
5. **Expected:** panes resume as **live terminals** (the CLI agents re-spawn in their worktrees and reattach), same as before this regression.

Operator notes verbatim: *"They appear black, struggling to resume and crashing."* and *"Previously we had the same issue, and it got fixed later on, but after that force quit it again broke."* → i.e. this is a **regression of previously-working behavior**.

---

## 3. Architecture primer (what a "pane" is)

- A **workspace** maps to a project dir. It contains N **panes**; each pane runs a CLI agent (claude/codex/gemini/kimi/opencode/cursor) or a shell.
- Each pane is backed by:
  - one row in the `agent_sessions` table (`id`, `workspace_id`, `provider_id`, `status` ∈ `starting|running|exited|error`, `exit_code`, `exited_at`, `pane_index`, `worktree_path`, `external_session_id`, `cwd`, …), and
  - (for git repos) a **git worktree** at `worktree_path` under the Electron userData worktree pool.
- On a normal launch, panes spawn via `executeLaunchPlan` (creates worktrees + PTYs).
- On reopen/relaunch, panes are **rehydrated** (shells shown from DB rows) and **resumed** (PTYs re-spawned with `--resume`/`--continue`).

---

## 4. Exact code map (verify line numbers; they may drift)

### Boot sequence — `src/main/rpc-router.ts`
- `buildRouter()` (~line 271, now `async`):
  - `initializeDatabase(userData)`
  - `const worktreeBase = path.join(userData, 'worktrees')` (~275)
  - `await runBootJanitor()` (~280)  ← **awaited now (was `void` fire-and-forget)**
  - `await sweepAllReposOnBoot(worktreeBase, getRawDb())` (~284)  ← **NEW: this call did not exist before; the function was dead code**
- `registerRouter()` (~2101, now `async`) → `await buildRouter()`; called from `electron/main.ts` `app.whenReady().then(async () => { … await registerRouter(); createWindow(); })` (~736–754).
- `workspaces.open` handler (~1353) → after opening, also calls `cleanupOrphanWorktrees(worktreeBase, hash, getRawDb())` (~1371) — **a THIRD worktree-cleanup call**, per-repo, fired (not awaited) on every workspace open, i.e. right before the renderer resumes panes.
- Pane controllers:
  - `panes.resume` (~1036/1051) → `resumeWorkspacePanes(workspaceId, { pty, loadScrollbackForSession })`
  - `panes.resumeSelected` (~1064/1081) → same, with a sessionId subset
  - `panes.respawnFailed` (~1058) → `respawnFailedWorkspacePanes(workspaceId, { pty })`
  - `panes.lastResumePlan` (~1112) and `panes.listForWorkspace` (~1159): both rank **live-first** (`status IN ('running','starting')` → 0 else 1) but return **one row per pane slot regardless of status** → this is why dead/exited panes still rehydrate as shells.

### Boot janitor — `src/main/core/db/janitor.ts`
- `runBootJanitor()` (~26–84). Selects zombies `WHERE status IN ('running','starting')` (~37) and updates each `SET status='exited', exit_code=-1, exited_at=now` (~41–44). **Preserves `pane_index`.** (Phase 0 Task 2 widened this from `running`-only to `running`+`starting`.)

### Worktree reaper — `src/main/core/workspaces/worktree-cleanup.ts`
- `cleanupOrphanWorktrees(worktreeBase, repoHash, db)` (~31):
  - keep-set query (~58–65): `SELECT DISTINCT worktree_path FROM agent_sessions WHERE worktree_path IS NOT NULL AND worktree_path LIKE '<repoDir>/%' AND (status='running' OR exited_at > now-7d)`.
  - cold-install short-circuit (~71–84).
  - reap loop (~90–103): any dir under `<repoDir>` whose full path is NOT in the keep-set is `fs.rm(..., {recursive:true,force:true})`.
- `sweepAllReposOnBoot(worktreeBase, db)` (~144–192): iterates **every** top-level dir under `worktreeBase` and calls `cleanupOrphanWorktrees(worktreeBase, <dirname>, db)` for each. **NOTE the layout assumption:** it treats each top-level dir as a "`repoHash`", but on disk the actual layout is `<worktreeBase>/<sessionId>/<paneName>` (the middle component is a *session* id, not a repo hash). Verify whether this mismatch matters for the keep-query's `LIKE '<repoDir>/%'` matching.

### Resume re-spawn — `src/main/core/pty/resume-launcher.ts`
- `listEligibleRows(db, workspaceId)` (~245–269): eligible to resume = `status='running' OR (status='exited' AND exit_code=-1)`. (So janitor-marked crashed panes — `exited, exit_code=-1` — ARE eligible.)
- `resumeWorkspacePanes(...)` (~410): for each eligible row, `cwd = workspaceCwdInWorktree({workspaceRoot, repoRoot, worktreePath})` (~445), build resume args (`buildResumeArgs`, ~58), `resolve(...)` spawns the PTY (~525), `markResumeRunning` on success, `markResumeFailed` (`status='exited', exit_code=-1`) on throw (~559).
- `attachExitPersistence(...)` (~222): **any exit within 1.5 s of spawn is treated as a launch failure → `status='error'`** (~232). A CLI that can't `chdir` into a missing worktree, or that fails `--resume`, dies fast → marked `error` → **black pane**.
- `respawnFailedWorkspacePanes(...)` (~336): the "Respawn fresh" recovery — re-spawns `exited/-1` rows in their existing worktree with NO resume args.
- `workspaceCwdInWorktree` lives in `src/main/core/workspaces/worktree-cwd.ts`.

### Lane A worktree primitives (already shipped, base `8e203b2`) — `src/main/core/git/worktree.ts`
- `WorktreePool.create()` has a count cap + `fs.statfs` free-disk floor (~99–100) and throws `WorktreeDiskGuardError`. `WorktreePool.removeAndPrune()` (~220). These are the disk-leak safety net and must stay intact.

### Secondary (ResizeObserver toast) — `src/main/main.tsx`
- `installGlobalErrorSink()` adds `window.addEventListener('error'|'unhandledrejection', …)` that calls `toast.error('Unexpected error: …')`. It currently surfaces the benign `ResizeObserver loop completed with undelivered notifications` message as a fatal toast.

---

## 5. What changed (the regression surface — Phase 0 Lane B)

Diff these commits (newest first); the base before Lane B is `8e203b2` (Lane A disk-safety) → diff `8e203b2..f4e6f02`:

| Commit | What |
|---|---|
| `b0c7725` | session-restore: throttled opportunistic `app.lastSession` flush (CRIT-3) |
| `f1b7ac8` | launcher.ts: `removeAndPrune` worktree on suppressed launch (twin) |
| `42ee75f` | factory-spawn.ts: `removeAndPrune` worktree on suppressed spawn (twin) |
| **`d384b0e`** | **boot: `await runBootJanitor()` + `await sweepAllReposOnBoot(...)` before window** ← prime suspect |
| **`2e1433b`** | **janitor: sweep `starting` zombies too (was `running` only); marks `exited, exit_code=-1`** ← suspect |
| `efbb472` | migration 0032: status-aware `agent_sessions_ws_pane_uq` unique index |

**Why it worked before:** the janitor was `void` (not awaited) so crashed panes were often still `status='running'` when resume ran (matching `listEligibleRows`), AND there was **no boot worktree sweep at all**, so per-pane worktrees were intact when resume re-spawned into them.

---

## 6. Evidence already gathered

- After a `kill -9` + relaunch, agent panes' git worktrees are **missing on disk** — e.g. a workspace showing 6 agents had **0** worktrees in `git worktree list` and under the pool dir; another showing 4 agents had only 2 (shell) worktrees left.
- All `agent_sessions` rows DO have `worktree_path` set (it is **not** a NULL-path problem). Counts at one snapshot: 122 `exited`/`wt=set`, 3 `running`/`wt=set`, 0 NULL.
- `app.lastSession` kv DID persist the open workspace across the SIGKILL (so CRIT-3 / workspace restore works) — only the **panes** fail to come back live.
- Apparent contradiction to resolve: the reaper's 7-day rule (`exited_at > now-7d`) *should* protect a just-crashed pane (the janitor sets `exited_at=now` immediately before the sweep), yet worktrees are vanishing. Confirm whether the protection is actually being applied to these rows (path-normalization mismatch? layout assumption in §4? timing? the per-open cleanup at rpc-router:1371?).

---

## 7. Hypotheses (ranked) + the decisive check for each

**H1 — Boot sweep reaps worktrees resume needs (most likely).** `sweepAllReposOnBoot` (new in `d384b0e`) deletes the crashed panes' worktrees; resume then re-spawns into a missing cwd → early-death → `error` → black.
- *Decisive check:* with the app quit, snapshot the worktree dirs + the keep-query result for a crashed workspace BEFORE relaunch; relaunch; snapshot again. Does the sweep delete a dir whose session row is `exited_at=now`? If yes, find why the keep-query misses it (compare the stored `worktree_path` string EXACTLY against `<repoDir>/<entry>` — trailing slash, `path.sep`, symlink/realpath of "Application Support", or the `<base>/<sessionId>/<paneName>` vs `<base>/<repoHash>/<worktree>` layout mismatch in §4).

**H2 — Resume re-spawns but the CLI `--resume`/`--continue` fails fast** (e.g. into an intact worktree but with an invalid session target), tripping the 1.5 s early-death → `error`.
- *Decisive check:* temporarily log the spawn `cwd`, `extraArgs`, and exit code/timing in `resumeWorkspacePanes` + `attachExitPersistence`; run a real crash→relaunch; read which it is (missing-cwd spawn error vs CLI exiting 1).

**H3 — Swarm workspaces don't auto-resume** (the "Swarm is paused — resume it" state); panes only rehydrate as dead shells and the auto-resume path is skipped for swarm panes.
- *Decisive check:* trace what the renderer calls on workspace reopen for a swarm vs a normal workspace — is `panes.resume` invoked at all for swarm panes, or is it gated behind a manual "resume swarm" action?

**H4 — `markResumeFailed` / janitor `exit_code=-1` interaction** leaves rows in a state the UI renders as permanently dead.
- *Decisive check:* after a failed resume, inspect the row (`status`, `exit_code`) and confirm whether `panes.respawnFailed` would recover it — and whether the UI ever offers that.

Confirm ONE root cause with evidence before writing the fix. It may be a combination (e.g. H1 + H3).

---

## 8. Suggested investigation procedure (controlled, reproducible)

The live app's DB kept changing during ad-hoc testing — use a **clean, controlled** repro:
1. Quit the app. Snapshot: `git -C <each project repo> worktree list`; `ls -R "~/Library/Application Support/Electron/worktrees"`; and `sqlite3 "$DB" "SELECT id,workspace_id,status,exit_code,exited_at,pane_index,worktree_path FROM agent_sessions WHERE workspace_id='<ws>';"`.
2. Launch; open ONE git-repo workspace with 2–3 panes; let them go live. Re-snapshot (note worktree dirs + session rows now `running`).
3. `pkill -9 -f electron-dist/main.js`. Re-snapshot the DB (rows should still be `running`, worktrees present) — this is the "crash" state.
4. Relaunch. **Immediately** capture the boot log (stdout of the electron process), then re-snapshot DB + worktrees. Determine: did the janitor mark them `exited/-1`? did the sweep delete any worktree? did resume run and what was the spawn error/exit timing?
5. The diff between step-3 and step-5 snapshots pins the mechanism.

Since Codex can't drive the GUI, also write an **automated** reproduction at the unit/integration level that exercises the boot sequence (`runBootJanitor` → `sweepAllReposOnBoot` → `resumeWorkspacePanes`) against a temp DB + temp worktree dirs and asserts the worktrees survive and resume re-spawns. (The operator will run the final GUI crash→relaunch to validate.)

---

## 9. Constraints (do NOT break these)

- **Do NOT reintroduce the post-crash launch lockout** that Phase 0 fixed. Keep migration `0032` (status-aware unique index) and the janitor's freeing of slots. Regression-test that a fresh spawn into a janitor-swept slot still succeeds.
- **Keep Lane A's disk-leak safety net** (`WorktreePool.create` cap + `statfs` floor; `removeAndPrune`). The goal is *don't reap worktrees that resume needs*, not *stop reaping leaked worktrees*.
- **Worktree isolation:** do all work in a dedicated git worktree/branch off `main` (`f4e6f02`). Verify your diff lands in your worktree, **not** the main checkout. Commit by explicit path (never `git add -A`).
- **Gates:** `npx tsc -b` clean, `npx vitest run` green, `npm run lint` clean, `npm run build` ok. Add the regression test(s) described in §8.
- **Do NOT merge, push, or tag.** Report the confirmed root cause + diff for review.

---

## 10. Secondary (optional, separate, smaller)

Benign `ResizeObserver loop completed with undelivered notifications` is surfaced as a fatal toast by `installGlobalErrorSink()` in `src/main/main.tsx`. Fix = in that global error handler, **filter only** the two benign ResizeObserver-loop messages (`"ResizeObserver loop limit exceeded"` and `"ResizeObserver loop completed with undelivered notifications"`) so they are swallowed / debug-logged, NOT toasted. Do **not** delete the whole error sink (a prior attempt did that — wrong). Add a unit test: a ResizeObserver-loop error produces no toast; a genuine error still does. Keep this in a SEPARATE commit from the resume fix.

---

## 11. Definition of done

- Confirmed root cause stated with evidence (which hypothesis, exact file:line + mechanism).
- A force-quit (`kill -9`) → relaunch resumes the previously-open panes as **live terminals** (PTYs re-spawned, worktrees intact). The swarm panes come back live (or there is a clear, working "resume" affordance — not a silent black crash).
- The post-crash lockout does NOT return (fresh spawns into swept slots still work).
- New automated regression test(s) fail before / pass after.
- All gates green. Not merged.

---

## 12. Resolution (2026-06-05)

**Part A — SHIPPED + operator-GUI-confirmed.** Root cause confirmed (Codex): the reaper's keep-set (`running OR exited_at>7d`) was narrower than resume-launcher's eligibility (`running OR (exited AND exit_code=-1)`), so boot/open cleanup could delete worktrees that resume would later spawn into. Fix: `cleanupOrphanWorktrees` keep-set now also preserves `starting` and `exited/-1` rows (`worktree-cleanup.ts:54`). Regression test added. Gates green (tsc · 2740 vitest · lint · build). Branch `fix/pane-resume-crash` (commit `93fbca6`), merged to local `main` (untagged, unpushed). Operator force-quit→relaunch test: **panes recovered live.**

**Part B — DEFERRED (latent robustness gap, not blocking).** A controlled snapshot during the retest revealed that a `running` pane can reference a `worktree_path` whose directory is **already missing on disk** (reaped during an earlier session). The resume path (`resume-launcher.ts` `resumeWorkspacePanes` / `respawnFailedWorkspacePanes`) re-spawns into the stored `worktree_path` **without verifying it exists or recreating it** — so once a worktree is gone for any reason, future resumes of that pane spawn into a missing cwd → early-death → black. Part A stops the *over-reaping* that creates this state going forward; it does not make resume **self-heal** an already-missing worktree. **Proposed Part B:** in the resume path, if `worktree_path` is non-null but the dir is missing, recreate it via `worktreePool.create(...)` before spawning (or fall back to the workspace root). Did not reproduce as fatal in the operator retest (panes recovered), so deferred.

**Also deferred:** the benign ResizeObserver toast (§10) — not implemented.
