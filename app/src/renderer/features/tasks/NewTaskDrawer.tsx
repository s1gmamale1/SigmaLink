// Lightweight drawer for creating a new task. Slides in from the right.

import { useState } from 'react';
import { X } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TaskStatus } from '@/shared/types';

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
      className="absolute inset-0 z-30 flex"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={props.onClose}
        className="flex-1 bg-black/40"
      />
      <div className="flex w-96 flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">New task</span>
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
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
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
