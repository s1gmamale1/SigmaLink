// V1.1.9 — Private spawn helpers for the swarm factory.
//
// Extracted from `factory.ts` to keep the public-surface module under the
// 400-LOC limit. This module is INTERNAL — only `factory.ts` is expected to
// import from it. External callers (controller.ts, assistant/tools.ts) stay
// pinned to the `factory.ts` re-exports.
//
// Each helper here was relocated verbatim from `factory.ts`; the only changes
// are (a) imports trimmed to what these helpers actually use, and (b) the
// `SwarmFactoryDeps` type is re-imported from `./factory` so the spawn arg
// shapes continue to match the public contract.
//
// v1.4.5: `loadSwarm` migrated here from `factory.ts` so `factory-add-agent.ts`
// can read the final swarm state without a circular import.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import {
  agentSessions,
  swarms,
  swarmAgents,
  workspaces as workspacesTable,
} from '../db/schema';
import { findProvider, resolvePaneClosedAt } from '../../../shared/providers';
import { providerAcceptsModelFlag, listModelsFor } from '../../../shared/model-catalog';
import type { AgentSession, Role, Swarm, SwarmAgent } from '../../../shared/types';
import { agentKey as makeAgentKey } from './types';
import { envelopeToInsert, parseProtocolLine, ProtocolLineBuffer } from './protocol';
import { resolveAndSpawn } from '../providers/launcher';
import { withCodexSpawnLock, resolveCodexHome } from '../control/codex-spawn-lock';
import { resolveSpawnRendererMode } from '../pty/spawn-renderer-mode';
import type { SwarmFactoryDeps } from './factory';
import { workspaceCwdInWorktree } from '../workspaces/worktree-cwd';
import {
  ensureClaudeProjectDir,
  prepareClaudeWorkspaceContext,
} from '../pty/claude-resume-sigma';
import { writeGuardrailBlock } from '../workspaces/guardrail-block';
import { ensureRufloMcpForPane } from '../workspaces/ruflo-mcp-policy';
import { ENABLE_RUFLO_HTTP_DAEMON } from '../workspaces/factory';
import { getSharedDeps } from '../../rpc-router';
import { allocateLowestFreeLivePaneIndex } from '../workspaces/pane-slots';
import { isPtyCrash } from '../pty/crash';
import { maybeAutoCheckpoint } from '../git/auto-checkpoint';
import { readWorktreeMode } from '../workspaces/worktree-mode';
import { WorktreeDiskGuardError } from '../git/worktree';
import type { AddInput } from '../notifications/manager';
import { KV_PTY_SPAWN_MODE, effectivePaneSpawnMode, parseSpawnMode } from '../pty/local-pty';
import { applyTeardownPolicy } from './swarm-teardown';
import {
  normalizeAgentRuntimeProfileId,
  profileAllowsMcp,
  profileIsMcpHeavy,
  type AgentRuntimeProfileId,
} from '../../../shared/runtime-profiles';
import { writeMcpConfigForAgent } from '../browser/mcp-config-writer';
import { buildClaudeMcpLaunchArgs } from '../ram-brake/mcp-launch-mode';

/**
 * SF-15 — write the bundled `ruflo` MCP entry (+ claude trust) into a swarm
 * agent's worktree cwd before its CLI spawns. Reads the autowrite/autotrust KV
 * gates (default ON) and the live HTTP-daemon port (HTTP when present, stdio
 * otherwise). Fully fail-open: a missing/locked DB, an absent shared-deps
 * accessor, or a write failure can only degrade to stdio or no-op — it never
 * throws into the spawn path.
 */
async function ensureRufloInWorktreeCwd(
  cwd: string,
  wsRow: typeof workspacesTable.$inferSelect,
  runtimeProfileId: AgentRuntimeProfileId,
  providerId: string,
): Promise<number | undefined> {
  try {
    const shared = getSharedDeps();
    const result = await ensureRufloMcpForPane({
      cwd,
      workspaceId: wsRow.id,
      workspaceRoot: wsRow.repoRoot ?? wsRow.rootPath,
      runtimeProfileId,
      // SigmaLink Dev (2026-06-11) — thread the provider so the policy's
      // by-construction shell gate fires: a plain shell consumes no MCP
      // config, and for the dev workspace the pane cwd is the user's home
      // directory where writing config/trust is forbidden.
      providerId,
      rawDb: getRawDb(),
      daemon: shared?.rufloHttpDaemonSupervisor ?? {
        port: () => null,
        spawn: async () => null,
      },
      httpDaemonEnabled: ENABLE_RUFLO_HTTP_DAEMON,
    });
    return result.transport === 'http' ? result.port : undefined;
  } catch {
    /* MCP wiring is non-fatal — never block the spawn */
    return undefined;
  }
}

