// C-9 — Guardrail definitions for the Skills-tab guardrail matrix.
//
// Four named guardrails that, when enabled, inject a guidance block into each
// new agent's worktree CLAUDE.md at dispatch. Titles seeded from SKILL_TILES
// in swarm-room/swarm-skills-data.ts; instructions are multi-line CLAUDE.md
// directives authored per guardrail.

export interface Guardrail {
  id: string;
  title: string;
  instruction: string;
}

export const GUARDRAILS: Record<string, Guardrail> = {
  'test-driven': {
    id: 'test-driven',
    title: 'Test-Driven',
    instruction: [
      'Write or update a failing test before implementing the fix or feature.',
      'Never commit code that causes the test suite to go red.',
      'If a test is hard to write, treat that as a design signal — simplify the implementation first.',
    ].join('\n'),
  },
  'security-audit': {
    id: 'security-audit',
    title: 'Security Audit',
    instruction: [
      'Before completing any task, scan the diff for:',
      '  - Hardcoded secrets, tokens, or credentials.',
      '  - Unsafe deserialisation or eval-like patterns.',
      '  - SSRF vectors (user-controlled URLs passed to fetch/http).',
      '  - Missing input validation at system boundaries.',
      'Block the task if a critical finding is present; note non-critical findings in your summary.',
    ].join('\n'),
  },
  'keep-ci-green': {
    id: 'keep-ci-green',
    title: 'Keep CI Green',
    instruction: [
      'Run lint, typecheck, and tests before handing off to the reviewer:',
      '  npm run build && npm test',
      'Do not proceed to the next task until all checks pass.',
      'If CI was already failing before your change, note it explicitly — do not hide pre-existing failures.',
    ].join('\n'),
  },
  'dry-principle': {
    id: 'dry-principle',
    title: 'DRY Principle',
    instruction: [
      'Extract duplication when the third copy of a code pattern appears.',
      'Prefer a shared utility over copy-paste; name it clearly and co-locate it with its consumers.',
      'Do NOT prematurely abstract — wait for the third occurrence before refactoring.',
    ].join('\n'),
  },
};

/**
 * Build a CLAUDE.md guardrail block for the given enabled ids.
 *
 * Returns `''` when `enabledIds` is empty or contains no known ids.
 * Skips unknown ids silently.
 */
export function buildGuardrailMarkdown(enabledIds: string[]): string {
  const enabled = enabledIds
    .map((id) => GUARDRAILS[id])
    .filter((g): g is Guardrail => g !== undefined);

  if (enabled.length === 0) return '';

  const lines: string[] = ['## Active guardrails', ''];
  for (const g of enabled) {
    lines.push(`### **${g.title}**`, '', g.instruction, '');
  }

  return lines.join('\n');
}
