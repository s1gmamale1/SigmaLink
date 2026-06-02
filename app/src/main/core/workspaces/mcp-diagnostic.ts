// P6 FEAT-5 — MCP config diagnostics controller.
//
// Reads each provider's on-disk MCP config for a workspace, parses the declared
// servers, and flags configuration problems:
//   - duplicate / scope-conflict: the same server NAME defined in >1 config file
//   - missing-env: a Ruflo-managed entry that is missing its expected env
//     (CLAUDE_FLOW_DIR for stdio entries)
//   - unreadable: a config file that exists but is malformed / can't be parsed
//
// Surfaces the result as a structured `McpDiagnostic` (servers[] + issues[]) and
// raises one actionable in-app notification per warn/error issue via the injected
// notify sink (ruflo-fallback-notice.ts pattern: fail-open, stable dedupKey).
//
// Dependency-injected so it loads under vitest (rpc-router can't — Electron deps).
// All filesystem reads are defensive: a malformed file becomes an 'unreadable'
// issue, never a thrown exception.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';

import type { getDb } from '../db/client';
import { workspaces } from '../db/schema';
import type { McpDiagnostic, McpIssue, McpServerEntry } from '../../../shared/types';
import { isManagedRufloEntry } from './mcp-autowrite';

export type McpDiagDb = ReturnType<typeof getDb>;

/** Notification sink slice — same shape the workspace factory injects. */
export interface McpDiagnosticNotify {
  add: (input: {
    workspaceId: string | null;
    kind: string;
    severity: 'info' | 'warn' | 'error' | 'critical';
    title: string;
    body?: string;
    dedupKey: string;
  }) => void;
}

export interface McpDiagnosticDeps {
  getDb: () => McpDiagDb;
  /** Optional — when present, the diagnose pass raises a bell per flagged issue. */
  notify?: McpDiagnosticNotify;
  /** Test hook — override the home directory used for user-scoped configs. */
  homeDir?: string;
}

const NOTIFICATION_KIND = 'mcp-diagnostic';

type Provider = McpServerEntry['provider'];

/** One config file the diagnostics pass attempts to read for a workspace. */
interface ConfigTarget {
  provider: Provider;
  scope: McpServerEntry['scope'];
  file: string;
  /** How to extract the server map from this provider's on-disk format. */
  format: 'json-mcpServers' | 'json-mcp' | 'toml-mcp_servers';
}

/** The expected env var a Ruflo-managed stdio entry must declare. */
const RUFLO_EXPECTED_ENV = 'CLAUDE_FLOW_DIR';

export function buildMcpDiagnosticController(deps: McpDiagnosticDeps) {
  return {
    diagnoseWorkspace: async (input: { workspaceId: string }): Promise<McpDiagnostic> => {
      const scannedAt = Date.now();
      const root = resolveWorkspaceRoot(deps.getDb(), input.workspaceId);

      // A workspace we can't resolve yields an empty-but-valid diagnostic rather
      // than throwing — the renderer renders the "no servers" empty state.
      if (root === null) {
        return { workspaceId: input.workspaceId, servers: [], issues: [], scannedAt };
      }

      const home = deps.homeDir ?? os.homedir();
      const targets = buildConfigTargets(root, home);

      const servers: McpServerEntry[] = [];
      const issues: McpIssue[] = [];

      for (const target of targets) {
        readConfigTarget(target, servers, issues);
      }

      // Cross-file duplicate detection: a server NAME present in >1 file.
      flagDuplicates(servers, issues);

      // Raise one notification per warn/error issue (info issues stay in-UI only).
      for (const issue of issues) {
        if (issue.severity === 'warn' || issue.severity === 'error') {
          notifyIssue(deps.notify, input.workspaceId, issue);
        }
      }

      return { workspaceId: input.workspaceId, servers, issues, scannedAt };
    },
  };
}

/** Resolve a workspace's absolute root path by id, or null if unknown/unreadable. */
function resolveWorkspaceRoot(db: McpDiagDb, workspaceId: string): string | null {
  try {
    const rows = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).all();
    const row = rows[0];
    if (!row || typeof row.rootPath !== 'string' || row.rootPath.length === 0) return null;
    return path.resolve(row.rootPath);
  } catch {
    return null;
  }
}

/** The full set of provider config files we scan for one workspace. */
function buildConfigTargets(root: string, home: string): ConfigTarget[] {
  return [
    // Project-scoped (live inside the workspace root).
    { provider: 'claude', scope: 'project', file: path.join(root, '.mcp.json'), format: 'json-mcpServers' },
    { provider: 'cursor', scope: 'project', file: path.join(root, '.cursor', 'mcp.json'), format: 'json-mcpServers' },
    // User-scoped (live in the user's home dir — shared across workspaces).
    { provider: 'codex', scope: 'user', file: path.join(home, '.codex', 'config.toml'), format: 'toml-mcp_servers' },
    { provider: 'gemini', scope: 'user', file: path.join(home, '.gemini', 'settings.json'), format: 'json-mcpServers' },
    { provider: 'kimi', scope: 'user', file: path.join(home, '.kimi', 'mcp.json'), format: 'json-mcpServers' },
    { provider: 'opencode', scope: 'user', file: path.join(home, '.config', 'opencode', 'opencode.json'), format: 'json-mcp' },
  ];
}

