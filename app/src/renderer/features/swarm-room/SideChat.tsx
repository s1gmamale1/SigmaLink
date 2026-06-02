// V3-W12-015 — Composer chrome.
//
// Recipient chip supports group selectors:
//   `@all`, `@coordinators`, `@builders`, `@scouts`, `@reviewers`
// in addition to per-agent ids and the legacy `'*'` (mapped to `@all`).
//
// Per-message status pill renders a colour + 3-letter code (V3 frame 0250):
//   MSG / DONE / ACK / ESCALATE  (colour follows --role-* tokens).
//
// FEAT-9: search, kind-filter pills, per-message pin (KV-persisted),
// collapsible timestamp-gap grouping for long chats (>40 turns).

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Send, Search, Pin, PinOff, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import { PANE_DRAG_MIME, buildPaneContext, type PaneDragPayload } from '@/renderer/lib/pane-context-builder';
import type { Swarm, SwarmMessage, SwarmMessageKind } from '@/shared/types';
import { MailboxBubble } from './MailboxBubble';
import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

interface Props {
  swarm: Swarm;
  messages: SwarmMessage[];
}

const GROUP_RECIPIENTS: { value: string; label: string }[] = [
  { value: '@all', label: '@all' },
  { value: '@coordinators', label: '@coordinators' },
  { value: '@builders', label: '@builders' },
  { value: '@scouts', label: '@scouts' },
  { value: '@reviewers', label: '@reviewers' },
];

/** KV panel key for pinned message IDs. Written as JSON.stringify(string[]). */
const PINS_PANEL = 'swarmChat.pins';

/** Gap threshold (ms) to start a new collapsible "run" group. */
const RUN_GAP_MS = 10 * 60 * 1000; // 10 minutes

/** All message kinds available for filter pills. */
const ALL_KINDS: SwarmMessageKind[] = [
  'SAY',
  'ACK',
  'STATUS',
  'DONE',
  'OPERATOR',
  'ROLLCALL',
  'ROLLCALL_REPLY',
  'SYSTEM',
];

/**
 * Map a V3 envelope kind to a 3-letter status pill code + role-colour class.
 * `MSG` is the default for SAY/OPERATOR; ESCALATE / DONE / ACK are first-class
 * surfaces in the V3 chat tail.
 */
function statusPillFor(
  message: SwarmMessage,
): { code: string; cls: string } {
  switch (message.kind) {
    case 'DONE':
      return { code: 'DONE', cls: 'bg-role-scout/20 text-role-scout border-role-scout/40' };
    case 'ACK':
      return { code: 'ACK', cls: 'bg-role-coordinator/20 text-role-coordinator border-role-coordinator/40' };
    case 'STATUS':
      return { code: 'MSG', cls: 'bg-role-builder/20 text-role-builder border-role-builder/40' };
    case 'ROLLCALL':
    case 'ROLLCALL_REPLY':
      return { code: 'MSG', cls: 'bg-role-builder/20 text-role-builder border-role-builder/40' };
    case 'SYSTEM':
      return { code: 'MSG', cls: 'bg-muted text-muted-foreground border-border' };
    case 'OPERATOR':
    case 'SAY':
    default:
      // V3 "ESCALATE" surfaces when payload flags it; fall back to MSG.
      if (
        message.payload &&
        typeof message.payload === 'object' &&
        'escalate' in message.payload &&
        message.payload.escalate
      ) {
        return { code: 'ESCALATE', cls: 'bg-role-reviewer/20 text-role-reviewer border-role-reviewer/40' };
      }
      return { code: 'MSG', cls: 'bg-role-builder/20 text-role-builder border-role-builder/40' };
  }
}

/**
 * Format a timestamp epoch-ms as a short human string (time if same day,
 * otherwise date+time).
 */
