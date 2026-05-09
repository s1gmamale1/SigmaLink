// Diagnostics settings: surfaces the native-module self-check that runs at
// boot (see `electron/main.ts`'s `checkNativeModules`) plus the Electron/Node
// runtime versions and the userData path. Lets the user re-run the probe
// without restarting the app and copy the rebuild command on failure.

import { useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import type { DiagnosticsReport } from '@/shared/router-shape';

const REBUILD_CMD = 'cd app && npx electron-rebuild -f -w better-sqlite3 -w node-pty';

export function DiagnosticsTab() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const r = await rpc.app.diagnostics();
      setReport(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const hasFailure = !!report?.nativeModules.some((m) => !m.ok);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Native modules
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh diagnostics"
          >
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        {report ? (
          <div className="flex flex-col gap-2">
            {report.nativeModules.map((mod) => (
              <div
                key={mod.module}
                className="rounded-md border border-border bg-card/40 p-3"
              >
                <div className="flex items-center gap-2">
                  {mod.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  <code className="text-sm font-medium">{mod.module}</code>
                  <span
                    className={
                      mod.ok
                        ? 'text-[11px] text-emerald-500'
                        : 'text-[11px] text-red-500'
                    }
                  >
                    {mod.ok ? 'loaded' : 'failed'}
                  </span>
                </div>
                {!mod.ok && mod.error ? (
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded border border-border bg-background/60 p-2 font-mono text-[11px] text-red-400">
                    {mod.error}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {hasFailure ? (
          <div className="mt-3 rounded-md border border-border bg-card/30 p-3">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Rebuild command
            </div>
            <pre className="select-all whitespace-pre-wrap break-words rounded border border-border bg-background/60 p-2 font-mono text-xs">
              {REBUILD_CMD}
            </pre>
            <div className="mt-1 text-[11px] text-muted-foreground">
              If <code>node_modules</code> is empty, run <code>npm install</code> first.
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Environment
        </div>
        {report ? (
          <div className="overflow-hidden rounded-md border border-border bg-card/30">
            <EnvRow label="Electron" value={report.env.electron ?? 'unknown'} />
            <EnvRow label="Node" value={report.env.node} />
            <EnvRow label="Chrome" value={report.env.chrome ?? 'unknown'} />
            <EnvRow label="Platform" value={report.env.platform} />
            <EnvRow label="Arch" value={report.env.arch} />
            <EnvRow label="User data" value={report.env.userData} mono />
          </div>
        ) : !error ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : null}
      </section>
    </div>
  );
}

function EnvRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <div className="w-24 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <code
        className={
          mono
            ? 'flex-1 select-all break-all font-mono text-xs'
            : 'flex-1 select-all break-words font-mono text-xs'
        }
      >
        {value}
      </code>
    </div>
  );
}
