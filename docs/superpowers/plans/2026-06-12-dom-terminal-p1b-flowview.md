# DOM Terminal Presenter P1b — FlowView + Renderer Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first visible DOM-presenter pane — a `FlowView` of CSS-wrapped logical lines fed by the P1a headless engine, switchable per pane via a KV renderer flag, with content seeded from the main ring-buffer snapshot.

**Architecture:** P1a landed `TerminalEngine` (`@xterm/headless` wrapper) and `input-encoder` standalone. P1b builds the consumer chain: an `engine-cache` mirroring `terminal-cache`'s lifecycle (PTY bus + snapshot seed + exit banner), a `FlowView` React presenter (logical lines → styled span runs, CSS wrap, `content-visibility` virtualization, native selection), a `DomTerminalView` host (RefitController-driven cols/rows, hidden-textarea input via the P1a encoder), and `Terminal.tsx` becomes a renderer switch on KV `panes.renderer.*`. The xterm path is untouched except for one extracted helper and one `export` keyword.

**Tech Stack:** React 19, `@xterm/headless@6.0.0` (already a dependency from P1a — NO new packages; pnpm cannot install from this worktree), vitest (node env for engine, jsdom for components).

**Spec:** `docs/superpowers/specs/2026-06-12-dom-terminal-presenter-design.md`. P1b scope = FlowView + flag + cache integration. **Out of scope (P1c):** GridView, conditional #160 fullscreen injection, pane context-menu toggle, `panes.renderer.agentBeta`.

**Known P1b limitations (documented, not bugs):**
- A DOM-mode pane whose app enters the alternate buffer (claude under the still-unconditional #160 fullscreen injection, codex ratatui) renders the alt-buffer viewport through FlowView — legible but not cell-exact. GridView (P1c) is the real alt-screen presenter. P1b dogfood target = plain/shell panes.
- Style-only changes (SGR recolor with identical text) deep in scrollback don't re-render; the live tail zone always re-renders, which covers spinners/recolors where they actually happen.

**House rules that bind every task:** work ONLY inside this worktree (`.claude/worktrees/p1b-flowview`); gate with the repo's own scripts (`pnpm lint`, NOT bare eslint — CI's config is stricter: no control chars in regex literals); run the FULL `npx vitest run` before declaring a task done that touches a mocked dependency; never launch the Electron app or Playwright locally; commit after every task.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `app/src/renderer/lib/terminal-engine.ts` | Modify | + `StyledRun` extraction (`styledLine`) and `cursor` getter |
| `app/src/renderer/lib/terminal-engine.test.ts` | Modify | + goldens for runs/cursor |
| `app/src/renderer/features/command-room/ansi-palette.ts` | Create | pure 256-color + RGB → CSS mapping, THEME-16 parity |
| `app/src/renderer/features/command-room/ansi-palette.test.ts` | Create | palette goldens + THEME parity |
| `app/src/renderer/lib/snapshot-overlap.ts` | Create | extracted overlap-dedup helper (shared by both caches) |
| `app/src/renderer/lib/snapshot-overlap.test.ts` | Create | overlap goldens |
| `app/src/renderer/lib/terminal-cache.ts` | Modify | use shared helper; `export` THEME (no behavior change) |
| `app/src/renderer/lib/engine-cache.ts` | Create | engine lifecycle: PTY bus, snapshot seed, exit banner, destroy |
| `app/src/renderer/lib/engine-cache.test.ts` | Create | seeding/exit/destroy tests against REAL engine |
| `app/src/renderer/features/command-room/FlowView.tsx` | Create | logical-line presenter (spans, wrap, virtualization, cursor, stick-to-bottom) |
| `app/src/renderer/features/command-room/FlowView.test.tsx` | Create | jsdom + real engine |
| `app/src/renderer/features/command-room/DomTerminalView.tsx` | Create | mount host: refit, input, focus, copy-on-select |
| `app/src/renderer/features/command-room/DomTerminalView.test.tsx` | Create | jsdom input/resize/focus tests |
| `app/src/renderer/lib/renderer-flag.ts` | Create | KV-backed mode resolution, module-cached |
| `app/src/renderer/lib/renderer-flag.test.ts` | Create | resolution precedence tests |
| `app/src/renderer/features/command-room/Terminal.tsx` | Modify | `SessionTerminal` becomes the switch; existing body → `XtermTerminalHost` |
| `app/src/renderer/features/command-room/Terminal.test.tsx` | Modify | flag-resolution settle + switch tests |

---

### Task 1: Engine styled-run extraction + cursor

