# Pane Focus + Click-Flicker Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 1 is a CONFIRM-FIRST step (systematic-debugging Phase 1) — do NOT skip it; the root cause is evidenced but not yet runtime-confirmed.

**Goal:** A single click reliably focuses a pane (keystrokes land on the first click) with no flicker, on every renderer (DOM default + xterm) and in both main and popped-out windows.

**Architecture:** The default DOM presenter (`DomTerminalView`, default since v2.4.1) routes keystrokes to a hidden 1×1 `<textarea>` that it focuses **on `mouseUp`, gated behind a "selection not collapsed" early-return**, with a plain `.focus()` (no `{ preventScroll }`). Pane activation (`SET_ACTIVE_SESSION`) fires earlier, on `onMouseDownCapture`. The fix moves focus to `pointerdown` with `{ preventScroll: true }`, decouples copy-on-select from the focus path so a stray micro-selection can never swallow the focus, and (if Task 1 confirms it) repairs the activation re-render. xterm panes already focus natively on click and must stay unchanged.

**Tech Stack:** React 18, TypeScript (`erasableSyntaxOnly` — no ctor param-props/enums), Vitest + jsdom (unit), headless Chromium (layout/scroll assertions — jsdom has no layout engine), Electron renderer.

---

## Root cause (evidence)

Operator report (2026-06-17, confirmed via AskUserQuestion): **all panes**, **both main + popped-out windows**, **flicker only on click**, **both the active ring and keystroke focus feel stuck until 3-4 clicks**.

Code path (canonical `origin/main` @ `d6e8983`):
- Activation fires on mousedown-capture: `PaneGrid.tsx:315` `onMouseDownCapture={() => onActivate(sid)}` → `CommandRoom.tsx:434-437` dispatch `CLEAR_SESSION_ATTENTION` + (guarded) `SET_ACTIVE_SESSION`.
- DOM presenter keystroke focus is the hidden `<textarea>` (`DomTerminalView.tsx:438-457`, `1×1`, `opacity:0`, `position:absolute; left:0; bottom:0`), focused only:
  - on `mouseUp` (`:384-394`) — but **early-returns without focusing when `!sel.isCollapsed`** (`:386-390`), i.e. any micro-movement during the click leaves a tiny selection → that click does not focus AND copies the stray selection to the clipboard;
  - on native `mousedown` ONLY under mouse-tracking (`:270-279`);
  - on `sigma:pty-focus` (`:168-177`).
  - All call sites use a plain `.focus()` (`:171`, `:274`, `:393`) — **no `{ preventScroll: true }`**, so focusing the textarea pinned at `bottom:0` makes the browser scroll the `overflowY:auto` FlowView to reveal it → a visible scroll-jump = the "flicker on click".
- xterm host (`Terminal.tsx` `XtermTerminalHost`) focuses via xterm's own click handling + `sigma:pty-focus` (`:189-204`); no change needed.

**Confirmed mechanisms (fixable now):** (1) focus-on-mouseUp gated behind the selection check → unreliable focus + clipboard clobber; (2) focus without `preventScroll` → scroll-jump flicker.
**UNCONFIRMED (Task 1 must verify):** the operator also reports the active **ring** lags. Static reading shows no remount on activation (all keys stable: `PaneGrid` cell `key={sid}`, `PaneErrorBoundary key={session.id}`), so this is likely either (a) perception of failed keystroke-focus, or (b) a runtime re-render/ordering effect only observable live. Do not code a ring fix until Task 1 confirms it reproduces and isolates it.

## File structure

- Modify `app/src/renderer/features/command-room/DomTerminalView.tsx` — focus on `pointerdown` + `{ preventScroll: true }`; decouple copy-on-select from focus.
- Test `app/src/renderer/features/command-room/DomTerminalView.test.tsx` (create if absent) — focus-on-pointerdown, selection-does-not-block-focus, preventScroll-used.
- (Conditional, Task 5) Modify `app/src/renderer/features/command-room/PaneGrid.tsx` / `CommandRoom.tsx` — only if Task 1 confirms an activation/ring defect.
- Headless-Chromium check (existing harness used by the pane-metrics/min-w-0 work) — assert no scroll-jump on focus.

---

### Task 1: Reproduce + confirm the failing mechanism (systematic-debugging Phase 1 — NO fix yet)

