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

/** Trailing-coalesce window for event-driven refetches. A burst of
 *  `memory:changed`/`tasks:changed`/`skills:changed`/`review:changed` events
 *  (e.g. a batch write emitting N change notifications) collapses into ONE
 *  full-list refetch + ONE state replace. */
const EVENT_REFRESH_DEBOUNCE_MS = 250;

/**
 * Shared shape for the per-workspace hydrate-on-mount-and-event pattern.
 * Mirrors the original `let alive = true / if (!alive) return / off()`
 * boilerplate so a stale fetch after unmount can't dispatch into a
 * torn-down provider. The fetcher receives an `isAlive()` getter that
 * must be re-checked after every `await` boundary.
 *
 * The MOUNT-time hydration fires immediately; EVENT-triggered refreshes are
 * trailing-coalesced over `debounceMs` (perf-hot-paths Task 5).
 *
 * Returns the useEffect cleanup function — call it as
 * `return runRefreshOnEvent(...)` from inside a useEffect.
 */
export function runRefreshOnEvent(
  fetcher: (isAlive: () => boolean) => Promise<void>,
  eventName: string,
  label: string,
  debounceMs = EVENT_REFRESH_DEBOUNCE_MS,
): () => void {
  let alive = true;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const refresh = () => {
    void (async () => {
      try {
        await fetcher(() => alive);
      } catch (err) {
        if (alive) console.error('Failed to load', label, err);
      }
    })();
  };
  // Mount-time hydration stays immediate — rooms must not open 250 ms stale.
  refresh();
  const onEvent = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (alive) refresh();
    }, debounceMs);
  };
  const off = window.sigma.eventOn(eventName, onEvent);
  return () => {
    alive = false;
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    off();
  };
}

// BUG-V1.1.2-02 — Runtime mirror of the `RoomId` union so the session-restore
// handler can narrow an incoming string before dispatching SET_ROOM. This
// mirror drifted THREE times ('git', 'sigmabench', then 'missions' in P1a) —
// each time the restore silently fell back to 'workspaces'. The list is now
// typed so the drift is a COMPILE error: `satisfies` proves every element is
// a RoomId, and the `MissingRoom` assertion below proves every RoomId is an
// element. Add a room to the union without adding it here and tsc fails.
const VALID_ROOMS_LIST = [
  'workspaces',
  'command',
  'swarm',
  'operator',
  'review',
  'tasks',
  'memory',
  'browser',
  'skills',
  'jorvis',
  'settings',
  'git',
  'sigmabench',
  'automations',
  // Phase 20 P1a — Missions room.
  'missions',
] as const satisfies readonly RoomId[];

// Exhaustiveness tripwire: if a RoomId union member is absent from the list
// above, `MissingRoom` is non-never and this assignment fails to compile.
type MissingRoom = Exclude<RoomId, (typeof VALID_ROOMS_LIST)[number]>;
const _assertAllRoomsListed: MissingRoom extends never ? true : never = true;
void _assertAllRoomsListed;

const VALID_ROOMS: ReadonlySet<RoomId> = new Set<RoomId>(VALID_ROOMS_LIST);

export function isRoomId(value: unknown): value is RoomId {
  return typeof value === 'string' && VALID_ROOMS.has(value as RoomId);
}

/**
 * Normalize a persisted room string, applying backward-compat mappings.
 * Persisted sessions/localStorage may hold `room: 'sigma'` from before the
 * W-6 identifier rename; map it to `'jorvis'` so restore still works.
 */
export function normalizeRoomId(value: string): string {
  if (value === 'sigma') return 'jorvis';
  return value;
}

export function parseOpenWorkspacesChanged(raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as { workspaceIds?: unknown };
  if (!Array.isArray(p.workspaceIds)) return null;
  const ids = p.workspaceIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length === p.workspaceIds.length ? ids : null;
}

/** Multi-window B3 — one entry of the `app:window-scope-changed` table. */
export interface WindowScopeEntry {
  windowId: number;
  isMain: boolean;
  workspaceIds: string[];
}

/**
 * Multi-window B3 — defensively parse the `{ scopes }` payload main broadcasts
 * on every ownership change (detach/redock/window-close). Mirrors
 * `parseOpenWorkspacesChanged`'s strict style: any malformed entry (bad shape,
 * non-integer windowId, non-boolean isMain, non-string-array workspaceIds)
 * rejects the WHOLE payload so a corrupt scope table never half-applies and
 * silently drops a window's workspaces. Returns `null` on any malformation.
 */
export function parseWindowScopeChanged(raw: unknown): WindowScopeEntry[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as { scopes?: unknown };
  if (!Array.isArray(p.scopes)) return null;
  const scopes: WindowScopeEntry[] = [];
  for (const entry of p.scopes) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as { windowId?: unknown; isMain?: unknown; workspaceIds?: unknown };
    // windowId: accepted as ANY integer here — renderer consumers read only
    // isMain/workspaceIds and must not assume positivity (window-context.ts is
    // the surface that requires > 0).
    if (typeof e.windowId !== 'number' || !Number.isInteger(e.windowId)) return null;
    if (typeof e.isMain !== 'boolean') return null;
    if (!Array.isArray(e.workspaceIds)) return null;
    const ids = e.workspaceIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (ids.length !== e.workspaceIds.length) return null;
    scopes.push({ windowId: e.windowId, isMain: e.isMain, workspaceIds: ids });
  }
  return scopes;
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
  // BSP-B2 — carry through the detached flag emitted by the main process.
  const detached = p.detached === true;
  return { workspaceId, tabs, activeTabId, lockOwner, mcpUrl, detached };
}
