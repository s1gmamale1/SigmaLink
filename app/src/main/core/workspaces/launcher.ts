// Launches a planned grid of agents into PTY sessions.
// Each pane gets a worktree (when the workspace is a Git repo) and a PTY.

import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client';
import { agentSessions, workspaces as workspacesTable } from '../db/schema';
import { findProvider } from '../../../shared/providers';
import type { AgentSession, LaunchPlan, Workspace } from '../../../shared/types';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';

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
      throw new Error(`Unknown provider: ${pane.providerId}`);
    }

    let worktreePath: string | null = null;
    let branch: string | null = null;
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
    const args = buildArgs(provider.id, pane.initialPrompt);
    void randomUUID; // session id is assigned by the registry
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

    // When the PTY exits, mark the session row.
    rec.pty.onExit(({ exitCode }) => {
      try {
        db.update(agentSessions)
          .set({ status: 'exited', exitCode, exitedAt: Date.now() })
          .where(eq(agentSessions.id, finalSessionId))
          .run();
      } catch {
        /* ignore: db may be closing during shutdown */
      }
    });
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
