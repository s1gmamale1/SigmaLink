// Providers tab — re-uses providers.list / providers.probeAll. The user can
// trigger a fresh probe via the "Re-probe" button. Found providers show a
// green dot + version (when known); missing ones show the install hint
// inline so the user can copy-paste it into their shell.

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, RefreshCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import type { ProviderProbe } from '@/shared/types';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';

interface Row {
  id: string;
  name: string;
  description: string;
  installHint: string;
  probe?: ProviderProbe;
}

export function ProvidersTab() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await rpc.providers.list();
      const probes = await rpc.providers.probeAll().catch(() => [] as ProviderProbe[]);
      const byId = new Map(probes.map((p) => [p.id, p]));
      setRows(
        list.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          installHint: p.installHint,
          probe: byId.get(p.id),
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <ErrorBanner
          message={error}
          onRetry={() => void refresh()}
          onDismiss={() => setError(null)}
        />
      ) : null}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {rows.length} provider{rows.length === 1 ? '' : 's'} ·{' '}
          {rows.filter((r) => r.probe?.found).length} found
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void refresh()}
          disabled={busy}
          className="gap-1"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          Re-probe
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const ok = !!r.probe?.found;
          return (
            <li
              key={r.id}
              className="flex items-start gap-3 rounded-md border border-border bg-card/40 px-3 py-2"
            >
              <span
                className={
                  ok
                    ? 'mt-[2px] grid h-5 w-5 place-items-center rounded-full bg-emerald-500/20 text-emerald-300'
                    : 'mt-[2px] grid h-5 w-5 place-items-center rounded-full bg-muted text-muted-foreground'
                }
                aria-hidden
              >
                {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{r.name}</span>
                  {r.probe?.version ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      v{r.probe.version}
                    </span>
                  ) : null}
                  {r.probe?.resolvedPath ? (
                    <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground" title={r.probe.resolvedPath}>
                      {r.probe.resolvedPath}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">{r.description}</div>
                {!ok ? (
                  <pre className="mt-2 overflow-x-auto rounded border border-border bg-muted/30 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    {r.installHint}
                  </pre>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
