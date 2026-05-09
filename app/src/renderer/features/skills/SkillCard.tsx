// One installed skill rendered as a card. Provides per-provider checkboxes,
// an Uninstall affordance, and an "Open" button to view the SKILL.md body.

import { useMemo } from 'react';
import { AlertTriangle, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { Skill, SkillProviderId, SkillProviderState } from '@/shared/types';

const PROVIDER_LABELS: Record<SkillProviderId, { name: string; chip: string }> = {
  claude: { name: 'Claude Code', chip: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
  codex: { name: 'Codex', chip: 'bg-green-500/15 text-green-300 border-green-500/30' },
  gemini: { name: 'Gemini', chip: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
};

const PROVIDER_ORDER: SkillProviderId[] = ['claude', 'codex', 'gemini'];

export interface SkillCardProps {
  skill: Skill;
  states: SkillProviderState[];
  busyKeys: Record<string, boolean>;
  onToggleProvider: (skill: Skill, provider: SkillProviderId, enable: boolean) => void;
  onUninstall: (skill: Skill) => void;
  onOpenDetail: (skill: Skill) => void;
}

export function SkillCard({
  skill,
  states,
  busyKeys,
  onToggleProvider,
  onUninstall,
  onOpenDetail,
}: SkillCardProps) {
  const stateByProvider = useMemo(() => {
    const map: Partial<Record<SkillProviderId, SkillProviderState>> = {};
    for (const s of states) map[s.providerId] = s;
    return map;
  }, [states]);

  const installedAt = useMemo(() => {
    try {
      return new Date(skill.installedAt).toLocaleString();
    } catch {
      return '';
    }
  }, [skill.installedAt]);

  const uninstallBusy = !!busyKeys[`uninstall:${skill.id}`];

  return (
    <div className="flex w-full flex-col gap-3 rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-foreground">{skill.name}</div>
            {skill.version ? (
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                v{skill.version}
              </span>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={skill.description}>
            {skill.description}
          </p>
          {skill.tags && skill.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {skill.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {t}
                </span>
              ))}
            </div>
          ) : null}
          {installedAt ? (
            <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Installed {installedAt}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenDetail(skill)}
            title="View SKILL.md"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onUninstall(skill)}
            disabled={uninstallBusy}
            title="Uninstall skill"
          >
            {uninstallBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        {PROVIDER_ORDER.map((provider) => {
          const meta = PROVIDER_LABELS[provider];
          const state = stateByProvider[provider];
          const enabled = !!state?.enabled;
          const busyKey = `${skill.id}:${provider}`;
          const busy = !!busyKeys[busyKey];
          const error = state?.lastError;
          return (
            <label
              key={provider}
              className={cn(
                'flex items-center gap-2 rounded-md border px-2 py-1 text-xs',
                meta.chip,
                error && 'border-destructive/60 text-destructive',
              )}
            >
              <Checkbox
                checked={enabled}
                disabled={busy}
                onCheckedChange={(value) => onToggleProvider(skill, provider, value === true)}
              />
              <span className="font-medium">{meta.name}</span>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {error && !busy ? (
                <span title={error} className="flex items-center gap-1 text-destructive">
                  <AlertTriangle className="h-3 w-3" />
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}
