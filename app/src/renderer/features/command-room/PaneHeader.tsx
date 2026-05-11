// V1.1.4 Step 4: per-pane top chrome — single h-7 strip (V3 BridgeMind port).
//
// Collapses the legacy two-strip layout (h-7 PaneHeader + h-6 PaneStatusStrip)
// into one h-7 row matching V3 frames 0070 / 0100 / 0140. Layout:
//   [2px provider colour stripe along the very top]
//   [status dot] [PROVIDER·N truncated label] [spacer]
//   [Focus] [Split (disabled)] [Minimise (disabled)] [Close]
//
// The branch label, working dir, model, and effort previously rendered in
// PaneStatusStrip now surface inside a Radix tooltip anchored to the
// provider name. Split + Minimise are intentional placeholders marked
// `disabled` — they ship visually only and pop a "Coming in v1.2" tooltip.

import { Columns2, Maximize2, Minimize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { findProvider } from '@/shared/providers';
import type { AgentSession } from '@/shared/types';

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
  opencode: { label: 'kimi-k2.6', effort: 'medium' },
  bridgecode: { label: 'bridgecode-default', effort: 'medium' },
  cursor: { label: 'cursor-agent', effort: 'medium' },
  droid: { label: 'droid', effort: 'medium' },
  copilot: { label: 'copilot', effort: 'medium' },
};

interface Props {
  session: AgentSession;
  /** 1-based pane index — derived from the session's order in the swarm roster. */
  paneIndex: number;
  /** Lift focus to this pane (binds to global `SET_ACTIVE_SESSION`). */
  onFocus: () => void;
  /** Close handler — keeps the existing `rpc.pty.kill(session.id)` behaviour. */
  onClose: () => void;
}

export function PaneHeader({ session, paneIndex, onFocus, onClose }: Props) {
  const exited = session.status === 'exited';
  const errored = session.status === 'error';
  const dotColor = errored ? '#ef4444' : exited ? '#9ca3af' : '#22c55e';
  const provider = findProvider(session.providerId);
  const providerColor = provider?.color ?? '#6b7280';
  const providerName = provider?.name ?? session.providerId.toUpperCase();
  const providerShort = providerName.split(' ')[0] ?? providerName;
  const branch = session.branch ?? 'dev';
  const meta = DEFAULT_MODELS[session.providerId];
  const modelLabel = meta?.label ?? '—';
  const effortLabel = meta?.effort ?? '—';

  return (
    // `z-20` lifts the chrome above the PaneSplash overlay (z-10) so the
    // focus/close buttons stay clickable while the boot splash is rendered.
    <div className="relative z-20">
      {/* Provider color stripe — 2px accent at top */}
      <div
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{ background: providerColor }}
        aria-hidden="true"
      />
      <div className="flex h-7 items-center gap-2 border-b border-border px-2 pt-[2px] text-[11px]">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: dotColor }}
          aria-label={`status: ${session.status}`}
        />
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="max-w-[80px] truncate font-medium uppercase tracking-wider"
                style={{ color: providerColor }}
                aria-label={`${providerShort}·${paneIndex}`}
              >
                {providerShort}·{paneIndex}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="font-mono text-[10px]">
              <div className="space-y-0.5">
                <div>branch: {branch}</div>
                <div>model: {modelLabel}</div>
                <div>effort: {effortLabel}</div>
                <div>cwd: {session.cwd}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={onFocus}
                  aria-label="Focus pane"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Focus pane</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Disabled placeholder — wrap in a span so the tooltip still
                    triggers on hover even though the underlying button is
                    pointer-events:none. */}
                <span tabIndex={0} aria-label="Split pane (coming in v1.2)">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 cursor-not-allowed opacity-40"
                    disabled
                    aria-label="Split pane"
                  >
                    <Columns2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">Coming in v1.2</TooltipContent>
            </Tooltip>
          </TooltipProvider>
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
