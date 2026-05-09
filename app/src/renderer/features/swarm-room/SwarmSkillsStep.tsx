// V3-W13-011 — Swarm Skills 12-tile grid with on/off pills.
//
// Source: frames 0210, 0220 (groups WORKFLOW / QUALITY / OPS / ANALYSIS).
//
// This step is rendered while creating a swarm AND remains addressable
// during a running swarm via the same mailbox kind. We emit a `skill_toggle`
// envelope (declared in W12; verified in core/swarms/types.ts) on every
// flip; the controller persists the state into `swarm_skills` via migration
// 0004 — but during creation, the swarm row doesn't exist yet, so we keep
// state locally in `selected` and the parent flushes it post-launch via
// `flushSkillsToSwarm` (see swarm-skills-data.ts).
//
// Only the React component is exported from this file so Fast Refresh
// stays happy; constants + helpers live in `swarm-skills-data.ts`.

import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { rpc } from '@/renderer/lib/rpc';
import {
  GROUP_LABEL,
  GROUP_ORDER,
  SKILL_TILES,
  type SkillGroup,
  type SkillTile,
} from './swarm-skills-data';

interface Props {
  /**
   * Map of skillKey → on. The parent owns the source of truth so it can
   * flush the toggles into the swarm post-launch (when no swarmId exists
   * yet) — see SwarmCreate.tsx for the post-launch flush.
   */
  selected: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
  /**
   * When set, every toggle is dispatched immediately as a `skill_toggle`
   * envelope into the running swarm's mailbox. During wizard creation this
   * is `null` and the parent flushes after launch.
   */
  swarmId: string | null;
}

export function SwarmSkillsStep({ selected, onChange, swarmId }: Props) {
  const grouped = useMemo(() => {
    const out: Record<SkillGroup, SkillTile[]> = {
      workflow: [],
      quality: [],
      ops: [],
      analysis: [],
    };
    for (const t of SKILL_TILES) out[t.group].push(t);
    return out;
  }, []);

  function toggle(tile: SkillTile, on: boolean): void {
    const next = { ...selected, [tile.key]: on };
    onChange(next);
    if (!swarmId) return;
    // Fire-and-forget — the controller persists into swarm_skills and other
    // agents pick the new state up via mailbox tail. Error toasting is
    // handled centrally in `rpc`.
    void rpc.swarms
      .sendMessage({
        swarmId,
        toAgent: '@coordinators',
        kind: 'skill_toggle',
        body: `${tile.key}=${on ? 'on' : 'off'}`,
        payload: { skillKey: tile.key, on, group: tile.group },
      })
      .catch(() => {
        /* swallow — toast already shown */
      });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium">Swarm Skills</div>
        <div className="text-[11px] text-muted-foreground">
          12 tiles · {Object.values(selected).filter(Boolean).length} on
        </div>
      </div>

      {GROUP_ORDER.map((group) => {
        const tiles = grouped[group];
        if (tiles.length === 0) return null;
        return (
          <section key={group} className="flex flex-col gap-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {GROUP_LABEL[group]}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {tiles.map((tile) => {
                const on = Boolean(selected[tile.key]);
                return (
                  <label
                    key={tile.key}
                    data-testid={`skill-tile-${tile.key}`}
                    className={
                      'flex cursor-pointer flex-col gap-1 rounded-md border bg-card p-3 transition ' +
                      (on
                        ? 'border-primary shadow-[0_0_0_1px_var(--primary)]'
                        : 'border-border hover:border-muted-foreground/40')
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{tile.title}</span>
                      <Switch
                        checked={on}
                        onCheckedChange={(v) => toggle(tile, Boolean(v))}
                        aria-label={`${tile.title} ${on ? 'on' : 'off'}`}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground">{tile.description}</span>
                  </label>
                );
              })}
            </div>
          </section>
        );
      })}
    </Card>
  );
}
