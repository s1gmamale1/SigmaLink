// DOM terminal presenter — pure pane-sizing math, extracted so the cols/rows
// derivation is unit-testable (jsdom gives the host no layout, so the inline
// math in DomTerminalView could never be exercised) and so the cell-width
// measurement lives in ONE place (it was duplicated in runFit + the click
// hit-test, a classic drift hazard).

/** Characters in the hidden measurement probe (`'W'.repeat(PROBE_LEN)`). */
export const PROBE_LEN = 10;
/** FlowView horizontal padding, per side (CSS `padding: '4px 6px'`). */
export const PAD_X = 6;
/**
 * Width of FlowView's vertical scrollbar, in px.
 *
 * `src/index.css` styles `::-webkit-scrollbar { width: 6px }`. A styled
 * `::-webkit-scrollbar` makes Chromium/Electron use a CLASSIC scrollbar that
 * takes layout width (vs the zero-width overlay scrollbar you'd get otherwise),
 * so FlowView's scroll gutter eats 6px of the text area. The cols math measures
 * the OUTER host (which has no scrollbar), so this must be reserved explicitly
 * — otherwise cols overcounts by ~1 and a full child-wrapped line is a few px
 * too wide for the real text box, and `white-space: pre-wrap` strands the
 * trailing word onto its own line (the "inline break" bug). Keep in sync with
 * the `::-webkit-scrollbar` width in src/index.css.
 */
export const SCROLLBAR_W = 6;

/** Fallbacks for when the probe has not measured yet (jsdom / pre-layout). */
const FALLBACK_CELL_W = 7.2;
const FALLBACK_LINE_H = 17;

/**
 * Cell advance width in px from a measured probe span. Uses the sub-pixel
 * `getBoundingClientRect().width` rather than the integer-rounded `offsetWidth`:
 * over ~100 columns the per-char rounding error of `offsetWidth / PROBE_LEN`
 * compounds into several px of under-measure, which is enough to overcount cols
 * and strand a word.
 */
export function measureCellW(probe: HTMLElement | null | undefined): number {
  const w = probe ? probe.getBoundingClientRect().width : 0;
  return w > 0 ? w / PROBE_LEN : FALLBACK_CELL_W;
}

/** Single-row height in px from the probe (falls back pre-layout). */
export function measureLineH(probe: HTMLElement | null | undefined): number {
  const h = probe ? probe.getBoundingClientRect().height : 0;
  return h > 0 ? h : FALLBACK_LINE_H;
}

/**
 * Terminal grid size for a presenter host of the given inner pixel size.
 * Reserves FlowView's padding AND its layout-taking scrollbar so a cols-wide
 * line from the child program always fits the real text box. GridView (alt
 * screen, `white-space: pre`, no scrollbar) is unaffected by the reserve beyond
 * a harmless ≤6px right gap — it never wraps, so it can't strand.
 */
export function proposeGrid(
  width: number,
  height: number,
  cellW: number,
  lineH: number,
): { cols: number; rows: number } {
  const textW = width - PAD_X * 2 - SCROLLBAR_W;
  return {
    cols: Math.max(2, Math.floor(textW / cellW)),
    rows: Math.max(1, Math.floor(height / lineH)),
  };
}
