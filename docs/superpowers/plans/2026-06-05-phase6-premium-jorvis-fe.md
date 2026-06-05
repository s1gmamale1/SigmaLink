# Phase 6 — Premium Jorvis FE (streamed reveal · spring bubbles · inline tool chips) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (this is a sequential single-surface feature — `ChatTranscript.tsx` is the shared hub, so tasks run in order, not in parallel). Steps use checkbox (`- [ ]`) syntax.

**Goal:** A Jorvis reply feels premium — text reveals smoothly with a caret, each bubble springs in once, and in-flight tool calls show as inline chips; reduce-motion shows instant text; a hung turn still clears via the existing watchdog.

**Architecture:** Pure **renderer** work over the existing IPC contract. The backend already emits `assistant:state` `{kind:'delta'}` events (text accumulates in `use-jorvis-assistant-state.ts` → `streaming:{turnId,delta}`) and `assistant:tool-trace` events. We add a rAF **catch-up reveal** hook that paces the accumulated text on screen, a **first-mount-only spring** on each bubble (reusing the CSS spring system), and an **inline tool-chip rail**. No new animation library — reuse `src/renderer/lib/motion.ts` + the `--ease-snappy`/`animate-sl-*` tokens. Reduce-motion is honored by the existing global CSS safety-net + `prefersReducedMotion()` branch.

**Tech Stack:** React 19 (ref-as-prop, no `forwardRef`), `useSyncExternalStore`-free local rAF, vitest + @testing-library/react, Tailwind `animate-sl-*` + `src/index.css` spring `linear()` tokens.

---

## ⚠️ Recon-corrected scope (do NOT over-build)

- **Backend incremental-delta emit is already in place** (`assistant:state`/`kind:'delta'` from `core/assistant/runClaudeCliTurn.emit.ts` `emitDelta`; final commit via `kind:'final'`/`standby`). The CLI yields complete blocks per JSONL line, not tokens — token-level streaming is a CLI limitation, NOT something to build. **No backend change is required for the visual goal**; the renderer rAF reveal produces the token-by-token feel from the accumulated text. (Optional, deferred: add a `seq?` ordering field — YAGNI; Electron IPC is per-channel ordered.)
- **Watchdogs exist** — backend `TURN_TIMEOUT_MS=90_000` (idle, re-armed per line) + renderer `JorvisRoom` `TURN_WATCHDOG_MS=120_000`. The DoD's "hung turn still clears" is already satisfied — **do not break it**; the reveal hook must clear its rAF on `standby`/`error`/unmount.
- **Tool trace exists** — `assistant:tool-trace` (consumed today only by the global `ToolCallInspector` panel). The inline chips subscribe to the SAME event scoped to the active turn; leave `ToolCallInspector` untouched.

## Apple-motion bar (from apple-design-motion)
- **Springs, not easing** — bubble-enter reuses `animate-sl-slide-up` / `sl-pop-in` (both built on `--ease-snappy`, a spring `linear()` curve). Animate **transform/opacity only** (GPU); never layout props.
- **First-mount only** — a bubble springs once on mount, never on subsequent re-renders (React-19: pass `ref` as a prop, `useLayoutEffect([])` + a `playedRef`).
- **Token reveal = damped catch-up** — a rAF loop advances a reveal cursor toward the accumulated length at a capped rate (smooth the read; never block input). A caret (`▍`) trails the revealed text while in-flight.
- **Honor `prefers-reduced-motion`** — the reveal hook returns the full text instantly with no caret when reduced; the CSS global safety-net already collapses the spring to 0.01ms. Provide the instant alternative, not the big move.

## File map

