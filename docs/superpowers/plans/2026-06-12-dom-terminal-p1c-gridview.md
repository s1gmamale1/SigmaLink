# DOM Terminal Presenter P1c — GridView + Conditional Fullscreen + Renderer Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cell-exact alt-screen rendering (GridView) for claude/codex/opencode panes, inline-mode claude for DOM panes (the #160 fullscreen injection becomes xterm-only), and a per-pane renderer toggle in the pane context menu.

**Architecture:** The engine gains raw single-row run extraction (`styledRow`) feeding a new viewport-only `GridView`; `DomTerminalView` switches FlowView↔GridView on buffer-type transitions, and FlowView sheds its v2.4.2 alt-screen patches (GridView owns alt now). The renderer-mode constants move to `src/shared/renderer-mode.ts` so the MAIN process can resolve a pane's mode at spawn time and include the `--settings '{"tui":"fullscreen"}'` pair only for xterm-mode claude spawns (data-driven via a new `xtermOnlyArgs` provider field). The context-menu toggle persists via the existing `setSessionRendererMode` and remounts the host through a `sigma:renderer-mode-changed` window event.

**Tech Stack:** React 19, `@xterm/headless` 6 (already present — NO new packages; pnpm cannot install from this worktree), vitest (node for engine/launcher, jsdom for components).

**Spec:** `docs/superpowers/specs/2026-06-12-dom-terminal-presenter-design.md`. **Dropped from the spec's P1 list:** `panes.renderer.agentBeta` — obsolete since v2.4.1 made `dom` the global default.

**House rules binding every task:** work ONLY inside this worktree; never run `pnpm/npm install`; gate with `pnpm lint` (NOT bare eslint — no control chars in regex literals; use string ops); FULL `npx vitest run` before any commit that touches a mocked dep or a sibling-mirrored site; no Electron/Playwright launches; commit per task; files under 500 lines.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `app/src/shared/renderer-mode.ts` | Create | pure renderer-mode constants/parsing shared by main + renderer |
| `app/src/renderer/lib/renderer-flag.ts` | Modify | consume + re-export the shared module (public API unchanged) |
| `app/src/renderer/lib/terminal-engine.ts` | Modify | `styledRow()` raw single-row runs (refactor shared cell-walk) |
| `app/src/renderer/features/command-room/run-style.ts` | Create | shared `runStyle()` (extracted from FlowView) |
| `app/src/renderer/features/command-room/GridView.tsx` | Create | cell-exact alt-buffer presenter |
| `app/src/renderer/features/command-room/FlowView.tsx` | Modify | drop alt-mode branches; consume `run-style.ts` |
| `app/src/renderer/features/command-room/DomTerminalView.tsx` | Modify | Flow↔Grid switch on buffer type |
| `app/src/shared/providers.ts` | Modify | claude fullscreen pair → new `xtermOnlyArgs` field |
| `app/src/main/core/providers/launcher.ts` | Modify | `rendererMode` opt; conditional `xtermOnlyArgs` in `buildArgs` |
| `app/src/main/core/pty/spawn-renderer-mode.ts` | Create | main-side KV → renderer-mode resolution helper |
| `app/src/main/core/workspaces/launcher.ts` | Modify | pass `rendererMode` at the spawn call (twin 1) |
| `app/src/main/core/swarms/factory-spawn.ts` | Modify | pass `rendererMode` at the spawn call (twin 2) |
| `app/src/renderer/features/command-room/Terminal.tsx` | Modify | listen for `sigma:renderer-mode-changed` |
| `app/src/renderer/features/command-room/PaneShell.tsx` | Modify | context-menu Renderer toggle item |
| Tests | Create/Modify | per task below; v2.4.2 FlowView alt tests MOVE to GridView |

---

### Task 1: Shared renderer-mode module

**Files:**
- Create: `app/src/shared/renderer-mode.ts`
- Modify: `app/src/renderer/lib/renderer-flag.ts`
- Test: `app/src/shared/renderer-mode.test.ts` (create); `app/src/renderer/lib/renderer-flag.test.ts` (must stay green UNMODIFIED — pure extraction)

