// V3-W13-012 — Sigma Assistant orb. Four states drive CSS keyframes:
//   STANDBY    — luminous sphere, gentle halo pulse + slow orbiting glints.
//   LISTENING  — breathing scale + brighter halo/glints (mic input expected).
//   RECEIVING  — scrolling stripe overlay (assistant streaming text).
//   THINKING   — slow rotating conic halo (model reasoning).
// Click handler from STANDBY transitions into LISTENING via the parent.
// The click handler flips the visual state for UI feedback; actual mic
// capture routes through the SigmaVoice global-capture pipeline (C-11).
//
// Phase 17 — "luminous" living orb (sigma-designs, testbed-picked V2 of 3
// candidates, screenshot-verified across aurora/ember/glass/cupertino/
// obsidian palettes on dark + light surfaces):
//   • Bright saturated sphere built ENTIRELY from the active theme's
//     --primary/--accent tokens — every theme gets its own orb; the shape
//     and motion language never change.
//   • Three soft blurred edge glints orbit at mixed speeds/directions
//     (12.1 / 9.1-reverse / 13.4-reverse s — the sigma-designs rim omegas),
//     each pulsing on an offset asymmetric envelope (sharp rise, soft
//     decay). Screen-blended so they read as LIGHT, not discs.
//   • One white-hot glint max (whiteness cap); accent underglow at the
//     bottom-right gives two-hue themes their second color.
//   • prefers-reduced-motion: loops off, static state indication stays.

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
      <span className="sl-orb-l sl-orb-l1" aria-hidden>
        <span />
      </span>
      <span className="sl-orb-l sl-orb-l2" aria-hidden>
        <span />
      </span>
      <span className="sl-orb-l sl-orb-l3" aria-hidden>
        <span />
      </span>
      <span className="sr-only">{STATE_LABEL[state]}</span>
      <style>{ORB_KEYFRAMES}</style>
    </button>
  );
}

