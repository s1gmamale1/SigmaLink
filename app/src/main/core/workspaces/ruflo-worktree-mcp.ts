// SF-15 — per-worktree Ruflo MCP config + trust.
//
// THE BUG (SF-15): `openWorkspace` writes the `ruflo` MCP server config and the
// claude trust file into the WORKSPACE ROOT. But every pane's CLI is spawned
// inside its OWN git worktree (`<userData>/worktrees/<repoHash>/<uuid>[/<rel>]`)
// — a directory entirely outside the workspace root. A CLI (claude / cursor)
// reads `.mcp.json` and `.claude/settings.local.json` RELATIVE TO ITS CWD, so
// the workspace-root ruflo config is invisible to the pane. Result: Ruflo MCP
// is never attached to panes.
//
// THE FIX: write a narrow `ruflo` entry (+ claude trust) into the pane's ACTUAL
// cwd right before its CLI spawns. This module is deliberately narrow — it only
// touches the worktree's own `.mcp.json` (claude/cursor read it) and reuses
// `ensureRufloTrusted` for the claude trust file. It never writes to home-dir
// configs (codex/gemini/kimi/opencode) — those are user-scoped and already
// handled once at workspace open.
//
// Every path is fail-open: this module never throws into the caller (the pane
// launcher). The worst case is a `warn` + a null result outcome; a pane launch
// must never be blocked on MCP wiring.

import fs from 'node:fs';
import path from 'node:path';
import { ensureRufloTrusted } from './mcp-trust';
import { isManagedRufloEntry } from './mcp-autowrite';

const RUFLO_SERVER_NAME = 'ruflo';
const RUFLO_COMMAND = 'npx';
// Mirrors mcp-autowrite's canonical stdio args (`mcp start`, npx first-run
// prompt suppressed). Kept in sync intentionally — the worktree entry must be
// indistinguishable from the workspace-root entry so self-heal across the two
// writers is consistent.
const RUFLO_ARGS = ['-y', '@claude-flow/cli@latest', 'mcp', 'start'];

type JsonObject = Record<string, unknown>;

export interface WriteRufloIntoCwdOptions {
  /**
   * HTTP-daemon port. When a finite positive integer is supplied the entry is
   * written in HTTP mode (`http://127.0.0.1:<port>/mcp`); otherwise stdio mode.
   */
  port?: number;
  /** When false, skip the claude trust write (autowrite-without-autotrust). */
  trust?: boolean;
  logger?: Pick<Console, 'warn'>;
}

export interface WriteRufloIntoCwdResult {
  /** Absolute path of the written `.mcp.json`, or null when skipped/refused. */
  claude: string | null;
  /** Whether the claude trust file was touched. */
  trusted: boolean;
}

/**
 * Ensure the bundled `ruflo` MCP server + claude trust are present in `cwd`
 * (the pane's worktree directory) so the CLI spawned there sees Ruflo. Narrow,
 * idempotent, and fail-open.
 *
 * @param cwd  the pane's actual working directory (worktree cwd).
 * @param opts port (HTTP vs stdio), trust toggle, logger seam.
 */
export function writeRufloMcpIntoCwd(
  cwd: string,
  opts: WriteRufloIntoCwdOptions = {},
): WriteRufloIntoCwdResult {
  const logger = opts.logger ?? console;
  const rawPort = opts.port;
  const port =
    typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0
      ? rawPort
      : undefined;

  const claude = writeRufloEntry(cwd, port, logger);

  let trusted = false;
  if (opts.trust !== false) {
    try {
      const r = ensureRufloTrusted(cwd, { logger });
      trusted = r.claude === 'written' || r.claude === 'already';
    } catch (err) {
      // ensureRufloTrusted is already fail-open; this is belt-and-suspenders.
      logger.warn(
        `[ruflo-worktree] trust failed for ${cwd}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { claude, trusted };
}

/**
 * Merge a managed `ruflo` server into `<cwd>/.mcp.json`. Refuses to clobber a
 * user-managed entry; preserves all co-tenant servers (browser/sigmamemory).
 * Returns the target path on success, or null when skipped/refused/failed.
 */
function writeRufloEntry(
  cwd: string,
  port: number | undefined,
  logger: Pick<Console, 'warn'>,
): string | null {
  const target = path.join(cwd, '.mcp.json');
  try {
    let doc: JsonObject = {};
    if (fs.existsSync(target)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (isPlainObject(parsed)) {
          doc = parsed;
        } else {
          logger.warn(`[ruflo-worktree] ${target} root is not an object — left untouched`);
          return null;
        }
      } catch {
        logger.warn(`[ruflo-worktree] ${target} is not valid JSON — left untouched`);
        return null;
      }
    }

    const mcpServers = isPlainObject(doc.mcpServers) ? doc.mcpServers : {};
    const existing = mcpServers[RUFLO_SERVER_NAME];
    if (existing !== undefined && !isManagedRufloEntry(existing)) {
      logger.warn(`[ruflo-worktree] ${target} has a user-managed ruflo entry — left untouched`);
      return null;
    }

    mcpServers[RUFLO_SERVER_NAME] = port !== undefined ? buildHttpEntry(port) : buildStdioEntry(cwd);
    doc.mcpServers = mcpServers;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, JSON.stringify(doc, null, 2) + '\n');
    return target;
  } catch (err) {
    logger.warn(
      `[ruflo-worktree] failed to write ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function buildStdioEntry(cwd: string): JsonObject {
  return {
    command: RUFLO_COMMAND,
    args: [...RUFLO_ARGS],
    env: {
      // Per-worktree memory dir so each pane's Ruflo store is isolated to its
      // own working tree (mirrors mcp-autowrite's workspace-root convention).
      CLAUDE_FLOW_DIR: path.join(cwd, '.claude-flow'),
    },
  };
}

function buildHttpEntry(port: number): JsonObject {
  return { url: `http://127.0.0.1:${port}/mcp` };
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeFileAtomic(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
