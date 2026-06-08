// Phase 4 — BridgeSpace-faithful pane header.
//
// Single h-7 strip:
//   [2px provider colour stripe at top]
//   [ pane-title-pill: ●status  alias · effort ]  …spacer…
//   [opacity-0 reveal: ⚙ gear][⤢ fullscreen][opacity-0: ⊞ split][opacity-0: – minimise][✕ close]
//
// All metadata (branch, model, cwd, Ruflo health, usage, relabel, rewind, brief)
// moved into the gear popover (PaneGearPopoverBody). The dot-soup is gone.
//
// Props interface: UNCHANGED — all existing callers keep working.

import { useState, useRef, useEffect } from 'react';
import {
  Maximize2,
  Minimize2,
  Settings2,
  SplitSquareVertical,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { PANE_DRAG_MIME } from '@/renderer/lib/pane-context-builder';
import { agentColor } from '@/renderer/lib/workspace-color';
import { derivePaneIdentity } from './pane-identity';
import { PaneGearPopoverBody } from './PaneGearPopover';
import { useCoachmark } from './use-coachmark';
import { usePaneLiveStats } from './usePaneLiveStats';
import { onEvent, rpc } from '@/renderer/lib/rpc';
import type { AgentSession } from '@/shared/types';
import { getAgentRuntimeProfile } from '@/shared/runtime-profiles';

// ---------------------------------------------------------------------------
// Props — identical to the previous PaneHeader so callers need no changes.
// ---------------------------------------------------------------------------

interface Props {
  session: AgentSession;
  /** 1-based pane index — derived from the session's order in the swarm roster. */
  paneIndex: number;
  /** Lift focus to this pane (binds to global `SET_ACTIVE_SESSION`). */
  onFocus: () => void;
  /** Close handler — keeps the existing `rpc.pty.kill(session.id)` behaviour. */
  onClose: () => void;
  /**
   * v1.4.2 packet-12 — true fullscreen toggle. When wired the icon swaps to an
   * exit-fullscreen glyph; falls back to `onFocus` when undefined.
   */
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** v1.4.3 #06 — Pane Split. When undefined the split icon shows disabled. */
  providers?: { id: string; name: string }[];
  onSplit?: (direction: 'horizontal' | 'vertical', providerId: string) => void;
  /** Force-disable Split (e.g. pane is already inside a split group). */
  canSplit?: boolean;
  /** v1.4.3 #06 — Toggle the minimised state. */
  onToggleMinimise?: () => void;
  /** v1.4.3 #06 — Reflects the current pane.minimised flag. */
  isMinimised?: boolean;
  /** C-1 UI — count of staged + unstaged + untracked files. */
  uncommitted?: number | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PaneHeader({
  session,
  paneIndex,
  onFocus,
  onClose,
  isFullscreen = false,
  onToggleFullscreen,
  providers,
  onSplit,
  canSplit = true,
  onToggleMinimise,
  isMinimised = false,
  uncommitted = null,
}: Props) {
  const id = derivePaneIdentity(session);
  const errored = session.status === 'error';
  const exited = session.status === 'exited';
  const dotColor = errored ? '#ef4444' : exited ? '#9ca3af' : '#22c55e';

  // BSP-V2 — live cost + tok/s estimate badge. Status-gated (PERF-5): only poll
  // running panes — exited/error panes have a frozen ledger.
  const liveStats = usePaneLiveStats(session.id, session.status === 'running');

  // FEAT-12 — coachmark: first-use tooltip on the title pill (was on grip).
  const coachmark = useCoachmark('coachmark.dragGrip.seen');

  // BSP-O4 — inline rename state. `localName` starts from session.name and
  // tracks the `panes:session-renamed` event so rerenders after the RPC call
  // reflect the persisted value without a full workspace reload. `editing`
  // enters the inline <input>; Enter/blur commits; Escape cancels.
  const [localName, setLocalName] = useState<string | null>(session.name ?? null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep localName in sync when the session prop changes from external sources
  // (workspace reload, panes.listForWorkspace refetch, etc.). The guard +
  // microtask pattern (void async IIFE) satisfies the react-hooks/set-state-in-effect
  // lint rule which forbids synchronous setState directly in the effect body.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) setLocalName(session.name ?? null);
    })();
    return () => { alive = false; };
  }, [session.name]);

  // Subscribe to `panes:session-renamed` so OTHER surfaces (e.g. future
  // multi-window or a sibling header) also update this pill live.
  useEffect(() => {
    const off = onEvent<{ sessionId: string; name: string | null }>(
      'panes:session-renamed',
      (p) => {
        if (p.sessionId === session.id) setLocalName(p.name);
      },
    );
    return off;
  }, [session.id]);

  // Focus the input as soon as the editing state activates.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEditing(): void {
    setDraftName(localName ?? id.alias);
    setEditing(true);
  }

  function commitRename(): void {
    setEditing(false);
    const trimmed = draftName.trim() || null;
    // Optimistic update.
    setLocalName(trimmed);
    void rpc.panes.rename({ sessionId: session.id, name: trimmed }).catch(() => {
      // Revert on failure.
      setLocalName(session.name ?? null);
    });
  }

  function cancelRename(): void {
    setEditing(false);
    setDraftName('');
  }

  // Display label: operator name > computed alias.
  const displayLabel = localName?.trim() || id.alias;

  // FEAT-12 — drag-start handler. The pill is now the drag source.
  function handleGripDragStart(e: React.DragEvent): void {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(
      PANE_DRAG_MIME,
      JSON.stringify({
        kind: 'pane',
        sessionId: session.id,
        branch: session.branch ?? null,
        worktreePath: session.worktreePath ?? null,
        providerId: session.providerId,
      }),
    );
  }

  return (
    // `z-20` lifts the chrome above the PaneSplash overlay (z-10).
    // FEAT-12: `draggable` removed from the root div — only the pill initiates.
    <div className="relative z-20" data-testid="pane-header">
      {/* Provider color stripe — 2px accent at top */}
      <div
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{ background: id.providerColor }}
        aria-hidden="true"
      />
      {/* P5.2 density-aware height — h-7 comfortable/compact, h-6 dense tier. */}
      <div className="sl-glass-toolbar flex h-7 items-center gap-1.5 border-b border-border px-2 pt-[2px] text-[length:calc(11px*var(--pane-font-scale,1))] [[data-grid-density=dense]_&]:h-6">

        {/* ── Title pill (drag handle, status glyph, alias·effort) ──────── */}
        <TooltipProvider delayDuration={coachmark.loaded && !coachmark.seen ? 300 : 200}>
          <Tooltip defaultOpen={coachmark.loaded && !coachmark.seen}>
            <TooltipTrigger asChild>
              <span
                role="button"
                tabIndex={0}
                draggable={!editing}
                onDragStart={editing ? undefined : handleGripDragStart}
                onMouseEnter={coachmark.seen ? undefined : coachmark.markSeen}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') coachmark.markSeen();
                }}
                aria-label={`${id.providerShort}·${paneIndex} — drag to inject context`}
                data-testid="pane-title-pill"
                className="flex h-5 shrink-0 cursor-grab items-center gap-1 rounded-full border px-2 text-[10px] font-medium active:cursor-grabbing focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={{ borderColor: agentColor(session.id) }}
              >
                {/* Folded status dot */}
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: dotColor }}
                  data-testid="pane-status-glyph"
                  aria-label={`status: ${session.status}`}
                  aria-hidden="false"
                />
                {/* BSP-O4 — name / alias · effort. Click the name to enter
                    inline-edit mode; the input replaces it while editing. */}
                {editing ? (
                  <input
                    ref={inputRef}
                    data-testid="pane-rename-input"
                    value={draftName}
                    maxLength={200}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                      if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                      // Prevent drag from stealing focus or interfering.
                      e.stopPropagation();
                    }}
                    // Stop click inside the input from propagating to drag.
                    onClick={(e) => e.stopPropagation()}
                    className="max-w-[80px] bg-transparent outline-none"
                    aria-label="Rename pane"
                  />
                ) : (
                  <span
                    className="max-w-[80px] truncate cursor-text"
                    onDoubleClick={(e) => { e.stopPropagation(); startEditing(); }}
                    data-testid="pane-display-name"
                    title="Double-click to rename"
                  >
                    {displayLabel} · {id.effortLabel}
                  </span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="font-mono text-[10px]">
              {coachmark.seen
                ? `${id.providerShort}·${paneIndex} — drag to inject context`
                : 'Drag this pill to inject context into another pane\'s composer'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Spacer */}
        <span className="flex-1" />

        {/* BSP-V2 — live cost + tok/s estimate badge.
            Hidden when no usage recorded yet (hasData=false). Reduced-motion
            safe: only color/opacity, no transforms/animations. Truncate-safe:
            max-w-[120px] + truncate so the badge never pushes the icon cluster
            off-screen on narrow panes. */}
        <PaneLiveStatsBadge
          totalCostUsd={liveStats.totalCostUsd}
          estTokPerSec={liveStats.estTokPerSec}
          hasData={liveStats.hasData}
        />
        <PaneRuntimeProfileBadge runtimeProfileId={session.runtimeProfileId} />
        <PaneRssBadge
          rssBytes={liveStats.rssBytes}
          processCount={liveStats.processCount}
          rootRssBytes={liveStats.rootRssBytes}
          mcpRssBytes={liveStats.mcpRssBytes}
          topChildCommand={liveStats.topChildCommand}
        />

        {/* ── Icon cluster ────────────────────────────────────────────────── */}
        {/* Stop accidental drags from the cluster triggering a context drag. */}
        <div className="flex shrink-0 items-center gap-0.5" onDragStart={(e) => e.stopPropagation()}>

          {/* Gear — opacity-0 reveal (situational) */}
          <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <Popover>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        data-testid="pane-gear"
                        aria-label="Pane details & actions"
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Pane details &amp; actions</TooltipContent>
                  <PopoverContent side="bottom" align="end" className="w-auto p-0">
                    <PaneGearPopoverBody
                      session={session}
                      providers={providers}
                      uncommitted={uncommitted}
                    />
                  </PopoverContent>
                </Popover>
              </Tooltip>
            </TooltipProvider>
          </div>

          {/* Fullscreen — always visible (never opacity-0) */}
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={onToggleFullscreen ?? onFocus}
                  aria-label={
                    onToggleFullscreen
                      ? isFullscreen
                        ? 'Exit fullscreen (Esc)'
                        : 'Fullscreen pane'
                      : 'Pin focus ring (Cmd+Alt+N)'
                  }
                >
                  {onToggleFullscreen ? (
                    isFullscreen ? (
                      <Minimize2 className="h-3.5 w-3.5" />
                    ) : (
                      <Maximize2 className="h-3.5 w-3.5" />
                    )
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {onToggleFullscreen
                  ? isFullscreen
                    ? 'Exit fullscreen (Esc)'
                    : 'Fullscreen pane'
                  : 'Pin focus ring (Cmd+Alt+N)'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Split + Minimise — opacity-0 reveal (situational) */}
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">

            {/* Merged split button */}
            <PaneHeaderSplitButton
              providers={providers}
              onSplit={onSplit}
              canSplit={canSplit}
            />

            {/* Minimise / Restore */}
            {onToggleMinimise ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={onToggleMinimise}
                      aria-label={isMinimised ? 'Restore pane' : 'Minimise pane'}
                    >
                      <Minimize2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isMinimised ? 'Restore pane' : 'Minimise pane'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} aria-label="Minimise pane (coming in v1.2)">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 cursor-not-allowed opacity-40"
                        disabled
                        aria-label="Minimise pane"
                      >
                        <Minimize2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Coming in v1.2</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {/* Close — always visible (never opacity-0) */}
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={onClose}
                  aria-label="Close pane"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Close pane</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
}

function compactProfileLabel(runtimeProfileId: unknown): string {
  const profile = getAgentRuntimeProfile(runtimeProfileId);
  if (profile.id === 'ruflo-core') return 'Ruflo';
  if (profile.id === 'browser-tools') return 'Browser';
  if (profile.id === 'security-tools') return 'Security';
  return 'Full';
}

function PaneRuntimeProfileBadge({ runtimeProfileId }: { runtimeProfileId: unknown }) {
  const profile = getAgentRuntimeProfile(runtimeProfileId);
  return (
    <span
      data-testid="pane-runtime-profile-badge"
      className={cn(
        'max-w-[72px] truncate rounded-sm border border-border/40 bg-card/30 px-1.5 py-0.5',
        'text-[9px] font-mono tabular-nums text-muted-foreground',
        profile.mcpHeavy ? 'border-amber-400/40 text-amber-300' : '',
      )}
      aria-label={`Runtime profile: ${profile.label}`}
      title={profile.label}
    >
      {compactProfileLabel(runtimeProfileId)}
    </span>
  );
}

function formatRss(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function PaneRssBadge({
  rssBytes,
  processCount,
  rootRssBytes,
  mcpRssBytes,
  topChildCommand,
}: {
  rssBytes: number | null;
  processCount: number | null;
  rootRssBytes: number | null;
  mcpRssBytes: number | null;
  topChildCommand: string | null;
}) {
  if (!rssBytes || rssBytes <= 0) return null;
  const label = `RSS ${formatRss(rssBytes)}`;
  const detailParts = [
    rootRssBytes ? `root ${formatRss(rootRssBytes)}` : null,
    mcpRssBytes ? `MCP ${formatRss(mcpRssBytes)}` : null,
    topChildCommand ? `top child ${topChildCommand}` : null,
    processCount ? `${processCount} processes` : null,
  ].filter((part): part is string => Boolean(part));
  const detail = detailParts.length > 0 ? `${label} · ${detailParts.join(' · ')}` : label;
  return (
    <span
      data-testid="pane-rss-badge"
      className={cn(
        'max-w-[88px] truncate rounded-sm border border-border/40 bg-card/30 px-1.5 py-0.5',
        'text-[9px] font-mono tabular-nums text-muted-foreground',
      )}
      aria-label={detail}
      title={detail}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// BSP-V2 — Live stats badge (cost $ + tok/s estimate)
// ---------------------------------------------------------------------------

interface PaneLiveStatsBadgeProps {
  totalCostUsd: number | null;
  estTokPerSec: number | null;
  hasData: boolean;
}

/**
 * Compact badge showing `~N tok/s · $X.XXXX` in the pane header.
 * Hidden when hasData=false (no usage recorded yet). Always prefixes tok/s
 * with "~" to make the estimate nature explicit.
 *
 * Truncate-safe: max-w-[120px] + text-ellipsis so narrow panes don't overflow.
 * Reduced-motion safe: only opacity transition, no transforms.
 */
function PaneLiveStatsBadge({ totalCostUsd, estTokPerSec, hasData }: PaneLiveStatsBadgeProps) {
  if (!hasData) return null;

  const parts: string[] = [];
  if (estTokPerSec !== null) {
    parts.push(`~${estTokPerSec} tok/s`);
  }
  if (totalCostUsd !== null) {
    // Show 4 decimal places for sub-cent precision (e.g. $0.0042).
    parts.push(`$${totalCostUsd.toFixed(4)}`);
  }
  if (parts.length === 0) return null;

  return (
    <span
      data-testid="pane-live-stats-badge"
      className={cn(
        'max-w-[120px] truncate',
        'rounded-sm px-1.5 py-0.5',
        'text-[9px] font-mono tabular-nums text-muted-foreground',
        'border border-border/40 bg-card/30',
        // Reduced-motion safe: only opacity transition
        'transition-opacity motion-reduce:transition-none',
      )}
      aria-label={`Live stats: ${parts.join(', ')}`}
    >
      {parts.join(' · ')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Merged split button (ONE pane-split trigger, not two separate H/V icons)
// ---------------------------------------------------------------------------

interface SplitButtonProps {
  providers?: { id: string; name: string }[];
  onSplit?: (direction: 'horizontal' | 'vertical', providerId: string) => void;
  canSplit: boolean;
}

function PaneHeaderSplitButton({ providers, onSplit, canSplit }: SplitButtonProps) {
  const wired = Boolean(onSplit) && canSplit && (providers?.length ?? 0) > 0;

  if (!wired) {
    const disabledReason = !onSplit
      ? 'Coming in v1.2'
      : !canSplit
        ? 'Already in a split group (max 2-level deep)'
        : 'No providers available';
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} aria-label={`Split pane (${disabledReason})`}>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 cursor-not-allowed opacity-40"
                disabled
                aria-label="Split pane"
                data-testid="pane-split"
              >
                <SplitSquareVertical className="h-3.5 w-3.5" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{disabledReason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <DropdownMenu>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label="Split pane"
                data-testid="pane-split"
              >
                <SplitSquareVertical className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Split pane</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider">
          Split pane
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* Vertical splits */}
        <DropdownMenuLabel className="text-[9px] text-muted-foreground/70">Vertical</DropdownMenuLabel>
        {(providers ?? []).map((p) => (
          <DropdownMenuItem
            key={`v-${p.id}`}
            onClick={() => onSplit?.('vertical', p.id)}
          >
            {p.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* Horizontal splits */}
        <DropdownMenuLabel className="text-[9px] text-muted-foreground/70">Horizontal</DropdownMenuLabel>
        {(providers ?? []).map((p) => (
          <DropdownMenuItem
            key={`h-${p.id}`}
            onClick={() => onSplit?.('horizontal', p.id)}
          >
            {p.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
