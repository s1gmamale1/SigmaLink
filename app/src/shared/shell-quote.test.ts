import { describe, expect, it } from 'vitest';
import { joinShellCommand, quoteShellArg } from './shell-quote';
import { AGENT_PROVIDERS, installCommandFor } from './providers';

// --- reference tokenizers -------------------------------------------------
// The round-trip oracle: a quoted string is correct iff a shell tokenizer
// splits it back into the ORIGINAL argv array. Both tokenizers THROW on an
// unterminated quote — that is the C-060 failure mode (`sh` drops to a
// `quote>` continuation prompt instead of running the command).

/** POSIX `sh` word splitting: '…' literal, "…" with \ escapes, \x escapes. */
function tokenizePosix(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t') {
      if (started) { out.push(cur); cur = ''; started = false; }
      i += 1;
      continue;
    }
    if (ch === "'") {
      i += 1;
      started = true;
      while (i < input.length && input[i] !== "'") { cur += input[i]!; i += 1; }
      if (i >= input.length) throw new Error('unterminated single quote');
      i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      started = true;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && ['"', '\\', '$', '`'].includes(input[i + 1] ?? '')) {
          cur += input[i + 1]!;
          i += 2;
          continue;
        }
        cur += input[i]!;
        i += 1;
      }
      if (i >= input.length) throw new Error('unterminated double quote');
      i += 1;
      continue;
    }
    if (ch === '\\') {
      cur += input[i + 1] ?? '';
      i += 2;
      started = true;
      continue;
    }
    cur += ch;
    started = true;
    i += 1;
  }
  if (started) out.push(cur);
  return out;
}

/** Win32 `CommandLineToArgvW` semantics (backslash runs only escape a quote). */
function tokenizeWin32(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let inQuotes = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === '\\') {
      let n = 0;
      while (input[i] === '\\') { n += 1; i += 1; }
      if (input[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        started = true;
        if (n % 2 === 1) cur += '"';
        else inQuotes = !inQuotes;
        i += 1;
      } else {
        cur += '\\'.repeat(n);
        started = true;
      }
      continue;
    }
    if (ch === '"') { inQuotes = !inQuotes; started = true; i += 1; continue; }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (started) { out.push(cur); cur = ''; started = false; }
      i += 1;
      continue;
    }
    cur += ch;
    started = true;
    i += 1;
  }
  if (inQuotes) throw new Error('unterminated double quote');
  if (started) out.push(cur);
  return out;
}

const tokenize = { darwin: tokenizePosix, linux: tokenizePosix, win32: tokenizeWin32 } as const;

// --- C-058/C-060: the single-arg quoter ----------------------------------

const R = String.raw;

const ARG_CASES: Array<{ name: string; input: string; posix: string; win32: string }> = [
  { name: 'plain token', input: 'codex', posix: R`'codex'`, win32: R`"codex"` },
  { name: 'space in a posix path', input: '/Users/x/My Apps/a', posix: R`'/Users/x/My Apps/a'`, win32: R`"/Users/x/My Apps/a"` },
  { name: 'space in a Program Files path', input: R`C:\Program Files\SigmaLink\SigmaLink.exe`, posix: R`'C:\Program Files\SigmaLink\SigmaLink.exe'`, win32: R`"C:\Program Files\SigmaLink\SigmaLink.exe"` },
  // C-060: `'` closes the quote, word-splits, and reopens an unterminated one.
  { name: 'embedded single quote', input: "/Users/x/Leo's Apps/a", posix: R`'/Users/x/Leo'\''s Apps/a'`, win32: R`"/Users/x/Leo's Apps/a"` },
  { name: 'embedded double quote', input: 'say "hi"', posix: R`'say "hi"'`, win32: R`"say \"hi\""` },
  { name: 'backslash run before a double quote', input: R`a\"b`, posix: R`'a\"b'`, win32: R`"a\\\"b"` },
  // A template literal cannot end in a backslash, so these stay plain strings.
  { name: 'trailing backslash', input: 'C:\\dir\\', posix: "'C:\\dir\\'", win32: '"C:\\dir\\\\"' },
  { name: 'metacharacter $', input: '$HOME/x', posix: R`'$HOME/x'`, win32: R`"$HOME/x"` },
  { name: 'metacharacter backtick', input: '`whoami`', posix: "'`whoami`'", win32: '"`whoami`"' },
  { name: 'metacharacter ;', input: 'a; rm -rf /', posix: R`'a; rm -rf /'`, win32: R`"a; rm -rf /"` },
  { name: 'metacharacter |', input: 'curl u | bash', posix: R`'curl u | bash'`, win32: R`"curl u | bash"` },
  { name: 'empty string', input: '', posix: R`''`, win32: R`""` },
];