function readSpawnMode(): 'direct' | 'shell-first' {
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KV_PTY_SPAWN_MODE) as { value?: string } | undefined;
    return parseSpawnMode(row?.value ?? null);
  } catch {
    return 'direct';
  }
}

/**
 * Pick the coordinator that a newly-added agent should be assigned to.
 *
 * The "queen" is the first coordinator (the one whose `coordinatorId` is
 * NULL); other coordinators are peers that point back at the queen. For a
 * `custom`-preset swarm with no coordinator, this returns null.
 */
export function pickCoordinatorId(
  agentRows: Array<typeof swarmAgents.$inferSelect>,
  role: Role,
): string | null {
  const coordinators = agentRows.filter((a) => a.role === 'coordinator');
  if (coordinators.length === 0) return null;
  const queen = coordinators.find((a) => !a.coordinatorId) ?? coordinators[0];
  if (role === 'coordinator') return queen?.id ?? null;
  return queen?.id ?? null;
}

/**
 * Translate an `initialPrompt` into provider-specific CLI arguments.
 *
 * Providers may declare `oneshotArgs` (token list with `{prompt}` placeholder)
 * or a single `initialPromptFlag`. Providers that support neither fall back to
 * a delayed stdin write inside `spawnAgentSession`.
 */
export function buildExtraArgs(
  providerId: string,
  initialPrompt?: string,
  modelId?: string,
): string[] {
  const provider = findProvider(providerId);
  if (!provider) return [];
  // BSP-V2 — inject `--model <id>` for providers whose CLI accepts the flag
  // (claude / cursor / gemini per MODEL_FLAG_PROVIDERS). Audit 2026-06-10 —
  // ALSO allowlist against the shared catalog, restoring true parity with the
  // launcher twin (core/workspaces/launcher.ts buildExtraArgs, M1 review fix):
  // an unknown modelId is dropped silently (the CLI default applies). Spawn is
  // shell:false argv, but this is defense-in-depth at the renderer→spawn
  // boundary.
  const modelArgs: string[] =
    modelId &&
    providerAcceptsModelFlag(providerId) &&
    listModelsFor(providerId).some((m) => m.modelId === modelId)
      ? ['--model', modelId]
      : [];
  if (!initialPrompt) return modelArgs;
  if (provider.oneshotArgs && provider.oneshotArgs.length) {
    return [
      ...modelArgs,
      ...provider.oneshotArgs.map((tok) => tok.replace('{prompt}', initialPrompt)),
    ];
  }
  if (provider.initialPromptFlag) {
    return [...modelArgs, provider.initialPromptFlag, initialPrompt];
  }
  return modelArgs;
}

/**
 * Reload an `agent_sessions` row by id and map it into the shared
 * `AgentSession` shape that the renderer / RPC layer consumes.
 */
export function loadAgentSession(sessionId: string): AgentSession | null {
  const row = getDb()
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    cwd: row.cwd,
    branch: row.branch ?? null,
    status: row.status as AgentSession['status'],
    exitCode: row.exitCode ?? undefined,
    startedAt: row.startedAt,
    exitedAt: row.exitedAt ?? undefined,
    worktreePath: row.worktreePath ?? null,
    initialPrompt: row.initialPrompt ?? undefined,
    runtimeProfileId: normalizeAgentRuntimeProfileId(row.runtimeProfileId),
    // v1.4.3 #06 — surface split/minimised fields so the renderer can group
    // sub-panes into split cells and collapse minimised panes. Drizzle types
    // these as `string | null` / `number | null` / `number`; map nulls to
    // explicit nulls for the renderer's `?: string | null` contract.
    splitGroupId: row.splitGroupId ?? null,
    splitDirection: (row.splitDirection as AgentSession['splitDirection']) ?? null,
    splitIndex: row.splitIndex ?? null,
    minimised: !!row.minimised,
    // BSP-O4 — operator-supplied display name (migration 0036). Drizzle maps
    // the nullable TEXT column to `string | null`; both null and undefined are
    // normalised to null so the renderer receives a consistent shape.
    name: row.name ?? null,
  };
}

