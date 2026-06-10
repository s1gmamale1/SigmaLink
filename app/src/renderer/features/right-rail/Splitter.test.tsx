// @vitest-environment jsdom
//
// 2026-06-10 audit, finding 2 — Splitter sets document.body cursor/userSelect
// on pointerdown and resets them only in endDrag. A mid-drag unmount (rail
// closed, workspace switch) previously left `user-select: none` app-wide.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Splitter } from './Splitter';

beforeAll(() => {
  // jsdom has no pointer capture; Splitter calls setPointerCapture unguarded
  // on pointerdown. (Pattern: MemoryQuickSwitcher.test.tsx.)
  const proto = Element.prototype as unknown as {
    setPointerCapture?: (id: number) => void;
    releasePointerCapture?: (id: number) => void;
  };
  if (!proto.setPointerCapture) proto.setPointerCapture = () => undefined;
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => undefined;
});

afterEach(() => {
  cleanup();
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

describe('Splitter — body style hygiene', () => {
  it('resets body cursor/userSelect when unmounted mid-drag', () => {
    const { getByRole, unmount } = render(
      <Splitter width={400} onResize={() => {}} onCommit={() => {}} />,
    );
    fireEvent.pointerDown(getByRole('separator'), { pointerId: 1, clientX: 500 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    unmount(); // mid-drag — endDrag never fires

    // Pre-fix: both stuck ('col-resize' / 'none') app-wide.
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('normal release still resets styles and commits the width (regression guard)', () => {
    const onCommit = vi.fn();
    const { getByRole } = render(
      <Splitter width={400} onResize={() => {}} onCommit={onCommit} />,
    );
    const sep = getByRole('separator');
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 500 });
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 480 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('unmount with NO drag in flight leaves body styles untouched (never stomp siblings)', () => {
    document.body.style.cursor = 'wait'; // another surface owns the cursor
    const { unmount } = render(
      <Splitter width={400} onResize={() => {}} onCommit={() => {}} />,
    );
    unmount();
    expect(document.body.style.cursor).toBe('wait');
  });
});
