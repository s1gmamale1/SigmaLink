// Pure layout math for the Command Room fill-grid.
//
// Panes tile into rows that fill ALL space with no dead cell: rows are
// distributed as evenly as possible (≈ round(sqrt(n)) rows), earlier rows
// fuller. Within a row the panes share the width; the short last row's panes
// simply take a larger share — so every row fills edge-to-edge. Row heights and
// per-row column widths are independently resizable in the renderer (this module
// only decides which session goes in which row).
//
// No React/DOM/IPC — fully unit-testable.

/** Panes-per-row for `n` panes: ≈round(sqrt(n)) rows, earlier rows get the extra. */
export function rowCounts(n: number): number[] {
  if (n <= 0) return [];
  const rows = Math.max(1, Math.round(Math.sqrt(n)));
  const base = Math.floor(n / rows);
  const extra = n % rows; // first `extra` rows get one more
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Group an ordered session list into rows per `rowCounts`. */
export function paneRows(sessionIds: string[]): string[][] {
  const counts = rowCounts(sessionIds.length);
  const rows: string[][] = [];
  let idx = 0;
  for (const count of counts) {
    rows.push(sessionIds.slice(idx, idx + count));
    idx += count;
  }
  return rows;
}

/** Stable signature of a layout's shape (row × column counts). Used to decide
 *  whether persisted resize fractions still apply after a pane is added/removed. */
export function shapeSignature(sessionIds: string[]): string {
  return rowCounts(sessionIds.length).join('x');
}
