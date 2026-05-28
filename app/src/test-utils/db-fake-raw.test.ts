import { describe, expect, it } from 'vitest';
import { createDbFake, seedAgentSession } from './db-fake';

describe('db-fake-raw SELECT predicates', () => {
  it('honors equality, IS NOT NULL, and IN predicates before returning rows', () => {
    const fake = createDbFake();
    seedAgentSession(fake, {
      id: 'live-0',
      workspaceId: 'ws-1',
      paneIndex: 0,
      status: 'running',
    });
    seedAgentSession(fake, {
      id: 'terminal-1',
      workspaceId: 'ws-1',
      paneIndex: 1,
      status: 'exited',
    });
    seedAgentSession(fake, {
      id: 'null-live',
      workspaceId: 'ws-1',
      paneIndex: null,
      status: 'starting',
    });
    seedAgentSession(fake, {
      id: 'other-ws',
      workspaceId: 'ws-2',
      paneIndex: 0,
      status: 'running',
    });

    const rows = fake.raw
      .prepare(
        `SELECT pane_index, status
         FROM agent_sessions
         WHERE workspace_id = ?
           AND pane_index IS NOT NULL
           AND status IN ('running', 'starting')
         ORDER BY pane_index ASC`,
      )
      .all('ws-1');

    expect(rows).toEqual([{ pane_index: 0, status: 'running' }]);
  });
});
