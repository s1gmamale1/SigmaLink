// v1.7.1 W-5 Skills Phase 2 — Hook that manages skill binding state for a
// workspace or pane. Handles:
//   - Initial load from `skills.listBindings` on workspace change.
//   - Attaching a skill (returns the new binding).
//   - Detaching a skill by binding id.
//
// SCOPE NOTE: INFORMATIONAL ONLY. These bindings are purely visual chips.
// They do NOT affect agent dispatch, do NOT inject into agent context, and
// do NOT alter Sigma/Jorvis tool-calling. Behavioral activation is deferred.

import { useCallback, useEffect, useState } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import type { SkillBinding } from './SkillBindingChip';

interface UseSkillBindingsOptions {
  workspaceId: string | null;
}

export interface UseSkillBindingsResult {
  /** All bindings for the workspace (workspace-wide + all pane-scoped). */
  bindings: SkillBinding[];
  /** Attach a skill. Returns the created (or already-existing) binding. */
  attach: (input: {
    paneSessionId?: string | null;
    skillName: string;
    skillSource: string;
  }) => Promise<SkillBinding | null>;
  /** Detach a binding by id. */
  detach: (bindingId: string) => Promise<void>;
}

export function useSkillBindings({ workspaceId }: UseSkillBindingsOptions): UseSkillBindingsResult {
  const [bindings, setBindings] = useState<SkillBinding[]>([]);

  // Load persisted bindings whenever the active workspace changes.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!workspaceId) {
        setBindings([]);
        return;
      }
      try {
        const rows = await rpc.skills.listBindings({ workspaceId });
        if (alive) {
          setBindings(
            rows.map((r) => ({
              id: r.id,
              skillName: r.skillName,
              skillSource: r.skillSource,
              paneSessionId: r.paneSessionId,
            })),
          );
        }
      } catch {
        // Graceful degradation — bindings are additive and non-critical.
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const attach = useCallback(
    async (input: {
      paneSessionId?: string | null;
      skillName: string;
      skillSource: string;
    }): Promise<SkillBinding | null> => {
      if (!workspaceId) return null;
      try {
        const row = await rpc.skills.attach({
          workspaceId,
          paneSessionId: input.paneSessionId ?? null,
          skillName: input.skillName,
          skillSource: input.skillSource,
        });
        const binding: SkillBinding = {
          id: row.id,
          skillName: row.skillName,
          skillSource: row.skillSource,
          paneSessionId: row.paneSessionId,
        };
        // Upsert: replace existing entry with same id, or add new.
        setBindings((prev) => {
          const idx = prev.findIndex((b) => b.id === binding.id);
          if (idx >= 0) return prev;
          return [...prev, binding];
        });
        return binding;
      } catch {
        return null;
      }
    },
    [workspaceId],
  );

  const detach = useCallback(async (bindingId: string): Promise<void> => {
    try {
      await rpc.skills.detach({ bindingId });
      setBindings((prev) => prev.filter((b) => b.id !== bindingId));
    } catch {
      // Graceful degradation — if the RPC fails, optimistic remove still happened
      // locally; a reload will reconcile.
    }
  }, []);

  return { bindings, attach, detach };
}
