// Provider-agnostic pane-title summarizer via the **opencode** CLI headless mode
// (`opencode run -m <model> --format json`). Free: rides the user's opencode login
// (their sub'd model, e.g. GLM 5.2, or opencode's free models). No API key, and —
// unlike `claude -p` — it doesn't bill the Max sub or boot a 12-19s agent.
//
// Self-healing model choice (operator design): try opencode's DEFAULT model first;
// if that fails (model removed / none configured), fall back to the FIRST model
// `opencode models` lists. opencode missing/not-logged-in → returns null and the
// renderer orchestrator keeps the instant heuristic title.
//
// Run in os.tmpdir so it doesn't load the workspace's AGENTS.md (keeps the call
// small/fast), stdin closed, stderr unpiped.

import { tmpdir } from 'node:os';
import { spawnExecutable } from '../util/spawn-cross-platform';
import { probeProviderById } from './probe';

const TIMEOUT_MS = 30_000;     // opencode boot + a free-tier turn can be ~10-15s; generous (it's background)
const INPUT_CAP = 2_000;
const STDOUT_CAP = 64_000;     // JSON event stream — small, but cap defensively
const TITLE_CAP = 60;

let cachedOpencodePath: string | null | undefined; // undefined=unprobed, null=not found
let cachedModels: string[] | null = null;

/** Test-only: reset caches. */
export function __resetSummarizerCache(): void {
  cachedOpencodePath = undefined;
  cachedModels = null;
}

async function resolveOpencode(): Promise<string | null> {
  if (cachedOpencodePath !== undefined) return cachedOpencodePath;
  try {
    const probe = await probeProviderById('opencode');
    cachedOpencodePath = probe.found && probe.resolvedPath ? probe.resolvedPath : null;
  } catch {
    cachedOpencodePath = null;
  }
  return cachedOpencodePath;
}

function buildTitlePrompt(text: string): string {
  return (
    'Reply with ONLY a 2-4 word title in Title Case naming what this coding task ' +
    'is about. No quotes, no punctuation, no preamble, no explanation — just the ' +
    'title.\n\nTask:\n' + text.slice(0, INPUT_CAP)
  );
}

/** First non-empty line, stripped of a stray SIGMA::LABEL prefix + quotes/markdown,
 *  collapsed, capped. Returns null when nothing usable survives. */
export function sanitizeTitle(out: string): string | null {
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  let s = line.replace(/^\s*SIGMA::LABEL\s*/i, '');
  s = s.replace(/^["'`*#\s.\-–—]+/, '').replace(/["'`*\s.]+$/, '').replace(/\s+/g, ' ').trim();
  if (!s || !/[\p{L}\p{N}]/u.test(s)) return null;
  return s.length > TITLE_CAP ? s.slice(0, TITLE_CAP).trim() : s;
}

/** Parse `opencode run --format json` output: concatenate the `type:"text"` event
 *  parts, then sanitize. */
function extractTitle(stdout: string): string | null {
  let text = '';
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    try {
      const ev = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string } };
      if (ev.type === 'text' && typeof ev.part?.text === 'string') text += ev.part.text;
    } catch {
      /* partial/non-JSON line — skip */
    }
  }
  return sanitizeTitle(text);
}

/** One headless opencode run. `model` null → opencode's default model. */
function runOpencode(
  bin: string,
  text: string,
  model: string | null,
  spawn: typeof spawnExecutable,
): Promise<string | null> {
  const args = ['run', buildTitlePrompt(text), '--format', 'json'];
  if (model) args.splice(1, 0, '-m', model);
  return new Promise<string | null>((resolve) => {
    let child;
    try {
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
      try { child.kill(); } catch { /* gone */ }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < STDOUT_CAP) stdout += d.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(extractTitle(stdout)));
  });
}

async function getFirstModel(bin: string, spawn: typeof spawnExecutable): Promise<string | null> {
  if (cachedModels) return cachedModels[0] ?? null;
  const list = await new Promise<string[]>((resolve) => {
    let child;
    try {
      child = spawn(bin, ['models'], { cwd: tmpdir(), env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve([]);
      return;
    }
    let out = '';
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { child.kill(); } catch { /* gone */ }
      resolve(out.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.-]+$/.test(l)));
    };
    const t = setTimeout(done, 10_000);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', done);
    child.on('close', done);
  });
  cachedModels = list;
  return list[0] ?? null;
}

/**
 * Summarize a task prompt into a short title via opencode, or null on any failure.
 * `spawn` is injectable for tests.
 */
export async function summarizeTitle(
  text: string,
  spawn: typeof spawnExecutable = spawnExecutable,
): Promise<string | null> {
  if (!text || !text.trim()) return null;
  const bin = await resolveOpencode();
  if (!bin) return null;

  // Attempt 1 — opencode's default model (the user's configured/sub'd model).
  const primary = await runOpencode(bin, text, null, spawn);
  if (primary) return primary;

  // Attempt 2 — first model opencode lists (self-healing fallback).
  const first = await getFirstModel(bin, spawn);
  if (!first) return null;
  return runOpencode(bin, text, first, spawn);
}
