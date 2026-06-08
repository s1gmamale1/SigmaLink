// Pure layout math for the Command Room uniform fill-grid.
//
// Panes tile into a clean grid that fills ALL space with no dead cell: rows are
// distributed as evenly as possible (≈ round(sqrt(n)) rows), and the last/short
// rows widen their cells to span the full width. The column count is the LCM of
// the per-row counts so every row's cells sum to exactly `cols` (a perfect fill).
//
// No React/DOM/IPC — fully unit-testable. The grid is a pure function of the
// session list; there is no persisted layout state.

export interface GridCell {
  sessionId: string;
  /** Number of grid columns this cell spans. */
  colSpan: number;
}

export interface GridShape {
  cols: number;
  rows: number;
  cells: GridCell[];
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a: number, b: number): number {
  return (a * b) / gcd(a, b);
}

/** Panes-per-row for `n` panes: ≈round(sqrt(n)) rows, earlier rows get the extra. */
export function rowCounts(n: number): number[] {
  if (n <= 0) return [];
  const rows = Math.max(1, Math.round(Math.sqrt(n)));
  const base = Math.floor(n / rows);
  const extra = n % rows; // first `extra` rows get one more
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Build the fill-grid for an ordered session list. */
export function gridShape(sessionIds: string[]): GridShape {
  const n = sessionIds.length;
  if (n === 0) return { cols: 1, rows: 1, cells: [] };
  const counts = rowCounts(n);
  const cols = counts.reduce((acc, c) => lcm(acc, c), 1);
  const rows = counts.length;
  const cells: GridCell[] = [];
  let idx = 0;
  for (const count of counts) {
    const colSpan = cols / count; // integer: cols is a multiple of every count
    for (let i = 0; i < count; i++) {
      cells.push({ sessionId: sessionIds[idx]!, colSpan });
      idx += 1;
    }
  }
  return { cols, rows, cells };
}