/**
 * Read + parse one config file, appending discovered servers and any
 * missing-env / unreadable issues. Absent files are skipped silently; malformed
 * files become an 'unreadable' issue (never throw).
 */
function readConfigTarget(
  target: ConfigTarget,
  servers: McpServerEntry[],
  issues: McpIssue[],
): void {
  let raw: string;
  try {
    if (!fs.existsSync(target.file)) return; // absent → not configured, skip.
    raw = fs.readFileSync(target.file, 'utf8');
  } catch {
    issues.push(unreadableIssue(target, 'config file could not be read'));
    return;
  }

  if (target.format === 'toml-mcp_servers') {
    parseTomlConfig(target, raw, servers, issues);
    return;
  }
  parseJsonConfig(target, raw, servers, issues);
}

/** Parse a JSON provider config (claude/cursor/gemini/kimi `mcpServers`, opencode `mcp`). */
function parseJsonConfig(
  target: ConfigTarget,
  raw: string,
  servers: McpServerEntry[],
  issues: McpIssue[],
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push(unreadableIssue(target, 'JSON is malformed and could not be parsed'));
    return;
  }
  if (!isPlainObject(parsed)) {
    issues.push(unreadableIssue(target, 'JSON root is not an object'));
    return;
  }

  const mapKey = target.format === 'json-mcp' ? 'mcp' : 'mcpServers';
  const serverMap = parsed[mapKey];
  if (serverMap === undefined) return; // no servers declared in this file.
  if (!isPlainObject(serverMap)) {
    issues.push(unreadableIssue(target, `"${mapKey}" is present but not an object`));
    return;
  }

  for (const [name, entry] of Object.entries(serverMap)) {
    const managed = isManagedRufloEntry(entry);
    servers.push({ name, provider: target.provider, scope: target.scope, file: target.file, managed });
    if (managed) flagMissingEnv(target, name, entry, issues);
  }
}

/**
 * Best-effort TOML parse for codex's `~/.codex/config.toml`. We only need the
 * `[mcp_servers.<name>]` table headers (+ their env sub-tables) to list servers
 * and check for the expected env — a full TOML parser is overkill. Any structural
 * surprise is tolerated: at worst a server is skipped, never a throw.
 */
function parseTomlConfig(
  target: ConfigTarget,
  raw: string,
  servers: McpServerEntry[],
  issues: McpIssue[],
): void {
  // Collect every `[mcp_servers.<name>]` and `[mcp_servers.<name>.env]` header.
  const headerRe = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)(\.[^\]]+)?\]\s*$/gm;
  const seen = new Set<string>();
  const withEnvTable = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(raw)) !== null) {
    const name = match[1];
    const sub = match[2];
    if (sub === undefined) {
      seen.add(name);
    } else if (sub === '.env') {
      withEnvTable.add(name);
    }
  }

  for (const name of seen) {
    // We treat a codex entry as managed only when it declares the ruflo command
    // (npx). We approximate by checking the block has `command = "npx"`.
    const managed = name === 'ruflo' && tomlBlockHasNpxCommand(raw, name);
    servers.push({ name, provider: target.provider, scope: target.scope, file: target.file, managed });
    // Missing-env for a managed ruflo entry: no `[mcp_servers.ruflo.env]` table
    // OR the table lacks CLAUDE_FLOW_DIR.
    if (managed && !tomlEnvDeclaresExpectedKey(raw, name, withEnvTable)) {
      issues.push(missingEnvIssue(target, name));
    }
  }
}

// Hardcoded (static) regexes — no dynamic RegExp(), per the mcp-autowrite.ts
// convention, to avoid the ReDoS lint (CWE-1333). The only variable input is a
// TOML table NAME, which we match by exact-string scan rather than regex.

