// Step 4: session picker.
//
// v1.3.0 — one row per pane. Each row shows: colour dot (workspace-color.ts)
// · provider name · pane index · session chip (Badge) · "Change…" popover.
//
// On step enter: rpc.panes.listSessions(providerId, cwd) is called per pane;
// the first result is pre-selected, otherwise "New session" is the default.
//
// Bulk bar provides: "Resume newest for all" / "All new" / "Reset to suggested".
//
// Wire contract (backend runs in parallel; mock until RPC lands):
//   rpc.panes.listSessions({ providerId, cwd }) → SessionListItem[] DESC updatedAt
//   rpc.panes.lastResumePlan(workspaceId) → ResumePlanEntry[]

import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { workspaceColor } from '@/renderer/lib/workspace-color';
import { rpcSilent } from '@/renderer/lib/rpc';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionListItem {
  id: string;
  providerId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  firstMessagePreview?: string;
}

export interface ResumePlanEntry {
  paneIndex: number;
  providerId: string;
  sessionId: string | null;
}

export interface PaneSession {
  paneIndex: number;
  providerId: string;
  /** null means "New session" */
  sessionId: string | null;
}

export interface PaneRow {
  paneIndex: number;
  providerId: string;
  providerName: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Stable hash of a string for the colour palette. */
function colorKey(s: string): string {
  // Deterministic: same provider across panes uses provider id as seed,
  // so same provider → same dot colour everywhere in the wizard.
  return s;
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function sessionLabel(item: SessionListItem): string {
  const time = formatRelative(item.updatedAt);
  const extra = item.title ?? item.firstMessagePreview ?? '';
  if (!extra) return time;
  const trimmed = extra.length > 40 ? extra.slice(0, 37) + '…' : extra;
  return `${time} · ${trimmed}`;
}

// ─── Mock RPC (removed once backend lands) ───────────────────────────────────

type PanesRpc = {
  listSessions: (args: { providerId: string; cwd: string; opts?: unknown }) => Promise<SessionListItem[]>;
  lastResumePlan: (workspaceId: string) => Promise<ResumePlanEntry[]>;
};

// Access rpc.panes via cast — channels not yet registered in router-shape.
const panesRpc = (rpcSilent as unknown as { panes: PanesRpc }).panes;

async function fetchSessions(providerId: string, cwd: string): Promise<SessionListItem[]> {
  try {
    const items = await panesRpc.listSessions({ providerId, cwd });
    return Array.isArray(items) ? items.slice(0, 50) : [];
  } catch {
    return [];
  }
}

// v1.3.0 — Fetches the last resume plan for a workspace (Scenario B: sidebar
// re-open pre-population). Called from Launcher.tsx before advancing to the
// SessionStep. Exported so Launcher can import without a circular dep.
async function fetchLastResumePlan(workspaceId: string): Promise<ResumePlanEntry[]> {
  try {
    const plan = await panesRpc.lastResumePlan(workspaceId);
    return Array.isArray(plan) ? plan : [];
  } catch {
    return [];
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export { fetchLastResumePlan };

// ─── Sub-components ──────────────────────────────────────────────────────────

interface SessionChipProps {
  session: SessionListItem | null;
}

function SessionChip({ session }: SessionChipProps) {
  if (!session) {
    return (
      <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
        New session
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="max-w-[200px] truncate text-xs font-normal">
      {sessionLabel(session)}
    </Badge>
  );
}

interface SessionCommandProps {
  sessions: SessionListItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function SessionCommand({ sessions, selectedId, onSelect }: SessionCommandProps) {
  return (
    <Command className="w-72 rounded-lg border border-border bg-popover shadow-md" loop>
      <Command.Input
        placeholder="Search sessions…"
        className="border-b border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-60 overflow-y-auto p-1">
        <Command.Empty className="py-3 text-center text-xs text-muted-foreground">
          No sessions found.
        </Command.Empty>
        <Command.Item
          value="__new__"
          onSelect={() => onSelect(null)}
          className={cn(
            'flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm transition-colors',
            'aria-selected:bg-accent aria-selected:text-accent-foreground',
            selectedId === null && 'bg-accent/20',
          )}
        >
          <span className="font-medium">New session</span>
          <span className="text-xs text-muted-foreground">Start fresh</span>
        </Command.Item>
        {sessions.length > 0 && (
          <Command.Group heading="Recent sessions" className="mt-1">
            {sessions.map((s) => (
              <Command.Item
                key={s.id}
                value={s.id + (s.title ?? '') + (s.firstMessagePreview ?? '')}
                onSelect={() => onSelect(s.id)}
                className={cn(
                  'flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                  'aria-selected:bg-accent aria-selected:text-accent-foreground',
                  selectedId === s.id && 'bg-accent/20',
                )}
              >
                <span className="truncate font-mono text-xs">{s.id.slice(0, 8)}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {sessionLabel(s)}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export interface SessionStepProps {
  rows: PaneRow[];
  cwd: string;
  /** Controlled selection: paneIndex → { sessionId | null } */
  selections: Record<number, string | null>;
  onSelectionsChange: (next: Record<number, string | null>) => void;
  onReconfigure: () => void;
}

export function SessionStep({
  rows,
  cwd,
  selections,
  onSelectionsChange,
  onReconfigure,
}: SessionStepProps) {
  // Per-pane session list — loaded on popover open (lazy, R-1.3.0-1).
  const [sessionLists, setSessionLists] = useState<Record<number, SessionListItem[]>>({});
  const [loadingPanes, setLoadingPanes] = useState<Record<number, boolean>>({});
  const [openPopover, setOpenPopover] = useState<number | null>(null);

  // Ref for the "suggested" smart defaults: top session per pane (or null).
  const suggestedRef = useRef<Record<number, string | null>>({});

  // On step enter: pre-select top-N synchronously for each pane.
  useEffect(() => {
    if (rows.length === 0) return;
    let alive = true;

    void (async () => {
      const initial: Record<number, string | null> = {};
      for (const row of rows) {
        try {
          const items = await fetchSessions(row.providerId, cwd);
          if (!alive) return;
          const topId = items[0]?.id ?? null;
          initial[row.paneIndex] = topId;
          suggestedRef.current[row.paneIndex] = topId;
          setSessionLists((prev) => ({ ...prev, [row.paneIndex]: items }));
        } catch {
          initial[row.paneIndex] = null;
          suggestedRef.current[row.paneIndex] = null;
        }
      }
      if (!alive) return;
      onSelectionsChange({ ...selections, ...initial });
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cwd]);

  // Lazy-load full session list on popover open.
  function handlePopoverOpen(paneIndex: number, providerId: string): void {
    setOpenPopover(paneIndex);
    if (sessionLists[paneIndex] !== undefined) return; // already loaded
    setLoadingPanes((prev) => ({ ...prev, [paneIndex]: true }));
    void fetchSessions(providerId, cwd).then((items) => {
      setSessionLists((prev) => ({ ...prev, [paneIndex]: items }));
      setLoadingPanes((prev) => ({ ...prev, [paneIndex]: false }));
    });
  }

  function setPane(paneIndex: number, sessionId: string | null): void {
    onSelectionsChange({ ...selections, [paneIndex]: sessionId });
    setOpenPopover(null);
  }

  // ─── Bulk actions ──────────────────────────────────────────────────────────

  function resumeNewestForAll(): void {
    const next: Record<number, string | null> = { ...selections };
    for (const row of rows) {
      const list = sessionLists[row.paneIndex] ?? [];
      next[row.paneIndex] = list[0]?.id ?? null;
    }
    onSelectionsChange(next);
  }

  function allNew(): void {
    const next: Record<number, string | null> = {};
    for (const row of rows) {
      next[row.paneIndex] = null;
    }
    onSelectionsChange(next);
  }

  function resetToSuggested(): void {
    const next: Record<number, string | null> = {};
    for (const row of rows) {
      next[row.paneIndex] = suggestedRef.current[row.paneIndex] ?? null;
    }
    onSelectionsChange(next);
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Sessions per pane
        </div>
        <button
          type="button"
          onClick={onReconfigure}
          className="text-xs text-muted-foreground transition hover:text-foreground"
        >
          Reconfigure layout...
        </button>
      </div>

      {/* Bulk bar */}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={resumeNewestForAll}>
          Resume newest for all
        </Button>
        <Button size="sm" variant="outline" onClick={allNew}>
          All new
        </Button>
        <Button size="sm" variant="ghost" onClick={resetToSuggested}>
          Reset to suggested
        </Button>
      </div>

      {/* Pane rows */}
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const selectedId = selections[row.paneIndex] ?? null;
          const list = sessionLists[row.paneIndex] ?? [];
          const selectedItem = list.find((s) => s.id === selectedId) ?? null;
          const dotColor = workspaceColor(colorKey(row.providerId));
          const isLoading = loadingPanes[row.paneIndex] ?? false;

          return (
            <li
              key={row.paneIndex}
              className="flex items-center gap-3 rounded-md border border-border bg-card/40 px-3 py-2 transition"
            >
              {/* Colour dot */}
              <span
                className={cn('h-2.5 w-2.5 shrink-0 rounded-full', dotColor)}
                aria-hidden
              />

              {/* Provider + pane index */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{row.providerName}</span>
                  <span className="text-xs text-muted-foreground">Pane {row.paneIndex + 1}</span>
                </div>
              </div>

              {/* Session chip */}
              <SessionChip session={selectedItem} />

              {/* Change popover */}
              <Popover.Root
                open={openPopover === row.paneIndex}
                onOpenChange={(open) => {
                  if (open) handlePopoverOpen(row.paneIndex, row.providerId);
                  else setOpenPopover(null);
                }}
              >
                <Popover.Trigger asChild>
                  <Button size="sm" variant="outline" className="shrink-0 text-xs">
                    Change...
                  </Button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    side="bottom"
                    align="end"
                    sideOffset={6}
                    className="z-50 animate-in fade-in-0 zoom-in-95"
                    data-testid={`session-popover-${row.paneIndex}`}
                  >
                    {isLoading ? (
                      <div className="flex w-72 items-center justify-center rounded-lg border border-border bg-popover px-4 py-6 text-xs text-muted-foreground shadow-md">
                        Loading sessions...
                      </div>
                    ) : (
                      <SessionCommand
                        sessions={list}
                        selectedId={selectedId}
                        onSelect={(id) => setPane(row.paneIndex, id)}
                      />
                    )}
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
