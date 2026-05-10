// V3-W13-013 — Bridge Assistant tool registry. Ten canonical tools per
// PRODUCT_SPEC §3.10. Each delegates into an existing controller.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDb } from '../db/client';
import {
  agentSessions,
  swarmAgents,
  workspaces as workspacesTable,
} from '../db/schema';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import type { SwarmMailbox } from '../swarms/mailbox';
import type { MemoryManager } from '../memory/manager';
import type { TasksManager } from '../tasks/manager';
import type { BrowserManagerRegistry } from '../browser/manager';
import type { LaunchPlan, RoleAssignment, SwarmPreset } from '../../../shared/types';
import { executeLaunchPlan } from '../workspaces/launcher';
import { createSwarm, listSwarmsForWorkspace } from '../swarms/factory';
import { formatBroadcast, formatRollCall } from '../swarms/protocol';
import { defaultRoster } from '../swarms/types';

export interface ToolContext {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
  memory: MemoryManager;
  tasks: TasksManager;
  browserRegistry: BrowserManagerRegistry;
  defaultWorkspaceId: string | null;
  userDataDir: string;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parse: (raw: unknown) => Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

const pickPreset = (n: number): LaunchPlan['preset'] =>
  n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : 6;

function requireWs(ctx: ToolContext, explicit: string | undefined, label: string): string {
  const wsId = explicit ?? ctx.defaultWorkspaceId;
  if (!wsId) throw new Error(`${label}: workspaceId required`);
  return wsId;
}

const T = <S extends z.ZodTypeAny>(
  id: string,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  schema: S,
  handler: (a: z.infer<S>, ctx: ToolContext) => Promise<unknown>,
): ToolDefinition => ({
  id,
  name,
  description,
  inputSchema,
  parse: (raw) => schema.parse(raw) as Record<string, unknown>,
  handler: (raw, ctx) => handler(raw as z.infer<S>, ctx),
});

// ── Schemas ───────────────────────────────────────────────────────────────
const sLaunchPane = z.object({
  workspaceRoot: z.string().min(1),
  provider: z.string().min(1),
  count: z.number().int().min(1).max(8).optional(),
  initialPrompt: z.string().optional(),
});
const sPromptAgent = z.object({ sessionId: z.string().min(1), prompt: z.string() });
const sReadFiles = z.object({
  paths: z.array(z.string().min(1)).min(1).max(32),
  maxBytes: z.number().int().positive().max(2_000_000).optional(),
});
const sOpenUrl = z.object({ url: z.string().min(1), workspaceId: z.string().optional() });
const sCreateTask = z.object({
  workspaceId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  labels: z.array(z.string()).optional(),
});
const sCreateSwarm = z.object({
  workspaceId: z.string().optional(),
  mission: z.string().min(1),
  preset: z.enum(['squad', 'team', 'platoon', 'battalion', 'custom']),
  name: z.string().optional(),
});
const sCreateMemory = z.object({
  workspaceId: z.string().optional(),
  name: z.string().min(1),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const sSearchMemories = z.object({
  workspaceId: z.string().optional(),
  query: z.string(),
  limit: z.number().int().min(1).max(50).optional(),
});
const sBroadcast = z.object({ swarmId: z.string().min(1), body: z.string().min(1) });
const sRollCall = z.object({
  swarmId: z.string().optional(),
  workspaceId: z.string().optional(),
});
const sListActiveSessions = z.object({ workspaceId: z.string().optional() });
const sListSwarms = z.object({ workspaceId: z.string().optional() });
const sListWorkspaces = z.object({});

function cwdLooksInsideWorkspace(
  cwd: string,
  ws: typeof workspacesTable.$inferSelect | undefined,
): boolean {
  if (!ws) return false;
  const roots = [ws.rootPath, ws.repoRoot].filter((r): r is string => Boolean(r));
  return roots.some((root) => {
    const rel = path.relative(root, cwd);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

// ── Tools ─────────────────────────────────────────────────────────────────
export const TOOLS: ToolDefinition[] = [
  T(
    'launch_pane',
    'Launch pane',
    'Spawn one or more agent panes in the active workspace.',
    {
      type: 'object',
      required: ['workspaceRoot', 'provider'],
      properties: {
        workspaceRoot: { type: 'string' },
        provider: { type: 'string' },
        count: { type: 'number', minimum: 1, maximum: 8 },
        initialPrompt: { type: 'string' },
      },
    },
    sLaunchPane,
    async (a, ctx) => {
      const count = a.count ?? 1;
      const plan: LaunchPlan = {
        workspaceRoot: a.workspaceRoot,
        preset: pickPreset(count),
        panes: Array.from({ length: count }, (_, i) => ({
          paneIndex: i,
          providerId: a.provider,
          initialPrompt: a.initialPrompt,
        })),
      };
      const out = await executeLaunchPlan(plan, {
        pty: ctx.pty,
        worktreePool: ctx.worktreePool,
      });
      return { sessionIds: out.sessions.map((s) => s.id), sessions: out.sessions };
    },
  ),
  T(
    'prompt_agent',
    'Prompt agent',
    'Type a prompt into an existing PTY session.',
    {
      type: 'object',
      required: ['sessionId', 'prompt'],
      properties: { sessionId: { type: 'string' }, prompt: { type: 'string' } },
    },
    sPromptAgent,
    async (a, ctx) => {
      ctx.pty.write(a.sessionId, a.prompt + '\n');
      return { ok: true };
    },
  ),
  T(
    'read_files',
    'Read files',
    'Read up to 32 files from disk (UTF-8, capped per file).',
    {
      type: 'object',
      required: ['paths'],
      properties: {
        paths: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        maxBytes: { type: 'number' },
      },
    },
    sReadFiles,
    async (a) => {
      const cap = a.maxBytes ?? 65_536;
      const files: Array<{ path: string; ok: boolean; content?: string; error?: string }> = [];
      for (const p of a.paths) {
        try {
          if (!fs.existsSync(p)) {
            files.push({ path: p, ok: false, error: 'not found' });
            continue;
          }
          const buf = fs.readFileSync(p);
          const slice = buf.length > cap ? buf.subarray(0, cap) : buf;
          files.push({
            path: p,
            ok: true,
            content: slice.toString('utf8'),
            ...(buf.length > cap ? { error: `truncated to ${cap} bytes` } : {}),
          });
        } catch (err) {
          files.push({
            path: p,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { files };
    },
  ),
  T(
    'open_url',
    'Open URL',
    'Open a URL in the active browser tab (creates one if missing).',
    {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string' }, workspaceId: { type: 'string' } },
    },
    sOpenUrl,
    async (a, ctx) => {
      const wsId = requireWs(ctx, a.workspaceId, 'open_url');
      const mgr = ctx.browserRegistry.get(wsId);
      const tabs = mgr.listTabs();
      const active = tabs.find((t) => t.active) ?? tabs[0];
      if (active) {
        await mgr.navigate(active.id, a.url);
        return { tabId: active.id };
      }
      const tab = await mgr.openTab(a.url);
      return { tabId: tab.id };
    },
  ),
  T(
    'create_task',
    'Create task',
    'Create a backlog task in the workspace kanban.',
    {
      type: 'object',
      required: ['title'],
      properties: {
        workspaceId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
    },
    sCreateTask,
    async (a, ctx) => {
      const wsId = requireWs(ctx, a.workspaceId, 'create_task');
      const task = ctx.tasks.create({
        workspaceId: wsId,
        title: a.title,
        description: a.description,
        labels: a.labels,
      });
      return { task };
    },
  ),
  T(
    'create_swarm',
    'Create swarm',
    'Spin up a swarm with a default roster for the chosen preset.',
    {
      type: 'object',
      required: ['mission', 'preset'],
      properties: {
        workspaceId: { type: 'string' },
        mission: { type: 'string' },
        preset: { type: 'string', enum: ['squad', 'team', 'platoon', 'battalion', 'custom'] },
        name: { type: 'string' },
      },
    },
    sCreateSwarm,
    async (a, ctx) => {
      const wsId = requireWs(ctx, a.workspaceId, 'create_swarm');
      const roster: RoleAssignment[] =
        a.preset === 'custom' ? [] : defaultRoster(a.preset as SwarmPreset);
      const swarm = await createSwarm(
        { workspaceId: wsId, mission: a.mission, preset: a.preset, name: a.name, roster },
        {
          pty: ctx.pty,
          worktreePool: ctx.worktreePool,
          mailbox: ctx.mailbox,
          userDataDir: ctx.userDataDir,
        },
      );
      return { swarm };
    },
  ),
  T(
    'create_memory',
    'Create memory',
    'Add a markdown memory note to the workspace memory hub.',
    {
      type: 'object',
      required: ['name'],
      properties: {
        workspaceId: { type: 'string' },
        name: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    sCreateMemory,
    async (a, ctx) => {
      const wsId = requireWs(ctx, a.workspaceId, 'create_memory');
      const memory = await ctx.memory.createMemory({
        workspaceId: wsId,
        name: a.name,
        body: a.body ?? '',
        tags: a.tags ?? [],
      });
      return { memory };
    },
  ),
  T(
    'search_memories',
    'Search memories',
    'Search the workspace memory hub for matching notes.',
    {
      type: 'object',
      required: ['query'],
      properties: {
        workspaceId: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    sSearchMemories,
    async (a, ctx) => {
      const wsId = requireWs(ctx, a.workspaceId, 'search_memories');
      const hits = await ctx.memory.searchMemories({
        workspaceId: wsId,
        query: a.query,
        limit: a.limit,
      });
      return { hits };
    },
  ),
  T(
    'broadcast_to_swarm',
    'Broadcast to swarm',
    'Send a broadcast message to every agent in a swarm.',
    {
      type: 'object',
      required: ['swarmId', 'body'],
      properties: { swarmId: { type: 'string' }, body: { type: 'string' } },
    },
    sBroadcast,
    async (a, ctx) => {
      const env = formatBroadcast(a.body);
      const m = await ctx.mailbox.append({
        swarmId: a.swarmId,
        fromAgent: 'operator',
        toAgent: env.toAgent,
        kind: env.kind,
        body: env.body,
      });
      return { messageId: m.id };
    },
  ),
  T(
    'roll_call',
    'Roll call',
    'Send ROLLCALL to one swarm (or every swarm in the workspace if `swarmId` is omitted).',
    {
      type: 'object',
      properties: { swarmId: { type: 'string' }, workspaceId: { type: 'string' } },
    },
    sRollCall,
    async (a, ctx) => {
      const env = formatRollCall();
      const targetIds: string[] = [];
      if (a.swarmId) targetIds.push(a.swarmId);
      else {
        const wsId = requireWs(ctx, a.workspaceId, 'roll_call');
        for (const s of listSwarmsForWorkspace(wsId)) targetIds.push(s.id);
      }
      const messageIds: string[] = [];
      for (const swarmId of targetIds) {
        try {
          const m = await ctx.mailbox.append({
            swarmId,
            fromAgent: 'operator',
            toAgent: env.toAgent,
            kind: env.kind,
            body: env.body,
            payload: env.payload,
          });
          messageIds.push(m.id);
        } catch {
          /* partial roll-calls still succeed */
        }
      }
      return { messageIds, swarmCount: targetIds.length };
    },
  ),
  T(
    'list_active_sessions',
    'List active sessions',
    'List live PTY sessions, optionally scoped to a workspace.',
    {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
    },
    sListActiveSessions,
    async (a, ctx) => {
      const wsId = a.workspaceId ?? ctx.defaultWorkspaceId ?? undefined;
      const db = getDb();
      const workspaces = db.select().from(workspacesTable).all();
      const ws = wsId ? workspaces.find((w) => w.id === wsId) : undefined;
      const sessionRows = db.select().from(agentSessions).all();
      const agentRows = db.select().from(swarmAgents).all();
      const sessionById = new Map(sessionRows.map((row) => [row.id, row]));
      const agentBySessionId = new Map(
        agentRows
          .filter((row) => row.sessionId)
          .map((row) => [row.sessionId as string, row]),
      );

      const sessions = ctx.pty
        .list()
        .map((rec, paneIndex) => ({ rec, paneIndex }))
        .filter(({ rec }) => rec.alive)
        .filter(({ rec }) => {
          if (!wsId) return true;
          const row = sessionById.get(rec.id);
          return row?.workspaceId === wsId || cwdLooksInsideWorkspace(rec.cwd, ws);
        })
        .map(({ rec, paneIndex }) => {
          const row = sessionById.get(rec.id);
          const agent = agentBySessionId.get(rec.id);
          return {
            sessionId: rec.id,
            provider: row?.providerEffective ?? row?.providerId ?? rec.providerId,
            status: rec.alive ? 'running' : row?.status ?? 'exited',
            agentKey: agent?.agentKey ?? null,
            swarmId: agent?.swarmId ?? null,
            paneIndex,
          };
        });
      return { sessions };
    },
  ),
  T(
    'list_swarms',
    'List swarms',
    'List swarms and role rosters for the active workspace.',
    {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
    },
    sListSwarms,
    async (a, ctx) => {
      const wsId = requireWs(ctx, a.workspaceId, 'list_swarms');
      const swarms = listSwarmsForWorkspace(wsId).map((swarm) => ({
        swarmId: swarm.id,
        name: swarm.name,
        status: swarm.status,
        agentCount: swarm.agents.length,
        roles: swarm.agents.map((agent) => ({
          agentKey: agent.agentKey,
          role: agent.role,
          status: agent.status,
          sessionId: agent.sessionId,
          provider: agent.providerId,
        })),
      }));
      return { swarms };
    },
  ),
  T(
    'list_workspaces',
    'List workspaces',
    'List known workspaces and mark the active assistant workspace.',
    {
      type: 'object',
      properties: {},
    },
    sListWorkspaces,
    async (_a, ctx) => {
      const rows = getDb()
        .select()
        .from(workspacesTable)
        .all()
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
      const fallbackActiveId = ctx.defaultWorkspaceId ?? rows[0]?.id ?? null;
      return {
        workspaces: rows.map((row) => ({
          id: row.id,
          name: row.name,
          rootPath: row.rootPath,
          active: row.id === fallbackActiveId,
        })),
      };
    },
  ),
];

const TOOL_ALIASES: Record<string, string> = {
  'memory.search': 'search_memories',
  'memory.create': 'create_memory',
  dispatch_pane: 'prompt_agent',
};

export const findTool = (name: string): ToolDefinition | null => {
  const id = TOOL_ALIASES[name] ?? name;
  return TOOLS.find((t) => t.id === id) ?? null;
};

export const publicTools = () =>
  TOOLS.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
