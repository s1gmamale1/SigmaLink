/**
 * v1.5.1-A — Extracted from CommandRoom.tsx.
 *
 * Inserts `@<path> ` into the PTY for `sessionId`. Shows a toast when the
 * pane is not running instead of silently no-opping (the registry already
 * swallows unknown session writes without throwing).
 */
import { toast } from 'sonner';
import { rpc } from '@/renderer/lib/rpc';
import type { AgentSession } from '@/shared/types';

export async function insertMention(
  sessionId: string,
  path: string,
  sessionStatus: AgentSession['status'],
): Promise<void> {
  if (sessionStatus !== 'running') {
    toast.warning('Pane is not running', { description: 'Start the pane before dropping files.' });
    return;
  }
  await rpc.pty.write(sessionId, `@${path} `);
}