- [ ] **Step 1: Write the failing test** (`app/src/shared/renderer-mode.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RENDERER_MODE,
  parseRendererMode,
  RENDERER_DEFAULT_KEY,
  rendererSessionKey,
} from './renderer-mode';

describe('renderer-mode (shared main+renderer)', () => {
  it('exposes the single source of truth for the default', () => {
    expect(DEFAULT_RENDERER_MODE).toBe('dom');
    expect(RENDERER_DEFAULT_KEY).toBe('panes.renderer.default');
    expect(rendererSessionKey('abc')).toBe('panes.renderer.abc');
  });

  it('parseRendererMode validates at the boundary', () => {
    expect(parseRendererMode('dom')).toBe('dom');
    expect(parseRendererMode('xterm')).toBe('xterm');
    expect(parseRendererMode('webgl2')).toBeNull();
    expect(parseRendererMode(null)).toBeNull();
    expect(parseRendererMode(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/shared/renderer-mode.test.ts` → module not found.

- [ ] **Step 3: Implement** `app/src/shared/renderer-mode.ts`:

```ts
// DOM terminal presenter P1c — renderer-mode constants shared by BOTH sides.
// The renderer's flag resolution (renderer-flag.ts) and the MAIN process's
// spawn-time decision (omit the claude fullscreen injection for DOM panes)
// must agree on keys, parsing, and the unset default — one drifting default
// would silently re-split install behavior from dogfood behavior (the v2.4.1
// lesson). Pure module: no Electron, no DB, no DOM.

export type RendererMode = 'xterm' | 'dom';

/** Global default KV key; per-session overrides use rendererSessionKey(). */
export const RENDERER_DEFAULT_KEY = 'panes.renderer.default';

/** The renderer when no KV is set anywhere (v2.4.1 flipped this to 'dom'). */
export const DEFAULT_RENDERER_MODE: RendererMode = 'dom';

export function rendererSessionKey(sessionId: string): string {
  return `panes.renderer.${sessionId}`;
}

export function parseRendererMode(raw: unknown): RendererMode | null {
  return raw === 'dom' || raw === 'xterm' ? raw : null;
}
```

Then refactor `app/src/renderer/lib/renderer-flag.ts`: delete its local `RendererMode` type, `RENDERER_DEFAULT_KEY`, `rendererSessionKey`, `parseMode`, and the inline `DEFAULT_RENDERER_MODE` const; import them from the shared module and re-export so existing consumers don't churn:

```ts
import {
  DEFAULT_RENDERER_MODE,
  parseRendererMode,
  RENDERER_DEFAULT_KEY,
  rendererSessionKey,
  type RendererMode,
} from '@/shared/renderer-mode';

export { DEFAULT_RENDERER_MODE, RENDERER_DEFAULT_KEY, rendererSessionKey };
export type { RendererMode };
```

(Inside `resolveRendererMode`, replace `parseMode(` with `parseRendererMode(`.) Keep everything else — the module cache, `peekRendererMode`, `resolveRendererMode`, `setSessionRendererMode`, `__resetRendererFlagCache` — byte-identical in behavior.

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/shared/renderer-mode.test.ts src/renderer/lib/renderer-flag.test.ts` → both green, renderer-flag.test.ts UNMODIFIED (pure extraction proof).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "refactor(panes): extract shared renderer-mode module — one default for main+renderer (P1c task 1)"`

---

### Task 2: Engine raw single-row extraction (`styledRow`)

**Files:**
- Modify: `app/src/renderer/lib/terminal-engine.ts`
- Test: `app/src/renderer/lib/terminal-engine.test.ts`

`styledLine()` snaps to the wrapped-run head and JOINS continuations — correct for FlowView's logical lines, wrong for a grid: an alt-screen row that autowrapped (long paste echo) would merge into its neighbor and break row-exactness. `styledRow(row)` extracts ONE buffer row, no snap, no join, same attribute-run grammar and trailing-default-whitespace trim.

- [ ] **Step 1: Write the failing tests** — append to `terminal-engine.test.ts`:

```ts
describe('TerminalEngine — styledRow (grid contract: one buffer row, no joining)', () => {
  it('extracts a single row even when the line wrapped', async () => {
    const { engine } = makeEngine({ cols: 10, rows: 5 });
    track(engine);
    await flushWrite(engine, 'abcdefghijklmnop'); // wraps: row0=abcdefghij row1=klmnop
    expect(engine.styledRow(0).map((r) => r.text).join('')).toBe('abcdefghij');
    expect(engine.styledRow(1).map((r) => r.text).join('')).toBe('klmnop');
  });

  it('keeps attribute runs and trims trailing default whitespace', async () => {
    const { engine } = makeEngine({ cols: 20, rows: 5 });
    track(engine);
    await flushWrite(engine, '\x1b[1;31mab\x1b[0mcd');
    const runs = engine.styledRow(0);
    expect(runs.length).toBe(2);
    expect(runs[0]).toMatchObject({ text: 'ab', bold: true, fg: { mode: 'palette', value: 1 } });
    expect(runs[1]!.text).toBe('cd');
  });

  it('keeps non-default trailing background cells (TUI theme fills)', async () => {
    const { engine } = makeEngine({ cols: 8, rows: 4 });
    track(engine);
    await flushWrite(engine, '\x1b[48;5;236m        \x1b[0m'); // full row of bg-painted spaces
    const runs = engine.styledRow(0);
    expect(runs.map((r) => r.text).join('').length).toBe(8);
    expect(runs[0]!.bg).toEqual({ mode: 'palette', value: 236 });
  });

  it('out-of-range row returns []', async () => {
    const { engine } = makeEngine({ cols: 10, rows: 4 });
    track(engine);
    expect(engine.styledRow(999)).toEqual([]);
    expect(engine.styledRow(-1)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/renderer/lib/terminal-engine.test.ts` → `styledRow is not a function`.

- [ ] **Step 3: Implement.** In `terminal-engine.ts`, first READ the current `styledLine` implementation. Extract its inner per-row run-walk into a private method, then build both public methods on it:

```ts
  /** Walk one buffer line's cells, appending attribute-contiguous runs to
   *  `runs` (continuing `cur` across calls so wrapped rows can merge). */
  private appendRowRuns(
    line: NonNullable<ReturnType<IBuffer['getLine']>>,
    runs: StyledRun[],
    cur: StyledRun | null,
    work: IBufferCell,
  ): StyledRun | null {
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, work);
      if (!cell || cell.getWidth() === 0) continue; // wide-char continuation
      const chars = cell.getChars() || ' ';
      const fg = cellColor(cell.getFgColorMode(), cell.getFgColor(), cell.isFgPalette(), cell.isFgRGB());
      const bg = cellColor(cell.getBgColorMode(), cell.getBgColor(), cell.isBgPalette(), cell.isBgRGB());
      const bold = !!cell.isBold();
      const dim = !!cell.isDim();
      const italic = !!cell.isItalic();
      const underline = !!cell.isUnderline();
      const inverse = !!cell.isInverse();
      const strikethrough = !!cell.isStrikethrough();
      if (
        cur &&
        sameColor(cur.fg, fg) && sameColor(cur.bg, bg) &&
        cur.bold === bold && cur.dim === dim && cur.italic === italic &&
        cur.underline === underline && cur.inverse === inverse &&
        cur.strikethrough === strikethrough
      ) {
        cur.text += chars;
      } else {
        cur = { text: chars, fg, bg, bold, dim, italic, underline, inverse, strikethrough };
        runs.push(cur);
      }
    }
    return cur;
  }

  /** Trim trailing DEFAULT-styled whitespace in place (parity with
   *  translateToString(true)); painted trailing cells are kept. */
  private trimTrailingDefaultWhitespace(runs: StyledRun[]): void {
    while (runs.length > 0) {
      const last = runs[runs.length - 1]!;
      if (last.fg.mode === 'default' && last.bg.mode === 'default' && !last.inverse && !last.underline && !last.strikethrough) {
        last.text = last.text.replace(/[ ]+$/, '');
        if (last.text === '') {
          runs.pop();
          continue;
        }
      }
      break;
    }
  }

  /**
   * GridView contract — ONE buffer row as attribute runs: no wrapped-run
   * snapping, no continuation joining (a grid row is a grid row even if the
   * app's output autowrapped). Trailing default whitespace trimmed; painted
   * trailing cells (TUI theme fills) kept.
   */
  styledRow(row: number): StyledRun[] {
    const buf = this.term.buffer.active;
    if (row < 0 || row >= buf.length) return [];
    const line = buf.getLine(row);
    if (!line) return [];
    const runs: StyledRun[] = [];
    this.appendRowRuns(line, runs, null, buf.getNullCell());
    this.trimTrailingDefaultWhitespace(runs);
    return runs;
  }
```

Rewrite `styledLine` to use the same helpers (behavior identical — its existing tests are the proof):

```ts
  styledLine(startRow: number): StyledRun[] {
    const buf = this.term.buffer.active;
    if (buf.length === 0) return [];
    let row = Math.min(Math.max(0, startRow), buf.length - 1);
    while (row > 0 && buf.getLine(row)?.isWrapped) row--;
    const runs: StyledRun[] = [];
    const work = buf.getNullCell();
    let cur: StyledRun | null = null;
    let r = row;
    for (;;) {
      const line = buf.getLine(r);
      if (!line) break;
      cur = this.appendRowRuns(line, runs, cur, work);
      r++;
      if (r >= buf.length || !buf.getLine(r)?.isWrapped) break;
    }
    this.trimTrailingDefaultWhitespace(runs);
    return runs;
  }
```

For the `IBuffer`/`IBufferCell` types in the private-method signatures, import them: `import type { IBuffer, IBufferCell } from '@xterm/headless';` — if those names aren't exported by the typings, type the params structurally instead (`line: { length: number; getCell(x: number, c?: unknown): ... }` is NOT acceptable — check the typings file `node_modules/@xterm/headless/typings/xterm-headless.d.ts` first; both interfaces exist there in the `@xterm/headless` module declaration).

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/renderer/lib/terminal-engine.test.ts` → ALL green (the pre-existing styledLine suite proves the refactor is behavior-identical).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(panes): engine styledRow — raw single-row runs for GridView (P1c task 2)"`

---

### Task 3: Shared run-style + GridView

**Files:**
- Create: `app/src/renderer/features/command-room/run-style.ts`, `app/src/renderer/features/command-room/GridView.tsx`
- Modify: `app/src/renderer/features/command-room/FlowView.tsx` (consume run-style.ts ONLY — alt removal is Task 4)
- Test: `app/src/renderer/features/command-room/GridView.test.tsx` (create)

- [ ] **Step 1: Extract `run-style.ts`** (move, don't rewrite — copy FlowView's current `runStyle` verbatim, renaming the `alt` param to `block`):

```ts
// DOM terminal presenter P1c — shared run → CSSProperties mapping for both
// presenters. `block: true` renders the run as an inline-block (background
// fills the full line box — the v2.4.2 stripe lesson); GridView always uses
// block, FlowView never does (flowing text must stay inline for selection
// and natural wrapping).

import type { CSSProperties } from 'react';
import type { StyledRun } from '@/renderer/lib/terminal-engine';
import { colorFor, DEFAULT_BG, DEFAULT_FG } from './ansi-palette';

export function runStyle(run: StyledRun, block: boolean): CSSProperties {
  let color = colorFor(run.fg, 'fg');
  let background = colorFor(run.bg, 'bg');
  if (run.inverse) {
    const fgResolved = color ?? DEFAULT_FG;
    const bgResolved = background ?? DEFAULT_BG;
    color = bgResolved;
    background = fgResolved;
  }
  const style: CSSProperties = {};
  if (block) {
    style.display = 'inline-block';
    style.verticalAlign = 'top';
  }
  if (color) style.color = color;
  if (background) style.backgroundColor = background;
  if (run.bold) style.fontWeight = 700;
  if (run.dim) style.opacity = 0.6;
  if (run.italic) style.fontStyle = 'italic';
  const deco = [run.underline ? 'underline' : '', run.strikethrough ? 'line-through' : '']
    .filter(Boolean)
    .join(' ');
  if (deco) style.textDecoration = deco;
  return style;
}

export const CURSOR_STYLE: CSSProperties = { backgroundColor: '#a78bfa', color: '#0a0c12' };
```

In `FlowView.tsx`: delete the local `runStyle` function, import `{ runStyle, CURSOR_STYLE }` from `'./run-style'`, replace the two literal cursor style objects (`{ backgroundColor: '#a78bfa', color: '#0a0c12' }`) with `CURSOR_STYLE` (spread where merged: `{ ...style, ...CURSOR_STYLE }`), and pass the existing `alt` flag through as the `block` arg. Run `npx vitest run src/renderer/features/command-room/FlowView.test.tsx` — green, unmodified (pure extraction).

- [ ] **Step 2: Write the failing GridView tests** (`GridView.test.tsx`):

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TerminalEngine } from '@/renderer/lib/terminal-engine';
import { GridView } from './GridView';

