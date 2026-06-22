# Pane Auto-Labeling TUI Read-Path Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a pane's header pill show what Claude is working on by reading the `SIGMA::LABEL` sentinel from the *parsed* terminal buffer (where cursor-paint is already resolved) instead of from the raw interactive-TUI PTY byte stream (which the shipped anchored byte-regex can never match).

**Architecture:** A pure extractor (`pane-label-scan.ts`) finds the freshest sentinel in a list of rendered logical lines. A reader (`label-reader.ts`, replacing the broken `label-watcher.ts`) reads recent rows from the live `TerminalEngine` (DOM mode, default) or cached xterm `Terminal` (xterm mode) on each buffer change and feeds the existing `pane-labels` store. The engine/xterm caches attach/detach the reader at create/destroy (they already enforce engine↔xterm mutual exclusion). The store + `PaneHeader` display chain are unchanged — they were always correct, just never fed. A visible rename affordance is added to the header pill.

**Tech Stack:** TypeScript, React 19 (`useSyncExternalStore` — already wired), Vitest (node env for the engine regression via real `@xterm/headless`; jsdom for `.tsx`), `@xterm/headless` `TerminalEngine`, `@xterm/xterm` `onWriteParsed`.

## Global Constraints

- **Worktree:** all work happens in `/Users/aisigma/projects/sl-pane-label/app` (branch `feat/pane-auto-label-tui-fix`, off `origin/main`). `node_modules` is already symlinked to the main checkout. Do NOT work in `/Users/aisigma/projects/SigmaLink/app`.
- **Gate (local):** `npx tsc -b` + `npx vitest run <files>` + `npm run lint`. Build (`npm run build`) at the final gate only. **Never** run `npx playwright`/`electron:dev`/e2e locally — defer to CI.
- **TS dialect:** `erasableSyntaxOnly` — no `constructor(private x)` param properties, no enums/namespaces (declare field + assign). (No new classes here, but follow if refactoring.)
- **Renderer tests:** `.tsx`/jsdom tests need a `// @vitest-environment jsdom` docblock + `vi.hoisted()` mocks + explicit `afterEach(cleanup)`. The `.ts` engine test runs in the default node env (no docblock) — mirror `terminal-engine.test.ts`.
- **Commit trailer:** end every commit message body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. No push/PR without explicit authorization.
- **Sentinel verb is `SIGMA::LABEL`** (verbatim). The injected `--append-system-prompt` already ships on `origin/main` — do NOT touch `src/shared/providers.ts` or `launcher.ts`.

---

## Task 1: `pane-label-scan.ts` — pure `extractLabel`

**Files:**
- Create: `src/renderer/lib/pane-label-scan.ts`
- Test: `src/renderer/lib/pane-label-scan.test.ts`

**Interfaces:**
- Produces: `export function extractLabel(lines: string[]): string | null`

- [ ] **Step 1: Write the failing test**

`src/renderer/lib/pane-label-scan.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { extractLabel } from './pane-label-scan';

describe('extractLabel', () => {
  it('matches a plain sentinel line', () => {
    expect(extractLabel(['SIGMA::LABEL Async token refresh refactor'])).toBe(
      'Async token refresh refactor',
    );
  });
  it('matches with a leading bullet + indent (TUI render)', () => {
    expect(extractLabel(['  ⏺ SIGMA::LABEL Reviewing auth'])).toBe('Reviewing auth');
  });
  it('collapses cursor-gap multiple spaces', () => {
    expect(extractLabel(['SIGMA::LABEL   say   hello'])).toBe('say hello');
  });
  it('returns the LAST match (freshest task)', () => {
    expect(
      extractLabel(['SIGMA::LABEL First task', 'noise', 'SIGMA::LABEL Second task']),
    ).toBe('Second task');
  });
  it('does NOT match a mid-prose mention', () => {
    expect(extractLabel(['the agent prints a SIGMA::LABEL foo line here'])).toBeNull();
  });
  it('returns null when no line qualifies', () => {
    expect(extractLabel(['just terminal output', ''])).toBeNull();
  });
  it('ignores an empty payload', () => {
    expect(extractLabel(['SIGMA::LABEL    '])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/lib/pane-label-scan.test.ts`
