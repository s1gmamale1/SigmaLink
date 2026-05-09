// V3-W12-005 / V3-W14-006: 3-card picker shown above the stepper. Three modes:
//   • SigmaLink (⌘T) — the existing terminal-grid workspace (default).
//   • SigmaSwarm (⌘S) — short-circuit to the Swarm Room.
//   • SigmaCanvas (⌘K) — visual design tool. Was ALPHA in W12; W14-006
//     promotes it to live behind `kv['canvas.gaSign']==='1'`.
//
// Frames 0020 / 0180 / 0398 in the V3 frame log show three large clickable
// cards that select the kind of workspace the user wants to spin up. We
// render them as a horizontal row above the stepper. The selection drives
// the stepper labels + Step 3's affordances.

import { useEffect, useState } from 'react';
import { Layers, Network, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpcSilent } from '@/renderer/lib/rpc';
import { MOD_KEY_LABEL } from '@/renderer/lib/shortcuts';

export type LauncherMode = 'space' | 'swarm' | 'canvas';

interface CardSpec {
  id: LauncherMode;
  title: string;
  hotkey: string;
  blurb: string;
  icon: typeof Layers;
  alpha?: boolean;
}

const CARDS: CardSpec[] = [
  {
    id: 'space',
    title: 'SigmaLink',
    hotkey: 'T',
    blurb: 'Multi-pane terminal grid with one CLI agent per pane.',
    icon: Layers,
  },
  {
    id: 'swarm',
    title: 'SigmaSwarm',
    hotkey: 'S',
    blurb: 'Coordinated swarm of named agents working a shared mission.',
    icon: Network,
  },
  {
    id: 'canvas',
    title: 'SigmaCanvas',
    hotkey: 'K',
    blurb: 'Visual design tool — click an element, dispatch a prompt.',
    icon: Wand2,
    alpha: true,
  },
];

interface PickerCardsProps {
  mode: LauncherMode;
  onChange: (mode: LauncherMode) => void;
}

export function PickerCards({ mode, onChange }: PickerCardsProps) {
  // V3-W14-006: SigmaCanvas drops the ALPHA chip when `canvas.gaSign==='1'`.
  // Default treats GA as "off" so the chip stays until the operator flips
  // the kv flag explicitly.
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
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {CARDS.map((card) => {
        const Icon = card.icon;
        const active = mode === card.id;
        const showAlpha = card.alpha && !gaSign;
        return (
          <button
            key={card.id}
            type="button"
            onClick={() => onChange(card.id)}
            className={cn(
              'group flex h-full flex-col gap-2 rounded-lg border p-4 text-left transition',
              active
                ? 'border-ring bg-accent/15 shadow-sm'
                : 'border-border bg-card/40 hover:border-ring/40 hover:bg-card',
            )}
            aria-pressed={active}
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Icon className="h-4 w-4" />
                {card.title}
                {showAlpha ? (
                  <span className="rounded-sm bg-accent/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-accent-foreground">
                    Alpha
                  </span>
                ) : null}
              </span>
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {MOD_KEY_LABEL}
                {card.hotkey}
              </kbd>
            </div>
            <p className="text-xs text-muted-foreground">{card.blurb}</p>
          </button>
        );
      })}
    </div>
  );
}
