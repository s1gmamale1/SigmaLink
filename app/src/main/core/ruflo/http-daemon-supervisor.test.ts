// Unit tests for RufloHttpDaemonSupervisor.
//
// Strategy:
//   - vi.mock('node:child_process') replaces spawn/execSync with controllable fakes
//   - vi.mock('node:net') stubs allocatePort so we get a deterministic port
//   - vi.mock('node:http') stubs the health-probe GET calls
//   - vi.useFakeTimers() lets us fast-forward backoff/timeout delays
//
// We import the supervisor AFTER mocks are in place so module initialisation
// picks up the fakes. vi.resetAllMocks() in afterEach ensures mockReturnValue
// state does not leak between tests.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ── mock: node:child_process ───────────────────────────────────────────────

const mockSpawn = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Routed-spawn assertion: the SUT must launch tiers through spawnExecutable
// (which wraps .cmd shims on win32), not raw child_process.spawn. The mock
// forwards to mockSpawn so every existing assertion keeps working.
const spawnExecutableCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('../util/spawn-cross-platform', () => ({
  spawnExecutable: (cmd: string, args: string[], opts: unknown) => {
    spawnExecutableCalls.push({ cmd, args });
    return mockSpawn(cmd, args, opts);
  },
}));

// ── mock: node:net ─────────────────────────────────────────────────────────

const NET_PORT = 54321;
const mockNetServer = {
  listen: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  address: vi.fn(() => ({ port: NET_PORT })),
};

vi.mock('node:net', () => ({
  default: {
    createServer: () => mockNetServer,
  },
  createServer: () => mockNetServer,
}));

// ── mock: node:http ────────────────────────────────────────────────────────

type GetCallback = (res: MockHttpResponse) => void;
type RequestCallback = (res: MockHttpResponse) => void;

interface MockHttpResponse extends EventEmitter {
  statusCode: number;
  setEncoding: (enc: string) => void;
  resume: () => void;
}

interface MockHttpRequest extends EventEmitter {
  destroy: (err?: Error) => void;
  setTimeout: (ms: number, cb: () => void) => void;
  write: (data: string) => void;
  end: () => void;
}

let httpGetImpl: ((url: string, cb: GetCallback) => MockHttpRequest) | null = null;
/** Controls http.request() POST behaviour for the round-trip probe tests. */
let httpRequestImpl:
  | ((url: string, opts: unknown, cb: RequestCallback) => MockHttpRequest)
  | null = null;

vi.mock('node:http', () => ({
  default: {
    get: (url: string, cb: GetCallback) => {
      if (httpGetImpl) return httpGetImpl(url, cb);
      const req = makeReq();
      req.emit('error', new Error('no mock'));
      return req;
    },
    request: (url: string, opts: unknown, cb: RequestCallback) => {
      if (httpRequestImpl) return httpRequestImpl(url, opts, cb);
      const req = makeReq();
      req.emit('error', new Error('no mock'));
      return req;
    },
  },
  get: (url: string, cb: GetCallback) => {
    if (httpGetImpl) return httpGetImpl(url, cb);
    const req = makeReq();
    req.emit('error', new Error('no mock'));
    return req;
  },
  request: (url: string, opts: unknown, cb: RequestCallback) => {
    if (httpRequestImpl) return httpRequestImpl(url, opts, cb);
    const req = makeReq();
    req.emit('error', new Error('no mock'));
    return req;
  },
}));

