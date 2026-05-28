// Lightweight drawer for creating a new task. Slides in from the right.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TaskStatus } from '@/shared/types';
import { useFocusTrap } from './useFocusTrap';

interface Props {
  open: boolean;
  workspaceId: string;
  initialStatus?: TaskStatus;
  onClose: () => void;
  onCreated?: () => void;
}

export function NewTaskDrawer(props: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [labels, setLabels] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Store the element that triggered open so we can return focus on close.
  const returnFocusRef = useRef<Element | null>(null);
  // Ref to the dialog panel — used by the focus-trap to scope Tab containment.
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Ref to the title input — we focus it on open ourselves (instead of the
  // `autoFocus` prop) so the capture of the opener happens BEFORE focus moves.
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const { open, onClose } = props;

  // Capture the opener + move initial focus in ONE layout effect, ordered so
  // capture wins. `autoFocus` (the old approach) fired during commit — i.e.
  // BEFORE this effect — so the capture used to record the title input itself,
  // and return-focus then landed on a detached node (→ <body>). Capturing here
  // first, then focusing the input, makes return-focus land on the real opener.
  useLayoutEffect(() => {
    if (open) {
      returnFocusRef.current = document.activeElement;
      titleInputRef.current?.focus();
    } else {
      // Return focus to the trigger when the drawer closes.
      if (returnFocusRef.current && 'focus' in returnFocusRef.current) {
        (returnFocusRef.current as HTMLElement).focus();
      }
      returnFocusRef.current = null;
    }
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Contain Tab / Shift+Tab within the panel (WCAG 2.4.3 / 2.1.2). Initial
  // focus (title input) + opener capture are handled by the layout effect
  // above; Escape by the effect below — useFocusTrap only adds wrapping.
  useFocusTrap(panelRef, open);

  // BUG-W7-008: drawer open/close is keyed off `props.open`. The owning
  // <TasksRoom> watches `state.room` and forces the drawer closed on room
  // change so the drawer cannot leak across rooms. See TasksRoom.tsx.
  if (!props.open) return null;
  const submit = async () => {
    if (!title.trim()) {
      setErr('Title required');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await rpc.tasks.create({
        workspaceId: props.workspaceId,
        title: title.trim(),
        description: description.trim(),
        status: props.initialStatus ?? 'backlog',
        labels: labels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean),
      });
      setTitle('');
      setDescription('');
      setLabels('');
      props.onCreated?.();
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-task-drawer-title"
      className="absolute inset-0 z-30 flex"
    >
      {/* Click-to-close backdrop scrim. tabIndex={-1} keeps it OUT of the Tab
          order — a full-bleed invisible backdrop should not be a keyboard stop
          (Escape + the explicit Close buttons already dismiss the drawer). This
          also makes the dialog's focusable set == the panel's, which is exactly
          what useFocusTrap contains. Still fully clickable. */}
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={props.onClose}
        className="flex-1 bg-black/40"
      />
      <div ref={panelRef} className="flex w-96 flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-3 py-2">
          <span id="new-task-drawer-title" className="text-sm font-semibold">New task</span>
          <button
            type="button"
            onClick={props.onClose}
            className="rounded p-1 hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Title</span>
            <Input
              ref={titleInputRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Wire up the auth callback"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details, acceptance criteria, refs."
              className="h-32 w-full resize-none rounded-md border border-border bg-background p-2 text-sm outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Labels (comma-separated)</span>
            <Input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="bug, ui, p1"
            />
          </label>
          {err ? <div className="text-xs text-red-500">{err}</div> : null}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border p-3">
          <Button onClick={props.onClose} variant="ghost" disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            Create
          </Button>
        </footer>
      </div>
    </div>
  );
}
