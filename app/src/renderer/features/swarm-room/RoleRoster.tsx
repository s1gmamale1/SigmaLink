// V3-W12-010 / V3-W12-012 / V3-W12-018 — V3 role roster.
//
// Each role row carries:
//   - A coloured stripe driven by the per-theme `--role-<role>` token.
//   - 9-provider chip strip in V3 order
//     (BridgeCode | Claude | Codex | Gemini | OpenCode | Cursor | Droid |
//      Copilot | Custom Command).
//   - Model dropdown next to the provider strip.
//   - `Auto` chip (autoApprove) — wired via `swarm.update-agent` (channel
//     lands in V3-W12-014 once foundations adds it to the allowlist).
//   - Count -/+ controls (operator can scale a role on a Custom roster).
//
// Above the rows, a global "CLI agent for all" provider strip (V3-W12-012)
// flips every row's provider in one click. Coming-soon providers render
// disabled per V3-W12-001 semantics.

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { Role, RoleAssignment, SwarmAgent } from '@/shared/types';
import { CUSTOM_ROSTER_CAP } from './preset-data';
// V3-W15-005 — Plan-gated custom roster cap. Ultra (SigmaLink default) =
// CUSTOM_ROSTER_CAP (20); Pro = 15; Basic = 5. The min() guarantees we never
// exceed the schema-level CHECK constraint even if a future tier raises the
// matrix value.
import { useCanDo } from '@/renderer/lib/canDo';

const ROLE_LABEL: Record<Role, string> = {
  coordinator: 'Coordinator',
  builder: 'Builder',
  scout: 'Scout',
  reviewer: 'Reviewer',
};

/** Tailwind class names for each role colour stripe / pill / text. */
const ROLE_STRIPE: Record<Role, string> = {
  coordinator: 'bg-role-coordinator',
  builder: 'bg-role-builder',
  scout: 'bg-role-scout',
  reviewer: 'bg-role-reviewer',
};

const ROLE_TEXT: Record<Role, string> = {
  coordinator: 'text-role-coordinator',
  builder: 'text-role-builder',
  scout: 'text-role-scout',
  reviewer: 'text-role-reviewer',
};

const ROLE_BORDER: Record<Role, string> = {
  coordinator: 'border-role-coordinator',
  builder: 'border-role-builder',
  scout: 'border-role-scout',
  reviewer: 'border-role-reviewer',
};

/**
 * V3 provider matrix order. The label "Custom Command" maps to providerId
 * `custom`. Coming-soon providers (BridgeCode) render disabled but selectable
 * per V3-W12-001 fallback semantics.
 */
const V3_PROVIDER_ORDER: Array<{ id: string; label: string; comingSoon?: boolean }> = [
  { id: 'bridgecode', label: 'BridgeCode', comingSoon: true },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'droid', label: 'Droid' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'custom', label: 'Custom Command' },
];

/** Default model id per provider — stub until models.ts surfaces via RPC. */
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  claude: 'claude-opus-4-7',
  codex: 'gpt-5.4',
  gemini: 'gemini-2.5-pro',
  opencode: 'opencode-default',
  bridgecode: 'bridgecode-default',
  cursor: 'cursor-default',
  droid: 'droid-default',
  copilot: 'copilot-default',
  custom: 'custom-default',
};

interface ProviderOption {
  id: string;
  name: string;
}

interface Props {
  roster: RoleAssignment[];
  /** Provider list from `providers.list`; used as the union with V3 order. */
  providers: ProviderOption[];
  onChange: (next: RoleAssignment[]) => void;
  readOnly?: boolean;
  liveAgents?: SwarmAgent[];
  messageCounts?: Record<string, number>;
  /** When true, render Custom +/- controls under each role group. */
  customCountControls?: boolean;
}

