// Pure data — extracted from PresetPicker.tsx so the component file only
// exports React components (react-refresh/only-export-components).

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
  { id: 'legion', label: 'Legion', total: 50, split: { coordinator: 4, builder: 30, scout: 10, reviewer: 6 } },
];
