// V3-W12-006: 3-step stepper Start → Layout → Agents shown above the
// wizard body. Steps render with check-state once their preconditions are
// met. Clicking a completed step navigates back to it; clicking a future
// step is a no-op until prior gates pass.

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StepId = 'start' | 'layout' | 'agents' | 'sessions';

interface StepSpec {
  id: StepId;
  label: string;
  num: number;
}

const STEPS: StepSpec[] = [
  { id: 'start', label: 'Start', num: 1 },
  { id: 'layout', label: 'Layout', num: 2 },
  { id: 'agents', label: 'Agents', num: 3 },
  { id: 'sessions', label: 'Sessions', num: 4 },
];

interface StepperProps {
  current: StepId;
  /** Set of step ids that pass their gate (folder picked, layout chosen, ...). */
  completed: Partial<Record<StepId, boolean>>;
  onJump: (id: StepId) => void;
}

export function Stepper({ current, completed, onJump }: StepperProps) {
  return (
    <ol className="flex items-center gap-1.5 text-sm" aria-label="Wizard progress">
      {STEPS.map((step, idx) => {
        const isCurrent = step.id === current;
        const isDone = !!completed[step.id] && !isCurrent;
        const isFuture = !isCurrent && !isDone;
        // Allow jumping back to anything completed and to the current step.
        const canJump = isDone || isCurrent;
        return (
          <li key={step.id} className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => canJump && onJump(step.id)}
              disabled={!canJump}
              className={cn(
                'flex items-center gap-2 rounded-md px-2.5 py-1.5 transition',
                isCurrent && 'bg-accent/15 text-foreground',
                isDone && 'text-foreground hover:bg-muted/40',
                isFuture && 'cursor-not-allowed text-muted-foreground/60',
              )}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold',
                  isDone
                    ? 'border-emerald-500/70 bg-emerald-500/20 text-emerald-400'
                    : isCurrent
                      ? 'border-ring bg-accent/30 text-accent-foreground'
                      : 'border-border text-muted-foreground',
                )}
              >
                {isDone ? <Check className="h-3 w-3" /> : step.num}
              </span>
              <span className="text-sm font-medium">{step.label}</span>
            </button>
            {idx < STEPS.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  'h-px w-6 transition',
                  isDone ? 'bg-emerald-500/50' : 'bg-border',
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
