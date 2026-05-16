import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KV_RUFLO_AUTOWRITE_MCP = 'ruflo.autowriteMcp';

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
}

export interface WorkspaceMcpWriteResult {
  claude: string | null;
  codex: string | null;
  gemini: string | null;
  /** v1.3.5 — null when Kimi CLI isn't detected and no existing config file. */
  kimi: string | null;
  /** v1.3.5 — null when OpenCode CLI isn't detected and no existing config file. */
  opencode: string | null;
  refused: string[];
}

interface RufloServer {
  command: string;
  args: string[];
  env: Record<string, string>;
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

  const claudeTarget = path.join(root, '.mcp.json');
  const codexTarget = path.join(home, '.codex', 'config.toml');
  const geminiTarget = path.join(home, '.gemini', 'settings.json');
  const kimiTarget = path.join(home, '.kimi', 'mcp.json');
  const opencodeTarget = path.join(home, '.config', 'opencode', 'opencode.json');

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
      refused,
    };
  }

  const claude = writeJsonMcpFile({ target: claudeTarget, server, refused, logger });
  const codex = writeCodexToml({ target: codexTarget, server, refused, logger });
  const gemini = writeJsonMcpFile({ target: geminiTarget, server, refused, logger });
  const kimi = kimiActive
    ? writeJsonMcpFile({ target: kimiTarget, server, refused, logger })
    : null;
  const opencode = opencodeActive
    ? writeOpencodeMcpFile({ target: opencodeTarget, server, refused, logger })
    : null;

  return { claude, codex, gemini, kimi, opencode, refused };
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

function writeJsonMcpFile(args: {
  target: string;
  server: RufloServer;
  refused: string[];
  logger: Pick<Console, 'warn'>;
}): string | null {
  const { target, server, refused, logger } = args;
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

  mcpServers[RUFLO_SERVER_NAME] = mergeRufloEntry(existing, server);
  doc.mcpServers = mcpServers;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, JSON.stringify(doc, null, 2) + '\n');
  return target;
}

function writeCodexToml(args: {
  target: string;
  server: RufloServer;
  refused: string[];
  logger: Pick<Console, 'warn'>;
}): string | null {
  const { target, server, refused, logger } = args;
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const ranges = findTomlTableRanges(existing, 'mcp_servers.ruflo');
  const mainRange = ranges.find((range) => range.header === 'mcp_servers.ruflo');

  if (ranges.length > 0) {
    const mainBlock = mainRange ? existing.slice(mainRange.start, mainRange.end) : '';
    const command = parseTomlStringValue(mainBlock, 'command');
    if (command !== RUFLO_COMMAND) {
      warnRefusal(refused, logger, target, 'existing ruflo TOML entry is user-managed');
      return null;
    }
  }

  const next = replaceTomlTables(existing, ranges, renderCodexRufloBlock(server));
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
function writeOpencodeMcpFile(args: {
  target: string;
  server: RufloServer;
  refused: string[];
  logger: Pick<Console, 'warn'>;
}): string | null {
  const { target, server, refused, logger } = args;
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

  mcp[RUFLO_SERVER_NAME] = mergeOpencodeRufloEntry(existing, server);
  doc.mcp = mcp;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, JSON.stringify(doc, null, 2) + '\n');
  return target;
}

function mergeRufloEntry(existing: unknown, server: RufloServer): RufloServer & JsonObject {
  const previous = isPlainObject(existing) ? existing : {};
  const previousEnv = normalizeStringRecord(previous.env);
  return {
    ...previous,
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
  return {
    ...previous,
    type: 'local',
    command: [server.command, ...server.args],
    environment: {
      ...previousEnv,
      ...server.env,
    },
    enabled: typeof previous.enabled === 'boolean' ? previous.enabled : true,
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function isManagedRufloEntry(entry: unknown): boolean {
  return isPlainObject(entry) && entry.command === RUFLO_COMMAND;
}

function isManagedOpencodeRufloEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const command = entry.command;
  return Array.isArray(command) && command[0] === RUFLO_COMMAND;
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
  return parseTomlStringValue(mainBlock, 'command') === RUFLO_COMMAND ? null : target;
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

function parseTomlStringValue(source: string, key: string): string | null {
  const keyPattern = escapeRegExp(key);
  const re = new RegExp(`^\\s*${keyPattern}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*(?:#.*)?$`, 'm');
  const match = re.exec(source);
  return match ? (match[1] ?? match[2] ?? '') : null;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
