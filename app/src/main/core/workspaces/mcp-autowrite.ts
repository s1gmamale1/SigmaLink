import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KV_RUFLO_AUTOWRITE_MCP = 'ruflo.autowriteMcp';

/** SF-7 — gates per-provider auto-trust of the bundled `ruflo` MCP server in
 *  new workspaces. '1' (default) = auto-trust ON; '0' = opt-out. Independent of
 *  KV_RUFLO_AUTOWRITE_MCP (trust without autowrite is meaningless, but the
 *  operator may want autowrite without auto-approval). */
export const KV_RUFLO_AUTOTRUST_MCP = 'ruflo.autoTrustMcp';

// ─── Ruflo memory-convention block constants ─────────────────────────────────

const CONVENTION_BLOCK_START = '<!-- ruflo-memory-convention:start -->';
const CONVENTION_BLOCK_END = '<!-- ruflo-memory-convention:end -->';
const CONVENTION_BLOCK_USER_MARKER = '<!-- ruflo-memory-convention:user -->';

/**
 * Managed block injected into workspace-root CLAUDE.md to teach spawned CLIs
 * the canonical Ruflo memory namespace and retrieval tool.
 *
 * Key rules:
 * - Store  → `memory_store(namespace: "patterns")`
 * - Search → `memory_search_unified(query)` (sweeps ALL namespaces)
 *   Do NOT use plain `memory_search` — it defaults to the near-empty "default"
 *   namespace and returns ~nothing.
 * - After completing a task, store a short verdict to namespace "patterns"
 *   (key `verdict:<taskId>` or `verdict:<sessionId>`).
 */
const RUFLO_CONVENTION_BLOCK_CONTENT = `\
${CONVENTION_BLOCK_START}
## Ruflo Memory Convention

**Store memories** with namespace \`"patterns"\` (the canonical namespace):
\`\`\`
memory_store(key, value, namespace: "patterns", upsert: true)
\`\`\`

**Retrieve memories** with \`memory_search_unified\` — it sweeps ALL namespaces
(\`default\`, \`pattern\`, \`patterns\`, \`feedback\`, …) and returns relevant results:
\`\`\`
memory_search_unified(query)
\`\`\`

> Do NOT use plain \`memory_search\` without a namespace — it defaults to the
> near-empty \`"default"\` namespace and returns ~nothing useful.

After completing a task, store a short verdict (what worked / what to apply next)
to namespace \`"patterns"\` with key \`verdict:<taskId>\` or \`verdict:<sessionId>\`.
${CONVENTION_BLOCK_END}`;
// Detector functions exported for unit tests and for factory.ts utilities.
// They are declared later in this file (function hoisting applies).
export { isManagedRufloEntry, isManagedOpencodeRufloEntry };

const RUFLO_SERVER_NAME = 'ruflo';
const RUFLO_COMMAND = 'npx';
// v1.3.5 — canonical args. v1.3.4 shipped `mcp-stdio` which is NOT a valid
// claude-flow subcommand; the real form is `mcp start`. The `-y` flag
// suppresses npx's first-run prompt so the spawned MCP client doesn't hang.
// Pre-existing user configs with `mcp-stdio` self-heal on next openWorkspace()
// because `isManagedRufloEntry()` only checks `command === 'npx'`.
const RUFLO_ARGS = ['-y', '@claude-flow/cli@latest', 'mcp', 'start'];

type JsonObject = Record<string, unknown>;

export interface WorkspaceMcpWriteOptions {
  homeDir?: string;
  logger?: Pick<Console, 'warn'>;
  /** Test hook — override the PATH-or-file-exists detection for Kimi/OpenCode. */
  detectCli?: (name: 'kimi' | 'opencode') => boolean;
  /**
   * v1.6.0 — If a finite positive integer is provided, all 5 CLI configs are
   * written in HTTP-daemon mode (`http://127.0.0.1:<port>/mcp`). Omit or pass
   * an invalid value to get the default stdio mode.
   */
  port?: number;
}