export interface SpawnAgentSessionArgs {
  wsRow: typeof workspacesTable.$inferSelect;
  swarmId: string;
  agentId: string;
  role: Role;
  roleIndex: number;
  providerId: string;
  baseRef?: string;
  agentKey: string;
  initialPrompt?: string;
  /** RAM Brake — per-agent MCP/tool profile. Defaults to `ruflo-core`. */
  runtimeProfileId?: AgentRuntimeProfileId;
  /** SF-8 — Yolo/Bypass: append the provider's autoApproveFlag at spawn. */
  autoApprove?: boolean;
  /**
   * BSP-V2 — per-spawn model id for the `+Pane` flow. Mirrors
   * `PaneAssignment.modelId` (launcher path). `buildExtraArgs` appends
   * `--model <id>` for providers that accept the flag. Undefined = provider default.
   */
  modelId?: string;
  /**
   * DEV-W5 — per-spawn worktree override. When `true`, skip worktree creation
   * regardless of the workspace's `worktreeMode` KV setting (in-place). When
   * `false`, force a worktree even if the workspace is in in-place mode. When
   * `undefined`, fall back to the workspace `worktreeMode` (legacy behavior).
   * The `worktreePathOverride` (splitPane) short-circuit takes precedence over
   * this flag — both skip the WorktreePool.create() call but for different
   * reasons (splitPane re-uses a parent worktree; skipWorktree=true skips it).
   */
  skipWorktree?: boolean;
  deps: SwarmFactoryDeps;
  /**
   * v1.4.3 #06 — when provided, skip the WorktreePool.create() call and use
   * the supplied worktree (the parent pane's). Pass `cwd` + `branch` together
   * so the new `agent_sessions` row mirrors the parent's geometry. All
   * legacy callers leave these undefined; only the splitPane RPC sets them.
   */
  worktreePathOverride?: string | null;
  cwdOverride?: string;
  branchOverride?: string | null;
}

/**
 * Spawn one swarm agent's PTY, persist its `agent_sessions` row, and wire its
 * stdout into the SIGMA:: protocol parser → mailbox pipeline.
 *
 * Returns the new session id and workspace pane slot on success. Throws if the
 * provider can't be resolved or the worktree allocator fails. Caller is
 * responsible for marking the corresponding `swarm_agents` row.
 */
