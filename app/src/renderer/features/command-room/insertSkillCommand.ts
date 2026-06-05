/**
 * W-5 Phase 3 — Skill slash-command injection.
 *
 * Inserts `/<skillName> ` into the PTY for `sessionId`. This lands the text
 * in the input line; the operator presses Enter to invoke the skill.
 *
 * Modeled exactly on `insertMention.ts` (the file→pane @-mention drop).
 * Worktree-agnostic: a slash command is resolved by the CLI from its config
 * dirs, not from a file path.
 *
 * Shows a toast when the pane is not running instead of silently no-opping.
 */
import { toast } from 'sonner';
import { rpc } from '@/renderer/lib/rpc';
import type { AgentSession } from '@/shared/types';

/** Provider IDs for which slash-command injection is supported. */
export const SLASH_CAPABLE_PROVIDERS = new Set<string>(['claude', 'codex', 'gemini']);

/**
 * Per-provider prefix for skill injection (SMK-3b).
 * '/' for claude/gemini; '$' for codex.
 */
const SKILL_COMMAND_PREFIX: Record<string, '/' | '$'> = {
  claude: '/',
  codex: '$',
  gemini: '/',
};

/**
 * Returns true when `providerId` supports slash-command injection.
 * Exported so callers can gate toasts without calling the async function first.
 */
export function isSlashCapableProvider(providerId: string): boolean {
  return SLASH_CAPABLE_PROVIDERS.has(providerId);
}

/**
 * Writes `<prefix><skillName> ` (with a trailing space, no newline) to the
 * PTY for `sessionId`.  The prefix is `'/'` for claude/gemini and `'$'` for
 * codex (SMK-3b). The trailing space makes it easy to append arguments before
 * pressing Enter.
 *
 * @param sessionId     - The PTY session to write to.
 * @param skillName     - The skill's command name (no leading prefix).
 * @param sessionStatus - The current `AgentSession['status']`. Must be
 *                        `'running'` for injection to proceed.
 * @param providerId    - The provider owning this pane (selects the prefix).
 */
export async function insertSkillCommand(
  sessionId: string,
  skillName: string,
  sessionStatus: AgentSession['status'],
  providerId: string,
): Promise<void> {
  if (sessionStatus !== 'running') {
    toast.warning('Pane is not running', { description: 'Start the pane before dropping skills.' });
    return;
  }
  const prefix = SKILL_COMMAND_PREFIX[providerId] ?? '/';
  await rpc.pty.write(sessionId, `${prefix}${skillName} `);
}
