import { useEffect, useMemo, useState } from 'react';
import { Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import type { CreateSwarmInput, Role, RoleAssignment, Swarm, SwarmPreset } from '@/shared/types';
import { PresetPicker } from './PresetPicker';
import { PRESETS } from './preset-data';
import { RoleRoster } from './RoleRoster';

const DEFAULT_PROVIDER_BY_ROLE: Record<Role, string> = {
  coordinator: 'codex',
  builder: 'claude',
  scout: 'gemini',
  reviewer: 'codex',
};

const ROLE_ORDER: Role[] = ['coordinator', 'builder', 'scout', 'reviewer'];

function buildDefaultRoster(preset: SwarmPreset): RoleAssignment[] {
  const meta = PRESETS.find((p) => p.id === preset);
  if (!meta) return [];
  const roster: RoleAssignment[] = [];
  for (const role of ROLE_ORDER) {
    const count = meta.split[role];
    for (let i = 1; i <= count; i++) {
      roster.push({ role, roleIndex: i, providerId: DEFAULT_PROVIDER_BY_ROLE[role] });
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
  const [mission, setMission] = useState('');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<SwarmPreset>('squad');
  const [roster, setRoster] = useState<RoleAssignment[]>(() => buildDefaultRoster('squad'));
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    setRoster(buildDefaultRoster(preset));
  }, [preset]);

  const totalAgents = useMemo(() => roster.length, [roster]);

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
          <div className="text-2xl font-semibold tracking-tight">New Swarm</div>
          <div className="text-sm text-muted-foreground">
            Mission, preset, per-role provider — then launch.
          </div>
        </div>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </header>

      <Card className="flex flex-col gap-3 p-4">
        <div className="text-sm font-medium">1 · Mission</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Optional swarm name"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <textarea
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          placeholder="What should this swarm accomplish?"
          rows={3}
          className="min-h-[80px] w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <div className="text-sm font-medium">2 · Preset</div>
        <PresetPicker value={preset} onChange={setPreset} />
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">3 · Roster ({totalAgents} agents)</div>
        </div>
        <RoleRoster roster={roster} providers={providers} onChange={setRoster} />
      </Card>

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {error ? <span className="text-destructive">{error}</span> : 'Ready when you are.'}
        </div>
        <Button onClick={launch} disabled={creating || !state.activeWorkspace} className="gap-2">
          <Rocket className="h-4 w-4" />
          {creating ? 'Launching…' : `Launch ${totalAgents} agents`}
        </Button>
      </div>
    </div>
  );
}