**Files:**
- Modify: `app/src/renderer/lib/terminal-engine.ts`
- Test: `app/src/renderer/lib/terminal-engine.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `terminal-engine.test.ts`:

```ts
describe('TerminalEngine — styled runs + cursor', () => {
  it('SGR splits a line into attribute runs', async () => {
    const { engine } = makeEngine({ cols: 40, rows: 5 });
    track(engine);
    await flushWrite(engine, '\x1b[1;31mred-bold\x1b[0m plain');
    const runs = engine.styledLine(0);
    expect(runs.length).toBe(2);
    expect(runs[0]).toMatchObject({
      text: 'red-bold',
      bold: true,
      fg: { mode: 'palette', value: 1 },
    });
    expect(runs[1]).toMatchObject({
      text: ' plain',
      bold: false,
      fg: { mode: 'default' },
    });
  });

  it('truecolor + inverse + underline attributes survive extraction', async () => {
    const { engine } = makeEngine({ cols: 40, rows: 5 });
    track(engine);
    await flushWrite(engine, '\x1b[38;2;16;32;48m\x1b[4;7mX\x1b[0m');
    const run = engine.styledLine(0)[0]!;
    expect(run.fg).toEqual({ mode: 'rgb', value: 0x102030 });
    expect(run.underline).toBe(true);
    expect(run.inverse).toBe(true);
  });

  it('a wrapped styled line extracts as ONE logical run sequence', async () => {
    const { engine } = makeEngine({ cols: 10, rows: 5 });
    track(engine);
    await flushWrite(engine, '\x1b[32m' + 'abcdefghijklmnop' + '\x1b[0m');
    const runs = engine.styledLine(0);
    expect(runs.map((r) => r.text).join('')).toBe('abcdefghijklmnop');
    expect(runs[0]!.fg).toEqual({ mode: 'palette', value: 2 });
    // asking from the continuation row snaps to the head
    expect(engine.styledLine(1).map((r) => r.text).join('')).toBe('abcdefghijklmnop');
  });

  it('wide (CJK) characters keep their text without zero-width dupes', async () => {
    const { engine } = makeEngine({ cols: 20, rows: 5 });
    track(engine);
    await flushWrite(engine, 'a你b');
    expect(engine.styledLine(0).map((r) => r.text).join('')).toBe('a你b');
  });

  it('trailing default-styled whitespace is trimmed', async () => {
    const { engine } = makeEngine({ cols: 20, rows: 5 });
    track(engine);
    await flushWrite(engine, 'hi');
    const runs = engine.styledLine(0);
    expect(runs.map((r) => r.text).join('')).toBe('hi');
  });

  it('cursor tracks absolute row/col', async () => {
    const { engine } = makeEngine({ cols: 40, rows: 5 });
    track(engine);
    await flushWrite(engine, 'one\r\ntwo');
    expect(engine.cursor).toEqual({ row: 1, col: 3 });
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/renderer/lib/terminal-engine.test.ts` → fails with `styledLine is not a function`.

- [ ] **Step 3: Implement** — in `terminal-engine.ts`, add after the `LogicalLine` interface:

```ts
/** Color of one run: default (inherit theme), palette index 0–255, or 0xRRGGBB. */
export interface RunColor {
  mode: 'default' | 'palette' | 'rgb';
  value: number;
}

/** One attribute-contiguous span of a logical line. */
export interface StyledRun {
  text: string;
  fg: RunColor;
  bg: RunColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
}
```

Add inside the class (after `logicalLines`):

```ts
  /** Absolute cursor position in the active buffer (row = baseY + cursorY). */
  get cursor(): { row: number; col: number } {
    const buf = this.term.buffer.active;
    return { row: buf.baseY + buf.cursorY, col: buf.cursorX };
  }

  /**
   * Extract the logical line starting at (or containing) `startRow` as
   * attribute-contiguous runs — the FlowView's span contract. Trailing
   * default-styled whitespace is trimmed (parity with translateToString(true)).
   */
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
      r++;
      if (r >= buf.length || !buf.getLine(r)?.isWrapped) break;
    }
    // Trim trailing default-styled whitespace (the buffer pads rows to cols).
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
    return runs;
  }
```

Add module-scope helpers (above the class):

```ts
function cellColor(_mode: number, value: number, isPalette: number, isRgb: number): RunColor {
  if (isRgb) return { mode: 'rgb', value };
  if (isPalette) return { mode: 'palette', value };
  return { mode: 'default', value: 0 };
}

function sameColor(a: RunColor, b: RunColor): boolean {
  return a.mode === b.mode && a.value === b.value;
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/renderer/lib/terminal-engine.test.ts` → all pass (including the 10 P1a goldens).

- [ ] **Step 5: Commit** — `git add src/renderer/lib/terminal-engine.ts src/renderer/lib/terminal-engine.test.ts && git commit -m "feat(panes): engine styled-run extraction + cursor accessor (P1b task 1)"`

---

### Task 2: ANSI palette module

**Files:**
- Create: `app/src/renderer/features/command-room/ansi-palette.ts`
- Modify: `app/src/renderer/lib/terminal-cache.ts` (add `export` to `THEME` only)
- Test: `app/src/renderer/features/command-room/ansi-palette.test.ts`

- [ ] **Step 1: Write the failing tests**:

```ts
// @vitest-environment jsdom
// (jsdom because the THEME-parity case imports terminal-cache, which imports @xterm/xterm)
import { describe, expect, it } from 'vitest';
import { ANSI_16, colorFor, DEFAULT_BG, DEFAULT_FG, paletteColor } from './ansi-palette';

describe('ansi-palette', () => {
  it('first 16 match the xterm THEME (single visual source of truth)', async () => {
    const { THEME } = await import('@/renderer/lib/terminal-cache');
    expect(ANSI_16).toEqual([
      THEME.black, THEME.red, THEME.green, THEME.yellow,
      THEME.blue, THEME.magenta, THEME.cyan, THEME.white,
      THEME.brightBlack, THEME.brightRed, THEME.brightGreen, THEME.brightYellow,
      THEME.brightBlue, THEME.brightMagenta, THEME.brightCyan, THEME.brightWhite,
    ]);
  });

  it('256-color cube + grayscale follow the xterm formula', () => {
    expect(paletteColor(16)).toBe('#000000');       // cube origin
    expect(paletteColor(196)).toBe('#ff0000');      // pure red corner
    expect(paletteColor(231)).toBe('#ffffff');      // cube max
    expect(paletteColor(232)).toBe('#080808');      // grayscale start
    expect(paletteColor(255)).toBe('#eeeeee');      // grayscale end
  });

  it('colorFor resolves modes; default returns null (CSS inherits)', () => {
    expect(colorFor({ mode: 'default', value: 0 }, 'fg')).toBeNull();
    expect(colorFor({ mode: 'palette', value: 1 }, 'fg')).toBe(ANSI_16[1]);
    expect(colorFor({ mode: 'rgb', value: 0x102030 }, 'bg')).toBe('#102030');
  });

  it('exposes the theme defaults FlowView paints with', () => {
    expect(DEFAULT_FG).toBe('#e6e8f0');
    expect(DEFAULT_BG).toBe('#0a0c12');
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/renderer/features/command-room/ansi-palette.test.ts` → module not found.

- [ ] **Step 3: Implement** `ansi-palette.ts`:

```ts
// DOM terminal presenter P1b — pure ANSI → CSS color mapping for FlowView.
// The 16 base colors MUST stay byte-identical to terminal-cache's THEME so a
// pane looks the same under either renderer; the parity test enforces it.

import type { RunColor } from '@/renderer/lib/terminal-engine';

export const DEFAULT_FG = '#e6e8f0';
export const DEFAULT_BG = '#0a0c12';

export const ANSI_16: readonly string[] = [
  '#0a0c12', '#ef4444', '#22c55e', '#eab308',
  '#60a5fa', '#c084fc', '#22d3ee', '#e6e8f0',
  '#525a73', '#f87171', '#4ade80', '#facc15',
  '#93c5fd', '#d8b4fe', '#67e8f9', '#f8fafc',
];

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** xterm 256-color palette: 16 theme + 6×6×6 cube + 24-step grayscale. */
export function paletteColor(index: number): string {
  const i = Math.max(0, Math.min(255, Math.trunc(index)));
  if (i < 16) return ANSI_16[i]!;
  if (i < 232) {
    const v = i - 16;
    const step = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    const r = step(Math.floor(v / 36));
    const g = step(Math.floor((v % 36) / 6));
    const b = step(v % 6);
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const gray = 8 + (i - 232) * 10;
  return `#${hex2(gray)}${hex2(gray)}${hex2(gray)}`;
}

/** Resolve a run color to CSS, or null for "default" (inherit the view's
 *  fg/bg) — keeps default-styled spans free of inline color styles. */
export function colorFor(c: RunColor, _kind: 'fg' | 'bg'): string | null {
  if (c.mode === 'palette') return paletteColor(c.value);
  if (c.mode === 'rgb') return `#${c.value.toString(16).padStart(6, '0')}`;
  return null;
}
```

In `terminal-cache.ts`, change `const THEME = {` to `export const THEME = {` (line ~166). Nothing else.

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/renderer/features/command-room/ansi-palette.test.ts src/renderer/lib/terminal-cache.test.ts` → both green (the second proves the export didn't disturb the mock-based suite).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(panes): ansi-palette CSS mapping with THEME-16 parity test (P1b task 2)"`

---

### Task 3: Snapshot-overlap helper + engine cache

**Files:**
- Create: `app/src/renderer/lib/snapshot-overlap.ts`, `app/src/renderer/lib/engine-cache.ts`
- Modify: `app/src/renderer/lib/terminal-cache.ts` (swap inline overlap block for the helper)
- Test: `app/src/renderer/lib/snapshot-overlap.test.ts`, `app/src/renderer/lib/engine-cache.test.ts`

- [ ] **Step 1: Write the failing overlap tests** (`snapshot-overlap.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { computeSnapshotOverlap, MAX_OVERLAP_SCAN } from './snapshot-overlap';

describe('computeSnapshotOverlap', () => {
  it('finds the longest snapshot-tail / pending-head overlap', () => {
    expect(computeSnapshotOverlap('abcdef', 'defghi')).toBe(3);
  });
  it('returns 0 when there is no overlap or either side is empty', () => {
    expect(computeSnapshotOverlap('abc', 'xyz')).toBe(0);
    expect(computeSnapshotOverlap('', 'abc')).toBe(0);
    expect(computeSnapshotOverlap('abc', '')).toBe(0);
  });
  it('full containment: pending entirely inside the snapshot tail', () => {
    expect(computeSnapshotOverlap('xxabc', 'abc')).toBe(3);
  });
  it('caps the scan window', () => {
    expect(MAX_OVERLAP_SCAN).toBe(65_536);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**, then implement `snapshot-overlap.ts`:

```ts
// Extracted from terminal-cache.ts (2026-06-10 finding 5b) so the xterm cache
// and the P1b engine cache share ONE overlap-dedup implementation. Main
// appends to the ring buffer per raw chunk but coalesces the renderer
// broadcast, so a byte can be in BOTH the snapshot and a pending live chunk;
// the longest snapshot-tail/pending-head overlap is dropped from pending.

/** Coalescer maxBytes — the largest single flush, hence the largest possible
 *  duplicate window. */
export const MAX_OVERLAP_SCAN = 65_536;

export function computeSnapshotOverlap(snapBuffer: string, pendingJoined: string): number {
  if (!snapBuffer || !pendingJoined) return 0;
  const max = Math.min(snapBuffer.length, pendingJoined.length, MAX_OVERLAP_SCAN);
  for (let k = max; k > 0; k--) {
    if (snapBuffer.endsWith(pendingJoined.slice(0, k))) return k;
  }
  return 0;
}
```

In `terminal-cache.ts`, replace the inline overlap block inside the snapshot IIFE (the `const joined = pending.join(''); let overlap = 0; if (snapBuffer && joined) { const MAX_OVERLAP_SCAN = 65_536; … }` section, ~lines 415–426) with:

```ts
    let skip = computeSnapshotOverlap(snapBuffer, pending.join(''));
```

(delete the now-unused `joined`/`overlap` locals; the `for (const chunk of pending)` drain below already consumes `skip`), and add the import at the top: `import { computeSnapshotOverlap } from './snapshot-overlap';`. Run `npx vitest run src/renderer/lib/terminal-cache.test.ts` — must stay green with NO test edits (pure extraction).

- [ ] **Step 3: Write the failing engine-cache tests** (`engine-cache.test.ts`):

```ts
// Engine lifecycle against the REAL TerminalEngine; only the IPC edges
// (rpc, pty buses) are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.hoisted(() => ({
  pty: {
    snapshot: vi.fn(async () => ({ buffer: '' })),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
  },
}));
vi.mock('@/renderer/lib/rpc', () => ({ rpc: rpcMock, rpcSilent: rpcMock }));

const dataSubs = vi.hoisted(() => new Map<string, (p: { sessionId: string; data: string }) => void>());
const exitSubs = vi.hoisted(() => new Map<string, (p: { sessionId: string; exitCode: number }) => void>());
vi.mock('@/renderer/lib/pty-data-bus', () => ({
  subscribePtyData: (id: string, fn: (p: { sessionId: string; data: string }) => void) => {
    dataSubs.set(id, fn);
    return () => dataSubs.delete(id);
  },
}));
vi.mock('@/renderer/lib/pty-exit-bus', () => ({
  subscribeExit: (id: string, fn: (p: { sessionId: string; exitCode: number }) => void) => {
    exitSubs.set(id, fn);
    return () => exitSubs.delete(id);
  },
}));

import { __resetEngineCache, destroyEngine, getCachedEngine, getOrCreateEngine } from './engine-cache';

function engineText(entry: ReturnType<typeof getOrCreateEngine>): string {
  return entry.engine.logicalLines().map((l) => l.text).join('\n').trimEnd();
}

/** Engine writes are queued — settle parser + the async snapshot IIFE. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  vi.clearAllMocks();
  dataSubs.clear();
  exitSubs.clear();
  rpcMock.pty.snapshot.mockImplementation(async () => ({ buffer: '' }));
});
afterEach(() => __resetEngineCache());

describe('engine-cache', () => {
  it('seeds from snapshot then drains pending without duplicating the overlap', async () => {
    let release!: (v: { buffer: string }) => void;
    rpcMock.pty.snapshot.mockImplementation(
      () => new Promise<{ buffer: string }>((r) => (release = r)),
    );
    const entry = getOrCreateEngine('s1');
    // live chunk arrives while the snapshot is in flight, duplicating its tail
    dataSubs.get('s1')!({ sessionId: 's1', data: 'world\r\n' });
    release({ buffer: 'hello world\r\n' });
    await settle();
    expect(entry.snapshotReady).toBe(true);
    expect(engineText(entry)).toBe('hello world');
  });

  it('post-snapshot live chunks write straight through', async () => {
    const entry = getOrCreateEngine('s2');
    await settle();
    dataSubs.get('s2')!({ sessionId: 's2', data: 'streamed' });
    await settle();
    expect(engineText(entry)).toContain('streamed');
  });

  it('pty exit writes the banner once and flags the entry', async () => {
    const entry = getOrCreateEngine('s3');
    await settle();
    exitSubs.get('s3')!({ sessionId: 's3', exitCode: 0 });
    exitSubs.get('s3')!({ sessionId: 's3', exitCode: 0 });
    await settle();
    expect(entry.ptyExited).toBe(true);
    const text = entry.engine.logicalLines().map((l) => l.text).join('\n');
    expect(text.match(/session exited code=0/g)).toHaveLength(1);
  });

  it('DA answers from the engine are stripped before reaching pty.write (SF-3 parity)', async () => {
    getOrCreateEngine('s4');
    await settle();
    dataSubs.get('s4')!({ sessionId: 's4', data: '\x1b[c' }); // hosted app queries DA
    await settle();
    // the engine synthesised a DA reply; the cache must NOT forward it as stdin
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });

  it('destroyEngine unsubscribes and disposes; getOrCreate is idempotent', async () => {
    const a = getOrCreateEngine('s5');
    expect(getOrCreateEngine('s5')).toBe(a);
    expect(getCachedEngine('s5')).toBe(a);
    destroyEngine('s5');
    expect(getCachedEngine('s5')).toBeUndefined();
    expect(dataSubs.has('s5')).toBe(false);
    expect(exitSubs.has('s5')).toBe(false);
  });
});
```

- [ ] **Step 4: Run, verify FAIL**, then implement `engine-cache.ts`:

```ts
// DOM terminal presenter P1b — engine-side twin of terminal-cache.ts.
// One headless TerminalEngine per DOM-mode session, owning the PTY bus
// subscription, the race-safe snapshot seed (shared overlap dedup), and the
// exit banner — the same lifecycle contract the xterm cache provides, minus
// DOM parking (a headless engine has no DOM to park).
//
// MUTUAL EXCLUSION: a session must never have BOTH a live engine and a live
// cached xterm — each owns an onData→pty.write pipe, and two pipes would
// double-answer every DA/DSR query. Terminal.tsx's renderer switch is the
// single choke point that destroys the other cache's entry on mode mount.

import { TerminalEngine } from './terminal-engine';
import { rpc } from '@/renderer/lib/rpc';
import { subscribePtyData } from './pty-data-bus';
import { subscribeExit } from './pty-exit-bus';
import { stripDeviceAttributesResponses } from './terminal-cache';
import { computeSnapshotOverlap } from './snapshot-overlap';

export const ENGINE_CACHE_LIMIT = 32;

export interface EngineCacheEntry {
  sessionId: string;
  engine: TerminalEngine;
  /** True once the underlying PTY emitted `pty:exit`. */
  ptyExited: boolean;
  /** True after the snapshot resolved and pending chunks drained. */
  snapshotReady: boolean;
  /** True while a DomTerminalView is mounted for this session — such an
   *  entry is never LRU-evicted (destroying it would blank a visible pane). */
  mounted: boolean;
  lastAccessed: number;
  unsubscribePty: () => void;
  offExit: () => void;
}

const cache = new Map<string, EngineCacheEntry>();

function evictOldestIfFull(): void {
  if (cache.size < ENGINE_CACHE_LIMIT) return;
  let exitedVictim: EngineCacheEntry | null = null;
  let liveVictim: EngineCacheEntry | null = null;
  for (const entry of cache.values()) {
    if (entry.mounted) continue;
    if (entry.ptyExited) {
      if (!exitedVictim || entry.lastAccessed < exitedVictim.lastAccessed) exitedVictim = entry;
    } else if (!liveVictim || entry.lastAccessed < liveVictim.lastAccessed) {
      liveVictim = entry;
    }
  }
  const victim = exitedVictim ?? liveVictim;
  if (victim) destroyEngine(victim.sessionId);
}

export function getOrCreateEngine(sessionId: string): EngineCacheEntry {
  const existing = cache.get(sessionId);
  if (existing) {
    existing.lastAccessed = Date.now();
    return existing;
  }
  evictOldestIfFull();

  const engine = new TerminalEngine({
    // SF-3 parity: the engine answers DA/DSR queries via onData exactly like
    // the attached xterm; the same strip applies before the PTY sees stdin.
    writeToPty: (data) => {
      const clean = stripDeviceAttributesResponses(data);
      if (clean === '') return;
      void rpc.pty.write(sessionId, clean).catch(() => undefined);
    },
  });

  const pending: string[] = [];
  let snapshotDone = false;
  const unsubscribePty = subscribePtyData(sessionId, (payload) => {
    if (!cache.has(sessionId)) return;
    if (snapshotDone) engine.write(payload.data);
    else pending.push(payload.data);
  });

  const offExit = subscribeExit(sessionId, (payload) => {
    const entry = cache.get(sessionId);
    if (!entry || entry.ptyExited) return;
    entry.ptyExited = true;
    engine.write(`\r\n\x1b[2;90m[session exited code=${payload.exitCode}]\x1b[0m\r\n`);
  });

  const entry: EngineCacheEntry = {
    sessionId,
    engine,
    ptyExited: false,
    snapshotReady: false,
    mounted: false,
    lastAccessed: Date.now(),
    unsubscribePty,
    offExit,
  };
  cache.set(sessionId, entry);

  void (async () => {
    let snapBuffer = '';
    try {
      const snap = await rpc.pty.snapshot(sessionId);
      if (!cache.has(sessionId)) return;
      if (snap.buffer) {
        snapBuffer = snap.buffer;
        engine.write(snapBuffer);
      }
    } catch {
      /* best-effort; the live subscription captured everything since attach */
    }
    let skip = computeSnapshotOverlap(snapBuffer, pending.join(''));
    for (const chunk of pending) {
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      engine.write(skip > 0 ? chunk.slice(skip) : chunk);
      skip = 0;
    }
    pending.length = 0;
    snapshotDone = true;
    entry.snapshotReady = true;
  })();

  return entry;
}

export function destroyEngine(sessionId: string): void {
  const entry = cache.get(sessionId);
  if (!entry) return;
  cache.delete(sessionId);
  try {
    entry.unsubscribePty();
  } catch {
    /* raced teardown — ignore */
  }
  try {
    entry.offExit();
  } catch {
    /* same */
  }
  try {
    entry.engine.dispose();
  } catch {
    /* same */
  }
}

export function getCachedEngine(sessionId: string): EngineCacheEntry | undefined {
  return cache.get(sessionId);
}

export function getEngineCacheSize(): number {
  return cache.size;
}

/** Test-only: wipe every cached engine. */
export function __resetEngineCache(): void {
  for (const id of Array.from(cache.keys())) destroyEngine(id);
}
```

- [ ] **Step 5: Run, verify PASS** — `npx vitest run src/renderer/lib/` → snapshot-overlap, engine-cache, terminal-cache, terminal-engine all green.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(panes): engine-cache lifecycle + shared snapshot-overlap helper (P1b task 3)"`

---

### Task 4: FlowView presenter

**Files:**
- Create: `app/src/renderer/features/command-room/FlowView.tsx`
- Test: `app/src/renderer/features/command-room/FlowView.test.tsx`

- [ ] **Step 1: Write the failing tests** (jsdom, REAL engine — no mocks):

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TerminalEngine } from '@/renderer/lib/terminal-engine';
import { FlowView, MAX_RENDER_LINES } from './FlowView';

const engines: TerminalEngine[] = [];
function makeEngine(cols = 40, rows = 10): TerminalEngine {
  const e = new TerminalEngine({ writeToPty: () => undefined }, { cols, rows });
  engines.push(e);
  return e;
}
function write(engine: TerminalEngine, data: string): Promise<void> {
  return act(() => new Promise<void>((r) => engine.term.write(data, () => setTimeout(r, 10))));
}

afterEach(() => {
  cleanup();
  for (const e of engines.splice(0)) e.dispose();
});

describe('FlowView', () => {
  it('renders logical lines as text content', async () => {
    const engine = makeEngine();
    const { getByTestId } = render(<FlowView engine={engine} />);
    await write(engine, 'alpha\r\nbeta\r\n');
    expect(getByTestId('flow-view').textContent).toContain('alpha');
    expect(getByTestId('flow-view').textContent).toContain('beta');
  });

  it('SGR runs become styled spans', async () => {
    const engine = makeEngine();
    const { getByTestId } = render(<FlowView engine={engine} />);
    await write(engine, '\x1b[1;31mhot\x1b[0m cold');
    const view = getByTestId('flow-view');
    const spans = Array.from(view.querySelectorAll('span'));
    const hot = spans.find((s) => s.textContent === 'hot')!;
    expect(hot.style.fontWeight).toBe('700');
    expect(hot.style.color).toBe('rgb(239, 68, 68)'); // ANSI_16[1] #ef4444
  });

  it('inverse swaps fg/bg against the theme defaults', async () => {
    const engine = makeEngine();
    const { getByTestId } = render(<FlowView engine={engine} />);
    await write(engine, '\x1b[7minv\x1b[0m');
    const span = Array.from(getByTestId('flow-view').querySelectorAll('span'))
      .find((s) => s.textContent === 'inv')!;
    expect(span.style.color).toBe('rgb(10, 12, 18)');               // DEFAULT_BG
    expect(span.style.backgroundColor).toBe('rgb(230, 232, 240)');  // DEFAULT_FG
  });

  it('a line longer than cols renders as ONE row div (logical join)', async () => {
    const engine = makeEngine(10, 5);
    const { getByTestId } = render(<FlowView engine={engine} />);
    await write(engine, 'abcdefghijklmnopqrst');
    const rows = getByTestId('flow-view').querySelectorAll('[data-row]');
    const joined = Array.from(rows).map((r) => r.textContent).join('');
    expect(joined).toContain('abcdefghijklmnopqrst');
    expect(
      Array.from(rows).filter((r) => r.textContent?.includes('abcdefghij')).length,
    ).toBe(1);
  });

  it('renders a cursor marker on the cursor line', async () => {
    const engine = makeEngine();
    const { getByTestId } = render(<FlowView engine={engine} />);
    await write(engine, 'prompt> ');
    expect(getByTestId('flow-view').querySelector('[data-cursor]')).toBeTruthy();
  });

  it('caps rendered rows at MAX_RENDER_LINES', async () => {
    const engine = makeEngine(80, 10);
    const { getByTestId } = render(<FlowView engine={engine} />);
    const burst = Array.from({ length: MAX_RENDER_LINES + 50 }, (_, i) => `L${i}`).join('\r\n');
    await write(engine, burst);
    const rows = getByTestId('flow-view').querySelectorAll('[data-row]');
    expect(rows.length).toBeLessThanOrEqual(MAX_RENDER_LINES);
    expect(getByTestId('flow-view').textContent).toContain(`L${MAX_RENDER_LINES + 49}`);
    expect(getByTestId('flow-view').textContent).not.toContain('L0 '); // oldest dropped from DOM
  });
});
```

(Engine `scrollback` default is 8000 — `MAX_RENDER_LINES + 50` rows stay resident, only the DOM is windowed. jsdom has no layout, so scroll-stickiness is asserted structurally — `scrollTop` assignment happens in a `useLayoutEffect` that jsdom executes but cannot meaningfully measure; do NOT write a scrollHeight assertion.)

- [ ] **Step 2: Run, verify FAIL**, then implement `FlowView.tsx`:

```tsx
// DOM terminal presenter P1b — the flowing-output presenter (spec §FlowView).
// Logical lines (isWrapped continuations pre-joined by the engine) render as
// one div per line with attribute-run spans; CSS does the wrapping, so a pane
// resize is a pure reflow — no buffer rewrap, no renderer clear, no repaint
// choreography. Native DOM selection/scroll come free (spec G1/G2).
//
// Virtualization: `content-visibility: auto` skips offscreen rendering work
// without JS measurement (logical lines have variable wrapped height, which
// breaks classic fixed-height windowing). The DOM itself is capped at the
// most recent MAX_RENDER_LINES logical lines; the engine retains the full
// 8000-line scrollback for read_pane/copy.
//
// Dirty-tracking: a row re-renders when its TEXT changes; rows inside the
// live tail (where TUIs repaint/recolor) always re-render. A style-only
// change deep in scrollback not re-rendering is a documented P1b limitation.

import { memo, useEffect, useLayoutEffect, useReducer, useRef, type CSSProperties } from 'react';
import type { StyledRun, TerminalEngine } from '@/renderer/lib/terminal-engine';
import { colorFor, DEFAULT_BG, DEFAULT_FG } from './ansi-palette';

export const MAX_RENDER_LINES = 1500;
/** Rows from the bottom that re-render on every buffer change. */
export const LIVE_TAIL_LINES = 64;
/** Estimated single-row height for content-visibility (12px × 1.4 ≈ 17). */
const LINE_HEIGHT_PX = 17;
/** Within this many px of the bottom counts as "stuck" (auto-follow). */
const STICK_SLOP_PX = 8;

const MONO_FONT =
  'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

function runStyle(run: StyledRun): CSSProperties {
  let color = colorFor(run.fg, 'fg');
  let background = colorFor(run.bg, 'bg');
  if (run.inverse) {
    const fgResolved = color ?? DEFAULT_FG;
    const bgResolved = background ?? DEFAULT_BG;
    color = bgResolved;
    background = fgResolved;
  }
  const style: CSSProperties = {};
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

interface LineRowProps {
  engine: TerminalEngine;
  startRow: number;
  text: string;
  /** Live-tail rows re-render every change (spinners, recolors, cursor). */
  live: boolean;
  /** Character offset of the cursor within this logical line, or null. */
  cursorOffset: number | null;
}

const LineRow = memo(
  function LineRow({ engine, startRow, cursorOffset }: LineRowProps) {
    const runs = engine.styledLine(startRow);
    const children: React.ReactNode[] = [];
    let consumed = 0;
    let cursorPlaced = false;
    runs.forEach((run, i) => {
      if (cursorOffset !== null && !cursorPlaced && cursorOffset < consumed + run.text.length) {
        const at = cursorOffset - consumed;
        const before = run.text.slice(0, at);
        const cursorChar = run.text.slice(at, at + 1) || ' ';
        const after = run.text.slice(at + 1);
        const style = runStyle(run);
        if (before) children.push(<span key={`${i}b`} style={style}>{before}</span>);
        children.push(
          <span key={`${i}c`} data-cursor style={{ ...style, backgroundColor: '#a78bfa', color: '#0a0c12' }}>
            {cursorChar}
          </span>,
        );
        if (after) children.push(<span key={`${i}a`} style={style}>{after}</span>);
        cursorPlaced = true;
      } else {
        children.push(<span key={i} style={runStyle(run)}>{run.text}</span>);
      }
      consumed += run.text.length;
    });
    if (cursorOffset !== null && !cursorPlaced) {
      children.push(
        <span key="ce" data-cursor style={{ backgroundColor: '#a78bfa', color: '#0a0c12' }}>
          {' '}
        </span>,
      );
    }
    return (
      <div
        data-row={startRow}
        style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${LINE_HEIGHT_PX}px` }}
      >
        {children.length > 0 ? children : ' '}
      </div>
    );
  },
  (prev, next) =>
    !next.live &&
    prev.text === next.text &&
    prev.startRow === next.startRow &&
    prev.cursorOffset === next.cursorOffset,
);

export function FlowView({ engine, className }: { engine: TerminalEngine; className?: string }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => engine.onBufferChanged(bump), [engine]);

  // Stick-to-bottom: follow output while the user is at the bottom; stop the
  // moment they scroll up; resume when they return to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLOP_PX;
  };

  const lines = engine.logicalLines();
  const visible = lines.slice(Math.max(0, lines.length - MAX_RENDER_LINES));
  const liveFromRow =
    visible.length > 0 ? visible[Math.max(0, visible.length - LIVE_TAIL_LINES)]!.startRow : 0;
  const cursor = engine.cursor;
  // Which logical line holds the cursor, and at what character offset?
  // offset = (cursor.row − line.startRow) · cols + cursor.col, because the
  // engine's wrapped rows are exactly cols wide.
  let cursorLine = -1;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i]!.startRow <= cursor.row) {
      cursorLine = i;
      break;
    }
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={className}
      data-testid="flow-view"
      style={{
        height: '100%',
        overflowY: 'auto',
        background: DEFAULT_BG,
        color: DEFAULT_FG,
        fontFamily: MONO_FONT,
        fontSize: 12,
        lineHeight: 1.4,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        userSelect: 'text',
        padding: '4px 6px',
        boxSizing: 'border-box',
      }}
    >
      {visible.map((l, i) => (
        <LineRow
          key={l.startRow}
          engine={engine}
          startRow={l.startRow}
          text={l.text}
          live={l.startRow >= liveFromRow}
          cursorOffset={
            i === cursorLine ? (cursor.row - l.startRow) * engine.term.cols + cursor.col : null
          }
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Run, verify PASS** — `npx vitest run src/renderer/features/command-room/FlowView.test.tsx`.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(panes): FlowView logical-line DOM presenter (P1b task 4)"`

---

### Task 5: DomTerminalView mount host

**Files:**
- Create: `app/src/renderer/features/command-room/DomTerminalView.tsx`
- Test: `app/src/renderer/features/command-room/DomTerminalView.test.tsx`

- [ ] **Step 1: Write the failing tests**:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const rpcMock = vi.hoisted(() => ({
  pty: {
    snapshot: vi.fn(async () => ({ buffer: '' })),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
  },
}));
vi.mock('@/renderer/lib/rpc', () => ({ rpc: rpcMock, rpcSilent: rpcMock }));
vi.mock('@/renderer/lib/pty-data-bus', () => ({ subscribePtyData: () => () => undefined }));
vi.mock('@/renderer/lib/pty-exit-bus', () => ({ subscribeExit: () => () => undefined }));

import { __resetEngineCache, getCachedEngine } from '@/renderer/lib/engine-cache';
import { DomTerminalView } from './DomTerminalView';

class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', ROStub);
});
afterEach(() => {
  cleanup();
  __resetEngineCache();
  vi.unstubAllGlobals();
});

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

describe('DomTerminalView', () => {
  it('creates a cached engine and marks it mounted; unmount clears the flag', async () => {
    const { unmount } = render(<DomTerminalView sessionId="d1" />);
    await settle();
    expect(getCachedEngine('d1')?.mounted).toBe(true);
    unmount();
    expect(getCachedEngine('d1')?.mounted).toBe(false);
    expect(getCachedEngine('d1')).toBeTruthy(); // engine survives unmount (cache-owned)
  });

  it('keydown encodes through the InputEncoder to pty.write', async () => {
    const { container } = render(<DomTerminalView sessionId="d2" />);
    await settle();
    const input = container.querySelector('textarea')!;
    fireEvent.keyDown(input, { key: 'a' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(rpcMock.pty.write.mock.calls.map((c) => c[1])).toEqual(['a', '\r', '\x1b[A']);
  });

  it('cmd-combos are NOT swallowed (encoder returns null → host app keeps them)', async () => {
    const { container } = render(<DomTerminalView sessionId="d3" />);
    await settle();
    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'c', metaKey: true });
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });

  it('paste normalizes newlines (bracketed-paste off by default)', async () => {
    const { container } = render(<DomTerminalView sessionId="d4" />);
    await settle();
    fireEvent.paste(container.querySelector('textarea')!, {
      clipboardData: { getData: () => 'one\ntwo\r\nthree' },
    });
    expect(rpcMock.pty.write).toHaveBeenCalledWith('d4', 'one\rtwo\rthree');
  });

  it('sigma:pty-focus for THIS session focuses the input host', async () => {
    const { container } = render(<DomTerminalView sessionId="d5" />);
    await settle();
    const input = container.querySelector('textarea')!;
    window.dispatchEvent(new CustomEvent('sigma:pty-focus', { detail: { sessionId: 'other' } }));
    expect(document.activeElement).not.toBe(input);
    window.dispatchEvent(new CustomEvent('sigma:pty-focus', { detail: { sessionId: 'd5' } }));
    expect(document.activeElement).toBe(input);
  });

  it('keystrokes are dropped once the PTY exited', async () => {
    const { container } = render(<DomTerminalView sessionId="d6" />);
    await settle();
    getCachedEngine('d6')!.ptyExited = true;
    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'a' });
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });
});
```

(`scrollIntoView` is not implemented in jsdom — the component must call it inside try/catch or guard with `?.`; the focus test above otherwise throws.)

- [ ] **Step 2: Run, verify FAIL**, then implement `DomTerminalView.tsx`:

```tsx
// DOM terminal presenter P1b — the per-mount host for a DOM-rendered pane
// (the engine-path twin of Terminal.tsx's xterm host). Owns the per-mount
// concerns: RefitController-driven sizing (cols from a measured probe span —
// ONE pty.resize per settle, none during drag: CSS reflows the text live for
// free, exactly the property this redesign exists for), the hidden-textarea
// input host (P1a encoder), focus routing, and select-to-copy parity.
//
// Deliberately ABSENT vs the xterm host: window:restored reveal (no GPU
// compositor state to repaint), dragFit (CSS wrap handles live drag), WebGL
// addon, link addon (FlowView anchors land in P2).

import { useEffect, useMemo, useRef } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { getOrCreateEngine } from '@/renderer/lib/engine-cache';
import { encodeKeyEvent, encodePaste } from './input-encoder';
import { FlowView } from './FlowView';
import { RefitController } from './refit-controller';

const PROBE_LEN = 10;
const PAD_X = 6; // FlowView horizontal padding — subtracted before cols math

const MONO_FONT =
  'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

export function DomTerminalView({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Idempotent cache hit — safe under StrictMode double-render.
  const entry = useMemo(() => getOrCreateEngine(sessionId), [sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    entry.mounted = true;
    entry.lastAccessed = Date.now();

    let lastCols = -1;
    let lastRows = -1;
    const runFit = () => {
      if (entry.ptyExited) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w <= 0 || h <= 0) return;
      const probe = probeRef.current;
      const cellW = probe && probe.offsetWidth > 0 ? probe.offsetWidth / PROBE_LEN : 7.2;
      const lineH = probe && probe.offsetHeight > 0 ? probe.offsetHeight : 17;
      const cols = Math.max(2, Math.floor((w - PAD_X * 2) / cellW));
      const rows = Math.max(1, Math.floor(h / lineH));
      entry.engine.resize(cols, rows);
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols;
        lastRows = rows;
        void rpc.pty.resize(sessionId, cols, rows).catch(() => undefined);
      }
    };
    // No dragFit: during a divider drag CSS re-wraps the text continuously;
    // the engine/PTY learn the final size once, on release/settle.
    const controller = new RefitController({ fit: runFit, reveal: runFit });

    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      controller.onContentRect(e.contentRect.width, e.contentRect.height);
    });
    ro.observe(container);

    const onResizeStart = () => controller.onDragStart();
    const onResizeEnd = () => controller.onDragEnd();
    window.addEventListener('sigma:pane-resize-start', onResizeStart);
    window.addEventListener('sigma:pane-resize-end', onResizeEnd);

    const onFocusReq = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionId?: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      inputRef.current?.focus();
      try {
        container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch {
        /* jsdom / unmounted */
      }
    };
    window.addEventListener('sigma:pty-focus', onFocusReq);

    return () => {
      entry.mounted = false;
      controller.dispose();
      try {
        ro.disconnect();
      } catch {
        /* already disconnected */
      }
      window.removeEventListener('sigma:pane-resize-start', onResizeStart);
      window.removeEventListener('sigma:pane-resize-end', onResizeEnd);
      window.removeEventListener('sigma:pty-focus', onFocusReq);
      // Engine is cache-owned: NOT disposed here (parity with detachFromHost).
    };
  }, [sessionId, entry]);

  const writeBytes = (bytes: string) => {
    void rpc.pty.write(sessionId, bytes).catch(() => undefined);
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (entry.ptyExited) return;
    const bytes = encodeKeyEvent(
      {
        key: ev.key,
        ctrlKey: ev.ctrlKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
        shiftKey: ev.shiftKey,
      },
      entry.engine.modes,
    );
    if (bytes === null) return; // cmd-shortcuts / bare modifiers stay with the app
    ev.preventDefault();
    writeBytes(bytes);
  };

  const onPaste = (ev: React.ClipboardEvent<HTMLTextAreaElement>) => {
    ev.preventDefault();
    if (entry.ptyExited) return;
    const text = ev.clipboardData.getData('text');
    if (!text) return;
    writeBytes(encodePaste(text, entry.engine.modes));
  };

  // Click focuses the input host — but never at the cost of an in-progress
  // text selection; select-to-copy parity with the xterm path's
  // onSelectionChange→clipboard pipe.
  const onMouseUp = () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const text = sel.toString();
      if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
      return;
    }
    inputRef.current?.focus();
  };

  return (
    <div
      ref={containerRef}
      className={className}
      onMouseUp={onMouseUp}
      data-testid="dom-terminal-view"
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
    >
      <span
        ref={probeRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          fontFamily: MONO_FONT,
          fontSize: 12,
          lineHeight: 1.4,
          whiteSpace: 'pre',
        }}
      >
        {'W'.repeat(PROBE_LEN)}
      </span>
      <FlowView engine={entry.engine} />
      <textarea
        ref={inputRef}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        aria-label="terminal input"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: 1,
          height: 1,
          opacity: 0,
          border: 'none',
          padding: 0,
          resize: 'none',
        }}
      />
    </div>
  );
}
```

- [ ] **Step 3: Run, verify PASS** — `npx vitest run src/renderer/features/command-room/DomTerminalView.test.tsx`.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(panes): DomTerminalView mount host — refit, encoder input, focus (P1b task 5)"`

