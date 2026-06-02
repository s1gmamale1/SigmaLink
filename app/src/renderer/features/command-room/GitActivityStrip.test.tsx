// @vitest-environment jsdom
//
// P6 FEAT-8 — GitActivityStrip coverage.
//
// We mock the poll hook (`useGitActivityPoll`) so the test is deterministic and
// doesn't touch RPC/timers. Asserts:
//   - no worktree path → renders nothing
//   - empty buckets → renders nothing
//   - populated buckets → renders the strip with an accessible summary label
//     (total commits + churn) so VoiceOver/screen-reader users get the number.
//
// recharts' ResponsiveContainer measures its parent; in jsdom that's 0×0 so the
// SVG bars don't paint. We therefore assert on the labelled wrapper element
// (the load-bearing accessibility contract), not on the chart internals.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { GitActivityBucket } from '@/shared/types';

const pollMock = vi.fn<(worktreePath: string | null) => GitActivityBucket[]>();

vi.mock('@/renderer/lib/use-git-activity-poll', () => ({
  useGitActivityPoll: (p: string | null) => pollMock(p),
}));

import { GitActivityStrip } from './GitActivityStrip';

// recharts' ResponsiveContainer instantiates a ResizeObserver, which jsdom
// lacks. Stub minimally so the populated-render path doesn't crash.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

function bucket(over: Partial<GitActivityBucket> = {}): GitActivityBucket {
  return {
    date: '2026-05-01',
    commitCount: 1,
    filesChanged: 1,
    linesAdded: 0,
    linesDeleted: 0,
    churn: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pollMock.mockReturnValue([]);
});

afterEach(() => cleanup());

describe('GitActivityStrip', () => {
  it('renders nothing when there is no worktree path', () => {
    pollMock.mockReturnValue([]);
    const { container } = render(<GitActivityStrip worktreePath={null} />);
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByTestId('git-activity-strip')).toBeNull();
  });

  it('renders nothing when there is no recent activity', () => {
    pollMock.mockReturnValue([]);
    const { container } = render(<GitActivityStrip worktreePath="/wt" />);
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByTestId('git-activity-strip')).toBeNull();
  });

  it('renders the strip with an accessible churn summary when populated', () => {
    pollMock.mockReturnValue([
      bucket({ date: '2026-05-01', commitCount: 2, linesAdded: 10, linesDeleted: 3, churn: 13 }),
      bucket({ date: '2026-05-03', commitCount: 1, linesAdded: 5, linesDeleted: 0, churn: 5 }),
    ]);

    render(<GitActivityStrip worktreePath="/wt" />);

    const strip = screen.getByTestId('git-activity-strip');
    expect(strip).toBeTruthy();

    // The accessible label summarizes totals: 2 active days, 3 commits,
    // churn 18 (+15 / -3).
    const label = strip.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/2 active days/);
    expect(label).toMatch(/3 commits/);
    expect(label).toMatch(/18 lines changed/);
    expect(label).toMatch(/\+15 \/ -3/);
    expect(strip.getAttribute('role')).toBe('img');
  });

  it('singularizes the label for a single active day with one commit', () => {
    pollMock.mockReturnValue([
      bucket({ date: '2026-05-01', commitCount: 1, linesAdded: 4, linesDeleted: 1, churn: 5 }),
    ]);
    render(<GitActivityStrip worktreePath="/wt" />);
    const label = screen.getByTestId('git-activity-strip').getAttribute('aria-label') ?? '';
    expect(label).toMatch(/1 active day:/);
    expect(label).toMatch(/1 commit,/);
  });

  it('passes the worktree path through to the poll hook', () => {
    pollMock.mockReturnValue([]);
    render(<GitActivityStrip worktreePath="/some/worktree" />);
    expect(pollMock).toHaveBeenCalledWith('/some/worktree');
  });
});
