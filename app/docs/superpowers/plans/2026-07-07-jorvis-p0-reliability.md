# Jorvis P0 — Reliability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jorvis trustworthy day-to-day — no silent turn deaths, no second `claude` child from a double-send, a distinct error surface with retry, envelope parsing that survives CLI updates, and a one-action fresh session — plus the low-risk 2026-07-07 recon fixes.

**Architecture:** All changes are bounded edits to the EXISTING assistant turn engine (`app/src/main/core/assistant/`), its renderer state hook (`app/src/renderer/features/jorvis-assistant/`), the Telegram bridge (`app/src/main/core/remote/`), and the RPC channel/schema mirrors. No new modules, no new model-spawning path. Everything rides the current `assistant.send` / `assistant:state` plumbing.

**Tech Stack:** TypeScript (Electron main + React renderer), Vitest, Drizzle/better-sqlite3 (main; tests use MockDb/DI — never `new Database()` under vitest), esbuild bundling. `erasableSyntaxOnly` is ON — no `constructor(private x)`, no enums, no namespaces.

## Global Constraints

- **Files stay under ~500 lines.** If a target file would cross it, split by responsibility.
- **Read before edit.** Every file is Read in-session before any Edit.
- **erasableSyntaxOnly (TS1294):** declare a field then assign in the constructor; never parameter-properties, enums, or namespaces.
- **DB code is DI/MockDb-tested** — better-sqlite3 will not load under vitest (Electron ABI). Never call `new Database()` in a test; use the existing fake/MockDb pattern.
- **RPC/event mirror discipline:** a new RPC channel touches `shared/rpc-channels.ts` (CHANNELS) + `shared/router-shape.ts` (AppRouter) + `main/rpc-router.ts` (handler) + `main/core/rpc/schemas.ts` (schema) + `shared/rpc-channels.test.ts` (TYPED_ROUTER_CHANNELS/SIDE_BAND_CHANNELS). A new EVENT touches the `EVENTS` set + the membership test. Grep the twins.
- **Local gate before any "done":** `npx tsc -b`, `npx vitest run <touched>` then a full `npx vitest run`, `npx eslint .` (max-warnings 0), `npm run build`. Run from `app/`.
- **No push, no tag, no release.** Land commits on the working branch; integration + release are the operator's.
- **Origin semantics unchanged:** `local` is full-trust; `telegram`/`external` keep their gates. New behavior must not gate `local`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `app/src/main/core/assistant/controller.ts` | add per-conversation in-flight guard to `send` | 1 |
| `app/src/main/core/assistant/controller.busy-guard.test.ts` | guard unit tests (new) | 1 |
| `app/src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.ts` | consume `kind:'error'` → error row + clear busy | 2 |
| `app/src/renderer/features/jorvis-assistant/ChatTranscript.tsx` | render an `error`-role row (distinct styling) | 2 |
| `app/src/renderer/features/jorvis-assistant/JorvisRoom.tsx` | show a Retry affordance on the last errored turn | 2 |
| `app/src/main/core/assistant/cli-envelope.ts` | tolerate unknown subtypes; add `classifyEnvelope` helper | 3 |
| `app/src/main/core/assistant/cli-envelope.test.ts` | envelope + recorded-fixture contract tests (new) | 3 |
| `app/src/main/core/assistant/__fixtures__/cli-envelopes/*.jsonl` | recorded CLI stream fixtures (new) | 3 |
| `app/src/main/diagnostics-log.ts` (or the boot log path) | log resolved `claude --version` at boot | 3 |
| `app/src/main/core/assistant/conversations.ts` | `clearClaudeSessionId` (keep transcript) | 4 |
| `app/src/main/rpc-router.ts` | `assistant.newSession` RPC wiring | 4 |
| `app/src/shared/rpc-channels.ts` / `router-shape.ts` / `core/rpc/schemas.ts` / `rpc-channels.test.ts` | mirror `assistant.newSession` | 4 |
| `app/src/renderer/features/jorvis-assistant/JorvisRoom.tsx` | "New session (keep history)" action | 4 |
| `app/src/main/core/remote/bridge.ts` | `/new` Telegram command | 4 |
| `app/src/main/core/assistant/controller.ts` (`:189`) + `shared/rpc-channels.ts` EVENTS | wire-or-delete `assistant:security` | 5 |
| `app/src/main/core/rpc/schemas.ts` (`:952-955`) | add `assistant.conversations.resumeHint` schema stub | 5 |
| `app/src/main/core/assistant/controller.ts` (`refResolve` `:780-839`) | route the walk through `path-guard` | 5 |
| comments in `controller.ts:60-64`, `authorization.test.ts:87` | stale-fact fixes | 5 |
| `docs/03-plan/WISHLIST.md` (repo `docs/`, the stale twin) | archive/remove | 5 |

