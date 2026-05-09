// Launches a planned grid of agents into PTY sessions.
// Each pane gets a worktree (when the workspace is a Git repo) and a PTY.
// Per-pane try/catch ensures a partial failure rolls back the just-created
// worktree (if any) and surfaces an `error` AgentSession to the renderer
// without inserting a "running" row into agent_sessions.

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { agentSessions, workspaces as workspacesTable } from '../db/schema';
import { findProvider } from '../../../shared/providers';
import type { AgentSession, LaunchPlan, Workspace } from '../../../shared/types';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import { getSharedDeps } from '../../rpc-router';
import { writeMcpConfigForAgent } from '../browser/mcp-config-writer';

interface LauncherDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  defaultCols?: number;
  defaultRows?: number;
}

function buildArgs(providerId: string, oneshotPrompt?: string): string[] {
  const p = findProvider(providerId);
  if (!p) return [];
  const args = [...p.args];
  if (oneshotPrompt && p.oneshotArgs && p.oneshotArgs.length) {
    return p.oneshotArgs.map((tok) => tok.replace('{prompt}', oneshotPrompt));
  }
  if (oneshotPrompt && p.initialPromptFlag) {
    return [...args, p.initialPromptFlag, oneshotPrompt];
  }
  return args;
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

      const cwd = worktreePath ?? wsRow.rootPath;

      // Browser + Memory MCP wiring: lazily start the per-workspace
      // Playwright MCP supervisor + the SigmaMemory stdio supervisor and
      // drop a single combined config snippet into the cwd / per-provider
      // user-config locations so the agent CLI inherits both `browser` and
      // `sigmamemory` MCP servers. Best-effort — never block PTY spawn.
      try {
        const shared = getSharedDeps();
        if (shared) {
          const mcpUrl = await shared.playwrightSupervisor.start(wsRow.id);
          const memRoot = wsRow.repoRoot ?? wsRow.rootPath;
          try {
            await shared.memorySupervisor.start(wsRow.id, memRoot);
          } catch {
            /* memory supervisor is non-fatal */
          }
          const memCmd = shared.memorySupervisor.getCommandFor(wsRow.id);
          writeMcpConfigForAgent({
            worktree: cwd,
            mcpUrl,
            memory: memCmd ?? undefined,
          });
        }
      } catch {
        /* MCP wiring is non-fatal */
      }

      const args = buildArgs(provider.id, pane.initialPrompt);
      const rec = deps.pty.create({
        providerId: provider.id,
        command: provider.command,
        args,
        cwd,
        cols: deps.defaultCols ?? 120,
        rows: deps.defaultRows ?? 32,
      });
      const finalSessionId = rec.id;

      db.insert(agentSessions)
        .values({
          id: finalSessionId,
          workspaceId: wsRow.id,
          providerId: provider.id,
          cwd,
          branch,
          worktreePath,
          status: 'running',
          initialPrompt: pane.initialPrompt,
          startedAt: rec.startedAt,
        })
        .run();

      // If we wanted a non-oneshot prompt to be typed, push it after a tick.
      // The launcher is the single source-of-truth for typing the initial
      // prompt; the rpc-router pty.create controller does NOT type prompts to
      // avoid double-send.
      if (pane.initialPrompt && !provider.oneshotArgs?.length && !provider.initialPromptFlag) {
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

      // When the PTY exits, mark the session row. If the exit code is
      // negative (synthetic spawn-failure exit) and arrives within ~1s, mark
      // the row as 'error' so the UI can distinguish a never-born process
      // from a normal exit.
      const startedMs = rec.startedAt;
      rec.pty.onExit(({ exitCode }) => {
        const earlyDeath = exitCode < 0 && Date.now() - startedMs < 1500;
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
      const message = err instanceof Error ? err.message : String(err);
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
