// Per-pane footer: a plain 1px line under each pane (no text, no padding).
//
// The aliveness verb ("Tinkering… 1:23") and the auto/bypass hint were removed
// per operator request — the footer is now just a hairline separator.
//
// FEAT-12 is preserved invisibly: the line is a drop target for PANE_DRAG_MIME.
// Dragging a pane grip onto it injects that pane's context into THIS pane's PTY
// input. The hit-area is widened a few px via a `before` pseudo so the 1px line
// is still a usable drop target; the only visual is a highlight while a pane is
// dragged over it.

import { useState } from 'react';
import type { AgentSession } from '@/shared/types';
import { PANE_DRAG_MIME, buildPaneContext } from '@/renderer/lib/pane-context-builder';
import type { PaneDragPayload } from '@/renderer/lib/pane-context-builder';
import { insertMention } from './insertMention';

interface Props {
  session: AgentSession;
}

export function PaneFooter({ session }: Props) {
  const [isDragOver, setIsDragOver] = useState(false);

  // Hide for exited / errored sessions — there's no shell to inject into.
  if (session.status === 'exited' || session.status === 'error') return null;

  function handleDragOver(e: React.DragEvent): void {
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent): void {
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
    if (payload.sessionId === session.id) return;
    void buildPaneContext(payload)
      // Collapse interior newlines so the injected context lands as one
      // un-submitted input line the user explicitly sends.
      .then((ctx) => insertMention(session.id, ctx.replace(/\r?\n/g, ' '), session.status));
  }

  return (
    <div
      data-testid="pane-footer"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={[
        // Plain hairline; the `before` widens the drop hit-area without taking
        // visual height.
        "relative h-px shrink-0 transition-colors before:absolute before:inset-x-0 before:-top-1 before:-bottom-1 before:content-['']",
        isDragOver ? 'bg-primary' : 'bg-border/60',
      ].join(' ')}
    />
  );
}