---

## Task 1: Per-conversation concurrent-turn guard (main-side)

**Files:**
- Modify: `app/src/main/core/assistant/controller.ts` (the `send` closure at `:422-544`; `activeTurns` at `:178`)
- Test: `app/src/main/core/assistant/controller.busy-guard.test.ts` (create)

**Interfaces:**
- Consumes: `activeTurns: Map<string, ActiveTurn>` where `ActiveTurn = { conversationId, turnId, cancelled }` (`controller.ts:178`).
- Produces: `send` now resolves `{ conversationId, turnId, busy?: boolean }`. When a live turn already exists for the resolved `conversationId`, `send` returns `{ conversationId, turnId: <existing>, busy: true }` WITHOUT spawning a second turn. Every existing caller ignoring `busy` is unaffected.

- [ ] **Step 1: Write the failing test**

Create `app/src/main/core/assistant/controller.busy-guard.test.ts`. Follow the DI pattern already used by `controller-external-gate.test.ts` / `authorization.test.ts` (build the controller with fake deps; no real DB — the guard is checked BEFORE any DB write when a conversationId is supplied). If those tests use a shared harness/helper, reuse it; otherwise construct `buildAssistantController` with the same fake `deps` shape they use.

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildAssistantController } from './controller';
// Reuse the existing fake-deps builder from the sibling gate tests if present;
// otherwise inline a minimal deps object mirroring controller-external-gate.test.ts.
import { makeFakeAssistantDeps } from './__testutils__/fake-deps'; // adjust to the real helper

describe('assistant.send concurrent-turn guard', () => {
  it('a second send for a conversation with a live turn returns busy without a new turn', async () => {
    const deps = makeFakeAssistantDeps();
    // Make runClaudeCliTurn hang so the first turn stays "live".
    const { controller } = buildAssistantController(deps);

    const first = await controller.send({ workspaceId: 'ws1', conversationId: 'conv1', prompt: 'a' });
    expect(first.busy).toBeFalsy();
    expect(first.turnId).toBeTruthy();

    const second = await controller.send({ workspaceId: 'ws1', conversationId: 'conv1', prompt: 'b' });
    expect(second.busy).toBe(true);
    expect(second.turnId).toBe(first.turnId); // points at the live turn, not a new one
  });

  it('a send for a DIFFERENT conversation is not blocked', async () => {
    const deps = makeFakeAssistantDeps();
    const { controller } = buildAssistantController(deps);
    const a = await controller.send({ workspaceId: 'ws1', conversationId: 'convA', prompt: 'a' });
    const b = await controller.send({ workspaceId: 'ws1', conversationId: 'convB', prompt: 'b' });
    expect(a.busy).toBeFalsy();
    expect(b.busy).toBeFalsy();
    expect(b.turnId).not.toBe(a.turnId);
  });
});
```

> If no `makeFakeAssistantDeps` helper exists, first read `controller-external-gate.test.ts` and copy its deps-construction into an inline `const deps = {...}` in this file. Do NOT invent a DB.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/core/assistant/controller.busy-guard.test.ts`
Expected: FAIL — `second.busy` is `undefined` (guard not implemented); two distinct turnIds.

- [ ] **Step 3: Implement the guard**

In `controller.ts`, add a live-turn index next to `activeTurns` (`:178`):

```typescript
const activeTurns = new Map<string, ActiveTurn>();
// P0.1 — one live turn per conversation. Prevents a double-send (multi-window,
// telegram, external, or a fast double-tap) from spawning a second `claude`
// child against the same conversation. Keyed by conversationId → live turnId.
const liveTurnByConversation = new Map<string, string>();
```

In `send`, AFTER `conversationId` is resolved (`:456`, right after the `if (!conversationId) { … }` block) and BEFORE `appendMessage`, add:

```typescript
      // P0.1 — reject a concurrent turn for this conversation. Return the live
      // turn id so the caller can attach to it instead of starting a rival turn.
      const existingTurnId = liveTurnByConversation.get(conversationId);
      if (existingTurnId && activeTurns.has(existingTurnId)) {
        return { conversationId, turnId: existingTurnId, busy: true };
      }
```

After `activeTurns.set(turnId, turn);` (`:470`), add:

```typescript
      liveTurnByConversation.set(conversationId, turnId);
```

In the `finally` block of the async IIFE (`:539-541`), release BOTH maps:

```typescript
        } finally {
          activeTurns.delete(turnId);
          if (liveTurnByConversation.get(conversationId) === turnId) {
            liveTurnByConversation.delete(conversationId);
          }
        }
```

Update the `send` return type union to include `busy?: boolean`:

```typescript
    }): Promise<{ conversationId: string; turnId: string; busy?: boolean }> => {
```

Also clean up on `cancel` (`:553-559`) — after marking cancelled, drop the live index so a fresh send isn't wrongly rejected:

```typescript
    cancel: async (input: { conversationId: string; turnId: string }): Promise<void> => {
      const t = activeTurns.get(input.turnId);
      if (t) t.cancelled = true;
      if (liveTurnByConversation.get(input.conversationId) === input.turnId) {
        liveTurnByConversation.delete(input.conversationId);
      }
      cancelClaudeCliTurn(input.turnId);
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/core/assistant/controller.busy-guard.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Run the full assistant suite (guard against regressions in the send contract)**

Run: `npx vitest run src/main/core/assistant`
Expected: PASS. If any existing test asserts the exact `send` return shape by object-equality, relax it to check `conversationId`/`turnId` fields (the added optional `busy` is additive).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc -b`
Expected: clean.

```bash
git add src/main/core/assistant/controller.ts src/main/core/assistant/controller.busy-guard.test.ts
git commit -m "fix(jorvis): reject concurrent turns per conversation (P0.1)"
```

---

## Task 2: Distinct error surface + Retry (renderer consumes `kind:'error'`)

**Files:**
- Modify: `app/src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.ts` (the `assistant:state` handler at `:117`)
- Modify: `app/src/renderer/features/jorvis-assistant/ChatTranscript.tsx` (message-kind rendering)
- Modify: `app/src/renderer/features/jorvis-assistant/JorvisRoom.tsx` (Retry action + last-user-prompt ref)
- Test: extend `app/src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.test.ts`

**Interfaces:**
- Consumes: `AssistantStateEvent = { kind: 'state'|'delta'|'error'|'final'; state?; conversationId; turnId; delta?; messageId?; message?: string }`. The main process ALREADY emits `kind:'error'` with a `message` field (`runClaudeCliTurn.emit.ts:118-125`) and also pushes the text as a delta — but the renderer currently treats `error` as unknown, so there is no distinct error styling and `busy` clears only via the trailing `standby`.
- Produces: on `kind:'error'` for the active turn, the hook clears `busy`, retires the turn, and commits an `error`-role message row `{ id: messageId ?? <uuid>, role: 'error', content: message }`. `ChatTranscript` renders `error` rows with a red badge + the text; `JorvisRoom` shows a "Retry" button on the most recent error row that re-sends the last user prompt.

- [ ] **Step 1: Write the failing test**

Extend `use-jorvis-assistant-state.test.ts` (it already drives `assistant:state` events via the mocked `onEvent`; follow its existing harness):

```typescript
it('kind:error commits an error row and clears busy for the active turn', () => {
  // ... arrange: set activeTurnIdRef to 'T1' and busy=true per the existing harness ...
  emit({ kind: 'error', conversationId: 'C1', turnId: 'T1', messageId: 'M1',
         message: 'claude CLI exited 1: boom' });
  // assert: busy cleared, and a message row {id:'M1', role:'error', content contains 'boom'} committed
  expect(getBusy()).toBe(false);
  const rows = getMessages();
  expect(rows.some(r => r.role === 'error' && r.content.includes('boom'))).toBe(true);
});

it('an error for a STALE turn is ignored (B3 gating still holds)', () => {
  // activeTurnIdRef = 'T2'; emit error for 'T1' → no row, busy unchanged
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.test.ts`
Expected: FAIL — no `error` row committed; `role: 'error'` not yet a valid `ChatRole`.

- [ ] **Step 3: Add `'error'` to `ChatRole` and render it**

