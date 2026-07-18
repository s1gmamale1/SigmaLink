// Launches a planned grid of agents into PTY sessions.
// Each pane gets a worktree (when the workspace is a Git repo) and a PTY.
// Per-pane try/catch ensures a partial failure rolls back the just-created
// worktree (if any) and surfaces an `error` AgentSession to the renderer
// without inserting a "running" row into agent_sessions.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { agentSessions, workspaces as workspacesTable } from '../db/schema';
import { findProvider } from '../../../shared/providers';
import type { AgentSession, LaunchPlan, Workspace } from '../../../shared/types';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import { WorktreeDiskGuardError } from '../git/worktree';
import type { AddInput } from '../notifications/manager';
import { getSharedDeps } from '../../rpc-router';
import { writeMcpConfigForAgent } from '../browser/mcp-config-writer';
import { resolveAndSpawn, ProviderLaunchError } from '../providers/launcher';
import { withCodexSpawnLock, resolveCodexHome } from '../control/codex-spawn-lock';
import { whenShellPathReady } from '../util/shell-path';
import { resolveSpawnRendererMode } from '../pty/spawn-renderer-mode';
import { buildResumeArgs } from '../pty/resume-launcher';
import {
  ensureClaudeProjectDir,
  isClaudeSessionId,
  prepareClaudeResume,
  prepareClaudeWorkspaceContext,
} from '../pty/claude-resume-sigma';
import {
  ensureGeminiProjectDir,
  prepareGeminiResume,
} from '../pty/gemini-resume-sigma';
import { workspaceCwdInWorktree } from './worktree-cwd';
import { readWorktreeMode } from './worktree-mode';
import { KV_PTY_SPAWN_MODE, parseSpawnMode, effectivePaneSpawnMode } from '../pty/local-pty';
import { writeGuardrailBlock } from './guardrail-block';
import { ensureRufloMcpForPane } from './ruflo-mcp-policy';
import { ENABLE_RUFLO_HTTP_DAEMON } from './factory';
import { allocateLowestFreeLivePaneIndex } from './pane-slots';
import { isPtyCrash } from '../pty/crash';
import { maybeAutoCheckpoint } from '../git/auto-checkpoint';
import { providerAcceptsModelFlag, listModelsFor } from '../providers/models';
import {
  normalizeAgentRuntimeProfileId,
  profileAllowsMcp,
  profileIsMcpHeavy,
} from '../../../shared/runtime-profiles';
import { checkRamBrakeAdmission } from '../ram-brake/admission';
import { buildClaudeMcpLaunchArgs } from '../ram-brake/mcp-launch-mode';

/**
 * Read `kv['providers.showLegacy']` (default '0'). Falsey when the user has
 * not opted in. The launcher façade re-checks this main-side so a renderer
 * that bypasses its own gate still cannot spawn a legacy provider.
 */
function readShowLegacy(): boolean {
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get('providers.showLegacy') as { value?: string } | undefined;
    return row?.value === '1' || row?.value === 'true';
  } catch {
    return false;
  }
}

/**
 * v1.6.0 Phase 1 — Read `kv['pty.spawnMode']`. Returns 'direct' (default)
 * when the key is absent or holds an unrecognised value, ensuring the
 * CRITICAL INVARIANT that the default behaviour is byte-for-byte unchanged.
 */
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

interface LauncherDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  defaultCols?: number;
  defaultRows?: number;
  /**
   * crash-classification IPC — called by the launcher's onExit handler to
   * broadcast `pty:error` when the exit is a crash (earlyDeath <1.5s OR
   * non-zero exitCode/signal). Optional so existing callers (tests, pty.create
   * controller) do not need to provide it; missing means no broadcast.
   */
  broadcastPtyError?: (payload: { sessionId: string; exitCode: number | null; signal?: string | null }) => void;
  /**
   * C6 obs — optional notifications sink for disk-guard alerts. When provided,
   * a WorktreeDiskGuardError triggers a critical notification so the operator
   * sees the disk-guard hit in the bell. Callers that don't thread notifications
   * still get the console.warn; only the bell is silent.
   */
  notifications?: { add: (input: AddInput) => unknown };
}

