// Swarm Room — main-side type & preset definitions. The role enum and the
// composition tables live here so factory.ts and the renderer's PresetPicker
// stay aligned. The renderer imports the role-split numbers via a thin shape
// in shared/types.ts; this module is main-side only and may use Node APIs.

import type { Role, SwarmPreset } from '../../../shared/types';

export type { Role, SwarmPreset };

export interface RolesPerPreset {
  coordinator: number;
  builder: number;
  scout: number;
  reviewer: number;
}

/**
 * Roster split per preset. Sources: PRODUCT_SPEC.md §5.2.
 * total: 5 / 10 / 15 / 50.
 */
export const PRESET_ROSTER: Record<Exclude<SwarmPreset, 'custom'>, RolesPerPreset> = {
  squad: { coordinator: 1, builder: 2, scout: 1, reviewer: 1 },
  team: { coordinator: 2, builder: 5, scout: 2, reviewer: 1 },
  platoon: { coordinator: 2, builder: 7, scout: 3, reviewer: 3 },
  legion: { coordinator: 4, builder: 30, scout: 10, reviewer: 6 },
};

/** Per-role default provider when the operator didn't pick one. */
export const DEFAULT_PROVIDER_BY_ROLE: Record<Role, string> = {
  coordinator: 'codex',
  builder: 'claude',
  scout: 'gemini',
  reviewer: 'codex',
};

export const ROLE_ORDER: Role[] = ['coordinator', 'builder', 'scout', 'reviewer'];

export function totalForPreset(preset: SwarmPreset): number {
  if (preset === 'custom') return 0;
  const r = PRESET_ROSTER[preset];
  return r.coordinator + r.builder + r.scout + r.reviewer;
}

/**
 * Build the default roster (one RoleAssignment per agent) for a preset using
 * the per-role default providers. Used as a starting point for the UI; the
 * operator can override each row before launching.
 */
export function defaultRoster(preset: SwarmPreset): {
  role: Role;
  roleIndex: number;
  providerId: string;
}[] {
  if (preset === 'custom') return [];
  const split = PRESET_ROSTER[preset];
  const roster: { role: Role; roleIndex: number; providerId: string }[] = [];
  for (const role of ROLE_ORDER) {
    const count = split[role];
    for (let i = 1; i <= count; i++) {
      roster.push({ role, roleIndex: i, providerId: DEFAULT_PROVIDER_BY_ROLE[role] });
    }
  }
  return roster;
}

/** "coordinator-1", "builder-7", etc. */
export function agentKey(role: Role, roleIndex: number): string {
  return `${role}-${roleIndex}`;
}
