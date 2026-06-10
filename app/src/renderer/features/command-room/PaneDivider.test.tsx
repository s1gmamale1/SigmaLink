// @vitest-environment jsdom
//
// 2026-06-10 audit, finding 5 — PaneDivider's per-drag window pointermove/up
// listeners (and pending rAF) leaked when the divider unmounted mid-drag, and
// the parent's onResizeEnd never fired — leaving the PR #133
// sigma:pane-resize-start refit suppression stuck ON for every terminal.
// The normal release path must stay byte-identical (PR #133 drag system).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { PaneDivider } from './PaneDivider';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDivider() {
  const onResizeStart = vi.fn();
  const onResize = vi.fn();
  const onResizeEnd = vi.fn();
  const utils = render(
    <PaneDivider
      orientation="vertical"
      getSize={() => 1000}
      onResizeStart={onResizeStart}
      onResize={onResize}
      onResizeEnd={onResizeEnd}
    />,
  );
  return { ...utils, onResizeStart, onResize, onResizeEnd };
}

describe('PaneDivider — mid-drag unmount safety (PR #133 behavior preserved)', () => {
  it('normal release: pointerup ends the drag exactly once; a later unmount does not re-end it', () => {
    const { getByTestId, unmount, onResizeStart, onResizeEnd } = renderDivider();
    fireEvent.pointerDown(getByTestId('pane-divider'), { pointerId: 1, clientX: 100 });
    expect(onResizeStart).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 120 });
    expect(onResizeEnd).toHaveBeenCalledTimes(1);

    unmount();
    expect(onResizeEnd).toHaveBeenCalledTimes(1); // no double-end
  });

  it('unmount mid-drag detaches the window listeners and still releases the drag once', () => {
    // Synchronous rAF: a LEAKED pointermove listener would call onResize
    // immediately, making the leak assertion deterministic.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const { getByTestId, unmount, onResize, onResizeEnd } = renderDivider();
    fireEvent.pointerDown(getByTestId('pane-divider'), { pointerId: 1, clientX: 100 });

    unmount(); // pane closed / grid reshape mid-drag

    // The sigma:pane-resize-start suppression pair must be released exactly
    // once (pre-fix: never — terminals stayed refit-suppressed forever).
    expect(onResizeEnd).toHaveBeenCalledTimes(1);

    // And the window listeners must be GONE: a post-unmount pointermove must
    // not drive onResize (pre-fix: the leaked listener still fired).
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('keyboard nudge path is untouched: arrow key fires start → resize → end once each', () => {
    const { getByTestId, onResizeStart, onResize, onResizeEnd } = renderDivider();
    fireEvent.keyDown(getByTestId('pane-divider'), { key: 'ArrowRight' });
    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(0.02);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });
});
