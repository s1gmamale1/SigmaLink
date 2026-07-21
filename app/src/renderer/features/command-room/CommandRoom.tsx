// V3-W13-003 / V3-W13-004 / v1.1.4 Step 4: Command Room — multi-pane grid.
//
// Renders the per-workspace agent sessions inside the <PaneGrid> fill-grid.
// Each cell stacks: PaneHeader (single h-7 strip) · (PaneSplash overlay +
// SessionTerminal) · PaneFooter. The grid honours the launcher's preset
// shape (1/2/3×3/4/6/8/9/10/12) and supports per-cell drag resize plus
// Cmd+Alt+<N> focus jumps. The legacy PaneStatusStrip was collapsed into
// PaneHeader's provider-name tooltip; Stop moves to the right-click menu.

import { useEffect, useMemo, useState } from 'react';
import { Plus, Terminal as TerminalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { WorktreeInfoBanner } from '@/renderer/components/WorktreeInfoBanner';
import { PaneGrid } from './PaneGrid';
import { PaneShell } from './PaneShell';
import { PaneErrorBoundary } from '@/renderer/app/ErrorBoundary';
import { AddPaneButton } from './AddPaneButton';
import type { AgentSession, Swarm } from '@/shared/types';
import { useSkillBindings } from '@/renderer/features/skills/useSkillBindings';
import { SkillBindingChip } from '@/renderer/features/skills/SkillBindingChip';
import { SKILL_DRAG_MIME, type SkillDragPayload } from '@/renderer/features/skills/SkillsTab';

const EMPTY_SESSIONS: AgentSession[] = [];
const EMPTY_SWARMS: Swarm[] = [];

// Pane layout: <PaneGrid> tiles the sessions into a uniform fill-grid (cells
// keyed by sessionId; rows ≈ √n, the last/short rows widen to fill so there is
// no dead space). Sessions are the authoritative set and the grid is a pure
// function of them — no layout state, no persistence. (The old flat grid-cell
// grouping + 1-level split-group model was retired with GridLayout/SplitGroupCell.)

export function CommandRoom() {
  const dispatch = useAppDispatch();
  const activeWorkspace = useAppStateSelector((state) => state.activeWorkspace);
  const activeWorkspaceId = activeWorkspace?.id ?? null;

  // v1.7.1 W-5 Phase 2 — INFORMATIONAL skill bindings for this workspace.
  const { bindings: skillBindings, attach: attachSkill, detach: detachSkill } =
    useSkillBindings({ workspaceId: activeWorkspaceId });

  // Workspace-header drop state for skill drags.
  const [wsHeaderDragOver, setWsHeaderDragOver] = useState(false);
  const activeSessionId = useAppStateSelector((state) => state.activeSessionId);
  const activeSwarmId = useAppStateSelector((state) => state.activeSwarmId);
  // v1.4.2 packet-12 — non-null when a pane is rendered fullscreen.
  const focusedPaneId = useAppStateSelector((state) => state.focusedPaneId);
  const sessions = useAppStateSelector((state) =>
    activeWorkspaceId ? state.sessionsByWorkspace[activeWorkspaceId] ?? EMPTY_SESSIONS : EMPTY_SESSIONS,
  );
  const workspaceSwarms = useAppStateSelector((state) =>
    activeWorkspaceId ? state.swarmsByWorkspace[activeWorkspaceId] ?? EMPTY_SWARMS : EMPTY_SWARMS,
  );
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  // v1.13.2 — `swarmsLoading` now derives from the CANONICAL swarm loader in
  // `use-live-events` (SET_SWARMS_LOADING), not a CommandRoom-local fetch. The
  // old dual loader raced the canonical one and could overwrite the swarms
  // slice; the duplicate fetch effect has been removed. Reading the slice keeps
  // the "+Pane" gate honest during the single hydration window.
  const swarmsLoading = useAppStateSelector((state) => state.swarmsLoading ?? false);
  // v1.5.3-A — "Add first pane" in the empty-state uses its own adding flag
  // so the EmptyState branch stays self-contained (the full dropdown version
  // lives in AddPaneButton which owns its own flag).
  const [emptyStateAdding, setEmptyStateAdding] = useState(false);
  const [showWorktreeBanner, setShowWorktreeBanner] = useState(true);
  const activeSwarm = useMemo(() => {
    if (!activeWorkspace) return null;
    const selected = activeSwarmId
      ? workspaceSwarms.find((s) => s.id === activeSwarmId)
      : null;
    return selected ?? workspaceSwarms.find((s) => s.status === 'running') ?? null;
  }, [activeSwarmId, activeWorkspace, workspaceSwarms]);

  useEffect(() => {
    let alive = true;
    void rpc.providers
      .list()
      .then((list) => {
        if (alive) setProviders(list.map((p) => ({ id: p.id, name: p.name })));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // v1.13.2 — the CommandRoom-local `rpc.swarms.list` effect was REMOVED here.
  // It duplicated the canonical loader in `use-live-events` and raced it: when
  // its UPSERT_SWARM dispatches landed after the canonical SET_SWARMS they could
  // re-sort/overwrite the swarms slice (and flip activeSwarmId). The canonical
  // loader now also owns the `swarmsLoading` flag, which we read from state.


  // Reconcile the global active session with the local pane list. If the
  // current activeSessionId is missing from this workspace's sessions, point
  // it at the first pane so the focus ring lands somewhere coherent.
  useEffect(() => {
    if (sessions.length === 0) return;
    const inList = activeSessionId
      ? sessions.some((s) => s.id === activeSessionId)
      : false;
    if (!inList) {
      dispatch({ type: 'SET_ACTIVE_SESSION', id: sessions[0]!.id });
    }
  }, [sessions, activeSessionId, dispatch]);

  // BUG-V1.1-04-IPC — cross-pane focus sync via sigma:pty-focus events.
  useEffect(() => {
    const onFocusReq = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionId?: string }>).detail;
      if (!detail || typeof detail.sessionId !== 'string') return;
      const target = detail.sessionId;
      if (!sessions.some((s) => s.id === target)) return;
      // Clear attention unconditionally — even if the pane is already active.
      dispatch({ type: 'CLEAR_SESSION_ATTENTION', sessionId: target });
      if (activeSessionId === target) return;
      dispatch({ type: 'SET_ACTIVE_SESSION', id: target });
    };
    window.addEventListener('sigma:pty-focus', onFocusReq);
    return () => window.removeEventListener('sigma:pty-focus', onFocusReq);
  }, [sessions, activeSessionId, dispatch]);

  // v1.4.2 packet-12 — global Esc exits fullscreen when a pane is focused.
  useEffect(() => {
    if (!focusedPaneId) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // A terminal-consumed Esc (DomTerminalView / xterm preventDefault every
      // key they encode into PTY bytes) is an agent interrupt, not an exit-
      // fullscreen request — swallowing it here also blurred the pane the
      // operator was actively typing into.
      if (ev.defaultPrevented) return;
      ev.preventDefault();
      dispatch({ type: 'UNFOCUS_PANE' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedPaneId, dispatch]);

  // v1.4.4 P6 — dev-only empty-state diagnostic (mount-only).
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' && sessions.length === 0 && activeWorkspace) {
      console.warn(
        '[CommandRoom] Empty state — workspace activated but sessions slice empty. ' +
          'Either user just landed on a fresh workspace, OR rehydration failed.',
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // v1.5.3-A — minimal addPane for the empty-state CTA (no chip/toast beyond
  // the toast from rpc failure; the full AddPaneButton owns chip state).
  // v1.13.1 — creates a default swarm when activeSwarm is null but workspace exists.
  async function addEmptyStatePane(): Promise<void> {
    if (!activeWorkspace || emptyStateAdding || providers.length === 0) return;
    setEmptyStateAdding(true);
    try {
      // v1.13.2 — do NOT dispatch UPSERT_SWARM for the freshly-created swarm
      // until addAgent succeeds. The v1.13.1 ordering optimistically upserted
      // the empty swarm BEFORE addAgent resolved, leaving an orphaned
      // agent-less swarm in state if addAgent rejected. The backend (v1.13.2)
      // accepts `swarms.create({ preset:'custom', roster:[] })`, so the create
      // itself succeeds — we just defer the slice write until the pane lands.
      let targetSwarmId: string;
      if (activeSwarm) {
        targetSwarmId = activeSwarm.id;
      } else {
        const newSwarm = await rpc.swarms.create({
          workspaceId: activeWorkspace.id,
          mission: 'Default swarm',
          preset: 'custom',
          roster: [],
        });
        targetSwarmId = newSwarm.id;
      }
      const result = await rpc.swarms.addAgent({ swarmId: targetSwarmId, providerId: providers[0]!.id });
      // addAgent resolved → now it is safe to write the swarm (which now has
      // the agent attached) into state. A single UPSERT carries the populated
      // swarm; no orphan can survive a rejection above.
      dispatch({ type: 'UPSERT_SWARM', swarm: result.swarm });
      dispatch({ type: 'ADD_SESSIONS', sessions: [result.session] });
      dispatch({ type: 'SET_ACTIVE_SESSION', id: result.sessionId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Could not add pane', { description: msg });
    } finally {
      setEmptyStateAdding(false);
    }
  }

  if (!activeWorkspace) {
    return (
      <EmptyState
        icon={TerminalIcon}
        title="Open a workspace first"
        description="The Command Room shows live agent terminals once a workspace is launched."
        action={
          <Button size="sm" onClick={() => dispatch({ type: 'SET_ROOM', room: 'workspaces' })}>
            Open Workspaces
          </Button>
        }
      />
    );
  }
  if (sessions.length === 0) {
    // v1.4.3 #05 — defense-in-depth UX. The actual rehydration fix lives in
    // packet #02; this branch surfaces an inline "Add first pane" affordance
    // so a user who lands on a fresh / freshly-rehydrated workspace doesn't
    // have to walk back through Workspaces → Launcher → grid wizard just to
    // recover. Only shown when swarms are not loading AND providers are ready.
    // v1.13.1 — allow zero-swarms case: "Add first pane" is shown when swarms
    // are done loading and either (a) a running swarm exists or (b) NO swarms
    // exist at all (addEmptyStatePane will create one). A paused/completed swarm
    // keeps canAddPane=false so the user goes back to the workspace wizard.
    //
    // v1.13.2 — `swarmsLoading` is the CANONICAL loader's in-flight flag and
    // flips to false only AFTER SET_SWARMS has landed for the active workspace
    // (the loader dispatches SET_SWARMS then SET_SWARMS_LOADING:false in its
    // finally). So `!swarmsLoading && hasNoSwarms` now reliably means "the
    // server confirmed zero swarms" — not a stale slice from a prior workspace
    // mid-hydration. The dual-loader race that made this gate fire spuriously
    // is gone (the duplicate CommandRoom fetch was removed). The `!activeWorkspace`
    // empty-state branch above already guarantees a workspace is active here.
    const hasRunningSwarm = workspaceSwarms.some((s) => s.status === 'running');
    const hasNoSwarms = workspaceSwarms.length === 0;
    const canAddPane =
      !swarmsLoading &&
      providers.length > 0 &&
      (hasRunningSwarm || hasNoSwarms);
    return (
      <EmptyState
        icon={TerminalIcon}
        title="No agents launched yet"
        description={
          canAddPane
            ? 'Add your first pane below, or go back to Workspaces to pick a grid preset.'
            : 'Head back to the Workspaces room to pick a grid preset and launch.'
        }
        action={
          <div className="flex gap-2">
            {canAddPane ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void addEmptyStatePane()}
                disabled={emptyStateAdding}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add first pane
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => dispatch({ type: 'SET_ROOM', room: 'workspaces' })}
            >
              Go to Workspaces
            </Button>
          </div>
        }
      />
    );
  }

  function handleRemove(session: AgentSession) {
    // Deliberate close → soft-delete via panes.close (marks closed_at, THEN
    // kills). This stops the pane resurrecting on restart AND suppresses the
    // spurious "Pane exited" toast (both the × button and the context-menu
    // "Close pane" funnel here via onRemove). The grid drops the tile below.
    // No status guard: panes.close is safe for an already-errored pane (the kill
    // is best-effort, and we still want closed_at set so the errored row stops
    // rehydrating); markPaneClosed's WHERE closed_at IS NULL keeps it idempotent.
    void rpc.panes.close(session.id).catch(() => undefined);
    dispatch({ type: 'REMOVE_SESSION', id: session.id });
  }

  function handleStop(session: AgentSession) {
    void rpc.pty.kill(session.id).catch(() => undefined);
  }

  // v1.13.2 — Relaunch a crashed pane: re-add an agent of the same provider to
  // the same swarm, then drop the crashed session. Mirrors the addPane flow
  // (a fresh PTY in the same swarm), so the recovered pane behaves identically
  // to a freshly-added one. Falls back to the active swarm when the crashed
  // session predates the swarm derivation. No-op if no target swarm is known.
  async function handleRelaunch(session: AgentSession): Promise<void> {
    const targetSwarmId = activeSwarm?.id;
    if (!targetSwarmId) {
      toast.error('Could not relaunch pane', {
        description: 'No active swarm to attach the new pane to.',
      });
      return;
    }
    try {
      const result = await rpc.swarms.addAgent({
        swarmId: targetSwarmId,
        providerId: session.providerId,
      });
      dispatch({ type: 'UPSERT_SWARM', swarm: result.swarm });
      dispatch({ type: 'ADD_SESSIONS', sessions: [result.session] });
      dispatch({ type: 'SET_ACTIVE_SESSION', id: result.sessionId });
      // session-persistence fix (2026-07-18) — close the crashed ROW in the DB,
      // not just the renderer (REMOVE_SESSION is UI-only). Without this the row
      // lingered open (closed_at NULL) as a stale sibling in its slot and boot
      // auto-resume respawned its OLD conversation. markPaneClosed is
      // idempotent; the kill inside panes.close is a no-op on a dead pane.
      void rpc.panes.close(session.id).catch(() => {
        /* best-effort — the janitor supersession sweep is the backstop */
      });
      // Drop the crashed pane only after the replacement lands.
      dispatch({ type: 'REMOVE_SESSION', id: session.id });
    } catch (err) {
      toast.error('Could not relaunch pane', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // v1.4.3 #06 — SPLIT_PANE dispatch annotates parent + child in one render pass.
  async function handleSplitPane(
    parent: AgentSession,
    direction: 'horizontal' | 'vertical',
    providerId: string,
  ): Promise<void> {
    try {
      const newSession = await rpc.swarms.splitPane({
        paneId: parent.id,
        direction,
        provider: providerId,
      });
      const groupId = newSession.splitGroupId;
      if (!groupId) {
        // Defensive fallback — controller should always return annotated session.
        dispatch({ type: 'ADD_SESSIONS', sessions: [newSession] });
        return;
      }
      dispatch({
        type: 'SPLIT_PANE',
        parentId: parent.id,
        newSession,
        groupId,
        direction,
      });
      toast.success(`Split pane ${direction}`, {
        description: `Added ${providerId}`,
      });
    } catch (err) {
      toast.error('Could not split pane', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // v1.4.3 #06 — Optimistic minimise with RPC revert on failure.
  function handleToggleMinimise(session: AgentSession): void {
    const next = !session.minimised;
    dispatch({ type: 'MINIMISE_PANE', paneId: session.id, minimised: next });
    void rpc.swarms.minimisePane({ paneId: session.id, minimised: next }).catch((err) => {
      dispatch({ type: 'MINIMISE_PANE', paneId: session.id, minimised: !next }); // revert
      toast.error('Could not minimise pane', {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // v1.7.1 W-5 Phase 2 — workspace-header skill drop handlers (INFORMATIONAL).
  function handleWsHeaderDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (e.dataTransfer.types.includes(SKILL_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setWsHeaderDragOver(true);
    }
  }

  function handleWsHeaderDragLeave(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setWsHeaderDragOver(false);
    }
  }

  function handleWsHeaderDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setWsHeaderDragOver(false);
    const raw = e.dataTransfer.getData(SKILL_DRAG_MIME);
    if (!raw || !activeWorkspaceId) return;
    try {
      const payload = JSON.parse(raw) as SkillDragPayload;
      if (payload.kind === 'skill' && payload.name) {
        // paneSessionId = null → workspace-wide binding.
        void attachSkill({ paneSessionId: null, skillName: payload.name, skillSource: payload.source });
      }
    } catch {
      /* malformed payload — ignore */
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={[
          'flex h-10 items-center gap-2 border-b border-border px-3 text-xs',
          wsHeaderDragOver && 'ring-2 ring-inset ring-[hsl(var(--ring))]',
        ]
          .filter(Boolean)
          .join(' ')}
        data-testid="workspace-header"
        onDragOver={handleWsHeaderDragOver}
        onDragLeave={handleWsHeaderDragLeave}
        onDrop={handleWsHeaderDrop}
      >
        <div className="font-medium">{activeWorkspace.name}</div>
        <span className="text-muted-foreground">·</span>
        <div className="text-muted-foreground">
          {sessions.length} {sessions.length === 1 ? 'agent' : 'agents'}
        </div>
        {/* v1.5.3-A — +Pane button extracted to AddPaneButton (owns disabled
            pill, error chip, and rpc.swarms.addAgent call). */}
        {/* v1.13.1 — also passes activeWorkspace + swarmsLoading so the button
            shows the correct message during the async hydration window. */}
        <AddPaneButton
          activeWorkspace={activeWorkspace}
          activeSwarm={activeSwarm}
          swarmsLoading={swarmsLoading}
          providers={providers}
        />
        {/* v1.7.1 W-5 Phase 2 — Workspace-wide skill binding chips (INFORMATIONAL). */}
        {skillBindings.filter((b) => b.paneSessionId === null).map((binding) => (
          <SkillBindingChip
            key={binding.id}
            binding={binding}
            onDetach={(id) => void detachSkill(id)}
          />
        ))}
        <div className="ml-auto text-[10px] text-muted-foreground/70">
          ⌘⌥&lt;N&gt; to focus pane
        </div>
      </div>
      {showWorktreeBanner && sessions.length > 0 && (
        <WorktreeInfoBanner onDismiss={() => setShowWorktreeBanner(false)} />
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <PaneGrid
          sessionIds={sessions.map((s) => s.id)}
          activeSessionId={activeSessionId}
          focusedPaneId={focusedPaneId}
          workspaceId={activeWorkspaceId}
          onActivate={(id) => {
            dispatch({ type: 'CLEAR_SESSION_ATTENTION', sessionId: id });
            if (activeSessionId !== id) dispatch({ type: 'SET_ACTIVE_SESSION', id });
          }}
          renderLeaf={(sessionId) => {
            const session = sessions.find((s) => s.id === sessionId);
            if (!session) return null;
            // v1.7.1 W-5 Phase 2 — filter to pane-scoped bindings for this session.
            const paneBindings = skillBindings.filter((b) => b.paneSessionId === session.id);
            const paneIndex = sessions.findIndex((s) => s.id === sessionId) + 1;
            return (
              <PaneErrorBoundary
                key={session.id}
                onRelaunch={() => void handleRelaunch(session)}
                onClose={() => handleRemove(session)}
              >
                <PaneShell
                  session={session}
                  paneIndex={paneIndex}
                  providers={providers}
                  workspaceRootPath={activeWorkspace.rootPath}
                  onFocus={() => {
                    dispatch({ type: 'CLEAR_SESSION_ATTENTION', sessionId: session.id });
                    if (activeSessionId !== session.id) dispatch({ type: 'SET_ACTIVE_SESSION', id: session.id });
                  }}
                  onRemove={() => handleRemove(session)}
                  onStop={() => handleStop(session)}
                  onRelaunch={() => void handleRelaunch(session)}
                  onDismissAuthWarning={() =>
                    dispatch({ type: 'CLEAR_SESSION_AUTH_ERROR', id: session.id })
                  }
                  onSplit={(dir, providerId) => void handleSplitPane(session, dir, providerId)}
                  onToggleMinimise={() => handleToggleMinimise(session)}
                  isFullscreen={focusedPaneId === session.id}
                  onToggleFullscreen={() =>
                    dispatch(
                      focusedPaneId === session.id
                        ? { type: 'UNFOCUS_PANE' }
                        : { type: 'FOCUS_PANE', paneId: session.id },
                    )
                  }
                  skillBindings={paneBindings}
                  onSkillDrop={(name, source) =>
                    void attachSkill({ paneSessionId: session.id, skillName: name, skillSource: source })
                  }
                  onSkillDetach={(bindingId) => void detachSkill(bindingId)}
                />
              </PaneErrorBoundary>
            );
          }}
        />
      </div>
    </div>
  );
}
