// Batch action bar shown at the bottom of the session list. Walks the
// selected sessions in order and invokes commit & merge serially; reports a
// stepper-style summary when done.

import { useState } from 'react';
import { GitMerge, Loader2 } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import type { BatchCommitResult } from '@/shared/types';

interface Props {
  selectedIds: string[];
  onClearSelection: () => void;
  onCompleted?: () => void;
}

export function BatchToolbar(props: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchCommitResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await rpc.review.batchCommitAndMerge({
        sessionIds: props.selectedIds,
        messageTemplate: 'sigmalink: merge ${branch}',
      });
      setResult(r);
      props.onCompleted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (props.selectedIds.length === 0) return null;
  return (
    <div className="border-t border-border bg-muted/30 p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">
          {props.selectedIds.length} session{props.selectedIds.length === 1 ? '' : 's'} selected
        </span>
        <Button onClick={run} size="sm" disabled={busy}>
          {busy ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <GitMerge className="mr-1 h-3 w-3" />
          )}
          Batch commit & merge
        </Button>
        <Button
          onClick={() => {
            setResult(null);
            setErr(null);
            props.onClearSelection();
          }}
          size="sm"
          variant="ghost"
          disabled={busy}
        >
          Clear
        </Button>
      </div>
      {err ? <div className="mt-2 text-red-500">{err}</div> : null}
      {result ? (
        <ol className="mt-2 list-decimal space-y-0.5 pl-5">
          {result.results.map((r) => (
            <li
              key={r.sessionId}
              className={r.ok ? 'text-emerald-500' : 'text-red-500'}
            >
              <span className="font-mono">{r.sessionId.slice(0, 8)}</span>{' '}
              {r.ok ? 'merged' : `failed: ${r.error || r.stderr || `exit ${r.code}`}`}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
