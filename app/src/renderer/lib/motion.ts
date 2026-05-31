/**
 * MOT-1 — Apple-grade motion vocabulary for overlay primitives.
 *
 * ONE source of truth for how every Radix/cmdk/vaul overlay enters and
 * exits. Consumers (the `components/ui/*` overlays) compose these constants
 * into their `className` so the whole app speaks a single motion language —
 * spring-driven, GPU-composited (transform + opacity only), Reduce-Motion
 * safe — instead of the stock `duration-200 ease-out animate-in/out`.
 *
 * The actual curves + durations are CSS custom properties / Tailwind
 * animations defined in:
 *   - src/index.css           → --ease-smooth | --ease-snappy | --ease-bouncy
 *                               + --motion-fast | --motion | --motion-slow
 *   - tailwind.config.js      → animate-sl-* keyframes bound to those tokens
 *
 * Reduce Motion: we do NOT branch in JS for the common case. The global
 * `@media (prefers-reduced-motion: reduce)` reset in index.css forces
 * animation-duration to 0.01ms !important on everything, which neutralizes
 * these animations while still firing `animationend` (so Radix exit
 * presence resolves and the node unmounts). `prefersReducedMotion()` is
 * exported only for the rare case where a consumer needs to branch in JS.
 */

/**
 * Centred overlays — dialog content, command palette.
 * Fade + gentle scale, gated on Radix's `data-state`.
 *
 * `animate-sl-overlay-in/out` rides the snappy spring on enter (250ms) and
 * the smooth curve on exit (150ms) — exits read quicker + calmer per HIG.
 */
export const overlayContentMotion =
  "data-[state=open]:animate-sl-overlay-in data-[state=closed]:animate-sl-overlay-out";

/**
 * Modal scrims / overlays — the dimmed backdrop behind a dialog/sheet/drawer.
 * Plain cross-fade (no scale) so the dim never "pops".
 */
export const overlayScrimMotion =
  "data-[state=open]:animate-sl-fade-in data-[state=closed]:animate-sl-fade-out";

/**
 * Anchored popovers / menus / selects / hover-cards.
 * Small fade + scale + 4px lift, on the fast snappy budget — these are
 * lightweight, frequently-triggered surfaces so they should feel instant.
 */
export const popoverContentMotion =
  "data-[state=open]:animate-sl-pop-in data-[state=closed]:animate-sl-pop-out";

/**
 * Tooltips — the lightest surface. Same fast pop as popovers; the
 * `data-state` selectors keep it consistent with the rest of the family.
 */
export const tooltipContentMotion = popoverContentMotion;

/**
 * Edge sheets / drawers — full-surface directional slide keyed off the
 * resolved side. Enter rides the snappy spring at the slow budget (350ms)
 * so a large surface settles with weight; exit is quicker + smooth.
 *
 * Radix `react-dialog` (Sheet) exposes the side via our own conditional
 * classes, so we key on `data-[state]`. vaul (Drawer) drives its own
 * drag-physics slide internally, so the Drawer only adopts our scrim
 * (overlayScrimMotion) — we do NOT override vaul's content transform.
 */
const SHEET_SLIDE: Record<"top" | "right" | "bottom" | "left", string> = {
  right:
    "data-[state=open]:animate-sl-slide-in-right data-[state=closed]:animate-sl-slide-out-right",
  left: "data-[state=open]:animate-sl-slide-in-left data-[state=closed]:animate-sl-slide-out-left",
  top: "data-[state=open]:animate-sl-slide-in-top data-[state=closed]:animate-sl-slide-out-top",
  bottom:
    "data-[state=open]:animate-sl-slide-in-bottom data-[state=closed]:animate-sl-slide-out-bottom",
};

/** Slide animation for a Radix-dialog-backed Sheet on a given side. */
export function sheetSideMotion(
  side: "top" | "right" | "bottom" | "left"
): string {
  return SHEET_SLIDE[side];
}

/**
 * True at the moment of call when the OS requests reduced motion. Most
 * consumers should NOT need this — the CSS reset already neutralizes the
 * animations. Provided for JS that must branch (e.g. imperative spring
 * handoff) and guarded for non-DOM/SSR/test contexts.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
