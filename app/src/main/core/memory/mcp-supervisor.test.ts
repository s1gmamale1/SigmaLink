import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/user-data'),
    getAppPath: vi.fn(() => '/app'),
  },
}));

vi.mock('node:child_process', () => ({ spawn }));

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
}));

import { MemoryMcpSupervisor } from './mcp-supervisor';

function childDouble() {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

describe('MemoryMcpSupervisor', () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockReturnValue(childDouble());
  });

  it('registers the client launch command without spawning an unused stdio child', async () => {
    const supervisor = new MemoryMcpSupervisor({
      serverEntry: '/app/electron-dist/mcp-memory-server.cjs',
      dbPath: '/user-data/sigmalink.db',
    });

    await supervisor.start('ws-1', '/workspace');

    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.getCommandFor('ws-1')).toEqual({
      command: process.execPath,
      args: ['/app/electron-dist/mcp-memory-server.cjs'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        SIGMALINK_DB_PATH: '/user-data/sigmalink.db',
        SIGMALINK_WORKSPACE_ID: 'ws-1',
        SIGMALINK_WORKSPACE_ROOT: '/workspace',
      },
    });
  });

  it('removes registered commands on workspace stop', async () => {
    const supervisor = new MemoryMcpSupervisor({
      serverEntry: '/app/electron-dist/mcp-memory-server.cjs',
      dbPath: '/user-data/sigmalink.db',
    });
    await supervisor.start('ws-1', '/workspace');

    supervisor.stop('ws-1');

    expect(supervisor.hasEntry('ws-1')).toBe(false);
    expect(supervisor.getCommandFor('ws-1')).toBeNull();
  });
});
