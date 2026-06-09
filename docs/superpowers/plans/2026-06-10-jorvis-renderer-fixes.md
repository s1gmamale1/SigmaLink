# Jorvis Renderer Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six 2026-06-10 audit findings in the Jorvis assistant renderer cluster: useSyncExternalStore snapshot bailout, out-of-order conversation hydration, jump-to-message highlight misses + timer leak, setState-inside-updater stream commit, composer clear dedup, and overlapping live-stats polls (both mirrored sites).

**Architecture:** Each fix is a minimal, locally-tested correctness guard: copy-on-write snapshots for the pane-event store, a monotonic request token for async hydration, frame-retry + unmount cleanup for the DOM highlight, a synchronously-written `streamingRef` so the standby commit happens as a sibling setState, a nonce'd composer push token, and an in-flight coalescing flag inside `poll()` at BOTH mirrored pollers. TDD per task with jsdom/RTL fake-RPC harnesses that mirror the existing test patterns (`JorvisRoom.b3.test.tsx` sigma-stub, `usePaneLiveStats.test.ts` fake-timer ticks).

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react (jsdom), Electron renderer (typed `rpc`/`onEvent` preload bridge, `window.sigma.invoke` side-band).

---

**Plan baseline:** written against committed state `main` @ `a4156ac` (2026-06-10). All paths below are relative to `/Users/aisigma/projects/SigmaLink/app` and all commands run from that directory. All cited line numbers refer to `git show HEAD:<path>` at this baseline.

**WIP HAZARD — re-verify against current file state before executing.** `ChatTranscript.tsx` / `ChatTranscript.stream.test.tsx` have carried uncommitted concurrent-session WIP in this repo's shared working tree (the tree was clean at plan-write time, but concurrent sessions reintroduce WIP without warning — see Task 0). This plan does NOT modify either file, but Tasks 4 and 5 modify neighbors that import `ChatTranscript` (`JorvisRoom.tsx`, `use-jorvis-assistant-state.ts`, and the new test imports `ChatMessageView`). Task 0 gates execution on re-verification.

## File Structure

```
src/renderer/features/jorvis-assistant/
  use-jorvis-pane-events.ts          MODIFY  (Task 1 — copy-on-add)
  use-jorvis-pane-events.test.ts     MODIFY  (Task 1 — re-render-from-add test)
  use-jorvis-conversations.ts        MODIFY  (Task 2 — hydrate request token)
  use-jorvis-conversations.test.ts   CREATE  (Task 2 — out-of-order + ws-switch guards)
  use-jorvis-jump-to-message.ts      MODIFY  (Task 3 — frame retry + timer cleanup)
  use-jorvis-jump-to-message.test.ts CREATE  (Task 3 — retry + unmount-clears-timer)
  use-jorvis-assistant-state.ts      MODIFY  (Task 4 — streamingRef sibling commit)
  use-jorvis-assistant-state.test.ts CREATE  (Task 4 — pure-updater / single-commit)
  JorvisRoom.tsx                     MODIFY  (Task 4 — streamingRef; Task 5 — push token)
  Composer.tsx                       MODIFY  (Task 5 — ComposerExternalValue {value,nonce})
  Composer.test.tsx                  CREATE  (Task 5 — re-clear on nonce bump)
src/renderer/features/command-room/
  usePaneLiveStats.ts                MODIFY  (Task 6 — coalescing guard)
  usePaneLiveStats.test.ts           MODIFY  (Task 6 — overlap drift-guard test)
src/renderer/features/right-rail/
  useSwarmLiveStats.ts               MODIFY  (Task 6 — coalescing guard, mirrored site)
  useSwarmLiveStats.test.ts          CREATE  (Task 6 — overlap drift-guard test)
```

All touched source files stay well under 500 lines (largest post-edit: `JorvisRoom.tsx` ~400, `usePaneLiveStats.test.ts` ~310).

### Task 0: Preflight — re-verify file state (MANDATORY, no commit)

**Files:** none modified.

- [ ] **Step 1: Confirm the working tree state for the jorvis cluster**

Run:
```bash
git status --short src/renderer/features/jorvis-assistant/ src/renderer/features/command-room/ src/renderer/features/right-rail/
git diff --stat HEAD -- src/renderer/features/jorvis-assistant/ChatTranscript.tsx src/renderer/features/jorvis-assistant/ChatTranscript.stream.test.tsx
```
Expected: empty output (clean). If `ChatTranscript.tsx`/`ChatTranscript.stream.test.tsx` show WIP: do NOT touch them, do NOT stage them in any commit, and plan-verify that the `ChatTranscript` props this plan relies on (`streaming: { turnId; delta; messageId } | null`, `pending`, exported `ChatMessageView`) are unchanged in the WORKING-TREE copy before Tasks 4–5. If any OTHER target file of this plan shows WIP, stop and report to the operator (concurrent-tree stomp protocol).

- [ ] **Step 2: Re-verify each finding's cited code still matches**

Run:
```bash
sed -n '27,44p' src/renderer/features/jorvis-assistant/use-jorvis-pane-events.ts
sed -n '92,125p' src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts
sed -n '35,50p' src/renderer/features/jorvis-assistant/use-jorvis-jump-to-message.ts
sed -n '149,167p' src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.ts
sed -n '51,62p' src/renderer/features/jorvis-assistant/Composer.tsx
sed -n '119,180p' src/renderer/features/command-room/usePaneLiveStats.ts
sed -n '57,102p' src/renderer/features/right-rail/useSwarmLiveStats.ts
```
Expected: `add()` does `this.events.push(raw)`; `hydrateConversation` has no token guard; a single `requestAnimationFrame` + uncancelled 1.5s timeout; `p.setMessages(...)` nested inside `p.setStreaming((prev) => …)`; Composer `externalValue?: string` with `typeof externalValue !== 'string'` guard; both pollers lack an in-flight guard. If any site already carries a fix (a concurrent lane landed it first), mark that task **Refuted/Already-fixed** in this plan file and skip it.

- [ ] **Step 3: Create an isolated execution branch (shared-tree stomp protection)**

Run:
```bash
git checkout -b fix/jorvis-renderer-audit-2026-06-10 origin/main
```
Expected: new branch off origin/main. (Per repo memory, prefer an isolated worktree if the shared tree shows concurrent churn.)

### Task 1: PaneEventStore copy-on-add (finding 1, MED)

`PaneEventStore.add()` mutates `this.events` in place and notifies; `getSnapshot` returns the same array reference, so `useSyncExternalStore` bails out on `Object.is` and pane-event cards (`JorvisRoom.tsx:341-351` `paneEvents.map`) only render when something else re-renders the room. `clear()` allocates a new array, which masks the bug in the existing tests (the asserted `result.current` is the SAME mutated array, so `toHaveLength(1)` passes without any re-render).

**Files:**
- Modify: `src/renderer/features/jorvis-assistant/use-jorvis-pane-events.ts:27-30`
- Test: `src/renderer/features/jorvis-assistant/use-jorvis-pane-events.test.ts`

- [ ] **Step 1: Write the failing test**

