// use-control-escalation — subscribes to `control:escalation` IPC events and
// queues pending approval requests. The escalation prompt component consumes
// the queue and calls `rpc.control.respondEscalation` on approve/deny.

import { useEffect, useState } from 'react';

export interface EscalationRequest {
  id: string;
  toolName: string;
  summary: string;
  clientLabel: string;
}

export function useControlEscalation() {
  const [queue, setQueue] = useState<EscalationRequest[]>([]);

  useEffect(() => {
    if (!('sigma' in window)) return;

    const off = window.sigma.eventOn('control:escalation', (raw: unknown) => {
      const payload = raw as EscalationRequest;
      if (!payload?.id) return;
      setQueue((prev) => {
        // Deduplicate by id — a duplicate push is harmless but noisy.
        if (prev.some((r) => r.id === payload.id)) return prev;
        return [...prev, payload];
      });
    });

    return off;
  }, []);

  const dismiss = (id: string) =>
    setQueue((prev) => prev.filter((r) => r.id !== id));

  return { queue, dismiss };
}
