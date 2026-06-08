// P6 FEAT-2 — per-pane Context/MCP metadata sidebar.
//
// Renders when the pane is fullscreen-focused (`open` prop).
// When `open` is false the component returns null — no DOM, no polls.
//
// Sections:
//   1. MCP — Ruflo daemon state (glyph + text + detail). Reuses
//      `useRufloDaemonHealth` (the same shared poller used by PaneHeader).
//   2. Usage — inputTokens / outputTokens / totalCostUsd from
//      `rpc.usage.sessionSummary`. Gracefully shows an empty-state when no
//      priced turn has been recorded yet (non-Claude providers, new sessions).
//
// Styling: Liquid-Glass / `bg-card/80 backdrop-blur` panel consistent with
// PaneFooter and CheckpointPanel class conventions.
//
// A11y: every section is an `<section aria-labelledby>` region. State is
// conveyed with glyph + text (not colour-only). `role="status"` on the
// loading area keeps screen-reader noise minimal.
//
// Motion: the sidebar slides in/out via a CSS transition. The transition is
// suppressed when `prefers-reduced-motion: reduce` is set (inline style).
//
// Collapse: a toggle hides the panel down to a thin rail to reclaim monitor
// space. The choice is persisted globally in the KV store
// (`ui.paneContextSidebar.collapsed`) so it sticks across panes and reopens.
// Collapsed, the metadata sections unmount entirely → their pollers stop.
//
// LSP: there is NO LSP integration anywhere in this codebase. LSP state is
// intentionally omitted (N/A).

import { useCallback, useEffect, useId, useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { rpcSilent } from '@/renderer/lib/rpc';
import { prefersReducedMotion } from '@/renderer/lib/motion';
import {
  useRufloDaemonHealth,
  type RufloDaemonState,
} from './useRufloDaemonHealth';
import { derivePaneIdentity } from './pane-identity';
import type { AgentSession, UsageSummary } from '@/shared/types';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PaneContextSidebarProps {
  session: AgentSession;
  /** When false the sidebar renders nothing (closed / pane not fullscreen). */
  open: boolean;
}

// ── MCP state glyphs ─────────────────────────────────────────────────────────

function mcpGlyph(state: RufloDaemonState): string {
  switch (state) {
    case 'running':
      return '●';
    case 'starting':
      return '◌';
    case 'fallback':
      return '◎';
    case 'down':
      return '○';
    case 'unknown':
    default:
      return '?';
  }
}

function mcpGlyphColor(state: RufloDaemonState): string {
  switch (state) {
    case 'running':
      return 'text-emerald-400';
    case 'starting':
      return 'text-amber-400';
    case 'fallback':
      return 'text-sky-400';
    case 'down':
      return 'text-destructive';
    case 'unknown':
    default:
      return 'text-muted-foreground';
  }
}

function mcpLabel(state: RufloDaemonState): string {
  switch (state) {
    case 'running':
      return 'Connected';
    case 'starting':
      return 'Starting';
    case 'fallback':
      return 'Fallback (stdio)';
    case 'down':
      return 'Disconnected';
    case 'unknown':
    default:
      return 'Unknown';
  }
}

// ── Usage formatting helpers ──────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number | null): string {
  if (usd === null) return '—';
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(3)}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

// C1 — Identity section: agent alias, provider, model+effort, branch.
// Mounted first in the sidebar so it is the primary metadata surface when
// the pane is fullscreen. Fed by derivePaneIdentity (anti-drift shared source).
function IdentitySection({ session }: { session: AgentSession }) {
  const id = derivePaneIdentity(session);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="pane-context-identity-section">
      <h3
        id={headingId}
        className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
      >
        Identity
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted-foreground/70">agent</dt>
        <dd className="font-medium">
          {id.alias}{' '}
          <span className="opacity-60">{id.agentId}</span>
        </dd>
        <dt className="text-muted-foreground/70">provider</dt>
        <dd>{id.providerName}</dd>
        <dt className="text-muted-foreground/70">model</dt>
        <dd className="truncate">{id.modelLabel} · {id.effortLabel}</dd>
        <dt className="text-muted-foreground/70">branch</dt>
        <dd className="truncate">{id.branch}</dd>
      </dl>
    </section>
  );
}