export async function spawnAgentSession(
  args: SpawnAgentSessionArgs,
): Promise<{ sessionId: string; paneIndex: number }> {
  const runtimeProfileId = normalizeAgentRuntimeProfileId(args.runtimeProfileId);
  const provider = findProvider(args.providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${args.providerId}`);
  }

  const db = getDb();
  let worktreePath: string | null = null;
  let branch: string | null = null;
  // v1.5.5-A — pre-allocate session UUID before worktree creation so the
  // worktree suffix and agent_sessions.id are the same value.
  const preallocSessionId = randomUUID();
  let spawnSessionId: string = preallocSessionId;
  // v1.4.3 #06 — split sub-panes inherit the parent's worktree instead of
  // allocating a fresh one. WorktreePool.create() is the only place a new
  // git worktree is materialised; skipping it when the caller already has a
  // path means the two sub-panes are co-tenants on one git branch (intentional
  // design — see splitPane RPC handler for the worktree-share rationale).
  // DEV-W3b (ADR-007) — skip worktree allocation when in-place mode is active.
  // DEV-W5 — per-spawn `skipWorktree` override wins over the workspace default:
  //   skipWorktree=true  → in-place (no worktree) regardless of workspace mode
  //   skipWorktree=false → force worktree even when workspace is in in-place mode
  //   skipWorktree=undefined → fall back to workspace worktreeMode KV (legacy)
  // worktreePath stays null → workspaceCwdInWorktree returns wsRow.rootPath.
  // Preserve the worktreePathOverride short-circuit (splitPane) unchanged.
  const inPlace =
    args.skipWorktree !== undefined
      ? args.skipWorktree
      : readWorktreeMode(getRawDb(), args.wsRow.id) === 'in-place';
  if (args.worktreePathOverride !== undefined) {
    worktreePath = args.worktreePathOverride;
    branch = args.branchOverride ?? null;
  } else if (!inPlace && args.wsRow.repoMode === 'git' && args.wsRow.repoRoot) {
    const r = await args.deps.worktreePool.create({
      repoRoot: args.wsRow.repoRoot,
      role: args.role,
      hint: `${args.role}-${args.roleIndex}`,
      base: args.baseRef,
      sessionId: preallocSessionId,
    });
    worktreePath = r.worktreePath;
    branch = r.branch;
    // Use the sessionId actually used (may differ on retry).
    spawnSessionId = r.sessionId;
  }

  // C-9 — Write enabled guardrails into the worktree CLAUDE.md at dispatch.
  // Best-effort: never block the PTY spawn on a CLAUDE.md write failure.
  if (worktreePath) {
    try {
      const kvRow = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get('guardrails.enabled') as { value?: string } | undefined;
      const guardrailIds: string[] = kvRow?.value
        ? (JSON.parse(kvRow.value) as string[])
        : [];
      await writeGuardrailBlock(worktreePath, guardrailIds);
    } catch {
      /* guardrail write is non-fatal */
    }
  }

  const cwd =
    args.cwdOverride ??
    workspaceCwdInWorktree({
      workspaceRoot: args.wsRow.rootPath,
      repoRoot: args.wsRow.repoRoot,
      worktreePath,
    });
  // SF-15 — swarm-agent panes spawn in their own worktree cwd, which never
  // inherits the workspace-root ruflo MCP config/trust written at workspace
  // open. Write a managed `ruflo` entry (+ claude trust) into this pane's cwd
  // BEFORE the CLI spawns. HTTP mode when the per-workspace daemon has a live
  // port; stdio otherwise. Fail-open + opt-out aware — never blocks the spawn.
  try {
    const shared = getSharedDeps();
    // SigmaLink Dev (2026-06-11) — `provider.id !== 'shell'`: the default
    // ruflo-core profile never reaches this block (browser/sigmamemory/
    // security all disallowed), but a heavy profile (browser-tools etc.) on a
    // shell pane WOULD fire it and write config into the pane cwd — which for
    // the dev workspace is the user's home directory. Shell panes consume no
    // MCP config; skip outright.
    if (
      shared &&
      provider.id !== 'shell' &&
      (profileAllowsMcp(runtimeProfileId, 'browser') ||
        profileAllowsMcp(runtimeProfileId, 'sigmamemory') ||
        profileAllowsMcp(runtimeProfileId, 'security'))
    ) {
      const memRoot = args.wsRow.repoRoot ?? args.wsRow.rootPath;
      let memCmd: ReturnType<typeof shared.memorySupervisor.getCommandFor> | null = null;
      if (profileAllowsMcp(runtimeProfileId, 'sigmamemory')) {
        try {
          await shared.memorySupervisor.start(args.wsRow.id, memRoot);
        } catch {
          /* memory supervisor is non-fatal */
        }
        memCmd = shared.memorySupervisor.getCommandFor(args.wsRow.id);
      }
      writeMcpConfigForAgent({
        worktree: cwd,
        runtimeProfileId,
        memory: memCmd ?? undefined,
      });
    }
  } catch {
    /* Browser/SigmaMemory MCP wiring is non-fatal */
  }
  const rufloMcpPort = await ensureRufloInWorktreeCwd(cwd, args.wsRow, runtimeProfileId, provider.id);
  // V1.1: route swarm-agent spawns through the provider launcher façade so
  // SigmaCode→Claude fallback, altCommands ENOENT walk, and the legacy gate
  // all apply uniformly. Read `kv['providers.showLegacy']` defensively — if
  // the row is missing the default is "hidden".
  let showLegacy = false;
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get('providers.showLegacy') as { value?: string } | undefined;
    showLegacy = row?.value === '1' || row?.value === 'true';
  } catch {
    /* ignore — default to false */
  }
  // BSP-V2 — thread modelId so `+Pane` can dispatch with a preset model.
  let extraArgs = buildExtraArgs(provider.id, args.initialPrompt, args.modelId);
  if (provider.id === 'claude') {
    const mcpArgs = buildClaudeMcpLaunchArgs({
      mode: profileIsMcpHeavy(runtimeProfileId) ? 'inherit' : 'strict-core',
      rufloHttpUrl:
        rufloMcpPort !== undefined ? `http://127.0.0.1:${rufloMcpPort}/mcp` : undefined,
    });
    if (mcpArgs.length > 0) extraArgs = [...extraArgs, ...mcpArgs];
  }
  if (provider.id === 'claude') {
    await prepareClaudeWorkspaceContext(args.wsRow.rootPath, cwd);
    await ensureClaudeProjectDir(cwd);
  }
  const spawnMode = effectivePaneSpawnMode(
    readSpawnMode(),
    !!args.initialPrompt,
    !!(provider.oneshotArgs?.length),
    !!provider.initialPromptFlag,
  );
  const doSpawn = () =>
    resolveAndSpawn(
      { ptyRegistry: args.deps.pty },
      {
        providerId: provider.id,
        cwd,
        cols: args.deps.defaultCols ?? 120,
        rows: args.deps.defaultRows ?? 32,
        showLegacy,
        extraArgs,
        // SF-8 — Yolo/Bypass: buildArgs appends provider.autoApproveFlag when true.
        autoApprove: args.autoApprove ?? false,
        // v1.5.5-A — pass pre-allocated UUID via preassignedSessionId (NOT
        // sessionId) so registry.create uses it as the row id while keeping
        // isResume=false → onPostSpawnCapture fires for disk-scan providers
        // and shouldPreAssign still injects --session-id for claude/gemini.
        preassignedSessionId: spawnSessionId,
        // v1.5.5 — explicit: swarm agent spawns are always fresh (no sessionId).
        isResume: false,
        spawnMode,
        // P1c — resolve the renderer mode at spawn so claude's #160 fullscreen
        // injection is appended ONLY for xterm-mode panes (the DOM presenter
        // wants inline). Fresh swarm spawns have no per-session override yet, so
        // this resolves global default KV → shared DEFAULT_RENDERER_MODE.
        rendererMode: resolveSpawnRendererMode(getRawDb(), spawnSessionId),
      },
    );
  const spawnResult =
    provider.id === 'codex'
      ? await withCodexSpawnLock(resolveCodexHome(), () => Promise.resolve(doSpawn()))
      : doSpawn();
  const rec = spawnResult.ptySession;
  const effectiveProvider = findProvider(spawnResult.providerEffective) ?? provider;

  // Tag the agent_sessions row with the swarm so future rooms (Review, Tasks)
  // can correlate sessions to swarm agents.
  // SF-12 — swarm panes share the same workspace-level pane slot space as
  // launcher panes because both persist to agent_sessions(workspace_id,
  // pane_index). Allocate the lowest free slot among currently-live rows inside
  // the write transaction and persist it so +Pane/swarm panes can rehydrate.
  let paneIndex = -1;
  try {
    const insertSession = getRawDb().transaction(() => {
      paneIndex = allocateLowestFreeLivePaneIndex(getRawDb(), args.wsRow.id);
      db.insert(agentSessions)
        .values({
          id: rec.id,
          workspaceId: args.wsRow.id,
          providerId: provider.id,
          cwd,
          branch,
          worktreePath,
          status: 'running',
          initialPrompt: args.initialPrompt,
          runtimeProfileId,
          startedAt: rec.startedAt,
          externalSessionId: rec.externalSessionId,
          paneIndex,
          // SF-8 — persist Yolo on the session so resume re-applies the flag.
          autoApprove: args.autoApprove ? 1 : 0,
        })
        .run();
    });
    insertSession();
  } catch (insertErr) {
    const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
    if (/UNIQUE constraint failed/i.test(msg)) {
      console.warn(
        `[factory-spawn] UNIQUE violation on agent_sessions (ws=${args.wsRow.id}, agent=${args.agentKey}) — duplicate spawn suppressed`,
      );
      // H-10 (Wave-2 hardening): the PTY was spawned BEFORE this INSERT, so a
      // UNIQUE violation leaves an orphaned child process with no DB row and no
      // future kill path (killAll only walks the registry, and forget() during
      // the graceful window never runs for a row we never persisted). Tear it
      // down here — kill the child, then forget() to drop the registry record,
      // unsubscribe its data/exit listeners, and arm the SIGKILL fallback. Both
      // are best-effort and must never mask the original suppression.
      try {
        args.deps.pty.kill(rec.id);
      } catch {
        /* kill is best-effort — forget() below still escalates to SIGKILL */
      }
      try {
        args.deps.pty.forget(rec.id);
      } catch {
        /* never let cleanup throw out of the suppression branch */
      }
      // CRIT-1/CRIT-2: the worktree was created before this INSERT. A suppressed
      // spawn must not leak it (the 49 GB disk-fill class). Best-effort remove
      // + prune; never let cleanup throw out of the suppression branch.
      if (worktreePath && args.wsRow.repoRoot) {
        try {
          await args.deps.worktreePool.removeAndPrune(args.wsRow.repoRoot, worktreePath);
        } catch {
          /* best-effort — the boot sweep is the backstop */
        }
      }
      // The attempted slot did not persist. Keep the existing suppression
      // contract for session id, but do not report the rejected pane slot to
      // renderer toasts.
      return { sessionId: rec.id, paneIndex: -1 };
    }
    throw insertErr;
  }
  // BUG-V1.1-02: persist the launcher-resolved provider tag. The launcher
  // façade always records `providerEffective`, even when no comingSoon swap
  // occurred, so downstream queries don't have to special-case nulls.
  // Best-effort — column is added by migration 0010; older DBs swallow the
  // failure.
  try {
    getRawDb()
      .prepare('UPDATE agent_sessions SET provider_effective = ? WHERE id = ?')
      .run(spawnResult.providerEffective, rec.id);
  } catch {
    /* column may not exist yet — ignore */
  }

  // FEAT-11 fast-follow — auto-checkpoint-on-dispatch (swarm path). The
  // agent_sessions row now exists (FK target) and the worktree is resolved,
  // but the initial prompt has NOT been delivered yet — so this captures the
  // pre-dispatch state before the agent's first turn touches the tree. Gated
  // (KV, default OFF), change-checked, min-interval throttled, fully fail-open.
  await maybeAutoCheckpoint({ sessionId: rec.id, worktreePath });

  if (
    args.initialPrompt &&
    !effectiveProvider.oneshotArgs?.length &&
    !effectiveProvider.initialPromptFlag
  ) {
    setTimeout(() => {
      try {
        args.deps.pty.write(rec.id, args.initialPrompt + '\n');
      } catch {
        /* ignore */
      }
    }, 600);
  }

  // Wire SIGMA:: protocol. The PTY ring buffer continues to receive raw bytes
  // for live terminal rendering; we additionally split chunks by line and
  // route SIGMA:: matches into the mailbox.
  const buf = new ProtocolLineBuffer();
  rec.pty.onData((chunk) => {
    buf.push(chunk, (line) => {
      const parsed = parseProtocolLine(line);
      if (!parsed) return;
      const insert = envelopeToInsert(args.swarmId, args.agentKey, parsed);
      void args.deps.mailbox.append(insert).catch(() => {
        /* mailbox append errors surface via the queue's reject */
      });
    });
  });

  // When the PTY exits, mark agent + session rows accordingly. Mirrors the
  // crash classification in launcher.ts so the same "crash = error" heuristic
  // applies to swarm agents.
  //
  // BUG-1 — this path previously destructured only `{ exitCode }`, dropped the
  // signal, and used `exitCode < 0 && earlyDeath` as its sole crash test. A
  // swarm CLI exiting with code 1 (or killed by a signal) after the 1.5s grace
  // window was therefore recorded as a CLEAN exit ('exited'/'done'). Use the
  // shared `isPtyCrash` classifier with a TIME-ONLY `earlyDeath` (matching
  // launcher.ts) so non-zero exit codes and signals are surfaced as 'error'.
  const startedMs = rec.startedAt;
  rec.pty.onExit(({ exitCode, signal }) => {
    const earlyDeath = Date.now() - startedMs < 1500;
    const isCrash = isPtyCrash(earlyDeath, exitCode, signal);
    try {
      db.update(agentSessions)
        .set({
          status: isCrash ? 'error' : 'exited',
          exitCode,
          exitedAt: Date.now(),
        })
        .where(eq(agentSessions.id, rec.id))
        .run();
      db.update(swarmAgents)
        .set({ status: isCrash ? 'error' : 'done' })
        .where(eq(swarmAgents.id, args.agentId))
        .run();
    } catch {
      /* db may be closing during shutdown */
    }

    // BSP-G5 — post-swarm auto-teardown: after EVERY agent exits, check whether
    // this was the LAST pending agent in the swarm. If so, apply the per-workspace
    // teardown policy (default keep-all → no-op unless operator opted in).
    //
    // We only trigger for 'destroy-failing' / 'keep-passing' policies; 'keep-all'
    // short-circuits inside applyTeardownPolicy, but we skip the COUNT query too.
    try {
      const rawDb = getRawDb();
      const policyRow = rawDb
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(`workspace.swarmTeardownPolicy.${args.wsRow.id}`) as
        | { value?: string }
        | undefined;
      const policyVal = policyRow?.value;
      const isPolicyActive =
        policyVal === 'keep-passing' || policyVal === 'destroy-failing';
      if (isPolicyActive) {
        const remaining = rawDb
          .prepare(
            `SELECT COUNT(*) as cnt FROM swarm_agents
             WHERE swarm_id = ? AND status NOT IN ('done', 'error')`,
          )
          .get(args.swarmId) as { cnt: number };
        if (remaining.cnt === 0 && args.wsRow.repoRoot) {
          void applyTeardownPolicy({
            swarmId: args.swarmId,
            workspaceId: args.wsRow.id,
            repoRoot: args.wsRow.repoRoot,
            rawDb,
            worktreePool: args.deps.worktreePool,
          }).catch(() => {
            /* best-effort — never propagate into onExit */
          });
        }
      }
    } catch {
      /* never let teardown logic throw into onExit */
    }
  });

  return { sessionId: rec.id, paneIndex };
}

