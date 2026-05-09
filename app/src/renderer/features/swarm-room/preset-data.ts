// Pure data — extracted from PresetPicker.tsx so the component file only
// exports React components (react-refresh/only-export-components).
//
// V3-W12-009: Legion → Battalion rename + Custom cap dropped from 50 → 20.
// Source: docs/02-research/v3-agent-roles-delta.md §2 + frames 0184/0185.

import type { SwarmPreset } from '@/shared/types';

export interface PresetMeta {
  id: SwarmPreset;
  label: string;
  total: number;
  split: { coordinator: number; builder: number; scout: number; reviewer: number };
}

export const PRESETS: PresetMeta[] = [
  { id: 'squad', label: 'Squad', total: 5, split: { coordinator: 1, builder: 2, scout: 1, reviewer: 1 } },
  { id: 'team', label: 'Team', total: 10, split: { coordinator: 2, builder: 5, scout: 2, reviewer: 1 } },
  { id: 'platoon', label: 'Platoon', total: 15, split: { coordinator: 2, builder: 7, scout: 3, reviewer: 3 } },
  // [INFERRED] Battalion split. V3 chip never expanded; extrapolated from
  // Platoon ratios. Confirm against frames 0184/0185 when high-res visuals
  // become available.
  { id: 'battalion', label: 'Battalion', total: 20, split: { coordinator: 3, builder: 11, scout: 3, reviewer: 3 } },
];

/** V3-W12-009: hard cap on Custom roster size. Was 50, now 20. */
export const CUSTOM_ROSTER_CAP = 20;
