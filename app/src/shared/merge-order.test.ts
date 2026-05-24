import { describe, it, expect } from 'vitest';
import { proposeMergeOrder } from './merge-order';

describe('proposeMergeOrder', () => {
  it('orders fewest-overlap panes first; disjoint panes keep input order', () => {
    const order = proposeMergeOrder([
      { sessionId: 'a', changedFiles: ['x.ts', 'y.ts'] },
      { sessionId: 'b', changedFiles: ['y.ts', 'z.ts'] }, // overlaps a on y.ts
      { sessionId: 'c', changedFiles: ['q.ts'] },          // disjoint
    ]);
    expect(order[0]).toBe('c');           // least conflicting first
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('empty → []', () => {
    expect(proposeMergeOrder([])).toEqual([]);
  });

  it('single pane → returns that pane sessionId', () => {
    expect(proposeMergeOrder([{ sessionId: 'x', changedFiles: ['a.ts'] }])).toEqual(['x']);
  });

  it('all disjoint panes keep input order', () => {
    const order = proposeMergeOrder([
      { sessionId: 'a', changedFiles: ['x.ts'] },
      { sessionId: 'b', changedFiles: ['y.ts'] },
      { sessionId: 'c', changedFiles: ['z.ts'] },
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