describe('quoteShellArg', () => {
  it.each(ARG_CASES)('posix: $name', ({ input, posix }) => {
    expect(quoteShellArg(input, 'darwin')).toBe(posix);
    expect(quoteShellArg(input, 'linux')).toBe(posix);
  });

  it.each(ARG_CASES)('win32: $name', ({ input, win32 }) => {
    expect(quoteShellArg(input, 'win32')).toBe(win32);
  });

  it.each(ARG_CASES)('round-trips as exactly one argv token: $name', ({ input }) => {
    expect(tokenizePosix(quoteShellArg(input, 'darwin'))).toEqual([input]);
    expect(tokenizeWin32(quoteShellArg(input, 'win32'))).toEqual([input]);
  });

  it('always quotes, so an interpolated `-e KEY=<arg>` pair stays one token', () => {
    // The External Control connect command builds `-e K=${q(v)}` by hand; the
    // quoter must never elide the quotes or that contract breaks.
    expect(quoteShellArg('external', 'darwin')).toBe(R`'external'`);
    expect(quoteShellArg('external', 'win32')).toBe(R`"external"`);
  });
});

// --- C-058/C-059: the argv joiner ----------------------------------------

const JOIN_CASES: Array<{ name: string; argv: string[]; posix: string; win32: string }> = [
  { name: 'npm global install needs no quoting', argv: ['npm', 'i', '-g', '@openai/codex'], posix: 'npm i -g @openai/codex', win32: 'npm i -g @openai/codex' },
  // C-059: the payload is ONE argv token and must survive as one.
  { name: 'bash -c payload with a pipe', argv: ['bash', '-c', 'curl https://cursor.com/install -fsS | bash'], posix: R`bash -c 'curl https://cursor.com/install -fsS | bash'`, win32: R`bash -c "curl https://cursor.com/install -fsS | bash"` },
  { name: 'space in a path member', argv: ['open', '/Users/x/My Apps/a'], posix: R`open '/Users/x/My Apps/a'`, win32: R`open "/Users/x/My Apps/a"` },
  { name: 'embedded single quote member', argv: ['echo', "it's"], posix: R`echo 'it'\''s'`, win32: R`echo "it's"` },
  { name: 'embedded double quote member', argv: ['echo', 'say "hi"'], posix: R`echo 'say "hi"'`, win32: R`echo "say \"hi\""` },
  { name: 'metacharacter members', argv: ['echo', '$HOME', '`id`', 'a;b', 'a|b'], posix: "echo '$HOME' '`id`' 'a;b' 'a|b'", win32: 'echo "$HOME" "`id`" "a;b" "a|b"' },
  { name: 'empty-string member', argv: ['echo', ''], posix: R`echo ''`, win32: R`echo ""` },
  { name: 'empty argv', argv: [], posix: '', win32: '' },
];

describe('joinShellCommand', () => {
  it.each(JOIN_CASES)('posix: $name', ({ argv, posix }) => {
    expect(joinShellCommand(argv, 'darwin')).toBe(posix);
    expect(joinShellCommand(argv, 'linux')).toBe(posix);
  });

  it.each(JOIN_CASES)('win32: $name', ({ argv, win32 }) => {
    expect(joinShellCommand(argv, 'win32')).toBe(win32);
  });

  it.each(JOIN_CASES)('round-trips to the original argv: $name', ({ argv }) => {
    expect(tokenizePosix(joinShellCommand(argv, 'darwin'))).toEqual(argv);
    expect(tokenizeWin32(joinShellCommand(argv, 'win32'))).toEqual(argv);
  });
});

// --- C-059: the real provider fixtures the modal renders ------------------

describe('provider install commands round-trip (C-059)', () => {
  const platforms = ['darwin', 'linux', 'win32'] as const;

  it('cursor-agent keeps `curl … | bash` as ONE argv token', () => {
    const cursor = AGENT_PROVIDERS.find((p) => p.id === 'cursor');
    expect(cursor).toBeDefined();
    const argv = installCommandFor(cursor!, 'darwin');
    expect(argv).toEqual(['bash', '-c', 'curl https://cursor.com/install -fsS | bash']);

    const rendered = joinShellCommand(argv!, 'darwin');
    // The pre-fix render — `bash -c curl https://cursor.com/install -fsS | bash`
    // — ran `bash -c curl` with $0 = the URL, wrote curl's usage to stderr and
    // piped an EMPTY stream into bash: a silent no-op install.
    expect(rendered).not.toBe(argv!.join(' '));
    expect(tokenizePosix(rendered)).toEqual(argv);
  });

  it.each(platforms)('every provider install command round-trips on %s', (platform) => {
    for (const def of AGENT_PROVIDERS) {
      const argv = installCommandFor(def, platform);
      if (!argv) continue;
      const rendered = joinShellCommand(argv, platform);
      expect(tokenize[platform](rendered), `${def.id} on ${platform}: ${rendered}`).toEqual(argv);
    }
  });
});
