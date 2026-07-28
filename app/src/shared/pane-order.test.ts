import { describe, expect, it } from 'vitest';
import {
  parsePaneOrder,
  reconcilePaneOrder,
  replacePaneOrderId,
  serializePaneOrder,
  swapPaneIds,
} from './pane-order';

describe('pane-order persistence', () => {
  it('round-trips a versioned record', () => {
    expect(parsePaneOrder(serializePaneOrder(['a', 'b']))).toEqual(['a', 'b']);
  });

  it.each([null, '', '{', '[]', '{"version":2,"sessionIds":["a"]}', '{"version":1,"sessionIds":"a"}'])(
    'rejects malformed or unsupported input: %s', (raw) => {
      expect(parsePaneOrder(raw)).toEqual([]);
    });

  it('filters empty, non-string, and duplicate IDs', () => {
    expect(parsePaneOrder('{"version":1,"sessionIds":["a","",7,"a","b"]}'))
      .toEqual(['a', 'b']);
  });
});

describe('reconcilePaneOrder', () => {
  it('keeps saved live IDs, drops stale IDs, and appends missing live IDs canonically', () => {
    expect(reconcilePaneOrder(['c', 'stale', 'a', 'c'], ['a', 'b', 'c', 'd']))
      .toEqual(['c', 'a', 'b', 'd']);
  });

  it('never hides or duplicates a live pane', () => {
    expect(reconcilePaneOrder([], ['a', 'a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('swapPaneIds', () => {
  it.each([
    [['a', 'b', 'c'], 'a', 'c', ['c', 'b', 'a']],
    [['a', 'b', 'c', 'd', 'e'], 'e', 'b', ['a', 'e', 'c', 'd', 'b']],
    [['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'g', 'c', ['a', 'b', 'g', 'd', 'e', 'f', 'c']],
  ])('swaps exactly two identities', (input, source, target, expected) => {
    expect(swapPaneIds(input, source, target)).toEqual(expected);
  });

  it('preserves the input reference for same-target and unknown IDs', () => {
    const order = ['a', 'b'];
    expect(swapPaneIds(order, 'a', 'a')).toBe(order);
    expect(swapPaneIds(order, 'missing', 'b')).toBe(order);
  });
});

describe('replacePaneOrderId', () => {
  it('keeps a relaunched pane in the crashed pane slot', () => {
    expect(replacePaneOrderId(['a', 'crashed', 'c'], 'crashed', 'replacement'))
      .toEqual(['a', 'replacement', 'c']);
  });

  it('is a reference-preserving no-op for missing, identical, empty, or duplicate replacements', () => {
    const order = ['a', 'b'];
    expect(replacePaneOrderId(order, 'missing', 'c')).toBe(order);
    expect(replacePaneOrderId(order, 'a', 'a')).toBe(order);
    expect(replacePaneOrderId(order, 'a', '')).toBe(order);
    expect(replacePaneOrderId(order, 'a', 'b')).toBe(order);
  });
});
