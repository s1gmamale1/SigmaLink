// BSP-T4 — per-workspace tint helpers.
//
// Tint = a single hex hue that drives TWO inline overrides on <html>:
//   - `--accent`       → HSL CHANNEL components ("H S% L%", no hsl() wrapper),
//                        because the token system consumes accent via
//                        `hsl(var(--accent))` (and alpha utilities like
//                        `bg-accent/10` → `hsl(var(--accent) / 0.1)`). Writing a
//                        hex here would produce the invalid `hsl(#b966f5)` and
//                        break EVERY accent surface app-wide.
//   - `--surface-tint` → the FULL hex, because it is consumed raw inside the
//                        `color-mix(in oklab, …, var(--surface-tint) 10%)` chrome
//                        wash, where a hex color is exactly what's wanted.
// One picked hex → two formats. Inline style wins over `[data-theme]` blocks.
// Clearing removes the overrides, reverting to the theme defaults.
//
// Security: `parseTint` HEX-validates before any `setProperty` call —
// CSS-injection guard (never write an unvalidated string into style.setProperty).

export interface WorkspaceTint {
  accent: string;
}

/** Accepts 3- or 6-digit hex only (#abc / #abc123). */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Parse and validate a raw JSON string from KV storage.
 * Returns null on any parse failure or if the accent is not a valid hex color.
 */
export function parseTint(raw: string | null | undefined): WorkspaceTint | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { accent?: unknown };
    if (typeof v.accent === 'string' && HEX.test(v.accent)) return { accent: v.accent };
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * Convert a hex color (#abc or #aabbcc) to bare HSL channel components
 * ("H S% L%"), the form the SigmaLink token system expects so that
 * `hsl(var(--accent))` and `hsl(var(--accent) / <alpha>)` both resolve.
 * Pure function; inputs are pre-validated hex via `parseTint`.
 */
export function hexToHslChannels(hex: string): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let hue = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        hue = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        hue = (b - r) / d + 2;
        break;
      default:
        hue = (r - g) / d + 4;
        break;
    }
    hue /= 6;
  }
  return `${Math.round(hue * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/**
 * Apply a workspace tint: sets `--accent` (HSL channels) and `--surface-tint`
 * (raw hex) as inline properties on `<html>` (higher specificity than
 * `[data-theme]` blocks). Only called after `parseTint` validates the hex value.
 */
export function applyTint(t: WorkspaceTint): void {
  const s = document.documentElement.style;
  // Channels — keeps `hsl(var(--accent))` + `bg-accent/10` valid.
  s.setProperty('--accent', hexToHslChannels(t.accent));
  // Full color — consumed raw inside the color-mix() chrome wash.
  s.setProperty('--surface-tint', t.accent);
}

/**
 * Clear the workspace tint: removes the inline `--accent` and `--surface-tint`
 * overrides, reverting to the active `[data-theme]` block's values.
 */
export function clearTint(): void {
  const s = document.documentElement.style;
  s.removeProperty('--accent');
  s.removeProperty('--surface-tint');
}
