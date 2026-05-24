// Tests for buildDesignController — C-13 existing-pane dispatch path.
// Pure node environment (no directive).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock class modules before importing the module under test.
vi.mock('./picker', () => {
  class DesignPickerRuntime {
    start = vi.fn();
    stop = vi.fn();
    stopAll = vi.fn();
    getSessionByToken = vi.fn().mockReturnValue(null);
    constructor(_opts: unknown) {}
  }
  return { DesignPickerRuntime };
});

vi.mock('./staging', () => {
  class DesignStaging {
    attach = vi.fn();
    ensureCanvasDir = vi.fn();
    constructor(_opts: unknown) {}
  }
  return { DesignStaging };
});

vi.mock('./hmr-poke', () => {
  class HmrPoke {
    setRoots = vi.fn();
    reloadTab = vi.fn();
    shutdown = vi.fn();
    constructor(_opts: unknown) {}
  }
  return { HmrPoke };
});

// Mock the DB client — dispatch with targetSessionId never hits the DB.
vi.mock('../db/client', () => ({
  getDb: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: vi.fn() }),
      }),
    }),
  }),
}));

// Mock executeLaunchPlan so the provider spawn path doesn't run.
vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: vi.fn().mockResolvedValue({
    sessions: [{ id: 'sess-spawn', status: 'running' }],
  }),
}));

import { buildDesignController } from './controller';

const mockBrowserRegistry = {
  has: vi.fn().mockReturnValue(false),
  get: vi.fn(),
};
const mockPty = {
  write: vi.fn(),
  create: vi.fn(),
  kill: vi.fn(),
  snapshot: vi.fn(),
  list: vi.fn().mockReturnValue([]),
  get: vi.fn(),
  forget: vi.fn(),
  resize: vi.fn(),
  setExternalSessionId: vi.fn(),
};
const mockWorktreePool = {
  acquire: vi.fn(),
  release: vi.fn(),
};

describe('buildDesignController — dispatch', () => {
  let ptyWriteSpy: ReturnType<typeof vi.fn>;
  let ctl: ReturnType<typeof buildDesignController>;

  beforeEach(() => {
    ptyWriteSpy = vi.fn().mockResolvedValue(undefined);
    vi.clearAllMocks();
    ctl = buildDesignController({
      browserRegistry: mockBrowserRegistry as never,
      pty: mockPty as never,
      worktreePool: mockWorktreePool as never,
      userDataDir: '/tmp/test-userData',
      emit: vi.fn(),
      ptyWrite: ptyWriteSpy,
    });
  });

  it('routes to existing pane via ptyWrite when targetSessionId is provided', async () => {
    const result = await ctl.dispatch({
      pickerToken: '',
      prompt: 'fix',
      targetSessionId: 'S1',
      capture: {
        selector: '.btn',
        html: '<button>Go</button>',
        pageUrl: 'http://localhost:3000/',
      },
    });

    expect(ptyWriteSpy).toHaveBeenCalledOnce();
    const [sessionId, text] = ptyWriteSpy.mock.calls[0] as [string, string];
    expect(sessionId).toBe('S1');
    // Text must end with '\r'
    expect(text.endsWith('\r')).toBe(true);
    // Text must contain the prompt
    expect(text).toContain('fix');
    // Result must be the routedTo shape
    expect(result).toEqual({ routedTo: 'S1' });
  });

  it('does NOT call executeLaunchPlan on targetSessionId path', async () => {
    await ctl.dispatch({
      pickerToken: '',
      prompt: 'change color',
      targetSessionId: 'S2',
    });

    expect(ptyWriteSpy).toHaveBeenCalledOnce();
    const { executeLaunchPlan } = await import('../workspaces/launcher');
    expect(executeLaunchPlan).not.toHaveBeenCalled();
  });

  it('throws when prompt is empty on targetSessionId path', async () => {
    await expect(
      ctl.dispatch({ pickerToken: '', prompt: '', targetSessionId: 'S1' }),
    ).rejects.toThrow('design.dispatch: prompt required');
  });

  it('throws when no providers and no targetSessionId', async () => {
    await expect(
      ctl.dispatch({ pickerToken: '', prompt: 'test', providers: [] }),
    ).rejects.toThrow('design.dispatch: at least one provider required');
  });
});
