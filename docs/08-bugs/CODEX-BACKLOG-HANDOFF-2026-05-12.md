# Codex Backlog Handoff — 2026-05-12

## Current State

- Worktree: `/Users/aisigma/projects/SigmaLink-bug-backlog-codex`
- Branch: `codex/bug-backlog-pr`
- Source of truth used: `docs/08-bugs/BACKLOG.md`
- Ruflo task record: `task-1778545436963-gtb750`
- Status: implementation is mostly complete, but not committed, not pushed, and no PR has been opened yet.

## Implemented Scope

### v1.1.9 Runtime Perf

- Added `useAppStateSelector<T>` backed by `useSyncExternalStore`.
- Added `useAppDispatch`.
- Added `sessionsByWorkspace` and `swarmsByWorkspace` derived slices to app state.
- Updated reducer maintenance paths for:
  - `ADD_SESSIONS`
  - `MARK_SESSION_EXITED`
  - `REMOVE_SESSION`
  - `SET_SWARMS`
  - `UPSERT_SWARM`
  - `MARK_SWARM_ENDED`
- Converted the first high-churn consumer wave:
  - Command Room
  - Command Palette
  - Swarm Room
  - Operator Console
- Added reducer tests for workspace-indexed sessions and swarms.

### CI / Test Infra

- Fixed stale GitHub Actions cache dependency path by using `app/package.json`.
- CI installs with `pnpm install --no-frozen-lockfile --ignore-scripts` because `app/pnpm-lock.yaml` is ignored in this repo.
- Added explicit Electron binary install step after skip-scripts install:
  - `node node_modules/electron/install.js`
- Added `pnpm run coverage`.
- Added `@vitest/coverage-v8`.
- Added baseline coverage thresholds matching current repo coverage:
  - lines: 22
  - statements: 21
  - functions: 21
  - branches: 18
- Added ShellCheck CI step for `app/scripts/install-macos.sh`.
- Added `app/coverage/` to `.gitignore`.

### React Compiler / Lint Wave

- `pnpm run lint` is clean.
- Fixed remaining sync `setState` in effect warnings with deferred effect work where appropriate.
- Replaced render-time `Math.random()` in sidebar skeleton with deterministic sizing.
- Fixed `shared/rpc.ts` remaining `any`.
- Added narrow file-level immutability disables for canvas physics surfaces where mutable refs are intentional:
  - `MemoryGraph.tsx`
  - `Constellation.tsx`

### Backlog Docs

- Updated `docs/08-bugs/BACKLOG.md` with 2026-05-12 status notes for completed v1.1.9 items.
- Noted that larger file-size refactors remain open.

## Validation Completed

Passing:

```bash
cd /Users/aisigma/projects/SigmaLink-bug-backlog-codex/app
pnpm run lint
pnpm exec tsc -b --pretty false
pnpm exec vitest run
pnpm run coverage
pnpm run build
```

Results:

- Vitest: 20 files passed, 130 tests passed.
- Coverage: 21.92% statements, 18.8% branches, 21.23% functions, 22.72% lines.
- Build: Vite production build passed.
- Installer syntax check:

```bash
cd /Users/aisigma/projects/SigmaLink-bug-backlog-codex
bash -n app/scripts/install-macos.sh
```

Passed locally.

ShellCheck binary is not installed locally, so the ShellCheck command itself was not locally verified. CI now installs ShellCheck before running it.

## E2E / Playwright Findings

Initial full Playwright run failed with Electron launch timeouts. That run used only:

```bash
pnpm run build
```

The CI path also runs:

```bash
node scripts/build-electron.cjs
```

After running `node scripts/build-electron.cjs`, focused smoke launched Electron successfully. The focused smoke then failed later on an existing visual-sweep assertion:

```text
expect(conversationsPanelCount).toBeGreaterThan(0)
Received: 0
```

Relevant context:

- `tests/e2e/smoke.spec.ts` logged multiple stale navigation labels such as missing `aria-label="Bridge Assistant"`, `Swarm Room`, `Operator Console`, etc.
- The app did launch after rebuilding `electron-dist`.
- I fixed the stale failure-log path in `tests/e2e/smoke.spec.ts` from `docs/07-bugs/OPEN.md` to `docs/08-bugs/OPEN.md`.
- `docs/06-test/` is currently untracked from the smoke run; review before committing. It may be generated artifact noise.

## Remaining Work

1. Decide whether to commit generated `docs/06-test/` artifacts or remove/ignore them.
2. Re-run focused Playwright smoke after updating stale navigation selectors or decide to leave BUG-W7-000 as partially verified:
   - Launch timeout did not reproduce after `node scripts/build-electron.cjs`.
   - Visual sweep still has stale expectations unrelated to app launch.
3. Run final status review:

```bash
git status --short
git diff --stat
```

4. Commit the branch.
5. Push `codex/bug-backlog-pr`.
6. Open PR against `main`.
7. Record Ruflo completion with `hooks_post_task` after commit/PR.

## Important Notes For Next Session

- Do not restart from `main`; continue in `/Users/aisigma/projects/SigmaLink-bug-backlog-codex`.
- The worktree is intentionally dirty and contains the current implementation.
- No merge has been done.
- No PR has been created yet.
- `app/pnpm-lock.yaml` exists locally from install but is ignored by repo policy; do not force-add it unless that policy changes.
- Electron tests require:

```bash
cd app
node node_modules/electron/install.js
pnpm run build
node scripts/build-electron.cjs
```

before Playwright smoke.
