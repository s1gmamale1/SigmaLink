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
 * Capture group 1: the raw exit-code digits.
 *
 * The sentinel is printed with a leading newline by the shell (`printf '\n…'`)
 * so it is always at the start of a line.  We tolerate:
 *   - optional leading \r (Windows-style CRLF from PTY normalisation)
 *   - optional trailing \r before \n
 */
export const SENTINEL_RE = new RegExp(
  `(?:^|\\r?\\n)${SENTINEL_PREFIX}(\\d+)${SENTINEL_SUFFIX}\\r?(?:\\n|$)`,
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
