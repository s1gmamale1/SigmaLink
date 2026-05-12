// BUG-V1.1.3-ORCH-03 regression guards for `createStdinWriter`.
//
// The audit flagged the pre-fix queue as susceptible to permanent hangs: a CLI
// child that stops draining stdin would never invoke the write callback, the
// chained Promise would never settle, and the parent turn driver's
// `await stdinWriter.enqueue(...)` would block forever. The fix wraps every
// write in a timeout (default 30s, configurable) that rejects the Promise
// AND signals the caller via `onTimeout` so the hung child can be killed.
//
// These tests stub the `child.stdin` writable so we can deliberately withhold
// the callback (`drain` never fires) and verify the timeout path. We use
// `vi.useFakeTimers` so the test exits in milliseconds, not 30 seconds.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  createStdinWriter,
  STDIN_WRITE_TIMEOUT_MS,
} from './runClaudeCliTurn.emit';
import type { CliChildLike } from './runClaudeCliTurn';

/**
 * Build a fake child whose `stdin.write` honours a `drain` toggle. When the
 * toggle is `true` (the default), writes invoke their callback synchronously
 * with no error (mirroring a healthy CLI). When `false`, writes accept the
 * chunk but never invoke the callback — exactly the failure mode the audit
 * flagged.
 */
class HangableChild extends EventEmitter implements CliChildLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed = false;
  killSignal: NodeJS.Signals | number | null = null;
  /** Pending callbacks that the test can release manually. */
  pending: Array<(err?: Error | null) => void> = [];
  /** When `false`, writes never invoke their callback. */
  drainCallbacks = true;

  constructor() {
    super();
    this.stdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        if (this.drainCallbacks) {
          callback();
        } else {
          // Hold the callback — this is the hang.
          this.pending.push(callback);
        }
      },
    });
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal ?? 'SIGTERM';
    return true;
  }

  /** Manually invoke every held-back callback (simulates a recovered CLI). */
  releaseAll(): void {
    while (this.pending.length > 0) {
      const cb = this.pending.shift();
      try {
        cb?.(null);
      } catch {
        /* best-effort */
      }
    }
  }
}

describe('createStdinWriter (BUG-V1.1.3-ORCH-03 regression guards)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('happy path: write resolves when child.stdin.write callback fires', async () => {
    // Sanity check — the queue still works when the CLI is healthy.
    const child = new HangableChild();
    const writer = createStdinWriter(child, { timeoutMs: 1_000 });

    await expect(writer.enqueue('hello\n')).resolves.toBeUndefined();
  });

  it('rejects with stdin_write_timeout when the child never drains', async () => {
    // The headline scenario: child accepts the chunk but never invokes the
    // callback. Without the fix, this Promise would hang forever. With the
    // fix, it rejects with a clear error after `timeoutMs`.
    const child = new HangableChild();
    child.drainCallbacks = false;
    const writer = createStdinWriter(child, { timeoutMs: 30_000 });

    const pending = writer.enqueue('hello\n');
    // Attach a catch handler immediately so unhandledRejection doesn't fire
    // when the timeout settles before our `expect(...).rejects` await below.
    const failure = pending.catch((err: unknown) => err);

    // Nothing has settled yet — advance just under the threshold.
    await vi.advanceTimersByTimeAsync(29_999);
    // Trip the timeout.
    await vi.advanceTimersByTimeAsync(2);

    const err = await failure;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('stdin_write_timeout');
  });

  it('invokes onTimeout callback so caller can kill the hung child', async () => {
    const child = new HangableChild();
    child.drainCallbacks = false;

    const onTimeout = vi.fn();
    const writer = createStdinWriter(child, {
      timeoutMs: 5_000,
      onTimeout,
    });

    const pending = writer.enqueue('hello\n').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5_001);
    await pending;

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith('stdin_write_timeout');
  });

  it('default timeout is 30 seconds when no opts.timeoutMs is provided', async () => {
    // Pins the constant so a future tweak to the default surfaces in tests.
    expect(STDIN_WRITE_TIMEOUT_MS).toBe(30_000);

    const child = new HangableChild();
    child.drainCallbacks = false;
    const writer = createStdinWriter(child);

    const pending = writer.enqueue('hello\n').catch((err: unknown) => err);

    // Just before the 30s default — should still be pending.
    await vi.advanceTimersByTimeAsync(29_999);
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Trip the default.
    await vi.advanceTimersByTimeAsync(2);
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('stdin_write_timeout');
  });

  it('a timed-out write does not poison subsequent enqueues', async () => {
    // The chain catches its own rejections so the next enqueue can still try
    // to write. (Whether the caller wants to keep writing to a presumably
    // hung child is its own decision — see the onTimeout kill in
    // runClaudeCliTurn.ts.) We avoid Node's `Writable` here so the test stays
    // in JS-only territory (no nextTick/setImmediate dance) under fake timers.
    let drain = false;
    const stdinStub = {
      write: vi.fn((_chunk: string | Buffer, cb: (err?: Error | null) => void) => {
        if (drain) cb(null);
        // else: hold the callback — the timeout will fire.
        return true;
      }),
    } as unknown as NodeJS.WritableStream;
    const child: CliChildLike = {
      stdin: stdinStub,
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      on: () => undefined,
      kill: () => true,
    };

    const writer = createStdinWriter(child, { timeoutMs: 1_000 });

    const first = writer.enqueue('first\n').catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1_001);
    const firstErr = await first;
    expect(firstErr).toBeInstanceOf(Error);
    expect((firstErr as Error).message).toBe('stdin_write_timeout');

    // Flip the stub to drain immediately. The next enqueue should resolve
    // through the same chain (the prior `.catch(() => undefined)` link
    // swallows the rejection so the new write actually runs).
    drain = true;
    await expect(writer.enqueue('second\n')).resolves.toBeUndefined();
    // Both writes were observed by the underlying stream.
    expect(stdinStub.write).toHaveBeenCalledTimes(2);
  });

  it('synchronous throw from child.stdin.write is caught and rejected', async () => {
    // If the writable is destroyed mid-flight, `write()` throws synchronously.
    // The fix wraps the `child.stdin.write(...)` call in a try/catch so the
    // error surfaces as a rejection (rather than an unhandled exception that
    // crashes the queue's microtask).
    const child = new HangableChild();
    const throwingChild: CliChildLike = {
      ...child,
      stdin: {
        write: () => {
          throw new Error('stdin_destroyed');
        },
      } as unknown as NodeJS.WritableStream,
      on: child.on.bind(child),
      kill: child.kill.bind(child),
    };
    const writer = createStdinWriter(throwingChild, { timeoutMs: 1_000 });

    await expect(writer.enqueue('boom\n')).rejects.toThrow('stdin_destroyed');
  });
});