/**
 * Build the prompt-related "extra" args. The façade owns the base
 * `provider.args` and the autoApprove flag; this helper contributes the tokens
 * that depend on `oneshotPrompt` plus the FEAT-14 per-pane `--model` flag.
 * Returning an empty array when neither a prompt nor a model is set is correct
 * — the caller still types the prompt later via `pty.write` for providers that
 * lack a one-shot or initial-prompt flag.
 *
 * FEAT-14 — per-pane model selection. When `modelId` is set AND the provider's
 * CLI accepts the flag (`providerAcceptsModelFlag`: claude / cursor / gemini),
 * prepend `--model <modelId>`. codex / kimi / opencode / shell are SKIPPED so
 * an unknown flag never breaks their spawn. Resume launches reuse the existing
 * session's model, so this helper is only consulted on the fresh-spawn branch.
 *
 * Exported for unit coverage (mirrors the `isPtyCrash` export pattern); the
 * executeLaunchPlan spawn flow is otherwise untouched.
 */
export function buildExtraArgs(
  providerId: string,
  oneshotPrompt?: string,
  modelId?: string,
): string[] {
  const p = findProvider(providerId);
  if (!p) return [];
  // M1 (review) — `modelId` rides the renderer's LaunchPlan; allowlist it against
  // the shared catalog before it becomes a `--model <id>` CLI arg. Unknown models
  // are dropped silently (the CLI default applies). Spawn is shell:false argv, but
  // this is defense-in-depth at the renderer→spawn boundary.
  const modelArgs: string[] =
    modelId &&
    providerAcceptsModelFlag(p.id) &&
    listModelsFor(p.id).some((m) => m.modelId === modelId)
      ? ['--model', modelId]
      : [];
  if (!oneshotPrompt) return modelArgs;
  if (p.oneshotArgs && p.oneshotArgs.length) {
    return [...modelArgs, ...p.oneshotArgs.map((tok) => tok.replace('{prompt}', oneshotPrompt))];
  }
  if (p.initialPromptFlag) {
    return [...modelArgs, p.initialPromptFlag, oneshotPrompt];
  }
  return modelArgs;
}

/**
 * BUG-V1.1-02: persist the resolved provider tag when a comingSoon→fallback
 * swap occurred. The column is nullable; the migration is idempotent and may
 * not have run yet on legacy DBs, so we fall back to a no-op on column-missing
 * errors instead of crashing the spawn.
 */
// BUG-1 — `isPtyCrash` moved to the dependency-free `../pty/crash` leaf module
// so the swarm spawn path (`swarms/factory-spawn.ts`) can share the exact same
// classifier without closing an import cycle (launcher → rpc-router → factory →
// factory-spawn → launcher). Re-exported here so the existing `./launcher`
// public surface (consumed by launcher.test.ts) is unchanged.
export { isPtyCrash };

function writeProviderEffective(sessionId: string, providerEffective: string): void {
  try {
    getRawDb()
      .prepare('UPDATE agent_sessions SET provider_effective = ? WHERE id = ?')
      .run(providerEffective, sessionId);
  } catch {
    /* column may not exist on a pre-0010 DB; ignore */
  }
}

