// V3-W13-013 — Sigma Assistant tool registry. Ten canonical tools per
// PRODUCT_SPEC §3.10. Each delegates into an existing controller.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
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
import type { LaunchPlan, Role, RoleAssignment, SwarmPreset } from '../../../shared/types';
import { executeLaunchPlan } from '../workspaces/launcher';
// v1.5.4-rollup-fold — reuse the v1.5.4-C-fixed pickPreset from controller.ts
// instead of maintaining a duplicate-and-buggy copy. The duplicate at line 46-47
// still returned `6` for n=7..8, leaving the MCP `launchPane` tool with the
// same invalid-LaunchPlan.preset gap that v1.5.4-C fixed in controller.ts.
import { pickPreset } from './controller';
import { addAgentToSwarm, createSwarm, listSwarmsForWorkspace } from '../swarms/factory';
import { formatBroadcast, formatRollCall } from '../swarms/protocol';
import { defaultRoster } from '../swarms/types';
// Wave-1 H-5 — the realpath-safe containment primitive R-1 first built here was
// promoted to the shared keystone in core/security/path-guard so the fs
// controller and this tool registry enforce containment identically (DRY).
import { assertAllowedPath, isInsideRoot } from '../security/path-guard';

export interface ToolContext {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
  memory: MemoryManager;
  tasks: TasksManager;
  browserRegistry: BrowserManagerRegistry;
  defaultWorkspaceId: string | null;
  userDataDir: string;
  /**
   * R-1 (Jorvis Telegram remote) — provenance of the turn that triggered this
   * tool call. `'local'` is the in-app operator (full trust, unchanged
   * behaviour); `'telegram'` is the remote Jorvis bridge, which must clear the
   * authorization gate in `invokeAssistantTool` before any DANGEROUS_REMOTE
   * tool runs. Defaults to `'local'` everywhere so every existing caller keeps
   * working without change.
   */
  origin?: 'local' | 'telegram';
  /**
   * R-1 — confirm-on-dangerous hook. Supplied by the remote bridge so the
   * authorization gate can ask the human operator to approve a dangerous tool
   * call out-of-band (e.g. a Telegram inline "Approve / Deny" button). Resolve
   * `true` to authorize, anything else to reject. Optional: when absent, the
   * gate treats a dangerous remote call as unapproved.
   */
  confirmDangerous?: (toolName: string, summary: string) => Promise<boolean>;
  /**
   * H-19 (full) — opportunistic ingestion scanner. Populated by the controller
   * from the aidefence gate as `(t,l) => gate.scanIngested(t,l)`. Tools that
   * pull untrusted text into the model's context (`read_files`,
   * `search_memories`) pass each item through this before returning it;
   * flagged content is coarse-redacted + annotated. ABSENT ⇒ tools skip
   * scanning and return content unchanged (full back-compat — every existing
   * caller keeps working). Never throws (the gate is opportunistic).
   */
  scanIngested?: (
    text: string,
    label: string,
  ) => Promise<{ text: string; flagged: boolean; reason?: string }>;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parse: (raw: unknown) => Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

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
const sAddAgent = z.object({
  swarmId: z.string().min(1),
  providerId: z.string().min(1),
  role: z.enum(['coordinator', 'builder', 'scout', 'reviewer']).optional(),
  initialPrompt: z.string().optional(),
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
const sMonitorPane = z.object({ sessionId: z.string().min(1), conversationId: z.string().min(1) });

function cwdLooksInsideWorkspace(
  cwd: string,
  ws: typeof workspacesTable.$inferSelect | undefined,
): boolean {
  if (!ws) return false;
  const roots = [ws.rootPath, ws.repoRoot].filter((r): r is string => Boolean(r));
  // shared `isInsideRoot(resolvedTarget, resolvedRoot)` — note the arg order:
  // target first, root second.
  return roots.some((root) => isInsideRoot(cwd, root));
}

/**
 * R-1 hardening — gather every directory a tool is allowed to read from: each
 * known workspace's `rootPath` + `repoRoot`, plus the git worktree pool dir for
 * each repo (worktrees live outside the repo root but are legitimately part of
 * the workspace). DB/registry failures degrade to an empty set (deny-all) so a
 * boot-time error can never silently widen the sandbox.
 */
function allowedReadRoots(ctx: ToolContext): string[] {
  const roots = new Set<string>();
  try {
    const rows = getDb().select().from(workspacesTable).all();
    for (const ws of rows) {
      if (ws.rootPath) roots.add(path.resolve(ws.rootPath));
      if (ws.repoRoot) {
        roots.add(path.resolve(ws.repoRoot));
        try {
          roots.add(path.resolve(ctx.worktreePool.poolPathForRepo(ws.repoRoot)));
        } catch {
          /* worktree pool unavailable — skip this repo's worktree dir */
        }
      }
    }
  } catch {
    /* DB unavailable — deny-all (empty set) rather than open the sandbox */
  }
  return [...roots];
}

/**
 * R-1 hardening — resolve `p` (following symlinks) and verify it sits inside
 * one of the allowed roots. Returns the resolved absolute path on success, or
 * `null` to reject. Delegates the realpath/symlink-safe containment to the
 * shared keystone (`assertAllowedPath`), which throws on rejection; `read_files`
 * wants a per-file `null` instead of throwing the whole batch, so we adapt the
 * throw into `null` here. Behaviour is identical to the previous private copy.
 */
function resolveInsideAllowedRoots(p: string, roots: string[]): string | null {
  try {
    return assertAllowedPath(p, roots);
  } catch {
    return null;
  }
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
    async (a, ctx) => {
      const cap = a.maxBytes ?? 65_536;
      // R-1 hardening — every requested path must resolve inside a known
      // workspace/worktree root (applies to ALL origins). Rejects traversal
      // (`../../../etc/passwd`), absolute escapes (`~/.ssh/id_rsa`), and
      // symlinks that point out of tree. Out-of-tree paths return a per-file
      // error rather than throwing so a single bad path can't fail the batch.
      const roots = allowedReadRoots(ctx);
      const files: Array<{
        path: string;
        ok: boolean;
        content?: string;
        error?: string;
        flagged?: boolean;
      }> = [];
      for (const p of a.paths) {
        try {
          const safePath = resolveInsideAllowedRoots(p, roots);
          if (!safePath) {
            files.push({ path: p, ok: false, error: 'path outside workspace' });
            continue;
          }
          if (!fs.existsSync(safePath)) {
            files.push({ path: p, ok: false, error: 'not found' });
            continue;
          }
          const buf = fs.readFileSync(safePath);
          const slice = buf.length > cap ? buf.subarray(0, cap) : buf;
          const content = slice.toString('utf8');
          // H-19 — opportunistic ingestion scan. Each file's content is checked
          // for prompt-injection BEFORE it reaches the model; flagged content is
          // coarse-redacted + annotated by the gate. Bounded by the existing
          // 32-file cap. No-op (unchanged content) when `scanIngested` is absent;
          // the gate never throws, so a scan failure can't fail this batch.
          const scan = ctx.scanIngested
            ? await ctx.scanIngested(content, p)
            : { text: content, flagged: false };
          files.push({
            path: p,
            ok: true,
            content: scan.text,
            ...(scan.flagged ? { flagged: true } : {}),
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
      // R-1 hardening — only https:// URLs may be opened (applies to ALL
      // origins). Rejects file:// (local-disk exfiltration), javascript: /
      // data: (script/markup injection into the embedded browser), and plain
      // http:// (downgrade). A malformed URL is rejected by `new URL`.
      let scheme: string;
      try {
        scheme = new URL(a.url).protocol;
      } catch {
        return { ok: false, error: 'invalid url' };
      }
      if (scheme !== 'https:') {
        return { ok: false, error: `unsupported url scheme: ${scheme} (https only)` };
      }
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
    'add_agent',
    'Add agent',
    'Add one agent pane to an existing running swarm, up to 20 agents.',
    {
      type: 'object',
      required: ['swarmId', 'providerId'],
      properties: {
        swarmId: { type: 'string' },
        providerId: { type: 'string' },
        role: { type: 'string', enum: ['coordinator', 'builder', 'scout', 'reviewer'] },
        initialPrompt: { type: 'string' },
      },
    },
    sAddAgent,
    async (a, ctx) => {
      const result = await addAgentToSwarm(
        {
          swarmId: a.swarmId,
          providerId: a.providerId,
          role: a.role as Role | undefined,
          initialPrompt: a.initialPrompt,
        },
        {
          pty: ctx.pty,
          worktreePool: ctx.worktreePool,
          mailbox: ctx.mailbox,
          userDataDir: ctx.userDataDir,
        },
      );
      return {
        sessionId: result.sessionId,
        paneIndex: result.paneIndex,
        agentKey: result.agentKey,
      };
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
      // H-19 — opportunistic ingestion scan. Each hit's `snippet` is untrusted
      // text pulled into the model's context, so we scan it for prompt-injection
      // BEFORE returning; flagged snippets are coarse-redacted + annotated by the
      // gate and carry a `flagged` marker. No-op when `scanIngested` is absent
      // (back-compat); the gate never throws. Bounded by the query `limit`.
      if (!ctx.scanIngested) return { hits };
      const scan = ctx.scanIngested;
      const scanned = await Promise.all(
        hits.map(async (h) => {
          const result = await scan(h.snippet, `memory:${h.id}`);
          return result.flagged
            ? { ...h, snippet: result.text, flagged: true }
            : { ...h, snippet: result.text };
        }),
      );
      return { hits: scanned };
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
  T(
    'monitor_pane',
    'Monitor pane',
    'Subscribe a Sigma conversation to lifecycle events from a PTY session (started, exited, error).',
    {
      type: 'object',
      required: ['sessionId', 'conversationId'],
      properties: {
        sessionId: { type: 'string' },
        conversationId: { type: 'string' },
      },
    },
    sMonitorPane,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async (a, _ctx) => {
      const db = getDb();
      db.update(agentSessions)
        .set({ jorvisMonitorConversationId: a.conversationId })
        .where(eq(agentSessions.id, a.sessionId))
        .run();
      return { ok: true };
    },
  ),
];

const TOOL_ALIASES: Record<string, string> = {
  'memory.search': 'search_memories',
  'memory.create': 'create_memory',
  dispatch_pane: 'prompt_agent',
};

/**
 * R-1 (Jorvis Telegram remote) — tools that are too dangerous to run
 * unattended from a remote origin and therefore require explicit human
 * confirmation when `origin === 'telegram'`. `prompt_agent` writes raw bytes
 * straight into a live PTY (it can type ANY shell command into an agent),
 * which is the single highest-blast-radius tool in the registry.
 *
 * Keyed by canonical tool *id* (post-alias). The authorization gate in
 * `invokeAssistantTool` resolves aliases before consulting this set.
 *
 * NOTE (cross-lane contract): the exact name `DANGEROUS_REMOTE` and the
 * membership `{ 'prompt_agent' }` are relied on by the Telegram-bridge lane.
 * Do not rename or change semantics without coordinating.
 */
export const DANGEROUS_REMOTE = new Set<string>(['prompt_agent']);

/**
 * R-1 — produce a short, human-readable one-liner describing a tool call, for
 * the confirm-on-dangerous prompt the operator sees in Telegram. Never throws
 * and never leaks large payloads (each value is truncated).
 */
export function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  try {
    for (const [key, value] of Object.entries(args ?? {})) {
      let rendered: string;
      if (typeof value === 'string') {
        rendered = value.length > 120 ? `${value.slice(0, 117)}…` : value;
      } else if (value === null || typeof value !== 'object') {
        rendered = String(value);
      } else {
        const json = JSON.stringify(value);
        rendered = json.length > 120 ? `${json.slice(0, 117)}…` : json;
      }
      parts.push(`${key}=${rendered}`);
    }
  } catch {
    /* fall through to the bare tool name */
  }
  return parts.length > 0 ? `${toolName}(${parts.join(', ')})` : `${toolName}()`;
}

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
