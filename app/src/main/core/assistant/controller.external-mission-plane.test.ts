// P3 Task 4 (D2/D5) — socket-path proof for the external mission plane.
// Mirrors controller.mcp-origin.test.ts's harness (buildAssistantController +
// createDbFake), but exercises the DIRECT `invokeTool` path (not
// invokeToolForConversation) — this is the exact call shape
// control-mcp-host.ts uses for the External Control MCP socket: every
// forwarded call carries `origin:'external'` + `clientLabel` (the connecting
// client's hello-handshake label) straight into invokeAssistantTool. Proves
// submit_task threads both fields onto the created mission row, and that the
// decompose wake enqueues via ctx.enqueueMissionWake.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
vi.mock('../browser/cdp', () => ({
  runCDP: vi.fn(),
  attachDebugger: vi.fn(() => true),
  detachDebugger: vi.fn(),
}));
vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: vi.fn(async () => ({ sessions: [] })),
}));

import { getDb, getRawDb } from '../db/client';
import { buildAssistantController } from './controller';
import type { AssistantControllerDeps } from './controller';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';
import * as missionsDao from '../missions/dao';

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
});

type InvokeToolFn = (input: {
  conversationId?: string;
  name: string;
  args: Record<string, unknown>;
  origin?: 'local' | 'telegram' | 'external' | 'autonomous';
  confirmDangerous?: (toolName: string, summary: string) => Promise<boolean>;
  clientLabel?: string;
}) => Promise<{ ok: boolean; result: unknown; error?: string }>;

function makeController(overrides: Partial<AssistantControllerDeps> = {}) {
  const deps: AssistantControllerDeps = {
    pty: {
      write: vi.fn(),
      kill: vi.fn(),
      has: vi.fn(() => true),
      snapshot: vi.fn(() => ''),
      isLive: vi.fn(() => true),
    } as unknown as AssistantControllerDeps['pty'],
    worktreePool: {} as AssistantControllerDeps['worktreePool'],
    mailbox: {} as AssistantControllerDeps['mailbox'],
    memory: {} as AssistantControllerDeps['memory'],
    tasks: {} as AssistantControllerDeps['tasks'],
    browserRegistry: {} as AssistantControllerDeps['browserRegistry'],
    userDataDir: '/tmp/test-userData',
    emit: vi.fn(),
    ...overrides,
  };
  const bundle = buildAssistantController(deps);
  const invokeTool = (bundle as unknown as { invokeTool: InvokeToolFn }).invokeTool;
  return { invokeTool };
}

describe('external mission plane — origin:"external" lands on the mission row (Control MCP socket shape)', () => {
  it('submit_task stamps origin="external" + the hello-handshake clientLabel on the created mission', async () => {
    const { invokeTool } = makeController();
    const out = await invokeTool({
      name: 'submit_task',
      args: { order: 'ship the thing' },
      origin: 'external',
      confirmDangerous: async () => false,
      clientLabel: 'hermes-1',
    });
    expect(out.ok).toBe(true);
    const missionId = (out.result as { missionId: string }).missionId;
    const mission = missionsDao.getMission(missionId);
    expect(mission?.origin).toBe('external');
    expect(mission?.clientLabel).toBe('hermes-1');
    expect(mission?.goal).toBe('ship the thing');
    expect(mission?.status).toBe('active');
  });

  it('submit_task is FREE for external origin — no confirmDangerous consultation, no escalation gate', async () => {
    const confirmDangerous = vi.fn(async () => false);
    const { invokeTool } = makeController();
    const out = await invokeTool({
      name: 'submit_task',
      args: { order: 'free path check' },
      origin: 'external',
      confirmDangerous,
      clientLabel: 'hermes-1',
    });
    expect(out.ok).toBe(true);
    expect(confirmDangerous).not.toHaveBeenCalled();
  });

  it('submit_task enqueues a decompose wake via the AssistantControllerDeps.enqueueMissionWake late-bind', async () => {
    const enqueueMissionWake = vi.fn();
    const { invokeTool } = makeController({ enqueueMissionWake });
    const out = await invokeTool({
      name: 'submit_task',
      args: { order: 'wake me up' },
      origin: 'external',
      clientLabel: 'hermes-1',
    });
    const missionId = (out.result as { missionId: string }).missionId;
    expect(enqueueMissionWake).toHaveBeenCalledWith('decompose', missionId);
  });

  it('check_task/get_report over the same external socket shape read the mission back', async () => {
    const { invokeTool } = makeController();
    const submitted = await invokeTool({
      name: 'submit_task',
      args: { order: 'readable order' },
      origin: 'external',
      clientLabel: 'hermes-1',
    });
    const missionId = (submitted.result as { missionId: string }).missionId;

    const checked = await invokeTool({
      name: 'check_task',
      args: { missionId },
      origin: 'external',
      clientLabel: 'hermes-1',
    });
    expect(checked.ok).toBe(true);
    expect((checked.result as { mission: { id: string } }).mission.id).toBe(missionId);

    const reported = await invokeTool({
      name: 'get_report',
      args: { missionId },
      origin: 'external',
      clientLabel: 'hermes-1',
    });
    expect(reported.ok).toBe(true);
    expect((reported.result as { status: string; report: string | null }).status).toBe('active');
    expect((reported.result as { status: string; report: string | null }).report).toBeNull();
  });

  it('kill-switch denies submit_task for external origin even though it is otherwise free', async () => {
    const { invokeTool } = makeController({ controlFrozen: () => true });
    const out = await invokeTool({
      name: 'submit_task',
      args: { order: 'should be denied' },
      origin: 'external',
      clientLabel: 'hermes-1',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/kill-switch/i);
  });
});
