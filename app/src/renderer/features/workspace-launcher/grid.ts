// Shared grid metadata for the workspace launcher. Pulled out of LayoutStep
// so React Fast Refresh keeps working — react-refresh/only-export-components
// disallows mixing component and value exports in the same module.

import type { GridPreset } from '@/shared/types';

export const PRESETS: GridPreset[] = [1, 2, 4, 6, 8, 10, 12];

// Frame-confirmed layouts (V3 frames 0030/0035/0040). Asymmetric counts
// (6, 10) split into two rows; 12 follows 4×3 from frame 0040. The 14/16
// entries are not in the V3 tile set but stay so consumers that read by
// preset never encounter an undefined. 18/20 mirror Command Room's expanded
// v1.1.3 swarm capacity layout.
export const GRID_DIMS: Record<GridPreset, { cols: number; rows: number }> = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  4: { cols: 2, rows: 2 },
  6: { cols: 3, rows: 2 },
  8: { cols: 4, rows: 2 },
  10: { cols: 5, rows: 2 },
  12: { cols: 4, rows: 3 },
  14: { cols: 7, rows: 2 },
  16: { cols: 4, rows: 4 },
  18: { cols: 5, rows: 4 },
  20: { cols: 5, rows: 4 },
};

export function gridLabel(n: GridPreset): string {
  const { cols, rows } = GRID_DIMS[n];
  return `${n} ${n === 1 ? 'terminal' : 'terminals'} · ${rows}×${cols} grid`;
}
