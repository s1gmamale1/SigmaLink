// src/shared/shell-quote.ts
//
// THE one quoter for every operator-copyable shell command (WISHLIST C-058).
//
// Three sites used to format a command for the operator to paste, each with
// different (or no) quoting: the External Control `claude mcp add` line
// (platform-aware, no escaping), the provider-install `bash -lc` wrapper
// (escaping, posix-only), and the provider-install modal (a raw
// `argv.join(' ')`). Every new emitter routes through here instead.
//
// The contract both functions hold: the emitted string, run through the
// target shell's tokenizer, yields back EXACTLY the argv array it was built
// from. Nothing word-splits, nothing gets swallowed by an unterminated quote,
// no metacharacter is interpreted.
//
// Pure functions with an EXPLICIT `platform` parameter — never `process.platform`.
// `control-rpc.ts` deliberately stays electron-free and has its platform
// injected through `ControlRpcDeps`; the renderer gets its own from
// `rpc.app.getPlatform()`. The platform that matters is the one the command
// will be PASTED INTO, which is not always the one doing the formatting.
//
// win32 targets cmd.exe (the shell `claude mcp add` is documented against)
// and the `CommandLineToArgvW` argv parser every native binary uses. Known
// limitation: cmd.exe expands `%VAR%` (and `!VAR!` under delayed expansion)
// even inside double quotes, and there is no escape for that at an
// interactive prompt — a value containing `%` is quoted here but cmd may
// still substitute it. No such value exists on any current emitting path
// (paths, hex tokens, fixed labels).

/** Characters that survive an unquoted shell word intact on every target. */
const POSIX_SAFE = /^[A-Za-z0-9_@+=:,./-]+$/;
/** Same, plus `\` for native Windows paths. Excludes `%`, `!`, `$`, `'`, `"`. */
const WIN32_SAFE = /^[A-Za-z0-9_@+=:,./\\-]+$/;

/**
 * Quote ONE argument for the shell it will be pasted into. ALWAYS quotes,
 * even when the value would be safe bare — callers interpolate the result
 * into hand-built strings (`-e KEY=${q(v)}`) and rely on the delimiters.
 *
 * POSIX: single quotes make every byte literal except `'` itself, which is
 * emitted as `'\''` (close, escaped literal, reopen). Without that escape an
 * app at `/Users/x/Leo's Apps/…` closed the quote at `Leo`, word-split, and
 * reopened an unterminated quote that swallowed the rest of the command —
 * the shell dropped to a `quote>` continuation prompt (C-060).
 *
 * win32: double quotes, with the `CommandLineToArgvW` backslash rule — a run
 * of backslashes is only special before a `"` (or the closing quote), where
 * it must be doubled so it is not read as escaping the quote.
 */
export function quoteShellArg(value: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return `'${value.replace(/'/g, `'\\''`)}'`;

  let out = '"';
  let slashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    if (ch === '"') out += '\\'.repeat(slashes * 2 + 1) + '"';
    else out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/**
 * Join an argv array into a pasteable command line, quoting only the tokens
 * that need it. Minimal quoting on purpose: this string is read by a human
 * before it is pasted, and `'npm' 'i' '-g' '@openai/codex'` is worse than
 * `npm i -g @openai/codex` for zero safety gained. It also keeps a bare
 * command name bare, so a win32 line still runs when pasted into PowerShell
 * rather than cmd.exe (PowerShell needs `&` to invoke a *quoted* command).
 *
 * Use this for whole commands; use `quoteShellArg` when interpolating a
 * single value into a string you are assembling yourself.
 */
export function joinShellCommand(argv: readonly string[], platform: NodeJS.Platform): string {
  const safe = platform === 'win32' ? WIN32_SAFE : POSIX_SAFE;
  return argv.map((arg) => (safe.test(arg) ? arg : quoteShellArg(arg, platform))).join(' ');
}
