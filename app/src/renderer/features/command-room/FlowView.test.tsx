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
  // term.write is async (parser write-queue); the engine's onBufferChanged
  // notify is rAF-scheduled (jsdom provides rAF ≈ 16ms), so wait long enough
  // for the notify + React's bump re-render to flush, not just the parser.
  return act(() => new Promise<void>((r) => engine.term.write(data, () => setTimeout(r, 40))));
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

  it('cursor tracks trailing spaces (pads past the trimmed text)', async () => {
    const engine = makeEngine();
    const { getByTestId } = render(<FlowView engine={engine} />);
    await write(engine, 'Also '); // trailing space: buffer cursor col 5, trimmed text len 4
    const cursor = getByTestId('flow-view').querySelector('[data-cursor]')!;
    expect(cursor).toBeTruthy();
    const row = cursor.closest('[data-row]')!;
    let before = '';
    for (const node of Array.from(row.childNodes)) {
      if (node === cursor || (node instanceof Element && node.contains(cursor))) break;
      before += node.textContent ?? '';
    }
    // everything rendered before the cursor block spans the typed prefix
    // INCLUDING the trailing space the trimmed runs dropped.
    expect(before).toBe('Also ');
  });

  it('renders a cursor marker on the cursor line', async () => {
    const engine = makeEngine();
    const { getByTestId } = render(<FlowView engine={engine} />);
    await write(engine, 'prompt> ');
    expect(getByTestId('flow-view').querySelector('[data-cursor]')).toBeTruthy();
  });

  it('alt-screen: rows never CSS-wrap and run backgrounds fill the row (TUI fidelity)', async () => {
    const engine = makeEngine(20, 5);
    const { getByTestId } = render(<FlowView engine={engine} />);
    // enter alt screen, paint a full-width bg row (opencode-style theme fill)
    await write(engine, '\x1b[?1049h\x1b[48;5;236m' + 'X'.repeat(20) + '\x1b[0m');
    const view = getByTestId('flow-view');
    // no wrapping in alt mode — a cols-wide row must stay ONE visual line
    expect(view.style.whiteSpace).toBe('pre');
    const painted = Array.from(view.querySelectorAll('span')).find(
      (sp) => sp.textContent === 'X'.repeat(20),
    )!;
    expect(painted).toBeTruthy();
    // inline-block lets the background cover the full line box — the inline
    // glyph-box background left dark stripes between rows (operator report)
    expect(painted.style.display).toBe('inline-block');
  });

  it('normal buffer keeps flowing: pre-wrap container, plain inline spans', async () => {
    const engine = makeEngine(20, 5);
    const { getByTestId } = render(<FlowView engine={engine} />);
    await write(engine, '\x1b[31mred\x1b[0m');
    const view = getByTestId('flow-view');
    expect(view.style.whiteSpace).toBe('pre-wrap');
    const red = Array.from(view.querySelectorAll('span')).find((sp) => sp.textContent === 'red')!;
    expect(red.style.display).not.toBe('inline-block');
  });

  it('caps rendered rows at MAX_RENDER_LINES', async () => {
    const engine = makeEngine(80, 10);
    const { getByTestId } = render(<FlowView engine={engine} />);
    const burst = Array.from({ length: MAX_RENDER_LINES + 50 }, (_, i) => `L${i}`).join('\r\n');
    await write(engine, burst);
    const rows = getByTestId('flow-view').querySelectorAll('[data-row]');
    expect(rows.length).toBeLessThanOrEqual(MAX_RENDER_LINES);
    expect(getByTestId('flow-view').textContent).toContain(`L${MAX_RENDER_LINES + 49}`);
    expect(getByTestId('flow-view').textContent).not.toContain('L0 '); // oldest dropped from DOM
  });
});
