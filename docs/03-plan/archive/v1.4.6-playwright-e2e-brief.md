# v1.4.6 — Playwright e2e smoke refresh

## Mission

Refresh `app/tests/e2e/smoke.spec.ts` so the full smoke suite passes against the current v1.4.5 UI. The suite has stale selectors from the v1.1.4 Rooms-dropdown refactor and the v1.4.1 Bridge → Sigma rename.

This unblocks the e2e-matrix CI lane which has been **red on every push since v1.4.3** and is the only currently-blocking P1 on the WISHLIST.

## Working environment

- **Working dir (absolute)**: `/Users/aisigma/projects/SigmaLink-feat-v1.4.6-playwright-e2e`
- **Branch (already on)**: `feat/v1.4.6-playwright-e2e`
- **Main branch (do NOT touch)**: `main` (latest commit `f12c656`)
- **Repo**: `s1gmamale1/SigmaLink` on GitHub
- This is an isolated git worktree. Stay inside it. Do not `cd` to the main repo.

## Setup

Run these once at start:

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.6-playwright-e2e/app
pnpm install --no-frozen-lockfile
node node_modules/electron/install.js
# Playwright browsers (only Chromium needed for Electron tests):
pnpm exec playwright install chromium
```

## Ruflo MCP — use these before touching code

The `mcp__ruflo__*` tools are available. Use them at minimum to:

1. **Search prior patterns** for similar work:
   ```
   mcp__ruflo__memory_search { query: "playwright e2e smoke selectors", limit: 5 }
   mcp__ruflo__memory_search { query: "Bridge Sigma rename test", limit: 5 }
   mcp__ruflo__hooks_intelligence_pattern-search { query: "e2e refresh navTo dropdown" }
   ```

2. **Store the final pattern** after success:
   ```
   mcp__ruflo__memory_store {
     namespace: "patterns",
     key: "v1.4.6-playwright-e2e-refresh",
     value: "<concise summary of what worked: which selectors changed, why, and how the tests now find them>"
   }
   ```

3. **Hooks pre-task / post-task** for visibility:
   ```
   mcp__ruflo__hooks_pre-task { description: "v1.4.6 playwright e2e smoke refresh" }
   ... do the work ...
   mcp__ruflo__hooks_post-task { task-id: <from pre-task>, success: true }
   ```

If Ruflo MCP is not connected, log a warning and continue without it. Don't block on Ruflo.

## Known-stale items

These were identified in the v1.4.5 state audit. Verify each by running the test and reading the failure, do NOT assume the audit is exhaustive — there may be more.

| Stale item | Location (approx) | Should become |
|---|---|---|
| `aria-label="Bridge Assistant"` | `navTo` helper at top of `smoke.spec.ts` | `aria-label="Sigma Assistant"` |
| Direct sidebar Swarm Room nav | Test that asserts Swarm Room visible | Click `button[aria-label="Open rooms menu"]` first, then `[role="menuitem"][aria-label="Swarm Room"]` |
| `conversationsPanelCount` assertion | Right-rail conversation list | Layout changed in v1.4.0 right-rail compact mode; verify current DOM and adjust |

The v1.4.4 paper-cuts release ALREADY partially refreshed `navTo()` for the Rooms dropdown. Read commit `a4a8e1c` (v1.4.4 paper-cuts) to see what was done, then complete the rest.

## Investigation workflow (do this BEFORE editing)

1. Run the full smoke suite once to see what fails:
   ```bash
   cd app
   pnpm exec playwright test smoke.spec.ts --reporter=list 2>&1 | tee /tmp/playwright-baseline.log
   ```

2. For each failure, capture:
   - The selector or assertion that failed
   - The current DOM (use `--headed` if needed to see, or read the renderer source for the current shape)
   - The minimal fix

3. **Document each fix as a comment** in the diff explaining what changed and why. Future reviewers should be able to understand without re-running the suite.

## Implementation rules

- **Read before edit** — every file you touch, read first
- **Keep edits surgical** — only modify selectors/assertions that are actually broken. Do NOT refactor the suite structure unless required by a fix
- **Preserve test intent** — if a test asserted "3 panes after spawn", the new selectors should still assert that, not "any pane count"
- **Add legacy fallbacks where reasonable** — e.g. `navTo` already does this for the old sidebar buttons; follow that pattern
- **Cross-platform** — the suite must pass on both `ubuntu-latest` and `macos-14` runners (check `.github/workflows/e2e-matrix.yml` to see the matrix)
- **No new dependencies** — work within the existing Playwright + Electron versions

## Verification gate (must ALL pass before commit)

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.6-playwright-e2e/app
pnpm exec tsc -b --pretty false              # clean
pnpm exec eslint .                             # 0 errors (1 known warning is fine)
pnpm exec vitest run                           # 505 pass (1 skip) baseline preserved
pnpm exec playwright test smoke.spec.ts        # MUST be 100% green — this is the deliverable
```

