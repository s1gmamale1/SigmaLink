// N1 — launcher mode vocabulary + mode-aware step derivation.
//
// Pulled into its own module (no React component exports) so it is pure and
// unit-testable, and so react-refresh/only-export-components is never tripped.
//
// Every mode leads with the 'intent' landing step (the minimal-chrome entry
// point), then branches on WHICH wizard steps show next:
//   • 'space'  — SigmaLink terminal grid: Intent → Start → Layout → Agents →
//                Sessions (the full worktree-per-pane flow; B2 SessionStep
//                preserved).
//   • 'single' — one terminal: Intent → Start only, then launch a
//                single-pane workspace.
//   • 'swarm'  — SigmaSwarm orchestrator: Intent → Start only, then route to
//                Swarm Room.
//   • 'canvas' — SigmaCanvas (preserved): Intent → Start only, then route to
//                Browser room.
//
// The Launcher's existing `launch()` already branches on the mode and calls the
// SAME RPCs (workspaces.launch / SET_ROOM 'swarm' / design.createCanvas). This
// module only decides the step CHROME — it changes no main-process contract.

import type { StepId } from './Stepper';

export type LauncherMode = 'space' | 'single' | 'swarm' | 'canvas';

/** Ordered full step set for the grid path, including the intent landing step. */
const FULL_STEPS: StepId[] = ['intent', 'start', 'layout', 'agents', 'sessions'];

/**
 * The visible, ordered steps for a given mode. Every mode leads with the
 * 'intent' landing step. Only 'space' shows the full Layout/Agents/Sessions
 * sequence after it; every other mode goes intent → Start → launch, so it
 * shows the Start step alone after intent (the launch CTA does the routing).
 */
export function stepsForMode(mode: LauncherMode): StepId[] {
  return mode === 'space' ? FULL_STEPS : ['intent', 'start'];
}

/** The next step after `current` within `mode`, or null at the end. */
export function nextStepForMode(mode: LauncherMode, current: StepId): StepId | null {
  const steps = stepsForMode(mode);
  const idx = steps.indexOf(current);
  if (idx < 0 || idx >= steps.length - 1) return null;
  return steps[idx + 1];
}

/** The previous step before `current` within `mode`, or null at the start. */
export function prevStepForMode(mode: LauncherMode, current: StepId): StepId | null {
  const steps = stepsForMode(mode);
  const idx = steps.indexOf(current);
  if (idx <= 0) return null;
  return steps[idx - 1];
}

/**
 * After a workspace is selected on the Start step, where should the wizard go?
 * Grid mode advances into Layout; every other mode stays on Start (the user
 * launches directly — single terminal / swarm / canvas need no further steps).
 */
export function stepAfterStart(mode: LauncherMode): StepId {
  return mode === 'space' ? 'layout' : 'start';
}

/**
 * Pane budget implied purely by the mode, independent of the Layout step. The
 * 'single' mode pins the grid to ONE pane; every other grid interaction is
 * driven by the Layout step's preset. Returns null when the mode does not pin
 * a count (i.e. the operator's chosen preset wins).
 */
export function fixedPaneCountForMode(mode: LauncherMode): 1 | null {
  return mode === 'single' ? 1 : null;
}