function McpSection({ workspaceId }: { workspaceId: string }) {
  const health = useRufloDaemonHealth(workspaceId);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} data-testid="pane-context-mcp-section">
      <h3
        id={headingId}
        className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
      >
        MCP / Ruflo
      </h3>
      <div className="flex items-start gap-2">
        <span
          className={`mt-px select-none text-sm leading-none ${mcpGlyphColor(health.state)}`}
          aria-hidden="true"
        >
          {mcpGlyph(health.state)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium leading-snug" data-testid="pane-context-mcp-label">
            {mcpLabel(health.state)}
          </div>
          {health.detail ? (
            <div
              className="mt-0.5 break-words text-[10px] leading-snug text-muted-foreground/70"
              data-testid="pane-context-mcp-detail"
            >
              {health.detail}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function UsageSection({ sessionId }: { sessionId: string }) {
  const headingId = useId();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // All setState calls happen inside the async IIFE (after a microtask
    // boundary) — satisfies the react-hooks/set-state-in-effect rule. The
    // `alive` guard prevents stale writes after unmount / sessionId change.
    void (async () => {
      try {
        const result = await rpcSilent.usage.sessionSummary({ sessionId });
        if (alive) setSummary(result as UsageSummary);
      } catch {
        /* surfaced gracefully as empty-state — never throws into the tree */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const hasData =
    summary !== null && (summary.inputTokens > 0 || summary.outputTokens > 0);

  return (
    <section aria-labelledby={headingId} data-testid="pane-context-usage-section">
      <h3
        id={headingId}
        className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
      >
        Usage
      </h3>
      {loading ? (
        <p
          role="status"
          aria-label="Loading usage data"
          className="text-[10px] text-muted-foreground/50"
          data-testid="pane-context-usage-loading"
        >
          Loading…
        </p>
      ) : !hasData ? (
        <p
          className="text-[10px] text-muted-foreground/50"
          data-testid="pane-context-usage-empty"
        >
          No usage data yet
        </p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]" data-testid="pane-context-usage-data">
          <dt className="text-muted-foreground/70">In</dt>
          <dd className="font-mono font-medium tabular-nums">
            {formatTokens(summary!.inputTokens)} tok
          </dd>
          <dt className="text-muted-foreground/70">Out</dt>
          <dd className="font-mono font-medium tabular-nums">
            {formatTokens(summary!.outputTokens)} tok
          </dd>
          {summary!.cacheReadTokens > 0 ? (
            <>
              <dt className="text-muted-foreground/70">Cache</dt>
              <dd className="font-mono font-medium tabular-nums">
                {formatTokens(summary!.cacheReadTokens)} read
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground/70">Cost</dt>
          <dd className="font-mono font-medium tabular-nums" data-testid="pane-context-usage-cost">
            {formatCost(summary!.totalCostUsd)}
          </dd>
        </dl>
      )}
    </section>
  );
}

// ── Collapse preference ───────────────────────────────────────────────────────

// Persisted globally (one key, not per-pane) so the operator's choice to reclaim
// screen space sticks across panes and reopens. Mirrors the KV pattern used by
// use-workspace-colors. Best-effort: a missing/failed KV store falls back to the
// default expanded state and never throws into the render tree.
const COLLAPSED_KV_KEY = 'ui.paneContextSidebar.collapsed';

function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const stored = await rpcSilent.kv.get(COLLAPSED_KV_KEY);
        if (alive && stored === '1') setCollapsedState(true);
      } catch {
        /* default expanded */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      void rpcSilent.kv.set(COLLAPSED_KV_KEY, next ? '1' : '0')?.catch?.(() => {});
    } catch {
      /* persistence is best-effort */
    }
  }, []);

  return [collapsed, setCollapsed];
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * Context/MCP metadata sidebar for a fullscreen-focused pane.
 *
 * Mount point: PaneShell (lead agent). Renders only when `open` is true.
 *
 * Sections:
 *   - MCP: Ruflo daemon connected-state via `useRufloDaemonHealth`
 *   - Usage: token in/out + cost via `rpc.usage.sessionSummary`
 *   (LSP omitted — no LSP integration in this codebase)
 */
export function PaneContextSidebar({ session, open }: PaneContextSidebarProps) {
  // Honor prefers-reduced-motion for the slide-in transition.
  const reducedMotion = prefersReducedMotion();
  const [collapsed, setCollapsed] = useSidebarCollapsed();

  if (!open) return null;

  // Collapsed: a thin rail (w-7 ≈ 28px vs the full w-52 ≈ 208px) that reclaims
  // the monitor space while keeping a discoverable affordance to bring the
  // panel back. The metadata sections unmount entirely → their pollers stop.
  if (collapsed) {
    return (
      <aside
        aria-label="Pane context (collapsed)"
        data-testid="pane-context-sidebar-collapsed"
        className="flex w-7 shrink-0 flex-col items-center border-l border-border/60 bg-card/80 py-2 backdrop-blur-md"
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Show pane context"
          aria-label="Show pane context"
          aria-expanded={false}
          data-testid="pane-context-expand"
          className="rounded p-1 text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Pane context"
      data-testid="pane-context-sidebar"
      className={[
        'flex w-52 shrink-0 flex-col gap-4 overflow-y-auto',
        'border-l border-border/60 bg-card/80 px-3 py-3',
        'backdrop-blur-md',
        // Slide-in from the right
        reducedMotion ? '' : 'sl-sidebar-enter',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Collapse control — aligned to the panel's leading edge so it sits
          nearest the terminal it hides. */}
      <div className="-mb-2 -mt-1 flex items-center">
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="Hide pane context"
          aria-label="Hide pane context"
          aria-expanded={true}
          data-testid="pane-context-collapse"
          className="rounded p-1 text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <PanelRightClose className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <IdentitySection session={session} />
      {/* Divider */}
      <div className="h-px bg-border/40" aria-hidden="true" />
      <McpSection workspaceId={session.workspaceId} />
      {/* Divider */}
      <div className="h-px bg-border/40" aria-hidden="true" />
      <UsageSection sessionId={session.id} />
    </aside>
  );
}
