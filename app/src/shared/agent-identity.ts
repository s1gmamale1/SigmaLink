// Single source of truth for an agent pane's deterministic identity helpers,
// shared by main (Jorvis's list_active_sessions tool) and renderer
// (pane-identity, headers, splash). Pure + synchronous so BOTH processes can
// import it without crossing the main/renderer boundary, and so the assistant
// refers to a pane by the SAME name the operator sees — never a bare pane index.

/**
 * FNV-1a 32-bit hash — integer-safe (all arithmetic stays within 32-bit via
 * Math.imul) so it works correctly on long session ids (e.g. UUIDs) without
 * JS float-mantissa overflow. Used exclusively by the agent-identity helpers.
 */
export function fnv1a32(id: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    // Multiply by FNV prime (16777619) keeping result in 32-bit range.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // unsigned 32-bit
}

/**
 * BSP-P3 — deterministic human-name alias for an agent session id. Same id →
 * same name across reloads / panes / windows / processes. 16 short, distinct,
 * gender-neutral names so collisions across a single grid are rare.
 */
export const AGENT_ALIAS_PALETTE: readonly string[] = [
  'Ava', 'Thea', 'Nia', 'Iris', 'Juno', 'Wren', 'Cleo', 'Vera',
  'Nova', 'Lyra', 'Echo', 'Sage', 'Rhea', 'Mira', 'Faye', 'Zara',
];

export function agentAlias(id: string): string {
  return AGENT_ALIAS_PALETTE[fnv1a32(id) % AGENT_ALIAS_PALETTE.length]!;
}

/**
 * The pane's DISPLAY NAME — the exact label every surface shows the operator.
 * Prefers the operator-supplied `name` (BSP-O4, persisted on
 * `agent_sessions.name`); falls back to the deterministic {@link agentAlias}
 * when unnamed.
 *
 * This is the single source of truth used by BOTH the renderer (pane header,
 * gear popover, context sidebar, splash — via `derivePaneIdentity`) and the
 * main process (Jorvis's `list_active_sessions` tool) so the assistant names a
 * pane the way the operator does, instead of "Pane 0" / "Builder 1".
 */
export function derivePaneName(session: { id: string; name?: string | null }): string {
  return session.name?.trim() || agentAlias(session.id);
}
