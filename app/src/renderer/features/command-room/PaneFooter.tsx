// V3-W13-003: per-pane footer hint strip.
//
// Cycles between `auto mode on (shift+tab to cycle)` and `bypass permissions on`
// based on agent state. The auto-approve flag isn't stored on AgentSession
// directly — it lives at the swarm-agent level (`swarm_agents.autoApprove`,
// V3-W12-018) and is mirrored into kv as `swarm.<swarmId>.<agentKey>.autoApprove`.
// We read that kv key when present; otherwise we fall back to the provider's
// own auto-approve flag column on the session if we ever start surfacing it.

import { useEffect, useState } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import type { AgentSession } from '@/shared/types';

interface Props {
  session: AgentSession;
  /**
   * Optional kv key (`swarm.<swarmId>.<agentKey>.autoApprove`). When provided,
   * the footer reads the boolean from kv. When not provided, the footer
   * defaults to `auto mode on`.
   */
  kvKey?: string;
}

export function PaneFooter({ session, kvKey }: Props) {
  // `kvBypass` is null until the async kv lookup resolves. setState only
  // fires from the resolved promise callback (the external-source exception
  // in react-hooks rules), never synchronously inside the effect body.
  const [kvBypass, setKvBypass] = useState<boolean | null>(null);

  useEffect(() => {
    if (!kvKey) return;
    let alive = true;
    void (async () => {
      try {
        const v = await rpcSilent.kv.get(kvKey);
        if (!alive) return;
        setKvBypass(v === '1' || v === 'true');
      } catch {
        if (alive) setKvBypass(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [kvKey]);

  const bypass = kvBypass ?? false;

  // Hide footer for exited / errored sessions — there's no shell to cycle.
  if (session.status === 'exited' || session.status === 'error') return null;

  return (
    <div className="flex h-5 items-center border-t border-border/60 bg-card/80 px-2 text-[10px] text-muted-foreground">
      {bypass ? (
        <span className="font-medium text-amber-400">bypass permissions on</span>
      ) : (
        <span>
          auto mode on{' '}
          <span className="text-muted-foreground/60">(shift+tab to cycle)</span>
        </span>
      )}
    </div>
  );
}