const engines: TerminalEngine[] = [];
function makeEngine(cols = 20, rows = 5): TerminalEngine {
  const e = new TerminalEngine({ writeToPty: () => undefined }, { cols, rows });
  engines.push(e);
  return e;
}
function write(engine: TerminalEngine, data: string): Promise<void> {
  return act(() => new Promise<void>((r) => engine.term.write(data, () => setTimeout(r, 40))));
}

afterEach(() => {
  cleanup();
  for (const e of engines.splice(0)) e.dispose();
});

/** Enter alt screen first — GridView is the alt-buffer presenter. */
function alt(data = ''): string {
  return '\x1b[?1049h' + data;
}

describe('GridView', () => {
  it('renders exactly term.rows row divs (viewport-only, no scrollback)', async () => {
    const engine = makeEngine(20, 5);
    const { getByTestId } = render(<GridView engine={engine} />);
    await write(engine, alt('hello'));
    const rows = getByTestId('grid-view').querySelectorAll('[data-grid-row]');
    expect(rows.length).toBe(5);
    expect(rows[0]!.textContent).toContain('hello');
  });

  it('a row never wraps: white-space pre + hidden overflow on each row', async () => {
    const engine = makeEngine(10, 4);
    const { getByTestId } = render(<GridView engine={engine} />);
    await write(engine, alt('0123456789'));
    const row = getByTestId('grid-view').querySelector('[data-grid-row]') as HTMLElement;
    expect(row.style.whiteSpace).toBe('pre');
    expect(row.style.overflow).toBe('hidden');
  });

  it('run backgrounds are inline-block (full row height — no stripes)', async () => {
    const engine = makeEngine(12, 4);
    const { getByTestId } = render(<GridView engine={engine} />);
    await write(engine, alt('\x1b[48;5;236m' + 'X'.repeat(12) + '\x1b[0m'));
    const painted = Array.from(getByTestId('grid-view').querySelectorAll('span')).find(
      (sp) => sp.textContent === 'X'.repeat(12),
    )!;
    expect(painted.style.display).toBe('inline-block');
  });

  it('renders the cursor block at the cursor cell', async () => {
    const engine = makeEngine(20, 5);
    const { getByTestId } = render(<GridView engine={engine} />);
    await write(engine, alt('ab'));
    const cursor = getByTestId('grid-view').querySelector('[data-cursor]')!;
    expect(cursor).toBeTruthy();
    const row = cursor.closest('[data-grid-row]')!;
    let before = '';
    for (const node of Array.from(row.childNodes)) {
      if (node === cursor || (node instanceof Element && node.contains(cursor))) break;
      before += node.textContent ?? '';
    }
    expect(before).toBe('ab'); // cursor at col 2 after typing 'ab'
  });

  it('updates on buffer changes (TUI repaint)', async () => {
    const engine = makeEngine(20, 5);
    const { getByTestId } = render(<GridView engine={engine} />);
    await write(engine, alt('first'));
    await write(engine, '\x1b[H\x1b[2Ksecond'); // home + clear-line + repaint
    expect(getByTestId('grid-view').textContent).toContain('second');
    expect(getByTestId('grid-view').textContent).not.toContain('first');
  });
});
```

- [ ] **Step 3: Run, verify FAIL** — `npx vitest run src/renderer/features/command-room/GridView.test.tsx` → module not found.

- [ ] **Step 4: Implement** `GridView.tsx`:

```tsx
// DOM terminal presenter P1c — the cell-exact alt-screen presenter (spec
// §GridView). Alt-buffer TUIs (claude fullscreen, codex/opencode ratatui)
// paint a rows×cols viewport with cursor positioning; rendering them as
// flowing logical lines (FlowView) was legible but not cell-exact. GridView
// renders exactly term.rows fixed-height rows from the active buffer's
// viewport: white-space pre (rows NEVER wrap), inline-block run spans
// (backgrounds fill the row — v2.4.2 stripe lesson), block cursor at the
// cursor cell. Viewport-only by construction: the alt buffer has no
// scrollback, and wheel input is routed upstream by DomTerminalView (SGR
// reports / arrow fallback). No mouse-position reporting yet (P2).

