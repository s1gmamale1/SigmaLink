import { useEffect, useMemo, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import type { Swarm, SwarmMessage } from '@/shared/types';
import { MailboxBubble } from './MailboxBubble';

interface Props {
  swarm: Swarm;
  messages: SwarmMessage[];
}

const BROADCAST: { value: '*'; label: string } = { value: '*', label: 'Broadcast (all)' };

export function SideChat({ swarm, messages }: Props) {
  const [recipient, setRecipient] = useState<string>('*');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const recipientOptions = useMemo(() => {
    const options: { value: string; label: string }[] = [BROADCAST];
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
      if (recipient === '*') {
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
          messages.map((m) => <MailboxBubble key={m.id} message={m} />)
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
              recipient === '*'
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
          Cmd/Ctrl+Enter to send · recipient sticks for back-and-forth
        </div>
      </div>
    </div>
  );
}
