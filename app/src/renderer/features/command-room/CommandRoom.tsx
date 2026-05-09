import { useMemo, useState } from 'react';
import { Maximize2, Minimize2, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { SessionTerminal } from './Terminal';

type Layout = 'mosaic' | 'columns' | 'focus';

function gridClassFor(count: number, layout: Layout): string {
  if (layout === 'focus') return 'grid-cols-1';
  if (layout === 'columns') {
    if (count <= 2) return 'grid-cols-1';
    if (count <= 6) return 'grid-cols-2';
    return 'grid-cols-3';
  }
  // mosaic: square-ish
  if (count <= 1) return 'grid-cols-1';
  if (count <= 2) return 'grid-cols-2';
  if (count <= 4) return 'grid-cols-2';
  if (count <= 6) return 'grid-cols-3';
  if (count <= 9) return 'grid-cols-3';
  if (count <= 12) return 'grid-cols-4';
  return 'grid-cols-4';
}

export function CommandRoom() {
  const { state } = useAppState();
  const sessions = state.sessions.filter((s) => state.activeWorkspace && s.workspaceId === state.activeWorkspace.id);
  const [layout, setLayout] = useState<Layout>('mosaic');
  const [focusId, setFocusId] = useState<string | null>(null);

  const visibleSessions = useMemo(() => {
    if (layout === 'focus' && focusId) {
      const target = sessions.find((s) => s.id === focusId);
      return target ? [target] : sessions.slice(0, 1);
    }
    return sessions;
  }, [sessions, layout, focusId]);

  if (!state.activeWorkspace) {
    return <RoomEmpty title="Open a workspace first" />;
  }
  if (sessions.length === 0) {
    return <RoomEmpty title="No agents launched yet — head back to Workspaces." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 items-center gap-2 border-b border-border px-3 text-xs">
        <div className="font-medium">{state.activeWorkspace.name}</div>
        <span className="text-muted-foreground">·</span>
        <div className="text-muted-foreground">
          {sessions.length} {sessions.length === 1 ? 'agent' : 'agents'}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <LayoutBtn current={layout} target="mosaic" set={setLayout}>
            Mosaic
          </LayoutBtn>
          <LayoutBtn current={layout} target="columns" set={setLayout}>
            Columns
          </LayoutBtn>
          <LayoutBtn current={layout} target="focus" set={setLayout}>
            Focus
          </LayoutBtn>
        </div>
      </div>
      <div
        className={cn('grid min-h-0 flex-1 gap-2 overflow-hidden p-2', gridClassFor(visibleSessions.length, layout))}
      >
        {visibleSessions.map((session) => (
          <PaneFrame
            key={session.id}
            session={session}
            isFocus={layout === 'focus'}
            onFocus={() => {
              setLayout('focus');
              setFocusId(session.id);
            }}
            onUnfocus={() => {
              setLayout('mosaic');
              setFocusId(null);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function PaneFrame({
  session,
  isFocus,
  onFocus,
  onUnfocus,
}: {
  session: ReturnType<typeof useAppState>['state']['sessions'][number];
  isFocus: boolean;
  onFocus: () => void;
  onUnfocus: () => void;
}) {
  const exited = session.status === 'exited';
  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex h-7 items-center gap-2 border-b border-border px-2 text-[11px]">
        <span className="h-2 w-2 rounded-full" style={{ background: exited ? '#ef4444' : '#22c55e' }} />
        <span className="font-medium uppercase tracking-wider">{session.providerId}</span>
        {session.branch ? (
          <span className="truncate text-muted-foreground" title={session.branch}>
            {session.branch}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {isFocus ? (
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onUnfocus} aria-label="Restore grid">
              <Minimize2 className="h-3 w-3" />
            </Button>
          ) : (
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onFocus} aria-label="Focus pane">
              <Maximize2 className="h-3 w-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => void rpc.pty.kill(session.id)}
            disabled={exited}
            aria-label="Stop session"
          >
            <Square className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <SessionTerminal sessionId={session.id} />
      </div>
    </div>
  );
}

function LayoutBtn({
  current,
  target,
  set,
  children,
}: {
  current: Layout;
  target: Layout;
  set: (l: Layout) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => set(target)}
      className={cn(
        'rounded-md px-2 py-1 text-xs',
        current === target ? 'bg-primary/15 text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50',
      )}
    >
      {children}
    </button>
  );
}

function RoomEmpty({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
      <X className="h-6 w-6 text-muted-foreground" />
      <div className="text-sm text-muted-foreground">{title}</div>
    </div>
  );
}
