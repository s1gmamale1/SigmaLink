# Packet 02 — Deferred e2e fixes from PR #36 Followup-2

> **Effort**: S (~4hr). **Tier**: P1 (CI). **Delegate**: Sonnet (self).
> **Blocks**: nothing. **Blocked by**: nothing.

## Problem

PR #36 Followup-2 (merged as `9211385`) fixed 1 of 4 stale Playwright e2e tests and explicitly deferred 3 tests to v1.4.7 with full triage. This packet closes those 3.

Per-test classification + fix approach were already documented in PR #36's `BRIEF.md ## Followup-2` section. Re-stated here with concrete code for the delegate.

## Failing tests

### Test 2 — `app/tests/e2e/dogfood.spec.ts:133` (STALE)

**Symptom**: `expect(await navTo(win, 'Operator Console')).toBe(true)` returns `false`.

**Root cause**: Two stale patterns from older releases:
1. The local `navTo()` helper (line 115-125 of `dogfood.spec.ts`) uses `button[aria-label="${label}"]` — but rooms moved into a Radix dropdown in v1.1.4. Direct sidebar buttons no longer exist for these labels.
2. Test body (line 201, 206) navigates to `'Bridge Assistant'` and asserts `data-room === 'bridge'`. v1.4.1 renamed Bridge → Sigma: label is now `'Sigma Assistant'`, room id is `'sigma'`.

**Fix**:

