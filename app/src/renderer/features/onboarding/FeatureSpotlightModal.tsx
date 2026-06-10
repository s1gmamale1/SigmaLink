// ONB-1 — Feature Spotlight. After first-run onboarding completes, surface a
// single optional, skippable modal that points new users at four headline
// surfaces: Memory, Swarm, Voice, and the ⌘K command palette. Each card has a
// "Show me" CTA that routes to the relevant room and dismisses the spotlight;
// Skip/close dismisses without routing.
//
// Gating (decided by the caller in App.tsx):
//   - `state.onboarded` true (read from reducer state, NOT kv — avoids the
//     onboarding-close race where the kv write lands a tick after the modal
//     closes), AND
//   - the `coachmark.featureSpotlight.seen` flag is loaded and unseen.
// `markSeen()` persists the "seen" flag so it never reopens.
//
// Motion: MOT-1 `sl-fade-in` (globally neutralized under
// prefers-reduced-motion via index.css). Accessibility: Radix Dialog provides
// role/labelled/focus-trap/Escape; Escape + outside-click both dismiss via
// `markSeen()`.

import { Brain, Command, Mic, Network, type LucideIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { useCoachmark } from '@/renderer/features/command-room/use-coachmark';

const COACHMARK_KEY = 'coachmark.featureSpotlight.seen';

interface SpotlightCard {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  cta: string;
}

const CARDS: readonly SpotlightCard[] = [
  {
    id: 'memory',
    icon: Brain,
    title: 'Memory',
    description: 'Notes, backlinks, and a live graph — an Obsidian-grade workspace memory.',
    cta: 'Show me',
  },
  {
    id: 'swarm',
    icon: Network,
    title: 'Swarms',
    description: 'Coordinate several agents at once with a shared mailbox and roster.',
    cta: 'Show me',
  },
  {
    id: 'voice',
    icon: Mic,
    title: 'Voice',
    description: 'Dictate prompts hands-free with local Whisper transcription.',
    cta: 'Show me',
  },
  {
    id: 'palette',
    icon: Command,
    title: 'Command palette',
    description: 'Press ⌘K anywhere to jump between rooms, workspaces, and actions.',
    cta: 'Open ⌘K',
  },
];

export { COACHMARK_KEY };

/**
 * The Feature Spotlight modal. Self-gates on the coachmark "seen" flag and
 * `state.onboarded`; renders nothing until both say "show". The caller
 * (App.tsx) mounts it unconditionally next to <OnboardingModal/>.
 */
export function FeatureSpotlightModal() {
  // Perf audit 2026-06-10 #7 — narrow selectors (mounted at the App root).
  const dispatch = useAppDispatch();
  const uiBoot = useAppStateSelector((s) => s.uiBoot);
  const onboarded = useAppStateSelector((s) => s.onboarded);
  const { loaded, seen, markSeen } = useCoachmark(COACHMARK_KEY);

  // Gate: boot settled (uiBoot) so we evaluate the REAL onboarded value, not the
  // optimistic `onboarded:true` initial — review C1: without uiBoot a fresh-install
  // boot race (the coachmark read landing before BOOT_UI) could open the spotlight
  // over the OnboardingModal for a never-onboarded user. uiBoot flips inside BOOT_UI
  // alongside the real onboarded, making the onboarding→spotlight ordering
  // deterministic. Then: onboarding finished AND the coachmark lookup resolved AND
  // the user hasn't seen the spotlight yet.
  const open = uiBoot && onboarded && loaded && !seen;

  function dismiss(): void {
    markSeen();
  }

  function showCard(id: string): void {
    switch (id) {
      case 'memory':
        dispatch({ type: 'SET_ROOM', room: 'memory' });
        break;
      case 'swarm':
        dispatch({ type: 'SET_ROOM', room: 'swarm' });
        break;
      case 'voice':
        dispatch({ type: 'SET_ROOM', room: 'settings' });
        dispatch({ type: 'SET_SETTINGS_TAB', tab: 'voice' });
        break;
      case 'palette':
        dispatch({ type: 'SET_COMMAND_PALETTE', open: true });
        break;
      default:
        break;
    }
    markSeen();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : dismiss())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>A quick tour of SigmaLink</DialogTitle>
          <DialogDescription>
            Four things worth knowing. Jump into any of them, or skip — you can always come back.
          </DialogDescription>
        </DialogHeader>

        <ul className="sl-fade-in grid gap-2 sm:grid-cols-2" style={{ animationTimingFunction: 'var(--ease-snappy)' }}>
          {CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <li
                key={card.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="text-sm font-semibold text-foreground">{card.title}</span>
                </div>
                <p className="flex-1 text-xs text-muted-foreground">{card.description}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => showCard(card.id)}
                >
                  {card.cta}
                </Button>
              </li>
            );
          })}
        </ul>

        <DialogFooter className="sm:justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
            Skip
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
