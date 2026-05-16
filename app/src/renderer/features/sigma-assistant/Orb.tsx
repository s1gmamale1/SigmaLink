// V3-W13-012 — Sigma Assistant orb. Four states drive CSS keyframes:
//   STANDBY    — gentle radial pulse.
//   LISTENING  — breathing scale + cyan tint (mic input expected).
//   RECEIVING  — scrolling stripe overlay (assistant streaming text).
//   THINKING   — slow rotating conic gradient (model reasoning).
// Click handler from STANDBY transitions into LISTENING via the parent.
// Real mic capture lands in W15 (SigmaVoice); for W13 the click flips
// the visual state so the rest of the UI is exercised end-to-end.

import { cn } from '@/lib/utils';

export type OrbState = 'standby' | 'listening' | 'receiving' | 'thinking';

interface Props {
  state: OrbState;
  onClick?: () => void;
  size?: number;
  className?: string;
}

const STATE_LABEL: Record<OrbState, string> = {
  standby: 'Sigma — standing by. Click to listen.',
  listening: 'Sigma — listening.',
  receiving: 'Sigma — receiving.',
  thinking: 'Sigma — thinking.',
};

export function Orb({ state, onClick, size = 56, className }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={STATE_LABEL[state]}
      title={STATE_LABEL[state]}
      data-state={state}
      className={cn(
        'sl-orb relative grid place-items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <span className="sl-orb-glow" aria-hidden />
      <span className="sl-orb-core" aria-hidden />
      <span className="sl-orb-ring" aria-hidden />
      <span className="sr-only">{STATE_LABEL[state]}</span>
      <style>{ORB_KEYFRAMES}</style>
    </button>
  );
}

const ORB_KEYFRAMES = `
.sl-orb {
  --orb-base: oklch(0.68 0.16 285);
  --orb-accent: oklch(0.78 0.14 220);
  background: radial-gradient(circle at 30% 30%, var(--orb-accent), var(--orb-base));
  box-shadow: 0 0 24px -8px var(--orb-accent), inset 0 0 8px -2px rgba(255,255,255,0.5);
  cursor: pointer;
}
.sl-orb-glow { position: absolute; inset: -8px; border-radius: 9999px;
  background: radial-gradient(circle, var(--orb-accent) 0%, transparent 65%);
  opacity: 0.45; pointer-events: none; }
.sl-orb-core { position: absolute; inset: 14%; border-radius: 9999px;
  background: radial-gradient(circle at 35% 30%, rgba(255,255,255,0.85), transparent 60%);
  pointer-events: none; }
.sl-orb-ring { position: absolute; inset: 0; border-radius: 9999px;
  border: 1px solid rgba(255,255,255,0.18); pointer-events: none; }

.sl-orb[data-state='standby'] .sl-orb-glow { animation: sl-orb-pulse 2.4s ease-in-out infinite; }
@keyframes sl-orb-pulse {
  0%, 100% { opacity: 0.30; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(1.08); }
}

.sl-orb[data-state='listening'] {
  --orb-accent: oklch(0.85 0.18 200);
  animation: sl-orb-breathe 1.6s ease-in-out infinite;
}
@keyframes sl-orb-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.06); }
}

.sl-orb[data-state='receiving'] .sl-orb-glow {
  background: linear-gradient(135deg,
    transparent 0%, transparent 35%,
    rgba(255,255,255,0.55) 50%,
    transparent 65%, transparent 100%);
  background-size: 240% 240%;
  animation: sl-orb-scroll 1.4s linear infinite;
  opacity: 0.7;
}
@keyframes sl-orb-scroll {
  0%   { background-position: 100% 100%; }
  100% { background-position: 0% 0%; }
}

.sl-orb[data-state='thinking'] .sl-orb-glow {
  background: conic-gradient(from 0deg,
    var(--orb-accent), transparent 35%,
    var(--orb-accent) 60%, transparent 90%, var(--orb-accent));
  animation: sl-orb-rotate 4s linear infinite;
  opacity: 0.55;
}
@keyframes sl-orb-rotate {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
`;