export async function executeLaunchPlan(
  plan: LaunchPlan,
  deps: LauncherDeps,
): Promise<{ workspace: Workspace; sessions: AgentSession[] }> {
  const db = getDb();
  // DEV-W3a — prefer the explicit workspace id. After migration 0034 drops the
  // unique workspaces_root_idx, two workspaces can share a rootPath, so a
  // by-path `.get()` would bind panes to an ARBITRARY duplicate row. Fall back
  // to the rootPath lookup only for legacy callers that omit workspaceId.
  const wsRow = plan.workspaceId
    ? db.select().from(workspacesTable).where(eq(workspacesTable.id, plan.workspaceId)).get()
    : db.select().from(workspacesTable).where(eq(workspacesTable.rootPath, plan.workspaceRoot)).get();
  if (!wsRow) throw new Error(`Workspace not opened: ${plan.workspaceId ?? plan.workspaceRoot}`);

  checkRamBrakeAdmission(getRawDb(), {
    workspaceId: wsRow.id,
    requestedProfiles: plan.panes.map((pane) => pane.runtimeProfileId),
    force: plan.forceRamBrake === true,
  });

  const sessions: AgentSession[] = [];
  for (const pane of plan.panes) {
    const runtimeProfileId = normalizeAgentRuntimeProfileId(pane.runtimeProfileId);
    let rufloMcpPort: number | undefined;
    const provider = findProvider(pane.providerId);
    if (!provider) {
      sessions.push({
        id: `error-${pane.paneIndex}-${Date.now()}`,
        workspaceId: wsRow.id,
        providerId: pane.providerId,
        cwd: wsRow.rootPath,
        branch: null,
        worktreePath: null,
        status: 'error',
        startedAt: Date.now(),
        initialPrompt: pane.initialPrompt,
        runtimeProfileId,
        error: `Unknown provider: ${pane.providerId}`,
        name: null,
      });
      continue;
    }

    let worktreePath: string | null = null;
    let branch: string | null = null;
    // v1.5.5-A — pre-allocate the session UUID so the worktree suffix and
    // agent_sessions.id are the same value. For git repos, worktreePool.create
    // consumes this; for non-git workspaces we mint one inline. Either way
    // the same UUID flows into resolveAndSpawn → registry.create, which
    // honours input.sessionId and skips its own randomUUID() call.
    const preallocSessionId = randomUUID();
    let finalPreallocSessionId: string = preallocSessionId;
    try {
      // DEV-W3b (ADR-007) — skip worktree allocation when in-place mode is active.
      // worktreePath stays null → workspaceCwdInWorktree returns wsRow.rootPath.
      const inPlace = readWorktreeMode(getRawDb(), wsRow.id) === 'in-place';
      if (!inPlace && wsRow.repoMode === 'git' && wsRow.repoRoot) {
        const r = await deps.worktreePool.create({
          repoRoot: wsRow.repoRoot,
          role: provider.id,
          hint: `pane-${pane.paneIndex}`,
          base: plan.baseRef,
          sessionId: preallocSessionId,
        });
        worktreePath = r.worktreePath;
        branch = r.branch;
        // Use whichever sessionId the pool actually used (may differ from
        // preallocSessionId if a collision triggered a retry).
        finalPreallocSessionId = r.sessionId;
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

      const cwd = workspaceCwdInWorktree({
        workspaceRoot: wsRow.rootPath,
        repoRoot: wsRow.repoRoot,
        worktreePath,
      });

      // SigmaLink Dev (2026-06-11) — a plain shell consumes no MCP config
      // (no agent CLI reads .mcp.json), and for the dev workspace the pane
      // cwd IS the user's home directory: writing MCP/memory config there
      // is forbidden. Gate the whole wiring block on a non-shell provider.
      if (provider.id !== 'shell') {
        // RAM Brake — Browser/SigmaMemory are heavy MCPs and must be explicitly
        // opted into per pane. Ruflo remains the default lightweight profile.
        // Best-effort — never block PTY spawn.
        try {
          const shared = getSharedDeps();
          if (shared) {
            const memRoot = wsRow.repoRoot ?? wsRow.rootPath;
            let memCmd: ReturnType<typeof shared.memorySupervisor.getCommandFor> | null = null;
            if (profileAllowsMcp(runtimeProfileId, 'sigmamemory')) {
              try {
                await shared.memorySupervisor.start(wsRow.id, memRoot);
              } catch {
                /* memory supervisor is non-fatal */
              }
              memCmd = shared.memorySupervisor.getCommandFor(wsRow.id);
            }
            writeMcpConfigForAgent({
              worktree: cwd,
              runtimeProfileId,
              memory: memCmd ?? undefined,
            });
            // SF-15 — the pane CLI reads `.mcp.json` + `.claude/settings.local.json`
            // relative to ITS cwd (the worktree), NOT the workspace root where
            // openWorkspace's autowrite/trust ran. Write a managed `ruflo` entry
            // (+ claude trust) into this pane's cwd BEFORE the CLI spawns so Ruflo
            // MCP actually attaches to the pane. HTTP mode when the per-workspace
            // daemon has a live port; stdio otherwise. Fail-open + opt-out aware.
            const rufloResult = await ensureRufloMcpForPane({
              cwd,
              workspaceId: wsRow.id,
              workspaceRoot: wsRow.repoRoot ?? wsRow.rootPath,
              runtimeProfileId,
              // SigmaLink Dev (2026-06-11) — thread the provider so the
              // policy's by-construction shell gate also covers this path
              // (belt-and-braces with the outer provider gate above).
              providerId: provider.id,
              rawDb: getRawDb(),
              daemon: shared.rufloHttpDaemonSupervisor,
              httpDaemonEnabled: ENABLE_RUFLO_HTTP_DAEMON,
            });
            if (rufloResult.transport === 'http') {
              rufloMcpPort = rufloResult.port;
            }
          }
        } catch {
          /* MCP wiring is non-fatal */
        }
      }

      // V1.1: route every spawn through the provider launcher façade. The
      // façade applies the comingSoon→fallback swap, walks `altCommands` on
      // ENOENT, appends `autoApproveFlag` when requested, and re-checks the
      // legacy gate main-side. The caller (this loop) still owns the DB
      // insert + worktree wiring + initial-prompt typing.
      //
      // v1.3.0 — Session picker: if the launch plan carries a paneResumePlan
      // entry with a non-null sessionId for this pane slot, inject resume args
      // via `buildResumeArgs` (covers all 5 providers, id vs continue fallback).
      // The extraArgs from buildExtraArgs are only applied when NOT resuming.
      //
      // v1.3.2 — Claude session-slug bridge. SessionStep scans for sessions at
      // `workspace.rootPath`, but Claude is about to spawn inside the per-pane
      // worktree. Claude derives its JSONL path from cwd as
      // `~/.claude/projects/<cwd.replace(/\//g, '-')>/<id>.jsonl`, so the
      // worktree slug ≠ workspace slug and `claude --resume <id>` would not
      // find the file → silent exit → blank pane (the v1.3.2 hotfix bug). We
      // symlink the workspace-slug JSONL into the worktree-slug dir BEFORE
      // spawn so resume works regardless of where Claude is launched from.
      //
      // For fresh Claude spawns we ensure the worktree-slug project dir exists
      // so `--session-id <new-uuid>` does not fail on a missing parent dir
      // (the v1.3.2 Pane 2 bug — claude versions that exit silently when
      // attempting to write the JSONL into a non-existent parent dir).
      // SF-12 Tier-2 invariant: workspace launch/resume plans are full-grid
      // launches and are expected to run after existing live panes for this
      // workspace have been closed/exited. The DB insert below still
      // reconciles the durable storage slot against currently-live rows, but
      // resume args must be selected before spawn and therefore remain keyed
      // to the requested launch-plan paneIndex.
      const resumeEntry = plan.paneResumePlan?.find(
        (r) => r.paneIndex === pane.paneIndex,
      );
      let resumeSessionId = resumeEntry?.sessionId ?? null;
      let extraArgs: string[];
      if (resumeSessionId) {
        if (provider.id === 'claude') {
          if (!isClaudeSessionId(resumeSessionId)) {
            resumeSessionId = null;
          } else {
            const outcome = await prepareClaudeResume(
              wsRow.rootPath,
              cwd,
              resumeSessionId,
            );
            // If the workspace-slug JSONL is missing on disk (deleted by the
            // user, scanned-but-since-pruned, etc.) drop the id and fall through
            // to `--continue` so the pane still spawns instead of going blank.
            if (outcome === 'missing') {
              resumeSessionId = null;
            }
          }
        }
        // v1.4.3-01 — Gemini session-slug bridge.
        // B2 fix — if the bridge cannot alias the worktree to the workspace
        // slug (the workspace slug has NO session history → 'missing'), drop the
        // picked id. The OLD code then still pre-created+aliased the dir and
        // spawned `--resume latest`, which fell through to gemini's GLOBAL
        // newest session (a DIFFERENT project) — silently resuming the wrong
        // chat. Now a dropped id means a FRESH spawn (no alias, no --resume; see
        // the gated ensureGeminiProjectDir below + buildResumeArgs gemini).
        if (provider.id === 'gemini') {
          const bridge = await prepareGeminiResume(wsRow.rootPath, cwd);
          if (bridge === 'missing') {
            resumeSessionId = null;
          }
        }
        if (resumeSessionId) {
          const resumeResult = buildResumeArgs(provider.id, resumeSessionId);
          extraArgs = resumeResult?.args ?? [];
        } else {
          // Resume id was unavailable on disk — switch to the universal
          // `--continue` fallback (no extra args needed for that path; the
          // launcher's resume-launcher branch handles the same flag mapping).
          const resumeResult = buildResumeArgs(provider.id, null);
          extraArgs = resumeResult?.args ?? [];
        }
      } else {
        // FEAT-14 — fresh spawn: thread the per-pane modelId so buildExtraArgs
        // can prepend `--model <id>` for providers that accept the flag.
        extraArgs = buildExtraArgs(provider.id, pane.initialPrompt, pane.modelId);
      }
      if (provider.id === 'claude') {
        const mcpArgs = buildClaudeMcpLaunchArgs({
          mode: pane.mcpLaunchMode ?? (profileIsMcpHeavy(runtimeProfileId) ? 'inherit' : 'strict-core'),
          rufloHttpUrl:
            rufloMcpPort !== undefined
              ? `http://127.0.0.1:${rufloMcpPort}/mcp`
              : undefined,
        });
        if (mcpArgs.length > 0) extraArgs = [...extraArgs, ...mcpArgs];
      }
      if (provider.id === 'claude') {
        await prepareClaudeWorkspaceContext(wsRow.rootPath, cwd);
        // Pane 2 fix — make sure the worktree-slug project dir exists so a
        // fresh `--session-id <uuid>` spawn can write its first JSONL line
        // without bailing on ENOENT for the parent dir.
        await ensureClaudeProjectDir(cwd);
      }
      // v1.4.3-01 / B2 — pre-create the gemini chats dir.
      //   * RESUME (resumeSessionId still set after the bridge check above):
      //     alias worktreeCwd → workspaceSlug so `--resume latest` reads the
      //     SAME chats directory the picked session lives in.
      //   * FRESH / dropped-id ('missing' bridge, or no session picked):
      //     pre-create gemini's OWN worktree-slug dir WITHOUT aliasing
      //     (worktreeCwd === workspaceCwd → no projects.json write), so a brand
      //     new gemini session does NOT latch onto the workspace's history and
      //     `--resume latest` (which we no longer emit for a null id) can't
      //     resolve to a foreign global session.
      if (provider.id === 'gemini') {
        if (resumeSessionId) {
          await ensureGeminiProjectDir(cwd, wsRow.rootPath);
        } else {
          await ensureGeminiProjectDir(cwd, cwd);
        }
      }
      // v1.6.0 Phase 3 — per-pane safe-scope spawn-mode override.
      //
      // When the global spawn mode is 'shell-first' we need the initial prompt
      // to reach the CLI. There are two working delivery paths:
      //
      //   Path A — provider has `initialPromptFlag` or `oneshotArgs`:
      //     The prompt is baked into the CLI argv (via buildExtraArgs), so
      //     shell-first works fine — the entire command line (including the
      //     prompt flag) is written to the shell by spawnLocalPty.
      //
      //   Path B — provider has NEITHER flag NOR oneshotArgs (e.g. kimi,
      //     opencode): the prompt is delivered by a post-spawn `pty.write`
      //     600 ms after spawn. In direct mode the CLI is the PTY child and is
      //     ready within a few hundred milliseconds, so the write lands safely.
      //     In shell-first mode the PTY child is the *shell*, and the write
      //     races shell→CLI startup — the 600 ms is not a reliable signal
      //     (timing would be environment-dependent and fragile).
      //
      //   Safe-scope fix: when global mode is 'shell-first' but this pane uses
      //   Path B, override the *pane-local* spawn mode to 'direct'. That pane
      //   loses shell-durability for this launch but the prompt is delivered
      //   correctly. All other panes in the same workspace keep shell-first.
      //
      //   A "stdin-prompt + shell-durability" solution (e.g. a CLI-ready signal
      //   that defers the write until the CLI has launched inside the shell)
      //   is the correct long-term fix for Path B providers; it is intentionally
      //   deferred as a future enhancement (Phase 3+).
      //
      // CRITICAL INVARIANT: when global mode is 'direct' this block is a no-op
      // — the per-pane override never fires, and behaviour is byte-for-byte
      // identical to pre-Phase-3.
      const effectiveSpawnMode = effectivePaneSpawnMode(
        readSpawnMode(),
        !!pane.initialPrompt,
        !!(provider.oneshotArgs?.length),
        !!provider.initialPromptFlag,
      );

      // perf-hot-paths Task 4 — gate the spawn on the async login-shell PATH
      // resolve (≤3.5 s cap; instant on warm boot). This single gate covers
      // ALL executeLaunchPlan callers (panes resume/respawn, workspace open,
      // assistant spawn) because providers/launcher.ts's resolveAndSpawn is a
      // sync callee reached only through here or the gated rpc-router handlers.
      await whenShellPathReady();
      // Task 5 — serialize codex spawns to avoid OAuth refresh-token races.
      // Non-codex providers call resolveAndSpawn directly (unchanged).
      const doSpawn = () => resolveAndSpawn(
        { ptyRegistry: deps.pty },
        {
          providerId: provider.id,
          cwd,
          cols: deps.defaultCols ?? 120,
          rows: deps.defaultRows ?? 32,
          showLegacy: readShowLegacy(),
          extraArgs,
          // v1.5.5-A — pass the pre-allocated UUID via preassignedSessionId
          // (NOT sessionId) so registry.create uses it as the row id while
          // keeping isResume=false → onPostSpawnCapture fires for disk-scan
          // providers and shouldPreAssign still injects --session-id for
          // claude/gemini (fixes the reviewer-blocking sentinel collision).
          preassignedSessionId: finalPreallocSessionId,
          // v1.5.5 — explicit: this is always a fresh spawn (no sessionId).
          isResume: false,
          // v1.6.0 Phase 3 — use the per-pane effective spawn mode (may be
          // overridden to 'direct' for Path B providers in shell-first mode;
          // see comment above). Default is 'direct' (CRITICAL INVARIANT).
          spawnMode: effectiveSpawnMode,
          // SF-8 Yolo/Bypass — thread pane.autoApprove into resolveAndSpawn
          // so buildArgs appends provider.autoApproveFlag when true.
          autoApprove: pane.autoApprove ?? false,
          // P1c — resolve the pane's renderer mode at spawn so claude's #160
          // fullscreen injection is appended ONLY for xterm-mode panes (the
          // DOM presenter wants inline). Per-session KV override (resume) →
          // global default KV → shared DEFAULT_RENDERER_MODE.
          rendererMode: resolveSpawnRendererMode(
            getRawDb(),
            resumeSessionId ?? finalPreallocSessionId,
          ),
        },
      );
      const spawnResult = provider.id === 'codex'
        ? await withCodexSpawnLock(resolveCodexHome(), () => Promise.resolve(doSpawn()))
        : doSpawn();
      const rec = spawnResult.ptySession;
      const finalSessionId = rec.id;
      const effectiveProvider =
        findProvider(spawnResult.providerEffective) ?? provider;

      // v1.3.0 — pre-stamp the session id when the launch plan carries a
      // resume entry, so the v1.2.8 disk-scan capture path is a no-op for
      // panes that were resumed by id. Fall back to the pre-assigned id from
      // the registry (claude/gemini pre-assign path) when no resume entry.
      const insertExternalSessionId = resumeSessionId ?? rec.externalSessionId ?? null;
      // session-persistence fix (2026-07-18) — the picker resume lane INSERTs a
      // NEW row; without carry-forward the operator's rename (BSP-O4 `name`)
      // and CLI label override (SF-10) silently reset to NULL and the new row
      // shadowed the old named row in listForWorkspace's rank ("Wren →
      // Frontend-Agent" reverted to the alias). Copy both from the newest open
      // row holding this external session id.
      let carriedName: string | null = null;
      let carriedDisplayProviderId: string | null = null;
      if (resumeSessionId) {
        try {
          const prev = getRawDb()
            .prepare(
              `SELECT name, display_provider_id FROM agent_sessions
               WHERE workspace_id = ? AND external_session_id = ? AND closed_at IS NULL
               ORDER BY started_at DESC LIMIT 1`,
            )
            .get(wsRow.id, resumeSessionId) as
            | { name: string | null; display_provider_id: string | null }
            | undefined;
          carriedName = prev?.name ?? null;
          carriedDisplayProviderId = prev?.display_provider_id ?? null;
        } catch {
          /* carry-forward is best-effort — a fresh alias is the safe fallback */
        }
      }
      let allocatedPaneIndex = pane.paneIndex;
      try {
        const insertSession = getRawDb().transaction(() => {
          allocatedPaneIndex = allocateLowestFreeLivePaneIndex(getRawDb(), wsRow.id);
          db.insert(agentSessions)
            .values({
              id: finalSessionId,
              workspaceId: wsRow.id,
              // BUG-V1.1-01: store the requested id in `providerId` so the UI
              // continues to show what the operator picked, and the resolved id
              // in `provider_effective` so the runtime knows which CLI actually
              // launched (relevant when a comingSoon → fallback swap occurs).
              providerId: provider.id,
              cwd,
              branch,
              worktreePath,
              status: 'running',
              initialPrompt: pane.initialPrompt,
              runtimeProfileId,
              startedAt: rec.startedAt,
              externalSessionId: insertExternalSessionId,
              // v1.3.1: persist the launcher-issued pane slot so
              // `panes.lastResumePlan` can return one row per pane (the most
              // recent) instead of one row per historical launch. Without this,
              // re-opening a workspace surfaced N×launches panes in the picker.
              paneIndex: allocatedPaneIndex,
              // SF-8 Yolo/Bypass — persist the bypass flag so resume can
              // re-apply it without the renderer re-submitting the preference.
              autoApprove: pane.autoApprove ? 1 : 0,
              // session-persistence fix — rename + CLI label carry-forward
              // (NULL on fresh spawns; copied from the superseded row on the
              // picker resume lane).
              name: carriedName,
              displayProviderId: carriedDisplayProviderId,
            })
            .run();
        });
        insertSession();
      } catch (insertErr) {
        // v1.5.5 Cluster A — guard against UNIQUE violation on
        // (workspace_id, pane_index). This can occur in a concurrent
        // rapid-spawn race where two executeLaunchPlan calls race the same
        // pane slot. Log and continue; the caller will surface an error
        // session for the pane that lost the race.
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (/UNIQUE constraint failed/i.test(msg)) {
          console.warn(
            `[launcher] UNIQUE violation on agent_sessions (ws=${wsRow.id}, pane=${pane.paneIndex}) — duplicate spawn suppressed`,
          );
          // SF-12: the PTY was spawned before the INSERT. If the unique
          // `(workspace_id, pane_index)` guard rejects the row, tear down the
          // just-created child so the registry cannot retain a live terminal
          // with no DB row.
          try {
            deps.pty.kill(finalSessionId);
          } catch {
            /* kill is best-effort — forget() still drops registry ownership */
          }
          try {
            deps.pty.forget(finalSessionId);
          } catch {
            /* never mask the original duplicate-slot failure */
          }
          sessions.push({
            id: `error-${pane.paneIndex}-${Date.now()}`,
            workspaceId: wsRow.id,
            providerId: provider.id,
            cwd,
            branch,
            worktreePath: null,
            status: 'error',
            startedAt: Date.now(),
            initialPrompt: pane.initialPrompt,
            runtimeProfileId,
            error: `Pane slot ${allocatedPaneIndex} is already occupied.`,
            name: null,
          });
          // CRIT-1/CRIT-2: the UNIQUE branch `continue`s and never reaches the
          // outer catch's worktreePool.remove, so it leaks the worktree created
          // for this pane. Remove + prune it here (best-effort).
          if (worktreePath && wsRow.repoRoot) {
            try {
              await deps.worktreePool.removeAndPrune(wsRow.repoRoot, worktreePath);
            } catch {
              /* best-effort — boot sweep is the backstop */
            }
          }
          continue;
        } else {
          throw insertErr;
        }
      }
      if (spawnResult.fallbackOccurred) {
        writeProviderEffective(finalSessionId, spawnResult.providerEffective);
      } else {
        // Always tag the row with the resolved id so downstream queries don't
        // have to special-case nulls.
        writeProviderEffective(finalSessionId, spawnResult.providerEffective);
      }

      // FEAT-11 fast-follow — auto-checkpoint-on-dispatch. The session row now
      // exists (FK target) and the worktree is resolved, but the initial prompt
      // has NOT been typed yet — so this captures the pre-dispatch state before
      // the agent's first turn touches the tree. Gated (KV, default OFF),
      // change-checked, min-interval throttled, and fully fail-open — it can
      // only ever skip, never block or break the launch.
      await maybeAutoCheckpoint({ sessionId: finalSessionId, worktreePath });

      // If we wanted a non-oneshot prompt to be typed, push it after a tick.
      // The launcher is the single source-of-truth for typing the initial
      // prompt; the rpc-router pty.create controller does NOT type prompts to
      // avoid double-send. Use the *effective* provider's flags — any
      // comingSoon→fallback path should defer to the resolved CLI's rules.
      if (
        pane.initialPrompt &&
        !effectiveProvider.oneshotArgs?.length &&
        !effectiveProvider.initialPromptFlag
      ) {
        setTimeout(() => {
          try {
            deps.pty.write(finalSessionId, pane.initialPrompt + '\n');
          } catch {
            /* ignore */
          }
        }, 600);
      }

      sessions.push({
        id: finalSessionId,
        workspaceId: wsRow.id,
        providerId: provider.id,
        cwd,
        branch,
        worktreePath,
        status: 'running',
        startedAt: rec.startedAt,
        initialPrompt: pane.initialPrompt,
        runtimeProfileId,
        // SF-8 Yolo/Bypass — surface the persisted flag so the renderer
        // knows whether this pane was launched in bypass mode.
        autoApprove: pane.autoApprove ?? false,
        // BSP-O4 — fresh spawns start unnamed; picker resumes carry the
        // operator's rename forward (session-persistence fix).
        name: carriedName,
      });

      // When the PTY exits, mark the session row. If the exit happens within
      // ~1.5s of spawn, treat it as a launch failure ('error') regardless of
      // exit code — this catches both synthetic ENOENT failures (exitCode < 0)
      // and real CLI crashes (e.g. Claude exiting with code 1 on bad resume).
      //
      // crash-classification IPC: also broadcast `pty:error` when the exit is
      // a crash so the renderer can keep the pane visible with an error banner
      // instead of GC-removing it. Crash = earlyDeath OR non-zero exitCode/signal.
      // Clean exits (code 0, not earlyDeath) only receive the regular `pty:exit`.
      const startedMs = rec.startedAt;
      rec.pty.onExit(({ exitCode, signal }) => {
        // account-switch restart (2026-07-14) — an EXPECTED kill (the restart
        // flow is about to resume this row in place) is not a crash: skip the
        // status write + pty:error broadcast; the restart flow owns the row
        // state. Grep-twins: resume-launcher.attachExitPersistence,
        // swarms/factory-spawn.
        if (rec.expectedExit) return;
        const earlyDeath = Date.now() - startedMs < 1500;
        const isCrash = isPtyCrash(earlyDeath, exitCode, signal);
        try {
          db.update(agentSessions)
            .set({
              // BUG-1 parity: persist the SAME crash classification used for the
              // `pty:error` broadcast (and by the swarm path in factory-spawn) so
              // a crashed pane resumed from disk reads 'error' (stays visible),
              // not 'exited' (which the exited-session GC would reap on restore).
              status: isCrash ? 'error' : 'exited',
              exitCode,
              exitedAt: Date.now(),
            })
            .where(eq(agentSessions.id, finalSessionId))
            .run();
        } catch {
          /* ignore: db may be closing during shutdown */
        }
        if (isCrash) {
          try {
            deps.broadcastPtyError?.({
              sessionId: finalSessionId,
              exitCode: exitCode ?? null,
              signal: signal != null ? String(signal) : null,
            });
          } catch {
            /* broadcast is best-effort */
          }
        }
      });
    } catch (err) {
      // ProviderLaunchError surfaces a human-readable .message already (legacy
      // gate, "no usable command found", etc.); we preserve it verbatim for
      // the renderer's error banner. Other thrown errors (worktree creation,
      // MCP wiring) flow through the same path.
      const message =
        err instanceof ProviderLaunchError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      // C6 obs — discriminated disk-guard catch: log + notify before generic handling.
      if (err instanceof WorktreeDiskGuardError) {
        console.warn(
          '[launcher] disk-guard refused spawn code=%s ws=%s: %s',
          err.code,
          wsRow.id,
          err.message,
        );
        deps.notifications?.add({
          workspaceId: wsRow.id,
          kind: 'disk-guard',
          severity: 'critical',
          title: 'Disk guard triggered',
          body: err.message,
          dedupKey: `disk-guard:${err.code}`,
          payload: { code: err.code },
        });
      }
      // Roll back the worktree if we created one before the failure.
      if (worktreePath && wsRow.repoRoot) {
        try {
          await deps.worktreePool.remove(wsRow.repoRoot, worktreePath);
        } catch {
          /* best-effort cleanup */
        }
      }
      sessions.push({
        id: `error-${pane.paneIndex}-${Date.now()}`,
        workspaceId: wsRow.id,
        providerId: provider.id,
        cwd: worktreePath ?? wsRow.rootPath,
        branch,
        worktreePath: null,
        status: 'error',
        startedAt: Date.now(),
        initialPrompt: pane.initialPrompt,
        runtimeProfileId,
        error: message,
      });
    }
  }

  return {
    workspace: {
      id: wsRow.id,
      name: wsRow.name,
      rootPath: wsRow.rootPath,
      repoRoot: wsRow.repoRoot,
      repoMode: wsRow.repoMode as Workspace['repoMode'],
      createdAt: wsRow.createdAt,
      lastOpenedAt: wsRow.lastOpenedAt,
    },
    sessions,
  };
}
