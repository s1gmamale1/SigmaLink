// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { MissionTask } from '@/shared/types';
import { MissionBoard } from './MissionBoard';

afterEach(() => {
  cleanup();
});

function task(
  id: string,
  status: MissionTask['status'],
  overrides: Partial<MissionTask> = {},
): MissionTask {
  return {
    id,
    missionId: 'm1',
    title: `Task ${id}`,
    spec: '',
    status,
    assigneeSessionId: null,
    worktreePath: null,
    attempt: 0,
    orderIdx: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('MissionBoard', () => {
  it('renders all 7 task-status columns, in order', () => {
    render(<MissionBoard tasks={[]} />);
    const labels = ['Backlog', 'Dispatched', 'Working', 'Reviewing', 'Needs Input', 'Done', 'Blocked'];
    const board = screen.getByTestId('mission-board');
    const rendered = labels.map((l) => within(board).getByText(l));
    for (const el of rendered) expect(el).toBeTruthy();
    for (let i = 1; i < rendered.length; i++) {
      // Each column header must precede the next in document order.
      expect(
        rendered[i - 1].compareDocumentPosition(rendered[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('a task card lands in its own status column, not any other', () => {
    render(<MissionBoard tasks={[task('t1', 'working', { title: 'Fix the bug' })]} />);
    const workingCol = screen.getByTestId('mission-column-working');
    expect(within(workingCol).getByText('Fix the bug')).toBeTruthy();

    const backlogCol = screen.getByTestId('mission-column-backlog');
    expect(within(backlogCol).queryByText('Fix the bug')).toBeNull();
  });

  it('sorts multiple tasks into their respective columns', () => {
    render(
      <MissionBoard
        tasks={[
          task('t1', 'backlog', { title: 'Backlog task' }),
          task('t2', 'done', { title: 'Done task' }),
          task('t3', 'blocked', { title: 'Blocked task' }),
        ]}
      />,
    );
    expect(
      within(screen.getByTestId('mission-column-backlog')).getByText('Backlog task'),
    ).toBeTruthy();
    expect(within(screen.getByTestId('mission-column-done')).getByText('Done task')).toBeTruthy();
    expect(
      within(screen.getByTestId('mission-column-blocked')).getByText('Blocked task'),
    ).toBeTruthy();
  });

  it('does not crash on a task with no assignee (P1a default: assigneeSessionId is always null)', () => {
    render(<MissionBoard tasks={[task('t1', 'backlog', { assigneeSessionId: null })]} />);
    expect(screen.getByText('Task t1')).toBeTruthy();
  });

  it('shows the linked pane name when a task IS assigned', () => {
    render(<MissionBoard tasks={[task('t1', 'working', { assigneeSessionId: 'abcdef1234567890' })]} />);
    // Card shows "Pane " + the first 8 chars of the session id.
    expect(screen.getByText(/abcdef12/)).toBeTruthy();
  });
});