function formatTs(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Split a flat sorted message list into "run" groups separated by RUN_GAP_MS
 * gaps. The most-recent run is index 0; older runs are index 1+.
 */
interface RunGroup {
  label: string;
  messages: SwarmMessage[];
}

function buildRunGroups(msgs: SwarmMessage[]): RunGroup[] {
  if (msgs.length === 0) return [];

  const groups: RunGroup[] = [];
  let current: SwarmMessage[] = [];

  for (let i = 0; i < msgs.length; i++) {
    if (
      i > 0 &&
      msgs[i].ts - msgs[i - 1].ts > RUN_GAP_MS
    ) {
      groups.push({ label: formatTs(current[0].ts), messages: current });
      current = [];
    }
    current.push(msgs[i]);
  }
  if (current.length > 0) {
    groups.push({ label: formatTs(current[0].ts), messages: current });
  }

  // Reverse so newest group is first.
  groups.reverse();
  return groups;
}

export function SideChat({ swarm, messages }: Props) {
  const [recipient, setRecipient] = useState<string>('@all');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // FEAT-9 state
  const [searchRaw, setSearchRaw] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeKinds, setActiveKinds] = useState<Set<SwarmMessageKind>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  // Tracks which older run-groups are open (by their group index 1+). Newest (0) is always open.
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate pins from KV on mount.
  useEffect(() => {
    void readWorkspaceUi(swarm.id, PINS_PANEL).then((raw) => {
      if (!raw) return;
      try {
        const ids = JSON.parse(raw) as string[];
        if (Array.isArray(ids)) setPinnedIds(new Set(ids));
      } catch {
        /* malformed — ignore */
      }
    });
  }, [swarm.id]);

  // 120ms debounce on search.
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearchQuery(searchRaw.trim().toLowerCase());
    }, 120);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchRaw]);

  function handleComposerDragOver(e: DragEvent<HTMLDivElement>): void {
    if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
      e.preventDefault();
    }
  }

  function handleComposerDrop(e: DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData(PANE_DRAG_MIME);
    try {
      const payload = JSON.parse(raw) as PaneDragPayload;
      void buildPaneContext(payload).then((ctx) => {
        setDraft((d) => (d ? d + '\n\n' : '') + ctx);
      }).catch(() => undefined);
    } catch {
      /* malformed payload — ignore */
    }
  }

  const recipientOptions = useMemo(() => {
    const options: { value: string; label: string }[] = [...GROUP_RECIPIENTS];
    for (const a of swarm.agents) {
      options.push({ value: a.agentKey, label: `${a.agentKey} (${a.providerId})` });
    }
    return options;
  }, [swarm.agents]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      if (recipient === '@all' || recipient === '*') {
        await rpc.swarms.broadcast(swarm.id, body);
      } else {
        await rpc.swarms.sendMessage({
          swarmId: swarm.id,
          toAgent: recipient,
          body,
          kind: 'OPERATOR',
        });
      }
      setDraft('');
    } catch (err) {
      console.error('send failed', err);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  }

  function toggleKind(kind: SwarmMessageKind): void {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  }

  function togglePin(id: string): void {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      // Persist asynchronously — best-effort.
      void writeWorkspaceUi(swarm.id, PINS_PANEL, JSON.stringify([...next]));
      return next;
    });
  }

  function toggleGroup(idx: number): void {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  }

  // Apply search + kind filter.
  const filteredMessages = useMemo(() => {
    return messages.filter((m) => {
      if (activeKinds.size > 0 && !activeKinds.has(m.kind)) return false;
      if (searchQuery) {
        const haystack = `${m.body} ${m.fromAgent} ${m.toAgent}`.toLowerCase();
        if (!haystack.includes(searchQuery)) return false;
      }
      return true;
    });
  }, [messages, activeKinds, searchQuery]);

  // Split filtered messages into pinned (sticky) and unpinned.
  const pinnedMessages = useMemo(
    () => filteredMessages.filter((m) => pinnedIds.has(m.id)),
    [filteredMessages, pinnedIds],
  );
  const unpinnedMessages = useMemo(
    () => filteredMessages.filter((m) => !pinnedIds.has(m.id)),
    [filteredMessages, pinnedIds],
  );

  // Group unpinned messages by run gaps.
  const runGroups = useMemo(
    () => buildRunGroups(unpinnedMessages),
    [unpinnedMessages],
  );

  function renderMessage(m: SwarmMessage): React.ReactNode {
    const pill = statusPillFor(m);
    const isPinned = pinnedIds.has(m.id);
    return (
      <div key={m.id} className="group flex flex-col gap-1">
        <div className="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wider">
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 font-medium',
              pill.cls,
            )}
          >
            {pill.code}
          </span>
          <span className="text-muted-foreground">
            {m.fromAgent} → {m.toAgent === '*' ? '@all' : m.toAgent}
          </span>
          <span className="ml-auto text-muted-foreground/60">{formatTs(m.ts)}</span>
          <button
            type="button"
            aria-label={isPinned ? 'Unpin message' : 'Pin message'}
            title={isPinned ? 'Unpin' : 'Pin'}
            onClick={() => togglePin(m.id)}
            className={cn(
              'rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100',
              isPinned && 'opacity-100 text-primary',
              'hover:bg-accent',
            )}
          >
            {isPinned
              ? <PinOff className="h-3 w-3" />
              : <Pin className="h-3 w-3" />}
          </button>
        </div>
        <MailboxBubble message={m} />
      </div>
    );
  }

  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
        Side chat · {messages.length} messages
      </div>

      {/* Search bar */}
      {hasMessages && (
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={searchRaw}
              onChange={(e) => setSearchRaw(e.target.value)}
              placeholder="Search messages…"
              aria-label="Search messages"
              className="w-full rounded border border-input bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>
      )}

      {/* Kind-filter pills */}
      {hasMessages && (
        <div
          className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-1.5"
          role="group"
          aria-label="Filter by message kind"
        >
          {ALL_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => toggleKind(kind)}
              aria-pressed={activeKinds.has(kind)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-colors',
                activeKinds.has(kind)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-transparent text-muted-foreground hover:border-muted-foreground',
              )}
            >
              {kind}
            </button>
          ))}
          {activeKinds.size > 0 && (
            <button
              type="button"
              onClick={() => setActiveKinds(new Set())}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-muted-foreground"
            >
              clear
            </button>
          )}
        </div>
      )}

      {/* Message list */}
      <div ref={scrollRef} className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
        {filteredMessages.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {messages.length === 0
              ? 'Mailbox is empty. Send a directive or roll-call to get the swarm talking.'
              : 'No messages match your search or filter.'}
          </div>
        ) : (
          <>
            {/* Pinned section */}
            {pinnedMessages.length > 0 && (
              <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-2">
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-primary">
                  <Pin className="h-3 w-3" />
                  Pinned
                </div>
                {pinnedMessages.map((m) => renderMessage(m))}
              </div>
            )}

            {/* Run groups: newest first, always open; older groups collapsible */}
            {runGroups.map((group, idx) => {
              const isNewest = idx === 0;
              const isOpen = isNewest || openGroups.has(idx);
              return (
                <div key={idx} className="flex flex-col gap-2">
                  {isNewest ? (
                    // Newest group: no collapse header, render inline.
                    <>
                      {runGroups.length > 1 && (
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 px-1">
                          Latest run · {group.messages.length} messages
                        </div>
                      )}
                      {group.messages.map((m) => renderMessage(m))}
                    </>
                  ) : (
                    <Collapsible open={isOpen} onOpenChange={() => toggleGroup(idx)}>
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent"
                          aria-expanded={isOpen}
                        >
                          {isOpen
                            ? <ChevronDown className="h-3 w-3 shrink-0" />
                            : <ChevronRight className="h-3 w-3 shrink-0" />}
                          <span>
                            Older run — {group.label} · {group.messages.length} message{group.messages.length !== 1 ? 's' : ''}
                          </span>
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="flex flex-col gap-2 pt-1 motion-safe:animate-none">
                        {group.messages.map((m) => renderMessage(m))}
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border p-2">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">To</span>
          <select
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            {recipientOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div
          data-testid="sidechat-composer"
          onDragOver={handleComposerDragOver}
          onDrop={handleComposerDrop}
          className="flex items-end gap-2"
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              recipient === '@all'
                ? 'Broadcast to every agent…'
                : `Message ${recipient}…`
            }
            rows={2}
            className="min-h-[44px] flex-1 resize-none rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          />
          <Button
            onClick={send}
            disabled={busy || !draft.trim() || swarm.status !== 'running'}
            className="gap-1"
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </Button>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          Cmd/Ctrl+Enter to send · {recipient.startsWith('@')
            ? 'group recipient'
            : 'recipient sticks for back-and-forth'}
        </div>
      </div>
    </div>
  );
}