Expected: FAIL — `Cannot find module './pane-label-scan'`.

- [ ] **Step 3: Implement `pane-label-scan.ts`**

```ts
// Pure extractor for the pane auto-label. Given RENDERED logical lines (from a
// parsed terminal buffer, where cursor-paint has been resolved to real text),
// return the freshest SIGMA::LABEL value. The sentinel must sit at the
// EFFECTIVE line start — after only an optional bullet/indent that the TUI
// paints — so a mid-prose mention does not false-match. Internal whitespace is
// collapsed (the TUI spaces words via cursor-column jumps). Returns null when
// no line qualifies.

// Leading decoration the TUI may paint before the sentinel: whitespace, a
// quote/box-draw glyph, or a bullet. `│`=U+2502, `⏺`=U+23FA, `•`=U+2022.
const SENTINEL = /^[\s>│⏺•*\-]*SIGMA::LABEL\s+(.+?)\s*$/;

export function extractLabel(lines: string[]): string | null {
  let found: string | null = null;
  for (const line of lines) {
    const m = SENTINEL.exec(line);
    if (!m) continue;
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (text !== '') found = text; // last qualifying line wins
  }
  return found;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/lib/pane-label-scan.test.ts`
Expected: PASS (7 cases).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/pane-label-scan.ts src/renderer/lib/pane-label-scan.test.ts
git commit -m "feat(command-room): pure SIGMA::LABEL extractor over rendered lines

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `terminal-engine.ts` `bufferLength` getter + `label-reader.ts`

**Files:**
- Modify: `src/renderer/lib/terminal-engine.ts` (add a one-line getter near `get cursor`, ~line 240)
- Create: `src/renderer/lib/label-reader.ts`
- Test: `src/renderer/lib/label-reader.test.ts`

**Interfaces:**
- Consumes: `extractLabel(lines: string[]): string | null` (Task 1); `setAgentLabel(sessionId, raw)` + `getAgentLabel(sessionId)` + `__resetAgentLabels()` (existing `pane-labels.ts`); `TerminalEngine.logicalLines(startRow?, endRow?): { startRow: number; text: string }[]` and `TerminalEngine.onBufferChanged(cb): () => void` (existing).
- Produces:
  - `export function readEngineLabel(engine: Pick<TerminalEngine, 'logicalLines' | 'bufferLength'>): string | null`
  - `export function readXtermLabel(term: XtermLike): string | null`
  - `export function attachEngineLabelReader(sessionId: string, engine: TerminalEngine): void`
  - `export function attachXtermLabelReader(sessionId: string, term: XtermLike): void`
  - `export function detachLabelReader(sessionId: string): void`
  - `export function __resetLabelReaders(): void`
  - `export interface XtermLike { … }`
  - `TerminalEngine.bufferLength: number` (getter)

- [ ] **Step 1: Add the `bufferLength` getter to `terminal-engine.ts`**

Find `get cursor(): { row: number; col: number } {` (~line 240) and insert directly above it:
```ts
  /** Rows currently in the active buffer (screen + scrollback). Lets a consumer
   *  bound a recent-rows scan without materializing the whole buffer. */
  get bufferLength(): number {
    return this.term.buffer.active.length;
  }

```

- [ ] **Step 2: Write the failing test**

