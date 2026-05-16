// V3-W12-011 — Swarm wizard 5-step shell.
//
// Steps in order: Roster · Mission · Directory · Context · Name.
// Stepper renders as `STEP <N> of 5 · SWARM ▸`. Step 1 reuses the existing
// roster + preset panel; the remaining steps are stubbed (titled placeholder
// bodies) and will land progressively across W12-W13.

import { useEffect, useMemo, useState } from 'react';
import { Rocket, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import type { CreateSwarmInput, Role, RoleAssignment, Swarm, SwarmPreset } from '@/shared/types';
import { PresetPicker } from './PresetPicker';
import { PRESETS } from './preset-data';
import { RoleRoster } from './RoleRoster';
import { MissionStep } from './MissionStep';
import { SwarmSkillsStep } from './SwarmSkillsStep';
import { flushSkillsToSwarm } from './swarm-skills-data';

const DEFAULT_PROVIDER_BY_ROLE: Record<Role, string> = {
  coordinator: 'codex',
  builder: 'claude',
  scout: 'gemini',
  reviewer: 'codex',
};

const ROLE_ORDER: Role[] = ['coordinator', 'builder', 'scout', 'reviewer'];

const STEPS = [
  { id: 'roster', label: 'Roster' },
  { id: 'mission', label: 'Mission' },
  { id: 'directory', label: 'Directory' },
  { id: 'context', label: 'Context' },
  { id: 'name', label: 'Name' },
] as const;

type StepId = (typeof STEPS)[number]['id'];

function buildDefaultRoster(preset: SwarmPreset): RoleAssignment[] {
  const meta = PRESETS.find((p) => p.id === preset);
  if (!meta) return [];
  const roster: RoleAssignment[] = [];
  for (const role of ROLE_ORDER) {
    const count = meta.split[role];
    for (let i = 1; i <= count; i++) {
      roster.push({
        role,
        roleIndex: i,
        providerId: DEFAULT_PROVIDER_BY_ROLE[role],
        autoApprove: false,
      });
    }
  }
  return roster;
}

interface Props {
  onCreated: (swarm: Swarm) => void;
  onCancel: () => void;
}

export function SwarmCreate({ onCreated, onCancel }: Props) {
  const { state } = useAppState();
  const [stepIdx, setStepIdx] = useState(0);
  const [mission, setMission] = useState('');
  const [name, setName] = useState('');
  // `directoryOverride` is null until the operator types a custom path. The
  // visible field falls back to the active workspace root in that case so we
  // never need a setState-in-effect for the default value.
  const [directoryOverride, setDirectoryOverride] = useState<string | null>(null);
  const [contextNotes, setContextNotes] = useState('');
  // V3-W13-011 — local on/off map for the 12 swarm-skills tiles. We persist
  // the selection only after launch via `flushSkillsToSwarm` so the
  // controller can mirror each tile into `swarm_skills` against a real
  // swarm id. During the wizard the renderer is the source of truth.
  const [skillSelection, setSkillSelection] = useState<Record<string, boolean>>({});
  const [preset, setPreset] = useState<SwarmPreset>('squad');
  const [roster, setRoster] = useState<RoleAssignment[]>(() => buildDefaultRoster('squad'));
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track which preset we last expanded into a roster; setRoster is only
  // called on a real preset change. Setting state in render is allowed because
  // it short-circuits via the prevPreset guard.
  const [lastPreset, setLastPreset] = useState<SwarmPreset>('squad');
  if (preset !== lastPreset) {
    setLastPreset(preset);
    setRoster(buildDefaultRoster(preset));
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await rpc.providers.list();
        if (!alive) return;
        setProviders(list.map((p) => ({ id: p.id, name: p.name })));
      } catch (err) {
        console.error(err);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Derived directory value — no useEffect needed.
  const directory =
    directoryOverride ?? state.activeWorkspace?.rootPath ?? '';

  const totalAgents = useMemo(() => roster.length, [roster]);
  const stepId: StepId = STEPS[stepIdx].id;
  const isLast = stepIdx === STEPS.length - 1;
  const isFirst = stepIdx === 0;

  function next(): void {
    if (!isLast) setStepIdx(stepIdx + 1);
  }
  function back(): void {
    if (!isFirst) setStepIdx(stepIdx - 1);
  }

  async function launch(): Promise<void> {
    const ws = state.activeWorkspace;
    if (!ws) {
      setError('Open a workspace first.');
      return;
    }
    if (!mission.trim()) {
      setError('Mission is required.');
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const input: CreateSwarmInput = {
        workspaceId: ws.id,
        mission: mission.trim(),
        preset,
        name: name.trim() || undefined,
        roster,
      };
      const swarm = await rpc.swarms.create(input);
      // V3-W13-011 — flush skill selection into `swarm_skills` via mailbox
      // mirror. Fire-and-forget; the table defaults to "off" so a partial
      // flush is still consistent with the wizard state.
      void flushSkillsToSwarm(swarm.id, skillSelection).catch(() => undefined);
      onCreated(swarm);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Step {stepIdx + 1} of {STEPS.length} · Swarm ▸
          </div>
          <div className="text-2xl font-semibold tracking-tight">
            New Swarm — {STEPS[stepIdx].label}
          </div>
        </div>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </header>

      {/* Stepper rail. */}
      <div className="flex items-center gap-1 text-xs">
        {STEPS.map((s, i) => {
          const done = i < stepIdx;
          const active = i === stepIdx;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStepIdx(i)}
              className={
                'flex items-center gap-1 rounded-md border px-2 py-1 transition ' +
                (active
                  ? 'border-primary bg-primary/15 text-primary-foreground'
                  : done
                    ? 'border-border bg-card text-foreground'
                    : 'border-border bg-card/40 text-muted-foreground')
              }
            >
              <span className="font-mono text-[10px] opacity-60">{i + 1}</span>
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>

      {/* Per-step body. */}
      {stepId === 'roster' ? (
        <Card className="flex flex-col gap-3 p-4">
          <div className="text-sm font-medium">Roster — preset & per-role provider</div>
          <PresetPicker value={preset} onChange={setPreset} />
          <div className="text-xs text-muted-foreground">
            {totalAgents} agents · {preset}
          </div>
          <RoleRoster
            roster={roster}
            providers={providers}
            onChange={setRoster}
            customCountControls={preset === 'custom'}
          />
        </Card>
      ) : null}

      {stepId === 'mission' ? (
        <MissionStep
          mission={mission}
          onMissionChange={setMission}
          onAdvance={next}
        />
      ) : null}

      {stepId === 'directory' ? (
        <Card className="flex flex-col gap-3 p-4">
          <div className="text-sm font-medium">Directory</div>
          <input
            value={directory}
            onChange={(e) => setDirectoryOverride(e.target.value)}
            placeholder="/Users/you/Code/your-repo"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <div className="text-[11px] text-muted-foreground">
            Defaults to the active workspace root. Folder picker UI lands in W13.
          </div>
        </Card>
      ) : null}

      {stepId === 'context' ? (
        <>
          <Card className="flex flex-col gap-3 p-4">
            <div className="text-sm font-medium">Context files</div>
            <textarea
              value={contextNotes}
              onChange={(e) => setContextNotes(e.target.value)}
              placeholder="One path per line. Files attached here are surfaced to every agent at launch."
              rows={6}
              className="min-h-[140px] w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <div className="text-[11px] text-muted-foreground">
              Drag-drop staging lands with Sigma Canvas (V3-W14).
            </div>
          </Card>
          {/* V3-W13-011 — Swarm Skills grid persists via `swarm_skills`. */}
          <SwarmSkillsStep
            selected={skillSelection}
            onChange={setSkillSelection}
            swarmId={null}
          />
        </>
      ) : null}

      {stepId === 'name' ? (
        <Card className="flex flex-col gap-3 p-4">
          <div className="text-sm font-medium">Name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional swarm name (defaults to mission)"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <div className="text-[11px] text-muted-foreground">
            {name.trim()
              ? `Will launch as "${name.trim()}".`
              : 'Auto-generated from the first 64 chars of the mission.'}
          </div>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {error ? <span className="text-destructive">{error}</span> : 'Ready when you are.'}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onCancel} className="gap-1">
            Cancel
          </Button>
          <Button variant="outline" onClick={back} disabled={isFirst} className="gap-1">
            <ChevronLeft className="h-4 w-4" /> Back
          </Button>
          {isLast ? (
            <Button
              onClick={launch}
              disabled={creating || !state.activeWorkspace}
              className="gap-2"
            >
              <Rocket className="h-4 w-4" />
              {creating ? 'Launching…' : `Launch ${totalAgents} agents`}
            </Button>
          ) : (
            <Button onClick={next} className="gap-1">
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
