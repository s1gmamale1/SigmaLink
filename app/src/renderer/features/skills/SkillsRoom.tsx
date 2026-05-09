// Phase 4 Skills room. Drop SKILL.md folders, see them validated + listed,
// toggle which providers receive each skill.

import { useCallback, useMemo, useState } from 'react';
import { Wand2 } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';
import type { Skill, SkillProviderId } from '@/shared/types';
import { DropZone } from './DropZone';
import { SkillCard } from './SkillCard';
import { SkillDetailModal } from './SkillDetailModal';

export function SkillsRoom() {
  const { state, dispatch } = useAppState();
  const [error, setError] = useState<string | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState<{ path: string; name: string } | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [detailSkill, setDetailSkill] = useState<Skill | null>(null);

  const skillProviderStates = state.skillProviderStates;
  const statesBySkill = useMemo(() => {
    const map: Record<string, typeof skillProviderStates> = {};
    for (const s of skillProviderStates) {
      const list = map[s.skillId] ?? [];
      list.push(s);
      map[s.skillId] = list;
    }
    return map;
  }, [skillProviderStates]);

  const refresh = useCallback(async () => {
    try {
      const list = await rpc.skills.list();
      dispatch({ type: 'SET_SKILLS', skills: list.skills, states: list.states });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [dispatch]);

  const handleFolderDetected = useCallback(
    async (skillRootAbsPath: string, force = false) => {
      setError(null);
      setUpdatePrompt(null);
      setInstallBusy(true);
      try {
        const skill = await rpc.skills.ingestFolder({ path: skillRootAbsPath, force });
        await refresh();
        // Open the detail modal so the user can inspect what just installed.
        setDetailSkill(skill);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Surface the structured "UPDATE_REQUIRED:<name>:<hash>" so the user
        // can opt into overwrite.
        if (message.startsWith('Error: UPDATE_REQUIRED:') || message.includes('UPDATE_REQUIRED:')) {
          const match = /UPDATE_REQUIRED:([^:]+):/.exec(message);
          if (match) {
            setUpdatePrompt({ path: skillRootAbsPath, name: match[1] });
          } else {
            setError(message);
          }
        } else {
          setError(message);
        }
      } finally {
        setInstallBusy(false);
      }
    },
    [refresh],
  );

  const handleToggle = useCallback(
    async (skill: Skill, provider: SkillProviderId, enable: boolean) => {
      const key = `${skill.id}:${provider}`;
      dispatch({ type: 'SKILLS_BUSY', key, busy: true });
      try {
        if (enable) {
          await rpc.skills.enableForProvider({ skillId: skill.id, provider });
        } else {
          await rpc.skills.disableForProvider({ skillId: skill.id, provider });
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        dispatch({ type: 'SKILLS_BUSY', key, busy: false });
      }
    },
    [dispatch, refresh],
  );

  const handleUninstall = useCallback(
    async (skill: Skill) => {
      const key = `uninstall:${skill.id}`;
      dispatch({ type: 'SKILLS_BUSY', key, busy: true });
      try {
        await rpc.skills.uninstall(skill.id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        dispatch({ type: 'SKILLS_BUSY', key, busy: false });
      }
    },
    [dispatch, refresh],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wand2 className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">Skills</h1>
            <p className="text-xs text-muted-foreground">
              Install Anthropic-format SKILL.md bundles. Toggle which providers receive each skill.
            </p>
          </div>
        </div>
      </header>

      <DropZone
        busy={installBusy}
        onFolderDetected={(p) => void handleFolderDetected(p, false)}
        onError={(msg) => setError(msg)}
      />

      {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}

      {updatePrompt ? (
        <div className="flex items-center justify-between rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          <span>
            A skill named <span className="font-mono">{updatePrompt.name}</span> is already installed with
            different content. Update it?
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const target = updatePrompt;
                setUpdatePrompt(null);
                if (target) void handleFolderDetected(target.path, true);
              }}
              className="rounded-md border border-amber-300/40 bg-amber-300/10 px-3 py-1 text-xs hover:bg-amber-300/20"
            >
              Update
            </button>
            <button
              type="button"
              onClick={() => setUpdatePrompt(null)}
              className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted/40"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 overflow-y-auto pb-6 lg:grid-cols-2">
        {state.skills.length === 0 ? (
          <div className="col-span-full">
            <EmptyState
              icon={Wand2}
              title="No skills installed yet"
              description="Drop a SKILL.md folder above to install your first skill."
            />
          </div>
        ) : (
          state.skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              states={statesBySkill[skill.id] ?? []}
              busyKeys={state.skillsBusy}
              onToggleProvider={(s, p, enable) => void handleToggle(s, p, enable)}
              onUninstall={(s) => void handleUninstall(s)}
              onOpenDetail={(s) => setDetailSkill(s)}
            />
          ))
        )}
      </div>

      <SkillDetailModal skill={detailSkill} onClose={() => setDetailSkill(null)} />
    </div>
  );
}
