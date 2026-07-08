// P1a Task 6 — Missions room hook. Owns the mission list, the currently-open
// mission's board (tasks + events), and the `missions:changed` live
// subscription (Task 4's mission tools emit it after every board mutation).
//
// Missions can be GLOBAL (workspace_id null) by design — this hook never
// filters by workspace: `rpc.missions.list({})` always lists every mission.
// CRITICAL: the call must pass an object, never `list()` bare — the zod
// input schema rejects `undefined` under VALIDATION_MODE 'enforce'.
//
// Hydrate-token discipline mirrors use-jorvis-conversations.ts: missions can
// be picked fast (the operator clicking through the rail while Jorvis is
// still building the board), so a slower `missions.get` resolution for an
// OLDER pick must never paint over a newer one.

import { useCallback, useEffect, useRef, useState } from 'react';
import { onEvent, rpc } from '@/renderer/lib/rpc';
import type { Mission, MissionEvent, MissionTask } from '@/shared/types';

export interface UseMissionsReturn {
  missions: Mission[];
  missionId: string | null;
  mission: Mission | null;
  tasks: MissionTask[];
  events: MissionEvent[];
  loading: boolean;
  refreshMissions: () => Promise<Mission[]>;
  onPickMission: (id: string) => void;
  clearMission: () => void;
}

export function useMissions(): UseMissionsReturn {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [missionId, setMissionId] = useState<string | null>(null);
  const [mission, setMission] = useState<Mission | null>(null);
  const [tasks, setTasks] = useState<MissionTask[]>([]);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [loading, setLoading] = useState(false);

  // Monotonic hydrate-request token — every entry point that starts (or
  // invalidates) a board fetch bumps it; hydrateMission re-checks it after
  // the await and discards superseded resolutions.
  const hydrateTokenRef = useRef(0);
  // Mirror of `missionId` for the `missions:changed` subscriber below, which
  // is installed once on mount — reading `missionId` directly there would
  // close over its mount-time value (always null).
  const missionIdRef = useRef<string | null>(null);
  useEffect(() => {
    missionIdRef.current = missionId;
  }, [missionId]);

  const refreshMissions = useCallback(async (): Promise<Mission[]> => {
    try {
      const rows = await rpc.missions.list({});
      setMissions(rows);
      return rows;
    } catch {
      setMissions([]);
      return [];
    }
  }, []);

  const hydrateMission = useCallback(async (id: string): Promise<void> => {
    const token = ++hydrateTokenRef.current;
    setLoading(true);
    try {
      const res = await rpc.missions.get({ missionId: id });
      if (token !== hydrateTokenRef.current) return; // superseded — drop
      setMissionId(res.mission?.id ?? null);
      setMission(res.mission);
      setTasks(res.tasks);
      setEvents(res.events);
    } catch {
      if (token !== hydrateTokenRef.current) return;
      setMission(null);
      setTasks([]);
      setEvents([]);
    } finally {
      if (token === hydrateTokenRef.current) setLoading(false);
    }
  }, []);

  const onPickMission = useCallback(
    (id: string) => {
      void hydrateMission(id);
    },
    [hydrateMission],
  );

  const clearMission = useCallback(() => {
    // A pending hydrate must not resurrect the cleared mission.
    hydrateTokenRef.current += 1;
    setMissionId(null);
    setMission(null);
    setTasks([]);
    setEvents([]);
  }, []);

  // Mount: fetch the mission list once. Wrapped in a nested async IIFE (not
  // a direct top-level call) — mirrors use-jorvis-ruflo-health.ts's pattern
  // and avoids react-hooks/set-state-in-effect (calling a state-setting
  // callback directly as the effect body's own statement).
  useEffect(() => {
    void (async () => {
      await refreshMissions();
    })();
  }, [refreshMissions]);

  // `missions:changed` fires on every board mutation (Task 4's mission
  // tools). Refetch the list, and if a mission is currently open, refetch
  // its board too — reads `missionIdRef` (not the `missionId` state) so this
  // subscription can be installed once and never goes stale.
  useEffect(() => {
    const off = onEvent('missions:changed', () => {
      void refreshMissions();
      const id = missionIdRef.current;
      if (id) void hydrateMission(id);
    });
    return off;
  }, [refreshMissions, hydrateMission]);

  return {
    missions,
    missionId,
    mission,
    tasks,
    events,
    loading,
    refreshMissions,
    onPickMission,
    clearMission,
  };
}