export function RoleRoster({
  roster,
  providers,
  onChange,
  readOnly,
  liveAgents,
  messageCounts,
  customCountControls,
}: Props) {
  // V3-W15-005 — Tier-aware roster cap. Ultra (default) = 20, matching the
  // existing CUSTOM_ROSTER_CAP and the swarms.preset CHECK constraint. The
  // min() prevents a future Ultra-bump from exceeding the schema cap.
  const tierCap = useCanDo<number>('swarm.maxSize');
  const rosterCap = Math.min(CUSTOM_ROSTER_CAP, tierCap);
  // Build the visible provider strip: keep V3 order, but only enable rows that
  // exist in the registry (`providers` list from RPC). Unknown ids stay
  // disabled so the strip still renders 9 chips even if a binary is absent.
  const providerStrip = useMemo(() => {
    const known = new Set(providers.map((p) => p.id));
    return V3_PROVIDER_ORDER.map((p) => ({
      ...p,
      installed: known.has(p.id),
    }));
  }, [providers]);

  function setAllProviders(providerId: string): void {
    if (readOnly) return;
    const next = roster.map((r) => ({
      ...r,
      providerId,
      modelId: DEFAULT_MODEL_BY_PROVIDER[providerId] ?? r.modelId,
    }));
    onChange(next);
  }

  function setRowProvider(idx: number, providerId: string): void {
    if (readOnly) return;
    const next = roster.map((r, i) =>
      i === idx
        ? {
            ...r,
            providerId,
            modelId: DEFAULT_MODEL_BY_PROVIDER[providerId] ?? r.modelId,
          }
        : r,
    );
    onChange(next);
  }

  function setRowModel(idx: number, modelId: string): void {
    if (readOnly) return;
    const next = roster.map((r, i) => (i === idx ? { ...r, modelId } : r));
    onChange(next);
  }

  function toggleAutoApprove(idx: number): void {
    if (readOnly) return;
    const next = roster.map((r, i) =>
      i === idx ? { ...r, autoApprove: !r.autoApprove } : r,
    );
    onChange(next);
  }

  function addRoleRow(role: Role): void {
    if (readOnly) return;
    if (roster.length >= rosterCap) return;
    const used = roster.filter((r) => r.role === role);
    const nextIndex = used.length === 0 ? 1 : Math.max(...used.map((r) => r.roleIndex)) + 1;
    const providerId = used[0]?.providerId ?? 'claude';
    onChange([
      ...roster,
      {
        role,
        roleIndex: nextIndex,
        providerId,
        modelId: DEFAULT_MODEL_BY_PROVIDER[providerId],
        autoApprove: false,
      },
    ]);
  }

  function removeRoleRow(role: Role): void {
    if (readOnly) return;
    const used = roster
      .map((r, i) => ({ row: r, idx: i }))
      .filter((x) => x.row.role === role);
    if (used.length === 0) return;
    const lastIdx = used[used.length - 1].idx;
    onChange(roster.filter((_, i) => i !== lastIdx));
  }

  return (
    <div className="flex flex-col gap-3">
      {/* V3-W12-012 — global "CLI-agent-for-all" provider strip. */}
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/40 p-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            CLI agent for all
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {providerStrip.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setAllProviders(p.id)}
                disabled={!p.installed && !p.comingSoon}
                className={cn(
                  'rounded-md border border-border bg-background px-2 py-1 text-[11px] transition',
                  'hover:bg-card disabled:opacity-40 disabled:hover:bg-background',
                )}
                title={p.comingSoon ? 'Coming soon — falls back to Claude.' : p.label}
              >
                {p.label}
                {p.comingSoon ? (
                  <span className="ml-1 text-[9px] uppercase opacity-60">soon</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Custom-roster +/- controls per role. */}
      {customCountControls && !readOnly ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/40 p-2 text-[11px]">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Roster
          </span>
          {(['coordinator', 'builder', 'scout', 'reviewer'] as Role[]).map((role) => {
            const count = roster.filter((r) => r.role === role).length;
            return (
              <div key={role} className="flex items-center gap-1">
                <span
                  aria-hidden
                  className={cn('h-2 w-2 rounded-full', ROLE_STRIPE[role])}
                />
                <span className={cn('text-xs font-medium', ROLE_TEXT[role])}>
                  {ROLE_LABEL[role]}
                </span>
                <button
                  type="button"
                  onClick={() => removeRoleRow(role)}
                  disabled={count === 0}
                  className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] disabled:opacity-30"
                >
                  −
                </button>
                <span className="w-5 text-center tabular-nums">{count}</span>
                <button
                  type="button"
                  onClick={() => addRoleRow(role)}
                  disabled={roster.length >= rosterCap}
                  className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] disabled:opacity-30"
                >
                  +
                </button>
              </div>
            );
          })}
          <span className="ml-auto text-[10px] text-muted-foreground">
            {roster.length}/{rosterCap}
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {roster.map((row, idx) => {
          const live = liveAgents?.find(
            (a) => a.role === row.role && a.roleIndex === row.roleIndex,
          );
          const agentKey = `${row.role}-${row.roleIndex}`;
          const status = live?.status ?? 'idle';
          const dot =
            status === 'error'
              ? '#ef4444'
              : status === 'busy'
                ? '#22c55e'
                : status === 'blocked'
                  ? '#f59e0b'
                  : status === 'done'
                    ? '#0ea5e9'
                    : '#71717a';
          const modelId = row.modelId ?? DEFAULT_MODEL_BY_PROVIDER[row.providerId];
          const autoApprove = row.autoApprove ?? false;
          return (
            <div
              key={`${row.role}-${row.roleIndex}`}
              className={cn(
                'relative flex flex-col gap-2 overflow-hidden rounded-lg border bg-card/60 p-3',
                ROLE_BORDER[row.role],
              )}
            >
              {/* Left colour stripe — V3 frame 0205. */}
              <span
                aria-hidden
                className={cn(
                  'absolute left-0 top-0 h-full w-1',
                  ROLE_STRIPE[row.role],
                )}
              />
              <div className="ml-2 flex items-center gap-2">
                <div className={cn('text-sm font-medium', ROLE_TEXT[row.role])}>
                  {ROLE_LABEL[row.role]} {row.roleIndex}
                </div>
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => toggleAutoApprove(idx)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider transition',
                    autoApprove
                      ? 'border-primary bg-primary/20 text-primary-foreground'
                      : 'border-border bg-background text-muted-foreground hover:bg-card',
                  )}
                  title="Auto-approve actions for this row"
                >
                  Auto
                </button>
                <div className="ml-auto flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
                  {status}
                </div>
              </div>

              {/* Provider chip strip + model dropdown. */}
              <div className="ml-2 flex flex-wrap items-center gap-1">
                {providerStrip.map((p) => {
                  const active = row.providerId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={readOnly || (!p.installed && !p.comingSoon)}
                      onClick={() => setRowProvider(idx, p.id)}
                      className={cn(
                        'rounded-md border px-1.5 py-0.5 text-[10px] transition',
                        active
                          ? 'border-primary bg-primary/15 text-primary-foreground'
                          : 'border-border bg-background text-muted-foreground hover:bg-card',
                        !p.installed && !p.comingSoon && 'opacity-40',
                      )}
                      title={p.comingSoon ? 'Coming soon' : p.label}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>

              <label className="ml-2 flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Model</span>
                <select
                  value={modelId ?? ''}
                  disabled={readOnly}
                  onChange={(e) => setRowModel(idx, e.target.value)}
                  className="ml-auto rounded-md border border-border bg-background px-2 py-1 text-xs"
                >
                  <option value={modelId ?? ''}>
                    {modelId ?? 'default'}
                  </option>
                </select>
              </label>

              <div className="ml-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span title="Mailbox identifier">{agentKey}</span>
                {messageCounts ? (
                  <span>{messageCounts[agentKey] ?? 0} msgs</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
