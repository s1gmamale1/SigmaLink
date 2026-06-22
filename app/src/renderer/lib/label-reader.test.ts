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