export interface WorkspaceMcpWriteResult {
  claude: string | null;
  codex: string | null;
  gemini: string | null;
  /** v1.3.5 — null when Kimi CLI isn't detected and no existing config file. */
  kimi: string | null;
  /** v1.3.5 — null when OpenCode CLI isn't detected and no existing config file. */
  opencode: string | null;
  /**
   * R-2 — Cursor's `<workspaceRoot>/.cursor/mcp.json`. Workspace-scoped JSON
   * with the same `mcpServers` shape as Claude's `.mcp.json`, so it is written
   * unconditionally (like claude/codex/gemini) — no PATH-detection gate.
   */
  cursor: string | null;
  refused: string[];
}

interface RufloServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Resolved transport config passed to all write helpers after opts normalization. */
interface WriteContext {
  server: RufloServer;
  /** Undefined → stdio mode. Defined → HTTP mode on this port. */
  port: number | undefined;
  refused: string[];
  logger: Pick<Console, 'warn'>;
}

export function writeWorkspaceMcpConfig(
  workspaceRoot: string,
  opts: WorkspaceMcpWriteOptions = {},
): WorkspaceMcpWriteResult {
  const root = path.resolve(workspaceRoot);
  const home = opts.homeDir ?? os.homedir();
  const logger = opts.logger ?? console;
  const detectCli = opts.detectCli ?? defaultDetectCli;
  const server = buildRufloServer(root);
  const refused: string[] = [];
  // v1.6.0 — validate port: must be a finite positive integer, otherwise stdio.
  const rawPort = opts.port;
  const port: number | undefined =
    typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0
      ? rawPort
      : undefined;

  const ctx: WriteContext = { server, port, refused, logger };

  const claudeTarget = path.join(root, '.mcp.json');
  const codexTarget = path.join(home, '.codex', 'config.toml');
  const geminiTarget = path.join(home, '.gemini', 'settings.json');
  const kimiTarget = path.join(home, '.kimi', 'mcp.json');
  const opencodeTarget = path.join(home, '.config', 'opencode', 'opencode.json');
  // R-2 — Cursor reads workspace-scoped `<root>/.cursor/mcp.json` (it also
  // honours `~/.cursor/mcp.json`, but we write the workspace-scoped file to
  // match the per-workspace isolation of Claude's `.mcp.json`). Same JSON
  // `mcpServers` shape as Claude, so writeJsonMcpFile handles it verbatim.
  const cursorTarget = path.join(root, '.cursor', 'mcp.json');

  // v1.3.5 — Kimi + OpenCode targets are gated by soft detection. If the user
  // doesn't have those CLIs installed AND no existing config file, skip
  // silently so we don't pollute their home dir with empty config dirs.
  const kimiActive = fs.existsSync(kimiTarget) || detectCli('kimi');
  const opencodeActive = fs.existsSync(opencodeTarget) || detectCli('opencode');

  const customEntries: string[] = [];
  if (hasCustomJsonRufloEntry(claudeTarget)) customEntries.push(claudeTarget);
  if (hasCustomTomlRufloEntry(codexTarget)) customEntries.push(codexTarget);
  if (hasCustomJsonRufloEntry(geminiTarget)) customEntries.push(geminiTarget);
  if (kimiActive && hasCustomJsonRufloEntry(kimiTarget)) customEntries.push(kimiTarget);
  if (opencodeActive && hasCustomOpencodeRufloEntry(opencodeTarget)) {
    customEntries.push(opencodeTarget);
  }
  // R-2 — refuse to clobber a user-managed cursor ruflo entry, same as claude.
  if (hasCustomJsonRufloEntry(cursorTarget)) customEntries.push(cursorTarget);

  if (customEntries.length > 0) {
    refused.push(...customEntries);
    logger.warn(
      `[ruflo] skipped MCP autowrite; user-managed ruflo entries exist in ${customEntries.join(
        ', ',
      )}`,
    );
    return {
      claude: null,
      codex: null,
      gemini: null,
      kimi: null,
      opencode: null,
      cursor: null,
      refused,
    };
  }

  const claude = writeJsonMcpFile({ target: claudeTarget, ctx });
  const codex = writeCodexToml({ target: codexTarget, ctx });
  const gemini = writeJsonMcpFile({ target: geminiTarget, ctx });
  const kimi = kimiActive ? writeJsonMcpFile({ target: kimiTarget, ctx }) : null;
  const opencode = opencodeActive ? writeOpencodeMcpFile({ target: opencodeTarget, ctx }) : null;
  // R-2 — cursor's `.cursor/mcp.json` uses the same JSON `mcpServers` shape as
  // Claude, so the same writer handles stdio + HTTP-daemon modes verbatim.
  const cursor = writeJsonMcpFile({ target: cursorTarget, ctx });

  // B3 — autowrite the memory-convention block into workspace-root CLAUDE.md.
  // Best-effort: never throws out of writeWorkspaceMcpConfig.
  try {
    writeRufloConventionBlock(root, ctx);
  } catch (err) {
    logger.warn(`[ruflo] writeRufloConventionBlock failed (non-fatal): ${String(err)}`);
  }

  return { claude, codex, gemini, kimi, opencode, cursor, refused };
}