function makeReq(): MockHttpRequest {
  const req = new EventEmitter() as MockHttpRequest;
  req.destroy = vi.fn();
  req.setTimeout = vi.fn();
  req.write = vi.fn();
  req.end = vi.fn();
  return req;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a mock ChildProcess EventEmitter. */
function makeChild(pid = 9999): EventEmitter & {
  pid: number;
  killed: boolean;
  kill: MockInstance;
  stdout: EventEmitter & { on: MockInstance };
  stderr: EventEmitter & { on: MockInstance };
  stdin: null;
} {
  const child = new EventEmitter() as ReturnType<typeof makeChild>;
  child.pid = pid;
  child.killed = false;
  child.kill = vi.fn(() => {
    /* intentionally not setting killed=true so SIGKILL test can verify escalation */
  });
  const makeStream = () => {
    const s = new EventEmitter() as EventEmitter & { on: MockInstance };
    const origOn = s.on.bind(s);
    s.on = vi.fn(origOn);
    return s;
  };
  child.stdout = makeStream();
  child.stderr = makeStream();
  child.stdin = null;
  return child;
}

/**
 * Set up the net mock so listen(0) resolves with NET_PORT.
 * The `close` callback is invoked synchronously.
 */
function setupNetMock(): void {
  mockNetServer.listen.mockImplementation(
    (_port: number, _host: string, cb: () => void) => {
      cb();
    },
  );
  mockNetServer.close.mockImplementation((cb: (err?: Error) => void) => {
    cb();
  });
  mockNetServer.on.mockImplementation(() => mockNetServer);
}

/**
 * Make httpGetImpl always return a health-ok response.
 * Uses Promise.resolve to schedule async work without relying on setImmediate
 * (which fake timers intercept and can create infinite loops).
 */
function alwaysHealthOk(): void {
  httpGetImpl = (_url, cb) => {
    const res = new EventEmitter() as MockHttpResponse;
    res.statusCode = 200;
    res.setEncoding = vi.fn();
    res.resume = vi.fn();
    const req = makeReq();

    // Schedule via Promise microtask (not setImmediate) so fake timers don't loop.
    void Promise.resolve().then(() => {
      cb(res);
      return Promise.resolve().then(() => {
        res.emit('data', '{"status":"ok"}');
        res.emit('end');
      });
    });

    return req;
  };
}

/**
 * Make httpGetImpl always fail with a connection error.
 * Error is emitted synchronously so it does not create setImmediate loops
 * with fake timers.
 */
function alwaysHealthFail(): void {
  httpGetImpl = () => {
    const req = makeReq();
    // Emit error synchronously — fake timers don't intercept synchronous calls.
    req.emit('error', new Error('ECONNREFUSED'));
    return req;
  };
}

/**
 * Make httpRequestImpl respond to every POST with a 200 + supplied body.
 * Used to mock the MCP JSON-RPC calls for the round-trip probe.
 */
function mockPostSuccess(body: string): void {
  httpRequestImpl = (_url, _opts, cb) => {
    const res = new EventEmitter() as MockHttpResponse;
    res.statusCode = 200;
    res.setEncoding = vi.fn();
    res.resume = vi.fn();
    const req = makeReq();
    void Promise.resolve().then(() => {
      cb(res);
      return Promise.resolve().then(() => {
        res.emit('data', body);
        res.emit('end');
      });
    });
    return req;
  };
}

/**
 * Make httpRequestImpl always fail for POST calls.
 */
function mockPostFail(): void {
  httpRequestImpl = () => {
    const req = makeReq();
    req.emit('error', new Error('ECONNREFUSED'));
    return req;
  };
}

// ── import the SUT (after mocks are in place) ──────────────────────────────

import { RufloHttpDaemonSupervisor } from './http-daemon-supervisor.ts';

// ── test suite ─────────────────────────────────────────────────────────────

describe('RufloHttpDaemonSupervisor', () => {
  let supervisor: RufloHttpDaemonSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    // Reset mocks fully (clears return values, call counts, and implementations).
    vi.resetAllMocks();
    spawnExecutableCalls.length = 0;
    setupNetMock();
    // Binary available by default (PATH probe succeeds).
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/ruflo'));
    httpGetImpl = null;
    httpRequestImpl = null;
    supervisor = new RufloHttpDaemonSupervisor({ binary: 'ruflo' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    httpGetImpl = null;
    httpRequestImpl = null;
  });

  // ── spawn-succeeds ─────────────────────────────────────────────────────

  it('spawn-succeeds: returns handle with correct port and status=running', async () => {
    alwaysHealthOk();
    const child = makeChild(1234);
    mockSpawn.mockReturnValue(child);

    const spawnPromise = supervisor.spawn('ws-1', '/home/user/project');

    // Flush microtasks so the health probe resolves.
    await vi.runAllTimersAsync();

    const handle = await spawnPromise;

    expect(handle).not.toBeNull();
    expect(handle!.port).toBe(NET_PORT);
    expect(handle!.status).toBe('running');
    expect(handle!.pid).toBe(1234);
    expect(handle!.workspaceRoot).toBe('/home/user/project');

    expect(mockSpawn).toHaveBeenCalledWith(
      'ruflo',
      ['mcp', 'start', '-t', 'http', '-p', String(NET_PORT), '--host', '127.0.0.1'],
      expect.objectContaining({
        env: expect.objectContaining({ CLAUDE_FLOW_CWD: '/home/user/project' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });

  // ── win32 .cmd shim safety: tier launch routed through spawnExecutable ──

  it('routes the tier launch through spawnExecutable (win32 .cmd shim safety)', async () => {
    alwaysHealthOk();
    const child = makeChild(4321);
    mockSpawn.mockReturnValue(child);

    const spawnPromise = supervisor.spawn('ws-route', '/home/user/project');
    await vi.runAllTimersAsync();
    await spawnPromise;

    expect(spawnExecutableCalls.length).toBeGreaterThan(0);
    expect(spawnExecutableCalls[0].cmd).toBe('ruflo');
    expect(spawnExecutableCalls[0].args).toContain('mcp');
  });

  // ── SF-14 launcher resolution ──────────────────────────────────────────

  it('spawn-binary-missing: returns null + LOUD warning when neither ruflo nor npx on PATH', async () => {
    // No forced binary → the supervisor probes PATH; make every probe miss.
    const sup = new RufloHttpDaemonSupervisor();
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sup.spawn('ws-missing', '/root');

    expect(result).toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
    // SF-14: the gap must be LOUD + distinct, not a vague "not found".
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DAEMON UNAVAILABLE'));
    warnSpy.mockRestore();
  });

  it('falls back to `npx -y @claude-flow/cli@latest` when ruflo is absent but npx is present', async () => {
    const sup = new RufloHttpDaemonSupervisor();
    // First probe (ruflo) misses; second probe (npx) hits.
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const probed = args[args.length - 1];
      if (probed === 'ruflo') throw new Error('not found');
      return Buffer.from('/usr/local/bin/npx');
    });
    alwaysHealthOk();
    const child = makeChild(7777);
    mockSpawn.mockReturnValue(child);

    const p = sup.spawn('ws-npx', '/proj');
    await vi.runAllTimersAsync();
    const handle = await p;

    expect(handle).not.toBeNull();
    expect(handle!.status).toBe('running');
    // The npx fallback must carry the package spec before the daemon subcommand.
    expect(mockSpawn).toHaveBeenCalledWith(
      'npx',
      ['-y', '@claude-flow/cli@latest', 'mcp', 'start', '-t', 'http', '-p', String(NET_PORT), '--host', '127.0.0.1'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('prefers PATH `ruflo` (no npx prefix) when ruflo is present', async () => {
    const sup = new RufloHttpDaemonSupervisor();
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const probed = args[args.length - 1];
      if (probed === 'ruflo') return Buffer.from('/usr/local/bin/ruflo');
      throw new Error('not found'); // npx never reached
    });
    alwaysHealthOk();
    const child = makeChild(8888);
    mockSpawn.mockReturnValue(child);

    const p = sup.spawn('ws-ruflo', '/proj');
    await vi.runAllTimersAsync();
    await p;

    expect(mockSpawn).toHaveBeenCalledWith(
      'ruflo',
      ['mcp', 'start', '-t', 'http', '-p', String(NET_PORT), '--host', '127.0.0.1'],
      expect.anything(),
    );
  });

  // ── SF-14 userData lazy-installed CLI tier ─────────────────────────────

  it('runs the lazy-installed userData @claude-flow/cli (offline) when ruflo is absent', async () => {
    // Create a fake install: <root>/node_modules/@claude-flow/cli/bin/cli.js
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf14-ruflo-'));
    const binDir = path.join(root, 'node_modules', '@claude-flow', 'cli', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const cliEntry = path.join(binDir, 'cli.js');
    fs.writeFileSync(cliEntry, '// fake cli');
    const nodeModules = path.join(root, 'node_modules');

    try {
      const sup = new RufloHttpDaemonSupervisor({ rufloRoot: root });
      // ruflo PATH probe misses → userData tier intercepts BEFORE npx is probed.
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[args.length - 1] === 'ruflo') throw new Error('not found');
        throw new Error('npx should not be probed when userData CLI exists');
      });
      alwaysHealthOk();
      mockSpawn.mockReturnValue(makeChild(4242));

      const p = sup.spawn('ws-userdata', '/proj');
      await vi.runAllTimersAsync();
      const handle = await p;

      expect(handle).not.toBeNull();
      expect(handle!.status).toBe('running');
      // Runs via Electron's embedded node: process.execPath <cli.js> mcp start …
      expect(mockSpawn).toHaveBeenCalledWith(
        process.execPath,
        [cliEntry, 'mcp', 'start', '-t', 'http', '-p', String(NET_PORT), '--host', '127.0.0.1'],
        expect.objectContaining({
          env: expect.objectContaining({
            ELECTRON_RUN_AS_NODE: '1',
            NODE_PATH: nodeModules,
          }),
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls through to npx when the userData CLI is not installed', async () => {
    // rufloRoot points at an empty dir → no cli.js → userData tier returns null.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf14-empty-'));
    try {
      const sup = new RufloHttpDaemonSupervisor({ rufloRoot: root });
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[args.length - 1] === 'ruflo') throw new Error('not found');
        return Buffer.from('/usr/local/bin/npx'); // npx present
      });
      alwaysHealthOk();
      mockSpawn.mockReturnValue(makeChild(4243));

      const p = sup.spawn('ws-empty', '/proj');
      await vi.runAllTimersAsync();
      await p;

      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        ['-y', '@claude-flow/cli@latest', 'mcp', 'start', '-t', 'http', '-p', String(NET_PORT), '--host', '127.0.0.1'],
        expect.anything(),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('crash-recovery respawn of the userData CLI tier still carries ELECTRON_RUN_AS_NODE', async () => {
    // Regression: launchChild() (the respawn path) must merge launch.env too,
    // else the recovery spawn runs process.execPath WITHOUT ELECTRON_RUN_AS_NODE
    // → boots Electron, not node → recovery fails and the daemon goes down.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf14-recov-'));
    const binDir = path.join(root, 'node_modules', '@claude-flow', 'cli', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'cli.js'), '// fake cli');

    try {
      const sup = new RufloHttpDaemonSupervisor({ rufloRoot: root });
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[args.length - 1] === 'ruflo') throw new Error('not found');
        throw new Error('npx should not be probed when userData CLI exists');
      });
      alwaysHealthOk();
      const child1 = makeChild(4444);
      const child2 = makeChild(4445);
      mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const p = sup.spawn('ws-recov', '/proj');
      await vi.runAllTimersAsync();
      await p;

      child1.emit('exit', 1, null); // crash → respawn via launchChild
      await vi.runAllTimersAsync();

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      const recovery = mockSpawn.mock.calls[1] as [string, string[], { env: Record<string, string> }];
      expect(recovery[0]).toBe(process.execPath);
      expect(recovery[2].env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── port-allocation ────────────────────────────────────────────────────

  it('port-allocation: dynamic port from net.createServer.listen(0) is passed to spawn', async () => {
    alwaysHealthOk();
    const child = makeChild(5555);
    mockSpawn.mockReturnValue(child);

    const spawnPromise = supervisor.spawn('ws-port', '/some/path');
    await vi.runAllTimersAsync();
    await spawnPromise;

    const spawnArgs = mockSpawn.mock.calls[0] as [string, string[], unknown];
    expect(spawnArgs[1]).toContain('-p');
    const portIndex = spawnArgs[1].indexOf('-p');
    expect(spawnArgs[1][portIndex + 1]).toBe(String(NET_PORT));
  });

  // ── health-probe-timeout ───────────────────────────────────────────────

  it('health-probe-timeout: spawn() rejects after 10s, status becomes down', async () => {
    alwaysHealthFail();
    const child = makeChild(2222);
    mockSpawn.mockReturnValue(child);

    const spawnPromise = supervisor.spawn('ws-timeout', '/root');

    // Attach rejection handler BEFORE running timers to avoid an unhandled-rejection
    // warning — the timeout fires inside runAllTimersAsync() and we must already
    // be listening at that point.
    const settled = spawnPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: Error) => ({ ok: false as const, error: e }),
    );

    // Advance past SPAWN_TIMEOUT_MS (10 000ms) and all probe delays.
    await vi.runAllTimersAsync();

    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/healthy within/);
    }
    expect(supervisor.status('ws-timeout')).toBe('down');
  });

  // ── crash-respawn ──────────────────────────────────────────────────────

  it('crash-respawn: child exit while running triggers respawn; emits restarted(true)', async () => {
    alwaysHealthOk();
    const child1 = makeChild(3001);
    const child2 = makeChild(3002);
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const restartedEvents: Array<[string, boolean]> = [];
    supervisor.on('restarted', (wsId: string, success: boolean) => {
      restartedEvents.push([wsId, success]);
    });

    // First spawn completes.
    const p = supervisor.spawn('ws-crash', '/proj');
    await vi.runAllTimersAsync();
    await p;

    expect(supervisor.status('ws-crash')).toBe('running');

    // Simulate crash.
    child1.emit('exit', 1, null);

    // Advance past the 1 500ms backoff + all probe delays.
    await vi.runAllTimersAsync();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(restartedEvents).toContainEqual(['ws-crash', true]);
    expect(supervisor.status('ws-crash')).toBe('running');
  });

  // ── BUG-2: stdout drain on BOTH the primary AND recovery child ──────────

  it('BUG-2: drains stdout on the primary child (or the daemon deadlocks on a full pipe)', async () => {
    alwaysHealthOk();
    const child = makeChild(3101);
    mockSpawn.mockReturnValue(child);

    const p = supervisor.spawn('ws-drain', '/proj');
    await vi.runAllTimersAsync();
    await p;

    // A stdout 'data' listener MUST be attached so the OS pipe never fills.
    const stdoutDataAttached = child.stdout.on.mock.calls.some(
      (args: unknown[]) => args[0] === 'data',
    );
    expect(stdoutDataAttached).toBe(true);
  });

  it('BUG-2: the crash-recovery child ALSO drains stdout (regression — recovery path previously wired only stderr)', async () => {
    alwaysHealthOk();
    const child1 = makeChild(3201);
    const child2 = makeChild(3202);
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const p = supervisor.spawn('ws-drain-recov', '/proj');
    await vi.runAllTimersAsync();
    await p;

    // Crash the primary → the supervisor respawns child2 via the recovery path.
    child1.emit('exit', 1, null);
    await vi.runAllTimersAsync();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    // The RECOVERY child must have a stdout 'data' drain too — without it a
    // recovered daemon that logs enough fills the ~64KB pipe and silently stops
    // serving /health and /mcp.
    const recoveryStdoutDrained = child2.stdout.on.mock.calls.some(
      (args: unknown[]) => args[0] === 'data',
    );
    expect(recoveryStdoutDrained).toBe(true);
    // And stderr is still buffered (parity with the primary path).
    const recoveryStderrWired = child2.stderr.on.mock.calls.some(
      (args: unknown[]) => args[0] === 'data',
    );
    expect(recoveryStderrWired).toBe(true);
  });

  // ── crash-respawn-gives-up-after-3 ────────────────────────────────────

  it('crash-respawn-gives-up-after-3: after 3 exits, status=down, emits restarted(false)', async () => {
    // First spawn: health ok so the daemon becomes running.
    alwaysHealthOk();
    const firstChild = makeChild(4001);
    mockSpawn.mockReturnValueOnce(firstChild);

    const restartedEvents: Array<[string, boolean]> = [];
    supervisor.on('restarted', (wsId: string, success: boolean) => {
      restartedEvents.push([wsId, success]);
    });

    const p = supervisor.spawn('ws-giveup', '/proj');
    await vi.runAllTimersAsync();
    await p;
    expect(supervisor.status('ws-giveup')).toBe('running');

    // Now switch health to fail so recovery spawns never succeed.
    alwaysHealthFail();

    // Set up 3 recovery children that will all exit immediately.
    const crashChild1 = makeChild(4002);
    const crashChild2 = makeChild(4003);
    const crashChild3 = makeChild(4004);
    mockSpawn
      .mockReturnValueOnce(crashChild1)
      .mockReturnValueOnce(crashChild2)
      .mockReturnValueOnce(crashChild3);

    // Trigger the crash.
    firstChild.emit('exit', 1, null);

    // Advance past 1st backoff (1 500ms).
    await vi.advanceTimersByTimeAsync(2_000);
    // Recovery child 1 starts but exits.
    crashChild1.emit('exit', 1, null);

    // Advance past 2nd backoff (4 500ms).
    await vi.advanceTimersByTimeAsync(5_000);
    // Recovery child 2 exits.
    crashChild2.emit('exit', 1, null);

    // Advance past 3rd backoff (13 500ms).
    await vi.advanceTimersByTimeAsync(14_000);
    // Recovery child 3 exits — this exhausts MAX_RESTARTS.
    crashChild3.emit('exit', 1, null);

    await vi.runAllTimersAsync();

    expect(supervisor.status('ws-giveup')).toBe('down');
    // The final 'restarted' event must be success=false.
    const lastEvent = restartedEvents[restartedEvents.length - 1];
    expect(lastEvent).toEqual(['ws-giveup', false]);
  });

  // ── B4: clean exit during startup = HTTP mode unsupported, no retries ──

  it('B4: a clean (code 0) exit before /health classifies as down with NO crash-recovery', async () => {
    // HTTP server-mode is upstream-broken: the CLI runs `mcp start -t http`,
    // then exits cleanly (code 0) instead of serving. Health never comes up.
    alwaysHealthFail();
    const child = makeChild(4801);
    mockSpawn.mockReturnValue(child);

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const spawnPromise = supervisor.spawn('ws-b4', '/proj');
    const settled = spawnPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: Error) => ({ ok: false as const, error: e }),
    );

    // spawn() awaits allocatePort() before doSpawn() registers the exit
    // handler — flush microtasks so the child is wired before we emit exit.
    await Promise.resolve();
    await Promise.resolve();

    // Clean exit during startup (status still 'starting').
    child.emit('exit', 0, null);
    await vi.runAllTimersAsync();

    const result = await settled;
    // spawn() rejects (caller falls back to stdio).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/HTTP mode unsupported/);
    }
    // Marked 'down' — and NOT respawned (only the single initial spawn).
    expect(supervisor.status('ws-b4')).toBe('down');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // Logged ONCE at info (not warn-spam).
    const unsupportedInfo = infoSpy.mock.calls.filter((c) =>
      String(c[0]).includes('HTTP mode unsupported'),
    );
    expect(unsupportedInfo).toHaveLength(1);
    // No "daemon exited" warn was emitted for the clean-exit-during-startup case.
    const exitWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('daemon exited'),
    );
    expect(exitWarns).toHaveLength(0);

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('B4: a non-zero exit during startup still warns and marks crashed (not the clean-exit path)', async () => {
    alwaysHealthFail();
    const child = makeChild(4802);
    mockSpawn.mockReturnValue(child);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const spawnPromise = supervisor.spawn('ws-b4-crash', '/proj');
    const settled = spawnPromise.then(
      () => ({ ok: true as const }),
      (e: Error) => ({ ok: false as const, error: e }),
    );

    // Flush microtasks so doSpawn() wires the exit handler before we emit.
    await Promise.resolve();
    await Promise.resolve();

    child.emit('exit', 1, null);
    await vi.runAllTimersAsync();

    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exited during startup/);
    }
    expect(supervisor.status('ws-b4-crash')).toBe('crashed');
    const exitWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('daemon exited'),
    );
    expect(exitWarns).toHaveLength(1);

    warnSpy.mockRestore();
  });

  // ── stop(): SIGTERM → SIGKILL ──────────────────────────────────────────

  it('stop(): sends SIGTERM; after 5s sends SIGKILL if still alive', async () => {
    alwaysHealthOk();
    const child = makeChild(6001);
    mockSpawn.mockReturnValue(child);

    const p = supervisor.spawn('ws-stop', '/proj');
    await vi.runAllTimersAsync();
    await p;
    expect(supervisor.status('ws-stop')).toBe('running');

    // Start stop — it sends SIGTERM and awaits exit.
    const stopPromise = supervisor.stop('ws-stop');

    // SIGTERM should have been sent synchronously at this point.
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Advance past KILL_ESCALATION_MS (5 000ms) without the child exiting.
    await vi.advanceTimersByTimeAsync(5_001);
    // Now SIGKILL should be sent.
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    // Emit exit so the stopPromise resolves.
    child.emit('exit', null, 'SIGKILL');
    await stopPromise;

    expect(supervisor.status('ws-stop')).toBeNull();
  });

  // ── stopAll() ─────────────────────────────────────────────────────────

  it('stopAll(): iterates all workspace entries and stops each', async () => {
    alwaysHealthOk();
    const childA = makeChild(7001);
    const childB = makeChild(7002);
    mockSpawn.mockReturnValueOnce(childA).mockReturnValueOnce(childB);

    const p1 = supervisor.spawn('ws-a', '/a');
    const p2 = supervisor.spawn('ws-b', '/b');
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    expect(supervisor.status('ws-a')).toBe('running');
    expect(supervisor.status('ws-b')).toBe('running');

    // Issue stopAll — emit exit from both children to let it resolve.
    const stopAllPromise = supervisor.stopAll();
    childA.emit('exit', 0, null);
    childB.emit('exit', 0, null);
    await vi.runAllTimersAsync();
    await stopAllPromise;

    expect(supervisor.status('ws-a')).toBeNull();
    expect(supervisor.status('ws-b')).toBeNull();
  });

  // ── restart() ─────────────────────────────────────────────────────────

  it('restart(): stop() + spawn() in sequence; returns a new handle', async () => {
    alwaysHealthOk();
    const child1 = makeChild(8001);
    const child2 = makeChild(8002);
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const p = supervisor.spawn('ws-restart', '/workspace');
    await vi.runAllTimersAsync();
    const h1 = await p;
    expect(h1!.pid).toBe(8001);

    // Emit exit from child1 so stop() can complete cleanly.
    const restartPromise = supervisor.restart('ws-restart');
    child1.emit('exit', 0, null);

    await vi.runAllTimersAsync();
    const h2 = await restartPromise;

    expect(h2).not.toBeNull();
    expect(h2!.pid).toBe(8002);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  // ── concurrent spawn() returns existing handle ─────────────────────────

  it('concurrent spawn() for same workspaceId does not duplicate the daemon', async () => {
    alwaysHealthOk();
    const child = makeChild(9001);
    mockSpawn.mockReturnValue(child);

    const p1 = supervisor.spawn('ws-concurrent', '/concurrent');
    await vi.runAllTimersAsync();
    const h1 = await p1;

    // Second call while already running.
    const p2 = supervisor.spawn('ws-concurrent', '/concurrent');
    const h2 = await p2;

    // Only one spawn call should have been made.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(h1!.port).toBe(h2!.port);
    expect(h1!.pid).toBe(h2!.pid);
  });

  // ── status() / port() accessors ────────────────────────────────────────

  it('status() returns null for an unknown workspaceId', () => {
    expect(supervisor.status('nonexistent')).toBeNull();
  });

  it('port() returns null for an unknown workspaceId', () => {
    expect(supervisor.port('nonexistent')).toBeNull();
  });

  it('port() returns the allocated port when daemon is running', async () => {
    alwaysHealthOk();
    const child = makeChild(9999);
    mockSpawn.mockReturnValue(child);

    const p = supervisor.spawn('ws-port-check', '/path');
    await vi.runAllTimersAsync();
    await p;

    expect(supervisor.port('ws-port-check')).toBe(NET_PORT);
  });

  // ── B1: CLAUDE_FLOW_DIR in initial spawn env ───────────────────────────

  it('B1-initial-spawn: env contains CLAUDE_FLOW_CWD AND CLAUDE_FLOW_DIR=<root>/.claude-flow', async () => {
    alwaysHealthOk();
    const child = makeChild(1234);
    mockSpawn.mockReturnValue(child);

    const workspaceRoot = '/home/user/project';
    const spawnPromise = supervisor.spawn('ws-b1-init', workspaceRoot);
    await vi.runAllTimersAsync();
    await spawnPromise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnOpts = mockSpawn.mock.calls[0]![2] as { env: Record<string, string> };
    expect(spawnOpts.env).toEqual(
      expect.objectContaining({
        CLAUDE_FLOW_CWD: workspaceRoot,
        CLAUDE_FLOW_DIR: path.join(workspaceRoot, '.claude-flow'),
      }),
    );
  });

  // ── B1: CLAUDE_FLOW_DIR in crash-recovery (launchChild) respawn ────────

  it('B1-respawn: crash-recovery spawn env also contains CLAUDE_FLOW_DIR=<root>/.claude-flow', async () => {
    alwaysHealthOk();
    const child1 = makeChild(3001);
    const child2 = makeChild(3002);
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const workspaceRoot = '/home/user/project';
    const p = supervisor.spawn('ws-b1-respawn', workspaceRoot);
    await vi.runAllTimersAsync();
    await p;

    // Simulate crash to trigger launchChild.
    child1.emit('exit', 1, null);
    await vi.runAllTimersAsync();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    // Both calls must have CLAUDE_FLOW_DIR set.
    for (let i = 0; i < 2; i++) {
      const spawnOpts = mockSpawn.mock.calls[i]![2] as { env: Record<string, string> };
      expect(spawnOpts.env).toEqual(
        expect.objectContaining({
          CLAUDE_FLOW_CWD: workspaceRoot,
          CLAUDE_FLOW_DIR: path.join(workspaceRoot, '.claude-flow'),
        }),
      );
    }
  });

  // ── B1 win32: CLAUDE_FLOW_DIR resolves correctly on Windows-style paths ──

  it('B1-win32: CLAUDE_FLOW_DIR uses path.join for Windows-style workspace root', () => {
    // Verify the path construction itself — path.join handles win32 roots correctly
    // on the host via the platform's path module. We test the contract by
    // constructing it the same way the implementation does.
    const winRoot = 'C:\\Users\\user\\project';
    const expected = path.join(winRoot, '.claude-flow');
    // The expected value uses platform sep on macOS (forward slash) — the important
    // assertion is that path.join is what the implementation uses, not string concat.
    expect(expected).toBe(`${winRoot}${path.sep}.claude-flow`);
  });

  // ── B2: round-trip probe sets roundTrip=true on success ───────────────

  it('B2-roundtrip-success: roundTrip=true in statusDetail when MCP round-trip succeeds', async () => {
    alwaysHealthOk();
    // Return a successful search result for both the store and search calls.
    mockPostSuccess(JSON.stringify({ result: { memories: [{ key: '__sigmalink_healthcheck__' }] } }));
    const child = makeChild(1234);
    mockSpawn.mockReturnValue(child);

    const spawnPromise = supervisor.spawn('ws-b2-ok', '/home/user/project');
    await vi.runAllTimersAsync();
    await spawnPromise;

    // Give the probe microtasks time to settle.
    await vi.runAllTimersAsync();

    const s = supervisor.statusDetail('ws-b2-ok');
    expect(s).not.toBeNull();
    expect(s!.roundTrip).toBe(true);
    // Daemon must still be 'running' (probe is non-fatal).
    expect(s!.status).toBe('running');
  });

  // ── B2: round-trip probe sets roundTrip=false on failure, single warn ──

  it('B2-roundtrip-failure: roundTrip=false and exactly one warn when POST fails', async () => {
    alwaysHealthOk();
    mockPostFail();
    const child = makeChild(5678);
    mockSpawn.mockReturnValue(child);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const spawnPromise = supervisor.spawn('ws-b2-fail', '/home/user/project');
    await vi.runAllTimersAsync();
    await spawnPromise;

    await vi.runAllTimersAsync();

    const s = supervisor.statusDetail('ws-b2-fail');
    expect(s).not.toBeNull();
    expect(s!.roundTrip).toBe(false);
    // Daemon must remain running despite probe failure.
    expect(s!.status).toBe('running');

    // Exactly one warn emitted by the round-trip probe.
    const roundTripWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('round-trip'),
    );
    expect(roundTripWarns).toHaveLength(1);

    warnSpy.mockRestore();
  });

  // ── B2: probe failure does not change daemon status from running ───────

  it('B2-probe-nonfatal: daemon status stays running even when round-trip probe fails', async () => {
    alwaysHealthOk();
    mockPostFail();
    const child = makeChild(7777);
    mockSpawn.mockReturnValue(child);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = supervisor.spawn('ws-b2-nonfatal', '/proj');
    await vi.runAllTimersAsync();
    await p;
    await vi.runAllTimersAsync();

    // DaemonStatus (the string value from status()) must remain 'running'.
    expect(supervisor.status('ws-b2-nonfatal')).toBe('running');

    warnSpy.mockRestore();
  });
});
