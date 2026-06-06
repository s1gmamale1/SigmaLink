// Phase 4 — single source of truth for a pane's STATIC identity/metadata.
//
// Rendered identically by PaneGearPopover (grid view) and PaneContextSidebar
// (fullscreen) so the two surfaces cannot drift. The async / polled data
// (Ruflo daemon health, token usage) intentionally stays in those surfaces via
// their existing hooks — this helper is pure and synchronous so it is trivially
// testable and shareable.

import { findProvider } from '@/shared/providers';
import { defaultModelFor } from '@/shared/model-catalog';
import { agentAlias, agentColor, agentShortId } from '@/renderer/lib/workspace-color';
import type { AgentSession } from '@/shared/types';

export interface PaneIdentity {
  /** Deterministic human-name alias (BSP-P3). */
  alias: string;
  /** 4-char short id (FEAT-7). */
  agentId: string;
  /** Stable per-agent hex accent (FEAT-7). */
  agentAccent: string;
  /** Display provider name (honours a relabel). */
  providerName: string;
  /** Display provider brand colour. */
  providerColor: string;
  /** First word of the provider name (compact pill label). */
  providerShort: string;
  /** Real provider name (the underlying CLI when relabelled). */
  realProviderName: string;
  /** True when the display label differs from the real provider. */
  isRelabelled: boolean;
  /** Default model label for the real provider. */
  modelLabel: string;
  /** Default effort tier for the real provider (BSP-P3). */
  effortLabel: string;
  /** Branch name, defaulting to 'dev' (BSP-P2). */
  branch: string;
  /** Working directory. */
  cwd: string;
  /** Worktree path, or null when the pane runs in-place. */
  worktreePath: string | null;
}

/**
 * Derive the static identity/metadata bundle for a pane. Pure — same session →
 * same result. Mirrors the derivations that used to live inline in PaneHeader.
 */
export function derivePaneIdentity(session: AgentSession): PaneIdentity {
  const effectiveProviderId = session.displayProviderId ?? session.providerId;
  const provider = findProvider(effectiveProviderId);
  const realProvider = findProvider(session.providerId);
  const providerName = provider?.name ?? effectiveProviderId.toUpperCase();
  const meta = defaultModelFor(session.providerId);
  return {
    // BSP-O4 — prefer the operator-supplied name over the computed alias so
    // EVERY surface that renders `id.alias` (gear popover, context sidebar,
    // splash, header) reflects the rename, not just the title pill. Falls back
    // to the deterministic alias when unnamed. (Updates on the next session
    // prop refresh; the title pill also tracks the live rename broadcast.)
    alias: session.name?.trim() || agentAlias(session.id),
    agentId: agentShortId(session.id),
    agentAccent: agentColor(session.id),
    providerName,
    providerColor: provider?.color ?? '#6b7280',
    providerShort: providerName.split(' ')[0] ?? providerName,
    realProviderName: realProvider?.name ?? session.providerId.toUpperCase(),
    isRelabelled: effectiveProviderId !== session.providerId,
    modelLabel: meta?.label ?? '—',
    effortLabel: meta?.defaultEffort ?? '—',
    branch: session.branch ?? 'dev',
    cwd: session.cwd,
    worktreePath: session.worktreePath ?? null,
  };
}
