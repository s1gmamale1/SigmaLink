// V3 BridgeMind sidebar — deterministic per-workspace colour dot.
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

export function workspaceColor(id: string): string {
  // Simple polynomial rolling hash. `>>> 0` coerces to an unsigned 32-bit int
  // so the modulo is non-negative for any input.
  const hash = id.split('').reduce((acc, char) => acc * 31 + char.charCodeAt(0), 0) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

export const WORKSPACE_COLOR_PALETTE = PALETTE;
