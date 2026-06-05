// DEV-L2 — proportion-preserving grid track reshaping (extracted from GridLayout
// so the component file only exports components — react-refresh/only-export-components).

/** Preserve proportions across a pane add/remove instead of resetting.
 *  Shrink: slice (surviving tracks keep their fr). Grow: append the current
 *  average so a new track is "average width". fr units are relative — no
 *  renormalisation needed. */
export function reshapeFracs(prev: number[], next: number): number[] {
  if (next <= 0) return [];
  if (prev.length === next) return prev;
  if (prev.length === 0) return Array(next).fill(1);
  if (next < prev.length) return prev.slice(0, next);
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  return [...prev, ...Array(next - prev.length).fill(avg)];
}
