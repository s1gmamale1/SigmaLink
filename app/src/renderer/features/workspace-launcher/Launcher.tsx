// Workspace launcher orchestrator. N1 redesigns the flow to be intent-first
// (BridgeSpace-style): Step 1 "Start" picks HOW you want to work via the hero
// IntentCards (SigmaLink grid / SigmaSwarm / single terminal / SigmaCanvas) and
// THEN picks a folder. The chosen mode drives a mode-aware Stepper (modes.ts):
// only the SigmaLink grid mode shows Layout → Agents → Sessions; every other
// mode is intent → launch. The launch RPCs are UNCHANGED — `launch()` still
// branches on the mode and calls the same workspaces.launch / SET_ROOM 'swarm'
// / design.createCanvas paths. BUG-W7-001 preserved: `state.activeWorkspace`
// is the single source of truth. B2 preserved: SessionStep's workspaceId prop
// + resume picker keep working in the grid path.

import { useEffect, useMemo, useState } from 'react';
import { Play, Plus, Settings as SettingsIcon, SplitSquareHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';
import type { GridPreset, LaunchPlan, ProviderProbe, Workspace } from '@/shared/types';
import { IntentCards } from './IntentCards';
import {
  type LauncherMode,
  nextStepForMode,
  prevStepForMode,
  stepAfterStart,
  stepsForMode,
} from './modes';
import { Stepper, type StepId } from './Stepper';
import { StartStep } from './StartStep';
import { LayoutStep } from './LayoutStep';
import type { SavedLayout } from './PresetRow';
import { AgentsStep } from './AgentsStep';
import { SessionStep, fetchLastResumePlan } from './SessionStep';
import type { PaneRow } from './SessionStep';
import { gridLabel } from './grid';
import { AGENT_PROVIDERS } from '@/shared/providers';

/** KV key for the per-workspace Yolo/Bypass default. */
function yoloKvKey(workspaceId: string): string {
  return `pane.autoApprove.default.${workspaceId}`;
}

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
  // N1 — remember the grid preset the operator picked so that toggling into
  // 'single' (which pins 1 pane) and back out restores their choice instead of
  // leaving the grid stuck at 1.
  const [gridPreset, setGridPreset] = useState<GridPreset>(4);
  const [counts, setCounts] = useState<Record<string, number>>({});
  // FEAT-14 — per-provider model picked at launch (providerId → modelId).
  // Only claude / cursor / gemini surface a dropdown; the launcher threads the
  // pick into each matching pane's `--model` flag. Empty = provider default.
  const [models, setModels] = useState<Record<string, string>>({});
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
  /**
   * SF-8 B2 — Yolo/Bypass per-launch toggle. Initialised from the per-workspace
   * kv default; toggling writes the kv so the next launch inherits the choice.
   * Default = false (OFF) when the kv key is absent.
   */
  const [yolo, setYolo] = useState(false);

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

  // SF-8 B2 — Hydrate the yolo toggle from the per-workspace kv default when
  // the active workspace changes. The setYolo calls are microtask-deferred
  // (via async/await) to satisfy the react-hooks/set-state-in-effect lint rule.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!selectedWorkspace) {
        if (alive) setYolo(false);
        return;
      }
      // Fail-safe: kv unavailable → default Yolo OFF (guards rpc.kv undefined).
      let raw: string | null = null;
      try {
        raw = await rpc.kv.get(yoloKvKey(selectedWorkspace.id));
      } catch {
        raw = null;
      }
      if (alive) setYolo(raw === '1');
    })();
    return () => {
      alive = false;
    };
  }, [selectedWorkspace?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** SF-8 B2 — Toggle yolo and persist the per-workspace default. */
  function toggleYolo(): void {
    const next = !yolo;
    setYolo(next);
    if (selectedWorkspace) {
      void rpc.kv?.set?.(yoloKvKey(selectedWorkspace.id), next ? '1' : '0')?.catch(() => undefined);
    }
  }

  // Step navigation + preset clamping run inside the event handlers below
  // (changeStepOnPick / changePreset). Avoiding setState-in-effect keeps the
  // render pass single-pass per react-hooks/set-state-in-effect rule.

  // N1 — change the launcher mode (intent-first). Resets the wizard to the
  // Start step so a mode switch never leaves the user stranded on a step the
  // new mode doesn't show. 'single' pins the pane budget to 1; switching back
  // to a grid mode restores the operator's last grid preset. Clears any stale
  // error. The launch RPC each mode ultimately calls is decided in launch().
  function changeMode(next: LauncherMode): void {
    if (next === mode) return;
    setError(null);
    setMode(next);
    setStep('start');
    if (next === 'single') {
      // Remember the current grid preset so it can be restored on switch-back,
      // then pin to a single pane.
      if (mode === 'space') setGridPreset(preset);
      setPreset(1);
    } else if (mode === 'single') {
      // Leaving single → restore the remembered grid preset.
      setPreset(gridPreset);
    }
  }

  function changePreset(next: GridPreset): void {
    setPreset(next);
    // N1 — track the operator's grid preset so a 'single' detour can restore
    // it. Only meaningful in grid mode; harmless otherwise.
    if (mode === 'space') setGridPreset(next);
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

  // Auto-advance Step 1 once a workspace lands in `state.activeWorkspace`.
  // N1 — the destination depends on the mode: grid mode advances to Layout;
  // single / swarm / canvas stay on Start (the launch CTA does the routing).
  // We don't auto-advance Layout → Agents — the user picks the pane count and
  // that click is the gate.
  function maybeAdvanceFromStart(): void {
    const dest = stepAfterStart(mode);
    setStep((curr) => (curr === 'start' ? dest : curr));
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

  // N1 — the mode-filtered, ordered step list the Stepper + StepNav navigate.
  const visibleSteps = useMemo(() => stepsForMode(mode), [mode]);

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

    // v1.4.3 (#02) — Rehydrate persisted pane sessions BEFORE routing to
    // Command Room so CommandRoom renders existing panes instead of EmptyState.
    // ADD_SESSIONS dispatches first so terminal-cache GC doesn't dispose
    // sessions that are about to become visible.
    try {
      // v1.5.3-hotfix — Promise.all of sessions + swarms so AddPaneButton's
      // activeSwarm resolves correctly after Launcher-driven workspace open
      // (was dispatching ADD_SESSIONS only → renderer thought no swarm
      // existed → +Pane disabled with misleading reason).
      const [sessions, swarms] = await Promise.all([
        rpc.panes.listForWorkspace(reopened.id),
        rpc.swarms.list(reopened.id),
      ]);
      if (sessions.length > 0) {
        dispatch({ type: 'ADD_SESSIONS', sessions });
        if (swarms.length > 0) {
          for (const swarm of swarms) {
            dispatch({ type: 'UPSERT_SWARM', swarm });
          }
          const running = swarms.find((s) => s.status === 'running');
          if (running) {
            dispatch({ type: 'SET_ACTIVE_SWARM', id: running.id });
          }
        }
        // Route to Command Room now that panes are hydrated.
        // v1.3.3 — route into the Command Room so the user sees panes instead
        // of staying on the Launcher's Start step after re-opening a workspace.
        dispatch({ type: 'SET_ROOM', room: 'command' });
        return;
      }
    } catch (err) {
      // Best-effort: log + fall through to resume plan flow.
      console.warn('[chooseExisting] listForWorkspace failed; falling through', err);
    }

    // v1.3.3 — route into the Command Room so the user sees panes instead
    // of staying on the Launcher's Start step after re-opening a workspace.
    dispatch({ type: 'SET_ROOM', room: 'command' });

    // v1.3.0 sidebar reroute (R-1.3.0-4): if lastResumePlan has entries,
    // hydrate paneResumePlan + derive preset/counts, then jump directly to
    // the sessions step instead of the Layout step. Stale IDs are silently
    // tolerated — SessionStep's smart-default effect will overwrite them.
    //
    // N1 — this multi-pane resume jump is grid-flow specific (it infers a
    // preset/counts grid + lands on the Sessions step, which only the 'space'
    // mode shows). For single/swarm/canvas, skip it and stay on Start.
    if (mode !== 'space') {
      maybeAdvanceFromStart();
      return;
    }
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

  function expandCountsToPanes(): Array<{ providerId: string; modelId?: string }> {
    // Convert {provider: count} → flat array sized to preset, padded with
    // the internal shell sentinel when the user under-assigned. The Custom
    // Command row also resolves to the shell sentinel at launch, which
    // routes through `defaultShell()` in `local-pty.ts`.
    //
    // FEAT-14 — carry the per-provider model (keyed by the matrix row id, which
    // equals the resolved providerId for the model-capable providers
    // claude/cursor/gemini). `shell`/`custom` never have a model.
    const flat: Array<{ providerId: string; modelId?: string }> = [];
    for (const [providerId, n] of Object.entries(counts)) {
      const id = providerId === 'custom' ? 'shell' : providerId;
      const modelId = models[providerId] || undefined;
      for (let i = 0; i < n; i++) flat.push({ providerId: id, modelId });
    }
    while (flat.length < preset) flat.push({ providerId: 'shell' });
    return flat.slice(0, preset);
  }

  // FEAT-10 — restore a saved named layout: apply the preset (clamping counts)
  // then overwrite the per-provider counts when the layout carries them. Old
  // `{name, preset}` entries (counts undefined) restore the preset alone.
  function restoreLayout(layout: SavedLayout): void {
    changePreset(layout.preset);
    if (layout.counts) {
      // Clamp the restored distribution to the preset budget so we never seed
      // an over-allocated matrix.
      const trimmed: Record<string, number> = {};
      let budget: number = layout.preset;
      for (const [k, v] of Object.entries(layout.counts)) {
        if (budget <= 0) break;
        const give = Math.min(v, budget);
        if (give > 0) trimmed[k] = give;
        budget -= give;
      }
      setCounts(trimmed);
    }
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
    // N1 — single-terminal mode: launch exactly ONE pane. If the operator never
    // assigned an agent (the Agents step is hidden in this mode), default to a
    // plain shell. This rides the SAME workspaces.launch RPC as the grid path —
    // only the pane budget differs.
    const effectivePreset: GridPreset = mode === 'single' ? 1 : preset;
    const singleShell = mode === 'single' && Object.keys(counts).length === 0;

    setLaunching(true);
    setError(null);
    try {
      const paneProviders: Array<{ providerId: string; modelId?: string }> =
        skipAgents || singleShell
          ? Array.from({ length: effectivePreset }, () => ({ providerId: 'shell' }))
          : expandCountsToPanes();
      // v1.3.1 fix (Bug B): the launcher backend reads `plan.paneResumePlan`
      // (a top-level array), not `panes[i].sessionId`. v1.3.0 emitted the
      // sessionId per-pane only, so `paneResumePlan` was undefined and every
      // pane spawned fresh. Build the top-level array via the exported helper
      // (covered by Launcher.test.tsx) so the contract stays testable.
      const resumeArray = buildPaneResumePlanArray(paneProviders.length, paneResumePlan);
      const plan: LaunchPlan = {
        workspaceRoot: selectedWorkspace.rootPath,
        preset: effectivePreset,
        panes: paneProviders.map(({ providerId, modelId }, paneIndex) => ({
          paneIndex,
          providerId,
          // SF-8 B2: thread yolo into every pane so the main process appends
          // the provider's autoApproveFlag when opts.autoApprove is true.
          autoApprove: yolo,
          // FEAT-14: per-pane model → launcher appends `--model <id>` for
          // providers that accept the flag. Omitted when no model was picked.
          ...(modelId ? { modelId } : {}),
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
      // N1 — single-terminal mode always launches one pane (shell by default),
      // so it is enabled as soon as a folder is picked.
      mode === 'single' ||
      Object.values(counts).reduce((a, b) => a + b, 0) === preset);

  const launchLabel =
    mode === 'swarm'
      ? 'Open Swarm Room'
      : mode === 'canvas'
        ? 'Open Sigma Canvas'
        : mode === 'single'
          ? Object.keys(counts).length > 0
            ? 'Launch 1 agent'
            : 'Open 1 terminal'
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
        <div className="text-sm text-muted-foreground">{headerSubtitle(mode)}</div>
      </header>

      <Card className="flex flex-col gap-4 p-4">
        <Stepper current={step} steps={visibleSteps} completed={completed} onJump={setStep} />

        <div className="border-t border-border/60 pt-4">
          {step === 'start' ? (
            <div className="flex flex-col gap-6">
              {/* N1 — intent-first: pick HOW you want to work, then a folder. */}
              <IntentCards mode={mode} onChange={changeMode} />
              <div className="border-t border-border/60 pt-5">
                <StartStep
                  selected={selectedWorkspace}
                  recents={persistedWorkspaces}
                  onPickFolder={pickFolder}
                  onChooseRecent={chooseExisting}
                  onForgetRecent={removeExisting}
                />
              </div>
            </div>
          ) : null}
          {step === 'layout' ? (
            <div className="flex flex-col gap-3">
              <LayoutStep
                preset={preset}
                onChange={changePreset}
                counts={counts}
                onRestoreLayout={restoreLayout}
              />
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
              models={models}
              onModelsChange={setModels}
            />
          ) : null}
          {step === 'sessions' ? (
            <SessionStep
              rows={buildPaneRows(counts, skipAgents, preset)}
              cwd={selectedWorkspace?.rootPath ?? ''}
              workspaceId={selectedWorkspace?.id}
              selections={paneResumePlan}
              onSelectionsChange={setPaneResumePlan}
              onReconfigure={() => setStep('layout')}
            />
          ) : null}
        </div>

        {/* SF-8 B2 — Yolo/Bypass mode row. N1: only shown for the modes that
            actually spawn agent panes via workspaces.launch (grid + single).
            Swarm has its own approval controls in the Swarm Room and Canvas
            spawns no agents, so the toggle would be a no-op there. */}
        {mode === 'space' || mode === 'single' ? (
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
            <Switch
              id="yolo-toggle"
              data-testid="yolo-toggle"
              checked={yolo}
              onCheckedChange={toggleYolo}
              aria-label="Yolo / Bypass mode — starts agents with their bypass flag"
              aria-checked={yolo}
            />
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor="yolo-toggle"
                className="cursor-pointer text-xs font-semibold text-amber-600 dark:text-amber-400"
              >
                ⚠️ Yolo / Bypass mode
              </label>
              <p className="text-[10px] text-muted-foreground">
                Starts agents with their bypass flag — disables the agent's own approval prompts.
                Use only in trusted workspaces.
              </p>
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          <StepNav
            mode={mode}
            step={step}
            onChange={setStep}
            canAgents={!!selectedWorkspace}
          />
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

// N1 — mode-aware header copy. The subtitle reflects what the chosen mode will
// actually do so the Start step reads as intent-first.
function headerSubtitle(mode: LauncherMode): string {
  switch (mode) {
    case 'swarm':
      return 'A team of AI agents will plan, build, and review one goal together.';
    case 'single':
      return 'Open a single terminal — pick a folder and launch.';
    case 'canvas':
      return 'Open the visual design canvas for this workspace.';
    case 'space':
    default:
      return 'Pick a workspace shape, choose a layout, then assign agents.';
  }
}

interface StepNavProps {
  mode: LauncherMode;
  step: StepId;
  onChange: (s: StepId) => void;
  canAgents: boolean;
}

function StepNav({ mode, step, onChange, canAgents }: StepNavProps) {
  // N1 — Back/Next walk the MODE-FILTERED step list (modes.ts), so the
  // non-grid modes (single/swarm/canvas) correctly have no further steps.
  const nextStep = nextStepForMode(mode, step);
  const prevStep = prevStepForMode(mode, step);
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