---

### Task 6: Renderer flag + Terminal.tsx switch

**Files:**
- Create: `app/src/renderer/lib/renderer-flag.ts`, `app/src/renderer/lib/renderer-flag.test.ts`
- Modify: `app/src/renderer/features/command-room/Terminal.tsx`
- Modify: `app/src/renderer/features/command-room/Terminal.test.tsx`

- [ ] **Step 1: Write the failing flag tests** (`renderer-flag.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kvGet = vi.hoisted(() => vi.fn(async (_key: string): Promise<string | null> => null));
const kvSet = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { get: kvGet, set: kvSet } },
  rpcSilent: { kv: { get: kvGet, set: kvSet } },
}));

import {
  __resetRendererFlagCache,
  peekRendererMode,
  RENDERER_DEFAULT_KEY,
  rendererSessionKey,
  resolveRendererMode,
  setSessionRendererMode,
} from './renderer-flag';

beforeEach(() => vi.clearAllMocks());
afterEach(() => __resetRendererFlagCache());

describe('renderer-flag', () => {
  it('defaults to xterm when no KV is set', async () => {
    expect(await resolveRendererMode('s1')).toBe('xterm');
  });

  it('per-session override wins over the global default', async () => {
    kvGet.mockImplementation(async (key: string) => {
      if (key === rendererSessionKey('s2')) return 'dom';
      if (key === RENDERER_DEFAULT_KEY) return 'xterm';
      return null;
    });
    expect(await resolveRendererMode('s2')).toBe('dom');
  });

  it('falls through to the global default', async () => {
    kvGet.mockImplementation(async (key: string) =>
      key === RENDERER_DEFAULT_KEY ? 'dom' : null,
    );
    expect(await resolveRendererMode('s3')).toBe('dom');
  });

  it('garbage KV values resolve to xterm (validate at the boundary)', async () => {
    kvGet.mockImplementation(async () => 'webgl2-hologram');
    expect(await resolveRendererMode('s4')).toBe('xterm');
  });

  it('kv failure resolves to xterm (fallback renderer is the safe default)', async () => {
    kvGet.mockImplementation(async () => {
      throw new Error('kv down');
    });
    expect(await resolveRendererMode('s5')).toBe('xterm');
  });

  it('module-caches per session: peek is sync after first resolve, kv hit once', async () => {
    await resolveRendererMode('s6');
    expect(peekRendererMode('s6')).toBe('xterm');
    kvGet.mockClear();
    await resolveRendererMode('s6');
    expect(kvGet).not.toHaveBeenCalled();
  });

  it('setSessionRendererMode persists and updates the cache', async () => {
    await setSessionRendererMode('s7', 'dom');
    expect(peekRendererMode('s7')).toBe('dom');
    expect(kvSet).toHaveBeenCalledWith(rendererSessionKey('s7'), 'dom');
  });
});
```

- [ ] **Step 2: Run, verify FAIL**, then implement `renderer-flag.ts`:

```ts
// DOM terminal presenter P1b — which renderer hosts a pane (spec §Renderer
// flag & fallback). Per-session KV override, then the global default, then
// 'xterm' (the battle-tested fallback). Resolutions are module-cached so a
// REMOUNT (workspace/room switch) renders the right host synchronously with
// no async flash — the remount-overlay lesson (PaneSplash whiteout #131).
//
// Stored as plain KV (`panes.renderer.<sessionId>`), NOT an agent_sessions
// column: the sessions table already has SIX mirror sites for its column
// list (sync COLUMN_ALLOWLIST drift class, P13); a renderer preference does
// not earn a seventh.

import { rpc, rpcSilent } from '@/renderer/lib/rpc';

export type RendererMode = 'xterm' | 'dom';

export const RENDERER_DEFAULT_KEY = 'panes.renderer.default';

export function rendererSessionKey(sessionId: string): string {
  return `panes.renderer.${sessionId}`;
}

const resolved = new Map<string, RendererMode>();

function parseMode(raw: unknown): RendererMode | null {
  return raw === 'dom' || raw === 'xterm' ? raw : null;
}

/** Sync cache read — null until the first resolveRendererMode for the id. */
export function peekRendererMode(sessionId: string): RendererMode | null {
  return resolved.get(sessionId) ?? null;
}

export async function resolveRendererMode(sessionId: string): Promise<RendererMode> {
  const hit = resolved.get(sessionId);
  if (hit) return hit;
  let mode: RendererMode = 'xterm';
  try {
    const per = parseMode(await rpcSilent.kv.get(rendererSessionKey(sessionId)));
    if (per) {
      mode = per;
    } else {
      const def = parseMode(await rpcSilent.kv.get(RENDERER_DEFAULT_KEY));
      if (def) mode = def;
    }
  } catch {
    /* kv unreachable → xterm, the safe fallback */
  }
  resolved.set(sessionId, mode);
  return mode;
}

/** Persist a per-pane override (P1c context menu will call this; available
 *  now for dogfood via console). Cache updates first so the next mount is
 *  correct even if the KV write fails. */
export async function setSessionRendererMode(sessionId: string, mode: RendererMode): Promise<void> {
  resolved.set(sessionId, mode);
  try {
    await rpc.kv.set(rendererSessionKey(sessionId), mode);
  } catch {
    /* best-effort persistence */
  }
}

/** Test-only. */
export function __resetRendererFlagCache(): void {
  resolved.clear();
}
```

- [ ] **Step 3: Make `Terminal.tsx` the switch.** Rename the existing exported component body: `export function SessionTerminal(...)` → `function XtermTerminalHost(...)` (same file, body untouched). Add imports at the top:

```ts
import { useEffect, useRef, useState } from 'react';
import { DomTerminalView } from './DomTerminalView';
import { destroy as destroyXtermEntry } from '@/renderer/lib/terminal-cache';
import { destroyEngine } from '@/renderer/lib/engine-cache';
import { peekRendererMode, resolveRendererMode, type RendererMode } from '@/renderer/lib/renderer-flag';
```

(`destroy` is already exported by terminal-cache; alias it on import. Keep the existing imports — `getOrCreateTerminal` etc. stay for `XtermTerminalHost`.) Then add the new switch component:

```tsx
/**
 * P1b (spec 2026-06-12) — renderer switch. Resolves the pane's renderer mode
 * from KV (module-cached: remounts are synchronous), then mounts exactly one
 * host. THE single mutual-exclusion choke point: before/while a mode is
 * mounted, the OTHER renderer's cached instance for this session is
 * destroyed — a session must never have two live onData→pty.write pipes
 * (each would answer DA/DSR queries → doubled bytes to the PTY). Content
 * survives the switch via the main ring-buffer snapshot, which both caches
 * replay on their next cache-miss (spec §Renderer flag & fallback).
 */
export function SessionTerminal({ sessionId, className }: Props) {
  const [mode, setMode] = useState<RendererMode | null>(() => peekRendererMode(sessionId));

  useEffect(() => {
    let alive = true;
    void resolveRendererMode(sessionId).then((m) => {
      if (alive) setMode(m);
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (mode === 'dom') destroyXtermEntry(sessionId);
    else if (mode === 'xterm') destroyEngine(sessionId);
  }, [mode, sessionId]);

  if (mode === null) {
    // One async tick on the very first mount of a session (later mounts hit
    // the module cache). An empty shell avoids constructing the WRONG
    // renderer's cache entry and immediately destroying it.
    return <div className={className} style={{ width: '100%', height: '100%' }} />;
  }
  if (mode === 'dom') return <DomTerminalView sessionId={sessionId} className={className} />;
  return <XtermTerminalHost sessionId={sessionId} className={className} />;
}
```

(Note the one-effect-tick window where the chosen host's child effects run before the exclusion effect: harmless on first mount — the other cache is empty — and on a real renderer SWITCH the destroyed entry is recreated from snapshot anyway. Document with the comment above, do not add ordering machinery.)

- [ ] **Step 4: Update `Terminal.test.tsx`.** Read the existing file first. Required changes:
  - Mock `@/renderer/lib/renderer-flag` is NOT the approach — instead mock the `rpc` kv surface the suite already mocks (verify: if the suite's rpc mock lacks `kv.get`, add `kv: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) }`).
  - Import and call `__resetRendererFlagCache()` in `beforeEach`.
  - Existing assertions now need the async flag settle before the xterm host appears: wrap follow-on queries in `await waitFor(...)` or `await act(async () => {})` after `render`.
  - Add two new switch tests:

```tsx
it('mounts DomTerminalView when the session KV override is dom', async () => {
  kvGet.mockImplementation(async (key: string) =>
    key === 'panes.renderer.sess-dom' ? 'dom' : null,
  );
  const { findByTestId } = render(<SessionTerminal sessionId="sess-dom" />);
  expect(await findByTestId('dom-terminal-view')).toBeTruthy();
});

it('defaults to the xterm host when no flag is set', async () => {
  const { container, queryByTestId } = render(<SessionTerminal sessionId="sess-x" />);
  await waitFor(() => expect(queryByTestId('dom-terminal-view')).toBeNull());
  // the xterm host attached the cached terminal's DOM root
  await waitFor(() => expect(container.firstChild).toBeTruthy());
});
```

  Adapt the second test's final assertion to whatever the existing suite already asserts about the xterm mount (it has established patterns + cache mocks — follow them, don't invent a parallel style).

- [ ] **Step 5: Sibling sweep (MANDATORY — the mock-breakage class).** Run:
  - `grep -rn "SessionTerminal" src/renderer --include="*.tsx" --include="*.ts"` — for every test that renders `SessionTerminal` directly or transitively (CommandRoom.test.tsx, PaneShell.test.tsx), check whether its rpc mock covers `kv.get`; if a suite mocks `Terminal.tsx` wholesale it is unaffected.
  - `grep -rn "vi.mock.*terminal-cache" src` — any hand-written mock of terminal-cache must now also export `THEME` and still export `destroy` (it already did).
  - Then run the FULL suite: `npx vitest run` — fix all fallout before committing.

- [ ] **Step 6: Run full gate for the task** — `npx vitest run` green AND `npx tsc -b` clean.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(panes): renderer flag + Terminal.tsx renderer switch (P1b task 6)"`

---

### Task 7: Full gate

**Files:** none new.

- [ ] **Step 1:** `npx tsc -b` → zero errors.
- [ ] **Step 2:** `npx vitest run` → full suite green (expect ~3800+ tests).
- [ ] **Step 3:** `pnpm lint` → clean (the repo's own script — bare `npx eslint .` uses a laxer config and has missed CI failures before).
- [ ] **Step 4:** `npm run build` → renderer bundle builds. (No main-process changes in P1b — `electron:compile` not required, but run it anyway as a cheap cross-check: `npm run electron:compile`.)
- [ ] **Step 5:** If anything failed: fix, re-run the full gate, then `git add -A && git commit -m "fix(panes): P1b gate fallout"`. If everything passed with no changes, no commit needed.

---

## Self-review notes (spec ↔ plan)

- **G1 instant reflow:** FlowView CSS wrap + DomTerminalView's no-dragFit controller → Task 4/5. ✓
- **G2 native selection/copy/scroll:** FlowView `userSelect`, DomTerminalView mouseup copy parity → Task 4/5. ✓
- **G4 zero xterm regression:** xterm path changes = `export THEME` + extracted overlap helper (behavior-identical, its test suite must pass unmodified) + body rename. ✓
- **Flag & fallback (spec §):** Task 6; `agentBeta` + context menu = P1c by scope decision. ✓
- **Seeding/no content loss on switch:** engine-cache snapshot replay (Task 3) + switch comment (Task 6). ✓
- **Engine evolution (spec says "cache becomes headless"):** implemented as a SIBLING cache + mutual exclusion rather than an in-place rewrite of terminal-cache — same contract, zero risk to the shipped path; the merge into one cache is P3 (default flip) work.
- **G3 / conditional #160, GridView, mouse:** explicitly P1c/P2 — out.
- **Parity testing:** engine goldens (P1a + Task 1) + THEME-16 parity (Task 2) + FlowView text assertions against the real engine (Task 4).
