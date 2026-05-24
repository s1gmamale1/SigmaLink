import { rpc } from '@/renderer/lib/rpc';
import { compactScrollback } from '@/shared/strip-ansi';

export const PANE_DRAG_MIME = 'application/sigmalink-pane';

export interface PaneDragPayload {
  kind: 'pane';
  sessionId: string;
  branch: string | null;
  worktreePath: string | null;
  providerId: string;
}

export async function buildPaneContext(p: PaneDragPayload): Promise<string> {
  try {
    const [snap, diff] = await Promise.all([
      rpc.pty.snapshot(p.sessionId),
      p.worktreePath ? rpc.git.diff(p.worktreePath) : Promise.resolve(null),
    ]);
    const branchStr = p.branch ?? 'unknown';
    const statStr = diff?.stat?.trim() ?? '(no changes)';
    const output = compactScrollback(snap.buffer);
    return [
      `--- Pane context (${p.providerId} · ${branchStr}) ---`,
      `branch: ${branchStr}`,
      `git diff --stat:`,
      statStr,
      `recent output:`,
      output,
      `--- end pane context ---`,
    ].join('\n');
  } catch {
    return `--- Pane context ---\nbranch: ${p.branch ?? 'unknown'}\n--- end pane context ---`;
  }
}
