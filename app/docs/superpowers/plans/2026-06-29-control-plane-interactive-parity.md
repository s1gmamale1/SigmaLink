# Control Plane Interactive Parity (Phase 2.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SigmaLink's external Control MCP surface usable by an unattended driver — reliable prompt submit, launch auto-approve, capacity force+visibility, non-blocking escalation, codex spawn-race safety, protocol handshake hardening.

**Architecture:** Targeted units in the existing control/assistant layer. Each is a focused file/concern with injected deps; no live Electron, no real `better-sqlite3`. Units 2 & 3 only populate `LaunchPlan` fields the executor already accepts; Units 1/4/5/6 add small helpers + wire them at one chokepoint each. `get_app_state` gains a shared perception surface so the driver can *see* what blocks it.

**Tech Stack:** TypeScript (Electron main), Zod tool schemas, vitest, better-sqlite3 (mocked in tests).

## Global Constraints

- **TS `erasableSyntaxOnly`** — NO constructor parameter properties, enums, or namespaces (TS1294). Declare field + assign in body.
- **No real `better-sqlite3` in tests** (Electron ABI) — use MockDb / fakes.
- **No live Electron** — E2E deferred to `tests/e2e/` in CI. Local gate = `tsc -b` + vitest + lint + build.
- **3-mirror tool parity** — every new tool added to ALL three: `tools.ts` (`TOOLS`/`T()`), `tool-catalogue.ts` (`JORVIS_TOOL_CATALOGUE`), `system-prompt.ts` (`TOOL_BLURB`). Enforced by `tool-catalogue.test.ts`.
- **Authz pin** — every catalogue tool needs a pinned verdict in `authz-external.test.ts` `EXPECTED_VERDICT` (fail-open guard test enforces it).
- **Run the FULL vitest**, not scoped — a new member access on a mocked dep breaks sibling mocks scoped tests miss.
- Commit after each task. NEVER push or tag (lead integrates via sigma-check).

---

### Task 1: Reliable submit (Unit 1, #3)

Replace `prompt_agent`'s single bulk `prompt + '\r'` write with body-write → settle → separate provider-correct Enter, so the trailing Enter lands outside the TUI paste-burst.

**Files:**
- Create: `src/main/core/control/submit-encode.ts` + `submit-encode.test.ts`
- Modify: `src/main/core/assistant/tools.ts` (`prompt_agent` handler, ~`:494-508`)
- Modify: `src/main/core/assistant/tools.test.ts` (the existing `prompt_agent` test, ~`:1099-1113`)

**Interfaces:**
- Produces: `submitByte(providerId: string): string` (default `'\r'`); `submitPrompt(write: (s:string)=>void, providerId: string, prompt: string, opts?: { settleMs?: number; sleep?: (ms:number)=>Promise<void> }): Promise<void>` — writes `prompt`, awaits `sleep(settleMs ?? 80)`, writes `submitByte(providerId)`.
- Consumes (Unit 1): `ctx.pty.write`, `ctx.pty.isLive` (existing).