export interface MaterializeRosterAgentArgs {
  swarmId: string;
  wsRow: typeof workspacesTable.$inferSelect;
  assignment: {
    role: Role;
    roleIndex: number;
    providerId: string;
    initialPrompt?: string;
    runtimeProfileId?: AgentRuntimeProfileId;
    autoApprove?: boolean;
    modelId?: string;
  };
  coordinatorId: string | null;
  baseRef?: string;
  now: number;
  deps: SwarmFactoryDeps;
}

/**
 * Materialise one roster agent: insert the `swarm_agents` row, attempt to
 * spawn its PTY session, then patch the row with the resulting sessionId /
 * status. Returns the canonical {@link SwarmAgent} shape and the spawn-time
 * coordinator id (so the caller can append it to its `coordinatorIds` list
 * when relevant).
 *
 * Spawn errors are captured here (status='error', mailbox SYSTEM message);
 * we never throw out of this helper — `createSwarm` must keep building the
 * rest of the roster even if one agent fails to launch.
 */
export async function materializeRosterAgent(
  args: MaterializeRosterAgentArgs,
): Promise<{ agentId: string; agent: SwarmAgent }> {
  const { swarmId, wsRow, assignment, coordinatorId, baseRef, now, deps } = args;
  const db = getDb();
  const aKey = makeAgentKey(assignment.role, assignment.roleIndex);
  const agentId = randomUUID();
  const inboxPath = deps.mailbox.ensureInbox(swarmId, aKey);

  db.insert(swarmAgents)
    .values({
      id: agentId,
      swarmId,
      role: assignment.role,
      roleIndex: assignment.roleIndex,
      providerId: assignment.providerId,
      status: 'idle',
      inboxPath,
      agentKey: aKey,
      coordinatorId,
      createdAt: now,
    })
    .run();

  let sessionId: string | null = null;
  let sessionStatus: SwarmAgent['status'] = 'idle';
  try {
    const spawn = await spawnAgentSession({
      wsRow,
      swarmId,
      agentId,
      role: assignment.role,
      roleIndex: assignment.roleIndex,
      providerId: assignment.providerId,
      baseRef,
      agentKey: aKey,
      initialPrompt: assignment.initialPrompt,
      runtimeProfileId: assignment.runtimeProfileId,
      autoApprove: assignment.autoApprove,
      modelId: assignment.modelId,
      deps,
    });
    sessionId = spawn.sessionId;
    sessionStatus = 'idle';
  } catch (err) {
    sessionStatus = 'error';
    // Surface the error in the agent row and persist a SYSTEM message so the
    // side-chat shows what failed. We never throw — `createSwarm` keeps going
    // with the rest of the roster; the operator can kill+retry from the UI.
    const message = err instanceof Error ? err.message : String(err);
    // C6 obs — discriminated disk-guard catch: log + notify before generic handling.
    if (err instanceof WorktreeDiskGuardError) {
      console.warn(
        '[factory-spawn] disk-guard refused spawn code=%s ws=%s: %s',
        err.code,
        wsRow.id,
        err.message,
      );
      args.deps.notifications?.add({
        workspaceId: wsRow.id,
        kind: 'disk-guard',
        severity: 'critical',
        title: 'Disk guard triggered',
        body: err.message,
        dedupKey: `disk-guard:${err.code}`,
        payload: { code: err.code },
      } as AddInput);
    }
    void deps.mailbox.append({
      swarmId,
      fromAgent: 'operator',
      toAgent: aKey,
      kind: 'SYSTEM',
      body: `Failed to spawn ${aKey}: ${message}`,
    });
  }

  if (sessionId) {
    db.update(swarmAgents)
      .set({ sessionId, status: sessionStatus })
      .where(eq(swarmAgents.id, agentId))
      .run();
  } else {
    db.update(swarmAgents)
      .set({ status: sessionStatus })
      .where(eq(swarmAgents.id, agentId))
      .run();
  }

  return {
    agentId,
    agent: {
      id: agentId,
      swarmId,
      role: assignment.role,
      roleIndex: assignment.roleIndex,
      providerId: assignment.providerId,
      sessionId,
      status: sessionStatus,
      inboxPath,
      agentKey: aKey,
    },
  };
}

