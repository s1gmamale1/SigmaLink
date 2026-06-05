// Phase 4 — consolidated per-pane metadata + actions, opened from the header
// gear button. Grid-view home for everything removed from the bar: status,
// Ruflo health, identity, branch/model/cwd/uncommitted, git-activity, usage,
// relabel, rewind, and the brief form. NOT a 4-tab inspector — a single scrollable
// vertical panel.
import { useState } from 'react';
import { History, ClipboardList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import { derivePaneIdentity } from './pane-identity';
import { useRufloDaemonHealth } from './useRufloDaemonHealth';
import { UsagePopover } from './UsagePopover';
import { GitActivityStrip } from './GitActivityStrip';
import { CheckpointPanel } from './CheckpointPanel';
import type { AgentSession } from '@/shared/types';

// SF-7 — colour mapping for the Ruflo daemon health dot.
function rufloHealthDotClass(state: string): string {
  switch (state) {
    case 'running':  return 'bg-emerald-500';
    case 'fallback': return 'bg-amber-500';
    case 'down':     return 'bg-red-500';
    case 'starting': return 'bg-amber-400 animate-pulse';
    default:         return 'bg-slate-400'; // unknown
  }
}

export function PaneGearPopoverBody({
  session,
  providers,
  uncommitted,
}: {
  session: AgentSession;
  providers?: { id: string; name: string }[];
  uncommitted?: number | null;
}) {
  const id = derivePaneIdentity(session);
  const health = useRufloDaemonHealth(session.workspaceId);
  const [rewindOpen, setRewindOpen] = useState(false);
  const canRewind =
    Boolean(session.worktreePath) &&
    (session.status === 'running' || session.status === 'exited');

  // Optimistic display override for relabelling (matches the old header logic)
  const [displayOverride, setDisplayOverride] = useState<string | null | undefined>(undefined);
  const effectiveProviderId =
    displayOverride !== undefined
      ? (displayOverride ?? session.providerId)
      : (session.displayProviderId ?? session.providerId);
  const isRelabelled = effectiveProviderId !== session.providerId;

  function relabel(displayProviderId: string | null): void {
    setDisplayOverride(displayProviderId);
    void rpc.panes
      .setDisplayProvider({ sessionId: session.id, displayProviderId })
      .catch(() => undefined);
  }

  // Brief form state
  const [goal, setGoal] = useState('');
  const [targetFiles, setTargetFiles] = useState('');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [outOfScope, setOutOfScope] = useState('');
  const [briefBusy, setBriefBusy] = useState(false);
  const briefDisabled = session.status !== 'running';

  function splitLines(s: string): string[] {
    return s.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  async function handleBriefSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!goal.trim() || briefBusy) return;
    setBriefBusy(true);
    try {
      await rpc.panes.brief({
        sessionId: session.id,
        worktreePath: session.worktreePath ?? null,
        capsule: {
          goal: goal.trim(),
          targetFiles: splitLines(targetFiles),
          successCriteria: splitLines(successCriteria),
          outOfScope: splitLines(outOfScope),
        },
      });
      setGoal('');
      setTargetFiles('');
      setSuccessCriteria('');
      setOutOfScope('');
    } finally {
      setBriefBusy(false);
    }
  }

  return (
    <div data-testid="pane-gear-popover" className="flex w-72 flex-col gap-3 p-2 text-[11px]">
      {/* Identity row */}
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: id.agentAccent }} aria-hidden />
        <span className="font-medium">{id.alias}</span>
        <span className="text-muted-foreground">· {id.providerName} · {id.effortLabel}</span>
        <span className="ml-auto font-mono text-[10px] opacity-60">{id.agentId}</span>
      </div>

      {/* Branch / model / cwd / uncommitted */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground/70">branch</dt>
        <dd className="truncate">{id.branch}</dd>
        <dt className="text-muted-foreground/70">model</dt>
        <dd className="truncate">{id.modelLabel}</dd>
        <dt className="text-muted-foreground/70">cwd</dt>
        <dd className="truncate" title={id.cwd}>{id.cwd}</dd>
        {typeof uncommitted === 'number' && uncommitted > 0 ? (
          <>
            <dt className="text-muted-foreground/70">uncommitted</dt>
            <dd><span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-600">±{uncommitted}</span></dd>
          </>
        ) : null}
      </dl>

      {/* Git activity heatmap */}
      <GitActivityStrip worktreePath={id.worktreePath} />

      {/* Ruflo health */}
      <div
        className="flex items-center gap-1.5 text-muted-foreground"
        data-testid="pane-gear-ruflo"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${rufloHealthDotClass(health.state)}`}
          aria-hidden
        />
        Ruflo MCP — {health.detail}
      </div>

      {/* Usage / cost */}
      <UsagePopover session={session} />

      {/* Actions divider */}
      <div className="flex flex-col gap-1 border-t border-border/50 pt-2">
        {/* Relabel */}
        {(providers ?? []).length > 0 ? (
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Label pane as…
          </div>
        ) : null}
        {(providers ?? []).map((p) => (
          <button
            key={p.id}
            type="button"
            className="text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => relabel(p.id)}
          >
            {p.name}
          </button>
        ))}
        {isRelabelled ? (
          <button
            type="button"
            className="text-left text-amber-500 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => relabel(null)}
          >
            Reset to {id.realProviderName}
          </button>
        ) : null}

        {/* Rewind */}
        {canRewind ? (
          <details
            open={rewindOpen}
            onToggle={(e) => setRewindOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary
              data-testid="pane-rewind-item"
              className="flex cursor-pointer select-none items-center gap-1 rounded px-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <History className="h-3 w-3" aria-hidden />
              Rewind…
            </summary>
            <div className="mt-1">
              <CheckpointPanel sessionId={session.id} />
            </div>
          </details>
        ) : null}

        {/* Brief form */}
        <details>
          <summary className="flex cursor-pointer select-none items-center gap-1 rounded px-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <ClipboardList className="h-3 w-3" aria-hidden />
            Brief this pane
          </summary>
          <form
            onSubmit={(e) => { void handleBriefSubmit(e); }}
            className="mt-1 flex flex-col gap-2"
          >
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Goal"
              rows={2}
              disabled={briefDisabled}
              className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
            />
            <textarea
              value={targetFiles}
              onChange={(e) => setTargetFiles(e.target.value)}
              placeholder="Target files (one per line)"
              rows={2}
              disabled={briefDisabled}
              className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
            />
            <textarea
              value={successCriteria}
              onChange={(e) => setSuccessCriteria(e.target.value)}
              placeholder="Success criteria (one per line)"
              rows={2}
              disabled={briefDisabled}
              className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
            />
            <textarea
              value={outOfScope}
              onChange={(e) => setOutOfScope(e.target.value)}
              placeholder="Out of scope (one per line)"
              rows={2}
              disabled={briefDisabled}
              className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
            />
            <Button
              type="submit"
              disabled={briefBusy || !goal.trim() || briefDisabled}
              className="mt-1 h-7 text-xs"
              aria-label="Inject capsule"
            >
              Inject capsule
            </Button>
          </form>
        </details>
      </div>
    </div>
  );
}