const ORB_KEYFRAMES = `
.sl-orb {
  /* THE SPHERE — top-left highlight, theme body, accent underglow. All hues
     derive from the live theme tokens (the only per-theme variable). */
  background:
    radial-gradient(circle at 34% 30%, white 0%, color-mix(in oklab, hsl(var(--primary)) 38%, white) 14%, transparent 46%),
    radial-gradient(circle at 66% 80%, color-mix(in srgb, hsl(var(--accent)) 85%, transparent) 0%, transparent 55%),
    radial-gradient(circle at 50% 50%, color-mix(in oklab, hsl(var(--primary)) 88%, white) 0%, hsl(var(--primary)) 55%, color-mix(in oklab, hsl(var(--primary)) 68%, #06040a) 100%);
  box-shadow: inset 0 0 14px -2px rgba(255,255,255,0.35);
  cursor: pointer;
}

/* Halo — soft outward glow; standby pulses it, receiving/thinking repaint it. */
.sl-orb-glow { position: absolute; inset: -16%; border-radius: 9999px;
  background: radial-gradient(circle, color-mix(in srgb, hsl(var(--primary)) 55%, transparent) 0%, transparent 60%);
  opacity: 0.6; pointer-events: none; }

/* THE ORBITING GLINTS — each wrapper spins (mixed speeds/directions); the
   inner dot is a blurred radial light pulsing on its own offset phase.
   Screen blend keeps them reading as light on the sphere. */
.sl-orb-l { position: absolute; inset: 0; pointer-events: none; }
.sl-orb-l > span { position: absolute; left: 50%; top: 0; width: 46%; height: 24%;
  transform: translate(-50%, -50%); border-radius: 9999px;
  filter: blur(6px); mix-blend-mode: screen; display: block; }
.sl-orb-l1 { animation: sl-orb-rot 12.1s linear infinite; }
.sl-orb-l1 > span {
  background: radial-gradient(closest-side, hsl(var(--accent)) 0%, transparent 72%);
  animation: sl-orb-pulse-1 2.8s cubic-bezier(0.05, 0.7, 0.1, 1) infinite; }
.sl-orb-l2 { animation: sl-orb-rot 9.1s linear infinite reverse; rotate: 150deg; }
.sl-orb-l2 > span {
  /* The single white-hot glint (whiteness cap: only this one). */
  background: radial-gradient(closest-side, rgba(255,255,255,0.95) 0%, transparent 65%);
  animation: sl-orb-pulse-2 3.8s cubic-bezier(0.05, 0.7, 0.1, 1) infinite;
  animation-delay: -2.1s; }
.sl-orb-l3 { animation: sl-orb-rot 13.4s linear infinite reverse; rotate: 260deg; }
.sl-orb-l3 > span {
  background: radial-gradient(closest-side, color-mix(in oklab, hsl(var(--accent)) 55%, hsl(var(--primary))) 0%, transparent 74%);
  animation: sl-orb-pulse-1 4.6s cubic-bezier(0.05, 0.7, 0.1, 1) infinite;
  animation-delay: -1.2s; }

@keyframes sl-orb-rot { to { transform: rotate(360deg); } }
/* Asymmetric pulse — sharp rise (peak 12%), long soft decay. */
@keyframes sl-orb-pulse-1 { 0% { opacity: 0.45; } 12% { opacity: 1; } 100% { opacity: 0.45; } }
@keyframes sl-orb-pulse-2 { 0% { opacity: 0.4; } 12% { opacity: 0.9; } 100% { opacity: 0.4; } }

.sl-orb[data-state='standby'] .sl-orb-glow { animation: sl-orb-halo 3.4s ease-in-out infinite; }
@keyframes sl-orb-halo {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50%      { opacity: 0.85; transform: scale(1.06); }
}

.sl-orb[data-state='listening'] { animation: sl-orb-breathe 1.6s ease-in-out infinite; }
.sl-orb[data-state='listening'] .sl-orb-glow { opacity: 0.9; }
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
    hsl(var(--accent)), transparent 35%,
    hsl(var(--accent)) 60%, transparent 90%, hsl(var(--accent)));
  animation: sl-orb-rotate 4s linear infinite;
  opacity: 0.55;
}
@keyframes sl-orb-rotate {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* Reduced-motion: kill the perpetual loops (halo, glint orbit/pulse, breathe,
   scroll, rotate). The orb still indicates state — via static opacity per
   data-state — it just stops moving. (HIG "Reduce Motion" + WCAG 2.3.3.) */
@media (prefers-reduced-motion: reduce) {
  .sl-orb,
  .sl-orb .sl-orb-l,
  .sl-orb .sl-orb-l > span,
  .sl-orb[data-state='standby'] .sl-orb-glow,
  .sl-orb[data-state='listening'],
  .sl-orb[data-state='receiving'] .sl-orb-glow,
  .sl-orb[data-state='thinking'] .sl-orb-glow {
    animation: none !important;
    transform: none !important;
  }
  /* Static, non-animated state indication. */
  .sl-orb .sl-orb-l > span { opacity: 0.6; transform: translate(-50%, -50%) !important; }
  .sl-orb[data-state='standby'] .sl-orb-glow { opacity: 0.5; }
  .sl-orb[data-state='listening'] .sl-orb-glow { opacity: 0.9; }
  .sl-orb[data-state='receiving'] .sl-orb-glow {
    background: radial-gradient(circle, color-mix(in srgb, hsl(var(--accent)) 60%, transparent) 0%, transparent 65%);
    background-size: auto;
    background-position: center;
    opacity: 0.7;
  }
  .sl-orb[data-state='thinking'] .sl-orb-glow {
    background: radial-gradient(circle, color-mix(in srgb, hsl(var(--accent)) 60%, transparent) 0%, transparent 65%);
    opacity: 0.55;
  }
}
`;