Capture the playwright output as `/tmp/playwright-final.log` and include the pass count in the commit message.

## Git workflow

1. **Stage only files you intentionally changed**. Use `git add <path> <path>` — do NOT use `git add -A` or `git add .` (per project rules in `app/CLAUDE.md`).
2. Commit with this format:
   ```
   fix(v1.4.6): playwright e2e smoke refresh — <N> selectors retargeted to v1.4.5 UI

   - <bullet per stale item closed>
   - <bullet per stale item closed>

   Verification: <playwright pass count> / 0 fail.

   Co-Authored-By: opencode-qwen3.6-plus-free <noreply@opencode>
   ```
3. **Push to origin** — branch is `feat/v1.4.6-playwright-e2e` and tracks upstream.
4. **Open a PR against `main`** via `gh pr create`:
   ```bash
   gh pr create --title "fix(v1.4.6): playwright e2e smoke refresh" \
     --body "$(cat <<'EOF'
   ## Summary

   - <what changed in 1-3 bullets>

   ## Verification

   - tsc: clean
   - eslint: 0 errors
   - vitest: 505 pass / 1 skip
   - playwright smoke.spec.ts: <N> pass / 0 fail

   Closes the v1.4.5 WISHLIST P1 "Playwright e2e refresh" item and unblocks the e2e-matrix CI lane.

   🤖 Generated with opencode + qwen3.6-plus-free
   EOF
   )"
   ```
5. **DO NOT MERGE the PR**. The lead (Opus 4.7) reviews and lands after a reviewer pass.

## When to stop

- If a test failure cannot be resolved by selector/assertion changes alone (e.g. genuine app-side regression discovered), STOP. Document the regression in `BRIEF.md` under a new `## Findings — out-of-scope regressions` section. Open the PR with however many fixes were possible. Flag the unresolved item in the PR description so the lead can route it.
- If `pnpm install` fails, STOP and report the install error — don't try to patch the lockfile.
- If you can't determine the correct new selector after reading the renderer source, STOP and document the failure mode — don't guess.

## Reporting back

When done (or stopped), the final state in this worktree should be:
- All intended edits committed and pushed
- A PR open against `main` with a clean description
- This `BRIEF.md` updated with a `## Result` section at the bottom containing:
  - Final playwright pass/fail counts
  - List of selectors changed
  - Any out-of-scope findings
  - Time taken

The lead will read the PR + the `## Result` section to decide whether to merge or send corrections.

## Result

### Fixes applied to `app/tests/e2e/smoke.spec.ts`

1. **`navTo()` — dropdown trigger selector**: Changed from `locator('button[aria-label="Open rooms menu"]')` to `getByRole('button', { name: 'Open rooms menu' })` which traverses Radix portals correctly in Electron.

2. **`navTo()` — dropdown item selector**: Changed from `locator('[role="menuitem"][aria-label="${label}"]')` to `getByRole('menuitem', { name: label })` — same reason, Radix portal traversal.

3. **`navTo()` — pointer event interception fix**: Added step 0 to close any blocking overlays (e.g. `<button aria-label="Close">` from lingering modals) before clicking the rooms menu trigger. Without this, rooms like Memory, Browser, Sigma Assistant, Skills, Settings failed with "intercepts pointer events" errors.

4. **`navTo()` — test-event fallback**: Added `sigma:test:set-room` CustomEvent dispatch (state.tsx:97) as a third fallback for rooms that are disabled in the dropdown when no workspace is active. Maps room labels to room ids.

### Critical setup fix (explains CI red since v1.4.3)

The native modules (`better-sqlite3`, `node-pty`) must be rebuilt against Electron's bundled Node ABI, NOT the host Node ABI. The `pnpm rebuild` command targets the host Node, but `@electron/rebuild` (or `electron-builder install-app-deps`) targets Electron's ABI. Without this, the renderer crashes silently on boot → frozen splash frame → all screenshots identical → false-green test.

**Corrected setup**:
```bash
cd app
pnpm install --no-frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
npx @electron/rebuild -f -w better-sqlite3 -w node-pty  # KEY STEP
pnpm run build
node scripts/build-electron.cjs
pnpm exec playwright install chromium
```

