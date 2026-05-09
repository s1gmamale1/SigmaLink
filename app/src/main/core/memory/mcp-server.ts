// Stdio MCP server for the SigmaLink Memory hub. This file is the entry
// point for the child process spawned by `mcp-supervisor.ts`. It speaks
// newline-delimited JSON-RPC 2.0 — the format used by MCP's stdio transport
// — over its own stdin/stdout. Diagnostics go to stderr only so they never
// pollute the wire.
//
// We did not pull in `@modelcontextprotocol/sdk` because:
//   1. The repo policy is to keep new deps to a minimum.
//   2. The set of methods we need (initialize, tools/list, tools/call) is
//      ~150 lines of boilerplate.
//   3. The supervisor injects two env vars — `SIGMALINK_DB_PATH` and
//      `SIGMALINK_WORKSPACE_ID` — which keep the child stateless except for
//      its DB handle. The full MCP SDK would not buy anything here.
//
// The server itself reaches into the SAME SQLite database the Electron main
// process uses; better-sqlite3 with WAL mode supports multi-process readers
// + a single writer at a time. The child performs short writes (atomic per
// transaction) so contention with the GUI is minimal. File writes go to the
// shared `<workspace>/.sigmamemory/` directory.

import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { initializeDatabase } from '../db/client';
import { MemoryManager } from './manager';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: 'list_memories',
    description: 'List every memory in the active workspace, newest first.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'read_memory',
    description: 'Read a memory by its name; returns null if missing.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_memory',
    description: 'Create a new memory with optional body and tag list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_memory',
    description: 'Replace the body and/or tags of an existing memory.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_to_memory',
    description: 'Append text to the end of a memory; creates it if missing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['name', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a memory and its on-disk file.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_memories',
    description: 'Token search across body + name; ranks title hits 4x.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_backlinks',
    description: 'Return every memory that contains [[name]] in its body.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_orphans',
    description: 'Return memories with no inbound or outbound links.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'suggest_connections',
    description: 'Co-tag heuristic ranking of related memories (max 10).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'init_hub',
    description: 'Ensure the .sigmamemory directory exists for the workspace.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'hub_status',
    description: 'Counts of memories / links / tags plus initialization flag.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

const PROTOCOL_VERSION = '2024-11-05';

async function main() {
  const dbPath = process.env.SIGMALINK_DB_PATH;
  const workspaceId = process.env.SIGMALINK_WORKSPACE_ID;
  const workspaceRoot = process.env.SIGMALINK_WORKSPACE_ROOT;
  if (!dbPath || !workspaceId || !workspaceRoot) {
    writeError(null, -32000, 'sigmamemory: missing SIGMALINK_DB_PATH / SIGMALINK_WORKSPACE_ID / SIGMALINK_WORKSPACE_ROOT');
    process.exit(1);
  }
  // The SQLite handle is opened lazily here. We share it with the GUI
  // process via the same .db file; WAL mode makes that safe.
  initializeDatabase(path.dirname(dbPath));
  const manager = new MemoryManager({
    emit: () => {
      // Child can't emit IPC events; the GUI is the only consumer of
      // memory:changed so we no-op here and rely on the GUI rescanning when
      // its window regains focus.
    },
    resolveWorkspaceRoot: (id) => (id === workspaceId ? workspaceRoot : null),
    resolveMcpCommand: () => null,
  });

  let pending = 0;
  let stdinClosed = false;
  const checkExit = () => {
    if (stdinClosed && pending === 0) {
      process.exit(0);
    }
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    pending += 1;
    handleLine(line, manager, workspaceId)
      .catch((err) => {
        writeStderr(
          'sigmamemory line handler crashed: ' + (err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => {
        pending -= 1;
        checkExit();
      });
  });
  rl.on('close', () => {
    stdinClosed = true;
    checkExit();
  });
}

async function handleLine(line: string, manager: MemoryManager, workspaceId: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch (err) {
    writeError(null, -32700, 'Parse error: ' + (err instanceof Error ? err.message : String(err)));
    return;
  }
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    writeError(req.id ?? null, -32600, 'Invalid Request');
    return;
  }
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case 'initialize':
        writeResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sigmamemory', version: '1.0.0' },
        });
        return;
      case 'initialized':
      case 'notifications/initialized':
        // notifications have no id and no response is required.
        return;
      case 'ping':
        writeResult(id, {});
        return;
      case 'tools/list':
        writeResult(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (typeof name !== 'string') {
          writeError(id, -32602, 'tools/call requires { name }');
          return;
        }
        const result = await invokeTool(manager, workspaceId, name, args);
        writeResult(id, {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
          isError: false,
        });
        return;
      }
      default:
        writeError(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeError(id, -32000, msg);
  }
}

async function invokeTool(
  manager: MemoryManager,
  workspaceId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const get = <T = unknown>(key: string): T => args[key] as T;
  switch (name) {
    case 'list_memories':
      return manager.listMemories(workspaceId);
    case 'read_memory':
      return manager.readMemory(workspaceId, String(get('name')));
    case 'create_memory':
      return manager.createMemory({
        workspaceId,
        name: String(get('name')),
        body: typeof args.body === 'string' ? args.body : '',
        tags: Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : [],
      });
    case 'update_memory':
      return manager.updateMemory({
        workspaceId,
        name: String(get('name')),
        body: typeof args.body === 'string' ? args.body : undefined,
        tags: Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : undefined,
      });
    case 'append_to_memory':
      return manager.appendToMemory({
        workspaceId,
        name: String(get('name')),
        text: String(get('text')),
      });
    case 'delete_memory':
      await manager.deleteMemory({ workspaceId, name: String(get('name')) });
      return { ok: true };
    case 'search_memories':
      return manager.searchMemories({
        workspaceId,
        query: String(get('query') ?? ''),
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
    case 'find_backlinks':
      return manager.findBacklinks({ workspaceId, name: String(get('name')) });
    case 'list_orphans':
      return manager.listOrphans({ workspaceId });
    case 'suggest_connections':
      return manager.suggestConnections({ workspaceId, name: String(get('name')) });
    case 'init_hub':
      return manager.initHub(workspaceId);
    case 'hub_status':
      return manager.hubStatus(workspaceId);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function writeResult(id: number | string | null, result: unknown): void {
  const payload: JsonRpcSuccess = { jsonrpc: '2.0', id, result };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function writeError(id: number | string | null, code: number, message: string, data?: unknown): void {
  const payload: JsonRpcError = { jsonrpc: '2.0', id, error: { code, message, data } };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function writeStderr(msg: string): void {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
}

main().catch((err) => {
  writeStderr('sigmamemory failed to start: ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
  process.exit(1);
});