In `use-jorvis-pane-events.test.ts`, change the testing-library import to include `act`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
```

Append inside the existing `describe('useJorvisPaneEvents', …)` block:

```ts
  it('re-renders from add() alone — snapshot identity must change (copy-on-add)', () => {
    handlers.clear();
    const { result } = renderHook(() => useJorvisPaneEvents('conv-1'));
    const before = result.current;
    const fn = handlers.get('assistant:pane-event');
    expect(fn).toBeTruthy();
    act(() => {
      fn?.({ id: 'e1', conversationId: 'conv-1', sessionId: 's1', kind: 'exited', ts: 1 });
    });
    // useSyncExternalStore bails out when getSnapshot returns the same
    // reference (Object.is). The pane-event cards only re-render if add()
    // produced a NEW array. The sibling tests above pass even WITHOUT a
    // re-render because `result.current` is the same in-place-mutated array —
    // this identity assertion is the one that catches the bailout.
    expect(result.current).not.toBe(before);
    expect(result.current).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/jorvis-assistant/use-jorvis-pane-events.test.ts`
Expected: FAIL — `expected [ {…} ] not to be [ {…} ]` (same array reference; no re-render fired).

- [ ] **Step 3: Write the minimal implementation**

In `use-jorvis-pane-events.ts`, replace `add()` (lines 27-30):

```ts
  add(raw: RawPaneEvent) {
    // Copy-on-add: useSyncExternalStore compares snapshots with Object.is —
    // an in-place push returns the SAME array reference and every subscriber
    // bails out without re-rendering (2026-06-10 audit finding #1). clear()
    // already allocates a new array; add() must too.
    this.events = [...this.events, raw as PaneEvent];
    for (const fn of this.listeners) fn();
  }
```

- [ ] **Step 4: Run the file's tests to verify all pass**

Run: `npx vitest run src/renderer/features/jorvis-assistant/use-jorvis-pane-events.test.ts`
Expected: PASS (4 tests — the 3 pre-existing ones must stay green).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/jorvis-assistant/use-jorvis-pane-events.ts src/renderer/features/jorvis-assistant/use-jorvis-pane-events.test.ts
git commit -m "fix(jorvis): copy-on-add in PaneEventStore so pane-event cards render on arrival"
```

### Task 2: hydrateConversation request token (finding 2, MED)

`hydrateConversation` (lines 92-125) applies async `assistant.conversations.get` results with no request token: `onPickConversation` (l.167) fires `void hydrateConversation(id)` per click, so rapid A→B picks resolving out of order show conversation A while KV persisted B. The ws-change effect (l.130-165) checks `alive` only BEFORE calling `hydrateConversation`, so a slow hydrate from workspace A paints inside workspace B.

**Files:**
- Modify: `src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts:1,62-68,92-125,162-164,203-208`
- Test: Create `src/renderer/features/jorvis-assistant/use-jorvis-conversations.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/renderer/features/jorvis-assistant/use-jorvis-conversations.test.ts`:

```ts
// @vitest-environment jsdom
//
// 2026-06-10 audit finding #2 — hydrateConversation must carry a request
// token so out-of-order RPC resolutions (rapid picks, slow hydrate across a
// workspace switch) cannot paint a stale conversation over the active one.
// Mock surface mirrors JorvisRoom.b3.test.tsx (window.sigma side-band stub +
// '@/renderer/lib/rpc' kv mock + '@/renderer/app/state' workspace mock).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  ws: { current: { id: 'ws-1', name: 'WS One' } as { id: string; name: string } | null },
}));

vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: { activeWorkspace: mocks.ws.current },
    dispatch: vi.fn(),
  }),
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: (...args: unknown[]) => mocks.kvGet(...args),
      set: (...args: unknown[]) => mocks.kvSet(...args),
    },
  },
}));

import { useJorvisConversations } from './use-jorvis-conversations';

interface Envelope {
  ok: true;
  data: unknown;
}
interface Deferred {
  resolve: (env: Envelope) => void;
  promise: Promise<Envelope>;
}
function deferred(): Deferred {
  let resolve!: (env: Envelope) => void;
  const promise = new Promise<Envelope>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

function listRow(id: string) {
  return { id, title: id, lastMessageAt: 1, messageCount: 1, claudeSessionId: null };
}

function getEnvelope(id: string): Envelope {
  return {
    ok: true,
    data: {
      conversation: { id, workspaceId: 'ws-1', title: id, createdAt: 1, claudeSessionId: null },
      messages: [
        { id: `${id}-m1`, role: 'assistant', content: `hello from ${id}`, toolCallId: null, createdAt: 2 },
      ],
    },
  };
}

const getDeferreds = new Map<string, Deferred>();
let listRowsByWs: Record<string, ReturnType<typeof listRow>[]> = {};

function resolveGet(id: string): void {
  const d = getDeferreds.get(id);
  if (!d) throw new Error(`no pending conversations.get for ${id}`);
  d.resolve(getEnvelope(id));
}

function installSigma(): void {
  const invoke = vi.fn(async (channel: string, payload?: Record<string, unknown>) => {
    if (channel === 'assistant.conversations.list') {
      const wsId = String(payload?.workspaceId ?? '');
      return { ok: true, data: listRowsByWs[wsId] ?? [] };
    }
    if (channel === 'assistant.conversations.get') {
      const id = String(payload?.conversationId ?? '');
      const d = deferred();
      getDeferreds.set(id, d);
      return d.promise;
    }
    return { ok: true, data: null };
  });
  Object.defineProperty(window, 'sigma', { configurable: true, value: { invoke } });
}

/** Macrotask flush — drains the effect's whole await chain (list → kv → get). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getDeferreds.clear();
  listRowsByWs = {};
  mocks.ws.current = { id: 'ws-1', name: 'WS One' };
  mocks.kvGet.mockResolvedValue(null);
  mocks.kvSet.mockResolvedValue(undefined);
  installSigma();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useJorvisConversations — hydrate request token (out-of-order guard)', () => {
  it('the LAST pick wins even when its RPC resolves first', async () => {
    listRowsByWs = { 'ws-1': [] };
    const { result } = renderHook(() => useJorvisConversations());
    await flush(); // settle the mount/ws effect (empty list → blank slate)

    act(() => {
      result.current.onPickConversation('conv-a');
    });
    act(() => {
      result.current.onPickConversation('conv-b');
    });

    // B (the latest pick) resolves FIRST…
    resolveGet('conv-b');
    await flush();
    expect(result.current.conversationId).toBe('conv-b');

    // …then the STALE A resolves late. It must be discarded — pre-fix it
    // overwrites the view while kv persisted 'conv-b'.
    resolveGet('conv-a');
    await flush();

    expect(result.current.conversationId).toBe('conv-b');
    expect(result.current.messages.map((m) => m.content)).toEqual(['hello from conv-b']);
  });

  it('a slow hydrate from workspace A cannot paint inside workspace B', async () => {
    listRowsByWs = { 'ws-1': [listRow('conv-a')], 'ws-2': [] };
    mocks.kvGet.mockResolvedValue('conv-a');

    const { result, rerender } = renderHook(() => useJorvisConversations());
    await flush(); // ws-1 boot effect reaches hydrate('conv-a') — left PENDING

    // Switch workspace while the hydrate is still in flight.
    mocks.ws.current = { id: 'ws-2', name: 'WS Two' };
    rerender();
    await flush(); // ws-2 effect: empty list → blank slate

    expect(result.current.conversationId).toBeNull();

    // The stale ws-1 hydrate now resolves. It must NOT paint into ws-2.
    resolveGet('conv-a');
    await flush();

    expect(result.current.conversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/jorvis-assistant/use-jorvis-conversations.test.ts`
Expected: FAIL — both tests: `expected 'conv-a' to be 'conv-b'` and `expected 'conv-a' to be null` (stale resolutions applied).

- [ ] **Step 3: Write the minimal implementation**

In `use-jorvis-conversations.ts`:

(a) Line 1 — add `useRef` to the React import:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
```

(b) Inside `useJorvisConversations()`, immediately after the `useState` block (after line 68), add:

```ts
  // 2026-06-10 audit #2 — monotonic hydrate request token. Every entry point
  // that starts (or invalidates) a hydration bumps it; hydrateConversation
  // re-checks it after the await and discards superseded resolutions, so an
  // out-of-order RPC can never paint a stale conversation/workspace.
  const hydrateRequestTokenRef = useRef(0);
```

(c) Replace `hydrateConversation` (lines 92-125) with:

```ts
  /** Hydrate a specific conversation into the transcript. Falls back to a
   *  blank slate when the row no longer exists (e.g. it was just deleted).
   *  Token-guarded: a newer hydrate (or a workspace switch / clear) bumps
   *  `hydrateRequestTokenRef`, and this resolution is discarded before ANY
   *  setState if it has been superseded. */
  const hydrateConversation = useCallback(async (id: string): Promise<void> => {
    const token = ++hydrateRequestTokenRef.current;
    try {
      const res = await invokeSideBand<ConvGet>('assistant.conversations.get', {
        conversationId: id,
      });
      if (token !== hydrateRequestTokenRef.current) return; // superseded — drop
      if (!res.conversation) {
        setConversationId(null);
        setMessages([]);
        setResumeNotice(null);
        return;
      }
      const conversation = res.conversation as HydratedConversation;
      setConversationId(conversation.id);
      setMessages(
        res.messages.map((m) => ({
          id: m.id,
          role: m.role as ChatRole,
          content: m.content,
          toolCallId: m.toolCallId,
          createdAt: m.createdAt,
        })),
      );
      setResumeNotice(
        conversation.claudeSessionId
          ? {
              conversationId: conversation.id,
              lastMessageAt: res.messages.at(-1)?.createdAt ?? conversation.createdAt,
            }
          : null,
      );
    } catch {
      /* keep current view on hydration failure */
    }
  }, []);
```

(d) In the ws-change effect's cleanup (lines 162-164), invalidate in-flight hydrates:

```ts
    return () => {
      alive = false;
      // 2026-06-10 audit #2 — a hydrate started under the OLD workspace must
      // not paint into the new one; bump the token so its resolution is dropped.
      hydrateRequestTokenRef.current += 1;
    };
```

(e) In `clearConversation` (lines 203-208), bump the token first:

```ts
  const clearConversation = useCallback(() => {
    // A pending hydrate must not resurrect the cleared thread.
    hydrateRequestTokenRef.current += 1;
    setConversationId(null);
    setMessages([]);
    setResumeNotice(null);
    persistActiveConversation('');
  }, []);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/features/jorvis-assistant/use-jorvis-conversations.test.ts src/renderer/features/jorvis-assistant/JorvisRoom.test.tsx src/renderer/features/jorvis-assistant/JorvisRoom.b3.test.tsx`
Expected: PASS (the two room suites exercise the hook through `JorvisRoom` and must stay green).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts src/renderer/features/jorvis-assistant/use-jorvis-conversations.test.ts
git commit -m "fix(jorvis): token-guard hydrateConversation against out-of-order resolution"
```

### Task 3: jump-to-message frame retry + timer cleanup (finding 3, LOW)

After `await hydrateConversation(...)` a SINGLE `requestAnimationFrame` queries `[data-message-id]` (lines 36-49) — the React commit can flush after that frame, producing a silent no-scroll/no-highlight. The 1.5s classList-removal `setTimeout` is never cleared on unsubscribe, holding a detached node. Design note: the fix must NOT cancel the retry chain in the `[conversationId]`-dep'd effect cleanup — the jump itself changes `conversationId` (hydrate), so that cleanup fires mid-jump and would self-cancel. Instead the handler reads the active conversation through a ref so the subscription stays stable, and cancellation happens on unmount / on a superseding jump.

**Files:**
- Modify: `src/renderer/features/jorvis-assistant/use-jorvis-jump-to-message.ts` (whole hook body, lines 1-58)
- Test: Create `src/renderer/features/jorvis-assistant/use-jorvis-jump-to-message.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/renderer/features/jorvis-assistant/use-jorvis-jump-to-message.test.ts`:

```ts
// @vitest-environment jsdom
//
// 2026-06-10 audit finding #3 — the jump-to-message highlight must retry
// across frames (the hydrate commit can flush AFTER the first rAF) and the
// 1.5s class-removal timer must be cleared on unmount (it otherwise holds a
// detached transcript node).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { set: vi.fn().mockResolvedValue(undefined) } },
}));

import { useJorvisJumpToMessage } from './use-jorvis-jump-to-message';

let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): void {
  const queue = rafQueue;
  rafQueue = [];
  act(() => {
    queue.forEach((cb) => cb(0));
  });
}

let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  rafQueue = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  // jsdom has no scrollIntoView.
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mountHook() {
  const hydrateConversation = vi.fn(async () => {});
  const transcriptRef = { current: container as HTMLDivElement | null };
  const r = renderHook(() =>
    useJorvisJumpToMessage({ conversationId: 'c1', hydrateConversation, transcriptRef }),
  );
  return { ...r, hydrateConversation };
}

function dispatchJump(messageId: string): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent('jorvis:jump-to-message', {
        detail: { conversationId: 'c1', messageId },
      }),
    );
  });
}

function addRow(messageId: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-message-id', messageId);
  container.appendChild(el);
  return el;
}

describe('useJorvisJumpToMessage — highlight retry + timer hygiene', () => {
  it('retries across frames when the message row commits after the first frame', () => {
    mountHook();
    dispatchJump('m1');

    flushRaf(); // frame 1 — row not in the DOM yet (commit hasn't flushed)
    const el = addRow('m1');
    flushRaf(); // frame 2 — the retry must find it (pre-fix: single rAF, no retry)

    expect(el.classList.contains('ring-2')).toBe(true);
  });

  it('clears the 1.5s highlight-removal timer on unmount (no detached-node hold)', () => {
    const el = addRow('m2');
    const { unmount } = mountHook();
    dispatchJump('m2');
    flushRaf();
    expect(el.classList.contains('ring-2')).toBe(true);

    unmount();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    // The removal callback must NOT have run after unmount — its timer was
    // cleared in cleanup, so it no longer pins the detached node. Pre-fix the
    // timer survives unmount, fires at 1.5s, and strips the class.
    expect(el.classList.contains('ring-2')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/jorvis-assistant/use-jorvis-jump-to-message.test.ts`
Expected: FAIL — test 1: `expected false to be true` (single rAF already consumed before the row existed); test 2: `expected false to be true` (uncancelled timer removed the class after unmount).

- [ ] **Step 3: Write the implementation (full file replacement)**

Replace the contents of `use-jorvis-jump-to-message.ts` with:

```ts
import { useEffect, useRef } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { KV_ACTIVE_CONVERSATION } from './use-jorvis-conversations';

export interface UseJorvisJumpToMessageArgs {
  conversationId: string | null;
  hydrateConversation: (id: string) => Promise<void>;
  transcriptRef: React.MutableRefObject<HTMLDivElement | null>;
}

/** How many frames to keep re-querying for the target row. The hydrate
 *  commit can flush a frame (or several, under load) AFTER the first rAF
 *  fires; a single-frame query silently no-scrolls (2026-06-10 audit #3). */
const MAX_HIGHLIGHT_FRAMES = 10;
const HIGHLIGHT_CLASSES = ['ring-2', 'ring-primary/60'] as const;
const HIGHLIGHT_MS = 1_500;

/** P3-S7 — External jump-to-message hook. The Operator Console fires a
 *  `jorvis:jump-to-message` window event after switching the room
 *  back to `jorvis`; we hydrate the requested conversation (if it isn't
 *  already active) and scroll the matching `[data-message-id]` element
 *  into view, retrying across frames until the commit lands. */
export function useJorvisJumpToMessage({
  conversationId,
  hydrateConversation,
  transcriptRef,
}: UseJorvisJumpToMessageArgs): void {
  // The handler reads the ACTIVE conversation through a ref so the event
  // subscription never re-subscribes mid-jump — the jump's own hydrate
  // CHANGES `conversationId`, and a dep'd-effect cleanup on that change
  // would cancel the in-flight highlight retry chain below.
  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // Pending rAF + highlight-removal timer handles. Cancelled on unmount so a
  // dangling 1.5s timer can't hold a detached transcript node alive, and on a
  // superseding jump so two highlight loops never race.
  const pendingRef = useRef<{ raf: number | null; timer: number | null }>({
    raf: null,
    timer: null,
  });

  useEffect(() => {
    const pending = pendingRef.current;

    const tryHighlight = (messageId: string, attempt: number): void => {
      pending.raf = null;
      const root = transcriptRef.current ?? document;
      const el = root.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      if (!el) {
        // The hydrate commit may not have flushed yet — retry next frame.
        if (attempt < MAX_HIGHLIGHT_FRAMES) {
          pending.raf = requestAnimationFrame(() => tryHighlight(messageId, attempt + 1));
        }
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add(...HIGHLIGHT_CLASSES);
      pending.timer = window.setTimeout(() => {
        pending.timer = null;
        el.classList.remove(...HIGHLIGHT_CLASSES);
      }, HIGHLIGHT_MS);
    };

    const handler = (raw: Event) => {
      const ev = raw as CustomEvent<{ conversationId: string; messageId?: string }>;
      const detail = ev.detail;
      if (!detail || typeof detail.conversationId !== 'string') return;
      void (async () => {
        if (detail.conversationId !== conversationIdRef.current) {
          await hydrateConversation(detail.conversationId);
          try {
            await rpc.kv.set(KV_ACTIVE_CONVERSATION, detail.conversationId);
          } catch {
            /* best-effort */
          }
        }
        if (detail.messageId) {
          const messageId = detail.messageId;
          // A new jump supersedes any in-flight retry/highlight.
          if (pending.raf !== null) cancelAnimationFrame(pending.raf);
          if (pending.timer !== null) window.clearTimeout(pending.timer);
          pending.raf = requestAnimationFrame(() => tryHighlight(messageId, 0));
        }
      })();
    };

    window.addEventListener('jorvis:jump-to-message', handler);
    return () => {
      window.removeEventListener('jorvis:jump-to-message', handler);
      if (pending.raf !== null) {
        cancelAnimationFrame(pending.raf);
        pending.raf = null;
      }
      if (pending.timer !== null) {
        window.clearTimeout(pending.timer);
        pending.timer = null;
      }
    };
    // `transcriptRef` is a stable ref prop; `conversationId` rides
    // conversationIdRef so this subscription survives the jump's own hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrateConversation]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/features/jorvis-assistant/use-jorvis-jump-to-message.test.ts src/renderer/features/jorvis-assistant/JorvisRoom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/jorvis-assistant/use-jorvis-jump-to-message.ts src/renderer/features/jorvis-assistant/use-jorvis-jump-to-message.test.ts
git commit -m "fix(jorvis): retry jump-to-message highlight across frames + clear timer on unmount"
```

### Task 4: standby commit as sibling setState via streamingRef (finding 4, LOW)

`use-jorvis-assistant-state.ts:149-166` dispatches `p.setMessages(...)` from INSIDE the `p.setStreaming((prev) => …)` updater — a side effect in an updater. StrictMode/rebase re-invokes updaters, re-firing the inner setState (currently shielded only by the `rows.some(id)` idempotency guard). Fix: the handler writes the streaming buffer synchronously to a `streamingRef` on each delta and reads it at standby, committing with two sibling setStates. JorvisRoom owns the ref and re-syncs it when it clears `streaming` externally (watchdog timeout, new-conversation reset).

**Files:**
- Modify: `src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.ts:15-48` (args interface), `:75-100` (BOTH propsRef mirrors — grep-the-twins), `:149-183` (standby + delta paths)
- Modify: `src/renderer/features/jorvis-assistant/JorvisRoom.tsx:100-103` (insert ref after busyRef block), `:124-135` (hook call)
- Test: Create `src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.test.ts`:

```ts
// @vitest-environment jsdom
//
// 2026-06-10 audit finding #4 — the standby commit must NOT be a setState
// dispatched from inside the setStreaming updater. StrictMode (and concurrent
// rebase) re-invokes functional updaters; a nested setMessages re-fires.
// Post-fix: the handler mirrors the stream buffer synchronously on
// `streamingRef` and commits via a SIBLING setMessages call.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { act } from '@testing-library/react';
import type { ChatMessageView } from './ChatTranscript';

type EventCb = (payload: unknown) => void;
const handlers = new Map<string, Set<EventCb>>();
function emit(name: string, payload: unknown): void {
  act(() => {
    handlers.get(name)?.forEach((fn) => fn(payload));
  });
}

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    ruflo: { 'patterns.store': vi.fn().mockResolvedValue({ ok: true }) },
  },
  onEvent: (name: string, cb: EventCb) => {
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(cb);
    return () => {
      handlers.get(name)?.delete(cb);
    };
  },
}));

import { useJorvisAssistantState } from './use-jorvis-assistant-state';

type StreamingBuf = { turnId: string; delta: string; messageId: string | null } | null;

afterEach(() => {
  handlers.clear();
  cleanup();
  vi.clearAllMocks();
});

function mountHandler() {
  const setMessages = vi.fn();
  const setOrbState = vi.fn();
  const setBusy = vi.fn();
  const setStreaming = vi.fn();
  const lastSentPromptRef = { current: null as string | null };
  const rufloReadyRef = { current: false };
  const activeTurnIdRef = { current: 't1' as string | null };
  const busyRef = { current: true };
  const streamingRef = { current: null as StreamingBuf };
  const clearWatchdog = vi.fn();

  renderHook(() =>
    useJorvisAssistantState({
      conversationId: 'c1',
      setMessages,
      setOrbState,
      setBusy,
      setStreaming,
      lastSentPromptRef,
      rufloReadyRef,
      activeTurnIdRef,
      busyRef,
      streamingRef,
      clearWatchdog,
    }),
  );

  return { setMessages, setStreaming, streamingRef };
}

describe('useJorvisAssistantState — standby commit is a sibling setState', () => {
  it('commits exactly one message even when streaming updaters are re-invoked (StrictMode)', () => {
    const { setMessages, setStreaming, streamingRef } = mountHandler();

    emit('assistant:state', {
      kind: 'delta',
      delta: 'Hello world',
      conversationId: 'c1',
      turnId: 't1',
      messageId: 'm1',
    });
    // Post-fix the handler mirrors the buffer SYNCHRONOUSLY on the ref so a
    // standby in the same tick can read the full delta.
    expect(streamingRef.current).toEqual({ turnId: 't1', delta: 'Hello world', messageId: 'm1' });

    emit('assistant:state', {
      kind: 'state',
      state: 'standby',
      conversationId: 'c1',
      turnId: 't1',
      messageId: 'm1',
    });

    // StrictMode simulation: React re-invokes FUNCTIONAL updaters. Any
    // updater handed to setStreaming must be pure — re-running it must not
    // re-fire a sibling setState. Pre-fix the commit lives INSIDE the
    // setStreaming updater, so this loop drives setMessages a second time.
    const prevBuf: StreamingBuf = { turnId: 't1', delta: 'Hello world', messageId: 'm1' };
    for (const call of setStreaming.mock.calls) {
      const arg = call[0] as unknown;
      if (typeof arg === 'function') {
        (arg as (p: StreamingBuf) => StreamingBuf)(prevBuf);
        (arg as (p: StreamingBuf) => StreamingBuf)(prevBuf);
      }
    }
    expect(setMessages).toHaveBeenCalledTimes(1);

    // The committed row carries the buffered delta; idempotency guard intact.
    const updater = setMessages.mock.calls[0][0] as (rows: ChatMessageView[]) => ChatMessageView[];
    const rows = updater([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'm1', role: 'assistant', content: 'Hello world' });
    expect(updater(rows)).toBe(rows);

    // The buffer is retired once the turn commits.
    expect(streamingRef.current).toBeNull();
    expect(setStreaming).toHaveBeenLastCalledWith(null);
  });

  it('accumulates same-tick deltas through the ref (no lost chunks)', () => {
    const { setStreaming, streamingRef } = mountHandler();
    emit('assistant:state', {
      kind: 'delta',
      delta: 'Hello ',
      conversationId: 'c1',
      turnId: 't1',
      messageId: 'm1',
    });
    emit('assistant:state', {
      kind: 'delta',
      delta: 'world',
      conversationId: 'c1',
      turnId: 't1',
      messageId: 'm1',
    });
    expect(streamingRef.current).toEqual({ turnId: 't1', delta: 'Hello world', messageId: 'm1' });
    expect(setStreaming).toHaveBeenLastCalledWith({
      turnId: 't1',
      delta: 'Hello world',
      messageId: 'm1',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.test.ts`
Expected: FAIL — test 1: `streamingRef.current` is `null` (pre-fix the hook never writes the ref) and/or `setMessages` called 2 times under the updater re-invocation loop; test 2: `streamingRef.current` is `null`. (The extra `streamingRef` arg is ignored at runtime by the pre-fix hook; vitest transpiles without typechecking, so the test runs and fails on behavior.)

- [ ] **Step 3: Implement the hook changes**

In `use-jorvis-assistant-state.ts`:

(a) Add to `UseJorvisAssistantStateArgs` (after the `busyRef` member, line ~41):

```ts
  /**
   * 2026-06-10 audit #4 — mirror of the `streaming` state. The handler writes
   * it SYNCHRONOUSLY on each delta and reads it at standby so the commit
   * happens as a SIBLING setState, never inside the setStreaming updater
   * (StrictMode/rebase re-invokes updaters; a nested setMessages re-fires —
   * previously shielded only by the rows.some idempotency guard). JorvisRoom
   * re-syncs the ref when it clears `streaming` externally (watchdog, reset).
   */
  streamingRef: React.MutableRefObject<
    { turnId: string; delta: string; messageId: string | null } | null
  >;
```

(b) Add `streamingRef` to the destructured params, AND to **both** propsRef mirrors — the `useRef({ … })` initializer (lines 75-86) and the `useLayoutEffect` body (lines 87-100). These are mirrored twins; missing one leaves the handler reading a stale/undefined ref. After the edit, verify with:

```bash
grep -n "streamingRef" src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.ts
```
Expected: hits in the interface, the params, the useRef initializer, the useLayoutEffect body, and the handler (≥5 lines).

(c) Replace the standby commit block (lines 149-166, the `p.setStreaming((prev) => { … })` call) with:

```ts
          // 2026-06-10 audit #4 — commit the streamed reply OUTSIDE any state
          // updater. The buffer is read from streamingRef (written
          // synchronously by the delta path below), so the commit is a plain
          // sibling setState and every updater stays pure.
          const buffered = p.streamingRef.current;
          if (buffered && e.messageId) {
            const messageId = e.messageId;
            p.setMessages((rows) =>
              rows.some((r) => r.id === messageId)
                ? rows
                : [
                    ...rows,
                    {
                      id: messageId,
                      role: 'assistant',
                      content: buffered.delta,
                      createdAt: Date.now(),
                    },
                  ],
            );
          }
          p.streamingRef.current = null;
          p.setStreaming(null);
```

(d) Replace the delta path (lines 168-183, the `p.setStreaming((prev) => …)` call) with:

```ts
      } else if (e.kind === 'delta' && e.delta) {
        // Phase 6 — capture the (stable) messageId carried on the delta. It's
        // the SAME id the standby-commit will assign to the committed row, so
        // ChatTranscript can key the in-flight sentinel by it → React reuses
        // the DOM node across the commit → the bubble doesn't re-spring.
        const messageId = typeof e.messageId === 'string' ? e.messageId : null;
        // Accumulate against the ref (not a functional updater): the ref is
        // the synchronous source of truth, so a standby — or a second delta —
        // in the same tick sees the full buffer, and setStreaming receives a
        // VALUE (pure under StrictMode re-invocation).
        const prev = p.streamingRef.current;
        const next =
          !prev || prev.turnId !== e.turnId
            ? { turnId: e.turnId, delta: e.delta, messageId }
            : {
                turnId: prev.turnId,
                delta: prev.delta + e.delta,
                messageId: prev.messageId ?? messageId,
              };
        p.streamingRef.current = next;
        p.setStreaming(next);
      }
```

- [ ] **Step 4: Implement the JorvisRoom wiring**

In `JorvisRoom.tsx`, insert after the `busyRef` sync effect (after line 103):

```ts
  // 2026-06-10 audit #4 — mirror of `streaming` for the assistant-state
  // handler: the standby commit reads the buffered delta from this ref as a
  // sibling setState instead of nesting setMessages inside the setStreaming
  // updater. The handler writes it synchronously per delta; this effect
  // re-syncs it when JorvisRoom clears `streaming` externally (watchdog
  // timeout, onNewConversation reset).
  const streamingRef = useRef(streaming);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);
```

And add `streamingRef,` to the `useJorvisAssistantState({ … })` call (lines 124-135), after `busyRef,`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/features/jorvis-assistant/`
Expected: PASS — the new file plus the whole jorvis suite (notably `JorvisRoom.b3.test.tsx` standby-clears-busy path and `ChatTranscript.stream.test.tsx`, which consume this commit flow).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.ts src/renderer/features/jorvis-assistant/use-jorvis-assistant-state.test.ts src/renderer/features/jorvis-assistant/JorvisRoom.tsx
git commit -m "fix(jorvis): commit streamed reply via streamingRef sibling setState, not inside setStreaming updater"
```

### Task 5: monotonic composer clear token (finding 5, LOW)

`JorvisRoom` clears the composer with `setComposerExternalValue('')`; React state dedups on identical value, so the SECOND `''` push (banner-retry or voice send via `sendPromptRef`, which bypasses the textarea) is a no-op — the user's typed-but-unsent text survives the send. Composer's sync effect (`Composer.tsx:51-61`) never re-runs. Fix: push `{ value, nonce }` objects with a monotonic nonce.

**Files:**
- Modify: `src/renderer/features/jorvis-assistant/Composer.tsx:17-32` (Props), `:51-61` (sync effect)
- Modify: `src/renderer/features/jorvis-assistant/JorvisRoom.tsx:20` (import), `:87` (state), `:163` (sendPrompt clear), `:213-221` (sendPrompt deps), `:256-260` (drop handler), `:364-366` (ribbon Apply)
- Test: Create `src/renderer/features/jorvis-assistant/Composer.test.tsx`

- [ ] **Step 1: Write the failing test file**

Create `src/renderer/features/jorvis-assistant/Composer.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// 2026-06-10 audit finding #5 — programmatic composer pushes carry a
// monotonic nonce. A bare-string externalValue dedups on Object.is, so the
// SECOND clear-to-'' (banner-retry / voice send after a previous send) is a
// silent no-op that leaves typed-but-unsent text in the textarea.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('@/renderer/lib/canDo', () => ({ useCanDo: () => false }));

import { Composer } from './Composer';

afterEach(() => cleanup());

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea[aria-label="Ask Jorvis"]');
  if (!el) throw new Error('composer textarea not found');
  return el as HTMLTextAreaElement;
}

describe('<Composer /> external push token', () => {
  it('re-clears on a nonce bump even when value is unchanged (banner-retry/voice send)', async () => {
    const onSend = vi.fn();
    const { container, rerender } = render(
      <Composer busy={false} onSend={onSend} externalValue={undefined} />,
    );
    const textarea = getTextarea(container);

    // First programmatic clear (e.g. after send #1).
    fireEvent.change(textarea, { target: { value: 'first draft' } });
    rerender(<Composer busy={false} onSend={onSend} externalValue={{ value: '', nonce: 1 }} />);
    await waitFor(() => expect(textarea.value).toBe(''));

    // The user types again; then a banner-retry/voice send clears AGAIN with
    // the SAME value (''). A string prop dedups here — the nonce must not.
    fireEvent.change(textarea, { target: { value: 'typed but unsent' } });
    rerender(<Composer busy={false} onSend={onSend} externalValue={{ value: '', nonce: 2 }} />);
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  it('an external push lands and the user can take back control by typing', async () => {
    const { container } = render(
      <Composer
        busy={false}
        onSend={vi.fn()}
        externalValue={{ value: 'from ribbon', nonce: 1 }}
      />,
    );
    const textarea = getTextarea(container);
    await waitFor(() => expect(textarea.value).toBe('from ribbon'));
    fireEvent.change(textarea, { target: { value: 'edited by user' } });
    expect(textarea.value).toBe('edited by user');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/jorvis-assistant/Composer.test.tsx`
Expected: FAIL — pre-fix Composer's effect guards `typeof externalValue !== 'string'`, so the object push is ignored and the first `waitFor(value === '')` times out (`expected 'first draft' to be ''`).

- [ ] **Step 3: Implement the Composer change**

In `Composer.tsx`:

(a) Above the `Props` interface, add the exported type, and change the `externalValue` prop:

```ts
/** 2026-06-10 audit #5 — a programmatic composer push. The `nonce` is a
 *  monotonic token: bump it on EVERY push so consecutive pushes of the same
 *  string (clearing to '' after each send) still apply — a bare string prop
 *  dedups on Object.is and leaves typed-but-unsent text in the textarea. */
export interface ComposerExternalValue {
  value: string;
  nonce: number;
}
```

and in `Props` replace

```ts
  externalValue?: string;
```

with

```ts
  externalValue?: ComposerExternalValue;
```

(b) Replace the sync effect (lines 51-61) with:

```ts
  // Phase 4 Track C — sync controlled value pushes (ribbon Apply, pane-context
  // drop, post-send clear). Each push is a fresh `{value, nonce}` object so
  // the dep changes — and the effect re-fires — even when `value` repeats.
  // Timeout-deferred so the lint rule `react-hooks/set-state-in-effect` is
  // satisfied; the parent only pushes on user actions so the hop is invisible.
  useEffect(() => {
    if (!externalValue) return;
    let alive = true;
    const id = window.setTimeout(() => {
      if (alive) setValue(externalValue.value);
    }, 0);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [externalValue]);
```

- [ ] **Step 4: Implement the JorvisRoom call sites (grep-the-twins: there are THREE push sites)**

In `JorvisRoom.tsx`:

(a) Line 20 — import the type:

```ts
import { Composer, type ComposerExternalValue } from './Composer';
```

(b) Line 87 — replace the state declaration and add the push helper directly below it:

```ts
  const [composerExternalValue, setComposerExternalValue] = useState<
    ComposerExternalValue | undefined
  >(undefined);
  /** 2026-06-10 audit #5 — every programmatic composer push goes through
   *  here. The nonce bump makes consecutive identical pushes (clearing to ''
   *  after a banner-retry/voice send) distinct, so Composer always re-syncs. */
  const pushComposerValue = useCallback((value: string) => {
    setComposerExternalValue((prev) => ({ value, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
```

(c) Replace ALL THREE push sites (verify the count with `grep -n "setComposerExternalValue(" src/renderer/features/jorvis-assistant/JorvisRoom.tsx` — after this edit the only remaining caller must be `pushComposerValue` itself):
- `sendPrompt` (line 163): `setComposerExternalValue('');` → `pushComposerValue('');`
- `handleComposerDrop` (line 259): `setComposerExternalValue(ctx);` → `pushComposerValue(ctx);`
- PatternRibbon `onApply` (line 365): `setComposerExternalValue(patternHit.pattern);` → `pushComposerValue(patternHit.pattern);`

(d) Add `pushComposerValue` to `sendPrompt`'s dependency array (lines 213-221), after `clearWatchdog,`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/features/jorvis-assistant/`
Expected: PASS (Composer.test.tsx + the room suites, which drive sends through the composer).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/features/jorvis-assistant/Composer.tsx src/renderer/features/jorvis-assistant/Composer.test.tsx src/renderer/features/jorvis-assistant/JorvisRoom.tsx
git commit -m "fix(jorvis): monotonic composer clear token so repeat clears are not deduped"
```

### Task 6: coalesce overlapping live-stats polls — BOTH mirrored sites (finding 6, LOW)

Both pollers run a 3s `setInterval` over un-coalesced async `poll()` calls. A slow RPC stacks overlapping polls that resolve out of order → stale `setStats` and a corrupted tok/s baseline (`prevOutputTokensRef` written out of order). Fix: an in-flight flag that SKIPS overlapping ticks, placed entirely INSIDE `poll()` so it survives — or is trivially subsumed by — the perf-hot-paths poller restructure (see Coordination notes).

**Files:**
- Modify: `src/renderer/features/command-room/usePaneLiveStats.ts:119-175` (wrap poll body)
- Modify: `src/renderer/features/right-rail/useSwarmLiveStats.ts:57-98` (wrap poll body — mirrored twin)
- Test: `src/renderer/features/command-room/usePaneLiveStats.test.ts` (append)
- Test: Create `src/renderer/features/right-rail/useSwarmLiveStats.test.ts`

- [ ] **Step 1: Write the failing pane-stats test**

In `usePaneLiveStats.test.ts`, add a deferred helper after `makeSummary` (line ~52):

```ts
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
```

Append inside `describe('usePaneLiveStats', …)`:

```ts
  // ── overlap coalescing (2026-06-10 audit #6) ────────────────────────────────

  it('skips interval ticks while the previous poll is still in flight (drift guard)', async () => {
    const slow = deferred<UsageSummary>();
    sessionSummaryMock
      .mockReturnValueOnce(slow.promise) // poll #1 hangs on a slow RPC
      .mockResolvedValue(makeSummary({ turnCount: 1, outputTokens: 600, totalCostUsd: 0.02 }));

    const { result } = renderHook(() => usePaneLiveStats('sess-overlap', true));

    await tickMs(0); // immediate poll #1 dispatched (now pending)
    expect(sessionSummaryMock).toHaveBeenCalledTimes(1);

    // Two interval ticks fire while #1 is STILL pending — they must be
    // skipped, not stacked (pre-fix: 3 calls; overlapping resolutions land
    // out of order and corrupt the prevOutputTokensRef tok/s baseline).
    await tickMs(3_000);
    await tickMs(3_000);
    expect(sessionSummaryMock).toHaveBeenCalledTimes(1);

    // The slow poll lands; its stats apply.
    slow.resolve(makeSummary({ turnCount: 1, outputTokens: 300, totalCostUsd: 0.01 }));
    await tickMs(0);
    expect(result.current.totalCostUsd).toBe(0.01);

    // Polling resumes on the next tick.
    await tickMs(3_000);
    expect(sessionSummaryMock).toHaveBeenCalledTimes(2);
    expect(result.current.totalCostUsd).toBe(0.02);
  });
```

- [ ] **Step 2: Write the failing swarm-stats test file (mirrored site)**

Create `src/renderer/features/right-rail/useSwarmLiveStats.test.ts`:

```ts
// @vitest-environment jsdom
//
// 2026-06-10 audit #6 — useSwarmLiveStats mirrors usePaneLiveStats (same 3s
// interval, same delta derivation) and shares the same overlap bug: ticks
// must be SKIPPED while a poll is in flight, or out-of-order resolutions
// corrupt the per-session token baselines. Test style mirrors
// usePaneLiveStats.test.ts (fake timers + advanceTimersByTimeAsync).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const sessionSummaryMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    usage: {
      sessionSummary: (...args: unknown[]) => sessionSummaryMock(...args),
    },
  },
}));

