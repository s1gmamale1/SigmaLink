// V3 SigmaMind sidebar — deterministic per-workspace colour dot.
// The workspace record has no colour column, so we derive one from the id.
// Same id → same colour across reloads / panes / windows.

// 8-slot palette pulled from Tailwind's *-400 ramp. Kept as raw class names
// so consumers can spread them straight into a Tailwind className. (We can't
// concatenate a Tailwind class name at runtime — the JIT only sees literal
// strings — so we list each one in full.)
const PALETTE: readonly string[] = [
  'bg-pink-400',
  'bg-blue-400',
  'bg-purple-400',
  'bg-amber-400',
  'bg-emerald-400',
  'bg-rose-400',
  'bg-cyan-400',
  'bg-indigo-400',
];

/** Deterministic polynomial rolling hash — preserved for workspace colour (backward-compat). */
function workspaceHash(id: string): number {
  return id.split('').reduce((acc, char) => acc * 31 + char.charCodeAt(0), 0) >>> 0;
}

export function workspaceColor(id: string): string {
  return PALETTE[workspaceHash(id) % PALETTE.length]!;
}

/**
 * FNV-1a 32-bit hash — integer-safe (all arithmetic stays within 32-bit via
 * bitwise ops) so it works correctly on long session ids (e.g. UUIDs) without
 * JS float-mantissa overflow. Used exclusively by the agent-identity helpers.
 */
function fnv1a32(id: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    // Multiply by FNV prime (16777619) keeping result in 32-bit range via |0
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // unsigned 32-bit
}

// ---------------------------------------------------------------------------
// Per-agent identity — FEAT-7
// ---------------------------------------------------------------------------

/**
 * Hex accent colours for per-agent identity dots/rings. Eight slots using
 * mid-saturation hues that read well on both light and Liquid Glass dark
 * surfaces. Deliberately distinct from the Tailwind workspace palette so a
 * same-workspace + same-agent scenario never visually collides.
 *
 * Hues chosen to avoid the provider stripe colours (blue, purple, amber, …)
 * and to remain visible against `bg-background` in every theme.
 */
export const AGENT_COLOR_PALETTE: readonly string[] = [
  '#f472b6', // pink-400
  '#34d399', // emerald-400
  '#60a5fa', // blue-400
  '#fb923c', // orange-400
  '#a78bfa', // violet-400
  '#2dd4bf', // teal-400
  '#facc15', // yellow-400
  '#f87171', // red-400
];

/**
 * Returns a stable hex accent colour for a given agent session id.
 * Same id → same colour across reloads; uses FNV-1a so long ids (UUIDs) work.
 */
export function agentColor(id: string): string {
  return AGENT_COLOR_PALETTE[fnv1a32(id) % AGENT_COLOR_PALETTE.length]!;
}

/**
 * Returns a stable 4-character short identifier for a given agent session id.
 * Uses the lower 16 bits of the FNV-1a hash rendered as 4 hex digits.
 * Deterministic and compact enough to distinguish same-provider panes visually.
 */
export function agentShortId(id: string): string {
  return (fnv1a32(id) & 0xffff).toString(16).padStart(4, '0');
}

/**
 * BSP-P3 — deterministic human-name alias for an agent session id. Same id →
 * same name across reloads / panes. 16 short, distinct, gender-neutral names so
 * collisions across a single grid are rare. Uses the existing FNV-1a hash so
 * long ids (UUIDs) work without float-mantissa overflow.
 */
export const AGENT_ALIAS_PALETTE: readonly string[] = [
  'Ava', 'Thea', 'Nia', 'Iris', 'Juno', 'Wren', 'Cleo', 'Vera',
  'Nova', 'Lyra', 'Echo', 'Sage', 'Rhea', 'Mira', 'Faye', 'Zara',
];

export function agentAlias(id: string): string {
  return AGENT_ALIAS_PALETTE[fnv1a32(id) % AGENT_ALIAS_PALETTE.length]!;
}

export const WORKSPACE_COLOR_PALETTE = PALETTE;

// ---------------------------------------------------------------------------
// Per-workspace hex dot colours — distinct-by-default, user-overridable.
// ---------------------------------------------------------------------------

/**
 * 15 mid-saturation hues that read well on dark glass surfaces. Wider than the
 * 8-slot Tailwind palette so adjacent workspaces are less likely to collide.
 * Deliberately overlaps some AGENT_COLOR_PALETTE hues — workspace dots and
 * agent dots are visually distinct (size + ring), so the same hex is fine.
 */
export const WORKSPACE_DOT_HEX_PALETTE: readonly string[] = [
  '#f472b6', // pink-400
  '#fb7185', // rose-400
  '#fb923c', // orange-400
  '#fbbf24', // amber-400
  '#facc15', // yellow-400
  '#a3e635', // lime-400
  '#34d399', // emerald-400
  '#2dd4bf', // teal-400
  '#22d3ee', // cyan-400
  '#38bdf8', // sky-400
  '#60a5fa', // blue-400
  '#818cf8', // indigo-400
  '#a78bfa', // violet-400
  '#c084fc', // purple-400
  '#e879f9', // fuchsia-400
];

/** Human-readable names for WORKSPACE_DOT_HEX_PALETTE (same order) — for a11y labels. */
export const WORKSPACE_DOT_COLOR_NAMES: readonly string[] = [
  'pink', 'rose', 'orange', 'amber', 'yellow', 'lime', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia',
];

/**
 * Deterministic hex colour for a workspace dot. UUID-safe (uses FNV-1a so
 * long ids never overflow). Returns a member of WORKSPACE_DOT_HEX_PALETTE.
 * Same id → same colour across reloads and panes.
 */
export function defaultWorkspaceColor(id: string): string {
  return WORKSPACE_DOT_HEX_PALETTE[fnv1a32(id) % WORKSPACE_DOT_HEX_PALETTE.length]!;
}
