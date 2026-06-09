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
  /**
   * B4 — honor the same gate as workspaces/factory.ts (ENABLE_RUFLO_HTTP_DAEMON).
   * The Ruflo HTTP daemon is upstream-broken; on Windows a bare `spawn('npx')`
   * ENOENTs and the supervisor then BLOCKS ~10s PER PANE waiting for health
   * before falling over to stdio. When false (the default) we skip the spawn
   * entirely and write stdio entries — removing the per-pane stall that made
   * a multi-pane workspace take minutes to open. Callers pass the gate value.
   */
  httpDaemonEnabled?: boolean;
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
  // B4: only attempt to spawn the per-workspace HTTP daemon when it is enabled.
  // While disabled (the default), spawning it per pane on Windows ENOENTs then
  // blocks ~10s waiting for health before falling over to stdio — multiplied by
  // every pane, that was the bulk of the multi-minute "workspace creation" lag.
  // Skipping straight to stdio (the working transport) removes that stall.
  if (port === undefined && input.httpDaemonEnabled) {
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