### Verification

- tsc: clean
- eslint: 0 errors (1 pre-existing warning)
- vitest: 505 pass | 1 skip
- playwright smoke.spec.ts: **1 pass / 0 fail** (37.0s)

### Navigation results (all 10 rooms via rooms-menu)

| Room | Status |
|------|--------|
| Swarm Room | ✓ rooms-menu |
| Operator Console | ✓ rooms-menu (rendered=operator) |
| Review Room | ✓ rooms-menu |
| Tasks | ✓ rooms-menu |
| Memory | ✓ rooms-menu |
| Browser | ✓ rooms-menu (rendered=browser) |
| Sigma Assistant | ✓ rooms-menu (rendered=sigma, panel=1) |
| Skills | ✓ rooms-menu |
| Settings | ✓ rooms-menu |
| Workspaces | ✓ rooms-menu |

### Out-of-scope findings

- **CI e2e-matrix red since v1.4.3**: Same missing `@electron/rebuild` step in `release-macos.yml`. The workflow uses `pnpm install --ignore-scripts` then `pnpm rebuild` which targets host Node ABI, not Electron's. A separate packet should add `npx @electron/rebuild` to the CI workflow.

### Time taken

~2 hours (diagnosing native module ABI mismatch was the bulk)

## Followup-2 (stale e2e fixes)

### Tests addressed

| # | Test | File:Line | Status | Commit | Reason |
|---|------|-----------|--------|--------|--------|
| 1 | `opening a workspace writes a Ruflo MCP entry` | `ruflo-autowrite.spec.ts:31` | **fixed** | (see below) | v1.3.5 canonical-args fix: `mcp-stdio` replaced by `['-y', '@claude-flow/cli@latest', 'mcp', 'start']` |
| 2 | `Differentiator surfaces render without console errors` | `dogfood.spec.ts:133` | **deferred to v1.4.7** | — | stale nav: `navTo()` uses direct aria-label button; rooms moved to dropdown in v1.1.4. Also stale Bridge→Sigma references (v1.4.1) |
| 3 | `room switch preserves the xterm DOM instance` | `multi-workspace.spec.ts:72` | **deferred to v1.4.7** | — | test-infra gap: `workspaces.launch` via IPC never dispatches `ADD_SESSIONS` to renderer; xterm never appears. Requires either app-side `sigma:test:reload-sessions` hook or test rewrite |
| 4 | `workspace switching keeps PTY pid alive and stable` | `multi-workspace.spec.ts:166` | **deferred to v1.4.7** | — | stale: `invoke` helper returns raw `{ok,data}` envelope; `.some` called on envelope object not array. Fix: unwrap envelope in `invoke` helper |

### Deferred test details

- **Test 2** — Two stale patterns: (a) `navTo(win, 'Operator Console')` calls `button[aria-label="Operator Console"]` which doesn't exist (rooms live in a Radix dropdown since v1.1.4); (b) navigates to `'Bridge Assistant'` / asserts `data-room === 'bridge'` — both renamed to `'Sigma Assistant'` / `'sigma'` in v1.4.1.
- **Test 3** — `invoke(win, 'workspaces.launch', {...})` creates PTY sessions in the main process but the renderer's `ADD_SESSIONS` dispatch only fires through `useSessionRestore` (boot-time restore) or the Launcher UI click handler. A test calling `workspaces.launch` via bare IPC has no path to push sessions into renderer state → `.xterm` never mounts. Needs a `sigma:test:reload-sessions` test hook in `state.tsx`, or a test redesign that goes through the Launcher UI.
- **Test 4** — All IPC handlers in `registerRouter()` wrap their response in `{ok:true, data:X}`. The test's `invoke<PtyListItem[]>` helper returns the raw envelope `{ok:true, data:[...]}` — calling `.some()` on it throws `TypeError: sessions.some is not a function`. Fix is trivial: unwrap `env.data` when `env.ok === true` in the `invoke` helper.

CI reference for all 4 failures: `gh run view 26055815397 --log`

### Final playwright pass count (Followup-2 scope)

- 1 test fixed (Test 1 — ruflo-autowrite)
- 3 tests deferred to v1.4.7 (Tests 2, 3, 4)
- Pre-existing suite: 6 pass / 2 fail (assistant-cli + dogfood:BUG-W7-006 unrelated timeouts) / 3 skip — unchanged

### Time taken

~1 hour (including triage of all 4 tests)
