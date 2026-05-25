// C-12 SigmaBench room — multi-agent conflict benchmark.
//
// Dispatches one task prompt to N providers (each in its own isolated git
// worktree via the swarm factory), then ranks them by how little their
// changed-file sets overlap. The whole point: prove the "worktree-swarm =
// no merge conflicts" thesis with a measurable leaderboard.
//
// The component:
//   1. renders a prompt textarea + provider checkboxes + Run button;
//   2. calls sigmabench.run → { runId };
//   3. polls sigmabench.getRun every POLL_MS while status === 'running'
//      (interval cleared on unmount or once the run is done/error);
//   4. renders the result rows sorted ascending by conflictScore
//      (most-isolated first).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, Loader2, Play } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';

const POLL_MS = 2_000;
const CATEGORY = 'multi-agent-conflict';
const PROVIDERS = ['claude', 'codex', 'gemini'] as const;
type BenchProvider = (typeof PROVIDERS)[number];

interface BenchResult {
  sessionId: string;
  provider: string;
  changedFiles: string[];
  conflictScore: number | null;
  exitCode: number | null;
}

interface BenchRun {
  id: string;
  createdAt: number;
  category: string;
  taskPrompt: string;
  status: 'running' | 'done' | 'error';
  results: BenchResult[];
}

// `sigmabench` is registered side-band (not in the typed AppRouter shape), so
// we narrow the proxy locally rather than widening the global rpc type.
interface SigmaBenchRpc {
  run: (input: {
    category: string;
    taskPrompt: string;
    providers: string[];
  }) => Promise<{ runId: string }>;
  getRun: (input: { id: string }) => Promise<BenchRun | null>;
  listRuns: () => Promise<BenchRun[]>;
}

function benchRpc(): SigmaBenchRpc {
  return (rpc as unknown as { sigmabench: SigmaBenchRpc }).sigmabench;
}

export function SigmaBenchRoom() {
  const { state } = useAppState();
  const workspaceId = state.activeWorkspace?.id ?? '';

  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<Record<BenchProvider, boolean>>({
    claude: true,
    codex: true,
    gemini: true,
  });
  const [run, setRun] = useState<BenchRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Clear any live interval on unmount.
  useEffect(() => stopPolling, [stopPolling]);

  const pollOnce = useCallback(
    async (runId: string) => {
      try {
        const latest = await benchRpc().getRun({ id: runId });
        if (latest) {
          setRun(latest);
          if (latest.status !== 'running') {
            stopPolling();
            setBusy(false);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        stopPolling();
        setBusy(false);
      }
    },
    [stopPolling],
  );

  const onRun = useCallback(async () => {
    const providers = PROVIDERS.filter((p) => selected[p]);
    if (prompt.trim().length === 0 || providers.length === 0) return;
    setError(null);
    setBusy(true);
    stopPolling();
    try {
      const { runId } = await benchRpc().run({
        category: CATEGORY,
        taskPrompt: prompt.trim(),
        providers,
      });
      // Kick an immediate read, then poll until the run settles.
      await pollOnce(runId);
      if (!pollRef.current) {
        pollRef.current = setInterval(() => void pollOnce(runId), POLL_MS);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [prompt, selected, pollOnce, stopPolling]);

  const sortedResults = run
    ? [...run.results].sort(
        (a, b) => (a.conflictScore ?? 0) - (b.conflictScore ?? 0),
      )
    : [];

  const canRun =
    !busy &&
    prompt.trim().length > 0 &&
    PROVIDERS.some((p) => selected[p]) &&
    workspaceId.length > 0;

  if (!workspaceId) {
    return (
      <EmptyState
        icon={Gauge}
        title="Open a workspace to use SigmaBench"
        description="SigmaBench runs agents in isolated git worktrees — open a project folder first."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
      <header className="flex items-center gap-2">
        <Gauge className="h-5 w-5 text-muted-foreground" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold">SigmaBench</h1>
          <p className="text-sm text-muted-foreground">
            Run one task across providers in isolated worktrees and rank them by
            how little their changes overlap.
          </p>
        </div>
      </header>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Task prompt
          <textarea
            aria-label="Task prompt"
            className="min-h-24 rounded-md border border-input bg-background p-2 text-sm"
            placeholder="Describe the task to dispatch to every provider…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1 text-sm font-medium">Providers</legend>
          {PROVIDERS.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm capitalize">
              <input
                type="checkbox"
                aria-label={p}
                checked={selected[p]}
                onChange={(e) =>
                  setSelected((prev) => ({ ...prev, [p]: e.target.checked }))
                }
              />
              {p}
            </label>
          ))}
        </fieldset>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            disabled={!canRun}
            onClick={() => void onRun()}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Play className="h-4 w-4" aria-hidden />
            )}
            Run benchmark
          </button>
          {busy && (
            <span className="text-sm text-muted-foreground">Running…</span>
          )}
        </div>

        {error && (
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        )}
      </section>

      {run && (
        <section className="rounded-md border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">
            Leaderboard
            <span className="ml-2 font-normal text-muted-foreground">
              {run.status === 'running' ? 'running…' : run.status}
            </span>
          </h2>
          {sortedResults.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No results yet — agents are still working.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-1 pr-4 font-medium">Provider</th>
                  <th className="py-1 pr-4 font-medium">Changed files</th>
                  <th className="py-1 font-medium">Conflict score</th>
                </tr>
              </thead>
              <tbody>
                {sortedResults.map((r) => (
                  <tr
                    key={r.sessionId}
                    data-testid="bench-result-row"
                    className="border-b border-border/50"
                  >
                    <td className="py-1 pr-4 capitalize">{r.provider}</td>
                    <td className="py-1 pr-4 tabular-nums">
                      {r.changedFiles.length}
                    </td>
                    <td className="py-1 tabular-nums">
                      {r.conflictScore ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