| File | New? | Responsibility |
|------|------|----------------|
| `src/renderer/features/jorvis-assistant/use-jorvis-stream-reveal.ts` | **new** | rAF catch-up reveal hook (`{revealed, caret}`) + reduce-motion instant branch |
| `src/renderer/features/jorvis-assistant/ChatTranscript.tsx` | exists | wire the reveal hook for the in-flight row only (turnId scope) + first-mount spring on `ChatRow` + mount the chip rail |
| `src/renderer/features/jorvis-assistant/InlineToolChips.tsx` | **new** | per-turn inline tool-chip rail (subscribes to `assistant:tool-trace` scoped to conversationId+turnId) |
| `src/renderer/features/jorvis-assistant/JorvisRoom.tsx` | exists | 1-line: pass the `streaming` object (turnId+delta) to `ChatTranscript` instead of the bare `streamingDelta` string |

> Tasks 2–4 all edit `ChatTranscript.tsx` → **sequential, one worktree**. Do Task 1 (isolated new hook) → 2 → 3 → 4 in order.

---

### Task 1: `use-jorvis-stream-reveal.ts` — rAF catch-up reveal hook (TDD, isolated)

**Files:**
- Create: `src/renderer/features/jorvis-assistant/use-jorvis-stream-reveal.ts`
- Test: `src/renderer/features/jorvis-assistant/use-jorvis-stream-reveal.test.ts`

- [ ] **Step 1: Write the failing test** (drive rAF via a fake; reduced-motion is mocked off):

```ts
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useJorvisStreamReveal } from './use-jorvis-stream-reveal';

vi.mock('@/renderer/lib/motion', () => ({ prefersReducedMotion: () => false }));

let raf: ((t: number) => void)[] = [];
beforeEach(() => {
  raf = [];
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { raf.push(cb); return raf.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());
const flush = (n: number) => { for (let i = 0; i < n; i++) { const cbs = raf; raf = []; cbs.forEach((cb) => cb(0)); } };

describe('useJorvisStreamReveal', () => {
  it('reveals progressively, not all at once, while active', () => {
    const { result, rerender } = renderHook(({ text, active }) => useJorvisStreamReveal(text, active), {
      initialProps: { text: 'hello world', active: true },
    });
    expect(result.current.revealed.length).toBe(0);
    act(() => flush(1));
    const afterOne = result.current.revealed.length;
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan('hello world'.length); // capped per frame — NOT instant
    act(() => flush(20));
    expect(result.current.revealed).toBe('hello world');
    expect(result.current.caret).toBe(true); // caret shows while active
  });

  it('jumps to full + no caret once inactive (turn done)', () => {
    const { result, rerender } = renderHook(({ text, active }) => useJorvisStreamReveal(text, active), {
      initialProps: { text: 'done text', active: true },
    });
    act(() => { rerender({ text: 'done text', active: false }); flush(1); });
    expect(result.current.revealed).toBe('done text');
    expect(result.current.caret).toBe(false);
  });
});
```

- [ ] **Step 2: Add the reduced-motion test**:

```ts
it('reduced-motion → instant full text, no caret, no rAF', async () => {
  vi.resetModules();
  vi.doMock('@/renderer/lib/motion', () => ({ prefersReducedMotion: () => true }));
  const { useJorvisStreamReveal: hook } = await import('./use-jorvis-stream-reveal');
  const { result } = renderHook(() => hook('instant!', true));
  expect(result.current.revealed).toBe('instant!');
  expect(result.current.caret).toBe(false);
  expect(raf.length).toBe(0);
});
```

- [ ] **Step 3: Run — expect FAIL** (module missing).

Run: `npx vitest run src/renderer/features/jorvis-assistant/use-jorvis-stream-reveal.test.ts`
Expected: FAIL "Cannot find module './use-jorvis-stream-reveal'".

- [ ] **Step 4: Implement**:

```ts
import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/renderer/lib/motion';

// chars revealed per frame; capped so a huge block still feels like typing, not a dump.
const MIN_PER_FRAME = 2;
const CATCHUP_FRACTION = 0.18; // reveal ~18% of the remaining gap each frame → eases as it catches up

export interface StreamReveal { revealed: string; caret: boolean; }

export function useJorvisStreamReveal(fullText: string, active: boolean): StreamReveal {
  const reduced = prefersReducedMotion();
  const [count, setCount] = useState(reduced || !active ? fullText.length : 0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced || !active) { setCount(fullText.length); return; }
    const tick = () => {
      setCount((c) => {
        if (c >= fullText.length) { rafRef.current = null; return c; }
        const gap = fullText.length - c;
        const step = Math.max(MIN_PER_FRAME, Math.ceil(gap * CATCHUP_FRACTION));
        const next = Math.min(fullText.length, c + step);
        rafRef.current = requestAnimationFrame(tick);
        return next;
      });
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); rafRef.current = null; };
  }, [fullText, active, reduced]);

  const revealed = reduced || !active ? fullText : fullText.slice(0, count);
  const caret = active && !reduced && count < fullText.length;
  return { revealed, caret };
}
```

- [ ] **Step 5: Run — expect PASS**, then `npx tsc -b`, then commit:

```bash
git add src/renderer/features/jorvis-assistant/use-jorvis-stream-reveal.*
git commit -m "feat(jorvis): rAF catch-up stream-reveal hook (reduce-motion instant)"
```

**Note:** `caret` going false exactly when `count >= length` (mid-stream pauses between blocks) is acceptable — the caret reappears when more delta arrives and `count < length` again. The `active` flag (from `streaming !== null`) is the authoritative in-flight gate.

---

### Task 2: wire the reveal into `ChatTranscript.tsx` for the in-flight row only (TDD)

The current `streamingDelta` string is appended to every assistant row (works only because the in-flight row has `content === ""`). Scope it to the active turn and route it through the reveal hook + render the caret.

**Files:**
- Modify: `src/renderer/features/jorvis-assistant/ChatTranscript.tsx`
- Modify: `src/renderer/features/jorvis-assistant/JorvisRoom.tsx` (pass `streaming` object, not the bare string)
- Test: `src/renderer/features/jorvis-assistant/ChatTranscript.stream.test.tsx` (new)

- [ ] **Step 1: Write the failing test** — render the transcript with an in-flight streaming row, assert the in-flight row reveals progressively while a completed assistant row renders its full content:

```tsx
import { render, act } from '@testing-library/react';
// fake rAF as in Task 1; pass messages=[{role:'assistant',content:'older',...}] + streaming={turnId:'t1',delta:'new reply'}
// assert: the older row shows 'older' in full immediately; the in-flight row reveals 'new reply' across frames + shows a caret element ([data-caret])
```

- [ ] **Step 2: Run — expect FAIL** (no caret element / reveals instantly today).

