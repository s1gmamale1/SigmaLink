// V3 SigmaMind sidebar — deterministic per-workspace colour dot.
// The workspace record has no colour column, so we derive one from the id.
// Same id → same colour across reloads / panes / windows.

// The agent-identity hash + alias now live in `@/shared/agent-identity` so the
// main process (Jorvis) and renderer compute pane names from ONE source. We
// re-export the alias helpers here so existing renderer importers are unchanged.
import { fnv1a32 } from '@/shared/agent-identity';
export { agentAlias, AGENT_ALIAS_PALETTE } from '@/shared/agent-identity';

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
