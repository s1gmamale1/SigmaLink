import type Database from 'better-sqlite3';
import {
  profileAllowsMcp,
  type AgentRuntimeProfileId,
} from '../../../shared/runtime-profiles';
import type { RufloHttpDaemonSupervisor } from '../ruflo/http-daemon-supervisor';
import { writeRufloMcpIntoCwd, type WriteRufloIntoCwdResult } from './ruflo-worktree-mcp';
import { KV_RUFLO_AUTOTRUST_MCP, KV_RUFLO_AUTOWRITE_MCP } from './mcp-autowrite';

export type RufloMcpTransport = 'http' | 'stdio' | 'skipped';

export interface EnsureRufloMcpForPaneInput {
  cwd: string;
  workspaceId: string;
  workspaceRoot: string;
  runtimeProfileId: AgentRuntimeProfileId;
  rawDb: Pick<Database.Database, 'prepare'>;
  daemon: Pick<RufloHttpDaemonSupervisor, 'port' | 'spawn'>;
  writeRuflo?: (
    cwd: string,
    opts: { port?: number; trust?: boolean },
  ) => WriteRufloIntoCwdResult;
  logger?: Pick<Console, 'warn'>;
}

export interface EnsureRufloMcpForPaneResult {
  transport: RufloMcpTransport;
  port?: number;
  written: WriteRufloIntoCwdResult | null;
}

export async function ensureRufloMcpForPane(
  input: EnsureRufloMcpForPaneInput,
): Promise<EnsureRufloMcpForPaneResult> {
  if (!profileAllowsMcp(input.runtimeProfileId, 'ruflo')) {
    return { transport: 'skipped', written: null };
  }
  if (!readKvEnabled(input.rawDb, KV_RUFLO_AUTOWRITE_MCP, true)) {
    return { transport: 'skipped', written: null };
  }

  const trust = readKvEnabled(input.rawDb, KV_RUFLO_AUTOTRUST_MCP, true);
  const write = input.writeRuflo ?? writeRufloMcpIntoCwd;
  const logger = input.logger ?? console;

  let port = safePort(input.daemon.port(input.workspaceId));
  if (port === undefined) {
    try {
      const handle = await input.daemon.spawn(input.workspaceId, input.workspaceRoot);
      port = safePort(handle?.port ?? null);
    } catch (err) {
      logger.warn(
        `[ruflo-mcp] HTTP daemon unavailable for workspace ${input.workspaceId}; falling back to stdio: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const written = write(input.cwd, { port, trust });
  return {
    transport: port === undefined ? 'stdio' : 'http',
    port,
    written,
  };
}

function readKvEnabled(
  rawDb: Pick<Database.Database, 'prepare'>,
  key: string,
  defaultValue: boolean,
): boolean {
  try {
    const row = rawDb.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    if (row?.value === '0') return false;
    if (row?.value === '1' || row?.value === 'true') return true;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

function safePort(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
