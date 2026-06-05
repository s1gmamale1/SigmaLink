// SF-7 — per-provider auto-trust of the bundled `ruflo` MCP server.
//
// Pre-approves ONLY the SigmaLink-bundled `ruflo` server by name so that a
// freshly-cloned repo opened as a workspace connects Ruflo end-to-end without a
// manual `/mcp` accept. This is a security boundary: we are deliberately the
// NARROWEST possible — we never enable all project servers, never a wildcard,
// never `--dangerously-skip-permissions`, and we always merge additively so a
// repo's own (third-party) MCP servers keep their normal trust prompt.
//
// Strategy by provider (mirrors the `mcp-autowrite` strategy table):
//   - claude   → merge `enabledMcpjsonServers:["ruflo"]` into
//                `<root>/.claude/settings.local.json` (gitignored by claude
//                convention; won't dirty the clone). THIS is the real work.
//   - cursor   → best-effort `cursor-agent mcp enable ruflo`, gated on binary
//                detection + fail-open. Contract verified against cursor-agent
//                (Task A4): `mcp enable <identifier>` "Add an MCP server to the
//                local approved list" — no required flags. Still best-effort.
//   - codex / gemini / kimi / opencode → documented no-ops: their MCP config is
//                loaded WITHOUT a per-project trust prompt, so writing the server
//                config in mcp-autowrite IS the trust. Nothing to pre-approve.
//
// Every path is fail-open: this module never throws into the caller
// (`openWorkspace`). The worst case for any provider is a `warn` + a result
// outcome other than 'written'.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const RUFLO_SERVER_NAME = 'ruflo';
const CURSOR_AGENT_BIN = 'cursor-agent';
const CURSOR_ENABLE_TIMEOUT_MS = 5_000;

export type TrustOutcome = 'written' | 'already' | 'skipped' | 'error' | 'noop';

export interface RufloTrustResult {
  claude: TrustOutcome;
  cursor: TrustOutcome;
  codex: TrustOutcome;
  gemini: TrustOutcome;
  kimi: TrustOutcome;
  opencode: TrustOutcome;
}

export interface EnsureTrustOpts {
  /** Home directory override (injected in tests). Reserved for providers that
   *  trust via a user-level file; current providers all trust per-project. */
  homeDir?: string;
  logger?: Pick<Console, 'warn'>;
  /** Best-effort CLI runner for cursor (injected in tests). Default:
   *  `spawnSync cursor-agent` with an args array (no shell string). */
  runCli?: (cmd: string, args: string[], cwd: string) => void;
  /** Detect a CLI on PATH (injected in tests). */
  detectCli?: (name: string) => boolean;
}

/**
 * Pre-approve ONLY the bundled `ruflo` MCP server per provider. Idempotent and
 * fail-open: never throws.
 *
 * @param workspaceRoot absolute or relative path to the opened workspace root.
 * @param opts injectable seams (homeDir / logger / runCli / detectCli).
 * @returns a per-provider {@link RufloTrustResult} describing each outcome.
 */
export function ensureRufloTrusted(
  workspaceRoot: string,
  opts: EnsureTrustOpts = {},
): RufloTrustResult {
  const root = path.resolve(workspaceRoot);
  const logger = opts.logger ?? console;
  return {
    claude: trustClaude(root, logger),
    cursor: trustCursor(root, opts),
    // codex/gemini/kimi/opencode: their MCP config is loaded without a
    // per-project trust prompt — writing the server config in mcp-autowrite IS
    // the trust. There is nothing to pre-approve here.
    codex: 'noop',
    gemini: 'noop',
    kimi: 'noop',
    opencode: 'noop',
  };
}

/**
 * claude — merge `enabledMcpjsonServers:["ruflo"]` into
 * `<root>/.claude/settings.local.json`. Additive (never clobbers other servers
 * or other keys), idempotent, and fail-open. An unparseable or non-object file
 * is left byte-for-byte untouched and reported as 'skipped'.
 */
