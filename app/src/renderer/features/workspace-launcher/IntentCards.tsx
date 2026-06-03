// N1 — Intent-first workspace picker (BridgeSpace-style), adapted to SigmaLink.
//
// Renders the Step-1 hero: "Let's set up your workspace — pick how you'd like
// to work." Two large vertical cards drive the rest of the wizard:
//
//   • SigmaLink  (RECOMMENDED) → the standard worktree-per-pane terminal grid
//                                (LauncherMode 'space').
//   • SigmaSwarm (ADVANCED)    → the SigmaSwarm orchestrator path
//                                (LauncherMode 'swarm' → routes to the Swarm Room).
//
// A subtle bottom link "Open a single terminal" selects the 'single' mode (a
// one-pane workspace that skips Layout/Agents and launches straight away).
//
// SigmaCanvas is PRESERVED as a small secondary affordance below the link so a
// working mode is never dropped (it stays gated behind `canvas.gaSign` for the
// ALPHA chip exactly as PickerCards did).
//
// Apple-grade: this is a UTILITY surface, so motion is near-invisible — the
// card mount uses the shared `sl-fade-in` (MOT-1 `--ease-smooth`, reduced-
// motion-safe) and hover is a cheap GPU transform/opacity lift only. One
// accent, generous whitespace, SF Pro via the app type stack; type + space
// carry the hierarchy (no glow, no heavy borders).

import { useEffect, useState } from 'react';
import { Layers, Network, Terminal, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpcSilent } from '@/renderer/lib/rpc';
import { MOD_KEY_LABEL } from '@/renderer/lib/shortcuts';
import type { LauncherMode } from './modes';

interface HeroCardSpec {
  id: LauncherMode;
  title: string;
  hotkey: string;
  blurb: string;
  badge: 'recommended' | 'advanced';
  icon: typeof Layers;
}

// The two hero cards mirror the operator's BridgeSpace screenshots, reworded
// for SigmaLink's worktree-per-pane model.
const HERO_CARDS: HeroCardSpec[] = [
  {
    id: 'space',
    title: 'SigmaLink',
    hotkey: 'T',
    blurb:
      'A clean grid of terminals — great for everyday coding, with or without AI. Each pane gets its own git worktree.',
    badge: 'recommended',
    icon: Layers,
  },
  {
    id: 'swarm',
    title: 'SigmaSwarm',
    hotkey: 'S',
    blurb:
      'A team of AI agents tackles one goal together — planning, building, and reviewing in parallel, each on its own branch.',
    badge: 'advanced',
    icon: Network,
  },
];

interface IntentCardsProps {
  mode: LauncherMode;
  onChange: (mode: LauncherMode) => void;
}

export function IntentCards({ mode, onChange }: IntentCardsProps) {
  // SigmaCanvas drops its ALPHA chip when `canvas.gaSign==='1'` (preserved from
  // the previous PickerCards behaviour). Default treats GA as "off".
  const [gaSign, setGaSign] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const v = await rpcSilent.kv.get('canvas.gaSign');
        if (alive) setGaSign(v === '1');
      } catch {
        /* default false */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="sl-fade-in flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">
          Let&apos;s set up your workspace
        </h2>
        <p className="text-sm text-muted-foreground">Pick how you&apos;d like to work.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {HERO_CARDS.map((card) => {
          const Icon = card.icon;
          const active = mode === card.id;
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => onChange(card.id)}
              aria-pressed={active}
              data-testid={`intent-card-${card.id}`}
              className={cn(
                // GPU-only hover lift (transform/opacity) on the smooth curve;
                // no layout animation. focus-visible ring for keyboard users.
                'group relative flex flex-col gap-3 rounded-xl border p-5 text-left',
                'transition-[transform,border-color,background-color,box-shadow] duration-200 ease-[var(--ease-smooth)]',
                'hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'border-ring bg-accent/10 shadow-sm'
                  : 'border-border bg-card/40 hover:border-ring/50 hover:bg-card hover:shadow-sm',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 text-accent-foreground">
                  <Icon className="h-5 w-5" />
                </span>
                <BadgePill kind={card.badge} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold tracking-tight">{card.title}</span>
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {MOD_KEY_LABEL}
                  {card.hotkey}
                </kbd>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">{card.blurb}</p>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onClick={() => onChange('single')}
          data-testid="intent-card-single"
          aria-pressed={mode === 'single'}
          className={cn(
            'inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            mode === 'single'
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Terminal className="h-4 w-4" />
          <span className="underline-offset-4 group-hover:underline">Open a single terminal</span>
        </button>

        {/* SigmaCanvas preserved as a quiet secondary option (never dropped). */}
        <button
          type="button"
          onClick={() => onChange('canvas')}
          data-testid="intent-card-canvas"
          aria-pressed={mode === 'canvas'}
          className={cn(
            'inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            mode === 'canvas'
              ? 'text-foreground'
              : 'text-muted-foreground/80 hover:text-foreground',
          )}
        >
          <Wand2 className="h-3.5 w-3.5" />
          SigmaCanvas
          {!gaSign ? (
            <span className="rounded-sm bg-accent/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-accent-foreground">
              Alpha
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

function BadgePill({ kind }: { kind: 'recommended' | 'advanced' }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider',
        kind === 'recommended'
          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : 'bg-accent/25 text-accent-foreground',
      )}
    >
      {kind === 'recommended' ? 'Recommended' : 'Advanced'}
    </span>
  );
}
