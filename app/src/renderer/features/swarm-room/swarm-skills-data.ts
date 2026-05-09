// V3-W13-011 — Swarm Skills 12-tile constants + post-launch flush helper.
//
// Pure data + a single async helper. Lives in a `.ts` (no `.tsx`) so the
// Fast-Refresh `only-export-components` rule never fires against the
// component file. The 12 tiles, group keys, and post-launch flush helper
// all live here; SwarmSkillsStep.tsx only exports the React component.

import { rpc } from '@/renderer/lib/rpc';

export type SkillGroup = 'workflow' | 'quality' | 'ops' | 'analysis';

export interface SkillTile {
  /** Stable key persisted to swarm_skills.skill_key. */
  key: string;
  title: string;
  description: string;
  group: SkillGroup;
}

// Group order (matches frame 0210 left-to-right reading order).
export const GROUP_ORDER: SkillGroup[] = ['workflow', 'quality', 'ops', 'analysis'];

export const GROUP_LABEL: Record<SkillGroup, string> = {
  workflow: 'Workflow',
  quality: 'Quality',
  ops: 'Ops',
  analysis: 'Analysis',
};

export const SKILL_TILES: SkillTile[] = [
  // WORKFLOW (3)
  {
    key: 'incremental-commits',
    title: 'Incremental Commits',
    description: 'Encourage small, reviewable commits scoped to a single concern.',
    group: 'workflow',
  },
  {
    key: 'refactor-only',
    title: 'Refactor Only',
    description: 'Forbid behaviour changes; refactors must keep the test suite green.',
    group: 'workflow',
  },
  {
    key: 'monorepo-aware',
    title: 'Monorepo Aware',
    description: 'Respect package boundaries; never edit files in unrelated workspaces.',
    group: 'workflow',
  },
  // QUALITY (6)
  {
    key: 'test-driven',
    title: 'Test-Driven',
    description: 'Write or update tests before implementing the fix.',
    group: 'quality',
  },
  {
    key: 'code-review',
    title: 'Code Review',
    description: 'Reviewers must read every diff hunk and call out style/perf issues.',
    group: 'quality',
  },
  {
    key: 'documentation',
    title: 'Documentation',
    description: 'Update README, JSDoc, and inline comments alongside the change.',
    group: 'quality',
  },
  {
    key: 'security-audit',
    title: 'Security Audit',
    description: 'Scan for secrets, unsafe deserialisation, and SSRF vectors.',
    group: 'quality',
  },
  {
    key: 'dry-principle',
    title: 'DRY Principle',
    description: 'Extract duplication when the third copy appears.',
    group: 'quality',
  },
  {
    key: 'accessibility',
    title: 'Accessibility',
    description: 'Honour ARIA roles, contrast ratios, and keyboard navigation.',
    group: 'quality',
  },
  // OPS (2)
  {
    key: 'keep-ci-green',
    title: 'Keep CI Green',
    description: 'Run lint + typecheck + tests before handing off to reviewer.',
    group: 'ops',
  },
  {
    key: 'migration-safe',
    title: 'Migration Safe',
    description: 'Forward-only DB migrations; no destructive ALTERs without a flag.',
    group: 'ops',
  },
  // ANALYSIS (1)
  {
    key: 'performance',
    title: 'Performance',
    description: 'Profile hot paths; avoid quadratic loops and N+1 queries.',
    group: 'analysis',
  },
];

/**
 * Flush a local `selected` map into a freshly-created swarm. Used by the
 * wizard immediately after `swarms.create` resolves: every "on" tile
 * becomes a `skill_toggle` envelope so the table mirrors the wizard state.
 * Off-tiles are emitted too so coordinators see an explicit baseline.
 */
export async function flushSkillsToSwarm(
  swarmId: string,
  selected: Record<string, boolean>,
): Promise<void> {
  for (const tile of SKILL_TILES) {
    const on = Boolean(selected[tile.key]);
    try {
      await rpc.swarms.sendMessage({
        swarmId,
        toAgent: '@coordinators',
        kind: 'skill_toggle',
        body: `${tile.key}=${on ? 'on' : 'off'}`,
        payload: { skillKey: tile.key, on, group: tile.group },
      });
    } catch {
      // Best-effort: a missing tile leaves the table at default (off),
      // which matches the on/off semantics anyway.
    }
  }
}
