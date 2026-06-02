// V3-W13-003: per-pane footer hint strip.
//
// Cycles between `auto mode on (shift+tab to cycle)` and `bypass permissions on`
// based on agent state. The auto-approve flag isn't stored on AgentSession
// directly — it lives at the swarm-agent level (`swarm_agents.autoApprove`,
// V3-W12-018) and is mirrored into kv as `swarm.<swarmId>.<agentKey>.autoApprove`.
// We read that kv key when present; otherwise we fall back to the provider's
// own auto-approve flag column on the session if we ever start surfacing it.
//
// ANIM-3: when session.status === 'running', the LEFT side of the footer shows
// a rotating whimsical progress verb + elapsed time ("Percolating… 1:23").
// The verb advances every 4 ticks (4s); elapsed uses a single 1s interval.
// Reduced motion: verb is frozen at index 0 (clock still ticks — not motion).
//
// FEAT-12: the footer composer area is a drop target for PANE_DRAG_MIME.
// Dropping a pane grip on the footer calls buildPaneContext (async ~100-300ms)
// then insertMention to inject the context string into the PTY input.
// Visual feedback: ring-2 highlight while a pane drag is over the composer +
// a brief "loading context…" label during the async fetch.

import { useEffect, useRef, useState } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import { prefersReducedMotion } from '@/renderer/lib/motion';
import { pickVerb } from './progress-verbs';
import type { AgentSession } from '@/shared/types';
import { PANE_DRAG_MIME, buildPaneContext } from '@/renderer/lib/pane-context-builder';
import type { PaneDragPayload } from '@/renderer/lib/pane-context-builder';
import { insertMention } from './insertMention';

interface Props {
  session: AgentSession;
  /**
   * Optional kv key (`swarm.<swarmId>.<agentKey>.autoApprove`). When provided,
   * the footer reads the boolean from kv. When not provided, the footer
   * defaults to `auto mode on`.
   */
  kvKey?: string;
}

/** Format elapsed seconds as "Ns" (< 60) or "m:ss" (>= 60). */
function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function PaneFooter({ session, kvKey }: Props) {
  // `kvBypass` is null until the async kv lookup resolves. setState only
  // fires from the resolved promise callback (the external-source exception
  // in react-hooks rules), never synchronously inside the effect body.
  const [kvBypass, setKvBypass] = useState<boolean | null>(null);

  // ANIM-3 — aliveness state. Both values are updated only from inside the
  // setInterval callback (external system), never synchronously in the effect
  // body — satisfies react-hooks/set-state-in-effect. Elapsed is stored as
  // state (not derived via Date.now() in render) to satisfy react-hooks/purity.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [verbIndex, setVerbIndex] = useState(0);
  const rotationTickRef = useRef(0);

  // FEAT-12 — drop-zone state: isDragOver shows ring highlight, isLoadingContext
  // shows a brief "loading context…" label while buildPaneContext is in flight.
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoadingContext, setIsLoadingContext] = useState(false);

  useEffect(() => {
    if (!kvKey) return;
    let alive = true;
    void (async () => {
      try {
        const v = await rpcSilent.kv.get(kvKey);
        if (!alive) return;
        setKvBypass(v === '1' || v === 'true');
      } catch {
        if (alive) setKvBypass(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [kvKey]);

  // ANIM-3 — single interval for elapsed + verb rotation.
  // Runs only while session is 'running'. Cleans up on status change or unmount.
  // setState is called exclusively inside the setInterval callback (external),
  // never synchronously in the effect body.
  useEffect(() => {
    if (session.status !== 'running') return;

    const reducedMotion = prefersReducedMotion();
    rotationTickRef.current = 0;

    const startedAt = session.startedAt;
    const id = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
      if (!reducedMotion) {
        rotationTickRef.current += 1;
        if (rotationTickRef.current % 4 === 0) {
          setVerbIndex((prev) => prev + 1);
        }
      }
    }, 1000);

    return () => clearInterval(id);
  }, [session.startedAt, session.status]);

  const bypass = kvBypass ?? false;

  // Hide footer for exited / errored sessions — there's no shell to cycle.
  if (session.status === 'exited' || session.status === 'error') return null;

  const verb = pickVerb(verbIndex);

  // FEAT-12 — drag-over handler: accept PANE_DRAG_MIME drops.
  function handleDragOver(e: React.DragEvent): void {
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent): void {
    // Only clear if leaving the footer root (not a child element).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData(PANE_DRAG_MIME);
    if (!raw) return;
    let payload: PaneDragPayload;
    try {
      payload = JSON.parse(raw) as PaneDragPayload;
    } catch {
      return;
    }
    // Guard: don't inject context into the same pane that was dragged from.
    if (payload.sessionId === session.id) return;
    setIsLoadingContext(true);
    void buildPaneContext(payload)
      .then((ctx) => insertMention(session.id, ctx, session.status))
      .finally(() => setIsLoadingContext(false));
  }

  return (
    <div
      className={[
        'flex h-5 items-center border-t border-border/60 bg-card/80 px-2 text-[10px] text-muted-foreground transition-all',
        isDragOver
          ? 'ring-2 ring-inset ring-primary bg-primary/10'
          : '',
      ].join(' ').trim()}
      data-testid="pane-footer"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isLoadingContext ? (
        <span className="shrink-0 italic text-muted-foreground/70" data-testid="pane-footer-loading">
          loading context&hellip;
        </span>
      ) : session.status === 'running' ? (
        <span className="shrink-0 text-muted-foreground/70" data-testid="pane-aliveness">
          {verb}&hellip; {formatElapsed(elapsedSeconds)}
        </span>
      ) : null}
      <span className="ml-auto shrink-0">
        {isDragOver ? (
          <span className="font-medium text-primary" data-testid="pane-footer-drop-hint">
            drop to inject context
          </span>
        ) : bypass ? (
          <span className="font-medium text-amber-400">bypass permissions on</span>
        ) : (
          <span>
            auto mode on{' '}
            <span className="text-muted-foreground/60">(shift+tab to cycle)</span>
          </span>
        )}
      </span>
    </div>
  );
}