In `ChatTranscript.tsx`, extend the role union + label/style maps (find `ChatRole` ~`:11`, `ROLE_LABEL` ~`:43`):

```typescript
export type ChatRole = 'user' | 'assistant' | 'tool' | 'system' | 'error';
```
```typescript
const ROLE_LABEL: Record<ChatRole, string> = {
  user: 'You', assistant: 'Jorvis', tool: 'Tool', system: 'System', error: 'Error',
};
```
Add an `error` branch to the body styling block (mirror the `system` amber branch but red — reuse the existing token, e.g. `text-[--danger]` / the class the codebase already uses for error toasts; grep `sl-error`/`danger` in `index.css` and match it).

- [ ] **Step 4: Handle `kind:'error'` in the state hook**

In `use-jorvis-assistant-state.ts`, inside the `onEvent<AssistantStateEvent>('assistant:state', …)` handler (`:117`), after the existing `turnId` gate (so stale/boot errors are dropped exactly like other events), add a branch BEFORE the delta/standby handling:

```typescript
      if (e.kind === 'error') {
        // P0.2 — a CLI/turn failure. Commit a distinct error row (idempotent by
        // messageId) and clear the in-flight turn so the composer unlocks with a
        // legible failure instead of a silent standby.
        const id = e.messageId ?? `err-${e.turnId}`;
        const text = e.message ?? 'Jorvis turn failed.';
        setMessages((rows) =>
          rows.some((r) => r.id === id)
            ? rows
            : [...rows, { id, role: 'error' as ChatRole, content: text }],
        );
        setBusy(false);
        setStreaming(null);
        activeTurnIdRef.current = null;
        cancelWatchdog();               // reuse the existing watchdog-clear used on standby
        return;
      }
```

> Match the exact state-setter names already in the file (`setBusy`/`setStreaming`/the watchdog clear). Because the main process ALSO emits the same text as a delta then a `standby{error}`, guard against a double error row: the `rows.some(r => r.id === id)` check + the trailing `standby` handler seeing `busy` already false makes the standby a no-op. Verify the standby branch tolerates `activeTurnIdRef.current === null` (it should, per the B3 gate).

- [ ] **Step 5: Add the Retry affordance**

In `JorvisRoom.tsx`, keep a ref to the last submitted user prompt (set it in `sendPrompt` alongside the existing `busy`/watchdog arm ~`:196`). Pass an `onRetry` callback to `ChatTranscript` that re-invokes `sendPrompt(lastPromptRef.current)`. `ChatTranscript` renders a small "Retry" button inside the LAST `error` row only. Keep it minimal — a text button, no new design system work.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.test.ts src/renderer/features/jorvis-assistant/ChatTranscript.render-count.test.tsx`
Expected: PASS. The render-count contract must still hold (an error row is a normal committed row — it must not re-invoke `useJorvisStreamReveal`).

- [ ] **Step 7: Typecheck + full renderer suite + commit**

Run: `npx tsc -b && npx vitest run src/renderer/features/jorvis-assistant`
Expected: PASS.

```bash
git add src/renderer/features/jorvis-assistant/
git commit -m "fix(jorvis): distinct error row + Retry on turn failure (P0.2)"
```

---

## Task 3: Envelope tolerance + recorded-fixture contract tests + version-at-boot

**Files:**
- Modify: `app/src/main/core/assistant/cli-envelope.ts` (add a tolerant classifier)
- Test: `app/src/main/core/assistant/cli-envelope.test.ts` (create)
- Create: `app/src/main/core/assistant/__fixtures__/cli-envelopes/success.jsonl`, `tool-use.jsonl`, `unknown-subtypes.jsonl`
- Modify: the boot diagnostics path to log the resolved `claude` version (see Step 5)

**Interfaces:**
- Consumes: `parseCliLine`, `isAssistantEnvelope`, `isSystemInitEnvelope`, `isResultEnvelope`, `isResultSuccess` (existing, `cli-envelope.ts`).
- Produces: `classifyEnvelope(env: CliEnvelope): 'assistant' | 'system-init' | 'result-success' | 'result-error' | 'other'` — a total function that NEVER throws and returns `'other'` for any unknown `type`/`subtype`. The turn loop keeps its current behavior (unknown → log-only) but now via a named, tested classifier so a new CLI subtype can't crash a turn.

- [ ] **Step 1: Write the failing test + capture fixtures**

Create three fixtures. `success.jsonl` and `tool-use.jsonl` should be real lines captured from a live `claude -p '…' --output-format stream-json --verbose` run (one simple text turn; one turn that calls a tool). `unknown-subtypes.jsonl` contains deliberately-forward envelopes to prove tolerance:

```jsonl
{"type":"system","subtype":"init","session_id":"abc123"}
{"type":"system","subtype":"some_future_hook","data":{"x":1}}
{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}
{"type":"rate_limit_event","tier":"foo"}
{"type":"result","subtype":"success","result":"done","is_error":false}
{"type":"totally_new_type","whatever":true}
```

Create `cli-envelope.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCliLine, classifyEnvelope } from './cli-envelope';

