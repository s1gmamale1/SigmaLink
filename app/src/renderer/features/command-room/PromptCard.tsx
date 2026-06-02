// FEAT-4 — interactive in-terminal prompt card.
//
// Overlays a clickable clarifying-question card over the pane terminal when an
// agent emits a `SIGMA::PROMPT` line and the feature is enabled. The operator's
// choice is handed back via `onSubmit(choices)`; the parent hook writes it to
// the pane's stdin.
//
//   • single-select → each choice is a button; one click submits.
//   • multi-select  → checkboxes + an explicit "Send" button (joins choices).
//
// Surface: calm `bg-card/95 backdrop-blur` (NOT bg-accent — v1.36 purple-flash
// lesson). Reduced-motion-safe (the only motion is a CSS enter that respects
// `prefers-reduced-motion`). Accessible: role="dialog" + aria-modal, an
// aria-label, autofocus into the card, and Escape to dismiss.

import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PromptPayload } from '@/main/core/swarms/protocol';

/**
 * Thin shell that REMOUNTS the inner card whenever the prompt changes (via a
 * `key` derived from the question + choices). The remount resets the
 * multi-select working set for free — no setState-in-effect / ref-during-render
 * needed (both forbidden by the React 19 hooks lint rules).
 */
export function PromptCard(props: {
  prompt: PromptPayload;
  /** Called with the chosen option text(s). */
  onSubmit: (choices: string[]) => void;
  /** Called when the operator dismisses the card (× or Escape). */
  onDismiss: () => void;
}) {
  const { prompt } = props;
  const promptKey = `${prompt.question} ${prompt.choices.join(' ')}`;
  return <PromptCardInner key={promptKey} {...props} />;
}

function PromptCardInner({
  prompt,
  onSubmit,
  onDismiss,
}: {
  prompt: PromptPayload;
  onSubmit: (choices: string[]) => void;
  onDismiss: () => void;
}) {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  // Multi-select working set (indices into prompt.choices). Fresh on every
  // (re)mount — the parent re-keys this component per prompt.
  const [selected, setSelected] = useState<Set<number>>(() => new Set());

  const isMulti = prompt.type === 'multi';

  // Move focus into the card on mount so keyboard users land on the question
  // immediately. Mount-only — the parent remounts on prompt change.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    }
  }

  function toggle(index: number): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function submitMulti(): void {
    const chosen = prompt.choices.filter((_, i) => selected.has(i));
    if (chosen.length === 0) return;
    onSubmit(chosen);
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-label="Agent question"
      tabIndex={-1}
      data-testid="prompt-card"
      onKeyDown={handleKeyDown}
      className={cn(
        'sl-pane-enter motion-reduce:animate-none',
        'absolute inset-x-0 bottom-0 z-20 m-2 rounded-lg border border-border/60',
        'bg-card/95 p-3 shadow-lg backdrop-blur outline-none',
      )}
    >
      <div className="mb-2 flex items-start gap-2">
        <p id={titleId} className="flex-1 text-sm font-medium text-foreground">
          {prompt.question}
        </p>
        <button
          type="button"
          aria-label="Dismiss question"
          data-testid="prompt-card-dismiss"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {isMulti ? (
        <>
          <div className="flex flex-col gap-1.5" role="group" aria-labelledby={titleId}>
            {prompt.choices.map((choice, i) => {
              const id = `${titleId}-opt-${i}`;
              return (
                <label
                  key={`${choice}-${i}`}
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm text-foreground hover:bg-muted/60"
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={selected.has(i)}
                    onChange={() => toggle(i)}
                    className="size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  />
                  <span>{choice}</span>
                </label>
              );
            })}
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              size="sm"
              data-testid="prompt-card-send"
              disabled={selected.size === 0}
              onClick={submitMulti}
            >
              Send
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {prompt.choices.map((choice, i) => (
            <Button
              key={`${choice}-${i}`}
              type="button"
              size="sm"
              variant="secondary"
              data-testid="prompt-card-choice"
              onClick={() => onSubmit([choice])}
            >
              {choice}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
