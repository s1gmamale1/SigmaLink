// v1.6.0 Phase 2 — CLI-exit sentinel constants and detection helpers.
//
// In shell-first mode the injected command line is wrapped with a POSIX
// `printf` snippet that prints a unique sentinel after the CLI exits:
//
//   <command> <args>; printf '\n%s%d%s\n' '__SIGMALINK_CLI_EXIT_' "$?" '__'
//
// This causes the shell to print  \n__SIGMALINK_CLI_EXIT_<code>__\n  when the
// CLI's foreground process group exits, while the shell itself stays alive
// (pane durability invariant).
//
// CRITICAL INVARIANT: these constants and helpers are ONLY used in the
// shell-first code path.  Direct mode never sees them.

/** Prefix of the sentinel marker (everything before the exit code). */
export const SENTINEL_PREFIX = '__SIGMALINK_CLI_EXIT_';

/** Suffix of the sentinel marker (everything after the exit code). */
export const SENTINEL_SUFFIX = '__';

/**
 * Regex that matches the sentinel line.
 * Capture group 1: the raw signed or unsigned exit code.
 *
 * The sentinel is printed with a leading newline by the shell (`printf '\n…'`)
 * so it is always at the start of a line.  We tolerate:
 *   - an optional minus sign (PowerShell can emit signed Windows status codes)
 *   - optional leading \r (Windows-style CRLF from PTY normalisation)
 *   - optional trailing \r before \n
 */
export const SENTINEL_RE = new RegExp(
  `(?:^|\\r?\\n)${SENTINEL_PREFIX}(-?\\d+)${SENTINEL_SUFFIX}\\r?(?:\\n|$)`,
  'g',
);

/**
 * Test whether a data chunk contains the sentinel (fast path — no allocation).
 */
export function containsSentinel(data: string): boolean {
  SENTINEL_RE.lastIndex = 0;
  return SENTINEL_RE.test(data);
}

export interface SentinelMatch {
  /** Parsed exit code from the sentinel. */
  exitCode: number;
  /** The data string with ALL sentinel occurrences stripped out. */
  strippedData: string;
}

/**
 * Scan `data` for the sentinel pattern.  If found, return the first exit code
 * and the data with sentinel lines removed.  Returns null if no sentinel.
 *
 * Multiple sentinels in one chunk are theoretically impossible (we inject the
 * command once) but we handle them defensively by keeping the first exit code
 * and stripping all occurrences.
 */
export function extractSentinel(data: string): SentinelMatch | null {
  // Reset the stateful regex before each use.
  SENTINEL_RE.lastIndex = 0;

  let firstCode: number | null = null;
  const stripped = data.replace(SENTINEL_RE, (match, codeStr) => {
    if (firstCode === null) {
      firstCode = parseInt(codeStr, 10);
    }
    // Replace the matched text with just a newline to preserve line structure
    // for any content that followed on the same chunk.  The leading newline
    // that `printf '\n…'` emits will already be present in the match, so
    // we emit an empty string — the surrounding context provides the line breaks.
    return match.startsWith('\n') || match.startsWith('\r\n') ? '\n' : '';
  });

  if (firstCode === null) return null;
  return { exitCode: firstCode, strippedData: stripped };
}

// ---------------------------------------------------------------------------
// 2026-06-10 audit (finding 4) — cross-chunk sentinel carry.
//
// extractSentinel() is per-chunk. PTY reads can split the sentinel across two
// (or more) chunks, in which case it NEVER matched and onCliExited never
// fired (shell-first is the DEFAULT mode). The registry keeps a small
// per-session tail and prepends it to the next chunk for SCANNING ONLY — the
// data forwarded to the renderer is never rewritten (bytes from a previous
// chunk already rendered and cannot be retracted).
// ---------------------------------------------------------------------------

/**
 * Maximum carried tail length. A signed 32-bit Windows status uses 11
 * characters (for example `-1073741510`), making the framed sentinel line
 * roughly 40 characters. 80 leaves headroom while bounding per-chunk concat
 * cost.
 */
export const SENTINEL_CARRY_MAX = 80;

/**
 * Compute the tail of `combined` (= previous carry + current chunk) to carry
 * into the NEXT chunk's sentinel scan when no sentinel matched.
 *
 * Anchor-safe: the carry always starts at a REAL `\n` from the stream, so
 * prepending it to the next chunk can never fabricate the `(?:^|\r?\n)`
 * line-start anchor (a naive `slice(-64)` could cut mid-line and turn
 * `x__SIGMALINK…` into a string-start false positive).
 *
 * When the in-flight line is already longer than any sentinel can be, no
 * partial sentinel can be pending → carry nothing. This also bounds memory on
 * newline-free streams (progress bars, spinners).
 */
export function sliceSentinelCarry(combined: string): string {
  const lastNl = combined.lastIndexOf('\n');
  if (lastNl === -1) return '';
  const tail = combined.slice(lastNl); // includes the '\n' anchor
  return tail.length > SENTINEL_CARRY_MAX ? '' : tail;
}

/**
 * Build the POSIX `printf` snippet that emits the sentinel after the CLI exits.
 *
 * The snippet is:
 *   ; printf '\n%s%d%s\n' '__SIGMALINK_CLI_EXIT_' "$?" '__'
 *
 * It is appended (without a trailing newline — the caller appends `\n`) to the
 * injected command line in `buildShellCommandLine` when `spawnMode === 'shell-first'`.
 */
export function buildSentinelSnippet(): string {
  return (
    `; printf '\\n%s%d%s\\n' '${SENTINEL_PREFIX}' "$?" '${SENTINEL_SUFFIX}'`
  );
}

// ---------------------------------------------------------------------------
// v1.6.0 Phase 5 — win32 PowerShell sentinel snippet.
//
// The sentinel MARKER format (__SIGMALINK_CLI_EXIT_<code>__) is identical on
// all platforms — SENTINEL_RE / extractSentinel / containsSentinel remain
// unchanged and recognise both POSIX and PowerShell variants.
//
// PowerShell emits the same \n__SIGMALINK_CLI_EXIT_<code>__\n pattern that
// SENTINEL_RE matches.
// ---------------------------------------------------------------------------

/**
 * Build the PowerShell snippet that emits the sentinel after the CLI exits.
 *
 * Intended for injection as the tail of a PowerShell command line, e.g.:
 *   claude --args; Write-Host "`n__SIGMALINK_CLI_EXIT_$($LASTEXITCODE)__"
 *
 * The snippet is:
 *   ; Write-Host "`n__SIGMALINK_CLI_EXIT_$($LASTEXITCODE)__"
 *
 * Backtick-n (`` `n ``) is PowerShell's newline escape inside double-quoted
 * strings.  `$LASTEXITCODE` holds the exit code of the last native command.
 * The `$()` delimiter prevents the sentinel suffix underscores from becoming
 * part of the PowerShell variable name.
 * Windows PowerShell resets `$LASTEXITCODE` to 0 when ConPTY interrupts the
 * foreground native pipeline, but leaves `$?` false for the next command.
 * Normalize only that otherwise-clean failure signature to the conventional
 * SIGINT status 130. Real zero and non-zero native exits remain unchanged.
 *
 * The caller appends `\n` (the Enter keystroke written into the PTY master).
 */
export function buildPowerShellSentinelSnippet(): string {
  const exitCode =
    '$(if ($LASTEXITCODE -eq 0 -and -not $?) { 130 } else { $LASTEXITCODE })';
  return (
    `; Write-Host "\`n${SENTINEL_PREFIX}${exitCode}${SENTINEL_SUFFIX}"`
  );
}
