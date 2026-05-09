// Shared types for the main-process skills subsystem. The renderer-facing
// shapes are mirrored in `src/shared/types.ts` (Skill, SkillProviderState).

import type { Skill, SkillProviderState } from '../../../shared/types';

export type ProviderTarget = 'claude' | 'codex' | 'gemini';

export const PROVIDER_TARGETS: readonly ProviderTarget[] = ['claude', 'codex', 'gemini'] as const;

export function isProviderTarget(value: unknown): value is ProviderTarget {
  return value === 'claude' || value === 'codex' || value === 'gemini';
}

/**
 * Frontmatter we accept from a SKILL.md. Per spec, only `name` (recommended,
 * defaults to folder name) and `description` (required) are validated strictly.
 * Everything else is forwarded to the fan-out targets verbatim.
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  tags?: string[];
  argumentHint?: string;
  arguments?: string | string[];
  whenToUse?: string;
  allowedTools?: string[];
  /** Free-form additional fields preserved for downstream fan-out targets. */
  extra?: Record<string, unknown>;
}

export interface FanoutResult {
  provider: ProviderTarget;
  ok: boolean;
  /** Absolute path written to (or that would have been written) for this provider. */
  targetPath: string;
  /** Filled when ok = false. */
  error?: string;
}

export type { Skill, SkillProviderState };
