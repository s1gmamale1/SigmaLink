import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendDiagnostic,
  formatError,
  attachRendererLogCapture,
  isCrashGoneReason,
} from './diagnostics-log.ts';

const tmpDirs: string[] = [];
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-diag-'));
  tmpDirs.push(dir);
  return path.join(dir, 'nested', 'diagnostics.log');
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('appendDiagnostic', () => {
  it('creates parent dirs and appends a line', () => {
    const f = tmpFile();
    appendDiagnostic(f, 'first');
    appendDiagnostic(f, 'second');
    expect(fs.readFileSync(f, 'utf8')).toBe('first\nsecond\n');
  });

  it('trims the file when it exceeds the cap', () => {
    const f = tmpFile();
    const big = 'x'.repeat(300 * 1024);
    appendDiagnostic(f, big);
    expect(fs.statSync(f).size).toBeLessThanOrEqual(256 * 1024);
  });

  it('never throws on a bad path', () => {
    expect(() => appendDiagnostic('/this/does/not/exist/\0/bad', 'x')).not.toThrow();
  });
});

describe('formatError', () => {
  it('formats a kind, message and stack with a timestamp', () => {
    const out = formatError('uncaughtException', new Error('boom'), '2026-06-16T00:00:00.000Z');
    expect(out).toContain('[2026-06-16T00:00:00.000Z] uncaughtException: boom');
    expect(out).toContain('Error: boom');
  });
  it('coerces non-Error reasons', () => {
    expect(formatError('unhandledRejection', 'plain', '2026-06-16T00:00:00.000Z')).toContain(
      'unhandledRejection: plain',
    );
  });
});

describe('isCrashGoneReason', () => {
  it('returns true for genuine crash reasons', () => {
    for (const r of ['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit']) {
      expect(isCrashGoneReason(r)).toBe(true);
    }
  });
  it('returns false for benign teardown reasons (normal close / GPU recycle)', () => {
    for (const r of ['clean-exit', 'killed', 'normal-termination', '']) {
      expect(isCrashGoneReason(r)).toBe(false);
    }
  });
});

describe('attachRendererLogCapture', () => {
  function fakeWc() {
    let cb: ((e: unknown, level: number, message: string) => void) | null = null;
    return {
      on: (_evt: string, fn: (e: unknown, level: number, message: string) => void) => {
        cb = fn;
      },
      emit: (level: number, message: string) => cb?.({}, level, message),
    };
  }

  it('captures error-level and [ErrorBoundary] messages, ignores chatter', () => {
    const f = tmpFile();
    const wc = fakeWc();
    attachRendererLogCapture(wc as never, f);
    wc.emit(1, 'just an info log'); // ignored (info)
    wc.emit(2, 'a dev warning'); // ignored (warning — React dev noise)
    wc.emit(3, 'a real error'); // captured (level >= 3)
    wc.emit(0, '[ErrorBoundary] room Error: boom at PaneShell'); // captured (marker)
    const out = fs.readFileSync(f, 'utf8');
    expect(out).not.toContain('just an info log');
    expect(out).not.toContain('a dev warning');
    expect(out).toContain('a real error');
    expect(out).toContain('[ErrorBoundary] room');
  });
});
