// V1.1.4 Step 4: per-pane top chrome — single h-7 strip (V3 SigmaMind port).
//
// Collapses the legacy two-strip layout (h-7 PaneHeader + h-6 PaneStatusStrip)
// into one h-7 row matching V3 frames 0070 / 0100 / 0140. Layout:
//   [2px provider colour stripe along the very top]
//   [status dot] [PROVIDER·N truncated label] [spacer]
//   [Focus] [Split-H] [Split-V] [Minimise] [Close]
//
// The branch label, working dir, model, and effort previously rendered in
// PaneStatusStrip now surface inside a Radix tooltip anchored to the
// provider name. Split (H/V) + Minimise shipped functional in v1.4.3 #06
// (PaneHeader wires `onSplit` + `onToggleMinimise`; pane-grid handles the
// flat-group sub-layout, max 2-level deep). The icons fall back to disabled
// when those callbacks are undefined (legacy callers).

import {
  ClipboardList,
  Columns2,
  GitBranch,
  Maximize2,
  Minimize2,
  Rows2,
  Target,
  X,
} from 'lucide-react';
import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { rpc } from '@/renderer/lib/rpc';
import { PANE_DRAG_MIME } from '@/renderer/lib/pane-context-builder';
import { Button } from '@/components/ui/button';
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
import { findProvider } from '@/shared/providers';
import type { AgentSession } from '@/shared/types';
import { useRufloDaemonHealth } from './useRufloDaemonHealth';
import type { RufloDaemonState } from './useRufloDaemonHealth';

// SF-7 — colour mapping for the Ruflo daemon health dot (FE-4 a11y standard).
function rufloHealthDotClass(state: RufloDaemonState): string {
  switch (state) {
    case 'running':  return 'bg-emerald-500';
    case 'fallback': return 'bg-amber-500';
    case 'down':     return 'bg-red-500';
    case 'starting': return 'bg-amber-400 animate-pulse';
    case 'unknown':  return 'bg-slate-400';
  }
}

// Mirror of `MODEL_OPTIONS` in `main/core/providers/models.ts` — the renderer
// can't import main-process modules so we duplicate the surface here. Keep
// this in sync when a provider's default model or effort changes.
interface ModelMeta {
  label: string;
  effort: 'low' | 'medium' | 'high';
}

const DEFAULT_MODELS: Record<string, ModelMeta> = {
  claude: { label: 'claude-opus-4.7', effort: 'high' },
  codex: { label: 'gpt-5.4', effort: 'high' },
  gemini: { label: 'gemini-2.5-pro', effort: 'medium' },
  kimi: { label: 'kimi-k2.6', effort: 'medium' },
  opencode: { label: 'opencode-default', effort: 'medium' },
};

