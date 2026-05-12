// Coverage for Fix 3 — execCmd must kill the child process when its combined
// stdout/stderr exceeds maxBuffer. Previously, output past the limit was
// silently discarded but the child continued running, leaking the process.

import { describe, it, expect } from 'vitest';

import { execCmd } from './exec';

const isWin = process.platform === 'win32';

describe('execCmd maxBuffer enforcement', () => {
  it('returns maxBufferExceeded=true and terminates an overflowing child', async () => {
    if (isWin) return; // POSIX-only: relies on /bin/sh and yes/dd semantics.

    const before = Date.now();
    // Use a POSIX one-liner that streams an unbounded number of bytes
    // (`yes` repeats indefinitely). With maxBuffer set very small, the
    // overflow path must trigger and kill the child quickly.
    const res = await execCmd('sh', ['-c', 'yes overflow'], {
      maxBuffer: 256,
      timeoutMs: 30_000,
    });
    const elapsed = Date.now() - before;

    expect(res.maxBufferExceeded).toBe(true);
    // The child should be killed within the SIGTERM + 5s SIGKILL window,
    // far short of the 30s timeoutMs. A generous 10s ceiling keeps the test
    // robust on slow CI runners while still proving the kill happened.
    expect(elapsed).toBeLessThan(10_000);
    // Stdout/stderr are truncated at the cutoff but still contain the
    // pre-overflow prefix.
    expect(res.stdout.length).toBeLessThanOrEqual(1024);
  }, 30_000);

  it('does NOT flag maxBufferExceeded for short-lived commands under the limit', async () => {
    if (isWin) return;
    const res = await execCmd('sh', ['-c', 'echo hello'], {
      maxBuffer: 1024,
      timeoutMs: 5_000,
    });
    expect(res.maxBufferExceeded).toBe(false);
    expect(res.stdout.trim()).toBe('hello');
    expect(res.code).toBe(0);
  });

  it('preserves the existing timedOut field semantics', async () => {
    if (isWin) return;
    const res = await execCmd('sh', ['-c', 'sleep 5'], {
      timeoutMs: 200,
    });
    expect(res.timedOut).toBe(true);
    expect(res.maxBufferExceeded).toBe(false);
  }, 10_000);
});
