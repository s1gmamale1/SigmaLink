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
