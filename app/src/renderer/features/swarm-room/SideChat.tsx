// V3-W12-015 — Composer chrome.
//
// Recipient chip supports group selectors:
//   `@all`, `@coordinators`, `@builders`, `@scouts`, `@reviewers`
// in addition to per-agent ids and the legacy `'*'` (mapped to `@all`).
//
// Per-message status pill renders a colour + 3-letter code (V3 frame 0250):
//   MSG / DONE / ACK / ESCALATE  (colour follows --role-* tokens).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import type { Swarm, SwarmMessage } from '@/shared/types';
import { MailboxBubble } from './MailboxBubble';

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

export function SideChat({ swarm, messages }: Props) {
  const [recipient, setRecipient] = useState<string>('@all');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      // Map V3 group selectors onto today's RPC: '@all' → broadcast, every
      // other group selector falls through to sendMessage with the group
      // string in `toAgent`. Foundations' V3-W12-016 mailbox migration
      // handles group expansion main-side.
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

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
        Side chat · {messages.length} messages
      </div>
      <div ref={scrollRef} className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            Mailbox is empty. Send a directive or roll-call to get the swarm talking.
          </div>
        ) : (
          messages.map((m) => {
            const pill = statusPillFor(m);
            return (
              <div key={m.id} className="flex flex-col gap-1">
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
                </div>
                <MailboxBubble message={m} />
              </div>
            );
          })
        )}
      </div>
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
        <div className="flex items-end gap-2">
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
            className="min-h-[44px] flex-1 resize-none rounded-md border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
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
