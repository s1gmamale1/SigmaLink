// Step 3: provider matrix.
//
// v1.2.4 final order: Claude | Codex | Gemini | Kimi | OpenCode | Custom
// Command. Each row exposes a `−/+` counter; a running total at the top
// reads `<used>/<N>`. Three quick-fill buttons:
//
//   • Enable all     — distribute panes evenly across every non-coming-soon
//                      provider (best-effort fallback for the user's pane
//                      count).
//   • One of each    — drop a single agent on each provider until panes run
//                      out; *skips* `comingSoon` rows per acceptance.
//   • Split evenly   — explicit alias of Enable all; kept as a separate
//                      verb because the V3 wizard lists both.
//
// "Skip — no agents / Open without AI" lives below the matrix and zeroes
// the counts so the launcher spawns plain Shell panes.

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AGENT_PROVIDERS, type AgentProviderDefinition } from '@/shared/providers';
import type { ProviderProbe } from '@/shared/types';
import { listModelsFor, providerAcceptsModelFlag } from '@/shared/model-catalog';
import { ProviderInstallModal } from './ProviderInstallModal';

// v1.2.4 matrix order. `custom` is a renderer-only "Custom Command" row that
// falls back to the internal shell sentinel at launch time.
const MATRIX_ORDER: string[] = [
  'claude',
  'codex',
  'gemini',
  'kimi',
  'opencode',
  'custom',
];

interface MatrixRow {
  id: string;
  name: string;
  description: string;
  comingSoon: boolean;
  installHint: string;
  found: boolean | null;
}

function buildRows(probes: Map<string, ProviderProbe>): MatrixRow[] {
  return MATRIX_ORDER.map((id): MatrixRow => {
    const def = AGENT_PROVIDERS.find((p) => p.id === id);
    if (def) return rowFromDef(def, probes);
    // Synthesise a row for ids that are not yet in the registry. These are
    // stubs that fall back to Custom Command at launch time. The user still
    // sees the row so the V3 matrix is faithful to the frame log.
    return synthRow(id);
  });
}

function rowFromDef(
  def: AgentProviderDefinition,
  probes: Map<string, ProviderProbe>,
): MatrixRow {
  const probe = probes.get(def.id);
  return {
    id: def.id,
    name: def.id === 'custom' ? 'Custom Command' : def.name,
    description: def.description,
    comingSoon: !!def.comingSoon,
    installHint: def.installHint,
    found: probe ? probe.found : null,
  };
}

// Stubs for ids that aren't in the shared registry. `custom` is a freeform
// shell command row; the launcher routes it through the internal shell
// sentinel at spawn time. Kept as a small lookup so we don't duplicate the
// row shape.
const STUBS: Record<string, Omit<MatrixRow, 'found'>> = {
  custom: {
    id: 'custom',
    name: 'Custom Command',
    description: 'Run any shell command as an agent.',
    comingSoon: false,
    installHint: 'Provide an absolute path or command on PATH.',
  },
};

function synthRow(id: string): MatrixRow {
  const stub = STUBS[id];
  if (stub) return { ...stub, found: null };
  return { id, name: id, description: '', comingSoon: false, installHint: '', found: null };
}

interface AgentsStepProps {
  totalPanes: number;
  /** Map of providerId → count chosen for that row. Sums must equal totalPanes
   *  for the launch CTA to be enabled (when not in skip-mode). */
  counts: Record<string, number>;
  onCountsChange: (next: Record<string, number>) => void;
  skipAgents: boolean;
  onSkipChange: (skip: boolean) => void;
  probes: ProviderProbe[];
  /**
   * FEAT-14 — per-provider model selected at launch. Key = providerId, value =
   * modelId. Only providers whose CLI accepts `--model` render a dropdown
   * (claude / cursor / gemini); the launcher threads the choice into each
   * pane's `--model` flag. Optional so legacy callers / tests need not supply.
   */
  models?: Record<string, string>;
  onModelsChange?: (next: Record<string, string>) => void;
}

