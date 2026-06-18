# Pane Auto-Scroll Robustness + Jump-to-Bottom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DOM-presenter pane reliably follow streaming output to the bottom, and add a floating "↓" button to return to the live bottom after scrolling up.

**Architecture:** Extract the stick-to-bottom logic from `FlowView` into a focused, unit-testable hook `use-stick-to-bottom.ts` with a pure decision function `computeStick`. The hook adds three fixes the inline version lacked: `overflow-anchor: none` on the scroll container (stop Chromium scroll-anchoring fighting auto-follow), a "keep prior intent unless the user scrolled up" rule (a content-growth distance jump no longer falsely disengages follow — the core "follows then stops" bug), and a `requestAnimationFrame` bottom re-assert (content-visibility re-measurement can't leave it short). `FlowView` consumes the hook and renders the button when not at bottom.

**Tech Stack:** React 18 (hooks, `useLayoutEffect`, `useState`), TypeScript (strict, `erasableSyntaxOnly`), Vitest + jsdom + `@testing-library/react`. Inline styles (matches the presenter files).

## Global Constraints

- **Base:** origin/main only. Work in worktree `/Users/aisigma/projects/sl-pane-autoscroll/app`. Never touch the main working tree at `/Users/aisigma/projects/SigmaLink`.
- **TS `erasableSyntaxOnly`:** no `enum`, no `namespace`, no constructor parameter properties. Declare a field then assign in the body.
- **DOM presenter only.** Do NOT modify `DomTerminalView.tsx`. All changes live in `FlowView.tsx` + the new hook files.
- **Keep files under 500 lines.** `FlowView.tsx` is ~315 lines; extracting the hook keeps it focused.
- Run all commands from `/Users/aisigma/projects/sl-pane-autoscroll/app`.

---

### Task 1: `computeStick` pure decision function + hook

**Files:**
- Create: `src/renderer/features/command-room/use-stick-to-bottom.ts`
- Test: `src/renderer/features/command-room/use-stick-to-bottom.test.ts`

**Interfaces:**
- Produces:
  - `STICK_SLOP_PX: number` (= 24)
  - `computeStick(opts: { scrollTop: number; scrollHeight: number; clientHeight: number; lastTop: number; wasSticking: boolean; slop?: number }): boolean`
  - `useStickToBottom(): { scrollRef: React.RefObject<HTMLDivElement | null>; atBottom: boolean; onScroll: () => void; scrollToBottom: () => void }`

- [ ] **Step 1: Write the failing test** (`use-stick-to-bottom.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { computeStick, STICK_SLOP_PX } from './use-stick-to-bottom';

const base = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, lastTop: 0, wasSticking: true };

describe('computeStick', () => {
  it('follows when within slop of the bottom', () => {
    // distance = 1000 - 790 - 200 = 10 <= 24
    expect(computeStick({ ...base, scrollTop: 790, lastTop: 790 })).toBe(true);
  });

  it('detaches when the user scrolls UP beyond slop', () => {
    // distance = 1000 - 400 - 200 = 400 > 24, and scrollTop dropped 790 -> 400
    expect(computeStick({ ...base, scrollTop: 400, lastTop: 790, wasSticking: true })).toBe(false);
  });

  it('STAYS stuck when content grows (distance jumps) but the user did NOT scroll up', () => {
    // The "follows then stops" bug: scrollHeight grew so distance is large, but
    // scrollTop did not decrease -> must keep the prior sticking intent.
    expect(
      computeStick({ scrollTop: 800, scrollHeight: 2000, clientHeight: 200, lastTop: 800, wasSticking: true }),
    ).toBe(true);
  });

  it('re-engages once the user returns within slop', () => {
    expect(computeStick({ ...base, scrollTop: 800, lastTop: 400, wasSticking: false })).toBe(true);
  });

  it('stays detached while away from bottom and not returning to it', () => {
    expect(computeStick({ ...base, scrollTop: 300, lastTop: 300, wasSticking: false })).toBe(false);
  });

  it('exposes a generous default slop', () => {
    expect(STICK_SLOP_PX).toBe(24);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/use-stick-to-bottom.test.ts`
Expected: FAIL — `computeStick` / `STICK_SLOP_PX` not exported (module not found).

- [ ] **Step 3: Write minimal implementation** (`use-stick-to-bottom.ts`)

```ts
// DOM terminal presenter — robust stick-to-bottom for FlowView. The pure
// `computeStick` decision is jsdom-testable; the hook layers the DOM concerns
// the inline version lacked: the consumer sets overflow-anchor:none, the
// "keep prior intent unless scrolled up" rule means a content-growth distance
// jump can't disengage follow, and a rAF bottom re-assert means
// content-visibility re-measurement can't leave us short of the true bottom.
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Within this many px of the bottom counts as "at bottom" (auto-follow). A
 *  generous slop tolerates content-visibility height-estimation jitter that
 *  the old 8px threshold did not. */
export const STICK_SLOP_PX = 24;

/** Pure decision: should the view follow the bottom after this scroll metric?
 *  - within slop of bottom -> follow
 *  - user scrolled UP away from bottom -> detach
 *  - otherwise (e.g. content grew, distance jumped, but no upward scroll) keep
 *    the prior intent — this is what stops the "follows then stops" bug. */
export function computeStick(opts: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  lastTop: number;
  wasSticking: boolean;
  slop?: number;
}): boolean {
  const slop = opts.slop ?? STICK_SLOP_PX;
  const distance = opts.scrollHeight - opts.scrollTop - opts.clientHeight;
  if (distance <= slop) return true;
  const scrolledUp = opts.scrollTop < opts.lastTop - 1;
  if (scrolledUp) return false;
  return opts.wasSticking;
}

export function useStickToBottom(): {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  onScroll: () => void;
  scrollToBottom: () => void;
} {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  }, []);

  // Re-pin on every render while following; rAF re-assert after
  // content-visibility settles so we never land short of the true bottom.
  // When not following, do nothing — never yank a reading user back down.
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    pin();
    const id = requestAnimationFrame(() => {
      if (stickRef.current) pin();
    });
    return () => cancelAnimationFrame(id);
  });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = computeStick({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      lastTop: lastTopRef.current,
      wasSticking: stickRef.current,
    });
    lastTopRef.current = el.scrollTop;
    stickRef.current = next;
    setAtBottom((prev) => (prev === next ? prev : next));
  }, []);

  const scrollToBottom = useCallback(() => {
    stickRef.current = true;
    pin();
    setAtBottom(true);
  }, [pin]);

  return { scrollRef, atBottom, onScroll, scrollToBottom };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/command-room/use-stick-to-bottom.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/command-room/use-stick-to-bottom.ts src/renderer/features/command-room/use-stick-to-bottom.test.ts
git commit -m "feat(pane): robust stick-to-bottom hook (computeStick + useStickToBottom)"
```

---

### Task 2: Wire the hook into FlowView + jump-to-bottom button

**Files:**
- Modify: `src/renderer/features/command-room/FlowView.tsx`
- Test: `src/renderer/features/command-room/FlowView.test.tsx` (add button cases)

**Interfaces:**
- Consumes: `useStickToBottom` from Task 1.

- [ ] **Step 1: Write the failing test** (append inside the `describe('FlowView', ...)` block in `FlowView.test.tsx`)

The file already imports `{ act, cleanup, fireEvent, render }` and has a `makeEngine()` helper — reuse them verbatim.

```tsx
it('shows a jump-to-bottom button only after scrolling up, and hides it on click', () => {
  const engine = makeEngine();
  const { container } = render(<FlowView engine={engine} />);
  const scroller = container.querySelector('[data-testid="flow-view"]') as HTMLDivElement;

  // Mock layout: tall content, 200px viewport.
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });

  // At the bottom -> following, no button.
  scroller.scrollTop = 800;
  fireEvent.scroll(scroller);
  expect(container.querySelector('[data-testid="jump-to-bottom"]')).toBeNull();

  // User scrolls UP -> detaches, button appears.
  scroller.scrollTop = 200;
  fireEvent.scroll(scroller);
  expect(container.querySelector('[data-testid="jump-to-bottom"]')).not.toBeNull();

  // Click returns to bottom -> button gone.
  fireEvent.click(container.querySelector('[data-testid="jump-to-bottom"]')!);
  expect(container.querySelector('[data-testid="jump-to-bottom"]')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/FlowView.test.tsx`
Expected: FAIL — no `[data-testid="jump-to-bottom"]` element after scrolling up.

- [ ] **Step 3: Implement — replace inline scroll state with the hook + add button**

In `FlowView.tsx`:

1. Add import near the other local imports:
```ts
import { useStickToBottom } from './use-stick-to-bottom';
```

2. Inside `FlowView`, DELETE these two refs:
```ts
const scrollRef = useRef<HTMLDivElement | null>(null);
const stickRef = useRef(true);
```
DELETE the stick `useLayoutEffect` block:
```ts
useLayoutEffect(() => {
  const el = scrollRef.current;
  if (el && stickRef.current) el.scrollTop = el.scrollHeight;
});
```
DELETE the `onScroll` definition:
```ts
const onScroll = () => {
  const el = scrollRef.current;
  if (!el) return;
  stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLOP_PX;
};
```
DELETE the now-unused module const `STICK_SLOP_PX` (~line 53). Drop `useLayoutEffect` from the `react` import (the search `scrollIntoView` effect uses `useEffect`, which stays). Keep `useRef` only if still used elsewhere — it is NOT after these deletions, so remove `useRef` from the import too if the linter flags it.

3. Add at the top of the component body, alongside the existing `const [, bump] = useReducer(...)`:
```ts
const { scrollRef, atBottom, onScroll, scrollToBottom } = useStickToBottom();
```
(`scrollRef` keeps the same name, so the search `scrollIntoView` effect that reads `scrollRef.current` is unchanged.)

4. Replace the component's `return (...)` so the scroll div is wrapped in a `position:relative` host that also holds the button, and set `overflowAnchor: 'none'` on the scroll div. Keep the `{visible.map(...)}` body EXACTLY as it is today:
```tsx
return (
  <div className={className} style={{ position: 'relative', height: '100%' }}>
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="flow-view"
      style={{
        height: '100%',
        overflowY: 'auto',
        overflowAnchor: 'none', // stop Chromium scroll-anchoring fighting auto-follow
        scrollbarGutter: 'stable',
        background: DEFAULT_BG,
        color: DEFAULT_FG,
        fontFamily: MONO_FONT,
        fontSize: 12,
        lineHeight: 1.4,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        overflowX: 'hidden',
        userSelect: 'text',
        padding: '4px 6px',
        boxSizing: 'border-box',
      }}
    >
      {visible.map((l, i) => (
        /* ...existing LineRow mapping UNCHANGED — copy it verbatim from the
           current file, do not retype it... */
      ))}
    </div>
    {!atBottom && (
      <button
        type="button"
        data-testid="jump-to-bottom"
        onClick={scrollToBottom}
        aria-label="Jump to latest output"
        title="Jump to latest output"
        style={{
          position: 'absolute',
          right: 14,
          bottom: 12,
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '9999px',
          border: '1px solid rgba(130,140,165,0.4)',
          background: 'rgba(28,32,44,0.9)',
          color: DEFAULT_FG,
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
          padding: 0,
        }}
      >
        ↓
      </button>
    )}
  </div>
);
```

> Only the wrapper, the `overflowAnchor`, and the button are new. `className`
> moves from the scroll div to the wrapper; the scroll div keeps
> `data-testid="flow-view"`.

- [ ] **Step 4: Run FlowView + neighbour tests**

Run: `npx vitest run src/renderer/features/command-room/FlowView.test.tsx src/renderer/features/command-room/DomTerminalView.test.tsx`
Expected: PASS. If a pre-existing FlowView test asserted on the old single-div root layout, update it to query `[data-testid="flow-view"]` (most already do).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: no errors. Fix any unused-import errors left by the Step 3 deletions.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/features/command-room/FlowView.tsx src/renderer/features/command-room/FlowView.test.tsx
git commit -m "feat(pane): jump-to-bottom button + overflow-anchor fix in FlowView"
```

---

### Task 3: Full gate

- [ ] **Step 1: Run the full command-room suite**

Run: `npx vitest run src/renderer/features/command-room/`
Expected: all PASS (watch for any mock breakage in neighbour terminal tests).

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc -b && npx eslint src/renderer/features/command-room/use-stick-to-bottom.ts src/renderer/features/command-room/FlowView.tsx`
Expected: clean.

- [ ] **Step 3: Report** (no further commit — docs already committed in this worktree).

> **Lead owns live-verification** (not the worktree agent): jsdom cannot prove
> real scroll/layout. After review, the lead builds a verify worktree
> (`vite build`, `electron . --user-data-dir=<isolated>`, background) and
> confirms: long burst stays pinned; scroll-up shows "↓"; click re-pins; divider
> resize keeps it pinned.
