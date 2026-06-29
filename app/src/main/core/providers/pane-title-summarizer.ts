// Provider-agnostic pane-title summarizer. Turns a (possibly long) prompt into a
// clean 2-4 word task title via a ONE-SHOT `claude -p --model haiku` subprocess.
//
// Why a subprocess and not an API call: the app ships no Anthropic SDK / API key
// — the Jorvis assistant already drives the local `claude` CLI (runClaudeCliTurn).
// We reuse that exact dependency: a single headless Haiku turn, run in a neutral
// cwd (os.tmpdir) so it skips the workspace's PROJECT CLAUDE.md. (The global
// ~/.claude/CLAUDE.md still loads — a known latency/cost tax, not worth breaking
// auth/cwd to avoid.) Best-effort: returns null on any failure (no binary,
// timeout, empty) and the renderer orchestrator falls back gracefully.

import { tmpdir } from 'node:os';
import { spawnExecutable } from '../util/spawn-cross-platform';
import { probeProviderById } from './probe';

const MODEL = 'haiku';        // claude CLI model alias → Claude Haiku (cheap/fast)
const TIMEOUT_MS = 15_000;
const INPUT_CAP = 2_000;      // cap the prompt we send (titles need only the gist)
const STDOUT_CAP = 4_000;     // cap captured output (a title is tiny)
const TITLE_CAP = 60;

// Probe is mildly expensive (runs `claude --version`); cache the resolved path.
// undefined = not yet probed, null = probed & not found.
let cachedClaudePath: string | null | undefined;

async function resolveClaude(): Promise<string | null> {
  if (cachedClaudePath !== undefined) return cachedClaudePath;
  try {
    const probe = await probeProviderById('claude');
    cachedClaudePath = probe.found && probe.resolvedPath ? probe.resolvedPath : null;
  } catch {
    cachedClaudePath = null;
  }
  return cachedClaudePath;
}

/** Test-only: reset the cached binary path. */
export function __resetSummarizerCache(): void {
  cachedClaudePath = undefined;
}

function buildTitlePrompt(text: string): string {
  const t = text.slice(0, INPUT_CAP);
  return (
    'Reply with ONLY a 2-4 word title in Title Case naming what this coding ' +
    'task is about. No quotes, no punctuation, no preamble, no explanation — ' +
    'just the title.\n\nTask:\n' + t
  );
}

/** First non-empty line, stripped of quotes/markdown/edge punctuation, collapsed,
 *  capped. Returns null when nothing usable survives. */
export function sanitizeTitle(out: string): string | null {
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  // Defensive: the global ~/.claude/CLAUDE.md may nudge `claude -p` to prefix a
  // "SIGMA::LABEL " sentinel — strip it so the title isn't doubled-up.
  let s = line.replace(/^\s*SIGMA::LABEL\s*/i, '');
  s = s.replace(/^["'`*#\s.\-–—]+/, '').replace(/["'`*\s.]+$/, '').replace(/\s+/g, ' ').trim();
  if (!s || !/[\p{L}\p{N}]/u.test(s)) return null;
  if (s.length > TITLE_CAP) s = s.slice(0, TITLE_CAP).trim();
  return s;
}

/**
 * Summarize a task prompt into a short title, or null on any failure.
 * `spawn` is injectable for tests.
 */
export async function summarizeTitle(
  text: string,
  spawn: typeof spawnExecutable = spawnExecutable,
): Promise<string | null> {
  if (!text || !text.trim()) return null;
  const bin = await resolveClaude();
  if (!bin) return null;

  const args = ['-p', buildTitlePrompt(text), '--model', MODEL];
  return new Promise<string | null>((resolve) => {
    let child;
    try {
      // stdio: stdin IGNORED (=/dev/null). Critical: `claude -p` with an OPEN,
      // non-TTY stdin pipe blocks ~3s waiting for piped input ("no stdin data
      // received in 3s…") and degrades; closing stdin makes it answer immediately.
      // stderr ignored too (we only want stdout; avoids backpressure).
      child = spawn(bin, args, { cwd: tmpdir(), env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (val: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < STDOUT_CAP) stdout += d.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(sanitizeTitle(stdout)));
  });
}