export function AgentsStep({
  totalPanes,
  counts,
  onCountsChange,
  skipAgents,
  onSkipChange,
  probes,
  models = {},
  onModelsChange,
}: AgentsStepProps) {
  const probeMap = useMemo(() => new Map(probes.map((p) => [p.id, p])), [probes]);
  const rows = useMemo(() => buildRows(probeMap), [probeMap]);

  // v1.4.9-06 — install modal state; null = closed, string = open for that provider
  const [installModalId, setInstallModalId] = useState<string | null>(null);

  const used = Object.values(counts).reduce((a, b) => a + b, 0);
  const remaining = totalPanes - used;

  function setRowCount(id: string, value: number) {
    const next = { ...counts };
    if (value <= 0) delete next[id];
    else next[id] = value;
    onCountsChange(next);
  }

  // FEAT-14 — set (or clear via the empty "Default" option) a row's model.
  function setRowModel(id: string, modelId: string) {
    if (!onModelsChange) return;
    const next = { ...models };
    if (modelId) next[id] = modelId;
    else delete next[id];
    onModelsChange(next);
  }

  function fillEvenly() {
    const eligible = rows.filter((r) => !r.comingSoon);
    if (eligible.length === 0 || totalPanes === 0) return;
    const base = Math.floor(totalPanes / eligible.length);
    const extra = totalPanes - base * eligible.length;
    const next: Record<string, number> = {};
    eligible.forEach((r, i) => {
      const v = base + (i < extra ? 1 : 0);
      if (v > 0) next[r.id] = v;
    });
    onCountsChange(next);
  }

  function oneOfEach() {
    // Skip comingSoon rows per V3-W12-004 acceptance. Cap at totalPanes so we
    // never overflow.
    const eligible = rows.filter((r) => !r.comingSoon).slice(0, totalPanes);
    const next: Record<string, number> = {};
    for (const r of eligible) next[r.id] = 1;
    onCountsChange(next);
  }

  function clearAll() {
    onCountsChange({});
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Agents per provider
        </div>
        <div className="text-xs text-muted-foreground">
          <span
            className={cn(
              'font-mono font-medium',
              remaining < 0 ? 'text-destructive' : 'text-foreground',
            )}
          >
            {used}/{totalPanes}
          </span>{' '}
          assigned
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={fillEvenly} disabled={skipAgents}>
          Enable all
        </Button>
        <Button size="sm" variant="outline" onClick={oneOfEach} disabled={skipAgents}>
          One of each
        </Button>
        <Button size="sm" variant="outline" onClick={fillEvenly} disabled={skipAgents}>
          Split evenly
        </Button>
        <Button size="sm" variant="ghost" onClick={clearAll} disabled={skipAgents}>
          Clear
        </Button>
      </div>

      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const count = counts[row.id] ?? 0;
          const disabled = skipAgents;
          return (
            <li
              key={row.id}
              className={cn(
                'flex items-center gap-3 rounded-md border border-border bg-card/40 px-3 py-2 transition',
                disabled && 'opacity-50',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{row.name}</span>
                  {row.comingSoon ? (
                    <span className="rounded-sm bg-accent/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-accent-foreground">
                      Soon
                    </span>
                  ) : null}
                  {row.found === false && !row.comingSoon && row.id !== 'custom' ? (
                    <button
                      type="button"
                      onClick={() => setInstallModalId(row.id)}
                      className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-500 hover:bg-amber-500/25"
                    >
                      Not on PATH
                    </button>
                  ) : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {row.description}
                </div>
              </div>
              <ModelSelect
                providerId={row.id}
                value={models[row.id] ?? ''}
                disabled={disabled || !onModelsChange}
                onChange={(modelId) => setRowModel(row.id, modelId)}
              />
              <CounterControls
                value={count}
                disabled={disabled}
                max={totalPanes}
                onChange={(v) => setRowCount(row.id, v)}
              />
            </li>
          );
        })}
        <li className="flex items-center justify-end pt-1">
          <button
            type="button"
            className="text-xs text-muted-foreground transition hover:text-foreground"
            onClick={() => {
              // Stub — V3 frame 0055 shows a `+ Add custom command` link below
              // the matrix. Wiring the modal lands in a follow-up wave.
            }}
          >
            + Add custom command
          </button>
        </li>
      </ul>

      <label className="flex items-center gap-2 rounded-md border border-dashed border-border bg-card/20 px-3 py-2 text-sm">
        <input
          type="checkbox"
          checked={skipAgents}
          onChange={(e) => onSkipChange(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        <span className="font-medium">Skip — no agents</span>
        <span className="text-xs text-muted-foreground">
          Open without AI — panes spawn plain interactive shells.
        </span>
      </label>

      {/* v1.4.9-06 — provider install modal */}
      {installModalId ? (
        <ProviderInstallModal
          providerId={installModalId}
          onClose={() => setInstallModalId(null)}
        />
      ) : null}
    </div>
  );
}

interface ModelSelectProps {
  providerId: string;
  value: string;
  disabled?: boolean;
  onChange: (modelId: string) => void;
}

// FEAT-14 — per-row model dropdown. Renders ONLY for providers whose CLI
// accepts a `--model` flag (claude / cursor / gemini per the shared catalog);
// codex / kimi / opencode / custom render nothing so the row layout is
// unchanged for them. A calm `bg-background` surface (NOT `bg-accent` — see
// the v1.36 purple-flash lesson) keeps the control visually quiet. The empty
// value maps to "Default" (the launcher omits `--model`, so the CLI default
// applies).
function ModelSelect({ providerId, value, disabled, onChange }: ModelSelectProps) {
  if (!providerAcceptsModelFlag(providerId)) return null;
  const options = listModelsFor(providerId);
  if (options.length === 0) return null;
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      aria-label={`Model for ${providerId}`}
      className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground transition hover:border-ring/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
    >
      <option value="">Default</option>
      {options.map((m) => (
        <option key={m.modelId} value={m.modelId}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

interface CounterControlsProps {
  value: number;
  max: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}

function CounterControls({ value, max, disabled, onChange }: CounterControlsProps) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={disabled || value <= 0}
        onClick={() => onChange(Math.max(0, value - 1))}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/60 text-sm transition hover:bg-card disabled:opacity-30"
        aria-label="Decrement"
      >
        −
      </button>
      <span className="w-6 text-center font-mono text-sm tabular-nums">{value}</span>
      <button
        type="button"
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/60 text-sm transition hover:bg-card disabled:opacity-30"
        aria-label="Increment"
      >
        +
      </button>
    </div>
  );
}