**Files:** none (instrumentation is temporary; revert before Task 2's commit).

- [ ] **Step 1: Build a dev build the operator can drive.** Run the app per the project run skill (operator-side; never launch Electron from an agent session — it steals focus). Open a workspace with ≥2 DOM panes (a shell pane + a claude pane).

- [ ] **Step 2: Add temporary tracing.** In `DomTerminalView.tsx` `onMouseUp` and the native `onMouseDownNative`, and in `CommandRoom.tsx` `onActivate`, add `console.debug('[focus-trace]', { where, sessionId, selCollapsed: window.getSelection()?.isCollapsed, active: document.activeElement?.getAttribute('aria-label') })`. (Captured to `diagnostics.log` via the #179 console-message bridge — errors-only today, so temporarily log at `console.error` or watch DevTools.)

- [ ] **Step 3: Reproduce + capture.** Operator clicks an unfocused pane 4× (single clean clicks, then a normal click). Record for each click: did `onActivate` fire? was `selCollapsed` true/false on `onMouseUp`? did `document.activeElement` become `terminal input`? did the pane scroll-jump?

- [ ] **Step 4: Classify.** Confirm which mechanism dominates:
  - `selCollapsed:false` on the failing clicks → the selection-guard (Task 3 is the fix).
  - `activeElement` not `terminal input` even with `selCollapsed:true` → focus timing / preventScroll / remount (Tasks 2/4).
  - `onActivate` not firing OR ring not updating despite firing → the ring defect (Task 5 in scope); otherwise mark Task 5 out-of-scope.

- [ ] **Step 5: Remove the tracing.** Revert all `console.debug` lines. Do NOT commit instrumentation. Record the classification in the PR description.

---

### Task 2: Focus the input on `pointerdown` with `{ preventScroll: true }`

**Files:**
- Modify: `app/src/renderer/features/command-room/DomTerminalView.tsx` (focus call sites `:171`, `:274`, `:393`; add a `pointerdown` listener in the effect near `:309`)
- Test: `app/src/renderer/features/command-room/DomTerminalView.test.tsx`

- [ ] **Step 1: Write the failing test** (jsdom focus works; `preventScroll` is accepted by jsdom's `focus`).

```tsx
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DomTerminalView } from './DomTerminalView';

// engine-cache + rpc are mocked in the existing pane test setup; reuse it.
describe('DomTerminalView focus', () => {
  it('focuses the input on pointerdown (before mouseup), even mid-selection', () => {
    const { getByTestId, getByLabelText } = render(<DomTerminalView sessionId="s1" />);
    const container = getByTestId('dom-terminal-view');
    const input = getByLabelText('terminal input') as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(input);
    fireEvent.pointerDown(container);
    expect(document.activeElement).toBe(input);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `npx vitest run src/renderer/features/command-room/DomTerminalView.test.tsx` — Expected: FAIL (focus is on mouseUp today).

- [ ] **Step 3: Implement.** Add a non-tracking `pointerdown` focus in the effect (alongside the existing native listeners near `:309`), and add `{ preventScroll: true }` to every `inputRef.current?.focus()` call (`:171`, `:274`, `:393`).

```ts
// inside the effect, after onMouseDownNative wiring:
const onPointerDownFocus = (ev: PointerEvent) => {
  // Tracking panes already focus + own the press in onMouseDownNative; shift =
  // user is selecting → don't yank focus mid-selection-gesture.
  if (trackingActive() || ev.shiftKey) return;
  inputRef.current?.focus({ preventScroll: true });
};
container.addEventListener('pointerdown', onPointerDownFocus);
// ...and in cleanup:
container.removeEventListener('pointerdown', onPointerDownFocus);
```

- [ ] **Step 4: Run the test, verify it passes.** Run: `npx vitest run src/renderer/features/command-room/DomTerminalView.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add app/src/renderer/features/command-room/DomTerminalView.tsx app/src/renderer/features/command-room/DomTerminalView.test.tsx
git commit -m "fix(panes): DOM presenter focuses on pointerdown with preventScroll (no scroll-jump, first-click focus)"
```

---

### Task 3: Decouple copy-on-select from the focus path (selection never blocks focus)

**Files:**
- Modify: `app/src/renderer/features/command-room/DomTerminalView.tsx` `onMouseUp` (`:384-394`)
- Test: `app/src/renderer/features/command-room/DomTerminalView.test.tsx`

- [ ] **Step 1: Write the failing test.**

```tsx
it('copies a real selection on mouseup WITHOUT swallowing focus on a stray micro-selection', () => {
  const writeText = vi.fn();
  Object.assign(navigator, { clipboard: { writeText } });
  const { getByTestId, getByLabelText } = render(<DomTerminalView sessionId="s1" />);
  const container = getByTestId('dom-terminal-view');
  const input = getByLabelText('terminal input') as HTMLTextAreaElement;
  // Simulate a collapsed-after-click selection (jsdom selection is collapsed by default).
  fireEvent.pointerDown(container);
  fireEvent.mouseUp(container);
  expect(document.activeElement).toBe(input); // focus not blocked
});
```

- [ ] **Step 2: Run it, verify it fails / passes-for-wrong-reason.** Run: `npx vitest run src/renderer/features/command-room/DomTerminalView.test.tsx` — confirm the OLD onMouseUp early-return path is what changes.

- [ ] **Step 3: Implement.** `onMouseUp` keeps copy-on-select but no longer owns focus (Task 2 handles focus on pointerdown), so it must NOT early-return out of anything focus-related:

```ts
const onMouseUp = () => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    const text = sel.toString();
    if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
  }
  // Focus is established on pointerdown (Task 2); nothing to do here for focus.
};
```

- [ ] **Step 4: Run the test, verify it passes.** Run: `npx vitest run src/renderer/features/command-room/DomTerminalView.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add app/src/renderer/features/command-room/DomTerminalView.tsx app/src/renderer/features/command-room/DomTerminalView.test.tsx
git commit -m "fix(panes): copy-on-select no longer swallows pane focus (decouple from mouseup focus)"
```

---

### Task 4: Verify no scroll-jump flicker (headless Chromium)

**Files:**
- Test: the existing headless-Chromium pane harness (same one the pane-metrics/min-w-0 reflow work uses; jsdom cannot assert scroll).

- [ ] **Step 1: Write the failing/guard check.** Render a DomTerminalView whose FlowView is scrolled up (content > viewport), then fire `pointerdown` and assert `flowEl.scrollTop` is unchanged (preventScroll keeps the view put).

- [ ] **Step 2: Run, verify** it fails without `{ preventScroll: true }` (Task 2) and passes with it.

- [ ] **Step 3: Commit** the headless check.

```bash
git commit -am "test(panes): headless-chromium guard — focusing a pane does not scroll-jump"
```

---

### Task 5: (CONDITIONAL — only if Task 1 confirmed an activation/ring defect) Repair activation ring lag

**Files:**
- Modify: `app/src/renderer/features/command-room/PaneGrid.tsx` and/or `CommandRoom.tsx` (the exact site depends on Task 1's classification).

- [ ] **Step 1:** From Task 1's capture, write a failing jsdom test that clicking an inactive cell synchronously flips `data-active` to the clicked cell (PaneGrid renders `data-active` at `:313`).
- [ ] **Step 2:** Run, verify it fails.
- [ ] **Step 3:** Implement the minimal fix indicated by Task 1 (e.g., if a competing dispatch reverts `activeSessionId`, guard it; if it's a stale closure in `onActivate`, stabilize it). DO NOT speculatively refactor.
- [ ] **Step 4:** Run, verify it passes.
- [ ] **Step 5:** Commit.

If Task 1 showed the ring DOES update and only keystroke-focus was stuck, SKIP this task and note "ring lag was perceived failed-focus" in the PR.

---

### Task 6: xterm parity + full gate

**Files:** none (verification only).

- [ ] **Step 1:** Manually confirm an xterm-renderer pane (right-click → Renderer: switch to xterm) still focuses on the first click (xterm's native handling is untouched).
- [ ] **Step 2:** Run the full local gate: `npx tsc -b` · `npx vitest run` · `npx eslint .` · `npm run build`. Expected: all clean (4070+ tests pass).
- [ ] **Step 3:** Commit any test snapshot updates.

---

## Manual verification checklist (operator, on a real build — DoD)

- [ ] One click on any unfocused pane (shell AND claude/codex) → keystrokes land immediately; no second/third click needed.
- [ ] Clicking a pane does NOT scroll-jump or flash the transcript.
- [ ] Selecting text in a pane still copies it (copy-on-select unchanged).
- [ ] A claude fullscreen-TUI pane still focuses + reports mouse correctly (tracking path unchanged).
- [ ] Same behavior in a popped-out workspace window.
- [ ] xterm-renderer pane (toggled) still focuses on the first click.

## Self-review notes

- Spec coverage: focus reliability (Tasks 2-3), flicker (Tasks 2,4), ring (Task 1→5 conditional), xterm parity (Task 6). ✓
- jsdom limits: focus + `document.activeElement` work; selection + layout/scroll do NOT → scroll-jump verified in headless Chromium (Task 4), not jsdom.
- `erasableSyntaxOnly`: no enums/param-props introduced. ✓
- Sibling sites: all three `inputRef.focus()` call sites get `{ preventScroll: true }` (grep `inputRef.current?.focus` before committing Task 2).