function buildRufloServer(workspaceRoot: string): RufloServer {
  return {
    command: RUFLO_COMMAND,
    args: [...RUFLO_ARGS],
    env: {
      CLAUDE_FLOW_DIR: path.join(workspaceRoot, '.claude-flow'),
    },
  };
}

function writeJsonMcpFile(args: { target: string; ctx: WriteContext }): string | null {
  const { target, ctx } = args;
  const { server, port, refused, logger } = ctx;
  let doc: JsonObject = {};
  if (fs.existsSync(target)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (isPlainObject(parsed)) {
        doc = parsed;
      } else {
        warnRefusal(refused, logger, target, 'existing JSON root is not an object');
        return null;
      }
    } catch {
      warnRefusal(refused, logger, target, 'existing JSON could not be parsed');
      return null;
    }
  }

  const mcpServers = isPlainObject(doc.mcpServers) ? doc.mcpServers : {};
  const existing = mcpServers[RUFLO_SERVER_NAME];
  if (existing !== undefined && !isManagedRufloEntry(existing)) {
    warnRefusal(refused, logger, target, 'existing ruflo entry is user-managed');
    return null;
  }

  mcpServers[RUFLO_SERVER_NAME] =
    port !== undefined ? buildHttpEntry(port) : mergeRufloEntry(existing, server);
  doc.mcpServers = mcpServers;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, JSON.stringify(doc, null, 2) + '\n');
  return target;
}

function writeCodexToml(args: { target: string; ctx: WriteContext }): string | null {
  const { target, ctx } = args;
  const { server, port, refused, logger } = ctx;
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const ranges = findTomlTableRanges(existing, 'mcp_servers.ruflo');
  const mainRange = ranges.find((range) => range.header === 'mcp_servers.ruflo');

  if (ranges.length > 0) {
    const mainBlock = mainRange ? existing.slice(mainRange.start, mainRange.end) : '';
    if (!isManagedTomlRufloBlock(mainBlock)) {
      warnRefusal(refused, logger, target, 'existing ruflo TOML entry is user-managed');
      return null;
    }
  }

  const block =
    port !== undefined ? renderCodexHttpBlock(port) : renderCodexRufloBlock(server);
  const next = replaceTomlTables(existing, ranges, block);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, next);
  return target;
}

