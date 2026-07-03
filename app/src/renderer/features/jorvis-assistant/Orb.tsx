// V3-W13-012 — Sigma Assistant orb. Four states drive CSS keyframes:
//   STANDBY    — the living idle (wobble + rim lights + halo pulse).
//   LISTENING  — breathing scale + brighter accent-tinted rim (mic expected).
//   RECEIVING  — scrolling stripe overlay (assistant streaming text).
//   THINKING   — slow rotating conic halo (model reasoning).
// Click handler from STANDBY transitions into LISTENING via the parent.
// The click handler flips the visual state for UI feedback; actual mic
// capture routes through the SigmaVoice global-capture pipeline (C-11).
//
// Phase 17 — sigma-designs living orb (orb-recipe.md), CSS port:
//   • Silhouette is never a perfect circle: border-radius wobble ≤±4% on an
//     incommensurate 6.7s period (recipe caps total at 10% of radius).
//   • THE LAW OF THE RIM: four independent lights slide along the edge at
//     mixed speeds/directions — ω = 0.52 / −0.69 / 0.83 / −0.47 rad/s
//     (periods 12.1 / 9.1 / 7.6 / 13.4 s) — two per rim layer, each layer
//     pulsing on its own asymmetric envelope (sharp rise, soft decay). Never
//     one traveling highlight, never whole-edge hue rotation.
//   • Interior is near-black GLASS with a hue cast + a dim drifting aurora —
//     never flat #000, never competing with the rim. One sheen band only.
//   • Only ONE light mixes toward white (whiteness cap).
//   • Every color derives from the active theme's --primary/--accent tokens,
//     so each theme gets its own orb; shape/animation language is identical.

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
      <span className="sl-orb-rim1" aria-hidden />
      <span className="sl-orb-rim2" aria-hidden />
      <span className="sl-orb-core" aria-hidden />
      <span className="sl-orb-ring" aria-hidden />
      <span className="sr-only">{STATE_LABEL[state]}</span>
      <style>{ORB_KEYFRAMES}</style>
    </button>
  );
}