const fx = (n: string) =>
  readFileSync(join(__dirname, '__fixtures__/cli-envelopes', n), 'utf8')
    .split('\n').filter(Boolean);

describe('classifyEnvelope', () => {
  it('never throws and classifies every line of the unknown-subtypes fixture', () => {
    for (const line of fx('unknown-subtypes.jsonl')) {
      const env = parseCliLine(line);
      expect(env).not.toBeNull();
      expect(() => classifyEnvelope(env!)).not.toThrow();
    }
  });
  it('classifies the known shapes', () => {
    const kinds = fx('unknown-subtypes.jsonl').map((l) => classifyEnvelope(parseCliLine(l)!));
    expect(kinds).toEqual([
      'system-init', 'other', 'assistant', 'other', 'result-success', 'other',
    ]);
  });
  it('a recorded real success turn ends in exactly one result-success', () => {
    const kinds = fx('success.jsonl').map((l) => classifyEnvelope(parseCliLine(l)!));
    expect(kinds.filter((k) => k === 'result-success').length).toBe(1);
  });
  it('malformed lines parse to null (caller surfaces raw delta)', () => {
    expect(parseCliLine('{not json')).toBeNull();
    expect(parseCliLine('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/assistant/cli-envelope.test.ts`
Expected: FAIL — `classifyEnvelope` is not exported.

- [ ] **Step 3: Implement `classifyEnvelope`**

Append to `cli-envelope.ts`:

```typescript
export type EnvelopeClass =
  | 'assistant'
  | 'system-init'
  | 'result-success'
  | 'result-error'
  | 'other';

/**
 * Total, never-throwing classification of a parsed envelope. Any unknown
 * `type` or `subtype` (a forward-compatible CLI addition) collapses to
 * 'other' so the turn loop log-and-continues instead of crashing. This is the
 * update-proofing seam: new CLI envelope shapes cannot break a live turn.
 */
export function classifyEnvelope(env: CliEnvelope): EnvelopeClass {
  if (isAssistantEnvelope(env)) return 'assistant';
  if (isSystemInitEnvelope(env)) return 'system-init';
  if (isResultEnvelope(env)) return isResultSuccess(env) ? 'result-success' : 'result-error';
  return 'other';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/core/assistant/cli-envelope.test.ts`
Expected: PASS.

- [ ] **Step 5: Adopt the classifier in the turn loop (no behavior change) + surface the version**

In `runClaudeCliTurn.trajectory.ts` where envelopes are routed (the block ending "system / user / unknown envelopes are log-only", `:121`), route through `classifyEnvelope` for the branch decision instead of ad-hoc `type` checks — keeping the SAME outcomes (this is a refactor to the tested seam, not new behavior). Confirm the existing `runClaudeCliTurn` tests still pass.

For the version: `getOrProbe` already captures `cachedProbe.version` (`runClaudeCliTurn.ts:164-168`). Add a one-line boot diagnostic. Grep for the existing boot-log/diagnostics writer (`diagnostics-log.ts` or the main boot sequence) and, once the probe resolves, log `` `[jorvis] claude CLI ${version ?? 'unknown'} at ${resolvedPath}` `` exactly once. If a `diagnostics-log.ts:appendDiagnostic`-style API exists, use it; else `console.info`. Add a test only if a pure logging helper is introduced.

- [ ] **Step 6: Run the assistant suite + typecheck + commit**

Run: `npx vitest run src/main/core/assistant && npx tsc -b`
Expected: PASS + clean.

```bash
git add src/main/core/assistant/cli-envelope.ts src/main/core/assistant/cli-envelope.test.ts \
        src/main/core/assistant/__fixtures__ src/main/core/assistant/runClaudeCliTurn.trajectory.ts
git commit -m "feat(jorvis): tolerant envelope classifier + fixture contract tests + version-at-boot (P0.3)"
```

---

## Task 4: Fresh-session control (app action + `/new` Telegram)

**Files:**
- Modify: `app/src/main/core/assistant/conversations.ts` (add `clearClaudeSessionId`)
- Modify: `app/src/main/rpc-router.ts` (register `assistant.newSession`)
- Modify: `app/src/shared/rpc-channels.ts`, `app/src/shared/router-shape.ts`, `app/src/main/core/rpc/schemas.ts`, `app/src/shared/rpc-channels.test.ts` (mirror the channel)
- Modify: `app/src/renderer/features/jorvis-assistant/JorvisRoom.tsx` (a "New session (keep history)" action)
- Modify: `app/src/main/core/remote/bridge.ts` (`/new` command)
- Test: `app/src/main/core/assistant/conversations.newsession.test.ts` (create, MockDb) + a bridge command test

**Interfaces:**
- Consumes: `setClaudeSessionId(conversationId, null)` already exists (`conversations.ts:85-94`) and clears the resume id WITHOUT touching messages. "Fresh session" = call it with `null`.
- Produces: `assistant.newSession({ conversationId })` RPC → clears `claudeSessionId`, keeps the transcript; returns `{ ok: true }`. Telegram `/new` calls it for the active conversation and replies confirming.

> Note: `conversations.ts` already has `setClaudeSessionId(id, null)`. Rather than a new DAO fn, expose the CLEAR intent explicitly for readability + a stable name the RPC + bridge call.

- [ ] **Step 1: Write the failing DAO test (MockDb)**

Create `conversations.newsession.test.ts` following the existing MockDb/DI pattern used by other `core/assistant` DB tests (grep a sibling that injects a fake db — do NOT `new Database()`):

```typescript
import { describe, it, expect } from 'vitest';
import { clearClaudeSessionId } from './conversations';
// wire the same MockDb the sibling conversations tests use

describe('clearClaudeSessionId', () => {
  it('nulls claude_session_id and leaves messages untouched', () => {
    // arrange a conversation with claudeSessionId='S1' + 2 messages in the MockDb
    clearClaudeSessionId('conv1');
    // assert claudeSessionId is now null AND messagesFor('conv1').length === 2
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/assistant/conversations.newsession.test.ts`
Expected: FAIL — `clearClaudeSessionId` not exported.

- [ ] **Step 3: Implement the DAO helper**

In `conversations.ts`, add next to `setClaudeSessionId`:

```typescript
/** P0.4 — start a fresh CLI context WITHOUT dropping the transcript. Clears
 *  the resume session id so the next turn spawns clean; messages are kept. */
export function clearClaudeSessionId(conversationId: string): void {
  setClaudeSessionId(conversationId, null);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/core/assistant/conversations.newsession.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the `assistant.newSession` RPC (5 mirror sites)**

1. `shared/rpc-channels.ts` CHANNELS — add `'assistant.newSession'` in the assistant block (`:239-247`).
2. `shared/router-shape.ts` AppRouter — add `newSession(input: { conversationId: string }): Promise<{ ok: true }>` in the `assistant:` block.
3. `main/rpc-router.ts` — add the handler on the assistant controller wiring (`grep 'assistant.send'` handler site); it calls `clearClaudeSessionId(conversationId)` and returns `{ ok: true }`. (Simplest: add a `newSession` method to the controller in `controller.ts` next to `list`/`cancel`, then it rides the existing controller registration.)
4. `main/core/rpc/schemas.ts` — add `'assistant.newSession': z.object({ conversationId: z.string().min(1).max(200) })` input (mirror the `refResolve` entry at `:944-950`).
5. `shared/rpc-channels.test.ts` — add `'assistant.newSession'` to `TYPED_ROUTER_CHANNELS`.

Prefer adding `newSession` to the controller in `controller.ts` (keeps it on the typed `assistant.*` surface, avoids a side-band):

```typescript
    newSession: async (input: { conversationId: string }): Promise<{ ok: true }> => {
      if (typeof input?.conversationId !== 'string' || !input.conversationId) {
        throw new Error('assistant.newSession: conversationId required');
      }
      // P0.4 — also drop any live-turn index + cancel an in-flight turn so the
      // fresh context isn't immediately resumed by a straggler.
      const live = liveTurnByConversation.get(input.conversationId);
      if (live) { const t = activeTurns.get(live); if (t) t.cancelled = true; cancelClaudeCliTurn(live); }
      conversationsDao.clearClaudeSessionId(input.conversationId);
      return { ok: true };
    },
```

- [ ] **Step 6: Renderer action + Telegram command**

Renderer: in `JorvisRoom.tsx`, add a "New session (keep history)" item (near the existing `onNewConversation` at `:254` — but distinct: this keeps the transcript). It calls `rpc.assistant.newSession({ conversationId })` then toasts "Fresh Jorvis session — history kept." Do NOT clear `messages`.

Telegram: in `bridge.ts handleMessage` (`:379`), add `/new` to the control-command block (`:388`, allowlist-gated like `/lock`):

```typescript
    if (command === '/lock' || command === '/unlock' || command === '/status' || command === '/new') {
      // …existing allowlist check…
      if (command === '/new') {
        const conversationId = this.resolveActiveConversationId?.(); // or the bridge's tracked conversation
        if (conversationId) { await this.deps.assistant.newSession?.({ conversationId }); }
        await this.reply(chatId, '🆕 Fresh Jorvis session started (history kept).');
        return;
      }
      // …
    }
```

> If the bridge doesn't currently track a conversationId, the simplest correct behavior for `/new` is to clear the resume id on the conversation the bridge last dispatched to; if none, reply "No active Jorvis conversation yet." Add `newSession` to the bridge's `assistant` dep type.

- [ ] **Step 7: Mirror test + full gate + commit**

Run: `npx vitest run src/shared/rpc-channels.test.ts src/main/core/assistant src/main/core/remote && npx tsc -b && npx eslint .`
Expected: PASS + clean (the channel-parity test proves all mirror sites agree).

```bash
git add src/main/core/assistant/conversations.ts src/main/core/assistant/controller.ts \
        src/shared/rpc-channels.ts src/shared/router-shape.ts src/main/core/rpc/schemas.ts \
        src/shared/rpc-channels.test.ts src/renderer/features/jorvis-assistant/JorvisRoom.tsx \
        src/main/core/remote/bridge.ts \
        src/main/core/assistant/conversations.newsession.test.ts
git commit -m "feat(jorvis): fresh-session control — app action + /new telegram (P0.4)"
```

---

## Task 5: Ride-along recon fixes

**Files (each an independent sub-commit):**
- `app/src/main/core/assistant/controller.ts:189` + `app/src/shared/rpc-channels.ts` EVENTS — `assistant:security`
- `app/src/main/core/rpc/schemas.ts:952-955` — `assistant.conversations.resumeHint` stub
- `app/src/main/core/assistant/controller.ts:780-839` — `refResolve` path-guard
- comment fixes: `controller.ts:60-64`, `authorization.test.ts:87`
- `docs/03-plan/WISHLIST.md` (repo root `docs/`, the stale twin)

**Interfaces:** none new — these are corrections. Do them as five small commits so each is independently reviewable/revertible.

- [ ] **Step 1: Decide `assistant:security` — wire minimal or delete**

The emit at `controller.ts:189` has zero subscribers and is not in `EVENTS`. For P0, DELETE the dead emit + its three stale comments (`controller.ts:182-183,458-462`, `aidefence-gate.ts:5,16`) rather than build a security UI (that's out of P0 scope). Keep the aidefence `audit` callback but make it a no-op-friendly local log:

```typescript
  const aidefence = deps.rufloCall
    ? createAidefenceGate({
        rufloCall: deps.rufloCall,
        // P0.5 — audit is local-only for now (the renderer surface was never
        // wired; the emitted event had no allowlist entry and no subscriber).
        audit: () => { /* reserved: a security surface is future work (P2+) */ },
      })
    : undefined;
```

Verify no test asserts the `assistant:security` emit (grep). Commit:
```bash
git commit -am "chore(jorvis): remove dead assistant:security emit (no subscriber, not allowlisted) (P0.5)"
```

- [ ] **Step 2: Add the `resumeHint` schema stub**

In `schemas.ts` at the `assistant.conversations.*` block (`:952-955`), add:

```typescript
  'assistant.conversations.resumeHint': stub,
```

Commit:
```bash
git commit -am "fix(rpc): add resumeHint schema stub — no channel is validation-free (P0.5)"
```

- [ ] **Step 3: Route `refResolve` through the path-guard**

Read `controller.ts:780-839` (`refResolve` walk). Import the shared guard (`assertAllowedPath` / `resolveInsideAllowedRoots` from `core/security/path-guard.ts:91-116`) and validate each resolved path against the workspace root the walk already trusts, mirroring how `read_files` uses it (`tools.ts:637-642`). If a resolved `@ref` escapes the root (symlink/`..`), skip it. Add/extend a unit test asserting an out-of-root symlink ref is not returned.

Commit:
```bash
git commit -am "fix(jorvis): route refResolve @-mention walk through path-guard (P0.5)"
```

- [ ] **Step 4: Stale-comment fixes**

- `controller.ts:60-64` — change "the 13 Sigma tools" to reference the live catalogue (e.g. "the Sigma tool catalogue (see `tool-catalogue.ts`, contract-tested against `tools.ts`)").
- `authorization.test.ts:87` — fix the test TITLE to list all four `DANGEROUS_REMOTE` members (`close_pane, close_workspace, kill_swarm, prompt_agent`); assertion is already correct.

Commit:
```bash
git commit -am "docs(jorvis): fix stale tool-count + DANGEROUS_REMOTE test title (P0.5)"
```

- [ ] **Step 5: Archive the stale WISHLIST twin**

The canonical wishlist is the repo-root `WISHLIST.md`. `docs/03-plan/WISHLIST.md` is an older lineage that misled a recon lane (lists 4 already-fixed Jorvis renderer bugs as open). Move it to `docs/03-plan/archive/WISHLIST-legacy-2026-07-07.md` with a one-line header pointing at the root file. (This file is in the repo `docs/`, NOT `app/docs/`.)

```bash
cd /Users/aisigma/projects/SigmaLink
git mv docs/03-plan/WISHLIST.md docs/03-plan/archive/WISHLIST-legacy-2026-07-07.md
# prepend a one-line "> Superseded by repo-root WISHLIST.md — archived 2026-07-07." header
git commit -m "docs: archive stale docs/03-plan/WISHLIST twin (misled recon; canonical is root) (P0.5)"
```

---

## Task 6: Full gate + phase verification

- [ ] **Step 1: Full local gate**

Run from `app/`:
```bash
npx tsc -b && npx vitest run && npx eslint . && npm run build
```
Expected: all green, eslint 0 warnings.

- [ ] **Step 2: Manual smoke (operator-run, documented)**

These need a real `claude` binary + a live app, so they are operator smokes (record results in the PR, don't fake them):
1. Send a Jorvis prompt; kill the `claude` child mid-turn (or point the binary at a broken path) → a red **Error** row appears with a **Retry** button; composer unlocks.
2. Double-tap send fast → only one reply streams (no duplicate turn).
3. "New session (keep history)" → transcript stays, next turn starts a clean CLI context (verify via the `--version`/session-id boot log or that `--resume` is absent on the next spawn).
4. Telegram `/new` → confirmation reply; next telegram prompt runs fresh.

- [ ] **Step 3: Definition-of-done check (ROADMAP Phase 19)**

Confirm against the ROADMAP DoD: two rapid sends → one child + defined busy (Task 1 test); every induced failure → visible transcript error row (Task 2 + smoke); fixture tests pass ≥2 envelope shapes (Task 3); `/new` + app New-session verified (Task 4 + smoke); full local gate green (Step 1).

---

## Self-Review notes (author)

- **Spec coverage:** P0.1 → Task 1; P0.2 → Task 2; P0.3 → Task 3; P0.4 → Task 4; P0.5 → Task 5. All five P0 sub-items map to a task.
- **Known soft spots to resolve at execution time (not placeholders — flagged unknowns needing a grep):** the exact fake-deps helper name for the controller tests; the exact MockDb wiring for the conversations test; the exact renderer state-setter + watchdog-clear names in `use-jorvis-assistant-state.ts`; whether the bridge tracks a conversationId for `/new`. Each task step says which sibling to grep for the real name — resolve by reading the sibling, do not invent APIs.
- **Type consistency:** `busy?: boolean` added to `send`'s return in Task 1 and consumed nowhere that asserts strict equality; `ChatRole` gains `'error'` in Task 2 and every `Record<ChatRole, …>` map is updated in the same step; `clearClaudeSessionId` is defined in Task 4 Step 3 and referenced by the RPC + bridge in the same task.
