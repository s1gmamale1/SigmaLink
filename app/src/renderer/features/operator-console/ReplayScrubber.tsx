// P3-S6 — Persistent Swarm Replay scrubber.
//
// V3 swarms vanish when the window closes. SigmaLink's mailbox is
// event-sourced on disk so every past session can be replayed frame-by-frame.
// This component owns the timeline UI: a `<input type="range">` scrubber, a
// frame counter, a bookmark dropdown, and the swarm picker. Drag the slider
// → `swarm.replay.scrub` → updates `replayFrame` → Constellation +
// ActivityFeed re-render in historical mode.

import { useCallback, useEffect, useState } from 'react';
import { Bookmark, BookmarkPlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Wire-shapes — match the controller in `core/swarms/replay.ts`.
export interface ReplayAgent {
  id: string; agentKey: string; role: string; roleIndex: number;
  providerId: string; addedAt: number;
}
export interface ReplayMsg {
  id: string; fromAgent: string; toAgent: string; kind: string;
  body: string; ts: number; payload?: Record<string, unknown>;
}
export interface ReplayFrame {
  swarmId: string; swarmName: string; missionText: string;
  frameIdx: number; totalFrames: number;
  agents: ReplayAgent[]; messages: ReplayMsg[];
  counters: { escalations: number; review: number; quiet: number; errors: number };
}
export interface ReplaySwarmSummary {
  swarmId: string; name: string; missionExcerpt: string;
  agentCount: number; messageCount: number;
  firstAt: number | null; lastAt: number | null; status: string;
}
export interface ReplayBookmark {
  id: string; label: string; frameIdx: number; createdAt: number;
}

interface Props {
  workspaceId: string;
  /** Reports the active replay frame upward so siblings can re-render. */
  onFrameChange: (frame: ReplayFrame | null) => void;
}

async function invokeReplay<T = unknown>(
  channel: `swarm.replay.${string}`,
  arg: unknown,
): Promise<T> {
  if (!('sigma' in window)) throw new Error('Preload bridge missing.');
  const env = (await window.sigma.invoke(channel, arg)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!env || typeof env !== 'object' || !('ok' in env)) {
    throw new Error(`Bad RPC response from ${channel}`);
  }
  if (env.ok) return env.data;
  throw new Error(env.error);
}

export function ReplayScrubber({ workspaceId, onFrameChange }: Props) {
  const [swarmList, setSwarmList] = useState<ReplaySwarmSummary[]>([]);
  const [activeSwarmId, setActiveSwarmId] = useState<string | null>(null);
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const [bookmarks, setBookmarks] = useState<ReplayBookmark[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);

  // Hydrate the swarm picker on mount + workspace change.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await invokeReplay<ReplaySwarmSummary[]>(
          'swarm.replay.list', { workspaceId },
        );
        if (cancelled) return;
        setSwarmList(list);
        if (!activeSwarmId && list.length > 0) setActiveSwarmId(list[0].swarmId);
      } catch { /* allowlist not yet wired or empty workspace */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // When the active swarm flips, reset to frame 0 + load bookmarks. Reset
  // path runs inside the async closure so we don't trigger setState during
  // effect setup (eslint react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!activeSwarmId) {
        if (!cancelled) { setFrame(null); setBookmarks([]); onFrameChange(null); }
        return;
      }
      try {
        const f = await invokeReplay<ReplayFrame>('swarm.replay.scrub', {
          swarmId: activeSwarmId, frameIdx: 0,
        });
        if (cancelled) return;
        setFrame(f); onFrameChange(f);
      } catch { /* ignore */ }
      try {
        const bm = await invokeReplay<ReplayBookmark[]>(
          'swarm.replay.listBookmarks', { swarmId: activeSwarmId },
        );
        if (!cancelled) setBookmarks(bm);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSwarmId]);

  const onScrub = useCallback(async (next: number) => {
    if (!activeSwarmId) return;
    try {
      const f = await invokeReplay<ReplayFrame>('swarm.replay.scrub', {
        swarmId: activeSwarmId, frameIdx: next,
      });
      setFrame(f); onFrameChange(f);
    } catch { /* UI stays at last good frame */ }
  }, [activeSwarmId, onFrameChange]);

  const onBookmark = useCallback(async () => {
    if (!frame || !activeSwarmId) return;
    const label = window.prompt('Bookmark label?', `Frame ${frame.frameIdx}`);
    if (!label || !label.trim()) return;
    try {
      await invokeReplay('swarm.replay.bookmark', {
        swarmId: activeSwarmId, frameIdx: frame.frameIdx, label: label.trim(),
      });
      const bm = await invokeReplay<ReplayBookmark[]>(
        'swarm.replay.listBookmarks', { swarmId: activeSwarmId },
      );
      setBookmarks(bm);
    } catch { /* ignore */ }
  }, [activeSwarmId, frame]);

  const onDeleteBookmark = useCallback(async (b: ReplayBookmark) => {
    try {
      await invokeReplay('swarm.replay.deleteBookmark', { snapshotId: b.id });
      setBookmarks((prev) => prev.filter((x) => x.id !== b.id));
    } catch { /* ignore */ }
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!frame) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      void onScrub(Math.max(0, frame.frameIdx - 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      void onScrub(Math.min(frame.totalFrames, frame.frameIdx + 1));
    }
  }, [frame, onScrub]);

  if (swarmList.length === 0) {
    return (
      <div className="flex shrink-0 items-center justify-center border-t border-border bg-card/30 px-3 py-3 text-[11px] text-muted-foreground">
        No past swarms in this workspace yet — create one to populate replays.
      </div>
    );
  }

  const max = frame?.totalFrames ?? 0;
  const idx = frame?.frameIdx ?? 0;
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-card/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <select
          value={activeSwarmId ?? ''}
          onChange={(e) => setActiveSwarmId(e.target.value || null)}
          className="rounded-md border border-border bg-background px-2 py-1 text-[11px]"
          aria-label="Select past swarm"
        >
          {swarmList.map((s) => (
            <option key={s.swarmId} value={s.swarmId}>
              {s.name} ({s.messageCount} events)
            </option>
          ))}
        </select>
        <span className="text-[11px] text-muted-foreground line-clamp-1">
          {frame?.missionText ?? ''}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={onBookmark} disabled={!frame} className="gap-1">
            <BookmarkPlus className="h-3.5 w-3.5" /> Bookmark
          </Button>
          <div className="relative">
            <Button variant="outline" size="sm" onClick={() => setBookmarksOpen((v) => !v)} disabled={bookmarks.length === 0} className="gap-1">
              <Bookmark className="h-3.5 w-3.5" /> {bookmarks.length}
            </Button>
            {bookmarksOpen && bookmarks.length > 0 ? (
              <ul className="absolute right-0 top-full z-10 mt-1 w-64 rounded-md border border-border bg-popover p-1 shadow-md">
                {bookmarks.map((b) => (
                  <li key={b.id} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-card/60">
                    <button
                      type="button"
                      onClick={() => { setBookmarksOpen(false); void onScrub(b.frameIdx); }}
                      className="flex-1 truncate text-left text-[11px]"
                    >
                      <span className="font-medium">{b.label}</span>
                      <span className="ml-2 text-muted-foreground">@ frame {b.frameIdx}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDeleteBookmark(b)}
                      className="rounded p-1 hover:bg-destructive/30"
                      aria-label={`Delete bookmark ${b.label}`}
                    >
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range" min={0} max={max} step={1} value={idx}
          onChange={(e) => void onScrub(Number(e.target.value))}
          onKeyDown={onKeyDown}
          aria-label="Replay timeline"
          disabled={!frame || max === 0}
          className={cn('flex-1 accent-primary', !frame || max === 0 ? 'opacity-40' : '')}
        />
        <span className="text-[11px] tabular-nums text-muted-foreground">
          Frame {idx} of {max}
        </span>
      </div>
    </div>
  );
}
