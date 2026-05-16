// Launches a planned grid of agents into PTY sessions.
// Each pane gets a worktree (when the workspace is a Git repo) and a PTY.
// Per-pane try/catch ensures a partial failure rolls back the just-created
// worktree (if any) and surfaces an `error` AgentSession to the renderer
// without inserting a "running" row into agent_sessions.

import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { agentSessions, workspaces as workspacesTable } from '../db/schema';
import { findProvider } from '../../../shared/providers';
import type { AgentSession, LaunchPlan, Workspace } from '../../../shared/types';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import { getSharedDeps } from '../../rpc-router';
import { writeMcpConfigForAgent } from '../browser/mcp-config-writer';
import { resolveAndSpawn, ProviderLaunchError } from '../providers/launcher';
import { buildResumeArgs } from '../pty/resume-launcher';
import {
  ensureClaudeProjectDir,
  isClaudeSessionId,
  prepareClaudeResume,
  prepareClaudeWorkspaceContext,
} from '../pty/claude-resume-bridge';
import { workspaceCwdInWorktree } from './worktree-cwd';

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

interface LauncherDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  defaultCols?: number;
  defaultRows?: number;
}

/**
 * Build the prompt-related "extra" args. The façade owns the base
 * `provider.args` and the autoApprove flag; this helper only contributes the
 * tokens that depend on `oneshotPrompt`. Returning an empty array when no
 * prompt is set is correct — the caller still types the prompt later via
 * `pty.write` for providers that lack a one-shot or initial-prompt flag.
 */
function buildExtraArgs(providerId: string, oneshotPrompt?: string): string[] {
  const p = findProvider(providerId);
  if (!p || !oneshotPrompt) return [];
  if (p.oneshotArgs && p.oneshotArgs.length) {
    return p.oneshotArgs.map((tok) => tok.replace('{prompt}', oneshotPrompt));
  }
  if (p.initialPromptFlag) {
    return [p.initialPromptFlag, oneshotPrompt];
  }
  return [];
}

/**
 * BUG-V1.1-02: persist the resolved provider tag when a comingSoon→fallback
 * swap occurred. The column is nullable; the migration is idempotent and may
 * not have run yet on legacy DBs, so we fall back to a no-op on column-missing
 * errors instead of crashing the spawn.
 */
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
  const wsRow = db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.rootPath, plan.workspaceRoot))
    .get();
  if (!wsRow) throw new Error(`Workspace not opened: ${plan.workspaceRoot}`);

  const sessions: AgentSession[] = [];
  for (const pane of plan.panes) {
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
        error: `Unknown provider: ${pane.providerId}`,
      });
      continue;
    }

    let worktreePath: string | null = null;
    let branch: string | null = null;
    try {
      if (wsRow.repoMode === 'git' && wsRow.repoRoot) {
        const r = await deps.worktreePool.create({
          repoRoot: wsRow.repoRoot,
          role: provider.id,
          hint: `pane-${pane.paneIndex}`,
          base: plan.baseRef,
        });
        worktreePath = r.worktreePath;
        branch = r.branch;
      }

      const cwd = workspaceCwdInWorktree({
        workspaceRoot: wsRow.rootPath,
        repoRoot: wsRow.repoRoot,
        worktreePath,
      });

      // v1.2.6 — Browser MCP is now stdio (npx-on-demand). We only need to
      // wire the SigmaMemory stdio supervisor; the browser config is a static
      // stdio command written into .mcp.json / config.toml / gemini-extension.
      // Best-effort — never block PTY spawn.
      try {
        const shared = getSharedDeps();
        if (shared) {
          const memRoot = wsRow.repoRoot ?? wsRow.rootPath;
          try {
            await shared.memorySupervisor.start(wsRow.id, memRoot);
          } catch {
            /* memory supervisor is non-fatal */
          }
          const memCmd = shared.memorySupervisor.getCommandFor(wsRow.id);
          writeMcpConfigForAgent({
            worktree: cwd,
            memory: memCmd ?? undefined,
          });
        }
      } catch {
        /* MCP wiring is non-fatal */
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
        extraArgs = buildExtraArgs(provider.id, pane.initialPrompt);
      }
      if (provider.id === 'claude') {
        await prepareClaudeWorkspaceContext(wsRow.rootPath, cwd);
        // Pane 2 fix — make sure the worktree-slug project dir exists so a
        // fresh `--session-id <uuid>` spawn can write its first JSONL line
        // without bailing on ENOENT for the parent dir.
        await ensureClaudeProjectDir(cwd);
      }
      const spawnResult = resolveAndSpawn(
        { ptyRegistry: deps.pty },
        {
          providerId: provider.id,
          cwd,
          cols: deps.defaultCols ?? 120,
          rows: deps.defaultRows ?? 32,
          showLegacy: readShowLegacy(),
          extraArgs,
        },
      );
      const rec = spawnResult.ptySession;
      const finalSessionId = rec.id;
      const effectiveProvider =
        findProvider(spawnResult.providerEffective) ?? provider;

      // v1.3.0 — pre-stamp the session id when the launch plan carries a
      // resume entry, so the v1.2.8 disk-scan capture path is a no-op for
      // panes that were resumed by id. Fall back to the pre-assigned id from
      // the registry (claude/gemini pre-assign path) when no resume entry.
      const insertExternalSessionId = resumeSessionId ?? rec.externalSessionId ?? null;
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
          startedAt: rec.startedAt,
          externalSessionId: insertExternalSessionId,
          // v1.3.1: persist the launcher-issued pane slot so
          // `panes.lastResumePlan` can return one row per pane (the most
          // recent) instead of one row per historical launch. Without this,
          // re-opening a workspace surfaced N×launches panes in the picker.
          paneIndex: pane.paneIndex,
        })
        .run();
      if (spawnResult.fallbackOccurred) {
        writeProviderEffective(finalSessionId, spawnResult.providerEffective);
      } else {
        // Always tag the row with the resolved id so downstream queries don't
        // have to special-case nulls.
        writeProviderEffective(finalSessionId, spawnResult.providerEffective);
      }

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
      });

      // When the PTY exits, mark the session row. If the exit happens within
      // ~1.5s of spawn, treat it as a launch failure ('error') regardless of
      // exit code — this catches both synthetic ENOENT failures (exitCode < 0)
      // and real CLI crashes (e.g. Claude exiting with code 1 on bad resume).
      const startedMs = rec.startedAt;
      rec.pty.onExit(({ exitCode }) => {
        const earlyDeath = Date.now() - startedMs < 1500;
        try {
          db.update(agentSessions)
            .set({
              status: earlyDeath ? 'error' : 'exited',
              exitCode,
              exitedAt: Date.now(),
            })
            .where(eq(agentSessions.id, finalSessionId))
            .run();
        } catch {
          /* ignore: db may be closing during shutdown */
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
