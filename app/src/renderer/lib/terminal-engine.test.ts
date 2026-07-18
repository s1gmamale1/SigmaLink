// DOM terminal presenter P1a (spec 2026-06-12) — VT goldens for the headless
// engine. Runs against the REAL @xterm/headless parser in node (no DOM, no
// jsdom): these are integration-grade fixtures, not mocks — if xterm's
// parsing or our logical-line extraction drifts, this suite is the tripwire.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalEngine } from './terminal-engine';

function makeEngine(opts: { cols?: number; rows?: number } = {}) {
  const sent: string[] = [];
  const engine = new TerminalEngine({ writeToPty: (d) => sent.push(d) }, opts);
  return { engine, sent };
}

/** term.write is async (parser runs on a write queue) — flush helper. */
function flushWrite(engine: TerminalEngine, data: string): Promise<void> {
  return new Promise((resolve) => engine.term.write(data, () => resolve()));
}

let engines: TerminalEngine[] = [];
function track(e: TerminalEngine): TerminalEngine {
  engines.push(e);
  return e;
}

beforeEach(() => {
  engines = [];
});
afterEach(() => {
  for (const e of engines) e.dispose();
});

describe('TerminalEngine — buffer + logical lines', () => {
  it('plain writes land as logical lines', async () => {
    const { engine } = makeEngine({ cols: 40, rows: 10 });
    track(engine);
    await flushWrite(engine, 'hello\r\nworld\r\n');
    const lines = engine.logicalLines();
    expect(lines[0]!.text).toBe('hello');
    expect(lines[1]!.text).toBe('world');
  });

  it('a line wider than cols is ONE logical line (isWrapped joining)', async () => {
    const { engine } = makeEngine({ cols: 10, rows: 5 });
    track(engine);
    const long = 'abcdefghijklmnopqrstuvwxy'; // 25 chars at cols=10 → 3 buffer rows
    await flushWrite(engine, long);
    const lines = engine.logicalLines();
    expect(lines[0]!.text).toBe(long);
    expect(lines[0]!.startRow).toBe(0);
    // The next logical line (cursor row remainder) must not duplicate content.
    const joined = lines.map((l) => l.text).join('');
    expect(joined).toBe(long);
  });

  it('a window starting mid-wrap snaps back to the logical head', async () => {
    const { engine } = makeEngine({ cols: 10, rows: 5 });
    track(engine);
    await flushWrite(engine, 'abcdefghijklmnopqrstuvwxy');
    const fromMid = engine.logicalLines(1, 3); // row 1 is a wrapped continuation
    expect(fromMid[0]!.startRow).toBe(0);
    expect(fromMid[0]!.text).toBe('abcdefghijklmnopqrstuvwxy');
  });

  it('SGR styling does not corrupt extracted text', async () => {
    const { engine } = makeEngine({ cols: 40, rows: 5 });
    track(engine);
    await flushWrite(engine, '\x1b[1;31mred-bold\x1b[0m plain');
    expect(engine.logicalLines()[0]!.text).toBe('red-bold plain');
  });
});

describe('TerminalEngine — buffer type + modes', () => {
  it('tracks alt-screen enter/exit (1049)', async () => {
    const { engine } = makeEngine();
    track(engine);
    expect(engine.bufferType).toBe('normal');
    await flushWrite(engine, '\x1b[?1049h');
    expect(engine.bufferType).toBe('alternate');
    await flushWrite(engine, '\x1b[?1049l');
    expect(engine.bufferType).toBe('normal');
  });

  it('exposes DECCKM and bracketed-paste modes for the InputEncoder', async () => {
    const { engine } = makeEngine();
    track(engine);
    expect(engine.modes).toEqual({ applicationCursorKeys: false, bracketedPaste: false });
    await flushWrite(engine, '\x1b[?1h\x1b[?2004h');
    expect(engine.modes).toEqual({ applicationCursorKeys: true, bracketedPaste: true });
  });
});