Replace the `navTo` helper in `dogfood.spec.ts` with the same 3-step strategy from `smoke.spec.ts:43` (verified working in v1.4.6 packet #02):

```typescript
// v1.4.7 — rooms are in the top-bar Radix DropdownMenu (since v1.1.4),
// not sidebar buttons. Same 3-step strategy as smoke.spec.ts navTo helper.
async function navTo(win: Page, label: string): Promise<boolean> {
  // 0. Close any blocking overlays first.
  try {
    const closeBtn = win.locator('button[aria-label="Close"]').first();
    if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await closeBtn.click({ timeout: 1000 }).catch(() => undefined);
      await win.waitForTimeout(200);
    }
  } catch { /* ignore */ }

  // 1. Rooms dropdown (v1.1.4+ layout).
  try {
    const trigger = win.getByRole('button', { name: 'Open rooms menu' });
    if (await trigger.isVisible({ timeout: 3000 }).catch(() => false)) {
      await trigger.click({ timeout: 3000 });
      await win.waitForTimeout(300);
      const item = win.getByRole('menuitem', { name: label });
      if (await item.isVisible({ timeout: 3000 }).catch(() => false)) {
        await item.click({ timeout: 3000 });
        await win.waitForTimeout(500);
        return true;
      }
      await win.keyboard.press('Escape').catch(() => undefined);
    }
  } catch { /* fall through */ }

  // 2. sigma:test:set-room event fallback (state.tsx hook).
  const labelToId: Record<string, string> = {
    'Swarm Room': 'swarm',
    'Operator Console': 'operator',
    'Review Room': 'review',
    Tasks: 'tasks',
    Memory: 'memory',
    Browser: 'browser',
    'Sigma Assistant': 'sigma',
    Skills: 'skills',
    Settings: 'settings',
    Workspaces: 'workspaces',
    'Command Room': 'command',
  };
  const roomId = labelToId[label];
  if (roomId) {
    try {
      await win.evaluate((room: string) => {
        window.dispatchEvent(new CustomEvent('sigma:test:set-room', { detail: { room } }));
      }, roomId);
      await win.waitForTimeout(500);
      const rendered = await win
        .evaluate(() => document.body.getAttribute('data-room') ?? 'unknown')
        .catch(() => 'unknown');
      if (rendered === roomId) return true;
    } catch { /* fall through */ }
  }

  // 3. Legacy sidebar button fallback.
  const btn = win.locator(`button[aria-label="${label}"]`);
  if ((await btn.count()) === 0) return false;
  try {
    await btn.first().click({ timeout: 3000, force: true });
    await win.waitForTimeout(400);
    return true;
  } catch {
    return false;
  }
}
```

Also update lines 201 + 206:
```typescript
// v1.4.1: Bridge → Sigma rename. Room id is now 'sigma', label 'Sigma Assistant'.
expect(await navTo(win, 'Sigma Assistant')).toBe(true);  // was 'Bridge Assistant'
await win.waitForTimeout(800);
const bridgeRoom = await win
  .evaluate(() => document.body.getAttribute('data-room') ?? 'unknown')
  .catch(() => 'unknown');
expect(bridgeRoom).toBe('sigma');  // was 'bridge'
```

The `data-testid="bridge-conversations-panel"` on the conversations panel (line 208) is INTENTIONALLY preserved — `ConversationsPanel.tsx` in `app/src/renderer/features/sigma-assistant/` retains that testid for backwards compatibility. Do NOT change this assertion.

**Verification**: `pnpm exec playwright test app/tests/e2e/dogfood.spec.ts --grep "Differentiator" --reporter=list`. Expect 1 pass.

---

### Test 3 — `app/tests/e2e/multi-workspace.spec.ts:72` (TEST INFRA)

**Symptom**: `expect.poll(() => document.querySelectorAll('.xterm').length).toBeGreaterThan(0)` times out at 10s.

**Root cause**: The test calls `workspaces.launch` via IPC which creates PTY sessions in the main process and inserts `agent_sessions` rows. But the renderer's `state.sessions` is NEVER updated because `ADD_SESSIONS` is only dispatched from three places:
1. `useSessionRestore` after `panes.resume` resolves (boot-time only; ref clears after first run)
2. `Sidebar.tsx` workspace-reopen click handler
3. `Launcher.tsx` after `rpc.workspaces.launch` resolves (UI flow, not IPC)
4. `CommandRoom.tsx` after `swarms.addAgent` (single-pane spawn)

A test calling `workspaces.launch` via raw `sigma.invoke()` has no path to push sessions into renderer state → `.xterm` never mounts.

**Fix (TWO PARTS)**:

#### Part A — Add `invoke()` envelope unwrapping to multi-workspace.spec.ts

The IPC handler in `registerRouter()` wraps every response in `{ok:true, data:X}`. The test's `invoke<T>` helper at line 19-29 returns the raw envelope. Add envelope unwrapping (same logic as `rpc.ts:16-29`):

```typescript
async function invoke<T>(win: Page, channel: string, ...args: unknown[]): Promise<T> {
  const raw = await win.evaluate(
    async ({ rpcChannel, rpcArgs }) => {
      const sigma = (window as unknown as {
        sigma: { invoke: (channelName: string, ...channelArgs: unknown[]) => Promise<unknown> };
      }).sigma;
      return sigma.invoke(rpcChannel, ...rpcArgs);
    },
    { rpcChannel: channel, rpcArgs: args },
  );
  if (raw && typeof raw === 'object' && 'ok' in (raw as Record<string, unknown>)) {
    const env = raw as { ok: boolean; data?: unknown; error?: string };
    if (env.ok) return env.data as T;
    throw new Error(env.error ?? `${channel} failed`);
  }
  return raw as T;
}
```

This single fix closes Test 4 (`multi-workspace.spec.ts:166`) completely.

#### Part B — Add a `sigma:test:reload-sessions` hook to `state.tsx`

Modify `app/src/renderer/app/state.tsx` to add a new test-only event handler that calls `panes.listForWorkspace` for the active workspace and dispatches `ADD_SESSIONS`. Mirror the existing `sigma:test:activate-workspace` and `sigma:test:set-room` patterns (state.tsx:69-99):

```typescript
// v1.4.7 — Test-only hook for e2e tests that call workspaces.launch via
// IPC. The renderer's ADD_SESSIONS dispatch only fires through useSessionRestore
// (boot-time) or the Launcher UI, so an IPC-only launch path has no way to
// surface the new sessions in renderer state. This event closes that gap.
useEffect(() => {
  const handler = async () => {
    const wsId = state.activeWorkspace?.id;
    if (!wsId) return;
    try {
      const sessions = await rpc.panes.listForWorkspace(wsId);
      if (sessions.length > 0) {
        dispatch({ type: 'ADD_SESSIONS', sessions });
      }
    } catch {
      /* test harness: swallow */
    }
  };
  window.addEventListener('sigma:test:reload-sessions', handler as EventListener);
  return () => window.removeEventListener('sigma:test:reload-sessions', handler as EventListener);
}, [state.activeWorkspace?.id]);
```

NOTE: this is the ONLY app-code touch in packet #02. It's a 13-line addition mirroring an existing test-event pattern with the same `// no-op in production` semantic. Acceptable.

Then in the test, after `workspaces.launch`:

```typescript
await invoke(win, 'workspaces.launch', { workspaceRoot: wsA, preset: 1, panes: [...] });

// v1.4.7 — push the newly-launched sessions into renderer state.
await win.evaluate(() => {
  window.dispatchEvent(new CustomEvent('sigma:test:reload-sessions'));
});
await win.waitForTimeout(500);

await expect
  .poll(() => win.evaluate(() => document.querySelectorAll('.xterm').length), { timeout: 10_000 })
  .toBeGreaterThan(0);
```

**Verification**: `pnpm exec playwright test app/tests/e2e/multi-workspace.spec.ts --reporter=list`. Expect 2 pass.

---

### Test 4 — `app/tests/e2e/multi-workspace.spec.ts:166` (STALE)

**Symptom**: `TypeError: sessions.some is not a function`.

**Root cause**: `pty.list` returns `{ok:true, data: PtyListItem[]}` (IPC envelope) but the test calls `.some()` on the envelope object.

**Fix**: Already covered by Part A of Test 3's fix above. Once the `invoke()` helper unwraps envelopes, this test passes.

**Verification**: Covered by Test 3 run.

---

## Files to touch

- `app/tests/e2e/dogfood.spec.ts` — replace `navTo()` helper + 2 inline string updates
- `app/tests/e2e/multi-workspace.spec.ts` — update `invoke()` helper + add reload-sessions event
- `app/src/renderer/app/state.tsx` — add `sigma:test:reload-sessions` handler (13 LOC)
- `app/src/renderer/app/state.test.ts` — add unit test for the new event handler (optional but recommended)

## Files NOT to touch
- Any other test file
- Any `app/src/main/**` file (these test fixes are renderer-only)
- The conversations panel's `bridge-conversations-panel` testid

## Verification gate

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false              # clean
pnpm exec eslint .                            # 0 errors, ≤1 pre-existing warning
pnpm exec vitest run                          # 505 pass | 1 skip baseline preserved
pnpm exec playwright test tests/e2e/ --reporter=list 2>&1 | tee /tmp/playwright-v1.4.7-final.log
# Expected: dogfood Differentiator + both multi-workspace tests now PASS
# (assistant-cli:27 + dogfood:357 still fail — those are packet #03 scope)
```

## Reporting back

Open a PR titled `fix(v1.4.7): close 3 deferred e2e tests from PR #36 Followup-2`. PR body should include:
- Per-test root cause + fix summary
- Before/after pass counts: was 1 pass / 3 fail (packet scope) → now 4 pass / 0 fail
- Confirmation that `pnpm exec vitest run` baseline (505+1 skip) is unchanged
