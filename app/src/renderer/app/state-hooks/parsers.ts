// v1.1.9 file-size split — shared IPC payload parsers and effect helpers
// for the state-hooks modules. These are pure, side-effect-free helpers
// extracted so each hook file stays under the 150-LOC budget. No React, no
// IPC bridge access except for the `eventOn` subscription in
// `runRefreshOnEvent`, which is meant to be called from inside a useEffect.

import type { BrowserState, SwarmMessage, SwarmMessageKind } from '../../../shared/types';
import type { RoomId } from '../state.types';

// Runtime mirror of `SwarmMessageKind` so the parser can reject malformed
// payloads instead of casting through `as`. If a new kind lands in
// shared/types.ts, add it here too — the unit test in state.test.ts asserts
// every kind round-trips cleanly.
const VALID_SWARM_KINDS: ReadonlySet<SwarmMessageKind> = new Set<SwarmMessageKind>([
  'SAY',
  'ACK',
  'STATUS',
  'DONE',
  'OPERATOR',
  'ROLLCALL',
  'ROLLCALL_REPLY',
  'SYSTEM',
]);

function isSwarmMessageKind(value: unknown): value is SwarmMessageKind {
  return typeof value === 'string' && VALID_SWARM_KINDS.has(value as SwarmMessageKind);
}

/**
 * Shared shape for the per-workspace hydrate-on-mount-and-event pattern.
 * Mirrors the original `let alive = true / if (!alive) return / off()`
 * boilerplate so a stale fetch after unmount can't dispatch into a
 * torn-down provider. The fetcher receives an `isAlive()` getter that
 * must be re-checked after every `await` boundary.
 *
 * Returns the useEffect cleanup function — call it as
 * `return runRefreshOnEvent(...)` from inside a useEffect.
 */
export function runRefreshOnEvent(
  fetcher: (isAlive: () => boolean) => Promise<void>,
  eventName: string,
  label: string,
): () => void {
  let alive = true;
  const refresh = () => {
    void (async () => {
      try {
        await fetcher(() => alive);
      } catch (err) {
        if (alive) console.error(`Failed to load ${label}:`, err);
      }
    })();
  };
  refresh();
  const off = window.sigma.eventOn(eventName, refresh);
  return () => {
    alive = false;
    off();
  };
}

// BUG-V1.1.2-02 — Runtime mirror of the `RoomId` union so the session-restore
// handler can narrow an incoming string before dispatching SET_ROOM. Adding a
// room here is a one-line edit; failing to add one means the restore silently
// drops back to 'workspaces' for that pane — never a crash.
const VALID_ROOMS: ReadonlySet<RoomId> = new Set<RoomId>([
  'workspaces',
  'command',
  'swarm',
  'operator',
  'review',
  'tasks',
  'memory',
  'browser',
  'skills',
  'sigma',
  'settings',
]);

export function isRoomId(value: unknown): value is RoomId {
  return typeof value === 'string' && VALID_ROOMS.has(value as RoomId);
}

export function parseOpenWorkspacesChanged(raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as { workspaceIds?: unknown };
  if (!Array.isArray(p.workspaceIds)) return null;
  const ids = p.workspaceIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length === p.workspaceIds.length ? ids : null;
}

export interface PendingRestore {
  activeWorkspaceId: string;
  openWorkspaces: Array<{ workspaceId: string; room: string }>;
}

export function parseSessionRestore(raw: unknown): PendingRestore | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as {
    activeWorkspaceId?: unknown;
    openWorkspaces?: unknown;
    workspaceId?: unknown;
    room?: unknown;
  };
  if (typeof p.activeWorkspaceId === 'string' && Array.isArray(p.openWorkspaces)) {
    const openWorkspaces = p.openWorkspaces.filter(
      (entry): entry is { workspaceId: string; room: string } => {
        if (!entry || typeof entry !== 'object') return false;
        const e = entry as { workspaceId?: unknown; room?: unknown };
        return (
          typeof e.workspaceId === 'string' &&
          !!e.workspaceId &&
          typeof e.room === 'string' &&
          !!e.room
        );
      },
    );
    if (openWorkspaces.length === 0) return null;
    return { activeWorkspaceId: p.activeWorkspaceId, openWorkspaces };
  }
  if (typeof p.workspaceId !== 'string' || !p.workspaceId) return null;
  if (typeof p.room !== 'string' || !p.room) return null;
  return {
    activeWorkspaceId: p.workspaceId,
    openWorkspaces: [{ workspaceId: p.workspaceId, room: p.room }],
  };
}

export function parseSwarmMessage(raw: unknown): SwarmMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const swarmId = typeof p.swarmId === 'string' ? p.swarmId : '';
  const id = typeof p.id === 'string' ? p.id : '';
  if (!swarmId || !id) return null;
  const from = typeof p.from === 'string' ? p.from : 'operator';
  const to = typeof p.to === 'string' ? p.to : '*';
  const body = typeof p.body === 'string' ? p.body : '';
  const ts = typeof p.ts === 'number' ? p.ts : Date.now();
  // v1.1.10 — runtime-validate `kind` so a malformed/malicious IPC payload
  // can't smuggle an unknown discriminant into state. Missing or invalid kinds
  // fall back to 'OPERATOR' (a UI-rendered neutral message); an explicit but
  // unknown string (e.g. `{ kind: 'INVALID' }`) is rejected outright so a
  // typo in main/native code is loud, not silent.
  const rawKind = p.kind;
  let kind: SwarmMessageKind;
  if (rawKind === undefined || rawKind === null) {
    kind = 'OPERATOR';
  } else if (isSwarmMessageKind(rawKind)) {
    kind = rawKind;
  } else {
    return null;
  }
  const payload =
    p.payload && typeof p.payload === 'object'
      ? (p.payload as Record<string, unknown>)
      : undefined;
  return { id, swarmId, fromAgent: from, toAgent: to, kind, body, payload, ts };
}

export function parseBrowserState(raw: unknown): BrowserState | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : '';
  if (!workspaceId) return null;
  const tabsRaw = Array.isArray(p.tabs) ? (p.tabs as unknown[]) : [];
  const tabs = tabsRaw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      id: String(t.id ?? ''),
      workspaceId: String(t.workspaceId ?? workspaceId),
      url: String(t.url ?? ''),
      title: String(t.title ?? ''),
      active: Boolean(t.active),
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      lastVisitedAt: typeof t.lastVisitedAt === 'number' ? t.lastVisitedAt : Date.now(),
    }));
  const activeTabId = typeof p.activeTabId === 'string' ? p.activeTabId : null;
  const lockOwnerRaw = p.lockOwner;
  const lockOwner =
    lockOwnerRaw && typeof lockOwnerRaw === 'object'
      ? {
          agentKey: String((lockOwnerRaw as Record<string, unknown>).agentKey ?? ''),
          claimedAt:
            typeof (lockOwnerRaw as Record<string, unknown>).claimedAt === 'number'
              ? ((lockOwnerRaw as Record<string, unknown>).claimedAt as number)
              : Date.now(),
          label:
            typeof (lockOwnerRaw as Record<string, unknown>).label === 'string'
              ? ((lockOwnerRaw as Record<string, unknown>).label as string)
              : undefined,
        }
      : null;
  const mcpUrl = typeof p.mcpUrl === 'string' ? p.mcpUrl : null;
  return { workspaceId, tabs, activeTabId, lockOwner, mcpUrl };
}