Run: `npx vitest run src/renderer/features/jorvis-assistant/ChatTranscript.stream.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Change `ChatTranscript` props + `ChatRow`** — replace `streamingDelta?: string` with `streaming?: { turnId: string; delta: string } | null`. In the `messages.map`, mark the row that is the in-flight assistant turn (the last assistant row while `streaming` is non-null — matching today's `content === ''` convention, but now gated by an explicit `isStreaming` boolean). For that row only, call `useJorvisStreamReveal(streaming.delta, true)` and render `revealed` + a `<span data-caret className="sl-caret">▍</span>` when `caret`. All other rows render `message.content` directly.

> `ChatRow` is an inline `function` today; to call a hook it must be a real component. Extract `ChatRow` to a named component `function ChatRow(props) { … }` (already a function — just ensure hooks are top-level, not conditional: always call `useJorvisStreamReveal(delta, isStreaming)` with `isStreaming=false` for non-streaming rows so the hook order is stable).

- [ ] **Step 4: Update `JorvisRoom.tsx`** — pass `streaming={streaming}` to `<ChatTranscript>` (the `{turnId,delta}|null` object already in state) instead of `streamingDelta={streaming?.delta}`.

- [ ] **Step 5: Add a `.sl-caret` blink** to `src/index.css` (reduced-motion-safe — the global safety-net already neutralizes it; add an explicit `motion-reduce:hidden` too):

```css
@keyframes sl-caret-blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
.sl-caret { display:inline-block; width:0.5ch; animation: sl-caret-blink 1s steps(1) infinite; }
```

- [ ] **Step 6: Run the test + the existing Jorvis suite + tsc**:

Run: `npx vitest run src/renderer/features/jorvis-assistant/ && npx tsc -b`
Expected: PASS (incl. the existing `JorvisRoom.b3.test.tsx` — the streaming/turnId/standby commit must still work).

- [ ] **Step 7: Commit**:

```bash
git add src/renderer/features/jorvis-assistant/ChatTranscript.tsx src/renderer/features/jorvis-assistant/JorvisRoom.tsx src/renderer/features/jorvis-assistant/ChatTranscript.stream.test.tsx src/index.css
git commit -m "feat(jorvis): stream-reveal the in-flight reply with a caret (turnId-scoped)"
```

---

### Task 3: first-mount-only spring bubble-enter on `ChatRow` (TDD)

**Files:**
- Modify: `src/renderer/features/jorvis-assistant/ChatTranscript.tsx`
- Test: extend `ChatTranscript.stream.test.tsx`

- [ ] **Step 1: Write the failing test** — a newly-mounted `ChatRow` wrapper gets the enter-animation class exactly once; a re-render (e.g. a streaming delta) does NOT re-add/re-trigger it:

```tsx
it('springs a bubble in on first mount only', () => {
  const { getByTestId, rerender } = render(/* transcript with one assistant row */);
  const row = getByTestId('chat-row-m1');
  expect(row.className).toContain('sl-slide-up'); // applied on mount
  // force a re-render (new streaming delta) and assert the class isn't re-applied/re-animated
  rerender(/* same row, +1 delta */);
  expect(row.dataset.entered).toBe('1'); // playedRef marker — proves it didn't replay
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — React-19 ref-as-prop on the `ChatRow` wrapper `<div>` + `useLayoutEffect([])` that adds `animate-sl-slide-up` once and sets `dataset.entered='1'` via a `playedRef`:

```tsx
function ChatRow({ message, /* … */ }: ChatRowProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);   // React 19: passed as ref={rootRef}, no forwardRef
  const played = useRef(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || played.current) return;
    played.current = true;
    el.classList.add('animate-sl-slide-up'); // transform+opacity; --ease-snappy; CSS safety-net handles reduce-motion
    el.dataset.entered = '1';
  }, []); // first mount only
  return <div ref={rootRef} data-testid={`chat-row-${message.id}`} /* … */>{/* … */}</div>;
}
```

(`animate-sl-slide-up` already exists in `tailwind.config.js`/`index.css`: `transform: translateY(12px)→0` + fade, `--ease-snappy`. Reduce-motion is auto-collapsed by the `index.css:740` safety-net — no extra branch needed, but the test asserts the class is present regardless since the reduce gate is in CSS.)

- [ ] **Step 4: Run + tsc + commit**:

Run: `npx vitest run src/renderer/features/jorvis-assistant/ && npx tsc -b`

```bash
git add src/renderer/features/jorvis-assistant/ChatTranscript.tsx src/renderer/features/jorvis-assistant/ChatTranscript.stream.test.tsx
git commit -m "feat(jorvis): first-mount-only spring bubble-enter (React-19 ref-as-prop)"
```

---

### Task 4: `InlineToolChips.tsx` — per-turn inline tool-chip rail (TDD)

**Files:**
- Create: `src/renderer/features/jorvis-assistant/InlineToolChips.tsx`
- Modify: `src/renderer/features/jorvis-assistant/ChatTranscript.tsx` (mount the rail under the active assistant turn)
- Test: `src/renderer/features/jorvis-assistant/InlineToolChips.test.tsx` (new)

- [ ] **Step 1: Write the failing test** — emit two `assistant:tool-trace` events for the active turn; assert two chips render with tool name + a status dot; an event for a DIFFERENT turnId is ignored:

```tsx
// reuse the JorvisRoom.b3.test.tsx onEvent/emitEvent mock pattern for '@/renderer/lib/rpc'
it('renders a chip per tool-trace for the active turn, ignores other turns', () => {
  const { getAllByTestId, queryByText } = render(<InlineToolChips conversationId="c1" turnId="t1" />);
  act(() => emitEvent('assistant:tool-trace', { conversationId: 'c1', turnId: 't1', name: 'Read', status: 'ok', durationMs: 12 }));
  act(() => emitEvent('assistant:tool-trace', { conversationId: 'c1', turnId: 't9', name: 'Bash', status: 'ok' })); // other turn
  expect(getAllByTestId('tool-chip')).toHaveLength(1);
  expect(queryByText('Bash')).toBeNull();
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement** `InlineToolChips.tsx` — `onEvent('assistant:tool-trace', …)` subscription filtered to `conversationId+turnId`, accumulate into local state, render compact pills (name + `ok`/`error` dot + `durationMs`), each with `animate-sl-pop-in`. **Verify the real `assistant:tool-trace` payload shape** against `core/assistant/runClaudeCliTurn.trajectory.ts` `traceToolUse` before finalizing field names (recon flagged the envelope has `name`, tool `id`, `input`; confirm the emitted trace's `status`/`durationMs` keys). Clean up the subscription on unmount.

- [ ] **Step 4: Mount in `ChatTranscript.tsx`** — render `<InlineToolChips conversationId turnId />` inside/under the active in-flight assistant `ChatRow` only (same `isStreaming` gate as Task 2). Historical turns keep using stored `role==='tool'` messages; `ToolCallInspector` (global panel) stays untouched.

- [ ] **Step 5: Run + tsc + commit**:

Run: `npx vitest run src/renderer/features/jorvis-assistant/ && npx tsc -b`

```bash
git add src/renderer/features/jorvis-assistant/InlineToolChips.tsx src/renderer/features/jorvis-assistant/ChatTranscript.tsx src/renderer/features/jorvis-assistant/InlineToolChips.test.tsx
git commit -m "feat(jorvis): inline per-turn tool-chip rail (assistant:tool-trace, turn-scoped)"
```

---

## Final gate (in main after merge)

- [ ] `npm run lint` (Phase-2 lesson: a lint-only error slipped my last gate — run lint explicitly).
- [ ] `npx tsc -b` · `npm test` (full vitest) · `npm run build`.
- [ ] `npx playwright test tests/e2e/` — confirm `JorvisRoom`/assistant smokes still pass and a hung turn still clears (watchdog).
- [ ] Manual feel check (or perf): a live reply reveals smoothly with a caret; bubbles spring once; tool calls chip in; toggle OS reduce-motion → instant text, no caret, no spring.

## Self-review checklist
1. **DoD coverage:** streamed reveal+caret (T1–T2) ✅ · first-mount spring (T3) ✅ · inline tool chips (T4) ✅ · reduce-motion instant (T1 + CSS safety-net) ✅ · hung turn clears (untouched watchdogs; reveal rAF cleaned on unmount/inactive) ✅.
2. **No over-build:** backend left as-is (delta contract already exists — the ROADMAP's "today whole blocks" was stale; deltas already emit, CLI just can't go finer than blocks).
3. **Motion discipline:** transform/opacity only; springs via existing `--ease-snappy`; first-mount-only; reduce-motion path present.
4. **Hook order stability:** `useJorvisStreamReveal` called unconditionally per row (with `active=false` for non-streaming) so React hook order never varies.

## Definition of done (ROADMAP)
A live reply streams token-by-token with a caret, bubbles spring once, tool calls render as chips; reduce-motion shows instant text; a hung turn still clears via the watchdog; gates green (lint · tsc · vitest · build · e2e).
