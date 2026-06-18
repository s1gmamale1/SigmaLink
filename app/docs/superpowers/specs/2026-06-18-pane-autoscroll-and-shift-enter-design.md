# Design — Pane auto-scroll robustness + Shift+Enter newline (DOM presenter)

**Date:** 2026-06-18
**Status:** Approved (operator, 2026-06-18) → writing-plans
**Base:** origin/main (the working tree is on a stale 27-behind branch with
uncommitted WIP — all work happens in fresh worktrees off origin/main; the
operator's tree is never touched).

Two **independent** features, dispatched to **two separate worktrees / PRs**.
Both target the **DOM terminal presenter** (`DomTerminalView` + `FlowView`),
which is the default renderer since v2.4.1 (`renderer-flag.ts`,
`DEFAULT_RENDERER_MODE = 'dom'`). The xterm path is one KV away and handles
both concerns natively (scroll-on-output; xterm key encoding) — explicitly out
of scope.

---

## Feature A — Reliable auto-follow + jump-to-bottom button

### Symptom (operator-confirmed)
In a streaming Claude/Codex pane the view **follows output for a while, then
stops mid-burst and never re-engages**, even though the operator did not scroll
up. There is **no affordance to return to the live bottom** once detached.

### Root cause (read from `FlowView.tsx` @ origin/main)
`FlowView` implements stick-to-bottom with:
```ts
const stickRef = useRef(true);
useLayoutEffect(() => {                       // every render
  const el = scrollRef.current;
  if (el && stickRef.current) el.scrollTop = el.scrollHeight;
});
const onScroll = () => {
  const el = scrollRef.current; if (!el) return;
  stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLOP_PX; // 8px
};
```
Three compounding factors make `stickRef` falsely flip to `false`:

1. **Chromium scroll anchoring** — the scroll container has the default
   `overflow-anchor: auto` (confirmed: no `overflow-anchor` is set anywhere in
   the renderer). When rows above the viewport change height, the browser
   adjusts `scrollTop` to keep a *visible row* pinned — actively dragging the
   viewport away from the bottom during a burst.
2. **`content-visibility: auto` height estimation** — offscreen `LineRow`s
   report a `containIntrinsicSize` estimate (17px); real wrapped heights
   differ, so `scrollHeight` jitters frame-to-frame.
3. **`onScroll` cannot distinguish programmatic from user scroll** — the
   `useLayoutEffect`'s own `scrollTop = scrollHeight` races with a `scrollHeight`
   change; in the resulting `onScroll`, `scrollHeight - scrollTop - clientHeight`
   momentarily exceeds the 8px slop → `stickRef = false`. Output keeps appending
   below, the gap only grows, and it **never re-engages**.

### Design
Extract the scroll logic into a focused, unit-testable hook
`use-stick-to-bottom.ts` (new file + `use-stick-to-bottom.test.ts`), consumed by
`FlowView`. The hook owns:

- **`overflow-anchor: none`** on the scroll container — stop anchoring from
  fighting auto-follow. (Applied via the container style FlowView already owns.)
- **Keep-prior-intent rule** (`computeStick`) — disengage only on a genuine
  **user scroll-up** (scrollTop decreased beyond 1px); re-engage when within a
  **generous slop (~24px)** of the bottom; otherwise keep the prior intent. A
  content-growth *distance jump* (scrollHeight grew, scrollTop unchanged) is
  therefore NOT a disengage — this is the direct fix for "follows then stops".
  The generous slop also tolerates sub-pixel + estimation noise the 8px
  threshold did not.
- **rAF bottom re-assert** — after the layout effect pins the bottom, a
  `requestAnimationFrame` re-asserts `scrollTop = scrollHeight` so
  content-visibility re-measurement settling can't leave it short.
- **Reactive `atBottom`** — a boolean state (set only when it *changes*, to
  avoid render storms) that drives button visibility.

**Jump-to-bottom button:** a small floating circular **"↓"** pinned to the
bottom-right *inside the scroll area* (operator-chosen placement, not the footer
chrome), shown only when `!atBottom`. Click → scroll to bottom + re-engage
follow. Styled to match the existing pane overlays (cf. `PaneSearch`); does not
steal terminal focus.

### Testing
- **Unit (jsdom)** — the hook's *pure decision logic*: given
  `{scrollTop, scrollHeight, clientHeight, programmatic}` inputs, assert
  engage/disengage transitions and the programmatic-guard. jsdom has no layout,
  so these test the decision function, not real scrolling.
- **Live (Electron)** — jsdom cannot prove real scroll/layout. Live-verify in a
  build worktree: `vite build` (skip tsc), `electron . --user-data-dir=<isolated>`
  from `app/`, run in background so it can't clobber the operator's `sigmalink.db`.
  Confirm: long burst stays pinned; scroll-up detaches + shows "↓"; click "↓"
  re-pins; resize keeps it pinned.

### Scope
- DOM presenter only. `FlowView.tsx` (button + style), new
  `use-stick-to-bottom.ts` (+ test). **`DomTerminalView.tsx` is NOT touched**
  (avoids the stale-branch #182 divergence). xterm scrolls-on-output natively.

---

## Feature B — Shift+Enter inserts a newline

### Behaviour today
`input-encoder.ts` `encodeKeyEvent` Enter case:
```ts
case 'Enter':
  return ev.altKey ? `${ESC}\r` : '\r';   // Shift ignored → submits
```
Shift+Enter sends `\r` → **submits**. The operator wants it to insert a newline
in the composer of Claude Code / Codex panes.

### Design — PROVIDER-AWARE (revised after empirical verification)
**Verification result (from the CLIs themselves, 2026-06-18):** the newline byte
differs per TUI.
- **Claude Code** — its own `/terminal-setup` configures VS Code Shift+Enter to
  send `\x1B\r` (meta-Enter); it documents "Option+Enter for newlines". Bare LF
  is NOT its newline. → **claude wants `\x1B\r`.**
- **Codex** — footer shows `⌃J` (Ctrl+J = `\n`/LF) for newline, and it pushes
  the kitty keyboard protocol (which our DOM presenter does not implement, so it
  falls back to Ctrl+J); it does not bind meta-Enter. → **codex wants `\n`.**

No single byte works for both, so the encoding is provider-aware (operator
decision, 2026-06-18). The pane's REAL provider (`session.providerId`, not the
cosmetic `displayProviderId`) selects the bytes:

```ts
// input-encoder.ts
export function shiftEnterNewline(providerId: string | undefined | null): string {
  return providerId === 'claude' ? `${ESC}\r` : '\n'; // claude=meta-Enter; codex/others=LF
}
export function encodeKeyEvent(ev, modes, opts?: { shiftEnterNewline?: string }): string | null {
  // ...
  case 'Enter':
    if (ev.altKey) return `${ESC}\r`;                 // Alt/Option+Enter unchanged
    if (ev.shiftKey) return opts?.shiftEnterNewline ?? '\n'; // provider-resolved, default LF
    return '\r';                                      // plain Enter submits
}
```
`DomTerminalView` resolves `providerId` from app state (`s.sessions.find(id)`)
and passes `{ shiftEnterNewline: shiftEnterNewline(providerId) }` into
`encodeKeyEvent`. Plain shells submit on either byte in cooked mode — no
regression. The encoder's other call site (wheel→arrow keys) passes no `opts`
and is unaffected.

### Testing
- **Pure goldens** (`input-encoder.test.ts`): `shiftEnterNewline('claude') →
  "\x1b\r"`, `('codex') → "\n"`, `('shell'|undefined) → "\n"`;
  `encodeKeyEvent(Shift+Enter, …, {shiftEnterNewline:'\x1b\r'}) → "\x1b\r"`;
  default (no opts) `Shift+Enter → "\n"`; regression-guard `Enter → "\r"`,
  `Alt+Enter → "\x1b\r"`.
- **Wiring** (`DomTerminalView.test.tsx`): make the `useAppStateSelector` mock
  state configurable; assert a `claude` session's Shift+Enter writes `\x1b\r` and
  a `codex` session's writes `\n`.

### Scope
- DOM presenter (`input-encoder.ts` + `DomTerminalView.tsx` + their tests). The
  xterm path encodes Enter inside `term.onData` (xterm's own handler); making
  Shift+Enter provider-aware there needs `attachCustomKeyEventHandler` —
  **out of scope** (xterm isn't the default), logged as an optional follow-up.

---

## Dispatch & housekeeping

- **Two manually-created worktrees off origin/main** (NOT `Agent
  isolation:"worktree"` — it has silently no-op'd before and could sweep this
  tree's uncommitted WIP + the #182 revert into a commit):
  - `feat/pane-autoscroll` — Feature A
  - `feat/shift-enter-newline` — Feature B
  - Verify `git worktree list` after creation; agents are bound to the absolute
    worktree path and stage only their own files.
- Two parallel **Opus** coder lanes → **Opus review** → gate (`tsc -b` + full
  `vitest run` + lint + build) in MAIN → live-verify A, PTY-probe B.
- Each worktree carries its own spec excerpt + plan for a self-contained PR.
- WISHLIST → add both items; ROADMAP → promote as the active phase.

## Non-goals
- xterm-path parity for either feature.
- Touching `DomTerminalView.tsx`, the operator's WIP, or the stale branch.
- Kitty keyboard protocol (remains P2 per the presenter spec).
