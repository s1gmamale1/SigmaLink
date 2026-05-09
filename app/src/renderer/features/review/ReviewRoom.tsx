// Review Room main page. Two-pane layout: SessionList rail on the left,
// per-session detail tabs (Diff / Tests / Notes / Conflicts) on the right.
// Multi-select drives the BatchToolbar at the bottom.

import { useEffect, useMemo, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useAppState } from '@/renderer/app/state';
import { SessionList } from './SessionList';
import { SessionDetail } from './SessionDetail';
import { BatchToolbar } from './BatchToolbar';

// Stable empty array used when the workspace has no hydrated review state —
// keeps the reference identity flat across renders for `useMemo`/`useEffect`.
const EMPTY_SESSIONS: never[] = [];

export function ReviewRoom() {
  const { state, dispatch } = useAppState();
  const wsId = state.activeWorkspace?.id ?? '';
  const reviewState = state.review[wsId];
  const sessions = reviewState?.sessions ?? EMPTY_SESSIONS;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const activeId = state.activeReviewSessionId;
  // Auto-select first session when entering the room with none selected.
  useEffect(() => {
    if (!activeId && sessions.length > 0) {
      dispatch({ type: 'SET_ACTIVE_REVIEW_SESSION', id: sessions[0].sessionId });
    }
    // If active session vanished (merged + pruned), clear it.
    if (activeId && !sessions.find((s) => s.sessionId === activeId)) {
      dispatch({
        type: 'SET_ACTIVE_REVIEW_SESSION',
        id: sessions[0]?.sessionId ?? null,
      });
    }
  }, [activeId, sessions, dispatch]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === activeId) ?? null,
    [sessions, activeId],
  );

  const toggleCheck = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === sessions.length
        ? new Set()
        : new Set(sessions.map((s) => s.sessionId)),
    );
  };

  if (!state.activeWorkspace) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Open a workspace to use the Review Room.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-muted/20 px-4 py-2">
        <GitBranch className="h-4 w-4 text-amber-400" />
        <h2 className="text-sm font-semibold">Review Room</h2>
        <span className="ml-2 text-xs text-muted-foreground">
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-border">
          <SessionList
            sessions={sessions}
            activeId={activeId}
            selected={selected}
            onSelect={(id) => dispatch({ type: 'SET_ACTIVE_REVIEW_SESSION', id })}
            onToggleCheck={toggleCheck}
            onToggleAll={toggleAll}
          />
          <BatchToolbar
            selectedIds={Array.from(selected)}
            onClearSelection={() => setSelected(new Set())}
          />
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          {activeSession ? (
            <SessionDetail session={activeSession} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No session selected.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