import { useSwarmLiveStats } from './useSwarmLiveStats';

interface SummaryShape {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number | null;
  turnCount: number;
}

function makeSummary(overrides: Partial<SummaryShape> = {}): SummaryShape {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: null,
    turnCount: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function tickMs(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useSwarmLiveStats — overlap coalescing (2026-06-10 audit #6)', () => {
  it('skips interval ticks while the previous poll is still in flight (drift guard)', async () => {
    const slow = deferred<SummaryShape>();
    sessionSummaryMock
      .mockReturnValueOnce(slow.promise) // poll #1 hangs
      .mockResolvedValue(makeSummary({ turnCount: 1, outputTokens: 600 }));

    renderHook(() => useSwarmLiveStats(['s1'], true));

    await tickMs(0);
    expect(sessionSummaryMock).toHaveBeenCalledTimes(1);

    await tickMs(3_000);
    await tickMs(3_000);
    // Pre-fix: 3 — every tick stacked another in-flight poll.
    expect(sessionSummaryMock).toHaveBeenCalledTimes(1);

    slow.resolve(makeSummary({ turnCount: 1, outputTokens: 300 })); // seeds the baseline
    await tickMs(0);

    await tickMs(3_000);
    expect(sessionSummaryMock).toHaveBeenCalledTimes(2);
  });

  it('seeds the baseline without a delta, then reports the genuine next-poll delta', async () => {
    sessionSummaryMock
      .mockResolvedValueOnce(makeSummary({ turnCount: 1, outputTokens: 300 })) // seed
      .mockResolvedValueOnce(makeSummary({ turnCount: 1, outputTokens: 600 })); // +300

    const { result } = renderHook(() => useSwarmLiveStats(['s1'], true));

    await tickMs(0);
    expect(result.current.hasData).toBe(true);
    expect(result.current.swarmTokenDelta).toBe(0); // M2 seed — no bogus lifetime spike

    await tickMs(3_000);
    expect(result.current.swarmTokenDelta).toBe(300);
  });
});
```

- [ ] **Step 3: Run both to verify the overlap tests fail**

Run: `npx vitest run src/renderer/features/command-room/usePaneLiveStats.test.ts src/renderer/features/right-rail/useSwarmLiveStats.test.ts`
Expected: FAIL — both overlap tests: `expected "spy" to be called 1 times, but got 3 times`. (The swarm baseline-seed test passes pre-fix — it pins existing M2 behavior the guard must not break.)

- [ ] **Step 4: Implement the guard at BOTH sites**

In `usePaneLiveStats.ts`, inside the effect (line 119), insert `let inFlight = false;` on the line above `async function poll()`, and wrap the ENTIRE existing poll body (everything from `let summary: UsageSummary | null = null;` through the final `setStats({ … });`, re-indented one level) in the guard:

```ts
    let inFlight = false;
    async function poll(): Promise<void> {
      // 2026-06-10 audit #6 — coalescing guard. A slow RPC + the 3s interval
      // stack overlapping polls that resolve OUT OF ORDER → stale setStats and
      // a corrupted tok/s baseline (prevOutputTokensRef written out of order).
      // Skip the tick; the next interval re-polls. MINIMAL by design: the
      // guard lives entirely inside poll() so the perf-hot-paths shared-poller
      // restructure can port or subsume it without touching the hook contract.
      if (inFlight) return;
      inFlight = true;
      try {
        // …existing body, unchanged, re-indented…
      } finally {
        inFlight = false;
      }
    }
```

The `try/finally` is required: the existing body has early `return`s (`!alive`, `!summary`, `!hasData`) that must still release the flag.

In `useSwarmLiveStats.ts`, apply the IDENTICAL pattern inside its effect (line 57): `let inFlight = false;` above `async function poll()`, then `if (inFlight) return; inFlight = true; try { …existing body from "let totalDelta = 0;" through "setStats({ … });"… } finally { inFlight = false; }`. Same comment, citing the same audit finding and the mirrored-site relationship.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/features/command-room/usePaneLiveStats.test.ts src/renderer/features/right-rail/useSwarmLiveStats.test.ts`
Expected: PASS — all pre-existing usePaneLiveStats tests (status gate, tok/s math, unmount) plus the new overlap guards.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/features/command-room/usePaneLiveStats.ts src/renderer/features/command-room/usePaneLiveStats.test.ts src/renderer/features/right-rail/useSwarmLiveStats.ts src/renderer/features/right-rail/useSwarmLiveStats.test.ts
git commit -m "fix(command-room): coalesce overlapping live-stats polls at both mirrored sites (pane + swarm)"
```

### Task 7: grep-the-siblings sweep + full gate

The repo's recurring failure mode is fixing ONE of N mirrored sites. Sweep for the two bug classes fixed above before gating.

**Files:** read-only sweep (fix + test any offender found, same patterns as Tasks 1-2).

- [ ] **Step 1: Sweep all other useSyncExternalStore stores for in-place snapshot mutation**

Run:
```bash
grep -rln "useSyncExternalStore" src/renderer --include='*.ts' --include='*.tsx'
```
Expected files (baseline): `app/state.hook.ts`, `command-room/useRufloDaemonHealth.ts`, `jorvis-assistant/use-jorvis-pane-events.ts`, `right-rail/RightRail.tsx`, `notifications/NotificationBell.tsx`, `notifications/NotificationDropdown.tsx`, `lib/use-git-status-poll.ts`, `lib/use-git-activity-poll.ts`, `top-bar/RoomsMenuButton.tsx`, `lib/use-breakpoint.ts`, `tasks/TasksRoom.selectors.test.tsx`. For each store, verify `getSnapshot` never returns a collection/object that is mutated in place before notify:

```bash
for f in $(grep -rln "useSyncExternalStore" src/renderer --include='*.ts' --include='*.tsx'); do echo "== $f"; grep -n "\.push(\|\.splice(\|\.pop(\|\.shift(\|\.unshift(" "$f"; done
```
Expected (verified at plan time): no hits in any store file — `use-jorvis-pane-events.ts` was the only copy-on-write offender, fixed in Task 1. If a new offender appears (concurrent lanes add stores), apply the Task 1 copy-on-write pattern + an identity-assertion test, commit as `fix(<area>): copy-on-write store snapshot for useSyncExternalStore`.

- [ ] **Step 2: Sweep for other unguarded async setStates in the cluster**

Run:
```bash
grep -rn "useCallback(async\|void (async" src/renderer/features/jorvis-assistant src/renderer/features/command-room src/renderer/features/right-rail --include='*.ts' --include='*.tsx' | grep -v test
```
For each hit, eyeball: does an awaited result feed a setState with neither an `alive` flag nor a request token? Known-guarded after this plan: `use-jorvis-conversations.ts` (token), `usePaneLiveStats.ts`/`useSwarmLiveStats.ts` (alive + coalesce). Check at minimum: `use-jorvis-ruflo-health.ts`, `use-jorvis-pattern-probe.ts`, `use-jorvis-resume-flow.ts`, `use-jorvis-dispatch-echo.ts`, `useRufloDaemonHealth.ts`. Any REAL out-of-order-paint bug found: do NOT scope-creep this plan — capture it via the wishlist skill (WISHLIST.md) with file:line and the reproduction reasoning.

- [ ] **Step 3: Run the full gate (NO local e2e — CI's e2e-matrix owns that)**

Run, in order:
```bash
npx tsc -b
npx eslint . --max-warnings 0
npx vitest run
npm run product:check
```
Expected: all green. `tsc -b` typechecks the test files too (worktree/lane tsc is laxer — this is the authoritative check). Do NOT run `npx playwright test` locally — it launches competing Electron windows on the operator's machine; the PR's CI e2e-matrix covers it.

- [ ] **Step 4: Push the branch and open a PR (do not merge to main directly)**

```bash
git push -u origin fix/jorvis-renderer-audit-2026-06-10
```
Then open a PR titled `fix(jorvis): renderer correctness cluster — 2026-06-10 audit findings 1-6` summarizing the six findings, and let CI (incl. e2e-matrix) gate the merge.

---

## Coordination notes

1. **perf-hot-paths poller overlap (sibling plan).** That plan restructures `usePaneLiveStats`/`useSwarmLiveStats` into a shared refcounted, visibility-paused poller. Task 6 is deliberately the MINIMAL correctness guard — a `let inFlight` flag + `try/finally` entirely inside `poll()`, no hook-contract or interval changes — so it either ports verbatim into the shared poller's tick function (one `inFlight` per poll source) or is subsumed by an equivalent built-in guard. The two drift-guard tests assert only on RPC call counts and returned stats, so they survive the restructure as long as the hooks' return shapes hold; if the restructure replaces the hooks outright, move the tests to the shared poller and keep the same assertions. Whichever plan lands second resolves the (small, mechanical) conflict inside `poll()`.
2. **perf-render owns the JorvisRoom selector + ChatRow memo.** Tasks 4 and 5 touch `JorvisRoom.tsx` in three small, additive spots (a `streamingRef` + sync effect after the `busyRef` block; the `composerExternalValue` state shape + `pushComposerValue` helper; three call-site renames). No selector or transcript-row changes. Expect at most trivial merge conflicts in the JorvisRoom state-declaration block; land order doesn't matter, but whoever merges second re-runs `npx vitest run src/renderer/features/jorvis-assistant/`.
3. **ChatTranscript WIP hazard.** This plan was written against committed state (`git show HEAD:…`, main @ `a4156ac`) per the audit instruction; the tree was clean at plan time, but this repo's shared working tree gets stomped by concurrent sessions, so Task 0 re-verifies before any edit. This plan must NEVER modify or stage `ChatTranscript.tsx` / `ChatTranscript.stream.test.tsx`. Contracts relied on from ChatTranscript: the exported `ChatMessageView` type (Task 4 test) and the `streaming={ turnId, delta, messageId } | null` + `pending` props (Task 4 leaves the values JorvisRoom passes unchanged). If working-tree WIP changes either contract, re-validate Tasks 4-5 against the working-tree copy before executing them.
4. **Execution isolation.** Per repo memory (concurrent-tree stomp), execute on a fresh branch off `origin/main` (Task 0 Step 3) — or an isolated worktree if the shared tree is hot — commit atomically per task, and push promptly.

## Self-review

Checked the plan against the audit spec with fresh eyes; fixes applied inline:

- **Spec coverage:** findings 1-6 → Tasks 1-6; grep-the-siblings → Task 7 (both requested sweeps: other useSyncExternalStore stores, other unguarded async setStates); gate = `tsc -b` / `eslint --max-warnings 0` / `vitest run` / `product:check`, NO local e2e; coordination notes cover all three requested items. **No finding refuted** — all six verified against `main` @ `a4156ac` during plan research.
- **Finding-3 design trap fixed at plan time:** cancelling the rAF chain in the original `[conversationId]`-dep'd effect cleanup would self-cancel mid-jump (the jump's hydrate changes `conversationId`); the implementation moves `conversationId` onto a ref so the subscription — and the retry chain — survive, while unmount/supersede still cancel.
- **Finding-4 timing hole fixed at plan time:** an effect-mirrored `streamingRef` alone could miss the last delta if delta+standby land in one tick; the handler therefore writes the ref synchronously on the delta path (test 2 pins same-tick accumulation), and JorvisRoom's effect only re-syncs external clears.
- **Placeholder scan:** every code step carries complete code; the two "existing body, re-indented" wrappers in Task 6 reference exact start/end lines of unchanged code, with the early-return/`try-finally` interaction called out.
- **Type consistency:** `ComposerExternalValue { value; nonce }` matches between Composer.tsx, JorvisRoom usage, and Composer.test.tsx; `streamingRef`'s type matches `UseJorvisAssistantStateArgs`, the JorvisRoom `useRef(streaming)` initialization, and the test's `StreamingBuf`; the Task 2 test's envelope shape matches `invokeSideBand`'s `{ok,data}` contract and `ConvGet`'s `{conversation, messages}` consumption.
- **Pre-fix failure modes stated per test** so the executor can distinguish "correct red" from harness breakage.
