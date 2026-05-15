// Workspace launcher orchestrator. Wave 12 (V3-W12-004/005/006/007 +
// BUG-W7-015) splits the chrome across PickerCards / Stepper /
// StartStep / LayoutStep / AgentsStep. BUG-W7-001 is preserved:
// `state.activeWorkspace` is the single source of truth.

import { useEffect, useMemo, useState } from 'react';
import { Play, Plus, Settings as SettingsIcon, SplitSquareHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';
import type { GridPreset, LaunchPlan, ProviderProbe, Workspace } from '@/shared/types';
import { PickerCards, type LauncherMode } from './PickerCards';
import { Stepper, type StepId } from './Stepper';
import { StartStep } from './StartStep';
import { LayoutStep } from './LayoutStep';
import { AgentsStep } from './AgentsStep';
import { SessionStep, fetchLastResumePlan } from './SessionStep';
import type { PaneRow } from './SessionStep';
import { gridLabel } from './grid';
import { AGENT_PROVIDERS } from '@/shared/providers';

/**
 * v1.3.1 — Build the top-level `paneResumePlan` array that the backend
 * (`executeLaunchPlan`) reads. Bug B fix: v1.3.0 emitted `sessionId` per-pane
 * only, so `plan.paneResumePlan` was always undefined → resume args were
 * never injected → every pane spawned fresh.
 *
 * Returns an array of `{ paneIndex, sessionId }` entries for panes the user
 * explicitly picked a non-null sessionId for. Panes the user left at "New
 * session" (null) are omitted so the launcher's `find()` returns undefined
 * and the pane spawns fresh.
 *
 * Exported for unit testing (Launcher.test.tsx). The eslint disable is the
 * same pattern used by SessionStep.tsx for `fetchLastResumePlan` — Vite's
 * fast-refresh contract only fires on component exports, and this helper is
 * pure so HMR is not impacted in practice.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function buildPaneResumePlanArray(
  paneCount: number,
  selections: Record<number, string | null>,
): Array<{ paneIndex: number; sessionId: string | null }> {
  const out: Array<{ paneIndex: number; sessionId: string | null }> = [];
  for (let i = 0; i < paneCount; i++) {
    const picked = selections[i];
    if (picked !== undefined && picked !== null) {
      out.push({ paneIndex: i, sessionId: picked });
    }
  }
  return out;
}

/**
 * v1.3.0 — Convert {providerId: count} + skipAgents flag into a flat ordered
 * list of PaneRow values matching the pane grid layout. Used by SessionStep to
 * render one row per pane with the correct provider name + dot colour.
 */
function buildPaneRows(
  counts: Record<string, number>,
  skipAgents: boolean,
  preset: GridPreset,
): PaneRow[] {
  const rows: PaneRow[] = [];
  if (skipAgents) {
    // All panes are plain shells — render them as "Shell" rows.
    for (let i = 0; i < preset; i++) {
      rows.push({ paneIndex: i, providerId: 'shell', providerName: 'Shell' });
    }
    return rows;
  }
  for (const [providerId, n] of Object.entries(counts)) {
    const id = providerId === 'custom' ? 'shell' : providerId;
    const def = AGENT_PROVIDERS.find((p) => p.id === providerId);
    const name = def ? (providerId === 'custom' ? 'Custom Command' : def.name) : providerId;
    for (let j = 0; j < n; j++) {
      rows.push({ paneIndex: rows.length, providerId: id, providerName: name });
    }
  }
  // Pad remaining panes with shell rows.
  while (rows.length < preset) {
    rows.push({ paneIndex: rows.length, providerId: 'shell', providerName: 'Shell' });
  }
  return rows.slice(0, preset);
}

export function WorkspaceLauncher() {
  // V1.1.10 perf — slice subscriptions instead of full AppState. The
  // Launcher only depends on the active workspace + persisted workspace
  // recents; it does NOT need to re-render on swarm/browser/chat dispatches.
  const dispatch = useAppDispatch();
  const selectedWorkspace = useAppStateSelector((s) => s.activeWorkspace);
  const persistedWorkspaces = useAppStateSelector((s) => s.workspaces);

  const [mode, setMode] = useState<LauncherMode>('space');
  const [step, setStep] = useState<StepId>('start');
  const [preset, setPreset] = useState<GridPreset>(4);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [skipAgents, setSkipAgents] = useState(false);
  const [probes, setProbes] = useState<ProviderProbe[]>([]);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * v1.3.0 — per-pane session selection. Key = paneIndex, value = sessionId
   * (string) or null meaning "New session". Populated from lastResumePlan on
   * chooseExisting(), or by user interaction in SessionStep.
   */
  const [paneResumePlan, setPaneResumePlan] = useState<Record<number, string | null>>({});

  // Probe providers on mount so the matrix can render PATH-status badges.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const ps = await rpc.providers.probeAll().catch(() => [] as ProviderProbe[]);
      if (alive) setProbes(ps);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Step navigation + preset clamping run inside the event handlers below
  // (changeStepOnPick / changePreset). Avoiding setState-in-effect keeps the
  // render pass single-pass per react-hooks/set-state-in-effect rule.

  function changePreset(next: GridPreset): void {
    setPreset(next);
    // Clamp existing per-provider counts so the sum never exceeds the new
    // pane budget. Done synchronously alongside the preset change so the
    // matrix never flashes an over-allocated state.
    setCounts((prev) => {
      const total = Object.values(prev).reduce((a, b) => a + b, 0);
      if (total <= next) return prev;
      const trimmed: Record<string, number> = {};
      let budget = next;
      for (const [k, v] of Object.entries(prev)) {
        if (budget <= 0) break;
        const give = Math.min(v, budget);
        if (give > 0) trimmed[k] = give;
        budget -= give;
      }
      return trimmed;
    });
  }

  // Auto-advance Step 1 → 2 once a workspace lands in `state.activeWorkspace`.
  // We don't auto-advance Step 2 → 3 — the user picks the pane count and
  // that click is the gate.
  function maybeAdvanceFromStart(): void {
    setStep((curr) => (curr === 'start' ? 'layout' : curr));
  }

  const completed = useMemo<Partial<Record<StepId, boolean>>>(
    () => ({
      start: !!selectedWorkspace,
      layout: !!selectedWorkspace && preset > 0,
      agents:
        skipAgents ||
        Object.values(counts).reduce((a, b) => a + b, 0) === preset,
      // sessions step is considered complete once agents step is complete
      // (the user has viewed it or bulk-acted; we don't gate on explicit
      // per-pane confirmation because "New session" is always a valid choice).
      sessions:
        skipAgents ||
        Object.values(counts).reduce((a, b) => a + b, 0) === preset,
    }),
    [selectedWorkspace, preset, counts, skipAgents],
  );

  async function pickFolder(): Promise<void> {
    const r = await rpc.workspaces.pickFolder();
    if (!r) return;
    const ws = await rpc.workspaces.open(r.path);
    dispatch({ type: 'SET_ACTIVE_WORKSPACE', workspace: ws });
    dispatch({ type: 'SET_WORKSPACES', workspaces: await rpc.workspaces.list() });
    maybeAdvanceFromStart();
  }

  async function chooseExisting(ws: Workspace): Promise<void> {
    const reopened = await rpc.workspaces.open(ws.rootPath);
    dispatch({ type: 'SET_ACTIVE_WORKSPACE', workspace: reopened });

    // v1.3.0 sidebar reroute (R-1.3.0-4): if lastResumePlan has entries,
    // hydrate paneResumePlan + derive preset/counts, then jump directly to
    // the sessions step instead of the Layout step. Stale IDs are silently
    // tolerated — SessionStep's smart-default effect will overwrite them.
    try {
      const plan = await fetchLastResumePlan(reopened.id);
      if (plan.length > 0) {
        // Derive preset from the number of pane entries (best-effort).
        const inferredPreset = plan.length as GridPreset;
        const inferredCounts: Record<string, number> = {};
        const hydrated: Record<number, string | null> = {};
        for (const entry of plan) {
          inferredCounts[entry.providerId] =
            (inferredCounts[entry.providerId] ?? 0) + 1;
          hydrated[entry.paneIndex] = entry.sessionId;
        }
        setPreset(inferredPreset);
        setCounts(inferredCounts);
        setPaneResumePlan(hydrated);
        setStep('sessions');
        return;
      }
    } catch (err) {
      // Best-effort: log + fall through to normal Layout-step flow.
      console.warn('[SessionStep] lastResumePlan fetch failed; falling through', err);
    }

    maybeAdvanceFromStart();
  }

  async function removeExisting(ws: Workspace): Promise<void> {
    await rpc.workspaces.remove(ws.id);
    dispatch({ type: 'SET_WORKSPACES', workspaces: await rpc.workspaces.list() });
    if (selectedWorkspace?.id === ws.id) {
      dispatch({ type: 'SET_ACTIVE_WORKSPACE', workspace: null });
    }
  }

  function expandCountsToPanes(): string[] {
    // Convert {provider: count} → flat array sized to preset, padded with
    // the internal shell sentinel when the user under-assigned. The Custom
    // Command row also resolves to the shell sentinel at launch, which
    // routes through `defaultShell()` in `local-pty.ts`.
    const flat: string[] = [];
    for (const [providerId, n] of Object.entries(counts)) {
      const id = providerId === 'custom' ? 'shell' : providerId;
      for (let i = 0; i < n; i++) flat.push(id);
    }
    while (flat.length < preset) flat.push('shell');
    return flat.slice(0, preset);
  }

  async function launch(): Promise<void> {
    if (!selectedWorkspace) {
      setError('Pick a workspace folder first.');
      return;
    }
    if (mode === 'swarm') {
      // Defer to the Swarm Room which has its own creation wizard. Don't
      // spawn panes; just route the user into that room.
      dispatch({ type: 'SET_ROOM', room: 'swarm' });
      return;
    }
    if (mode === 'canvas') {
      // V3-W14-006 — SigmaCanvas: create a canvas row, ensure a browser tab
      // exists for the Design surface, then route into the Browser room. The
      // BrowserRoom recognises the design picker toggle in the AddressBar.
      try {
        await rpc.design.createCanvas({
          workspaceId: selectedWorkspace.id,
          title: `${selectedWorkspace.name} canvas`,
        });
        const state = await rpc.browser.getState(selectedWorkspace.id);
        if (state.tabs.length === 0) {
          await rpc.browser.openTab({ workspaceId: selectedWorkspace.id });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return;
      }
      dispatch({ type: 'SET_ROOM', room: 'browser' });
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      const paneProviders = skipAgents
        ? Array(preset).fill('shell')
        : expandCountsToPanes();
      // v1.3.1 fix (Bug B): the launcher backend reads `plan.paneResumePlan`
      // (a top-level array), not `panes[i].sessionId`. v1.3.0 emitted the
      // sessionId per-pane only, so `paneResumePlan` was undefined and every
      // pane spawned fresh. Build the top-level array via the exported helper
      // (covered by Launcher.test.tsx) so the contract stays testable.
      const resumeArray = buildPaneResumePlanArray(paneProviders.length, paneResumePlan);
      const plan: LaunchPlan = {
        workspaceRoot: selectedWorkspace.rootPath,
        preset,
        panes: paneProviders.map((providerId, paneIndex) => ({
          paneIndex,
          providerId,
        })),
        ...(resumeArray.length > 0 ? { paneResumePlan: resumeArray } : {}),
      };
      const out = await rpc.workspaces.launch(plan);
      dispatch({ type: 'SET_ACTIVE_WORKSPACE', workspace: selectedWorkspace });
      dispatch({ type: 'ADD_SESSIONS', sessions: out.sessions });
      dispatch({ type: 'SET_ROOM', room: 'command' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLaunching(false);
    }
  }

  const launchEnabled =
    !!selectedWorkspace &&
    !launching &&
    (skipAgents ||
      mode === 'swarm' ||
      mode === 'canvas' ||
      Object.values(counts).reduce((a, b) => a + b, 0) === preset);

  const launchLabel =
    mode === 'swarm'
      ? 'Open Swarm Room'
      : mode === 'canvas'
        ? 'Open Bridge Canvas'
        : skipAgents
          ? `Open ${preset} ${preset === 1 ? 'shell' : 'shells'}`
          : `Launch ${preset} ${preset === 1 ? 'agent' : 'agents'}`;

  return (
    <div className="sl-fade-in flex h-full flex-col gap-4 overflow-y-auto p-6">
      {error ? (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      ) : null}
      <header className="flex flex-col gap-1">
        <div className="text-2xl font-semibold tracking-tight">Build the future.</div>
        <div className="text-sm text-muted-foreground">
          Pick a workspace shape, choose a layout, then assign agents.
        </div>
      </header>

      <PickerCards mode={mode} onChange={setMode} />

      <Card className="flex flex-col gap-4 p-4">
        <Stepper current={step} completed={completed} onJump={setStep} />

        <div className="border-t border-border/60 pt-4">
          {step === 'start' ? (
            <StartStep
              selected={selectedWorkspace}
              recents={persistedWorkspaces}
              onPickFolder={pickFolder}
              onChooseRecent={chooseExisting}
              onForgetRecent={removeExisting}
            />
          ) : null}
          {step === 'layout' ? (
            <div className="flex flex-col gap-3">
              <LayoutStep preset={preset} onChange={changePreset} />
              <div className="text-xs text-muted-foreground">{gridLabel(preset)}</div>
            </div>
          ) : null}
          {step === 'agents' ? (
            <AgentsStep
              totalPanes={preset}
              counts={counts}
              onCountsChange={setCounts}
              skipAgents={skipAgents}
              onSkipChange={setSkipAgents}
              probes={probes}
            />
          ) : null}
          {step === 'sessions' ? (
            <SessionStep
              rows={buildPaneRows(counts, skipAgents, preset)}
              cwd={selectedWorkspace?.rootPath ?? ''}
              selections={paneResumePlan}
              onSelectionsChange={setPaneResumePlan}
              onReconfigure={() => setStep('layout')}
            />
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          <StepNav step={step} onChange={setStep} canAgents={!!selectedWorkspace} />
          <Button
            onClick={launch}
            disabled={!launchEnabled}
            // BUG-W7-015: route the launch CTA through `--accent` rather than
            // `--primary` so the Parchment theme can crank accent darker for
            // 4.5:1 contrast without affecting the secondary Pick-folder
            // button (which still uses `--primary`). Other themes alias
            // accent to a token-equivalent of primary so the visual stays
            // identical there.
            className="gap-2 bg-accent text-accent-foreground hover:bg-accent/90"
            aria-label={launchLabel}
          >
            <Play className="h-4 w-4" />
            {launching ? 'Launching…' : launchLabel}
          </Button>
        </div>
      </Card>

      <BottomActionRow />
    </div>
  );
}

interface StepNavProps {
  step: StepId;
  onChange: (s: StepId) => void;
  canAgents: boolean;
}

function StepNav({ step, onChange, canAgents }: StepNavProps) {
  const next: Record<StepId, StepId | null> = {
    start: 'layout',
    layout: 'agents',
    agents: 'sessions',
    sessions: null,
  };
  const prev: Record<StepId, StepId | null> = {
    start: null,
    layout: 'start',
    agents: 'layout',
    sessions: 'agents',
  };
  const nextStep = next[step];
  const prevStep = prev[step];
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => prevStep && onChange(prevStep)}
        disabled={!prevStep}
      >
        Back
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => nextStep && onChange(nextStep)}
        disabled={!nextStep || ((nextStep === 'agents' || nextStep === 'sessions') && !canAgents)}
      >
        Next
      </Button>
    </div>
  );
}

// V3-W12-005 acceptance: bottom action row `+ NEW TERMINAL · SPLIT RIGHT ·
// SETTINGS`. These are global affordances under the wizard card; the
// individual handlers are stubs for now (Settings routes to the Settings
// room; new-terminal/split-right wiring lands with Command Room polish).
function BottomActionRow() {
  // V1.1.10 perf — useAppDispatch is a context-only read (never re-renders
  // on state change); previous useAppState() subscribed to the full state
  // even though only dispatch was used.
  const dispatch = useAppDispatch();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
      <button
        type="button"
        className="flex items-center gap-1 rounded-md border border-border bg-card/40 px-3 py-1.5 transition hover:bg-card"
        onClick={() => undefined}
      >
        <Plus className="h-3.5 w-3.5" /> New terminal
      </button>
      <button
        type="button"
        className="flex items-center gap-1 rounded-md border border-border bg-card/40 px-3 py-1.5 transition hover:bg-card"
        onClick={() => undefined}
      >
        <SplitSquareHorizontal className="h-3.5 w-3.5" /> Split right
      </button>
      <button
        type="button"
        className="flex items-center gap-1 rounded-md border border-border bg-card/40 px-3 py-1.5 transition hover:bg-card"
        onClick={() => dispatch({ type: 'SET_ROOM', room: 'settings' })}
      >
        <SettingsIcon className="h-3.5 w-3.5" /> Settings
      </button>
    </div>
  );
}