import { useEffect, useReducer } from 'react';
import type { TerminalEngine } from '@/renderer/lib/terminal-engine';
import { DEFAULT_BG, DEFAULT_FG } from './ansi-palette';
import { CURSOR_STYLE, runStyle } from './run-style';

const MONO_FONT =
  'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

export function GridView({ engine, className }: { engine: TerminalEngine; className?: string }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => engine.onBufferChanged(bump), [engine]);

  const buf = engine.term.buffer.active;
  const rows = engine.term.rows;
  // Viewport top in absolute buffer rows. The alt buffer normally has
  // length === rows (no scrollback), making this 0; the clamp keeps us
  // correct if an implementation detail ever pads it.
  const top = Math.max(0, buf.length - rows);
  const cursor = engine.cursor;

  const rowNodes = [];
  for (let i = 0; i < rows; i++) {
    const absRow = top + i;
    const runs = engine.styledRow(absRow);
    const children: React.ReactNode[] = [];
    let cursorPlaced = false;
    const cursorCol = absRow === cursor.row ? cursor.col : null;
    let consumed = 0;
    runs.forEach((run, ri) => {
      if (cursorCol !== null && !cursorPlaced && cursorCol < consumed + run.text.length) {
        const at = cursorCol - consumed;
        const before = run.text.slice(0, at);
        const cursorChar = run.text.slice(at, at + 1) || ' ';
        const after = run.text.slice(at + 1);
        const style = runStyle(run, true);
        if (before) children.push(<span key={`${ri}b`} style={style}>{before}</span>);
        children.push(
          <span key={`${ri}c`} data-cursor style={{ ...style, ...CURSOR_STYLE }}>
            {cursorChar}
          </span>,
        );
        if (after) children.push(<span key={`${ri}a`} style={style}>{after}</span>);
        cursorPlaced = true;
      } else {
        children.push(<span key={ri} style={runStyle(run, true)}>{run.text}</span>);
      }
      consumed += run.text.length;
    });
    if (cursorCol !== null && !cursorPlaced) {
      const pad = cursorCol - consumed;
      if (pad > 0) children.push(<span key="cpad" style={{ display: 'inline-block', verticalAlign: 'top' }}>{' '.repeat(pad)}</span>);
      children.push(
        <span key="ce" data-cursor style={{ display: 'inline-block', verticalAlign: 'top', ...CURSOR_STYLE }}>
          {' '}
        </span>,
      );
    }
    rowNodes.push(
      <div
        key={i}
        data-grid-row={i}
        style={{ whiteSpace: 'pre', overflow: 'hidden', height: '1.4em', lineHeight: 1.4 }}
      >
        {children.length > 0 ? children : ' '}
      </div>,
    );
  }

  return (
    <div
      className={className}
      data-testid="grid-view"
      style={{
        height: '100%',
        overflow: 'hidden',
        background: DEFAULT_BG,
        color: DEFAULT_FG,
        fontFamily: MONO_FONT,
        fontSize: 12,
        lineHeight: 1.4,
        userSelect: 'text',
        padding: '4px 6px',
        boxSizing: 'border-box',
      }}
    >
      {rowNodes}
    </div>
  );
}
```

(No memoization: ≤ ~60 rows re-rendered per coalesced change is cheap, and TUIs repaint dense regions anyway. The padding values match FlowView's so the probe-based cols/rows math in DomTerminalView stays valid for both.)

- [ ] **Step 5: Run, verify PASS** — `npx vitest run src/renderer/features/command-room/GridView.test.tsx src/renderer/features/command-room/FlowView.test.tsx`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(panes): GridView cell-exact alt-screen presenter + shared run-style (P1c task 3)"`

