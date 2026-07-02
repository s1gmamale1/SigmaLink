// Minimal-chrome landing (BridgeMind-structure, SigmaLink tokens). Pure
// landing: hero + four stacked mode rows + kbd-hint footer. Screenshot-bare
// rows — blurbs live in `title` tooltips. Replaces IntentCards (deleted).
// The ALPHA gate on SigmaCanvas (`canvas.gaSign`) is preserved verbatim.

import { useEffect, useState } from 'react';
import { Layers, Network, Settings as SettingsIcon, Terminal, Wand2 } from 'lucide-react';
import { Kbd } from '@/renderer/components/Kbd';
import { Monogram } from '@/renderer/components/Monogram';
import { rpcSilent } from '@/renderer/lib/rpc';
import { MOD_KEY_LABEL } from '@/renderer/lib/shortcuts';
import type { LauncherMode } from './modes';

interface LandingRowSpec {
  id: LauncherMode;
  title: string;
  hotkey: string; // display label only — bindings are a WISHLIST item
  blurb: string; // tooltip
  icon: typeof Layers;
  alpha?: boolean;
}

const LANDING_ROWS: LandingRowSpec[] = [
  {
    id: 'space',
    title: 'SigmaLink',
    hotkey: 'T',
    blurb: 'A clean grid of terminals — each pane gets its own git worktree.',
    icon: Layers,
  },
  {
    id: 'swarm',
    title: 'SigmaSwarm',
    hotkey: 'S',
    blurb: 'A team of AI agents tackles one goal together, each on its own branch.',
    icon: Network,
  },
  {
    id: 'single',
    title: 'Single terminal',
    hotkey: '1',
    blurb: 'One plain terminal in the folder you pick.',
    icon: Terminal,
  },
  {
    id: 'canvas',
    title: 'SigmaCanvas',
    hotkey: '2',
    blurb: 'The visual design canvas for this workspace.',
    icon: Wand2,
    alpha: true,
  },
];

interface LauncherLandingProps {
  onPick: (mode: LauncherMode) => void;
  onOpenSettings: () => void;
}

export function LauncherLanding({ onPick, onOpenSettings }: LauncherLandingProps) {
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
    <div className="sl-fade-in flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-6 py-10">
      {/* Hero — brand + per-theme tinted tagline. */}
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex items-center gap-3">
          <Monogram size={36} />
          <span className="text-2xl font-semibold tracking-tight">SigmaLink</span>
        </div>
        <div className="text-4xl font-bold tracking-tight text-primary">Command the fleet.</div>
        <p className="text-sm text-muted-foreground">Choose how you want to work.</p>
      </div>

      {/* Stacked mode rows. */}
      <div className="flex w-full max-w-md flex-col gap-3">
        {LANDING_ROWS.map((row) => {
          const Icon = row.icon;
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onPick(row.id)}
              title={row.blurb}
              data-testid={`intent-card-${row.id}`}
              className="group relative flex w-full items-center gap-3 overflow-hidden rounded-xl border border-border bg-card/40 px-4 py-3.5 text-left transition-[transform,border-color,background-color,box-shadow] duration-200 ease-smooth hover:-translate-y-0.5 hover:border-ring/50 hover:bg-card hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* 1px token-driven gradient hairline (top edge). */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-primary/25 via-accent/20 to-transparent"
              />
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent-foreground">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1 text-sm font-medium tracking-tight">{row.title}</span>
              {row.alpha && !gaSign ? (
                <span className="rounded-sm bg-accent/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-accent-foreground">
                  Alpha
                </span>
              ) : null}
              <Kbd>
                {MOD_KEY_LABEL}
                {row.hotkey}
              </Kbd>
            </button>
          );
        })}
      </div>

      {/* Kbd-hint footer — only bindings that actually exist (mod+k, mod+o). */}
      <div
        data-testid="landing-footer"
        className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[11px] uppercase tracking-wider text-muted-foreground"
      >
        <span className="flex items-center gap-1.5">
          <Kbd>{MOD_KEY_LABEL}K</Kbd> Command palette
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>{MOD_KEY_LABEL}O</Kbd> Memory
        </span>
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 uppercase tracking-wider transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Open settings"
        >
          <SettingsIcon className="h-3 w-3" /> Settings
        </button>
      </div>
    </div>
  );
}