const ORB_KEYFRAMES = `
/* Rim-light slide angles — @property registration makes conic 'from' angles
   animatable. Distinct names from the aurora pane-rim tokens (--aurora-a*). */
@property --orb-a1 { syntax: '<angle>'; inherits: false; initial-value: 20deg; }
@property --orb-a2 { syntax: '<angle>'; inherits: false; initial-value: 152deg; }
@property --orb-a3 { syntax: '<angle>'; inherits: false; initial-value: 244deg; }
@property --orb-a4 { syntax: '<angle>'; inherits: false; initial-value: 78deg; }

.sl-orb {
  /* Theme-derived palette — the ONLY thing that changes per theme.
     l3 is the single white-mixed light (whiteness cap, recipe §2). */
  --orb-l1: hsl(var(--accent));
  --orb-l2: hsl(var(--primary));
  --orb-l3: color-mix(in oklab, hsl(var(--primary)) 45%, white);
  --orb-l4: color-mix(in oklab, hsl(var(--accent)) 55%, hsl(var(--primary)));
  /* Near-black glass with a hue cast — never #000 (recipe §3). */
  --orb-glass: color-mix(in oklab, hsl(var(--primary)) 16%, #050409);

  /* Interior: glass base + a DIM two-blob aurora + one soft sheen support. */
  background:
    radial-gradient(48% 42% at 30% 70%, color-mix(in srgb, var(--orb-l2) 34%, transparent), transparent 72%),
    radial-gradient(42% 38% at 72% 28%, color-mix(in srgb, var(--orb-l1) 26%, transparent), transparent 74%),
    var(--orb-glass);
  box-shadow:
    0 0 24px -8px var(--orb-l1),
    inset 0 0 10px -2px color-mix(in srgb, var(--orb-l3) 55%, transparent);
  cursor: pointer;
  /* Silhouette wobble — organic, ≤±4%, incommensurate with the rim periods. */
  animation: sl-orb-wobble 6.7s ease-in-out infinite;
}
@keyframes sl-orb-wobble {
  0%, 100% { border-radius: 51% 49% 52% 48% / 49% 52% 48% 51%; }
  27%      { border-radius: 47% 53% 49% 51% / 53% 47% 52% 48%; }
  53%      { border-radius: 53% 47% 51% 49% / 47% 52% 49% 53%; }
  79%      { border-radius: 48% 52% 47% 53% / 52% 48% 53% 47%; }
}

/* Halo — soft outward accent glow (follows the wobble via inherit). */
.sl-orb-glow { position: absolute; inset: -8px; border-radius: inherit;
  background: radial-gradient(circle, var(--orb-l1) 0%, transparent 65%);
  opacity: 0.45; pointer-events: none; }

/* THE FOUR RIM LIGHTS — two per layer, masked to a ring that follows the
   wobbling silhouette (border-radius: inherit + padding mask). Each conic is
   one soft arc; layers pulse on offset asymmetric envelopes. */
.sl-orb-rim1, .sl-orb-rim2 {
  position: absolute; inset: 0; border-radius: inherit; padding: 6%;
  pointer-events: none;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
}
.sl-orb-rim1 {
  background:
    conic-gradient(from var(--orb-a1), transparent 0 68%, var(--orb-l1) 84%, transparent 96%),
    conic-gradient(from var(--orb-a3), transparent 0 74%, var(--orb-l3) 88%, transparent 98%);
  animation:
    sl-orb-rot-1 12.1s linear infinite,
    sl-orb-rot-3 7.6s linear infinite,
    sl-orb-pulse-1 2.8s cubic-bezier(0.05, 0.7, 0.1, 1) infinite;
}
.sl-orb-rim2 {
  background:
    conic-gradient(from var(--orb-a2), transparent 0 72%, var(--orb-l2) 86%, transparent 97%),
    conic-gradient(from var(--orb-a4), transparent 0 76%, var(--orb-l4) 89%, transparent 99%);
  animation:
    sl-orb-rot-2 9.1s linear infinite reverse,
    sl-orb-rot-4 13.4s linear infinite reverse,
    sl-orb-pulse-2 4.2s cubic-bezier(0.05, 0.7, 0.1, 1) infinite;
  animation-delay: 0s, 0s, -2.1s; /* offset pulse phase (recipe §2) */
}
@keyframes sl-orb-rot-1 { to { --orb-a1: 380deg; } }
@keyframes sl-orb-rot-2 { to { --orb-a2: 512deg; } }
@keyframes sl-orb-rot-3 { to { --orb-a3: 604deg; } }
@keyframes sl-orb-rot-4 { to { --orb-a4: 438deg; } }
/* Asymmetric pulse: sharp rise (peak at 12%), long soft decay — solar flare,
   not sine (recipe §5 envelope folded into the rim pulse). */
@keyframes sl-orb-pulse-1 { 0% { opacity: 0.55; } 12% { opacity: 1; } 100% { opacity: 0.55; } }
@keyframes sl-orb-pulse-2 { 0% { opacity: 0.5; } 12% { opacity: 0.95; } 100% { opacity: 0.5; } }

/* ONE sheen band (recipe §3: no second shell). */
.sl-orb-core { position: absolute; inset: 14%; border-radius: inherit;
  background: radial-gradient(circle at 35% 30%, rgba(255,255,255,0.7), transparent 58%);
  pointer-events: none; }

/* Faint base ring so rim-light gaps never go fully dark. */
.sl-orb-ring { position: absolute; inset: 0; border-radius: inherit;
  border: 1px solid color-mix(in srgb, var(--orb-l4) 40%, rgba(255,255,255,0.12));
  pointer-events: none; }

.sl-orb[data-state='standby'] .sl-orb-glow { animation: sl-orb-halo-pulse 3.4s ease-in-out infinite; }
@keyframes sl-orb-halo-pulse {
  0%, 100% { opacity: 0.30; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(1.08); }
}

.sl-orb[data-state='listening'] {
  /* Brighter, accent-tinted; wobble continues alongside the breathe. */
  --orb-glass: color-mix(in oklab, hsl(var(--accent)) 24%, #050409);
  animation: sl-orb-wobble 6.7s ease-in-out infinite, sl-orb-breathe 1.6s ease-in-out infinite;
}
.sl-orb[data-state='listening'] .sl-orb-rim1,
.sl-orb[data-state='listening'] .sl-orb-rim2 { opacity: 1; }
@keyframes sl-orb-breathe {
  0%, 100% { scale: 1; }
  50%      { scale: 1.06; }
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
    var(--orb-l1), transparent 35%,
    var(--orb-l1) 60%, transparent 90%, var(--orb-l1));
  animation: sl-orb-rotate 4s linear infinite;
  opacity: 0.55;
}
@keyframes sl-orb-rotate {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* Reduced-motion: kill every perpetual loop (wobble, rim slide/pulse, halo,
   breathe, scroll, rotate). The orb still indicates state — via static
   opacity / accent tint per data-state — it just stops moving.
   (HIG "Reduce Motion" + WCAG 2.3.3.) */
@media (prefers-reduced-motion: reduce) {
  .sl-orb,
  .sl-orb .sl-orb-rim1,
  .sl-orb .sl-orb-rim2,
  .sl-orb[data-state='standby'] .sl-orb-glow,
  .sl-orb[data-state='listening'],
  .sl-orb[data-state='receiving'] .sl-orb-glow,
  .sl-orb[data-state='thinking'] .sl-orb-glow {
    animation: none !important;
    transform: none !important;
  }
  /* Static, non-animated state indication. Each state still reads
     differently at a glance (glow strength + listening accent tint). */
  .sl-orb .sl-orb-rim1, .sl-orb .sl-orb-rim2 { opacity: 0.75; }
  .sl-orb[data-state='standby'] .sl-orb-glow { opacity: 0.40; }
  .sl-orb[data-state='listening'] .sl-orb-glow { opacity: 0.60; }
  .sl-orb[data-state='listening'] .sl-orb-rim1,
  .sl-orb[data-state='listening'] .sl-orb-rim2 { opacity: 1; }
  .sl-orb[data-state='receiving'] .sl-orb-glow {
    background: radial-gradient(circle, var(--orb-l1) 0%, transparent 65%);
    background-size: auto;
    background-position: center;
    opacity: 0.70;
  }
  .sl-orb[data-state='thinking'] .sl-orb-glow {
    background: radial-gradient(circle, var(--orb-l1) 0%, transparent 65%);
    opacity: 0.55;
  }
}
`;
