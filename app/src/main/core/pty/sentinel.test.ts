// v1.6.0 Phase 2/5 — sentinel constants, detection regex, and extraction helper.
// Phase 5 additions: win32 per-shell sentinel snippets (PowerShell + cmd.exe).
// These tests run on any platform (pure logic, no win32 host required).

import { describe, it, expect } from 'vitest';
import {
  SENTINEL_PREFIX,
  SENTINEL_SUFFIX,
  SENTINEL_RE,
  containsSentinel,
  extractSentinel,
  buildSentinelSnippet,
  buildPowerShellSentinelSnippet,
  buildCmdSentinelSnippet,
  sliceSentinelCarry,
  SENTINEL_CARRY_MAX,
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

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 5 — win32 PowerShell sentinel snippet
//
// NOTE: win32 e2e verification requires a Windows host. These tests cover
// the pure logic (snippet format, marker presence, regex match) and are
// runnable on any platform (macOS CI included).
// pending-Windows-dogfood: full PTY integration test runs on a Windows host.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPowerShellSentinelSnippet (Phase 5 — win32 pwsh)', () => {
  it('contains the sentinel prefix and suffix', () => {
    const snippet = buildPowerShellSentinelSnippet();
    expect(snippet).toContain(SENTINEL_PREFIX);
    expect(snippet).toContain(SENTINEL_SUFFIX);
  });

  it('starts with "; Write-Host" so it can be appended to a command line', () => {
    const snippet = buildPowerShellSentinelSnippet();
    expect(snippet.trimStart()).toMatch(/^; Write-Host/);
  });

  it('uses $LASTEXITCODE so PowerShell substitutes the actual exit code', () => {
    const snippet = buildPowerShellSentinelSnippet();
    expect(snippet).toContain('$LASTEXITCODE');
  });

  it('includes a backtick-n newline escape for the leading newline', () => {
    const snippet = buildPowerShellSentinelSnippet();
    // PowerShell uses `n inside double-quoted strings for newline
    expect(snippet).toContain('`n');
  });
});

describe('buildPowerShellSentinelSnippet round-trip (Phase 5)', () => {
  it('simulated PowerShell output (exit 0) matches SENTINEL_RE', () => {
    // PowerShell would expand: Write-Host "`n__SIGMALINK_CLI_EXIT_0__"
    // producing: \n__SIGMALINK_CLI_EXIT_0__ (with a real newline before)
    const simulatedOutput = `\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\n`;
    SENTINEL_RE.lastIndex = 0;
    expect(SENTINEL_RE.test(simulatedOutput)).toBe(true);
  });

  it('simulated PowerShell output (exit 127) is extracted correctly', () => {
    const simulatedOutput = `CLI output\n${SENTINEL_PREFIX}127${SENTINEL_SUFFIX}\nPS C:\\> `;
    const result = extractSentinel(simulatedOutput);
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(127);
    expect(result!.strippedData).not.toContain(SENTINEL_PREFIX);
    expect(result!.strippedData).toContain('CLI output');
  });

  it('CRLF line endings (Windows PTY normalisation) are recognised', () => {
    const simulatedOutput = `CLI output\r\n${SENTINEL_PREFIX}1${SENTINEL_SUFFIX}\r\nPS C:\\> `;
    SENTINEL_RE.lastIndex = 0;
    expect(SENTINEL_RE.test(simulatedOutput)).toBe(true);
    const result = extractSentinel(simulatedOutput);
    expect(result!.exitCode).toBe(1);
    expect(result!.strippedData).not.toContain(SENTINEL_PREFIX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-03 audit A1 — win32 cmd.exe sentinel, conditional-echo form.
//
// The old SET-capture form could never work: cmd expands %VAR% at PARSE time
// for the whole `&`-chained interactive line, so SET captured the pre-line
// ERRORLEVEL and the echo expanded __SL_EC before SET ran. The fixed snippet
// uses `&& … || …` conditional echoes — no variable expansion anywhere, at the
// documented cost of collapsing non-zero exit codes to 1.
//
// NOTE: pending-Windows-dogfood for PTY e2e. Unit-only on macOS.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCmdSentinelSnippet (audit A1 — conditional-echo)', () => {
  it('contains no cmd variable-expansion tokens at all', () => {
    const snippet = buildCmdSentinelSnippet();
    expect(snippet).not.toContain('%');
    expect(snippet).not.toContain('!');
  });

  it('is exactly the conditional-echo pair (success 0 via &&, failure 1 via ||)', () => {
    expect(buildCmdSentinelSnippet()).toBe(
      ` && (echo. & echo ${SENTINEL_PREFIX}0${SENTINEL_SUFFIX})` +
        ` || (echo. & echo ${SENTINEL_PREFIX}1${SENTINEL_SUFFIX})`,
    );
  });
});

describe('buildCmdSentinelSnippet round-trip (audit A1)', () => {
  // `echo X` prints X verbatim and `echo.` prints a blank line; because the
  // snippet contains no % or ! tokens, cmd performs NO expansion on it — this
  // simulation is faithful to real cmd semantics (unlike the old tests, which
  // hand-simulated output the buggy SET-capture snippet could never produce).
  it('success-path output matches SENTINEL_RE with code 0', () => {
    const out = `CLI output\r\n\r\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\r\nC:\\> `;
    const result = extractSentinel(out);
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(result!.strippedData).not.toContain(SENTINEL_PREFIX);
  });

  it('failure-path output matches SENTINEL_RE with code 1', () => {
    const out = `\r\n${SENTINEL_PREFIX}1${SENTINEL_SUFFIX}\r\n`;
    const result = extractSentinel(out);
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(1);
  });

  it('CRLF line endings from ConPTY are recognised (regex-level, any code)', () => {
    const simulatedOutput = `CLI output\r\n${SENTINEL_PREFIX}42${SENTINEL_SUFFIX}\r\nC:\\> `;
    SENTINEL_RE.lastIndex = 0;
    expect(SENTINEL_RE.test(simulatedOutput)).toBe(true);
    const result = extractSentinel(simulatedOutput);
    expect(result!.exitCode).toBe(42);
  });
});

// ── 2026-06-10 audit finding 4: cross-chunk sentinel carry helper ──────────
describe('sliceSentinelCarry', () => {
  it('keeps the tail from the last newline when a partial sentinel may be in flight', () => {
    expect(sliceSentinelCarry('CLI output\n__SIGMALINK_CLI_EX')).toBe('\n__SIGMALINK_CLI_EX');
  });

  it('keeps just the newline when the chunk ends at a line boundary', () => {
    expect(sliceSentinelCarry('CLI output\n')).toBe('\n');
  });

  it('drops the carry when the in-flight line is longer than any sentinel (cap)', () => {
    expect(sliceSentinelCarry('start\n' + 'x'.repeat(SENTINEL_CARRY_MAX + 16))).toBe('');
  });

  it('returns empty when there is no newline at all (no anchor → no fabricated line start)', () => {
    expect(sliceSentinelCarry('x'.repeat(20))).toBe('');
  });

  it('never fabricates a line-start anchor: carry + next chunk only matches via a REAL stream newline', () => {
    // The carry always begins with the stream's own '\n', so prepending it to
    // the next chunk reproduces the genuine line boundary.
    const carry = sliceSentinelCarry('output\n__SIGMALINK_CLI_EXIT_');
    const match = extractSentinel(carry + '0__\n');
    expect(match).not.toBeNull();
    expect(match!.exitCode).toBe(0);
  });
});
