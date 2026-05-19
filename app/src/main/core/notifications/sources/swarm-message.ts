// v1.4.9 #07 — Swarm broadcast notification source.
//
// Wiring contract (per brief §4 "Wiring contracts" item 2): the mailbox
// already calls `setEmitter(message)` on every append. We extend the same
// emitter closure in `rpc-router.ts` so one mailbox emit feeds (a) the
// existing renderer broadcast AND (b) this notifications source.
//
// Gate:
//   - `message.payload?.broadcastToSidebar === true` (operator-set on the
//     envelope payload — JSON-typed, no migration needed per Open Q5
//     resolution), AND
//   - `message.kind ∈ {swarm-broadcast, escalation, review_request,
//     error_report}` — legacy SIGMA:: kinds we already track.
//
// Severity mapping (D1):
//   - default → `info`
//   - `kind ∈ {escalation, error_report}` → `warn`
//
// Dedup key (D3): `swarm:${swarmId}:${kind}:${fromAgent}`. Bursts from one
// agent collapse; two agents posting independently do not.

import type { NotificationsManager } from '../manager';
import { getDb } from '../../db/client';
import { swarms } from '../../db/schema';
import { eq } from 'drizzle-orm';
import type { SwarmMessage } from '../../../../shared/types';

const WARN_KINDS = new Set<string>(['escalation', 'error_report']);
const ALLOWED_KINDS = new Set<string>([
  'swarm-broadcast',
  'escalation',
  'review_request',
  'error_report',
]);

function resolveWorkspaceForSwarm(swarmId: string): string | null {
  try {
    const row = getDb()
      .select({ workspaceId: swarms.workspaceId })
      .from(swarms)
      .where(eq(swarms.id, swarmId))
      .get();
    return row?.workspaceId ?? null;
  } catch {
    return null;
  }
}

export function pushSwarmMessageNotification(
  manager: NotificationsManager,
  message: SwarmMessage,
): void {
  if (!ALLOWED_KINDS.has(message.kind as string)) return;
  const broadcastFlag = message.payload?.broadcastToSidebar;
  if (broadcastFlag !== true) return;

  const severity = WARN_KINDS.has(message.kind as string) ? 'warn' : 'info';
  const workspaceId = resolveWorkspaceForSwarm(message.swarmId);

  manager.add({
    workspaceId,
    kind: 'swarm-message',
    severity,
    title: `${message.fromAgent} → swarm`,
    body: message.body,
    payload: {
      swarmId: message.swarmId,
      messageId: message.id,
      fromAgent: message.fromAgent,
      kind: message.kind,
    },
    sourceEvent: 'swarm:message',
    dedupKey: `swarm:${message.swarmId}:${message.kind}:${message.fromAgent}`,
  });
}