function trustClaude(root: string, logger: Pick<Console, 'warn'>): TrustOutcome {
  const target = path.join(root, '.claude', 'settings.local.json');
  try {
    let obj: Record<string, unknown> = {};
    if (fs.existsSync(target)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch {
        logger.warn(`[ruflo-trust] ${target} is not valid JSON — left untouched`);
        return 'skipped';
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn(`[ruflo-trust] ${target} is not a JSON object — left untouched`);
        return 'skipped';
      }
      obj = parsed as Record<string, unknown>;
    }

    const cur = Array.isArray(obj.enabledMcpjsonServers)
      ? (obj.enabledMcpjsonServers as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (cur.includes(RUFLO_SERVER_NAME)) return 'already';

    obj.enabledMcpjsonServers = [...cur, RUFLO_SERVER_NAME];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Atomic write: serialise to a temp file then rename so a crash mid-write
    // can never leave a half-written (and thus unparseable) settings file.
    // Unique temp name (pid+ts) so concurrent openWorkspace calls for the same
    // root can't collide on a fixed `.tmp` (review Low #1/#3 — closes the TOCTOU
    // where another process could pre-create the temp target).
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
    try {
      fs.renameSync(tmp, target);
    } catch (renameErr) {
      // Don't leave an orphaned temp file behind if the rename fails.
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw renameErr;
    }
    return 'written';
  } catch (err) {
    logger.warn(
      `[ruflo-trust] claude trust failed for ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 'error';
  }
}

/**
 * cursor — best-effort `cursor-agent mcp enable ruflo`, gated on binary
 * detection. Cursor reads `<root>/.cursor/mcp.json` (written by mcp-autowrite);
 * `cursor-agent mcp enable <identifier>` adds the named server to the local
 * approved list (subcommand contract verified in Task A4). The call is fully
 * gated (skips when the binary is not detected) and fail-open, so even a
 * future contract change can only `warn` — it can never block workspace open
 * or throw.
 */
function trustCursor(root: string, opts: EnsureTrustOpts): TrustOutcome {
  const hasInjectedCursorSeam = Boolean(opts.detectCli || opts.runCli);
  if (!hasInjectedCursorSeam && isUnitTestProcess()) return 'noop';
  const detect = opts.detectCli ?? defaultDetectCli;
  if (!detect(CURSOR_AGENT_BIN)) return 'noop';
  const run = opts.runCli ?? defaultRunCli;
  try {
    run(CURSOR_AGENT_BIN, ['mcp', 'enable', RUFLO_SERVER_NAME], root);
    return 'written';
  } catch (err) {
    (opts.logger ?? console).warn(
      `[ruflo-trust] cursor enable failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'error';
  }
}

function isUnitTestProcess(): boolean {
  return process.env.VITEST === 'true'
    || process.env.VITEST_WORKER_ID !== undefined
    || process.env.NODE_ENV === 'test';
}

/** Detect a CLI on PATH without spawning it (used to gate the cursor call). */
function defaultDetectCli(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => {
    try {
      return fs.existsSync(path.join(d, name)) || fs.existsSync(path.join(d, `${name}.cmd`));
    } catch {
      return false;
    }
  });
}

/** Start the cursor enable with an args array (no shell string -> no injection).
 *
 * This is intentionally fire-and-forget. Cursor trust is best-effort plumbing;
 * it must never add seconds of synchronous latency to workspace or pane launch
 * when the external CLI is slow or waiting on its own first-run setup.
 */
function defaultRunCli(cmd: string, args: string[], cwd: string): void {
  const child = spawn(cmd, args, { cwd, stdio: 'ignore' });
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
  }, CURSOR_ENABLE_TIMEOUT_MS);
  timer.unref?.();
  child.once('exit', () => clearTimeout(timer));
  child.once('error', () => clearTimeout(timer));
  child.unref();
}