describe('TerminalEngine — PTY-bound replies (SF-3 parity)', () => {
  it('answers a Primary DA query via the delegate', async () => {
    const { engine, sent } = makeEngine();
    track(engine);
    await flushWrite(engine, '\x1b[c'); // hosted app asks "who are you?"
    expect(sent.length).toBeGreaterThan(0);
    // DA1 response shape: ESC [ ? <params> c — asserted via string ops
    // (a regex literal with \x1b trips eslint no-control-regex).
    const joined = sent.join('');
    expect(joined.startsWith('\x1b[?')).toBe(true);
    expect(joined.endsWith('c')).toBe(true);
  });
});

describe('TerminalEngine — resize + change notification', () => {
  it('resize updates cols/rows and reflows', async () => {
    const { engine } = makeEngine({ cols: 10, rows: 5 });
    track(engine);
    await flushWrite(engine, 'abcdefghijklmnop');
    engine.resize(40, 5);
    expect(engine.term.cols).toBe(40);
    expect(engine.logicalLines()[0]!.text).toBe('abcdefghijklmnop');
  });

  it('coalesces a burst of writes into one change callback', async () => {
    vi.useFakeTimers();
    try {
      const { engine } = makeEngine();
      track(engine);
      const cb = vi.fn();
      engine.onBufferChanged(cb);
      engine.write('a');
      engine.write('b');
      engine.write('c');
      await vi.runAllTimersAsync(); // write-queue + the setTimeout(0) notify
      expect(cb).toHaveBeenCalled();
      expect(cb.mock.calls.length).toBeLessThanOrEqual(2); // coalesced, not 3
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribe stops notifications; dispose goes inert', async () => {
    const { engine } = makeEngine();
    track(engine);
    const cb = vi.fn();
    const off = engine.onBufferChanged(cb);
    off();
    await flushWrite(engine, 'x');
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
    engine.dispose();
    expect(() => engine.write('y')).not.toThrow();
    expect(() => engine.resize(80, 24)).not.toThrow();
  });

  it('a THROWING subscriber does not starve the ones registered after it', async () => {
    // The engine-cache attaches the label reader FIRST (at create time), so it
    // sits ahead of every presenter bump in the Set. If it ever throws mid-
    // notify, an unguarded loop would abort before FlowView/DomTerminalView
    // re-render — the pane freezes on whatever half-painted frame it had.
    const { engine } = makeEngine();
    track(engine);
    const boom = vi.fn(() => {
      throw new Error('label reader blew up');
    });
    const presenter = vi.fn();
    engine.onBufferChanged(boom);
    engine.onBufferChanged(presenter);

    await flushWrite(engine, 'hello');
    await new Promise((r) => setTimeout(r, 10));

    expect(boom).toHaveBeenCalled();
    expect(presenter).toHaveBeenCalled();
  });

  it('keeps notifying on LATER writes after a subscriber throws', async () => {
    const { engine } = makeEngine();
    track(engine);
    engine.onBufferChanged(() => {
      throw new Error('persistently broken subscriber');
    });
    const presenter = vi.fn();
    engine.onBufferChanged(presenter);

    await flushWrite(engine, 'first');
    await new Promise((r) => setTimeout(r, 10));
    const afterFirst = presenter.mock.calls.length;

    await flushWrite(engine, 'second');
    await new Promise((r) => setTimeout(r, 10));

    expect(afterFirst).toBeGreaterThan(0);
    expect(presenter.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

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

describe('TerminalEngine — mouse tracking exposure (wheel reporting)', () => {
  it('reports the mode+sgr when the app enables vt200 tracking with SGR encoding', async () => {
    const { engine } = makeEngine();
    track(engine);
    expect(engine.mouseTracking).toEqual({ mode: 'none', sgr: false });
    await flushWrite(engine, '\x1b[?1000h\x1b[?1006h'); // claude-fullscreen style
    expect(engine.mouseTracking).toEqual({ mode: 'vt200', sgr: true });
  });

  it('DECRST 1006 drops the sgr flag; x10 tracking reports mode x10', async () => {
    const { engine } = makeEngine();
    track(engine);
    await flushWrite(engine, '\x1b[?1000h\x1b[?1006h\x1b[?1006l');
    expect(engine.mouseTracking).toEqual({ mode: 'vt200', sgr: false });
    await flushWrite(engine, '\x1b[?1000l\x1b[?9h'); // x10: button-press only, no wheel
    expect(engine.mouseTracking.mode).toBe('x10');
  });
});

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
