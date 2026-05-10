import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KV_RUFLO_AUTOWRITE_MCP = 'ruflo.autowriteMcp';

const RUFLO_SERVER_NAME = 'ruflo';
const RUFLO_COMMAND = 'npx';
const RUFLO_ARGS = ['@claude-flow/cli@latest', 'mcp-stdio'];

type JsonObject = Record<string, unknown>;

export interface WorkspaceMcpWriteOptions {
  homeDir?: string;
  logger?: Pick<Console, 'warn'>;
}

export interface WorkspaceMcpWriteResult {
  claude: string | null;
  codex: string | null;
  gemini: string | null;
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
  const server = buildRufloServer(root);
  const refused: string[] = [];
  const targets = {
    claude: path.join(root, '.mcp.json'),
    codex: path.join(home, '.codex', 'config.toml'),
    gemini: path.join(home, '.gemini', 'settings.json'),
  };
  const customEntries = [
    hasCustomJsonRufloEntry(targets.claude),
    hasCustomTomlRufloEntry(targets.codex),
    hasCustomJsonRufloEntry(targets.gemini),
  ].filter((target): target is string => Boolean(target));

  if (customEntries.length > 0) {
    refused.push(...customEntries);
    logger.warn(
      `[ruflo] skipped MCP autowrite; user-managed ruflo entries exist in ${customEntries.join(
        ', ',
      )}`,
    );
    return { claude: null, codex: null, gemini: null, refused };
  }

  const claude = writeJsonMcpFile({
    target: targets.claude,
    server,
    refused,
    logger,
  });
  const codex = writeCodexToml({
    target: targets.codex,
    server,
    refused,
    logger,
  });
  const gemini = writeJsonMcpFile({
    target: targets.gemini,
    server,
    refused,
    logger,
  });

  return { claude, codex, gemini, refused };
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

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function isManagedRufloEntry(entry: unknown): boolean {
  return isPlainObject(entry) && entry.command === RUFLO_COMMAND;
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