`src/renderer/lib/label-reader.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalEngine } from './terminal-engine';
import {
  readEngineLabel,
  readXtermLabel,
  attachEngineLabelReader,
  attachXtermLabelReader,
  detachLabelReader,
  __resetLabelReaders,
  type XtermLike,
} from './label-reader';
import { getAgentLabel, __resetAgentLabels } from './pane-labels';

const engines: TerminalEngine[] = [];
function makeEngine(): TerminalEngine {
  const e = new TerminalEngine({ writeToPty: () => {} }, { cols: 80, rows: 24 });
  engines.push(e);
  return e;
}
function flush(e: TerminalEngine, data: string): Promise<void> {
  return new Promise((r) => e.term.write(data, () => r()));
}

/** Minimal fake xterm whose buffer rows can be mutated between fires. */
function fakeXterm(rows: string[]): XtermLike & { fire(): void; rows: string[] } {
  let cb: () => void = () => {};
  return {
    rows,
    onWriteParsed(fn) {
      cb = fn;
      return { dispose() { cb = () => {}; } };
    },
    fire() { cb(); },
    buffer: {
      active: {
        get length() { return rows.length; },
        getLine(i: number) {
          const t = rows[i];
          return t === undefined
            ? undefined
            : { translateToString: () => t, isWrapped: false };
        },
      },
    },
  };
}

afterEach(() => {
  for (const e of engines) e.dispose();
  engines.length = 0;
  __resetLabelReaders();
  __resetAgentLabels();
});

describe('readEngineLabel — real @xterm/headless (regression for the TUI cursor-paint bug)', () => {
  it('extracts a label painted via cursor-column jumps (exact production form)', async () => {
    const e = makeEngine();
    // Captured live from interactive Claude Code: words placed via \x1b[<n>G
    // absolute-column jumps (NOT spaces), preceded by cursor moves. The OLD
    // byte-regex /^SIGMA::LABEL/ on raw bytes could never match this.
    await flush(e, '\x1b[2C\x1b[9ASIGMA::LABEL\x1b[16Gsay\x1b[20Ghello\r\n');
    expect(readEngineLabel(e)).toBe('say hello');
  });
  it('returns the freshest label after a re-emit', async () => {
    const e = makeEngine();
    await flush(e, 'SIGMA::LABEL First task\r\n');
    await flush(e, 'lots of output\r\n');
    await flush(e, 'SIGMA::LABEL Second task\r\n');
    expect(readEngineLabel(e)).toBe('Second task');
  });
  it('returns null when no sentinel was painted', async () => {
    const e = makeEngine();
    await flush(e, 'just normal output\r\n');
    expect(readEngineLabel(e)).toBeNull();
  });
});

describe('attachEngineLabelReader', () => {
  it('feeds the store on buffer change; detach stops further updates', () => {
    let cb = () => {};
    const fake = {
      bufferLength: 1,
      logicalLines: () => [{ startRow: 0, text: 'SIGMA::LABEL Engine task' }],
      onBufferChanged: (fn: () => void) => {
        cb = fn;
        return () => { cb = () => {}; };
      },
    } as unknown as TerminalEngine;
    attachEngineLabelReader('e1', fake);
    cb();
    expect(getAgentLabel('e1')).toBe('Engine task');
    detachLabelReader('e1');
    cb(); // detached → no-op
    expect(getAgentLabel('e1')).toBe('Engine task');
  });
  it('is idempotent (one subscription per session)', () => {
    let subs = 0;
    const fake = {
      bufferLength: 0,
      logicalLines: () => [],
      onBufferChanged: () => { subs++; return () => {}; },
    } as unknown as TerminalEngine;
    attachEngineLabelReader('e2', fake);
    attachEngineLabelReader('e2', fake);
    expect(subs).toBe(1);
  });
});

describe('readXtermLabel / attachXtermLabelReader (fallback xterm mode)', () => {
  it('reads the label from the xterm buffer', () => {
    const term = fakeXterm(['boot', '⏺ SIGMA::LABEL Reviewing PR', 'more']);
    expect(readXtermLabel(term)).toBe('Reviewing PR');
  });
  it('attach feeds the store on write; detach stops it', () => {
    const term = fakeXterm(['SIGMA::LABEL Task A']);
    attachXtermLabelReader('x1', term);
    term.fire();
    expect(getAgentLabel('x1')).toBe('Task A');
    detachLabelReader('x1');
    term.rows[0] = 'SIGMA::LABEL Task B';
    term.fire();
    expect(getAgentLabel('x1')).toBe('Task A'); // unchanged after detach
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/renderer/lib/label-reader.test.ts`
Expected: FAIL — `Cannot find module './label-reader'`.

