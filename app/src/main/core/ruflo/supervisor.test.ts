import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
  },
}));

import { RufloMcpSupervisor } from './supervisor';

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
    stdin: { write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = 7001;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.stdin = { write: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('RufloMcpSupervisor.stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGKILL after 2s when SIGTERM was sent but the child has not exited', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const supervisor = new RufloMcpSupervisor({
      rufloRoot: '/ruflo',
      cwd: '/runtime',
      nodeBinary: '/node',
      forceState: 'down',
    });

    await supervisor.start();
    supervisor.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(2_001);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
