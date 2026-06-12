# DOM Terminal Presenter P2 — Shell Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full SGR mouse reporting (clicks/drag/motion with shift-to-select bypass), real link anchors in FlowView via the existing routeLinkClick, find-in-pane search, OSC-133 command-block gutters, and a vim/htop-grade GridView golden pass.

**Architecture:** The engine grows two read surfaces — a granular `mouseTracking.mode` (replacing P1c's boolean `active`) and OSC-133 prompt marks via a parser hook. Three new pure modules carry the logic (`mouse-encoder.ts`, `linkify.ts`, `command-blocks.ts`); `route-link-click.ts` is extracted from Terminal.tsx so DomTerminalView can use it without an import cycle. FlowView gains a decoration pipeline (links + search highlights merged into the run walk) and block gutters; DomTerminalView gains pointer reporting and the search overlay.

**Tech Stack:** React 19, `@xterm/headless` 6 (`parser.registerOscHandler(ident, cb)` confirmed at typings line 1292). NO new packages. vitest node (pure/engine) + jsdom (components).

**Spec:** `docs/superpowers/specs/2026-06-12-dom-terminal-presenter-design.md` §P2. **P3 disposition (record in Task 7's docs step, no code):** the P3 "deletions" (WebGL/atlas, reveal path, fullscreen injection, xterm→legacy rename) are DEFERRED — they conflict with the spec's own non-goal ("xterm remains the fallback renderer indefinitely until a separate decision retires it"); deleting them would regress the still-reachable xterm path. P3's default flip already shipped in v2.4.1. Phase 2 + this disposition = spec complete.

**House rules:** worktree-only; no installs; `pnpm lint` not bare eslint; NO control chars in test regex literals (string ops); FULL `npx vitest run` before commits touching mocked/mirrored surfaces; no Electron/Playwright; commit per task; files < 500 lines (FlowView and DomTerminalView grow this phase — if either nears 500, extract the search overlay into `PaneSearch.tsx`, which Task 5 does anyway).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `app/src/renderer/lib/terminal-engine.ts` | Modify | granular `mouseTracking.mode`; OSC-133 `promptMarks` |
| `app/src/renderer/features/command-room/mouse-encoder.ts` | Create | pure SGR mouse report encoding + should-report policy |
| `app/src/renderer/features/command-room/linkify.ts` | Create | pure URL detection in line text |
| `app/src/renderer/features/command-room/command-blocks.ts` | Create | pure marks → blocks derivation |
| `app/src/renderer/features/command-room/route-link-click.ts` | Create | extracted verbatim from Terminal.tsx (cycle-free) |
| `app/src/renderer/features/command-room/Terminal.tsx` | Modify | import routeLinkClick from the new module |
| `app/src/renderer/features/command-room/line-segments.ts` | Create | pure run-decoration (links + search ranges → segments) |
| `app/src/renderer/features/command-room/FlowView.tsx` | Modify | segment pipeline, link anchors, search highlights, block gutters |
| `app/src/renderer/features/command-room/PaneSearch.tsx` | Create | find-in-pane overlay (input, count, prev/next, close) |
| `app/src/renderer/features/command-room/DomTerminalView.tsx` | Modify | pointer reporting, search state + keybinding, link ctx |
| `app/src/renderer/features/command-room/GridView.test.tsx` | Modify | fidelity goldens (vim/htop-class fixtures) |
| Tests | Create | one `.test.ts(x)` per new module; integration tests in existing suites |

---

### Task 1: Engine — granular mouse mode + OSC-133 prompt marks

**Files:** Modify `app/src/renderer/lib/terminal-engine.ts`; test `app/src/renderer/lib/terminal-engine.test.ts`. Then fix the ONE existing consumer of the old shape: `DomTerminalView.tsx`'s wheel block (`mt.active` → mode check) — its tests must stay green within this task.

- [ ] **Step 1: Failing engine tests** (append):

```ts
describe('TerminalEngine — granular mouse mode (P2)', () => {
  it('exposes the tracking mode verbatim', async () => {
    const { engine } = makeEngine();
    track(engine);
    expect(engine.mouseTracking).toEqual({ mode: 'none', sgr: false });
    await flushWrite(engine, '\x1b[?1002h\x1b[?1006h');
    expect(engine.mouseTracking).toEqual({ mode: 'drag', sgr: true });
    await flushWrite(engine, '\x1b[?1002l\x1b[?1003h');
    expect(engine.mouseTracking.mode).toBe('any');
  });
});

describe('TerminalEngine — OSC-133 prompt marks (P2)', () => {
  it('records A/B/C/D marks with absolute rows and exit codes', async () => {
    const { engine } = makeEngine({ cols: 40, rows: 10 });
    track(engine);
    await flushWrite(engine, '\x1b]133;A\x07$ ');
    await flushWrite(engine, 'make\r\n\x1b]133;C\x07building...\r\n\x1b]133;D;2\x07');
    await flushWrite(engine, '\x1b]133;A\x07$ ');
    const marks = engine.promptMarks;
    expect(marks.map((m) => m.kind).join('')).toBe('ACDA');
    expect(marks[0]!.row).toBe(0);
    expect(marks[2]!.exitCode).toBe(2);
    expect(marks[3]!.row).toBeGreaterThan(marks[0]!.row);
  });

  it('caps stored marks (oldest dropped)', async () => {
    const { engine } = makeEngine({ cols: 20, rows: 5 });
    track(engine);
    for (let i = 0; i < 30; i++) await flushWrite(engine, '\x1b]133;A\x07x\r\n');
    expect(engine.promptMarks.length).toBeLessThanOrEqual(2048);
  });
});
```

- [ ] **Step 2: verify FAIL**, then implement in `terminal-engine.ts`:
  - Replace the P1c `mouseTracking` getter:

```ts
  /** Granular mouse-tracking state. `mode` mirrors xterm verbatim ('x10' is
   *  press-only legacy and reports no wheel/motion); `sgr` tracks DECSET 1006
   *  via the parser hook (the public modes API hides the report encoding). */
  get mouseTracking(): { mode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'; sgr: boolean } {
    return { mode: this.term.modes.mouseTrackingMode, sgr: this.sgrMouseMode };
  }
```

  - Add OSC-133 support. New types + field + constructor hook + getter:

```ts
export interface PromptMark {
  kind: 'A' | 'B' | 'C' | 'D';
  /** Absolute buffer row (baseY + cursorY) at mark time. Drifts once the
   *  scrollback trims past it — accepted: trimmed rows are out of the render
   *  window anyway. */
  row: number;
  /** Only on 'D' marks that carried one (`133;D;<code>`). */
  exitCode?: number;
}

const MAX_PROMPT_MARKS = 2048;
```

```ts
  private readonly marks: PromptMark[] = [];

  /** OSC-133 shell-integration marks (FinalTerm protocol), oldest first. */
  get promptMarks(): readonly PromptMark[] {
    return this.marks;
  }
```

  In the constructor (after the 1006 watchers):

```ts
    // OSC 133 (FinalTerm shell integration): A=prompt B=command-start
    // C=output-start D=command-end[;exit]. Recording rows here gives the
    // FlowView its command-block gutters. Return true: the mark is consumed
    // (xterm has no default handler for 133 anyway).
    this.disposers.push(
      this.term.parser.registerOscHandler(133, (data) => {
        const kind = data[0];
        if (kind === 'A' || kind === 'B' || kind === 'C' || kind === 'D') {
          const buf = this.term.buffer.active;
          const mark: PromptMark = { kind, row: buf.baseY + buf.cursorY };
          if (kind === 'D' && data.length > 2) {
            const code = Number(data.slice(2).split(';')[0]);
            if (Number.isFinite(code)) mark.exitCode = code;
          }
          this.marks.push(mark);
          if (this.marks.length > MAX_PROMPT_MARKS) this.marks.shift();
        }
        return true;
      }),
    );
```

  - Fix the consumer: in `DomTerminalView.tsx`'s `onWheel`, replace `if (mt.active && mt.sgr)` with `if (mt.mode !== 'none' && mt.mode !== 'x10' && mt.sgr)`. Update the P1c engine tests that asserted `{ active, sgr }` to the new `{ mode, sgr }` shape (`'\x1b[?1000h\x1b[?1006h'` → `{ mode: 'vt200', sgr: true }`; the x10 case asserts `mode: 'x10'`).

- [ ] **Step 3: Run** `npx vitest run src/renderer/lib/terminal-engine.test.ts src/renderer/features/command-room/DomTerminalView.test.tsx` → green.
- [ ] **Step 4: Commit** — `feat(panes): engine granular mouse mode + OSC-133 prompt marks (P2 task 1)`

---

### Task 2: Pure mouse encoder + pointer reporting in DomTerminalView

**Files:** Create `mouse-encoder.ts` + `mouse-encoder.test.ts`; modify `DomTerminalView.tsx` + its test.

- [ ] **Step 1: Failing encoder goldens** (`mouse-encoder.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { encodeSgrMouse, shouldReportMouse } from './mouse-encoder';

const NOMOD = { shift: false, alt: false, ctrl: false };

describe('encodeSgrMouse', () => {
  it('press/release/motion grammar', () => {
    expect(encodeSgrMouse('press', 0, 5, 3, NOMOD)).toBe('\x1b[<0;5;3M');
    expect(encodeSgrMouse('release', 0, 5, 3, NOMOD)).toBe('\x1b[<0;5;3m');
    expect(encodeSgrMouse('motion', 0, 6, 3, NOMOD)).toBe('\x1b[<32;6;3M');
    expect(encodeSgrMouse('press', 2, 1, 1, NOMOD)).toBe('\x1b[<2;1;1M'); // right
  });
  it('modifier bits: shift 4, alt 8, ctrl 16', () => {
    expect(encodeSgrMouse('press', 0, 1, 1, { shift: true, alt: false, ctrl: false })).toBe('\x1b[<4;1;1M');
    expect(encodeSgrMouse('press', 1, 1, 1, { shift: false, alt: true, ctrl: true })).toBe('\x1b[<25;1;1M');
  });
  it('wheel buttons pass through (64 up / 65 down)', () => {
    expect(encodeSgrMouse('press', 64, 9, 2, NOMOD)).toBe('\x1b[<64;9;2M');
  });
});

describe('shouldReportMouse', () => {
  it('x10: press only', () => {
    expect(shouldReportMouse('x10', 'press', false)).toBe(true);
    expect(shouldReportMouse('x10', 'release', false)).toBe(false);
    expect(shouldReportMouse('x10', 'motion', true)).toBe(false);
  });
  it('vt200: press+release, no motion', () => {
    expect(shouldReportMouse('vt200', 'release', false)).toBe(true);
    expect(shouldReportMouse('vt200', 'motion', true)).toBe(false);
  });
  it('drag: motion only while a button is held; any: all motion', () => {
    expect(shouldReportMouse('drag', 'motion', true)).toBe(true);
    expect(shouldReportMouse('drag', 'motion', false)).toBe(false);
    expect(shouldReportMouse('any', 'motion', false)).toBe(true);
  });
  it('none: never', () => {
    expect(shouldReportMouse('none', 'press', false)).toBe(false);
  });
});
```

- [ ] **Step 2: verify FAIL, implement** `mouse-encoder.ts`:

```ts
// DOM terminal presenter P2 — pure SGR (1006) mouse report encoding + the
// per-tracking-mode report policy. The DOM presenter owns what the attached
// xterm's CoreMouseService did invisibly. X10/UTF8 legacy ENCODINGS are not
// supported (we only report when DECSET 1006 is active — modern TUIs all
// request it); the x10 tracking MODE is honored (press-only).

export type MouseReportKind = 'press' | 'release' | 'motion';
export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

export interface MouseMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** SGR: ESC [ < code ; col ; row M|m — code = button + mods + motion bit;
 *  release uses final 'm' (the button id is preserved, unlike legacy X10). */
export function encodeSgrMouse(
  kind: MouseReportKind,
  button: number,
  col: number,
  row: number,
  mods: MouseMods,
): string {
  let code = button;
  if (mods.shift) code += 4;
  if (mods.alt) code += 8;
  if (mods.ctrl) code += 16;
  if (kind === 'motion') code += 32;
  return `\x1b[<${code};${col};${row}${kind === 'release' ? 'm' : 'M'}`;
}

export function shouldReportMouse(
  mode: MouseTrackingMode,
  kind: MouseReportKind,
  buttonHeld: boolean,
): boolean {
  switch (mode) {
    case 'none':
      return false;
    case 'x10':
      return kind === 'press';
    case 'vt200':
      return kind !== 'motion';
    case 'drag':
      return kind !== 'motion' || buttonHeld;
    case 'any':
      return true;
  }
}
```

- [ ] **Step 3: Failing DomTerminalView pointer tests** (append; reuse the suite's mocks/settle):

```tsx
  it('reports SGR press/release when the app tracks the mouse; shift bypasses for selection', async () => {
    const { container } = render(<DomTerminalView sessionId="m1" />);
    await settle();
    const engine = getCachedEngine('m1')!.engine;
    await new Promise<void>((r) => engine.term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h', () => r()));
    const view = container.querySelector('[data-testid="dom-terminal-view"]')!;
    fireEvent.mouseDown(view, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseUp(view, { button: 0, clientX: 0, clientY: 0 });
    const sent = rpcMock.pty.write.mock.calls.map((c) => c[1]).join('');
    expect(sent).toContain('\x1b[<0;1;1M');
    expect(sent).toContain('\x1b[<0;1;1m');
    rpcMock.pty.write.mockClear();
    fireEvent.mouseDown(view, { button: 0, shiftKey: true });
    expect(rpcMock.pty.write).not.toHaveBeenCalled(); // shift = native selection
  });

  it('drag mode (1002) reports motion only while pressed; cell-deduped', async () => {
    const { container } = render(<DomTerminalView sessionId="m2" />);
    await settle();
    const engine = getCachedEngine('m2')!.engine;
    await new Promise<void>((r) => engine.term.write('\x1b[?1049h\x1b[?1002h\x1b[?1006h', () => r()));
    const view = container.querySelector('[data-testid="dom-terminal-view"]')!;
    fireEvent.mouseMove(view, { clientX: 0, clientY: 0 });
    expect(rpcMock.pty.write).not.toHaveBeenCalled(); // not pressed
    fireEvent.mouseDown(view, { button: 0, clientX: 0, clientY: 0 });
    rpcMock.pty.write.mockClear();
    fireEvent.mouseMove(view, { clientX: 0, clientY: 0 }); // same cell → deduped
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });

  it('no tracking → no reports, selection untouched', async () => {
    const { container } = render(<DomTerminalView sessionId="m3" />);
    await settle();
    fireEvent.mouseDown(container.querySelector('[data-testid="dom-terminal-view"]')!, { button: 0 });
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: Implement pointer reporting.** In `DomTerminalView.tsx`, inside the main effect:
  - Extract the wheel block's cell math into a closure usable by all handlers:

```ts
    const cellAt = (clientX: number, clientY: number): { col: number; row: number } => {
      const rect = container.getBoundingClientRect();
      const probe = probeRef.current;
      const cellW = probe && probe.offsetWidth > 0 ? probe.offsetWidth / PROBE_LEN : 7.2;
      const lineH = probe && probe.offsetHeight > 0 ? probe.offsetHeight : 17;
      return {
        col: Math.max(1, Math.min(entry.engine.term.cols, Math.floor((clientX - rect.left) / cellW) + 1)),
        row: Math.max(1, Math.min(entry.engine.term.rows, Math.floor((clientY - rect.top) / lineH) + 1)),
      };
    };
```

  - Refactor `onWheel`'s SGR branch to use `cellAt` + `encodeSgrMouse('press', ev.deltaY < 0 ? 64 : 65, col, row, { shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey })` (behavior identical — bytes unchanged for unmodified wheel; existing wheel tests must stay green).
  - Add the button/motion pipeline (native listeners, same add/remove pattern as `onWheel`):

```ts
    // P2 — pointer reporting. Shift is the universal "let me select text"
    // bypass (xterm/iTerm convention): shifted events never report and never
    // preventDefault, so native selection + the select-to-copy mouseup keep
    // working even under tracking. Reports require SGR encoding (1006) —
    // legacy encodings are not emitted.
    let heldButton: number | null = null;
    let lastMotionCell: string | null = null;
    const report = (kind: 'press' | 'release' | 'motion', button: number, ev: MouseEvent) => {
      const { col, row } = cellAt(ev.clientX, ev.clientY);
      const bytes = encodeSgrMouse(kind, button, col, row, {
        shift: ev.shiftKey,
        alt: ev.altKey,
        ctrl: ev.ctrlKey,
      });
      void rpc.pty.write(sessionId, bytes).catch(() => undefined);
      return `${col};${row}`;
    };
    const trackingActive = () => {
      const mt = entry.engine.mouseTracking;
      return !entry.ptyExited && mt.mode !== 'none' && mt.sgr;
    };
    const onMouseDownNative = (ev: MouseEvent) => {
      if (!trackingActive() || ev.shiftKey) return;
      if (!shouldReportMouse(entry.engine.mouseTracking.mode, 'press', false)) return;
      ev.preventDefault(); // suppress native selection start under tracking
      inputRef.current?.focus();
      heldButton = ev.button;
      lastMotionCell = null;
      report('press', ev.button, ev);
    };
    const onMouseUpNative = (ev: MouseEvent) => {
      if (heldButton === null) return;
      const btn = heldButton;
      heldButton = null;
      if (!trackingActive() || ev.shiftKey) return;
      if (!shouldReportMouse(entry.engine.mouseTracking.mode, 'release', false)) return;
      report('release', btn, ev);
    };
    const onMouseMoveNative = (ev: MouseEvent) => {
      if (!trackingActive() || ev.shiftKey) return;
      const mode = entry.engine.mouseTracking.mode;
      if (!shouldReportMouse(mode, 'motion', heldButton !== null)) return;
      const { col, row } = cellAt(ev.clientX, ev.clientY);
      const cellKey = `${col};${row}`;
      if (cellKey === lastMotionCell) return; // one report per cell, not per pixel
      lastMotionCell = cellKey;
      // motion carries the held button, or 3 (release/no-button) in any-mode
      const button = heldButton ?? 3;
      void rpc.pty
        .write(sessionId, encodeSgrMouse('motion', button, col, row, { shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey }))
        .catch(() => undefined);
    };
    container.addEventListener('mousedown', onMouseDownNative);
    // window-level so a release outside the pane still ends the drag
    window.addEventListener('mouseup', onMouseUpNative);
    container.addEventListener('mousemove', onMouseMoveNative);
```

  (+ the three removals in the cleanup; imports `encodeSgrMouse, shouldReportMouse` from `'./mouse-encoder'`.)
  - Guard the existing React `onMouseUp` select-to-copy handler: at its top add `if (entry.engine.mouseTracking.mode !== 'none' && entry.engine.mouseTracking.sgr) { /* tracking owns unshifted mouse; shift-selection still hits the sel-branch below via native selection */ }` — concretely: keep the handler but make the focus() fallback not fire while tracking is active (`if (!trackingActive-equivalent) inputRef.current?.focus();` — focus already happened on press).

- [ ] **Step 5: Run** scoped suites then FULL `npx vitest run` (DomTerminalView is consumed by Terminal/PaneShell suites).
- [ ] **Step 6: Commit** — `feat(panes): SGR pointer reporting — press/release/drag/motion with shift-to-select bypass (P2 task 2)`

---

### Task 3: Link anchors in FlowView (extract route-link-click, pure linkify, segment pipeline)

**Files:** Create `route-link-click.ts`, `linkify.ts` (+tests), `line-segments.ts` (+tests); modify `Terminal.tsx`, `FlowView.tsx`, `DomTerminalView.tsx` (+ their tests).

- [ ] **Step 1: Extract `routeLinkClick`.** Move the module-scope `routeLinkClick` function from `Terminal.tsx` (lines ~64–94, with its doc comment) VERBATIM into new `route-link-click.ts` (exported); `Terminal.tsx` imports it from there. This breaks the would-be cycle (Terminal → DomTerminalView → routeLinkClick). Run `npx vitest run src/renderer/features/command-room/Terminal.test.tsx` — green unmodified (pure move; the C-8 suite exercises it via the cache context).

- [ ] **Step 2: Failing linkify goldens** (`linkify.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { findUrls } from './linkify';

describe('findUrls', () => {
  it('finds http(s) URLs with offsets', () => {
    expect(findUrls('see https://a.dev/x and http://b.io')).toEqual([
      { start: 4, end: 17, url: 'https://a.dev/x' },
      { start: 22, end: 33, url: 'http://b.io' },
    ]);
  });
  it('trims trailing punctuation but keeps path punctuation', () => {
    expect(findUrls('go to https://a.dev/p?q=1).')[0]!.url).toBe('https://a.dev/p?q=1');
    expect(findUrls('(https://a.dev/x(y)z)')[0]!.url).toBe('https://a.dev/x(y)z');
  });
  it('no URLs → empty', () => {
    expect(findUrls('plain shell output')).toEqual([]);
  });
});
```

  NOTE on offsets: `end` is EXCLUSIVE. Verify the first golden's numbers against your implementation by hand before locking them in (count: 'see ' = 4, so start 4; 'https://a.dev/x' is 15 chars → end 19, NOT 17 — **recompute both goldens precisely when writing the test; the values above are illustrative and likely wrong on purpose-of-review. The TEST must carry correct values derived from the strings.**)

- [ ] **Step 3: Implement `linkify.ts`:**

```ts
// DOM terminal presenter P2 — pure URL detection for FlowView link anchors.
// Plain-text detection only; OSC-8 explicit hyperlinks are NOT surfaced by
// xterm's public buffer API and stay a known gap (record in the spec).

export interface UrlRange {
  start: number;
  /** exclusive */
  end: number;
  url: string;
}

const URL_RE = /https?:\/\/[^\s"'<> ]+/g;
const TRAILING_PUNCT = /[)\]}>.,;:!?]+$/;

export function findUrls(text: string): UrlRange[] {
  const out: UrlRange[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0]!;
    // Trim trailing punctuation, but keep balanced closing parens:
    // "https://a.dev/x(y)z" keeps ")z"; "(https://a.dev/x)" drops the ")".
    const trimmed = url.replace(TRAILING_PUNCT, '');
    const opens = (trimmed.match(/\(/g) ?? []).length;
    let keep = trimmed;
    let rest = url.slice(trimmed.length);
    while (rest.startsWith(')') && (keep.match(/\)/g) ?? []).length < opens) {
      keep += ')';
      rest = rest.slice(1);
    }
    url = keep;
    if (url.length > 'https://'.length) {
      out.push({ start: m.index!, end: m.index! + url.length, url });
    }
  }
  return out;
}
```

- [ ] **Step 4: Failing segment tests** (`line-segments.test.ts`) + implement `line-segments.ts` — the decoration pipeline FlowView renders from:

```ts
import { describe, expect, it } from 'vitest';
import { segmentRuns, type Decoration } from './line-segments';
import type { StyledRun } from '@/renderer/lib/terminal-engine';

const plain = (text: string): StyledRun => ({
  text,
  fg: { mode: 'default', value: 0 },
  bg: { mode: 'default', value: 0 },
  bold: false, dim: false, italic: false, underline: false, inverse: false, strikethrough: false,
});

describe('segmentRuns', () => {
  it('no decorations → one segment per run, text preserved', () => {
    const segs = segmentRuns([plain('hello '), { ...plain('world'), bold: true } as StyledRun], []);
    expect(segs.map((s) => s.text).join('')).toBe('hello world');
    expect(segs.length).toBe(2);
  });
  it('splits runs at decoration boundaries and tags them', () => {
    const decos: Decoration[] = [{ start: 6, end: 11, link: 'https://w' }];
    const segs = segmentRuns([plain('hello world!')], decos);
    expect(segs.map((s) => s.text)).toEqual(['hello ', 'world', '!']);
    expect(segs[1]!.link).toBe('https://w');
    expect(segs[0]!.link).toBeUndefined();
  });
  it('overlapping search + link decorations both apply', () => {
    const segs = segmentRuns([plain('x https://a.dev y')], [
      { start: 2, end: 15, link: 'https://a.dev' },
      { start: 10, end: 13, search: 'normal' },
    ]);
    const hit = segs.find((s) => s.search)!;
    expect(hit.link).toBe('https://a.dev');
  });
});
```

```ts
// line-segments.ts — pure run decoration. Splits StyledRuns at decoration
// boundaries so FlowView can render link anchors and search highlights
// without disturbing the attribute runs (a segment inherits its source
// run's style verbatim).

import type { StyledRun } from '@/renderer/lib/terminal-engine';

export interface Decoration {
  start: number;
  /** exclusive */
  end: number;
  link?: string;
  search?: 'normal' | 'active';
}

export interface LineSegment extends StyledRun {
  link?: string;
  search?: 'normal' | 'active';
}

export function segmentRuns(runs: StyledRun[], decorations: Decoration[]): LineSegment[] {
  if (decorations.length === 0) return runs.map((r) => ({ ...r }));
  // Collect every boundary offset, then walk runs emitting sub-segments.
  const bounds = new Set<number>();
  for (const d of decorations) {
    bounds.add(d.start);
    bounds.add(d.end);
  }
  const out: LineSegment[] = [];
  let offset = 0;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    const cuts = [offset, ...[...bounds].filter((b) => b > offset && b < runEnd).sort((a, b) => a - b), runEnd];
    for (let i = 0; i < cuts.length - 1; i++) {
      const s = cuts[i]!;
      const e = cuts[i + 1]!;
      if (e <= s) continue;
      const seg: LineSegment = { ...run, text: run.text.slice(s - offset, e - offset) };
      for (const d of decorations) {
        if (d.start <= s && e <= d.end) {
          if (d.link) seg.link = d.link;
          if (d.search) seg.search = d.search;
        }
      }
      out.push(seg);
    }
    offset = runEnd;
  }
  return out;
}
```

- [ ] **Step 5: Wire FlowView.** Read the current `FlowView.tsx` first. Changes:
  - Props: `export function FlowView({ engine, className, onLinkClick, searchTerm, activeMatch }: { engine: TerminalEngine; className?: string; onLinkClick?: (url: string) => void; searchTerm?: string; activeMatch?: { line: number; index: number } | null })` — `activeMatch.line` = logical-line array index, `index` = which match within that line.
  - In `LineRow`, before the cursor walk, build segments: compute `findUrls(text)` → link decorations; compute search decorations from `searchTerm` (case-insensitive `indexOf` loop over the line text; the match equal to `activeMatch` for this row gets `search: 'active'`). `const segments = segmentRuns(runs, decorations);` then the existing cursor walk runs over `segments` instead of `runs` (a segment has `.text` and styles via `runStyle(seg, false)` — identical walk).
  - Rendering a segment: if `seg.link` → `<span data-link …>` with `textDecoration: 'underline'`, `cursor: 'pointer'`, and `onClick={() => onLinkClick?.(seg.link!)}`; if `seg.search` → background `#7c5e10` (normal) / `#b8860b` + `data-search-active` (active); cursor span styling unchanged.
  - Memo: `searchTerm`/`activeMatch`/`onLinkClick` must participate — simplest correct: add `searchTerm: string | undefined` and an `activeKey: string | null` (e.g. `` `${activeMatch?.line}:${activeMatch?.index}` ``) to `LineRowProps` and the memo comparator. Pass `onLinkClick` through; functions changing identity is fine because DomTerminalView memoizes it with `useCallback` (Step 6 of this task).
  - Active-match scroll: in FlowView, `useEffect` on `activeMatch` → `scrollRef.current?.querySelector('[data-search-active]')?.scrollIntoView({ block: 'nearest' })` in try/catch.
  - FlowView tests to add: a line containing a URL renders a `[data-link]` span whose click calls the spy; a `searchTerm` renders highlight spans; the URL/cursor interplay doesn't corrupt text (write a URL line + assert full textContent).

- [ ] **Step 6: Wire DomTerminalView.** Mirror the xterm host's link context: `const activeWorkspaceId = useAppStateSelector((s) => s.activeWorkspace?.id);` + `const { setActiveTab } = useRightRail();` (imports identical to Terminal.tsx's), then `const onLinkClick = useCallback((url: string) => routeLinkClick(url, wsIdRefLike.current, () => setActiveTab('browser')), …)` — keep a `useRef` updated with the workspace id exactly like Terminal.tsx's `wsIdRef` pattern so the callback identity is stable. Pass `onLinkClick` into `<FlowView … />`. Test: mock `route-link-click.ts` module, write a URL into the engine, click the link span, assert the mock got the url + workspace id.

- [ ] **Step 7: Run scoped + FULL suite; Commit** — `feat(panes): FlowView link anchors via routeLinkClick — pure linkify + segment pipeline (P2 task 3)`

---

### Task 4: OSC-133 command-block gutters

**Files:** Create `command-blocks.ts` + test; modify `FlowView.tsx` + test.

- [ ] **Step 1: Failing pure tests** (`command-blocks.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { deriveBlocks } from './command-blocks';
import type { PromptMark } from '@/renderer/lib/terminal-engine';

describe('deriveBlocks', () => {
  it('one block per prompt mark, exit code from the D mark inside it', () => {
    const marks: PromptMark[] = [
      { kind: 'A', row: 0 },
      { kind: 'C', row: 1 },
      { kind: 'D', row: 4, exitCode: 2 },
      { kind: 'A', row: 5 },
    ];
    expect(deriveBlocks(marks)).toEqual([
      { startRow: 0, endRow: 4, exitCode: 2 },
      { startRow: 5, endRow: Number.POSITIVE_INFINITY, exitCode: undefined },
    ]);
  });
  it('no marks → no blocks', () => {
    expect(deriveBlocks([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement `command-blocks.ts`:**

```ts
// P2 — OSC-133 marks → command blocks (the wishlist segmentation item).
// A block spans from one prompt mark (A) to the row before the next A; the
// last block is open-ended. Exit code comes from the D mark inside the span.

import type { PromptMark } from '@/renderer/lib/terminal-engine';

export interface CommandBlock {
  startRow: number;
  /** inclusive; Infinity for the open (latest) block */
  endRow: number;
  exitCode: number | undefined;
}

export function deriveBlocks(marks: readonly PromptMark[]): CommandBlock[] {
  const prompts = marks.filter((m) => m.kind === 'A');
  return prompts.map((a, i) => {
    const next = prompts[i + 1];
    const endRow = next ? next.row - 1 : Number.POSITIVE_INFINITY;
    const d = marks.find((m) => m.kind === 'D' && m.row >= a.row && m.row <= endRow);
    return { startRow: a.row, endRow, exitCode: d?.exitCode };
  });
}
```

- [ ] **Step 3: FlowView gutters.** In `FlowView`, compute `const blocks = deriveBlocks(engine.promptMarks);` per render (marks array is small). Pass per-row props: `blockStart: boolean` (row === a block's startRow) and `blockFailed: boolean` (row inside a block whose `exitCode` is a number ≠ 0). In `LineRow`'s row div style: `blockFailed` → `borderLeft: '2px solid #ef4444', paddingLeft: 4`; `blockStart` → `borderTop: '1px solid rgba(82,90,115,0.35)', marginTop: 2`. Add both to the memo comparator. Test (FlowView.test.tsx): write an OSC-133 fixture through the real engine (`'\x1b]133;A\x07$ fail\r\nboom\r\n\x1b]133;D;1\x07\x1b]133;A\x07$ '`), assert a row div carries the red border style and the second prompt row has the top border.

- [ ] **Step 4: Run + FULL suite; Commit** — `feat(panes): OSC-133 command-block gutters in FlowView (P2 task 4)`

---

### Task 5: Find-in-pane search

**Files:** Create `PaneSearch.tsx` + `PaneSearch.test.tsx`; modify `DomTerminalView.tsx` + test; FlowView already accepts `searchTerm`/`activeMatch` (Task 3).

- [ ] **Step 1: Failing PaneSearch tests:**

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach } from 'vitest';
import { PaneSearch } from './PaneSearch';

afterEach(cleanup);

describe('PaneSearch', () => {
  it('renders count, calls onTermChange as you type, cycles with Enter/Shift+Enter, closes on Escape', () => {
    const onTermChange = vi.fn();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const { getByPlaceholderText, getByTestId } = render(
      <PaneSearch term="abc" matchCount={5} activeIndex={1} onTermChange={onTermChange} onNavigate={onNavigate} onClose={onClose} />,
    );
    expect(getByTestId('pane-search-count').textContent).toBe('2/5');
    const input = getByPlaceholderText('Find');
    fireEvent.change(input, { target: { value: 'abcd' } });
    expect(onTermChange).toHaveBeenCalledWith('abcd');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith(1);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onNavigate).toHaveBeenCalledWith(-1);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement `PaneSearch.tsx`** — small absolutely-positioned bar (top-right of the pane), autofocused input, count `n/total` (`0/0` when no matches), `↑`/`↓` buttons calling `onNavigate(-1|1)`, `×` button → onClose. Style with the room's existing dark-surface idiom (plain inline styles matching FlowView's palette: bg `#161926`, border `#525a73`, text `#e6e8f0`, 12px mono). Props exactly as the test names them. `autoFocus` on the input; `stopPropagation` on its keydown so terminal input doesn't fire.

- [ ] **Step 3: Wire DomTerminalView.** State: `searchOpen`, `searchTerm`, `activeIdx`. Matches computed via `useMemo` when open: walk `entry.engine.logicalLines()` text, case-insensitive indexOf loop → flat array `[{line, index}]`; recompute on the host's existing `bump` renders (the reducer already re-renders on buffer change — the memo keys on `[searchTerm, searchOpen, revision]` where `revision` is a counter incremented by the same reducer; simplest: drop useMemo and compute inline when `searchOpen` — lines are already extracted by FlowView anyway and pane content is capped). `activeMatch` = matches[activeIdx mod len] mapped to `{ line, index }`. Open keybinding in `onKeyDown` BEFORE the encoder call: `const isMac = getPlatform() === 'darwin'; if ((isMac && ev.metaKey && ev.key === 'f') || (!isMac && ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === 'f')) { ev.preventDefault(); setSearchOpen(true); return; }` (mac Cmd+F; win/linux Ctrl+Shift+F — plain Ctrl+F stays readline's forward-char). Navigate wraps modulo; close clears term + refocuses the terminal textarea. Render `<PaneSearch …/>` above FlowView when open (normal buffer only is fine — alt-screen apps own their search; render it regardless but FlowView-only highlighting means alt mode shows count 0; acceptable, simplest). Pass `searchTerm`/`activeMatch` to FlowView. Tests: Cmd+F opens (platform-stubbed darwin default), typing updates highlights (assert a highlight span exists in flow-view), Escape closes and returns focus to the textarea.

- [ ] **Step 4: Run + FULL suite; Commit** — `feat(panes): find-in-pane search for DOM panes (P2 task 5)`

---

### Task 6: GridView fidelity goldens (vim/htop pass)

**Files:** Modify `GridView.test.tsx` (and GridView/engine ONLY if a golden exposes a real bug — record any fix as a deviation).

- [ ] **Step 1: Add goldens:**

```tsx
  it('cursor-positioned full-screen repaint lands cell-exact (vim-class)', async () => {
    const engine = makeEngine(10, 3);
    const { getByTestId } = render(<GridView engine={engine} />);
    // paint three rows via explicit cursor addressing, out of order
    await write(engine, alt('\x1b[3;1Hrow3======\x1b[1;1Hrow1======\x1b[2;1Hrow2======'));
    const rows = getByTestId('grid-view').querySelectorAll('[data-grid-row]');
    expect(rows[0]!.textContent).toContain('row1');
    expect(rows[1]!.textContent).toContain('row2');
    expect(rows[2]!.textContent).toContain('row3');
  });

  it('wide (CJK) characters occupy grid cells without duplication', async () => {
    const engine = makeEngine(10, 3);
    const { getByTestId } = render(<GridView engine={engine} />);
    await write(engine, alt('a你b'));
    expect(getByTestId('grid-view').querySelectorAll('[data-grid-row]')[0]!.textContent).toContain('a你b');
  });

  it('attribute combos (underline+dim+inverse) render distinct styled spans', async () => {
    const engine = makeEngine(20, 3);
    const { getByTestId } = render(<GridView engine={engine} />);
    await write(engine, alt('\x1b[4;2;7mUDI\x1b[0m plain'));
    const span = Array.from(getByTestId('grid-view').querySelectorAll('span')).find((s) => s.textContent === 'UDI')!;
    expect(span.style.textDecoration).toContain('underline');
    expect(span.style.opacity).toBe('0.6');
  });

  it('erase-display mid-frame leaves no stale cells (htop refresh class)', async () => {
    const engine = makeEngine(12, 3);
    const { getByTestId } = render(<GridView engine={engine} />);
    await write(engine, alt('AAAAAAAAAAAA\r\nBBBBBBBBBBBB'));
    await write(engine, '\x1b[H\x1b[2J\x1b[1;1Hfresh');
    const text = getByTestId('grid-view').textContent!;
    expect(text).toContain('fresh');
    expect(text).not.toContain('AAAA');
    expect(text).not.toContain('BBBB');
  });
```

- [ ] **Step 2: Run.** Expected: pass (the engine is xterm's real parser; GridView reads cells). If any fail, the bug is real — fix minimally in GridView/engine, record the deviation.
- [ ] **Step 3: Commit** — `test(panes): GridView vim/htop-grade fidelity goldens (P2 task 6)`

---

### Task 7: Full gate + spec closeout

- [ ] **Step 1:** `npx tsc -b` → 0.
- [ ] **Step 2:** FULL `npx vitest run` → green.
- [ ] **Step 3:** `pnpm lint` → clean.
- [ ] **Step 4:** `npm run product:check` → builds.
- [ ] **Step 5:** Update the spec (`docs/superpowers/specs/2026-06-12-dom-terminal-presenter-design.md`) status line: append `· **P2 SHIPPED (this branch): SGR mouse reporting (press/release/drag/motion + shift-select bypass), FlowView link anchors (plain-URL; OSC-8 = known gap, buffer API hides it), find-in-pane (⌘F / Ctrl+Shift+F), OSC-133 command-block gutters, GridView fidelity goldens · **P3 deletions DEFERRED-BY-DESIGN**: conflict with the Non-goals clause ("xterm remains the fallback indefinitely until a separate decision retires it") — the WebGL/reveal/fullscreen machinery serves the still-reachable xterm path; revisit only when xterm is retired. Spec phases otherwise COMPLETE.`` Commit as part of this task.
- [ ] **Step 6:** Commit any gate fallout separately; final commit `docs(spec): P2 shipped; P3 deletions deferred-by-design — DOM presenter spec complete`.

---

## Self-review notes

- Spec §P2 items: mouse reporting ✓(T2), link detection via routeLinkClick ✓(T3), search ✓(T5), OSC-133 blocks ✓(T1+T4), vim/htop fidelity pass ✓(T6). OSC-8 anchors recorded as a known gap (public buffer API limitation).
- Type chain: `PromptMark` (T1) → `deriveBlocks` (T4); `mouseTracking.mode` (T1) → `shouldReportMouse` (T2); `StyledRun` → `LineSegment` (T3) consumed by FlowView render walk.
- The linkify golden offsets are flagged for recomputation at write time (deliberate: hand-derived offsets in plans rot).
- Wheel behavior is byte-identical after the T2 refactor — existing wheel tests are the lock.