/** `command = "npx"` (or single-quoted) on its own line. */
const TOML_NPX_COMMAND_RE = /^\s*command\s*=\s*(?:"npx"|'npx')\s*(?:#.*)?$/m;
/** `CLAUDE_FLOW_DIR = ...` on its own line — the one env key we check for. */
const TOML_EXPECTED_ENV_RE = /^\s*CLAUDE_FLOW_DIR\s*=/m;

/** Does the `[mcp_servers.<name>]` block declare `command = "npx"`? */
function tomlBlockHasNpxCommand(raw: string, name: string): boolean {
  const block = sliceTomlBlock(raw, `mcp_servers.${name}`);
  if (block === null) return false;
  return TOML_NPX_COMMAND_RE.test(block);
}

/** Does `[mcp_servers.<name>.env]` declare the expected CLAUDE_FLOW_DIR key? */
function tomlEnvDeclaresExpectedKey(
  raw: string,
  name: string,
  withEnvTable: Set<string>,
): boolean {
  if (!withEnvTable.has(name)) return false;
  const block = sliceTomlBlock(raw, `mcp_servers.${name}.env`);
  if (block === null) return false;
  return TOML_EXPECTED_ENV_RE.test(block);
}

/**
 * Slice the body of a TOML table from its `[header]` to the next `[header]`/EOF.
 * Uses an exact-string scan over header lines (no dynamic RegExp on the variable
 * `header`) — a single static regex enumerates the bracketed table headers and
 * we compare each captured name to the target by string equality.
 */
function sliceTomlBlock(raw: string, header: string): string | null {
  const headerLineRe = /^[ \t]*\[([^\]]+)\][ \t]*$/gm;
  let m: RegExpExecArray | null;
  let bodyStart = -1;
  while ((m = headerLineRe.exec(raw)) !== null) {
    const found = m[1].trim();
    if (bodyStart === -1) {
      if (found === header) bodyStart = m.index + m[0].length;
      continue;
    }
    // First header AFTER our match ends the block body.
    return raw.slice(bodyStart, m.index);
  }
  return bodyStart === -1 ? null : raw.slice(bodyStart);
}

/**
 * A Ruflo-managed JSON entry must declare its `env.CLAUDE_FLOW_DIR` (stdio mode).
 * HTTP-daemon entries (url-only, no env) are exempt — their env is set by the
 * supervisor at spawn time, not in config.
 */
function flagMissingEnv(
  target: ConfigTarget,
  name: string,
  entry: unknown,
  issues: McpIssue[],
): void {
  if (!isPlainObject(entry)) return;
  // HTTP-daemon managed entries are url-only → no env expected.
  if (typeof entry.url === 'string') return;
  const envKey = target.format === 'json-mcp' ? 'environment' : 'env';
  const env = entry[envKey];
  const hasExpected =
    isPlainObject(env) &&
    typeof env[RUFLO_EXPECTED_ENV] === 'string' &&
    (env[RUFLO_EXPECTED_ENV] as string).length > 0;
  if (!hasExpected) {
    issues.push(missingEnvIssue(target, name));
  }
}

/**
 * Flag any server NAME that appears in more than one config file. The same name
 * across providers means each CLI dials a different server definition for the
 * "same" logical server — a scope conflict the operator should reconcile.
 */
function flagDuplicates(servers: McpServerEntry[], issues: McpIssue[]): void {
  const byName = new Map<string, McpServerEntry[]>();
  for (const s of servers) {
    const list = byName.get(s.name);
    if (list) list.push(s);
    else byName.set(s.name, [s]);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const files = [...new Set(list.map((s) => s.file))];
    if (files.length < 2) continue; // same file twice can't happen, but guard anyway.
    issues.push({
      severity: 'warn',
      kind: 'scope-conflict',
      title: `Duplicate MCP server "${name}"`,
      detail: `"${name}" is defined in ${files.length} config files (${files
        .map((f) => path.basename(f))
        .join(', ')}). Each provider dials its own definition; reconcile or remove the extras.`,
    });
  }
}

// ─── Issue builders ──────────────────────────────────────────────────────────

function unreadableIssue(target: ConfigTarget, why: string): McpIssue {
  return {
    severity: 'warn',
    kind: 'unreadable',
    title: `Unreadable MCP config (${target.provider})`,
    detail: `${target.file}: ${why}.`,
    file: target.file,
  };
}

function missingEnvIssue(target: ConfigTarget, name: string): McpIssue {
  return {
    severity: 'error',
    kind: 'missing-env',
    title: `MCP server "${name}" missing ${RUFLO_EXPECTED_ENV}`,
    detail: `The managed "${name}" entry in ${target.file} does not declare ${RUFLO_EXPECTED_ENV}; the Ruflo memory store will not resolve. Re-open the workspace to rewrite the config.`,
    file: target.file,
  };
}

// ─── Notification wiring ──────────────────────────────────────────────────────

/** Raise one bell per warn/error issue. Fail-open — never throws into the caller. */
function notifyIssue(
  notify: McpDiagnosticNotify | undefined,
  workspaceId: string,
  issue: McpIssue,
): void {
  if (!notify) return;
  try {
    notify.add({
      workspaceId,
      kind: NOTIFICATION_KIND,
      severity: issue.severity,
      title: issue.title,
      body: issue.detail,
      // Stable per-workspace + kind + file key so repeated scans collapse rather
      // than spamming a fresh bell on every diagnose pass.
      dedupKey: `${NOTIFICATION_KIND}:${workspaceId}:${issue.kind}:${issue.file ?? issue.title}`,
    });
  } catch {
    /* fail-open — a notification failure must never break the diagnostics pass. */
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