- [ ] **Step 1: Write the failing test** (`submit-encode.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest';
import { submitByte, submitPrompt } from './submit-encode';

describe('submit-encode', () => {
  it('submitByte defaults to CR for all known providers', () => {
    for (const p of ['claude', 'codex', 'gemini', 'kimi', 'opencode', 'unknown']) {
      expect(submitByte(p)).toBe('\r');
    }
  });

  it('submitPrompt writes body, settles, then writes the submit byte separately', async () => {
    const writes: string[] = [];
    const order: string[] = [];
    const sleep = vi.fn(async () => { order.push('settle'); });
    await submitPrompt((s) => { writes.push(s); order.push(`write:${s === '\r' ? 'CR' : 'body'}`); },
      'claude', 'multi\nline task', { settleMs: 80, sleep });
    expect(writes).toEqual(['multi\nline task', '\r']);
    expect(order).toEqual(['write:body', 'settle', 'write:CR']);
    expect(sleep).toHaveBeenCalledWith(80);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/core/control/submit-encode.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** (`submit-encode.ts`)

```ts
// src/main/core/control/submit-encode.ts
//
// Reliable prompt submit for agent TUIs. A single bulk write of `prompt + '\r'`
// trips the TUI's paste-burst detection (claude/codex buffer it as "[Pasted
// text]" and swallow the trailing CR), so the prompt is typed but never sent.
// We write the body, let it settle into a distinct PTY read, then write the
// submit byte separately. Provider-keyed so a future divergence is one line.

const SUBMIT_BYTE: Record<string, string> = {
  claude: '\r', codex: '\r', gemini: '\r', kimi: '\r', opencode: '\r',
};

export function submitByte(providerId: string): string {
  return SUBMIT_BYTE[providerId] ?? '\r';
}

const DEFAULT_SETTLE_MS = 80;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function submitPrompt(
  write: (s: string) => void,
  providerId: string,
  prompt: string,
  opts?: { settleMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  write(prompt);
  await (opts?.sleep ?? realSleep)(opts?.settleMs ?? DEFAULT_SETTLE_MS);
  write(submitByte(providerId));
}
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Wire into `prompt_agent`** — in `tools.ts`, replace `ctx.pty.write(a.sessionId, a.prompt + '\r')` with provider-aware settle-submit. First confirm how to resolve the session's provider id (grep `resolveSessionProvider` / `providerId` reachable from `ctx`; `app-state.ts` reads `provider_id` from `agent_sessions`). Use it; fall back to `''` (→ CR). Keep the `isLive` guard. The handler stays `async` and `await`s `submitPrompt`, then returns `{ ok: true }`.

```ts
// inside prompt_agent handler, after the isLive guard:
const providerId = ctx.resolveSessionProvider?.(a.sessionId) ?? '';
await submitPrompt((s) => ctx.pty.write(a.sessionId, s), providerId, a.prompt);
return { ok: true };
```

(If `ctx` has no provider resolver, add an optional `resolveSessionProvider?: (sessionId: string) => string | null` to `ToolContext` and inject it in `rpc-router.ts` from the same `SELECT provider_id` used by `classifyExternal` — confirm at `rpc-router.ts:~2475`.)

- [ ] **Step 6: Update the existing `prompt_agent` test** (`tools.test.ts:~1099`) — it currently asserts `writes = [['s1','hi\r']]`. With settle-submit it becomes two writes. Inject a fake `sleep`/no settle in the test harness, and assert ordered writes `['hi', '\r']` (or `[['s1','hi'],['s1','\r']]` per the harness's write shape). Confirm the harness's pty.write capture shape before editing.

- [ ] **Step 7: Run FULL vitest** — `npx vitest run` → all green.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(control): reliable prompt_agent submit (settle + separate Enter)"`

---

### Task 2: Launch auto-approve parity (Unit 2, #4)

`launch_pane` sets `autoApprove` per pane from the workspace Yolo KV default + an optional tool arg. The `LaunchPlan` PaneSpec already carries `autoApprove` (`launcher.ts:501`) — this only populates it.

**Files:**
- Modify: `src/main/core/assistant/tools.ts` (`sLaunchPane` schema `:208-214`; JSON inputSchema + handler `:407-431`)
- Test: `src/main/core/assistant/tools.test.ts` (launch_pane suite)

**Interfaces:**
- Consumes: `ctx.kvGet?.(key)` (existing on `ToolContext`), `ctx.defaultWorkspaceId`.
- KV key (GUI parity, confirm exact string in `Launcher.tsx:~238-251`): `pane.autoApprove.default.<workspaceId>` (value `'1'`/`'true'` → true).
- Produces: resolution `args.autoApprove ?? kvDefault ?? false` applied to every pane.

- [ ] **Step 1: Write the failing test** — drive `launch_pane` with a fake `kvGet` returning `'1'` for the key and assert the `LaunchPlan` passed to a mocked `executeLaunchPlan` has `panes[i].autoApprove === true`; a second case with `kvGet → null` + arg `autoApprove:false` asserts `false`; a third with `kvGet → '1'` + arg `autoApprove:false` asserts the arg wins (`false`). (Mock `executeLaunchPlan` to capture the plan — confirm how the existing launch_pane test stubs it.)

```ts
it('launch_pane threads workspace Yolo KV default into autoApprove', async () => {
  const plans: any[] = [];
  // ...mock executeLaunchPlan to push(plan) and return { sessions: [] }...
  const ctx = makeCtx({ kvGet: (k) => (k === 'pane.autoApprove.default.ws1' ? '1' : null),
                        defaultWorkspaceId: 'ws1' });
  await invoke('launch_pane', { workspaceRoot: '/x', provider: 'claude' }, ctx);
  expect(plans[0].panes[0].autoApprove).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (autoApprove undefined/false).

- [ ] **Step 3: Implement** — add to `sLaunchPane`: `autoApprove: z.boolean().optional(), forceRamBrake: z.boolean().optional()` (forceRamBrake belongs to Task 3 but add both schema fields here to avoid a second schema edit; only wire autoApprove in this task). Add both to the JSON inputSchema `properties`. In the handler resolve:

```ts
const wsId = ctx.defaultWorkspaceId;
const kvYolo = wsId ? (ctx.kvGet?.(`pane.autoApprove.default.${wsId}`) ?? null) : null;
const autoApprove = a.autoApprove ?? (kvYolo === '1' || kvYolo === 'true');
```

and set `autoApprove` on each pane object in the `panes:` map.

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Run FULL vitest** — green.
- [ ] **Step 6: Commit** — `feat(control): launch_pane honors workspace Yolo KV + autoApprove arg`

---

### Task 3: Capacity parity (Unit 3, #2)

Wire the `forceRamBrake` arg (schema added in Task 2) into the plan, and add a `capacity` block to `get_app_state`.

**Files:**
- Modify: `src/main/core/assistant/tools.ts` (`launch_pane` handler — set `plan.forceRamBrake`)
- Modify: `src/main/core/control/app-state.ts` (`buildAppState` — add `capacity`)
- Modify: `src/main/core/control/app-state.test.ts`
- Read first: `launcher.ts:185-188` (confirms admission reads `plan.forceRamBrake`); `ram-brake/admission.ts` (`readRamBrakeCaps`, `countLive` — exported? confirm import path).

**Interfaces:**
- Produces in snapshot: `capacity: { liveAgents:number; cap:number; workspaceLiveAgents:number; workspaceCap:number; headroom:number }`.

- [ ] **Step 1: Write the failing test (forceRamBrake)** — drive `launch_pane` with `forceRamBrake:true`, assert the captured plan has `forceRamBrake === true`; default (absent) → `undefined`/`false`.
- [ ] **Step 2: Implement forceRamBrake** — set `forceRamBrake: a.forceRamBrake === true` on the `LaunchPlan` object in the handler.
- [ ] **Step 3: Write the failing test (capacity)** — in `app-state.test.ts`, seed a MockDb with N `agent_sessions` in `('starting','running')` + a KV cap override; assert `snapshot.capacity` = `{ liveAgents:N, cap, workspaceLiveAgents, workspaceCap, headroom: cap-N }`. Follow the existing app-state.test MockDb pattern.
- [ ] **Step 4: Implement capacity in `buildAppState`** — import `readRamBrakeCaps` + `countLive` (or replicate the COUNT query if `countLive` is not exported); compute the block defensively (a query failure degrades to `cap`/`liveAgents` best-effort, never throws — matches §9 of the spec).
- [ ] **Step 5: Run to verify both pass.**
- [ ] **Step 6: Run FULL vitest** — green.
- [ ] **Step 7: Commit** — `feat(control): forceRamBrake on launch_pane + capacity in get_app_state`

---

### Task 4: Non-blocking escalation + check_escalation (Unit 4, #6)

For `origin:'external'`, an escalate-class tool returns `{ ok:false, status:'needs_approval', escalationId }` immediately instead of blocking 60s. Operator approval records a one-shot grant; a re-issued call consumes it. `get_app_state` lists pending escalations; a new `check_escalation` tool reports the decision.

**Files:**
- Create: `src/main/core/control/pending-escalations.ts` + test (pending map + one-shot grant store keyed by `toolName+argsHash, clientLabel`, TTL 120s; injected clock).
- Modify: `src/main/core/assistant/controller.ts` (the escalate branch, ~`:255-281`) — when `origin==='external'`: register pending + return `needs_approval` instead of awaiting `confirmDangerous` for 60s.
- Modify: `src/main/core/control/authz-external.ts` — `classifyExternal` consults the grant store (matching unconsumed grant → FREE, consume on use). Read first: `authz-external.ts:43-52` for the exact signature.
- Modify: `src/main/core/control/app-state.ts` — add `pendingEscalations: [{id,tool,summary,requestedAt}]`.
- Add tool: `check_escalation` in `tools.ts` + `tool-catalogue.ts` + `system-prompt.ts` (3-mirror); pin FREE in `authz-external.test.ts`.
- Wire: the operator approve/deny path (`control-rpc.respondEscalation` / `escalation.ts`) records the grant + resolves the pending entry. Read first: `escalation.ts:37-98`, `rpc-router.ts:841-844`.

**Interfaces:**
- `pending-escalations.ts` exports: `registerEscalation(input): { id }`, `resolveEscalation(id, approved)`, `consumeGrant(toolName, argsHash, clientLabel): boolean`, `listPending(): PendingEscalation[]`, `checkEscalation(id): 'pending'|'approved'|'denied'|'expired'`. Inject `now()`.
- `check_escalation` tool args: `{ escalationId: string }` → `{ status }`.

- [ ] **Step 1: Write the failing test (pending-escalations.ts)** — register → `checkEscalation` = `pending`; `resolveEscalation(id,true)` → `approved` + a matching `consumeGrant` returns true ONCE then false; TTL expiry (advance fake clock) → `expired`; deny → `denied`.
- [ ] **Step 2: Run → fails. Step 3: Implement pending-escalations.ts** (Map + grant Map with `{expiresAt, consumed}`; pure, clock injected).
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Write the failing test (non-blocking branch)** — in the controller/authz test, an `origin:'external'` escalate-class call returns `{ok:false, status:'needs_approval', escalationId}` synchronously (fake clock, NO 60s wait); a subsequent call with a recorded grant passes (verdict FREE); `origin:'local'` still blocks/awaits (unchanged). Confirm the existing `controller-external-gate.test.ts` patterns.
- [ ] **Step 6: Implement** the controller external branch + `classifyExternal` grant consult + `check_escalation` tool (3-mirror) + `pendingEscalations` in app-state + the approve-path grant write.
- [ ] **Step 7: Pin `check_escalation` FREE** in `authz-external.test.ts EXPECTED_VERDICT`; update `tool-catalogue.test.ts` expectations if it counts tools.
- [ ] **Step 8: Run FULL vitest** — green (catalogue parity + authz membership included).
- [ ] **Step 9: Commit** — `feat(control): non-blocking external escalation + check_escalation`

---

### Task 5: Codex spawn safety (Unit 5, #1)

Serialize codex spawns against the shared `CODEX_HOME` so concurrent launches can't race the single-use OAuth refresh; scan codex PTY output for auth errors and surface them.

**Files:**
- Create: `src/main/core/control/codex-spawn-lock.ts` + test — a promise-chain async mutex keyed by resolved `CODEX_HOME` (default `~/.codex`). `withCodexSpawnLock(home, fn, opts?)` holds until `fn` resolves OR a cap (`maxHoldMs`, default 4000) elapses.
- Create: `src/main/core/pty/auth-error-scan.ts` + test — `scanCodexAuthError(chunk: string): { kind: 'token_expired'|'refresh_reused'|'unauthorized' } | null` matching `token_expired` / `refresh token already used` / `HTTP 401`.
- Modify: the codex spawn chokepoint. Read first: `providers/launcher.ts` `resolveAndSpawn` + `local-pty.ts:495-614` to find the one place all three spawn paths funnel through; wrap codex (`providerId==='codex'`) spawns in `withCodexSpawnLock`. Non-codex unaffected.
- Modify: `src/main/core/pty/registry.ts` (`onData` ~`:326-353`) — for codex panes, run `scanCodexAuthError`; on hit set `dbStatus:'error'` + emit `pty:error` (reuse the existing crash `pty:error` broadcast path, confirm at `registry.ts:356-371`) and record an `authError` for the session.
- Modify: `src/main/core/control/app-state.ts` — per-session `authError: { kind, atMs } | null`.

**Interfaces:**
- `withCodexSpawnLock(home: string, fn: () => Promise<T>, opts?: { maxHoldMs?: number; now?: ()=>number }): Promise<T>`
- `scanCodexAuthError(chunk: string): CodexAuthError | null`

- [ ] **Step 1: Write the failing test (lock)** — two overlapping `withCodexSpawnLock(home, fn)` where `fn` records start order under a shared flag; assert the second starts only after the first releases; a DIFFERENT home runs concurrently; `maxHoldMs` releases a hung holder (fake clock).
- [ ] **Step 2: → fails. Step 3: Implement the mutex** (per-home promise chain).
- [ ] **Step 4: → passes.**
- [ ] **Step 5: Write the failing test (scanner)** — `token_expired` line → `{kind:'token_expired'}`; `refresh token already used` → `refresh_reused`; `HTTP 401` → `unauthorized`; benign output → null.
- [ ] **Step 6: → fails. Step 7: Implement the scanner** (regexes, no false positives on ordinary text — anchor on the known phrases).
- [ ] **Step 8: Wire** the lock at the codex spawn chokepoint and the scanner into `registry.onData` (codex panes only) + `authError` into app-state. Add/extend a registry test asserting a seeded `token_expired` chunk flips status + populates `authError`; a non-codex spawn is NOT serialized.
- [ ] **Step 9: Run FULL vitest** — green. (This touches the hot spawn path — re-gate carefully.)
- [ ] **Step 10: Commit** — `fix(control): serialize codex spawns + surface codex auth errors`

---

### Task 6: Protocol handshake hardening (Unit 6, drift)

Host validates `control.hello`'s `protocol` against a supported range and serves only the external-allowlisted tool subset in `tools.list`.

**Files:**
- Modify: `src/main/core/control/control-mcp-host.ts` (`control.hello` handler `:135-148`; `tools.list` `:161-163`).
- Modify: wherever `getCatalogue` is provided (`rpc-router.ts:853`) OR filter inside the host using an injected allowlist predicate.
- Read first: `authz-external.ts` for the external verdict allowlist (source of "which tools are external-callable").

**Interfaces:**
- Host opts gain `minProtocol`/`maxProtocol` (default `[1,1]`) and `isExternalTool?: (name:string)=>boolean` (or filter `getCatalogue()` to entries whose name has a pinned external verdict).

- [ ] **Step 1: Write the failing test** — a `control.hello` with `protocol: 2` (above max) is rejected with a clear error; `protocol: 1` and absent are accepted; `tools.list` excludes a catalogue entry with no external verdict and includes pinned ones. Extend `control-mcp-host.test.ts`.
- [ ] **Step 2: → fails. Step 3: Implement** the `protocol` read + range check in the hello handler (out-of-range → `{error:{code:-32003, message:'protocol vN unsupported; host accepts [MIN,MAX]'}}` + destroy); below MIN treated as floor warn-and-proceed only if ≥ a hard floor. Filter `tools.list` to the external subset.
- [ ] **Step 4: → passes. Step 5: Run FULL vitest** — green.
- [ ] **Step 6: Commit** — `feat(control): validate handshake protocol + filter external tool catalogue`

---

## Self-Review

- **Spec coverage:** Units 1-6 + the three `get_app_state` additions (capacity→Task 3, pendingEscalations→Task 4, authError→Task 5) each map to a task. Deferred §10 items are wishlisted, not tasked. ✅
- **Type consistency:** `submitByte`/`submitPrompt` (Task 1) names match across def+use; `autoApprove`/`forceRamBrake` reuse the existing `LaunchPlan` fields (no new types); `check_escalation` + `pending-escalations` exports consistent across Tasks 4. ✅
- **Read-first anchors** are intentional where I did not read every line (provider resolver in T1, executeLaunchPlan stub shape in T2, classifyExternal/escalation in T4, spawn chokepoint + onData in T5, external allowlist in T6) — implementers confirm the exact signature at the cited file:line before editing. This is deliberate (anti-fabrication), not a placeholder.

## Execution order
T1+T2 first (unblock basic driving), then T3+T4, then T5 (hot path, isolate), then T6. Each on the `feat/control-interactive-parity` branch (or per-task worktree if fanning out). Re-gate in MAIN after merge.
