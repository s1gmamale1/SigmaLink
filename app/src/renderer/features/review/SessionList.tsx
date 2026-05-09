// Left rail of the Review Room: every session in the active workspace, with
// branch + git status badges, plus checkboxes that drive the BatchToolbar.

import { GitBranch, CheckCircle2, XCircle, Hourglass } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ReviewSession } from '@/shared/types';

interface Props {
  sessions: ReviewSession[];
  activeId: string | null;
  selected: Set<string>;
  onSelect: (id: string) => void;
  onToggleCheck: (id: string) => void;
  onToggleAll: () => void;
}

export function SessionList(props: Props) {
  const allSelected =
    props.sessions.length > 0 && props.sessions.every((s) => props.selected.has(s.sessionId));
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={props.onToggleAll}
          className="cursor-pointer accent-primary"
          aria-label="Toggle select all"
        />
        <span className="text-muted-foreground">
          {props.selected.size} / {props.sessions.length} selected
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {props.sessions.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            No sessions in this workspace yet. Launch agents from the Command room.
          </div>
        ) : (
          props.sessions.map((s) => {
            const isActive = props.activeId === s.sessionId;
            const checked = props.selected.has(s.sessionId);
            const dirty = s.gitStatus
              ? s.gitStatus.staged.length +
                s.gitStatus.unstaged.length +
                s.gitStatus.untracked.length
              : 0;
            return (
              <button
                type="button"
                key={s.sessionId}
                onClick={() => props.onSelect(s.sessionId)}
                className={cn(
                  'group flex w-full flex-col gap-1 border-b border-border/60 px-3 py-2 text-left transition',
                  isActive ? 'bg-accent/30' : 'hover:bg-accent/10',
                )}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => props.onToggleCheck(s.sessionId)}
                    className="mt-1 cursor-pointer accent-primary"
                    aria-label={`Select session ${s.sessionId}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 text-xs font-medium">
                      <DecisionIcon decision={s.decision} />
                      <span className="truncate">{s.providerId}</span>
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <GitBranch className="h-3 w-3 shrink-0" />
                      <span className="truncate" title={s.branch ?? ''}>
                        {s.branch ?? '(no branch)'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1 pl-6 text-[10px]">
                  {!s.worktreePath ? (
                    <Badge tone="muted">merged</Badge>
                  ) : dirty === 0 ? (
                    <Badge tone="muted">clean</Badge>
                  ) : (
                    <Badge tone="warn">{dirty} change{dirty === 1 ? '' : 's'}</Badge>
                  )}
                  {s.lastTestExitCode !== null && s.lastTestExitCode !== undefined ? (
                    <Badge tone={s.lastTestExitCode === 0 ? 'ok' : 'fail'}>
                      tests {s.lastTestExitCode === 0 ? 'pass' : 'fail'}
                    </Badge>
                  ) : null}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function DecisionIcon({ decision }: { decision: ReviewSession['decision'] }) {
  if (decision === 'passed') return <CheckCircle2 className="h-3 w-3 text-emerald-500" />;
  if (decision === 'failed') return <XCircle className="h-3 w-3 text-red-500" />;
  return <Hourglass className="h-3 w-3 text-muted-foreground" />;
}

function Badge({ tone, children }: { tone: 'ok' | 'fail' | 'warn' | 'muted'; children: React.ReactNode }) {
  const palette: Record<typeof tone, string> = {
    ok: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    fail: 'bg-red-500/10 text-red-500 border-red-500/20',
    warn: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    muted: 'bg-muted text-muted-foreground border-border',
  };
  return (
    <span
      className={cn(
        'rounded-full border px-1.5 py-px text-[10px] font-medium uppercase tracking-wider',
        palette[tone],
      )}
    >
      {children}
    </span>
  );
}
