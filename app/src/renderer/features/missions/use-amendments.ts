// P2 Task 8 — self-amendments review queue hook. Mirrors use-missions.ts's
// fetch-on-mount + live-event-refetch pattern: list PROPOSED amendments (the
// operator's decision queue) via `jorvis.amendmentsList`, refetch on
// `jorvis:amendments-changed` (emitted by BOTH the propose_amendment tool
// AND this hook's own `decide()` call, since jorvis.amendmentsDecide
// broadcasts the same event on the main side), and expose `decide()` for the
// panel's Approve/Deny buttons.

import { useCallback, useEffect, useState } from 'react';
import { onEvent, rpc } from '@/renderer/lib/rpc';
import type { JorvisAmendment } from '@/shared/types';

export interface UseAmendmentsReturn {
  amendments: JorvisAmendment[];
  decidingId: string | null;
  decide: (id: string, approved: boolean) => Promise<void>;
}

export function useAmendments(): UseAmendmentsReturn {
  const [amendments, setAmendments] = useState<JorvisAmendment[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const rows = await rpc.jorvis.amendmentsList({ status: 'proposed' });
      setAmendments(rows);
    } catch {
      setAmendments([]);
    }
  }, []);

  // Mount: fetch once. Wrapped in a nested async IIFE (not a direct
  // top-level call) — mirrors use-missions.ts's mount effect.
  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  // `jorvis:amendments-changed` fires on every propose/decide. Refetch the
  // queue so the badge count and row list stay live without polling.
  useEffect(() => {
    const off = onEvent('jorvis:amendments-changed', () => {
      void refresh();
    });
    return off;
  }, [refresh]);

  const decide = useCallback(async (id: string, approved: boolean): Promise<void> => {
    setDecidingId(id);
    try {
      await rpc.jorvis.amendmentsDecide({ amendmentId: id, approved });
    } finally {
      setDecidingId(null);
    }
  }, []);

  return { amendments, decidingId, decide };
}