interface Props {
  session: AgentSession;
  /** 1-based pane index — derived from the session's order in the swarm roster. */
  paneIndex: number;
  /** Lift focus to this pane (binds to global `SET_ACTIVE_SESSION`). */
  onFocus: () => void;
  /** Close handler — keeps the existing `rpc.pty.kill(session.id)` behaviour. */
  onClose: () => void;
  /**
   * v1.4.2 packet-12 — true fullscreen toggle. When the pane is fullscreen
   * the focus-ring icon (Target) is swapped for an exit-fullscreen icon
   * (Minimize2) and the click dispatches UNFOCUS_PANE instead of FOCUS_PANE.
   * Defaults to a no-op handler + `false` so the existing tests / consumers
   * keep working without forced migration.
   */
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  // v1.4.3 #06 — Pane Split + Minimise. When `onSplit` is supplied the
  // Split-H / Split-V icons become a real provider dropdown. When undefined
  // (legacy callers / older tests) they fall back to the disabled "Coming
  // in v1.2" placeholders so the existing PaneHeader tests keep working
  // without forced migration.
  providers?: { id: string; name: string }[];
  onSplit?: (
    direction: 'horizontal' | 'vertical',
    providerId: string,
  ) => void;
  /**
   * Force-disable the Split icons (e.g. the pane is already inside a split
   * group — max 2-level deep in v1.4.x). Independent of `onSplit` so a
   * caller can wire the handler but still gate it.
   */
  canSplit?: boolean;
  /** v1.4.3 #06 — Toggle the minimised state. When undefined the Minimise
   *  icon falls back to the legacy disabled placeholder. */
  onToggleMinimise?: () => void;
  /** v1.4.3 #06 — Reflects the current pane.minimised flag; flips the icon
   *  and tooltip between "Minimise" and "Restore". */
  isMinimised?: boolean;
  /** C-1 UI — count of staged + unstaged + untracked files. Badge hidden when 0 or null. */
  uncommitted?: number | null;
}

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
  const exited = session.status === 'exited';
  const errored = session.status === 'error';
  const dotColor = errored ? '#ef4444' : exited ? '#9ca3af' : '#22c55e';
  // SF-7 — Ruflo daemon health dot: poll once + every 5 s. workspaceId comes
  // directly from session (no extra prop needed — AgentSession already carries it).
  const rufloHealth = useRufloDaemonHealth(session.workspaceId);
  // SF-10 — display-only CLI label. `displayOverride` (local, optimistic)
  // takes precedence over the persisted `session.displayProviderId`, which in
  // turn overrides the real `session.providerId`. Cosmetic only — model/effort
  // + drag payload below keep using the REAL providerId.
  const [displayOverride, setDisplayOverride] = useState<string | null | undefined>(undefined);
  const effectiveProviderId =
    displayOverride !== undefined
      ? (displayOverride ?? session.providerId)
      : (session.displayProviderId ?? session.providerId);
  const isRelabelled = effectiveProviderId !== session.providerId;
  const realProvider = findProvider(session.providerId);
  const realProviderName = realProvider?.name ?? session.providerId.toUpperCase();
  const provider = findProvider(effectiveProviderId);
  const providerColor = provider?.color ?? '#6b7280';
  const providerName = provider?.name ?? effectiveProviderId.toUpperCase();
  const providerShort = providerName.split(' ')[0] ?? providerName;

  /** SF-10 — set/clear the display label (cosmetic; persisted via RPC). */
  function relabel(displayProviderId: string | null): void {
    setDisplayOverride(displayProviderId); // optimistic
    void rpc.panes
      .setDisplayProvider({ sessionId: session.id, displayProviderId })
      .catch(() => undefined);
  }
  const branch = session.branch ?? 'dev';
  const meta = DEFAULT_MODELS[session.providerId];
  const modelLabel = meta?.label ?? '—';
  const effortLabel = meta?.effort ?? '—';

  return (
    // `z-20` lifts the chrome above the PaneSplash overlay (z-10) so the
    // focus/close buttons stay clickable while the boot splash is rendered.
    <div
      className="relative z-20"
      data-testid="pane-header"
      draggable
      onDragStart={(e) => {
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
      }}
    >
      {/* Provider color stripe — 2px accent at top */}
      <div
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{ background: providerColor }}
        aria-hidden="true"
      />
      {/* Density-aware height — comfortable/compact stay h-7; the dense tier
          (10+ panes) shrinks the strip to h-6 to claw back vertical chrome.
          The arbitrary variant reads `data-density='dense'` off the GridLayout
          cell ancestor so no new prop has to thread through PaneShell. */}
      <div className="sl-glass-toolbar flex h-7 items-center gap-2 border-b border-border px-2 pt-[2px] text-[length:calc(11px*var(--pane-font-scale,1))] [[data-density=dense]_&]:h-6">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: dotColor }}
          aria-label={`status: ${session.status}`}
        />
        {/* SF-7 — Ruflo MCP daemon health dot */}
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${rufloHealthDotClass(rufloHealth.state)}`}
                data-testid="ruflo-health-dot"
                aria-label={`Ruflo MCP — ${rufloHealth.detail}`}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="font-mono text-[10px]">
              Ruflo MCP — {rufloHealth.detail}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {/* SF-10 — the provider label is a relabel dropdown (click to tag this
            pane with the CLI running in it). Keeps its hover tooltip via Radix
            asChild composition (Tooltip + DropdownMenu triggers on one span). */}
        <DropdownMenu>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <span
                    data-testid="pane-provider-label"
                    role="button"
                    tabIndex={0}
                    title="Click to set this pane's CLI label"
                    className="max-w-[80px] cursor-pointer truncate font-medium uppercase tracking-wider"
                    style={{ color: providerColor }}
                    aria-label={`${providerShort}·${paneIndex}`}
                  >
                    {providerShort}·{paneIndex}
                  </span>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start" className="font-mono text-[10px]">
                <div className="space-y-0.5">
                  <div>branch: {branch}</div>
                  <div>model: {modelLabel}</div>
                  <div>effort: {effortLabel}</div>
                  <div>cwd: {session.cwd}</div>
                  {isRelabelled ? <div className="text-amber-500">label: {providerName} (real: {realProviderName})</div> : null}
                  {session.worktreePath ? (
                    <div className="truncate text-[9px] text-muted-foreground" title={session.worktreePath}>
                      worktree: {session.worktreePath}
                    </div>
                  ) : null}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-[10px]">Label this pane as…</DropdownMenuLabel>
            {(providers ?? []).map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => relabel(p.id)}>
                {p.name}
              </DropdownMenuItem>
            ))}
            {isRelabelled ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => relabel(null)}>
                  Reset to {realProviderName}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* C-1 UI — inline branch · model · uncommitted badge */}
        <span className="flex items-center gap-1 truncate text-muted-foreground">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          <span className="max-w-[90px] truncate">{branch}</span>
          <span className="max-w-[80px] truncate text-[10px] opacity-70">{modelLabel}</span>
          {typeof uncommitted === 'number' && uncommitted > 0 ? (
            <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-600" title={`${uncommitted} uncommitted`}>±{uncommitted}</span>
          ) : null}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5" onDragStart={(e) => e.stopPropagation()}>
          {/* v1.4.2 packet-12 — Pane Focus button is now a real fullscreen
              toggle. When the pane is fullscreen the icon swaps to Minimize2
              and the tooltip / aria-label flip to "Exit fullscreen". The
              legacy "Pin focus ring (Cmd+Alt+N)" focus-ring action moves to
              click-anywhere-on-pane + the keyboard shortcut (unchanged in
              GridLayout). When no fullscreen handler is supplied (legacy
              callers / tests) we keep the v1.2.5 behaviour and fall back to
              `onFocus` so the existing PaneHeader tests stay green without
              forced migration. */}
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
                    <Target className="h-3.5 w-3.5" />
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
          {/* Apple restraint — the SITUATIONAL controls (Split-V, Split-H,
              Minimise, Brief) stay invisible until the pane is hovered or a
              control inside the pane takes keyboard focus. They remain in the
              DOM + tab order at all times (opacity only, never display:none)
              so keyboard users can still reach them via Tab. The `group`
              ancestor is the GridLayout cell wrapper; Fullscreen + Close stay
              full-opacity as the two always-available actions. */}
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {/* v1.4.3 #06 — Split icons. When the caller wires `onSplit` AND
                the pane is not already in a split group, the icons open a
                provider dropdown and call splitPane RPC. Otherwise they fall
                back to the legacy disabled placeholder so older callers /
                tests stay green and panes inside a split group can't recurse
                (max 2-level deep in v1.4.x). */}
            <PaneHeaderSplitButton
              direction="vertical"
              icon={Columns2}
              label="Split pane vertically"
              providers={providers}
              onSplit={onSplit}
              canSplit={canSplit}
            />
            <PaneHeaderSplitButton
              direction="horizontal"
              icon={Rows2}
              label="Split pane horizontally"
              providers={providers}
              onSplit={onSplit}
              canSplit={canSplit}
            />
            {/* v1.4.3 #06 — Minimise / Restore toggle. Falls back to disabled
                when the caller didn't wire `onToggleMinimise`. */}
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
            <PaneHeaderBriefButton session={session} />
          </div>
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

// C-5 — "Brief this pane" popover. Opens a small form that collects the plan
// capsule fields (goal, target files, success criteria, out-of-scope) and
// submits via `rpc.panes.brief`. Disabled when the pane is not running.
function PaneHeaderBriefButton({ session }: { session: AgentSession }) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [targetFiles, setTargetFiles] = useState('');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [outOfScope, setOutOfScope] = useState('');
  const [busy, setBusy] = useState(false);

  const disabled = session.status !== 'running';

  function splitLines(s: string): string[] {
    return s.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      await rpc.panes.brief({
        sessionId: session.id,
        worktreePath: session.worktreePath ?? null,
        capsule: {
          goal: goal.trim(),
          targetFiles: splitLines(targetFiles),
          successCriteria: splitLines(successCriteria),
          outOfScope: splitLines(outOfScope),
        },
      });
      setOpen(false);
      setGoal('');
      setTargetFiles('');
      setSuccessCriteria('');
      setOutOfScope('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={disabled}
                aria-label="Brief this pane"
              >
                <ClipboardList className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Brief this pane (C-5)</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent side="bottom" align="end" className="w-80 p-3">
        <form onSubmit={(e) => { void handleSubmit(e); }} className="flex flex-col gap-2">
          <p className="text-xs font-medium">Brief this pane</p>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Goal"
            rows={2}
            className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <textarea
            value={targetFiles}
            onChange={(e) => setTargetFiles(e.target.value)}
            placeholder="Target files (one per line)"
            rows={2}
            className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <textarea
            value={successCriteria}
            onChange={(e) => setSuccessCriteria(e.target.value)}
            placeholder="Success criteria (one per line)"
            rows={2}
            className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <textarea
            value={outOfScope}
            onChange={(e) => setOutOfScope(e.target.value)}
            placeholder="Out of scope (one per line)"
            rows={2}
            className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Button type="submit" disabled={busy || !goal.trim()} className="mt-1 h-7 text-xs" aria-label="Inject capsule">
            Inject capsule
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

// v1.4.3 #06 — Split-icon button shared between the Split-V (Columns2) and
// Split-H (Rows2) icons. When wired and enabled, clicking the icon opens a
// provider dropdown; picking a provider calls `onSplit(direction, providerId)`.
// When disabled (no handler OR canSplit=false) it falls back to the legacy
// disabled-with-tooltip placeholder. The button retains the same
// `aria-label="Split pane"` as the v1.2.5 placeholder so existing PaneHeader
// tests that query by that label keep passing.
interface SplitButtonProps {
  direction: 'horizontal' | 'vertical';
  icon: typeof Columns2;
  label: string;
  providers?: { id: string; name: string }[];
  onSplit?: (direction: 'horizontal' | 'vertical', providerId: string) => void;
  canSplit: boolean;
}

function PaneHeaderSplitButton({
  direction,
  icon: Icon,
  label,
  providers,
  onSplit,
  canSplit,
}: SplitButtonProps) {
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
            <span tabIndex={0} aria-label={`${label} (${disabledReason})`}>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 cursor-not-allowed opacity-40"
                disabled
                aria-label="Split pane"
              >
                <Icon className="h-3.5 w-3.5" />
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
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider">
          {label}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(providers ?? []).map((p) => (
          <DropdownMenuItem
            key={p.id}
            onClick={() => onSplit?.(direction, p.id)}
          >
            {p.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
