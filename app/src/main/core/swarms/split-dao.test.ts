// v1.4.3 #06 — split-dao unit tests.
//
// Verifies the three core helpers (setPaneSplit, setPaneMinimised,
// getPaneSplitGroup) against the in-memory DB fake. The raw shim parses
// simple UPDATE statements (db-fake-raw.ts) and the drizzle shim handles the
// SELECT chain, so we exercise both surfaces from one test file.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import {
  createDbFake,
  seedAgentSession,
  seedWorkspace,
  type DbFake,
} from '@/test-utils/db-fake';
import {
  findPaneById,
  getPaneSplitGroup,
  getPaneWorkspaceId,
  setPaneMinimised,
  setPaneSplit,
} from './split-dao';

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
  seedWorkspace(fake, { id: 'ws-1' });
});

describe('setPaneSplit', () => {
  it('writes split_group_id / direction / index to the row', () => {
    seedAgentSession(fake, { id: 'sess-1', workspaceId: 'ws-1' });

    setPaneSplit('sess-1', 'split-A', 'horizontal', 0);

    const row = findPaneById('sess-1');
    expect(row?.splitGroupId).toBe('split-A');
    expect(row?.splitDirection).toBe('horizontal');
    expect(row?.splitIndex).toBe(0);
  });

  it('supports back-to-back writes for the two halves of a split', () => {
    seedAgentSession(fake, { id: 'sess-a', workspaceId: 'ws-1' });
    seedAgentSession(fake, { id: 'sess-b', workspaceId: 'ws-1' });

    setPaneSplit('sess-a', 'split-X', 'vertical', 0);
    setPaneSplit('sess-b', 'split-X', 'vertical', 1);

    expect(findPaneById('sess-a')?.splitIndex).toBe(0);
    expect(findPaneById('sess-b')?.splitIndex).toBe(1);
  });
});

describe('setPaneMinimised', () => {
  it('toggles the minimised flag to 1 when set true', () => {
    seedAgentSession(fake, { id: 'sess-1', workspaceId: 'ws-1', minimised: 0 });

    setPaneMinimised('sess-1', true);

    // Stored as 0/1 on disk; the loader/select returns the raw column.
    const row = findPaneById('sess-1') as unknown as { minimised: number };
    expect(row.minimised).toBe(1);
  });

  it('clears the minimised flag back to 0 when set false', () => {
    seedAgentSession(fake, { id: 'sess-1', workspaceId: 'ws-1', minimised: 1 });

    setPaneMinimised('sess-1', false);

    const row = findPaneById('sess-1') as unknown as { minimised: number };
    expect(row.minimised).toBe(0);
  });
});

describe('getPaneSplitGroup', () => {
  it('returns both halves of a split group ordered by split_index', () => {
    seedAgentSession(fake, {
      id: 'sess-b',
      workspaceId: 'ws-1',
      splitGroupId: 'g-1',
      splitDirection: 'horizontal',
      splitIndex: 1,
    });
    seedAgentSession(fake, {
      id: 'sess-a',
      workspaceId: 'ws-1',
      splitGroupId: 'g-1',
      splitDirection: 'horizontal',
      splitIndex: 0,
    });

    const group = getPaneSplitGroup('g-1');
    expect(group.map((p) => p.id)).toEqual(['sess-a', 'sess-b']);
    expect(group[0].splitDirection).toBe('horizontal');
  });

  it('returns an empty array when no panes share the group id', () => {
    expect(getPaneSplitGroup('does-not-exist')).toEqual([]);
  });
});

describe('getPaneWorkspaceId', () => {
  it('returns the workspaceId for an existing pane', () => {
    seedAgentSession(fake, { id: 'sess-1', workspaceId: 'ws-1' });
    expect(getPaneWorkspaceId('sess-1')).toBe('ws-1');
  });

  it('returns null when the pane does not exist', () => {
    expect(getPaneWorkspaceId('ghost')).toBeNull();
  });
});
