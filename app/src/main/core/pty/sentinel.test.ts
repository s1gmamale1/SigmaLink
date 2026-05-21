// v1.6.0 Phase 2 — sentinel constants, detection regex, and extraction helper.

import { describe, it, expect } from 'vitest';
import {
  SENTINEL_PREFIX,
  SENTINEL_SUFFIX,
  SENTINEL_RE,
  containsSentinel,
  extractSentinel,
  buildSentinelSnippet,
} from './sentinel';

describe('sentinel constants', () => {
  it('SENTINEL_PREFIX is the expected string', () => {
    expect(SENTINEL_PREFIX).toBe('__SIGMALINK_CLI_EXIT_');
  });

  it('SENTINEL_SUFFIX is the expected string', () => {
    expect(SENTINEL_SUFFIX).toBe('__');
  });
});

describe('buildSentinelSnippet', () => {
  it('returns a string containing the sentinel prefix and suffix', () => {
    const snippet = buildSentinelSnippet();
    expect(snippet).toContain(SENTINEL_PREFIX);
    expect(snippet).toContain(SENTINEL_SUFFIX);
  });

  it('is a valid POSIX printf snippet', () => {
    const snippet = buildSentinelSnippet();
    // Must start with "; printf" so it can be appended to a command line
    expect(snippet.trimStart()).toMatch(/^; printf/);
  });

  it('uses $? so the shell substitutes the actual exit code', () => {
    const snippet = buildSentinelSnippet();
    expect(snippet).toContain('"$?"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// containsSentinel — fast no-allocation path
// ─────────────────────────────────────────────────────────────────────────────

describe('containsSentinel', () => {
  it('returns true for a chunk containing the sentinel (exit code 0)', () => {
    const data = `some output\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n`;
    expect(containsSentinel(data)).toBe(true);
  });

  it('returns true for a chunk containing the sentinel (non-zero exit code)', () => {
    const data = `\n${SENTINEL_PREFIX}127${SENTINEL_SUFFIX}\n`;
    expect(containsSentinel(data)).toBe(true);
  });

  it('returns false for normal PTY output without the sentinel', () => {
    expect(containsSentinel('hello world\r\n')).toBe(false);
    expect(containsSentinel('')).toBe(false);
    expect(containsSentinel('__SIGMALINK_OTHER__\n')).toBe(false);
  });

  it('is stateless across multiple calls (regex lastIndex resets)', () => {
    const data = `\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n`;
    expect(containsSentinel(data)).toBe(true);
    expect(containsSentinel(data)).toBe(true);
    expect(containsSentinel('no sentinel')).toBe(false);
    expect(containsSentinel(data)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSentinel — returns exit code + stripped data
// ─────────────────────────────────────────────────────────────────────────────

describe('extractSentinel', () => {
  it('returns null when no sentinel is present', () => {
    expect(extractSentinel('normal output\r\n')).toBeNull();
    expect(extractSentinel('')).toBeNull();
  });

  it('parses exit code 0 correctly', () => {
    const data = `CLI banner\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n% `;
    const result = extractSentinel(data);
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
  });

  it('parses non-zero exit code correctly', () => {
    const data = `error output\n${SENTINEL_PREFIX}42${SENTINEL_SUFFIX}\n`;
    const result = extractSentinel(data);
    expect(result!.exitCode).toBe(42);
  });

  it('parses exit code 127 (command not found)', () => {
    const data = `\n${SENTINEL_PREFIX}127${SENTINEL_SUFFIX}\n`;
    const result = extractSentinel(data);
    expect(result!.exitCode).toBe(127);
  });

  it('strips the sentinel line from the returned data', () => {
    const data = `CLI output line\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n% `;
    const result = extractSentinel(data);
    expect(result!.strippedData).not.toContain(SENTINEL_PREFIX);
    expect(result!.strippedData).not.toContain(SENTINEL_SUFFIX);
  });

  it('preserves content before and after the sentinel', () => {
    const data = `before output\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\nafter output`;
    const result = extractSentinel(data);
    expect(result!.strippedData).toContain('before output');
    expect(result!.strippedData).toContain('after output');
  });

  it('handles CRLF line endings from PTY normalisation', () => {
    const data = `output\r\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\r\nshell prompt`;
    const result = extractSentinel(data);
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(result!.strippedData).not.toContain(SENTINEL_PREFIX);
  });

  it('is stateless across multiple calls', () => {
    const data = `\n${SENTINEL_PREFIX}5${SENTINEL_SUFFIX}\n`;
    const r1 = extractSentinel(data);
    const r2 = extractSentinel(data);
    expect(r1!.exitCode).toBe(5);
    expect(r2!.exitCode).toBe(5);
  });

  it('the SENTINEL_RE lastIndex resets before each extractSentinel call', () => {
    const data = `\n${SENTINEL_PREFIX}1${SENTINEL_SUFFIX}\n`;
    // Call multiple times without resetting externally.
    for (let i = 0; i < 5; i++) {
      const r = extractSentinel(data);
      expect(r).not.toBeNull();
      expect(r!.exitCode).toBe(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: buildSentinelSnippet → sentinel appears in shell output
// ─────────────────────────────────────────────────────────────────────────────

describe('sentinel round-trip', () => {
  it('the format emitted by the snippet matches SENTINEL_RE', () => {
    // Simulate what the shell would print when the printf snippet executes
    // with exit code 0:  \n__SIGMALINK_CLI_EXIT_0__\n
    const simulatedShellOutput = `\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n`;
    SENTINEL_RE.lastIndex = 0;
    expect(SENTINEL_RE.test(simulatedShellOutput)).toBe(true);
  });

  it('non-zero exit codes in shell output match the regex', () => {
    const outputs = [1, 2, 100, 127, 255].map(
      (code) => `\n${SENTINEL_PREFIX}${code}${SENTINEL_SUFFIX}\n`,
    );
    for (const out of outputs) {
      SENTINEL_RE.lastIndex = 0;
      expect(SENTINEL_RE.test(out)).toBe(true);
    }
  });
});