// ---------------------------------------------------------------------------
// Swarm query helpers (v1.4.5 — migrated from factory.ts so factory-add-agent
// can read the final swarm state without creating a circular dependency).
// factory.ts re-exports `loadSwarm` so the public API is unchanged.
// ---------------------------------------------------------------------------

export function loadSwarm(swarmId: string): Swarm | null {
  const db = getDb();
  const row = db.select().from(swarms).where(eq(swarms.id, swarmId)).get();
  if (!row) return null;
  const agentRows = db
    .select()
    .from(swarmAgents)
    .where(eq(swarmAgents.swarmId, swarmId))
    .all();
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    mission: row.mission,
    preset: row.preset as Swarm['preset'],
    status: row.status as Swarm['status'],
    createdAt: row.createdAt,
    endedAt: row.endedAt ?? null,
    agents: agentRows.map((r) => {
      // Ghost-agents fix — thread the pane's close marker onto the agent so
      // the renderer cap gates (+Pane / +Agent) can count LIVE panes instead
      // of lifetime rows. Per-row PK lookup: swarms are bounded (dozens of
      // lifetime rows) and the fake-db drizzle shim has no join support.
      const sess = r.sessionId
        ? db
            .select()
            .from(agentSessions)
            .where(eq(agentSessions.id, r.sessionId))
            .get()
        : undefined;
      return {
        id: r.id,
        swarmId: r.swarmId,
        role: r.role as Role,
        roleIndex: r.roleIndex,
        providerId: r.providerId,
        sessionId: r.sessionId ?? null,
        status: r.status as SwarmAgent['status'],
        inboxPath: r.inboxPath,
        agentKey: r.agentKey,
        closedAt: resolvePaneClosedAt(
          r.sessionId ?? null,
          sess ? { closedAt: sess.closedAt ?? null } : undefined,
        ),
      };
    }),
  };
}
