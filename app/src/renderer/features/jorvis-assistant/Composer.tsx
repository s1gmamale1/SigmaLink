// V3-W13-012 — Sigma Assistant composer.
// Enter submits; Shift+Enter newlines. Mic toggles the orb to LISTENING;
// real voice intake lands in W15.
//
// V3-W15-005 — Mic visibility gated by `canDo('sigmavoice.enabled')`. Ultra
// (SigmaLink default) returns true so users see no UI change. The gate is
// here to prove the capability matrix wires through; lower tiers (Pro/Basic
// in a hypothetical hosted SigmaLink) hide the affordance instead of
// disabling it so the dock chrome stays clean.

import { forwardRef, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Mic, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCanDo } from '@/renderer/lib/canDo';

/** 2026-06-10 audit #5 — a programmatic composer push. The `nonce` is a
 *  monotonic token: bump it on EVERY push so consecutive pushes of the same
 *  string (clearing to '' after each send) still apply — a bare string prop
 *  dedups on Object.is and leaves typed-but-unsent text in the textarea. */
export interface ComposerExternalValue {
  value: string;
  nonce: number;
}

interface Props {
  busy: boolean;
  onSend: (prompt: string) => void;
  onMicPress?: () => void;
  placeholder?: string;
  className?: string;
  /** Phase 4 Track C — emits the live textarea value so JorvisRoom can
   *  debounce a `ruflo.patterns.search` probe and surface a "Similar past
   *  task" ribbon. Optional; the composer works exactly as before when
   *  omitted. */
  onChange?: (value: string) => void;
  /** Phase 4 Track C — externally-set value (e.g. when the pattern ribbon's
   *  "Apply" CTA fills the composer). When provided the composer becomes
   *  controlled until the user types again. */
  externalValue?: ComposerExternalValue;
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

  // Phase 4 Track C — sync controlled value pushes (ribbon Apply, pane-context
  // drop, post-send clear). Each push is a fresh `{value, nonce}` object so
  // the dep changes — and the effect re-fires — even when `value` repeats.
  // Timeout-deferred so the lint rule `react-hooks/set-state-in-effect` is
  // satisfied; the parent only pushes on user actions so the hop is invisible.
  useEffect(() => {
    if (!externalValue) return;
    let alive = true;
    const id = window.setTimeout(() => {
      if (alive) setValue(externalValue.value);
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
        placeholder={placeholder ?? 'Ask Jorvis…'}
        rows={2}
        className={cn(
          // min-w-0: this textarea is a flex item; without it `min-width: auto`
          // lets it floor the composer row at content width instead of shrinking
          // to the panel, which is how long text ends up on one runaway line.
          'min-h-[44px] min-w-0 flex-1 resize-none rounded-md border border-input bg-muted/30 px-3 py-2 text-sm shadow-xs outline-none transition placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
        disabled={busy}
        aria-label="Ask Jorvis"
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