// v1.3.5 — OpenCode uses a fundamentally different schema:
//   - top-level key is `mcp` (not `mcpServers`)
//   - entry is { type: 'local', command: <flat-array>, environment: {...}, enabled: true }
//   - command is a single array (no separate args field)
//   - env-vars key is `environment` not `env`
// We preserve user-set `enabled: false`, `timeout`, and other arbitrary keys
// via shallow merge. The `$schema` top-level key is preserved verbatim if set.
//
// v1.6.0 — HTTP mode uses { type: 'http', url, enabled: true }. OpenCode's
// published JSON schema uses `type: "http"` for HTTP transports (not "remote").
function writeOpencodeMcpFile(args: { target: string; ctx: WriteContext }): string | null {
  const { target, ctx } = args;
  const { server, port, refused, logger } = ctx;
  let doc: JsonObject = {};
  if (fs.existsSync(target)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (isPlainObject(parsed)) {
        doc = parsed;
      } else {
        warnRefusal(refused, logger, target, 'existing JSON root is not an object');
        return null;
      }
    } catch {
      warnRefusal(refused, logger, target, 'existing JSON could not be parsed');
      return null;
    }
  }

  const mcp = isPlainObject(doc.mcp) ? doc.mcp : {};
  const existing = mcp[RUFLO_SERVER_NAME];
  if (existing !== undefined && !isManagedOpencodeRufloEntry(existing)) {
    warnRefusal(refused, logger, target, 'existing ruflo OpenCode entry is user-managed');
    return null;
  }

  mcp[RUFLO_SERVER_NAME] =
    port !== undefined
      ? buildOpencodeHttpEntry(port)
      : mergeOpencodeRufloEntry(existing, server);
  doc.mcp = mcp;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, JSON.stringify(doc, null, 2) + '\n');
  return target;
}

function mergeRufloEntry(existing: unknown, server: RufloServer): RufloServer & JsonObject {
  const previous = isPlainObject(existing) ? existing : {};
  const previousEnv = normalizeStringRecord(previous.env);
  // Strip HTTP-only fields (url) so that self-healing HTTP → stdio is clean.
  const { url: _url, ...rest } = previous;
  void _url;
  return {
    ...rest,
    command: server.command,
    args: [...server.args],
    env: {
      ...previousEnv,
      ...server.env,
    },
  };
}

function mergeOpencodeRufloEntry(existing: unknown, server: RufloServer): JsonObject {
  const previous = isPlainObject(existing) ? existing : {};
  const previousEnv = normalizeStringRecord(previous.environment);
  // Strip HTTP-only fields so self-heal HTTP → stdio is clean.
  const { url: _url, ...rest } = previous;
  void _url;
  return {
    ...rest,
    type: 'local',
    command: [server.command, ...server.args],
    environment: {
      ...previousEnv,
      ...server.env,
    },
    enabled: typeof previous.enabled === 'boolean' ? previous.enabled : true,
  };
}

// ─── HTTP entry builders (v1.6.0) ───────────────────────────────────────────

/**
 * Claude / Gemini / Kimi HTTP entry — `{ url: "http://127.0.0.1:<port>/mcp" }`.
 * URL alone implies HTTP transport per Claude's MCP schema; no command/args/env.
 */
function buildHttpEntry(port: number): JsonObject {
  return { url: `http://127.0.0.1:${port}/mcp` };
}

/**
 * OpenCode HTTP entry — `{ type: "http", url, enabled: true }`.
 * Daemon env is set by supervisor at spawn time, not per-CLI config.
 */
function buildOpencodeHttpEntry(port: number): JsonObject {
  return { type: 'http', url: `http://127.0.0.1:${port}/mcp`, enabled: true };
}

// ────────────────────────────────────────────────────────────────────────────

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** Regex matching Ruflo-managed HTTP localhost MCP endpoints (v1.6+). */
const RUFLO_HTTP_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/mcp$/;

/**
 * Returns true for entries written by this module — both stdio (v1.3.5+) and
 * HTTP-daemon (v1.6+) shapes. User-managed entries (different command / remote
 * URL) return false so we refuse to clobber them.
 */
function isManagedRufloEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  if (entry.command === RUFLO_COMMAND) return true; // stdio (v1.3.5+)
  if (typeof entry.url === 'string' && RUFLO_HTTP_URL_RE.test(entry.url)) {
    return true; // HTTP daemon (v1.6+) — localhost only
  }
  return false;
}

/**
 * Returns true for OpenCode entries written by this module — both stdio
 * (v1.3.5+, array command starting with 'npx') and HTTP-daemon (v1.6+) shapes.
 */
function isManagedOpencodeRufloEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const cmd = entry.command;
  if (Array.isArray(cmd) && cmd[0] === RUFLO_COMMAND) return true; // stdio
  if (entry.type === 'http' && typeof entry.url === 'string' && RUFLO_HTTP_URL_RE.test(entry.url)) {
    return true; // HTTP daemon (v1.6+)
  }
  return false;
}

function hasCustomJsonRufloEntry(target: string): string | null {
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) return null;
    const entry = parsed.mcpServers[RUFLO_SERVER_NAME];
    return entry !== undefined && !isManagedRufloEntry(entry) ? target : null;
  } catch {
    return null;
  }
}

function hasCustomTomlRufloEntry(target: string): string | null {
  if (!fs.existsSync(target)) return null;
  const source = fs.readFileSync(target, 'utf8');
  const ranges = findTomlTableRanges(source, 'mcp_servers.ruflo');
  if (ranges.length === 0) return null;
  const mainRange = ranges.find((range) => range.header === 'mcp_servers.ruflo');
  const mainBlock = mainRange ? source.slice(mainRange.start, mainRange.end) : '';
  return isManagedTomlRufloBlock(mainBlock) ? null : target;
}

function hasCustomOpencodeRufloEntry(target: string): string | null {
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.mcp)) return null;
    const entry = parsed.mcp[RUFLO_SERVER_NAME];
    return entry !== undefined && !isManagedOpencodeRufloEntry(entry) ? target : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function renderCodexRufloBlock(server: RufloServer): string {
  return [
    '[mcp_servers.ruflo]',
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    '',
    '[mcp_servers.ruflo.env]',
    `CLAUDE_FLOW_DIR = ${JSON.stringify(server.env.CLAUDE_FLOW_DIR)}`,
    '',
  ].join('\n');
}

/**
 * v1.6.0 — Codex HTTP-daemon block. No env sub-table; daemon env is set by
 * supervisor at spawn time.
 */
function renderCodexHttpBlock(port: number): string {
  return [
    '[mcp_servers.ruflo]',
    'transport = "http"',
    `url = "http://127.0.0.1:${port}/mcp"`,
    '',
  ].join('\n');
}

/**
 * Returns true if the TOML block is one written by this module: either a
 * stdio block (has `command = "npx"`) or an HTTP-daemon block (has
 * `transport = "http"` + a managed localhost url).
 */
function isManagedTomlRufloBlock(block: string): boolean {
  if (parseTomlStringValue(block, 'command') === RUFLO_COMMAND) return true;
  if (parseTomlStringValue(block, 'transport') === 'http') {
    const url = parseTomlStringValue(block, 'url');
    return typeof url === 'string' && RUFLO_HTTP_URL_RE.test(url);
  }
  return false;
}

interface TomlTableRange {
  header: string;
  start: number;
  end: number;
}

function findTomlTableRanges(source: string, tablePrefix: string): TomlTableRange[] {
  const headerRe = /^\s*\[([^\]]+)\]\s*$/gm;
  const headers: Array<{ header: string; start: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(source))) {
    headers.push({
      header: match[1].trim(),
      start: match.index,
    });
  }

  const ranges: TomlTableRange[] = [];
  for (let i = 0; i < headers.length; i += 1) {
    const current = headers[i];
    if (current.header !== tablePrefix && !current.header.startsWith(`${tablePrefix}.`)) {
      continue;
    }
    ranges.push({
      header: current.header,
      start: current.start,
      end: i + 1 < headers.length ? headers[i + 1].start : source.length,
    });
  }
  return ranges;
}