---

### Task 4: DomTerminalView Flow↔Grid switch; FlowView sheds alt mode

**Files:**
- Modify: `app/src/renderer/features/command-room/DomTerminalView.tsx`, `app/src/renderer/features/command-room/FlowView.tsx`
- Test: `app/src/renderer/features/command-room/DomTerminalView.test.tsx`, `app/src/renderer/features/command-room/FlowView.test.tsx`

- [ ] **Step 1: Write the failing switch test** — append to `DomTerminalView.test.tsx`:

```tsx
  it('switches FlowView↔GridView on buffer-type transitions', async () => {
    const { container } = render(<DomTerminalView sessionId="d12" />);
    await settle();
    expect(container.querySelector('[data-testid="flow-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="grid-view"]')).toBeNull();
    const engine = getCachedEngine('d12')!.engine;
    await new Promise<void>((r) => engine.term.write('\x1b[?1049h', () => setTimeout(r, 40)));
    expect(container.querySelector('[data-testid="grid-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="flow-view"]')).toBeNull();
    await new Promise<void>((r) => engine.term.write('\x1b[?1049l', () => setTimeout(r, 40)));
    expect(container.querySelector('[data-testid="flow-view"]')).toBeTruthy();
  });
```

(The 40ms settle covers the engine's rAF/setTimeout-coalesced change notify, same as FlowView's `write` helper. If the assertion races flakily, wrap the writes in `act(...)` exactly like FlowView.test.tsx's helper.)

- [ ] **Step 2: Run, verify FAIL** (no grid-view ever renders).

- [ ] **Step 3: Implement the switch.** In `DomTerminalView.tsx`:
  - Add imports: `import { GridView } from './GridView';` and extend the React import: `import { useEffect, useReducer, useRef } from 'react';`
  - Inside the component, before the main effect, add a change subscription so the HOST re-renders when the buffer type flips (FlowView/GridView subscribe internally for content, but the host must re-evaluate WHICH one to mount):

```tsx
  // Re-render the host on engine changes so the Flow↔Grid switch reacts to
  // alt-screen enter/exit (1049h/l). Cheap: the host renders a few divs.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => entry.engine.onBufferChanged(bump), [entry]);
```

  - Replace `<FlowView engine={entry.engine} />` in the JSX with:

```tsx
      {entry.engine.bufferType === 'alternate' ? (
        <GridView engine={entry.engine} />
      ) : (
        <FlowView engine={entry.engine} />
      )}
```

- [ ] **Step 4: De-alt FlowView.** GridView now owns the alternate buffer, so FlowView's v2.4.2 alt branches are dead weight:
  - Remove the `alt` prop from `LineRowProps`, the `LineRow` signature, the memo comparator (`prev.alt === next.alt` line), and the `<LineRow ... alt={alt} />` JSX.
  - Remove `const alt = engine.bufferType === 'alternate';` and revert the container style to unconditional flow: `whiteSpace: 'pre-wrap'`, `overflowWrap: 'anywhere'` (keep `overflowX: 'hidden'`).
  - All `runStyle(run, alt)` call sites become `runStyle(run, false)`.
  - In `FlowView.test.tsx`: DELETE the two v2.4.2 alt-mode tests (`'alt-screen: rows never CSS-wrap and run backgrounds fill the row (TUI fidelity)'` — its semantics now live in GridView.test.tsx — and keep `'normal buffer keeps flowing: pre-wrap container, plain inline spans'` as-is, it still pins the flow contract).

- [ ] **Step 5: Run, verify PASS** — `npx vitest run src/renderer/features/command-room/` → all command-room suites green.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(panes): DomTerminalView mounts GridView for alt-screen; FlowView returns to pure flow (P1c task 4)"`

---

### Task 5: Conditional #160 — fullscreen injection only for xterm-mode claude spawns

**Files:**
- Modify: `app/src/shared/providers.ts`, `app/src/shared/providers.test.ts`
- Modify: `app/src/main/core/providers/launcher.ts` (+ its test file — find it: `grep -rln "buildArgs\|resolveAndSpawn" src/main --include="*.test.ts"`)
- Create: `app/src/main/core/pty/spawn-renderer-mode.ts` + `app/src/main/core/pty/spawn-renderer-mode.test.ts`
- Modify: `app/src/main/core/workspaces/launcher.ts` (~line 477 call), `app/src/main/core/swarms/factory-spawn.ts` (~line 401 call)

**MANDATORY sibling sweep before coding:** `grep -rn "provider\.args\|\.args\b" src/main/core/providers src/main/core/workspaces src/main/core/swarms --include="*.ts" | grep -v test` and `grep -rn "resolveAndSpawn(" src/main --include="*.ts" | grep -v test` — if a THIRD spawn site or another `provider.args` consumer exists beyond the two known twins, it gets the same treatment; record it in the final report.

- [ ] **Step 1: Move the fullscreen pair to a new provider field.** In `app/src/shared/providers.ts`:
  - Add to the `AgentProviderDefinition` interface (next to `args`):

```ts
  /**
   * Args appended ONLY when the spawning pane renders through the legacy
   * xterm path (P1c, spec §Renderer flag). The claude fullscreen injection
   * (#160) lives here: the xterm grid needs alt-screen to keep Ink's
   * SIGWINCH reprints out of scrollback, while the DOM presenter WANTS
   * inline mode (no scrollback grid to corrupt; FlowView renders the
   * transcript as flowing lines — spec G3).
   */
  xtermOnlyArgs?: string[];
```

  - In the claude entry, change `args: ['--settings', '{"tui":"fullscreen"}'],` to:

```ts
    args: [],
    xtermOnlyArgs: ['--settings', '{"tui":"fullscreen"}'],
```

  (Keep the existing #160 rationale comment block attached, amending its first line to: `// --settings (xterm-mode panes ONLY since P1c): force the alt-screen ...`.)
  - Update the guard test in `providers.test.ts` (the `describe('claude pane spawns force the fullscreen TUI renderer')` block at ~line 147): it currently finds the `--settings` value inside `args`; point it at `xtermOnlyArgs` and add the inverse assertion:

```ts
describe('claude xterm-mode spawns force the fullscreen TUI renderer (#160, conditional since P1c)', () => {
  it("xtermOnlyArgs carry --settings with tui:'fullscreen' (valid JSON); base args are clean", () => {
    const claude = AGENT_PROVIDERS.find((p) => p.id === 'claude')!;
    const idx = claude.xtermOnlyArgs!.indexOf('--settings');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(claude.xtermOnlyArgs![idx + 1]!)).toEqual({ tui: 'fullscreen' });
    expect(claude.args).not.toContain('--settings');
  });
});
```

  (Adapt to the file's existing import/helper style — read the surrounding test first.)

- [ ] **Step 2: Thread `rendererMode` through the launcher.** In `app/src/main/core/providers/launcher.ts`:
  - Add to `ResolveAndSpawnOpts`:

```ts
  /**
   * Which renderer hosts this pane (P1c). Decides whether xtermOnlyArgs are
   * appended. Unset resolves to the shared DEFAULT_RENDERER_MODE — main and
   * renderer must never disagree on the default (v2.4.1 lesson).
   */
  rendererMode?: RendererMode;
```

  with `import { DEFAULT_RENDERER_MODE, type RendererMode } from '../../../shared/renderer-mode';` (match the file's existing relative-import style for shared — check how it imports `AgentProviderDefinition` and mirror that path style).
  - In `buildArgs`, after `out.push(...provider.args);` add:

```ts
  // P1c — xterm-only args (claude's #160 fullscreen injection): the DOM
  // presenter wants inline mode, the xterm grid needs alt-screen.
  const rendererMode = opts.rendererMode ?? DEFAULT_RENDERER_MODE;
  if (rendererMode === 'xterm' && provider.xtermOnlyArgs?.length) {
    out.push(...provider.xtermOnlyArgs);
  }
```

  - Find the launcher's test file and update/extend: claude spawn argv WITH `rendererMode: 'xterm'` contains the `--settings` pair; WITH `'dom'` does not; with the field omitted does not (dom default). Follow the file's existing fixture style for constructing opts/deps. If existing tests asserted the pair unconditionally, fix them to pass `rendererMode: 'xterm'`.

- [ ] **Step 3: Main-side mode resolution helper.** Create `app/src/main/core/pty/spawn-renderer-mode.ts`:

```ts
// P1c — resolve a pane's renderer mode at SPAWN time, main-side. Mirrors the
// renderer's resolution order (renderer-flag.ts): per-session KV override →
// global default KV → shared DEFAULT_RENDERER_MODE. Reads the kv table
// directly (the resume-launcher/ram-brake pattern); any failure falls back
// to the shared default — a wrong-but-consistent renderer beats a crash in
// the spawn path.

import type Database from 'better-sqlite3';
import {
  DEFAULT_RENDERER_MODE,
  parseRendererMode,
  RENDERER_DEFAULT_KEY,
  rendererSessionKey,
  type RendererMode,
} from '../../../shared/renderer-mode';

function readKv(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * `sessionId` is the SigmaLink session row id when known (resume/respawn —
 * a per-session override may exist); fresh spawns pass their pre-allocated
 * id or undefined (no override can exist yet — global/default applies).
 */
export function resolveSpawnRendererMode(
  db: Database.Database,
  sessionId?: string | null,
): RendererMode {
  if (sessionId) {
    const per = parseRendererMode(readKv(db, rendererSessionKey(sessionId)));
    if (per) return per;
  }
  return parseRendererMode(readKv(db, RENDERER_DEFAULT_KEY)) ?? DEFAULT_RENDERER_MODE;
}
```

  Test (`spawn-renderer-mode.test.ts`) — **better-sqlite3 cannot load under vitest (Electron ABI)**: use a fake with a `prepare(...).get(...)` shape, NEVER `new Database()`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveSpawnRendererMode } from './spawn-renderer-mode';

function fakeDb(rows: Record<string, string>) {
  return {
    prepare: () => ({
      get: (key: string) => (key in rows ? { value: rows[key] } : undefined),
    }),
  } as unknown as import('better-sqlite3').Database;
}

describe('resolveSpawnRendererMode', () => {
  it('per-session override wins', () => {
    const db = fakeDb({ 'panes.renderer.s1': 'xterm', 'panes.renderer.default': 'dom' });
    expect(resolveSpawnRendererMode(db, 's1')).toBe('xterm');
  });
  it('falls to the global KV, then the shared default', () => {
    expect(resolveSpawnRendererMode(fakeDb({ 'panes.renderer.default': 'xterm' }), 's2')).toBe('xterm');
    expect(resolveSpawnRendererMode(fakeDb({}), 's3')).toBe('dom');
    expect(resolveSpawnRendererMode(fakeDb({}))).toBe('dom');
  });
  it('garbage and throwing dbs resolve to the default', () => {
    expect(resolveSpawnRendererMode(fakeDb({ 'panes.renderer.default': 'vulkan' }), 's4')).toBe('dom');
    const throwing = { prepare: () => { throw new Error('locked'); } } as unknown as import('better-sqlite3').Database;
    expect(resolveSpawnRendererMode(throwing, 's5')).toBe('dom');
  });
});
```

- [ ] **Step 4: Wire BOTH spawn twins.** Read each call-site file first; both construct `resolveAndSpawn(deps, { ... })` opts objects:
  - `app/src/main/core/workspaces/launcher.ts` (~line 477): determine how this module reaches the DB (grep `db` / `deps.db` in the file; executeLaunchPlan's deps carry it — verify). Add to the opts object: `rendererMode: resolveSpawnRendererMode(<db>, opts.sessionId ?? finalPreallocSessionId),` (use the actual in-scope variable names — the resume path's session id if present, else the preallocated id; read the surrounding code for the exact names).
  - `app/src/main/core/swarms/factory-spawn.ts` (~line 401): same — `rendererMode: resolveSpawnRendererMode(<db>, <the spawn's session/prealloc id in scope>),`.
  - If a call-site genuinely has NO db handle in scope, do NOT plumb a new dep through five layers — instead pass nothing and let the launcher default apply, and FLAG it in the final report (the global-KV override would then not affect that path; acceptable only if true).
  - Update each call site's test file if it asserts the exact opts shape (grep for `resolveAndSpawn` in their tests; mock-breakage class — run the FULL suite after).

- [ ] **Step 5: Run** — `npx vitest run src/main src/shared` then FULL `npx vitest run` → green.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(panes): conditional #160 — claude fullscreen injection only for xterm-mode panes (P1c task 5)"`

---

### Task 6: Renderer toggle — context menu + live remount

**Files:**
- Modify: `app/src/renderer/features/command-room/Terminal.tsx`, `app/src/renderer/features/command-room/Terminal.test.tsx`
- Modify: `app/src/renderer/features/command-room/PaneShell.tsx`, `app/src/renderer/features/command-room/PaneShell.test.tsx`

- [ ] **Step 1: Write the failing Terminal test** — append to the renderer-switch describe in `Terminal.test.tsx` (follow its existing mock/settle helpers):

```tsx
  it('sigma:renderer-mode-changed remounts the host in the new mode', async () => {
    const { rpcSilent } = await import('@/renderer/lib/rpc');
    vi.mocked(rpcSilent.kv.get).mockResolvedValue(null); // default → dom
    const { SessionTerminal } = await import('./Terminal');
    const { setSessionRendererMode } = await import('@/renderer/lib/renderer-flag');
    const { findByTestId, queryByTestId } = render(<SessionTerminal sessionId="sess-t" />);
    expect(await findByTestId('dom-terminal-view')).toBeTruthy();

    const entry = fakeEntry('sess-t');
    getOrCreateTerminalMock.mockReturnValue(entry);
    await setSessionRendererMode('sess-t', 'xterm'); // updates the module cache
    window.dispatchEvent(
      new CustomEvent('sigma:renderer-mode-changed', { detail: { sessionId: 'sess-t' } }),
    );
    await settleFlag();
    await waitFor(() => expect(queryByTestId('dom-terminal-view')).toBeNull());
    await waitFor(() => expect(getOrCreateTerminalMock).toHaveBeenCalled());
    expect(destroyEngineMock).toHaveBeenCalledWith('sess-t'); // exclusion fired
  });
```

- [ ] **Step 2: Implement in `Terminal.tsx`.** In the `SessionTerminal` switch component, add after the resolve effect:

```tsx
  // P1c — the PaneShell context-menu toggle persists the new mode via
  // setSessionRendererMode (module cache updates first) then fires this
  // event; re-reading peek here swaps the host. The mode-exclusion effect
  // below then destroys the OTHER renderer's cache; the replacement host
  // re-seeds from the main ring-buffer snapshot (no content loss).
  useEffect(() => {
    const onModeChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionId?: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      setMode(peekRendererMode(sessionId));
    };
    window.addEventListener('sigma:renderer-mode-changed', onModeChanged);
    return () => window.removeEventListener('sigma:renderer-mode-changed', onModeChanged);
  }, [sessionId]);
```

- [ ] **Step 3: Write the failing PaneShell test** — append to `PaneShell.test.tsx` (read its existing render fixture/mocks first; it already renders panes with a context menu — follow the established pattern for opening the menu, e.g. `fireEvent.contextMenu` on the trigger):

```tsx
  it('context menu offers a renderer toggle that persists + fires the remount event', async () => {
    const { setSessionRendererMode, __resetRendererFlagCache } = await import(
      '@/renderer/lib/renderer-flag'
    );
    __resetRendererFlagCache();
    await setSessionRendererMode(SESSION_ID, 'dom'); // warm the peek cache
    const events: string[] = [];
    const onEvt = (ev: Event) =>
      events.push((ev as CustomEvent<{ sessionId?: string }>).detail?.sessionId ?? '');
    window.addEventListener('sigma:renderer-mode-changed', onEvt);
    try {
      renderPane(); // the suite's existing helper
      fireEvent.contextMenu(screen.getByTestId(/* the suite's existing trigger testid */));
      const item = await screen.findByTestId('ctx-renderer-toggle');
      expect(item.textContent).toMatch(/xterm/i); // offers the OTHER mode
      fireEvent.click(item);
      await waitFor(() => expect(events).toContain(SESSION_ID));
    } finally {
      window.removeEventListener('sigma:renderer-mode-changed', onEvt);
    }
  });
```

  (Adapt names — `SESSION_ID`, `renderPane`, the context-menu trigger — to the suite's real fixtures. If the suite mocks `@/renderer/lib/renderer-flag`, extend the mock with real-ish `peek/set` behavior backed by a Map instead of importing the real module.)

- [ ] **Step 4: Implement in `PaneShell.tsx`.** Add imports: `import { peekRendererMode, setSessionRendererMode } from '@/renderer/lib/renderer-flag';` (plus `MonitorCog` or another lucide icon already in the bundle — check the file's existing lucide import line and pick one imported nearby, or add `SquareTerminal`). Insert after the Paste `ContextMenuItem` (before the `ContextMenuSeparator`):

```tsx
          <ContextMenuItem
            data-testid="ctx-renderer-toggle"
            onSelect={() => {
              const current = peekRendererMode(activeTabId) ?? 'dom';
              const next = current === 'dom' ? 'xterm' : 'dom';
              // Cache-first persist, THEN the remount event — the switch
              // re-reads peek synchronously (renderer-flag module cache).
              void setSessionRendererMode(activeTabId, next).finally(() => {
                window.dispatchEvent(
                  new CustomEvent('sigma:renderer-mode-changed', {
                    detail: { sessionId: activeTabId },
                  }),
                );
              });
            }}
          >
            <SquareTerminal className="h-3.5 w-3.5" />
            <span>
              Renderer: switch to {(peekRendererMode(activeTabId) ?? 'dom') === 'dom' ? 'xterm' : 'DOM'}
            </span>
          </ContextMenuItem>
```

  Note for the label: `peekRendererMode` returns null until the pane's first resolve, but the menu only opens on a mounted pane whose SessionTerminal already resolved — the `?? 'dom'` covers the race harmlessly. A claude pane toggled DOM→xterm keeps its CURRENT process (already inline-mode) — the fullscreen injection only applies to NEW spawns; that's expected and not a bug (document nothing in UI; the next respawn picks it up).

- [ ] **Step 5: Run** — `npx vitest run src/renderer/features/command-room/PaneShell.test.tsx src/renderer/features/command-room/Terminal.test.tsx` → green; then FULL `npx vitest run` (PaneShell/Terminal are heavily consumed — mock-breakage sweep).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(panes): per-pane renderer toggle in the context menu (P1c task 6)"`

---

### Task 7: Full gate

- [ ] **Step 1:** `npx tsc -b` → exit 0.
- [ ] **Step 2:** FULL `npx vitest run` → green (~3850+).
- [ ] **Step 3:** `pnpm lint` → clean.
- [ ] **Step 4:** `npm run product:check` → builds (renderer bundle + electron-dist; main-process changes in Task 5 make `electron:compile` REQUIRED this time, which product:check includes).
- [ ] **Step 5:** e2e default-encoding sweep (the v1.22.1 class): `grep -rn "fullscreen\|tui\|grid-view\|flow-view" tests/e2e/ --include="*.ts"` — any spec asserting claude's fullscreen behavior or DOM-view internals gets reviewed (the xterm-cache spec already pins `panes.renderer.default=xterm` and is unaffected; claude spawns under it are xterm-mode → still get the injection → unchanged).
- [ ] **Step 6:** Fix fallout if any, re-run the full gate, commit `fix(panes): P1c gate fallout` only if changes were needed.

---

## Self-review notes (spec ↔ plan)

- **GridView cell-exact viewport (spec §GridView/P1)**: Task 3; no mouse-position reporting (P2), wheel already routed (v2.4.2). ✓
- **Mode switch Flow↔Grid on normal↔alternate (spec §Mode switch)**: Task 4 host subscription. ✓
- **Conditional #160 / claude inline under DOM (spec G3 + §Renderer flag)**: Task 5 — data-driven `xtermOnlyArgs`, shared default (one source), BOTH spawn twins + sibling sweep. xterm-mode panes keep the injection (their dup-bug protection). ✓
- **Context-menu per-pane toggle (spec §Renderer flag)**: Task 6 — persists via existing `setSessionRendererMode`, remount via window event, content survives via snapshot replay. ✓
- **agentBeta**: deliberately dropped (default already `dom` since v2.4.1) — recorded in header. ✓
- **Type consistency**: `RendererMode`/`parseRendererMode` (Task 1) used in Tasks 5–6; `StyledRun` from the engine in Tasks 2–3; `styledRow` (Task 2) consumed by GridView (Task 3); `runStyle(run, block)` (Task 3) used by FlowView(false)/GridView(true). ✓
- **P3 remains out**: WebGL/reveal/fullscreen-injection deletions, default `legacy` renaming — untouched.
