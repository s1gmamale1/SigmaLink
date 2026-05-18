# Packet 03 — Pre-existing e2e timeouts (assistant-cli:27 + dogfood:357)

> **Effort**: M (~6-8hr investigation + fix). **Tier**: P1 (CI). **Delegate**: Sonnet (self).
> **Blocks**: nothing. **Blocked by**: nothing (can run parallel with #02).

## Problem

Two e2e tests have been failing on `main` since at least v1.4.5 — unrelated to PR #36's Followup-2 work but blocking the goal of "all 11 e2e tests pass". Both manifest as hard timeouts (not assertion failures) which makes them especially noisy in CI logs.

## Failing tests

### Test 5 — `app/tests/e2e/assistant-cli.spec.ts:27` ("Sigma Assistant streams a real Claude CLI reply")

**Symptom**:
```
TimeoutError: locator.fill: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('textarea, [contenteditable="true"]').last()

    78 |       .filter({ hasText: '' })
    79 |       .last();
  > 80 |     await composer.fill("what's 2 + 2?");
```

**Hypothesis (needs read of current SigmaRoom DOM to confirm)**: The selector `locator('textarea, [contenteditable="true"]').last()` was authored before the v1.4.1 SigmaRoom split (922 → 283 LOC + 9 hooks + 5 sub-components). The new SigmaRoom has multiple text-input regions:
- Pattern ribbon (`PatternRibbon.tsx`)
- Composer textarea (`Composer.tsx` — the actual target)
- Possibly a search input on `SigmaRailDropdown.tsx`
- Possibly conversation-rename inputs in `ConversationsPanel.tsx`

`.last()` no longer reliably picks the active composer.

### Investigation steps

1. Run the test in headed mode:
   ```bash
   cd /Users/aisigma/projects/SigmaLink/app
   pnpm exec playwright test tests/e2e/assistant-cli.spec.ts --headed --debug
   ```
2. Inspect the DOM at the point of failure: which elements match the selector?
3. Read `app/src/renderer/features/sigma-assistant/SigmaRoom.tsx` + `Composer.tsx` to find a unique selector for the composer (likely a `data-testid="sigma-composer"` if one exists; if not, add one in the same PR).
4. Replace the selector. Add a `data-testid` to the composer if needed (small touch in `app/src/renderer/features/sigma-assistant/Composer.tsx` — single attribute).

### Fix sketch

If composer has no testid today, add one:
```tsx
// app/src/renderer/features/sigma-assistant/Composer.tsx
<textarea
  data-testid="sigma-composer"
  // ... existing props
/>
```

Then the test:
```typescript
const composer = win.locator('[data-testid="sigma-composer"]');
await composer.waitFor({ state: 'visible', timeout: 10_000 });
await composer.fill("what's 2 + 2?");
await composer.press('Enter');
```

### Risk

This test ALSO requires a real Claude CLI installed on the runner. The `manual smoke:` describe block (line 3-6 of `assistant-cli-launch-pane.spec.ts`) is skipped by default; check whether `assistant-cli.spec.ts:27` should ALSO be in a `manual:` describe so it skips in CI when Claude CLI is missing. If yes, wrap the test:

```typescript
test.skip(
  process.env.SIGMA_E2E_CLAUDE !== '1',
  'Set SIGMA_E2E_CLAUDE=1 to run this test (requires claude CLI in PATH)',
);
```

Either fix the selector OR gate the test — choose based on whether CI has Claude installed (check `.github/workflows/e2e-matrix.yml` — currently it does NOT install claude CLI). Gating is the right answer for CI; selector fix is the right answer for local dev. Do both.

---

### Test 6 — `app/tests/e2e/dogfood.spec.ts:357` ("BUG-W7-006: swarms.create after workspaces.open has no race")

**Symptom**:
```
Test timeout of 180000ms exceeded.
Error Context: test-results/dogfood-dogfood-v1-BUG-W7--22121-workspaces-open-has-no-race/error-context.md
```

3-minute hard timeout. No assertion error in the test log → something hangs.

**Hypothesis**: The test calls `swarms.create` immediately after `workspaces.open` to verify there's no race between workspace open and swarm creation (BUG-W7-006). Something in the v1.4.x line introduced a hang in this exact sequence:

- v1.4.3 added orphan worktree cleanup on workspace open (`worktree-cleanup.ts`)
- v1.4.5 added `proper-lockfile` advisory locking around `projects.json` writes
- The 3-min timeout suggests the hang is filesystem or lock-related

### Investigation steps

1. Confirm the test passed pre-v1.4.3 by checking out an earlier ref:
   ```bash
   git stash; git checkout 73270b9; cd app; pnpm install --no-frozen-lockfile --ignore-scripts; node node_modules/electron/install.js; npx @electron/rebuild -f -w better-sqlite3 -w node-pty; pnpm run build; node scripts/build-electron.cjs; pnpm exec playwright test tests/e2e/dogfood.spec.ts --grep "BUG-W7-006" --reporter=list
   ```
   If it passes on v1.4.3, bisect forward.
2. Reproduce locally with `--debug` to see exactly where the test hangs.
3. Look at main-process logs (`app.console.on('message')`) during the hang — the renderer should emit something useful via `console.error` or `electron-log`.
4. Most likely root cause is `cleanupOrphanWorktrees()` in `worktree-cleanup.ts` taking very long, OR the `proper-lockfile` lock retry exhausting all 5 attempts. Both surface as silent hangs.

### Fix sketch

If `cleanupOrphanWorktrees` is the culprit: add a fast-path skip when there are zero historical sessions for the workspace (cold-install guard). Already noted as a safety in v1.4.3 #04's brief but may not be implemented.

If lockfile is the culprit: reduce the retry count + stale-recovery window during tests (gate on `process.env.NODE_ENV === 'test'`).

If neither: the hang is in `swarms.create` itself. Check the SQL transaction; better-sqlite3 transactions are synchronous and shouldn't hang.

### Risk

This test may surface a real app-side regression. If so:
- Document the regression in `docs/08-bugs/OPEN.md` as BUG-V1.4-XXX
- Add a fix to this packet (broaden scope)
- Update WISHLIST to reflect the new bug

If the regression is real and large, escalate to a separate packet (#03b) and ship the rest of v1.4.7 without this fix; quarantine the test via `test.skip` with a pointer to the bug ID.

---

## Files to touch (likely)

- `app/tests/e2e/assistant-cli.spec.ts` — selector tightening
- `app/src/renderer/features/sigma-assistant/Composer.tsx` — add `data-testid` (XS)
- `app/tests/e2e/dogfood.spec.ts` — possibly `test.skip` gate
- `app/src/main/core/workspaces/worktree-cleanup.ts` — if cleanup is the hang
- `app/src/main/core/workspaces/launcher.ts` — if `swarms.create` race is real

## Verification gate

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec playwright test tests/e2e/assistant-cli.spec.ts --reporter=list
# Either passes (if Claude CLI available) or skips with documented reason

pnpm exec playwright test tests/e2e/dogfood.spec.ts --grep "BUG-W7-006" --reporter=list
# Passes, or test.skip'd with pointer to a tracked bug ID
```

End-state: full e2e suite is **11 pass / 0 fail / N skip** (where skip count is documented in the test file).

## Reporting back

Open a PR titled `fix(v1.4.7): close pre-existing e2e timeouts — assistant-cli + dogfood BUG-W7-006`. If a real app regression is discovered, the PR title should reflect that (e.g. `fix(v1.4.7): orphan worktree cleanup hangs on cold install`).