// Hardcoded per-key regexes avoid the dynamic RegExp() ReDoS risk.
// Only the three TOML keys this module queries are represented here.
const TOML_STRING_RE: Readonly<Record<string, RegExp>> = {
  command: /^\s*command\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/m,
  transport: /^\s*transport\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/m,
  url: /^\s*url\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/m,
};

function parseTomlStringValue(source: string, key: string): string | null {
  const re = TOML_STRING_RE[key];
  if (re === undefined) return null;
  const m = re.exec(source);
  return m ? (m[1] ?? m[2] ?? '') : null;
}

function replaceTomlTables(source: string, ranges: TomlTableRange[], replacement: string): string {
  let next = source;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, range.start) + next.slice(range.end);
  }
  next = next.trimEnd();
  return next.length > 0 ? `${next}\n\n${replacement}` : replacement;
}

function warnRefusal(
  refused: string[],
  logger: Pick<Console, 'warn'>,
  target: string,
  reason: string,
): void {
  refused.push(target);
  logger.warn(`[ruflo] skipped MCP autowrite for ${target}: ${reason}`);
}

function writeFileAtomic(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

// v1.3.5 — PATH-or-`.cmd` probe for Kimi / OpenCode CLI binaries. Used to
// decide whether to write `~/.kimi/mcp.json` and `~/.config/opencode/opencode.json`
// for users who don't have those CLIs installed.
function defaultDetectCli(name: 'kimi' | 'opencode'): boolean {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  const candidates =
    process.platform === 'win32'
      ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
      : [name];
  for (const dir of pathEntries) {
    if (!dir) continue;
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(path.join(dir, candidate))) return true;
      } catch {
        /* PATH entry inaccessible — ignore */
      }
    }
  }
  return false;
}

// ─── B3: writeRufloConventionBlock ───────────────────────────────────────────

/**
 * Reads (or creates) `<workspaceRoot>/CLAUDE.md` and inserts/replaces the
 * managed `ruflo-memory-convention` block between its HTML-comment markers.
 *
 * Idempotent: a second call with identical managed content produces a
 * byte-identical file.
 *
 * Refusal: if the existing block between the markers contains the
 * `ruflo-memory-convention:user` opt-out marker the file is left untouched
 * and the path is pushed onto `ctx.refused`.
 */
function writeRufloConventionBlock(workspaceRoot: string, ctx: WriteContext): void {
  const { refused, logger } = ctx;
  const target = path.join(workspaceRoot, 'CLAUDE.md');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

  const startIdx = existing.indexOf(CONVENTION_BLOCK_START);
  const endIdx = existing.indexOf(CONVENTION_BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Block already present — check for user opt-out.
    const blockInterior = existing.slice(
      startIdx + CONVENTION_BLOCK_START.length,
      endIdx,
    );
    if (blockInterior.includes(CONVENTION_BLOCK_USER_MARKER)) {
      warnRefusal(refused, logger, target, 'user-owned ruflo-memory-convention block (opt-out marker present)');
      return;
    }

    // Replace the managed block (start marker through end marker inclusive).
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + CONVENTION_BLOCK_END.length);
    const next = before + RUFLO_CONVENTION_BLOCK_CONTENT + after;
    if (next === existing) return; // already identical — skip atomic write
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, next);
    return;
  }

  // No markers present — append the block (with a blank separator line).
  const separator = existing.length > 0 && !existing.endsWith('\n\n') ? '\n\n' : '';
  const trailingNewline = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const next =
    existing.length === 0
      ? RUFLO_CONVENTION_BLOCK_CONTENT + '\n'
      : existing + trailingNewline + separator + RUFLO_CONVENTION_BLOCK_CONTENT + '\n';
  if (next === existing) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, next);
}
