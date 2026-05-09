// RPC controller for the memory subsystem. Maps every method declared in
// `AppRouter['memory']` onto the underlying MemoryManager. The MCP server in
// `mcp-server.ts` forwards its JSON-RPC tool calls through these same
// methods so renderer & external agents stay perfectly in sync.

import { defineController } from '../../../shared/rpc';
import type {
  Memory,
  MemoryConnectionSuggestion,
  MemoryGraph,
  MemoryHubStatus,
  MemorySearchHit,
} from '../../../shared/types';
import type { MemoryManager } from './manager';
import type { MemoryMcpSupervisor } from './mcp-supervisor';

export interface MemoryControllerDeps {
  manager: MemoryManager;
  supervisor: MemoryMcpSupervisor;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`memory.${label}: missing or invalid string`);
  }
  return value;
}

export function buildMemoryController(deps: MemoryControllerDeps) {
  const m = deps.manager;
  return defineController({
    list_memories: async (input: { workspaceId: string }): Promise<Memory[]> => {
      return m.listMemories(requireString(input?.workspaceId, 'list_memories.workspaceId'));
    },
    read_memory: async (input: { workspaceId: string; name: string }): Promise<Memory | null> => {
      return m.readMemory(
        requireString(input?.workspaceId, 'read_memory.workspaceId'),
        requireString(input?.name, 'read_memory.name'),
      );
    },
    create_memory: async (input: {
      workspaceId: string;
      name: string;
      body?: string;
      tags?: string[];
    }): Promise<Memory> => {
      return m.createMemory({
        workspaceId: requireString(input?.workspaceId, 'create_memory.workspaceId'),
        name: requireString(input?.name, 'create_memory.name'),
        body: typeof input?.body === 'string' ? input.body : '',
        tags: Array.isArray(input?.tags) ? input.tags.filter((t) => typeof t === 'string') : [],
      });
    },
    update_memory: async (input: {
      workspaceId: string;
      name: string;
      body?: string;
      tags?: string[];
    }): Promise<Memory> => {
      return m.updateMemory({
        workspaceId: requireString(input?.workspaceId, 'update_memory.workspaceId'),
        name: requireString(input?.name, 'update_memory.name'),
        body: typeof input?.body === 'string' ? input.body : undefined,
        tags: Array.isArray(input?.tags) ? input.tags.filter((t) => typeof t === 'string') : undefined,
      });
    },
    append_to_memory: async (input: {
      workspaceId: string;
      name: string;
      text: string;
    }): Promise<Memory> => {
      return m.appendToMemory({
        workspaceId: requireString(input?.workspaceId, 'append_to_memory.workspaceId'),
        name: requireString(input?.name, 'append_to_memory.name'),
        text: requireString(input?.text, 'append_to_memory.text'),
      });
    },
    delete_memory: async (input: { workspaceId: string; name: string }): Promise<void> => {
      await m.deleteMemory({
        workspaceId: requireString(input?.workspaceId, 'delete_memory.workspaceId'),
        name: requireString(input?.name, 'delete_memory.name'),
      });
    },
    search_memories: async (input: {
      workspaceId: string;
      query: string;
      limit?: number;
    }): Promise<MemorySearchHit[]> => {
      return m.searchMemories({
        workspaceId: requireString(input?.workspaceId, 'search_memories.workspaceId'),
        query: typeof input?.query === 'string' ? input.query : '',
        limit: typeof input?.limit === 'number' ? input.limit : undefined,
      });
    },
    find_backlinks: async (input: {
      workspaceId: string;
      name: string;
    }): Promise<Memory[]> => {
      return m.findBacklinks({
        workspaceId: requireString(input?.workspaceId, 'find_backlinks.workspaceId'),
        name: requireString(input?.name, 'find_backlinks.name'),
      });
    },
    list_orphans: async (input: { workspaceId: string }): Promise<Memory[]> => {
      return m.listOrphans({
        workspaceId: requireString(input?.workspaceId, 'list_orphans.workspaceId'),
      });
    },
    suggest_connections: async (input: {
      workspaceId: string;
      name: string;
    }): Promise<MemoryConnectionSuggestion[]> => {
      return m.suggestConnections({
        workspaceId: requireString(input?.workspaceId, 'suggest_connections.workspaceId'),
        name: requireString(input?.name, 'suggest_connections.name'),
      });
    },
    init_hub: async (input: { workspaceId: string }): Promise<MemoryHubStatus> => {
      const status = await m.initHub(requireString(input?.workspaceId, 'init_hub.workspaceId'));
      // Lazily start the MCP child so spawned agents can find it.
      try {
        await deps.supervisor.start(status.workspaceId);
      } catch {
        /* non-fatal */
      }
      return status;
    },
    hub_status: async (input: { workspaceId: string }): Promise<MemoryHubStatus> => {
      return m.hubStatus(requireString(input?.workspaceId, 'hub_status.workspaceId'));
    },
    getGraph: async (input: { workspaceId: string }): Promise<MemoryGraph> => {
      return m.getGraph(requireString(input?.workspaceId, 'getGraph.workspaceId'));
    },
    getMcpCommand: async (input: {
      workspaceId: string;
    }): Promise<{ command: string; args: string[] } | null> => {
      const wsId = requireString(input?.workspaceId, 'getMcpCommand.workspaceId');
      return deps.supervisor.getCommandFor(wsId);
    },
  });
}
