import { describe, expect, it, vi } from 'vitest';
import type { ClientRect, KeyboardCoordinateGetter } from '@dnd-kit/core';
import {
  createPaneKeyboardCoordinates,
  paneDragId,
  paneDropId,
  paneTargetForArrow,
  sessionIdFromPaneDragId,
  sessionIdFromPaneDropId,
} from './pane-reorder-navigation';

describe('pane reorder IDs', () => {
  it('round-trips a pane drag ID', () => {
    expect(paneDragId('session-1')).toBe('pane-reorder:session-1');
    expect(sessionIdFromPaneDragId(paneDragId('session-1'))).toBe('session-1');
  });

  it('rejects wrong prefixes and empty suffixes', () => {
    expect(sessionIdFromPaneDragId('pane-slot:session-1')).toBeNull();
    expect(sessionIdFromPaneDragId('pane-reorder:')).toBeNull();
    expect(sessionIdFromPaneDragId(42)).toBeNull();
    expect(paneDropId('session-1')).toBe('pane-slot:session-1');
    expect(sessionIdFromPaneDropId('wrong:session-1')).toBeNull();
    expect(sessionIdFromPaneDropId('pane-slot:')).toBeNull();
  });
});

describe('paneTargetForArrow', () => {
  it('moves left and right through flattened visual slots without wrapping', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(paneTargetForArrow(ids, 'd', 'ArrowLeft')).toBe('c');
    expect(paneTargetForArrow(ids, 'a', 'ArrowLeft')).toBeNull();
    expect(paneTargetForArrow(ids, 'e', 'ArrowRight')).toBeNull();
  });

  it('clamps five-pane vertical movement to the target row', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(paneTargetForArrow(ids, 'c', 'ArrowDown')).toBe('e');
    expect(paneTargetForArrow(ids, 'e', 'ArrowUp')).toBe('b');
  });

  it('uses pane rows for three-pane vertical movement', () => {
    const ids = ['a', 'b', 'c'];
    expect(paneTargetForArrow(ids, 'b', 'ArrowDown')).toBe('c');
    expect(paneTargetForArrow(ids, 'c', 'ArrowUp')).toBe('a');
  });

  it('uses pane rows for seven-pane vertical movement', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(paneTargetForArrow(ids, 'c', 'ArrowDown')).toBe('e');
    expect(paneTargetForArrow(ids, 'g', 'ArrowUp')).toBe('e');
  });

  it('uses pane rows for twelve-pane vertical movement', () => {
    const ids = Array.from({ length: 12 }, (_, index) => String.fromCharCode(97 + index));
    expect(paneTargetForArrow(ids, 'd', 'ArrowDown')).toBe('h');
    expect(paneTargetForArrow(ids, 'i', 'ArrowUp')).toBe('e');
  });
});

function rectangle(left: number, top: number, width: number, height: number): ClientRect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe('createPaneKeyboardCoordinates', () => {
  it('returns the target slot center and prevents the handled arrow default', () => {
    const getter = createPaneKeyboardCoordinates(['a', 'b']);
    const preventDefault = vi.fn();
    const event = { code: 'ArrowRight', preventDefault } as unknown as KeyboardEvent;
    const coordinates = getter(event, {
      active: paneDragId('a'),
      currentCoordinates: { x: 1, y: 2 },
      context: {
        over: { id: paneDropId('a') },
        droppableRects: new Map([
          [paneDropId('a'), rectangle(0, 0, 10, 10)],
          [paneDropId('b'), rectangle(20, 30, 40, 60)],
        ]),
      } as Parameters<KeyboardCoordinateGetter>[1]['context'],
    });

    expect(coordinates).toEqual({ x: 40, y: 60 });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('uses the active drag ID when there is no current drop target', () => {
    const getter = createPaneKeyboardCoordinates(['a', 'b']);
    const event = { code: 'ArrowRight', preventDefault: vi.fn() } as unknown as KeyboardEvent;

    expect(
      getter(event, {
        active: paneDragId('a'),
        currentCoordinates: { x: 1, y: 2 },
        context: {
          over: null,
          droppableRects: new Map([[paneDropId('b'), rectangle(20, 30, 40, 60)]]),
        } as Parameters<KeyboardCoordinateGetter>[1]['context'],
      }),
    ).toEqual({ x: 40, y: 60 });
  });

  it('leaves non-arrow events and impossible moves at the current coordinates', () => {
    const getter = createPaneKeyboardCoordinates(['a']);
    const preventDefault = vi.fn();
    const currentCoordinates = { x: 1, y: 2 };

    expect(
      getter({ code: 'Enter', preventDefault } as unknown as KeyboardEvent, {
        active: paneDragId('a'),
        currentCoordinates,
        context: {} as Parameters<KeyboardCoordinateGetter>[1]['context'],
      }),
    ).toBe(currentCoordinates);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
