import { useEffect, useState } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';

export interface PatternHit {
  pattern: string;
  type?: string;
  confidence: number;
  score: number;
}

export interface UseSigmaPatternProbeArgs {
  composerText: string;
  rufloReady: boolean;
}

export interface UseSigmaPatternProbeReturn {
  patternHit: PatternHit | null;
}

/** Phase 4 Track C — debounced pattern probe (800ms). Fires only when the
 *  supervisor is `ready` and the composer holds enough text to be worth a
 *  round-trip. The `Promise.allSettled`-style ignore-on-fail keeps the
 *  ribbon silent on degraded supervisors. */
export function useSigmaPatternProbe({
  composerText,
  rufloReady,
}: UseSigmaPatternProbeArgs): UseSigmaPatternProbeReturn {
  const [patternHit, setPatternHit] = useState<PatternHit | null>(null);

  useEffect(() => {
    let alive = true;
    const text = composerText.trim();
    const skip = !rufloReady || text.length < 8;
    if (skip) {
      const id = window.setTimeout(() => {
        if (alive) setPatternHit(null);
      }, 0);
      return () => {
        alive = false;
        window.clearTimeout(id);
      };
    }
    const t = setTimeout(() => {
      void (async () => {
        try {
          const out = await rpcSilent.ruflo['patterns.search']({
            query: text,
            topK: 3,
            minConfidence: 0.7,
          });
          if (!alive) return;
          if (out && 'ok' in out && out.ok && out.results.length > 0) {
            const best = out.results.find((r) => r.confidence >= 0.7) ?? null;
            setPatternHit(best);
          } else {
            setPatternHit(null);
          }
        } catch {
          if (alive) setPatternHit(null);
        }
      })();
    }, 800);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [composerText, rufloReady]);

  return { patternHit };
}
