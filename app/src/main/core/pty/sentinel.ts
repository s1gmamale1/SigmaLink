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
 * Maximum carried tail length. The longest possible sentinel line is ~30
 * chars (`\n` + prefix(21) + 3 exit-code digits + suffix(2) + `\r\n`); 64
 * leaves comfortable headroom while bounding per-chunk concat cost.
 */
export const SENTINEL_CARRY_MAX = 64;

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
// v1.6.0 Phase 5 — win32 per-shell sentinel snippets.
//
// The sentinel MARKER format (__SIGMALINK_CLI_EXIT_<code>__) is identical on
// all platforms — SENTINEL_RE / extractSentinel / containsSentinel remain
// unchanged and recognise all three variants.
//
// PowerShell emits the sentinel via Write-Host; cmd.exe via echo.  Both print
// the same \n__SIGMALINK_CLI_EXIT_<code>__\n pattern that SENTINEL_RE matches.
// ---------------------------------------------------------------------------

/**
 * Build the PowerShell snippet that emits the sentinel after the CLI exits.
 *
 * Intended for injection as the tail of a PowerShell command line, e.g.:
 *   claude --args; Write-Host "`n__SIGMALINK_CLI_EXIT_$LASTEXITCODE`__"
 *
 * The snippet is:
 *   ; Write-Host "`n__SIGMALINK_CLI_EXIT_$LASTEXITCODE`__"
 *
 * Backtick-n (`` `n ``) is PowerShell's newline escape inside double-quoted
 * strings.  `$LASTEXITCODE` holds the exit code of the last native command.
 * `$LASTEXITCODE` is set BEFORE the semicolon sequence changes `$?`, so
 * chaining with `;` is correct here (`;` does not change `$LASTEXITCODE`).
 *
 * The caller appends `\n` (the Enter keystroke written into the PTY master).
 */
export function buildPowerShellSentinelSnippet(): string {
  return (
    `; Write-Host "\`n${SENTINEL_PREFIX}$LASTEXITCODE${SENTINEL_SUFFIX}"`
  );
}

/**
 * Build the cmd.exe snippet that emits the sentinel after the CLI exits.
 *
 * Appended to the injected interactive command line:
 *   claude --args && (echo. & echo __SIGMALINK_CLI_EXIT_0__) || (echo. & echo __SIGMALINK_CLI_EXIT_1__)
 *
 * WHY conditional echoes instead of %ERRORLEVEL% (2026-07-03 audit A1):
 * cmd.exe expands every `%VAR%` at PARSE time for the entire `&`-chained
 * interactive line — before ANY command in the line has run. A same-line
 * `SET __SL_EC=%ERRORLEVEL%` therefore captures the PRE-line errorlevel, and
 * a same-line `echo %__SL_EC%` expands before the SET executes (undefined on
 * first use → echoed literally). Delayed expansion (`cmd /V:ON` + `!VAR!`)
 * would fix that but changes `!` handling for everything the user types into
 * the pane shell — unacceptable. The conditional-echo pair needs no
 * expansion at all.
 *
 * FIDELITY TRADE: non-zero exit codes collapse to 1 on cmd.exe (pwsh panes
 * keep exact codes via $LASTEXITCODE). `&&`/`||` bind to the CLI because it
 * is the only preceding command; `(echo. & echo …)` always succeeds, so the
 * `||` arm cannot double-fire after a successful `&&` arm.
 *
 * `echo.` prints the blank line that gives SENTINEL_RE its line-start anchor.
 * The caller appends `\r\n` or `\n` (the Enter keystroke written into the PTY
 * master for cmd.exe — `\r\n` is conventional but `\n` also works in ConPTY).
 */
export function buildCmdSentinelSnippet(): string {
  return (
    ` && (echo. & echo ${SENTINEL_PREFIX}0${SENTINEL_SUFFIX})` +
    ` || (echo. & echo ${SENTINEL_PREFIX}1${SENTINEL_SUFFIX})`
  );
}
