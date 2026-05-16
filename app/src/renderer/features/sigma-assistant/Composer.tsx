// V3-W13-012 — Sigma Assistant composer.
// Enter submits; Shift+Enter newlines. Mic toggles the orb to LISTENING;
// real voice intake lands in W15.
//
// V3-W15-005 — Mic visibility gated by `canDo('bridgevoice.enabled')`. Ultra
// (SigmaLink default) returns true so users see no UI change. The gate is
// here to prove the capability matrix wires through; lower tiers (Pro/Basic
// in a hypothetical hosted SigmaLink) hide the affordance instead of
// disabling it so the dock chrome stays clean.

import { forwardRef, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Mic, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCanDo } from '@/renderer/lib/canDo';

interface Props {
  busy: boolean;
  onSend: (prompt: string) => void;
  onMicPress?: () => void;
  placeholder?: string;
  className?: string;
  /** Phase 4 Track C — emits the live textarea value so SigmaRoom can
   *  debounce a `ruflo.patterns.search` probe and surface a "Similar past
   *  task" ribbon. Optional; the composer works exactly as before when
   *  omitted. */
  onChange?: (value: string) => void;
  /** Phase 4 Track C — externally-set value (e.g. when the pattern ribbon's
   *  "Apply" CTA fills the composer). When provided the composer becomes
   *  controlled until the user types again. */
  externalValue?: string;
}

export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer(
  { busy, onSend, onMicPress, placeholder, className, onChange, externalValue }: Props,
  externalRef,
) {
  const [value, setValue] = useState('');
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const voiceEnabled = useCanDo<boolean>('sigmavoice.enabled');

  useEffect(() => {
    if (typeof externalRef === 'function') externalRef(innerRef.current);
    else if (externalRef) (externalRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = innerRef.current;
  }, [externalRef]);

  // Phase 4 Track C — sync controlled value pushes (e.g. ribbon Apply).
  // Microtask-deferred so the lint rule `react-hooks/set-state-in-effect`
  // is satisfied; the parent only updates `externalValue` on user actions
  // so the brief async hop is invisible.
  useEffect(() => {
    if (typeof externalValue !== 'string') return;
    let alive = true;
    const id = window.setTimeout(() => {
      if (alive) setValue(externalValue);
    }, 0);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [externalValue]);

  const commit = () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onSend(trimmed);
    setValue('');
    onChange?.('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div
      className={cn(
        'flex shrink-0 items-end gap-2 border-t border-border bg-background p-2',
        className,
      )}
    >
      <textarea
        ref={innerRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onChange?.(e.target.value);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? 'Ask Sigma…'}
        rows={2}
        className={cn(
          'min-h-[44px] flex-1 resize-none rounded-md border border-input bg-muted/30 px-3 py-2 text-sm shadow-xs outline-none transition placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
        disabled={busy}
        aria-label="Ask Sigma"
      />
      <div className="flex flex-col gap-1">
        {voiceEnabled ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onMicPress}
            aria-label="Toggle voice input"
            title="SigmaVoice input"
            disabled={busy}
          >
            <Mic className="h-4 w-4" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          onClick={commit}
          aria-label="Send"
          title="Send"
          disabled={busy || !value.trim()}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
});