- [ ] **Step 4: Implement `label-reader.ts`**

```ts
// Per-pane SIGMA::LABEL reader — replaces the byte-regex label-watcher.ts.
//
// Interactive Claude Code is a TUI that PAINTS via cursor-control escapes, so
// the sentinel never appears as a clean newline-delimited line in the raw PTY
// byte stream (what the old watcher tried). Captured live, "SIGMA::LABEL say
// hello" arrives as `\x1b[2C\x1b[9ASIGMA::LABEL\x1b[16Gsay\x1b[20Ghello` — words
// placed by absolute-column jumps, preceded by cursor moves. So we read the
// label from the PARSED buffer instead: the per-pane TerminalEngine (DOM mode,
// default) or the cached xterm Terminal (xterm mode), where @xterm has already
// resolved cursor-jumps into real, correctly-spaced text.
//
// Lifecycle: attached by engine-cache / terminal-cache at create time (which
// enforce engine↔xterm mutual exclusion, so the two paths never run together
// for one session) and detached at destroy. Feeds the existing pane-labels
// store (sanitize + last-good + no-notify-on-unchanged live there).

import { setAgentLabel } from '@/renderer/lib/pane-labels';
import { extractLabel } from '@/renderer/lib/pane-label-scan';
import type { TerminalEngine } from '@/renderer/lib/terminal-engine';

// Recent buffer rows to scan on each change — covers the visible screen plus a
// little history so a just-painted label is in range, without re-scanning an
// 8000-row scrollback on every coalesced repaint.
const SCAN_ROWS = 160;

/** The minimal @xterm/xterm surface the reader needs (the real Terminal
 *  satisfies it; tests pass a lightweight fake). */
export interface XtermLike {
  onWriteParsed(cb: () => void): { dispose(): void };
  buffer: {
    active: {
      length: number;
      getLine(
        i: number,
      ): { translateToString(trim?: boolean): string; isWrapped: boolean } | undefined;
    };
  };
}

/** Read the current label from a parsed engine buffer (recent rows only). */
export function readEngineLabel(
  engine: Pick<TerminalEngine, 'logicalLines' | 'bufferLength'>,
): string | null {
  const len = engine.bufferLength;
  const lines = engine.logicalLines(Math.max(0, len - SCAN_ROWS), len).map((l) => l.text);
  return extractLabel(lines);
}

/** Read the current label from a parsed xterm buffer (recent rows, wrap-joined). */
export function readXtermLabel(term: XtermLike): string | null {
  const buf = term.buffer.active;
  const end = buf.length;
  const lines: string[] = [];
  let i = Math.max(0, end - SCAN_ROWS);
  // Snap to a wrap head so the window never starts mid-logical-line.
  while (i > 0 && buf.getLine(i)?.isWrapped) i--;
  while (i < end) {
    const head = buf.getLine(i);
    if (!head) { i++; continue; }
    let text = head.translateToString(true);
    let next = i + 1;
    while (next < end && buf.getLine(next)?.isWrapped) {
      text += buf.getLine(next)!.translateToString(true);
      next++;
    }
    lines.push(text);
    i = next;
  }
  return extractLabel(lines);
}

const detachers = new Map<string, () => void>();

/** Attach a label reader to a DOM-mode engine (idempotent per session). */
export function attachEngineLabelReader(sessionId: string, engine: TerminalEngine): void {
  if (detachers.has(sessionId)) return;
  const off = engine.onBufferChanged(() => {
    const label = readEngineLabel(engine);
    if (label) setAgentLabel(sessionId, label);
  });
  detachers.set(sessionId, off);
}

/** Attach a label reader to an xterm-mode Terminal (idempotent per session). */
export function attachXtermLabelReader(sessionId: string, term: XtermLike): void {
  if (detachers.has(sessionId)) return;
  const sub = term.onWriteParsed(() => {
    const label = readXtermLabel(term);
    if (label) setAgentLabel(sessionId, label);
  });
  detachers.set(sessionId, () => sub.dispose());
}

/** Detach a session's reader. Idempotent; safe if never attached. */
export function detachLabelReader(sessionId: string): void {
  const off = detachers.get(sessionId);
  if (!off) return;
  try {
    off();
  } catch {
    /* raced teardown — ignore */
  }
  detachers.delete(sessionId);
}

/** Test-only: detach every reader. */
export function __resetLabelReaders(): void {
  for (const id of Array.from(detachers.keys())) detachLabelReader(id);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/renderer/lib/label-reader.test.ts`
Expected: PASS (all cases — the cursor-paint regression is the key one).

- [ ] **Step 6: Type-check + commit**

Run: `npx tsc -b`
Expected: no errors.
```bash
git add src/renderer/lib/terminal-engine.ts src/renderer/lib/label-reader.ts src/renderer/lib/label-reader.test.ts
git commit -m "feat(command-room): read SIGMA::LABEL from the parsed terminal buffer

Engine + xterm readers over recent rendered rows; replaces the byte-regex
watcher that could never match the interactive TUI cursor-paint stream.
Regression test feeds the real captured bytes through @xterm/headless.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire the reader into the engine + xterm caches

**Files:**
- Modify: `src/renderer/lib/engine-cache.ts` (`getOrCreateEngine` ~line 97, `destroyEngine` ~line 131)
- Modify: `src/renderer/lib/terminal-cache.ts` (`getOrCreateTerminal` ~line 340–520, `destroy` ~line 562)
- Test: `src/renderer/lib/engine-cache.test.ts` (extend)

**Interfaces:**
- Consumes: `attachEngineLabelReader`, `attachXtermLabelReader`, `detachLabelReader` (Task 2).

- [ ] **Step 1: Write the failing test (engine-cache)**

Add to the TOP of `src/renderer/lib/engine-cache.test.ts`, alongside the existing `vi.mock` calls (before the `import { … } from './engine-cache'` line):
```ts
const labelReaderMock = vi.hoisted(() => ({
  attachEngineLabelReader: vi.fn(),
  detachLabelReader: vi.fn(),
}));
vi.mock('@/renderer/lib/label-reader', () => labelReaderMock);
```
Add this `describe` block at the end of the file:
```ts
describe('engine-cache label-reader wiring', () => {
  it('attaches a label reader on create and detaches on destroy', async () => {
    labelReaderMock.attachEngineLabelReader.mockClear();
    labelReaderMock.detachLabelReader.mockClear();
    const entry = getOrCreateEngine('lbl-1');
    expect(labelReaderMock.attachEngineLabelReader).toHaveBeenCalledWith('lbl-1', entry.engine);
    destroyEngine('lbl-1');
    expect(labelReaderMock.detachLabelReader).toHaveBeenCalledWith('lbl-1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/lib/engine-cache.test.ts -t "label-reader wiring"`
Expected: FAIL — `attachEngineLabelReader` not called.

- [ ] **Step 3: Implement engine-cache wiring**

In `src/renderer/lib/engine-cache.ts`, add the import after line 17 (`import { computeSnapshotOverlap } …`):
```ts
import { attachEngineLabelReader, detachLabelReader } from './label-reader';
```
In `getOrCreateEngine`, immediately after `cache.set(sessionId, entry);` (line 97):
```ts
  // Auto-label — read SIGMA::LABEL from this engine's parsed buffer.
  attachEngineLabelReader(sessionId, engine);
```
In `destroyEngine`, immediately after `cache.delete(sessionId);` (line 131):
```ts
  detachLabelReader(sessionId);
```

- [ ] **Step 4: Implement terminal-cache wiring (xterm mode)**

In `src/renderer/lib/terminal-cache.ts`, add to the existing `@xterm/xterm`-adjacent imports (near the top, beside the other `@/renderer/lib` imports):
```ts
import { attachXtermLabelReader, detachLabelReader } from './label-reader';
```
In `getOrCreateTerminal`, right after `const onDataDispose = term.onData(…)` is created (~line 381, before the `return` of the entry — any point after `term` exists and before `return entry`):
```ts
  // Auto-label — read SIGMA::LABEL from this terminal's parsed buffer.
  attachXtermLabelReader(sessionId, term);
```
In `destroy`, immediately after `cache.delete(sessionId);` (line 565):
```ts
  detachLabelReader(sessionId);
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/renderer/lib/engine-cache.test.ts && npx tsc -b`
Expected: PASS; no type errors. (`terminal-cache.test.ts` constructs real/mock XTerm; if its XTerm mock lacks `onWriteParsed`, add `onWriteParsed: () => ({ dispose() {} })` to that mock — see Task 3 Step 6.)

- [ ] **Step 6: Keep terminal-cache.test green**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
If it fails because the test's XTerm test double has no `onWriteParsed`, add the method to that double (search the file for the `Terminal`/`XTerm` mock factory) returning a disposable:
```ts
      onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
```
Re-run until green. (If the suite uses the real `@xterm/xterm`, no change is needed — `onWriteParsed` exists.)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/lib/engine-cache.ts src/renderer/lib/engine-cache.test.ts src/renderer/lib/terminal-cache.ts src/renderer/lib/terminal-cache.test.ts
git commit -m "feat(command-room): attach the SIGMA::LABEL reader from the engine + xterm caches

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Remove the dead byte-regex watcher + repoint its consumers

**Files:**
- Delete: `src/renderer/lib/label-watcher.ts`, `src/renderer/lib/label-watcher.test.ts`
- Modify: `src/renderer/features/command-room/PaneShell.tsx` (remove import line 55 + effect lines 130–134)
- Modify: `src/renderer/features/command-room/CommandRoom.test.tsx` (mock line 45)
- Modify: `src/renderer/app/state-hooks/use-terminal-cache-gc.ts` (import line 22 + call line 53)
- Modify: `src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts` (mock lines 35–37, assertions 174–175)

**Interfaces:**
- Consumes: `detachLabelReader` (Task 2). Removes `ensureLabelWatcher`/`disposeLabelWatcher`.

- [ ] **Step 1: Delete the dead module + its test**

```bash
git rm src/renderer/lib/label-watcher.ts src/renderer/lib/label-watcher.test.ts
```

- [ ] **Step 2: Remove the PaneShell mount wiring**

In `src/renderer/features/command-room/PaneShell.tsx`, delete the import (line 55):
```ts
import { ensureLabelWatcher } from '@/renderer/lib/label-watcher';
```
and delete the effect (lines 130–134):
```ts
  // Auto-label — install the SIGMA::LABEL watcher for this pane. Idempotent +
  // persists across remounts (module-scope); the cache GC disposes it on close.
  useEffect(() => {
    ensureLabelWatcher(session.id);
  }, [session.id]);
```
(The label reader is now attached by the engine/xterm caches, not PaneShell. Leave the `useUncommittedCount` line and the FEAT-4 prompt-card block intact.)

- [ ] **Step 3: Fix the CommandRoom test mock**

In `src/renderer/features/command-room/CommandRoom.test.tsx`, replace the comment + mock (lines 43–45):
```ts
// PaneShell calls ensureLabelWatcher on mount → subscribePtyData → window.sigma.eventOn.

vi.mock('@/renderer/lib/label-watcher', () => ({ ensureLabelWatcher: vi.fn() }));
```
with:
```ts
// The engine/xterm caches attach the label reader; mock it out for the room render.
vi.mock('@/renderer/lib/label-reader', () => ({
  attachEngineLabelReader: vi.fn(),
  attachXtermLabelReader: vi.fn(),
  detachLabelReader: vi.fn(),
}));
```

- [ ] **Step 4: Repoint the GC hook**

In `src/renderer/app/state-hooks/use-terminal-cache-gc.ts`, replace the import (line 22):
```ts
import { disposeLabelWatcher } from '@/renderer/lib/label-watcher';
```
with:
```ts
import { detachLabelReader } from '@/renderer/lib/label-reader';
```
and replace the call (line 53):
```ts
      disposeLabelWatcher(id);
```
with:
```ts
      detachLabelReader(id);
```
(Keep `clearAgentLabel(id)` and `disposePromptWatcher(id)` unchanged.)

- [ ] **Step 5: Update the GC test mock + assertions**

In `src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`, replace the mock (lines 35–37):
```ts
const disposeLabelWatcherMock = vi.fn();
vi.mock('@/renderer/lib/label-watcher', () => ({
  disposeLabelWatcher: (...args: unknown[]) => disposeLabelWatcherMock(...args),
}));
```
with:
```ts
const detachLabelReaderMock = vi.fn();
vi.mock('@/renderer/lib/label-reader', () => ({
  detachLabelReader: (...args: unknown[]) => detachLabelReaderMock(...args),
}));
```
Replace the reset (line 75) `disposeLabelWatcherMock.mockReset();` with `detachLabelReaderMock.mockReset();`.
Replace the assertions (lines 174–175):
```ts
    expect(disposeLabelWatcherMock).toHaveBeenCalledWith('s2');
    expect(disposeLabelWatcherMock).not.toHaveBeenCalledWith('s1');
```
with:
```ts
    expect(detachLabelReaderMock).toHaveBeenCalledWith('s2');
    expect(detachLabelReaderMock).not.toHaveBeenCalledWith('s1');
```

- [ ] **Step 6: Run the affected suites + type-check**

Run:
```bash
npx vitest run src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts src/renderer/features/command-room/CommandRoom.test.tsx && npx tsc -b
```
Expected: PASS; no type errors; no remaining references to `label-watcher` (`git grep label-watcher src/` returns nothing).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(command-room): drop the dead byte-regex label-watcher

Reader is now attached by the engine/xterm caches; repoint the GC hook,
PaneShell, and tests to label-reader.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: PaneHeader — visible rename affordance

**Files:**
- Modify: `src/renderer/features/command-room/PaneHeader.tsx` (lucide import; the title pill `<span … data-testid="pane-title-pill">` ~line 244; after the display-name span ~line 287)
- Test: `src/renderer/features/command-room/PaneHeader.test.tsx`

**Interfaces:**
- Consumes: existing `startEditing()` (a `useCallback` in PaneHeader, ~line 159). Independent of Tasks 1–4.

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/features/command-room/PaneHeader.test.tsx` (reuse the file's existing `renderHeader`/`makeSession` helpers + RTL `screen`/`fireEvent`):
```ts
describe('PaneHeader rename affordance', () => {
  it('shows a rename button that opens inline edit', () => {
    renderHeader({ session: makeSession({ id: 'aff1', name: null }) });
    const btn = screen.getByTestId('pane-rename-affordance');
    fireEvent.click(btn);
    expect(screen.getByTestId('pane-rename-input')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/PaneHeader.test.tsx -t "rename affordance"`
Expected: FAIL — `Unable to find … pane-rename-affordance`.

- [ ] **Step 3: Implement**

Add `Pencil` to the existing `lucide-react` import in PaneHeader.tsx (find the line importing from `'lucide-react'` and append `, Pencil`).

Add `group` to the title-pill `className` so the affordance can reveal on hover. The pill span is `data-testid="pane-title-pill"` (~line 244); its className begins `"flex h-5 shrink-0 cursor-grab items-center gap-1 …"` — change the leading `"flex ` to `"group flex `.

Then, directly after the display-name `</span>` (the block ending at line 287, inside the pill, before its closing `</span>` at line 288), and only when not editing, insert:
```tsx
                {!editing && (
                  <button
                    type="button"
                    data-testid="pane-rename-affordance"
                    aria-label="Rename pane"
                    title="Rename pane"
                    onClick={(e) => { e.stopPropagation(); startEditing(); }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="ml-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
```
(`onMouseDown` stopPropagation prevents the pill drag from swallowing the click.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/features/command-room/PaneHeader.test.tsx`
Expected: PASS (new case + the existing precedence/tooltip cases).

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc -b`
Expected: no errors.
```bash
git add src/renderer/features/command-room/PaneHeader.tsx src/renderer/features/command-room/PaneHeader.test.tsx
git commit -m "feat(command-room): visible rename affordance on the pane header pill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full gate

- [ ] **Step 1: Type-check whole project** — `npx tsc -b` → no errors.
- [ ] **Step 2: Full renderer suite** — `npx vitest run` → all green. A broken sibling *mock* (e.g. a suite that instantiates the engine/xterm cache and now hits the new attach call) is the likely failure; fix the mock per the repo pattern. Re-run until green.
- [ ] **Step 3: Lint** — `npm run lint` → clean. (The `no-control-regex` style used in `pane-labels.ts` is not needed here — `pane-label-scan.ts` has no `\x00`-range literals. If the SENTINEL char class trips a rule, fix inline.)
- [ ] **Step 4: Build** — `npm run build` → success.
- [ ] **Step 5: Confirm no dangling references** — `git grep -n "label-watcher\|ensureLabelWatcher\|disposeLabelWatcher" src/` → no results.
- [ ] **Step 6: Commit any gate fixups**

```bash
git add -A
git commit -m "chore(command-room): gate fixups for pane auto-label TUI read-path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Root cause = raw-byte cursor-paint parse → read from parsed buffer: Task 2 (`readEngineLabel`/`readXtermLabel`) + the regression test feeding the real captured bytes. ✓
- `pane-labels.ts` unchanged: not touched in any task. ✓
- `pane-label-scan.ts` pure extractor (last-match, bullet/indent, mid-prose reject): Task 1. ✓
- `label-reader.ts` engine + xterm + detach + reset: Task 2. ✓
- Wiring at engine-cache + terminal-cache create/destroy (respects mutual exclusion): Task 3. ✓
- Remove `label-watcher.ts`, PaneShell wiring, CommandRoom mock, GC swap: Task 4. ✓
- `PaneHeader` visible rename affordance, keep double-click + context menu: Task 5 (existing entry points untouched). ✓
- Leave the sentinel visible (operator decision): no presenter change anywhere. ✓
- Renderer-only; no `providers.ts`/`launcher.ts`/`protocol.ts`/DB change: confirmed across tasks. ✓

**Placeholder scan:** none — every code/test step has literal content; all file paths exact.

**Type consistency:** `extractLabel(string[]) → string|null` (T1) consumed by `readEngineLabel`/`readXtermLabel` (T2). `attachEngineLabelReader`/`attachXtermLabelReader`/`detachLabelReader` (T2) consumed by wiring (T3) + GC (T4). `bufferLength` getter (T2 Step 1) consumed by `readEngineLabel` (T2 Step 4). `XtermLike` defined T2, used T2 tests; the real `XTerm` satisfies it structurally (`onWriteParsed` + `buffer.active.getLine`). `startEditing` (existing) consumed by T5. ✓

**Parallelizable lanes (for execution):** Task 1 and Task 5 are independent (disjoint files) and may run concurrently; Tasks 3 and 4 are independent of each other once Task 2 lands. Task 2 depends on Task 1; Task 6 depends on all. Sequential execution is also correct.
