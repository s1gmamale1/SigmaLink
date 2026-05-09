// Side panel for editing a task and reading/posting comments.

import { useEffect, useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Task, TaskComment, TaskStatus } from '@/shared/types';

interface Props {
  open: boolean;
  task: Task | null;
  onClose: () => void;
}

const STATUS_OPTIONS: TaskStatus[] = ['backlog', 'in_progress', 'in_review', 'done', 'archived'];

export function TaskDetailDrawer(props: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('backlog');
  const [labels, setLabels] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [newComment, setNewComment] = useState('');

  // Hydrate when the active task id changes. We deliberately depend only on
  // the id (not the whole `props.task`) — the parent passes a fresh object on
  // each render and we only want to refetch when the user opens a different
  // card.
  const taskId = props.task?.id ?? null;
  useEffect(() => {
    const t = props.task;
    if (!t) return;
    setTitle(t.title);
    setDescription(t.description);
    setStatus(t.status);
    setLabels(t.labels.join(', '));
    setErr(null);
    void (async () => {
      try {
        setComments(await rpc.tasks.listComments(t.id));
      } catch {
        /* ignore */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  if (!props.open || !props.task) return null;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await rpc.tasks.update({
        id: props.task!.id,
        title: title.trim(),
        description: description.trim(),
        status,
        labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await rpc.tasks.remove(props.task!.id);
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitComment = async () => {
    if (!newComment.trim()) return;
    try {
      const c = await rpc.tasks.addComment({
        taskId: props.task!.id,
        body: newComment.trim(),
      });
      setComments((prev) => [...prev, c]);
      setNewComment('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div role="dialog" aria-modal="true" className="absolute inset-0 z-30 flex">
      <button
        type="button"
        aria-label="Close"
        onClick={props.onClose}
        className="flex-1 bg-black/40"
      />
      <div className="flex w-[28rem] flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="truncate text-sm font-semibold">{props.task.title}</span>
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
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-32 w-full resize-none rounded-md border border-border bg-background p-2 text-sm outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              className="w-full rounded-md border border-border bg-background p-2 text-sm"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Labels</span>
            <Input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="bug, ui, p1"
            />
          </label>
          <div>
            <span className="mb-1 block text-xs text-muted-foreground">Assignment</span>
            <div className="rounded border border-border bg-muted/40 p-2 text-xs">
              {props.task.assignedSwarmAgentId ? (
                <span>swarm agent <code>{props.task.assignedSwarmAgentId}</code></span>
              ) : props.task.assignedSessionId ? (
                <span>session <code>{props.task.assignedSessionId}</code></span>
              ) : (
                <span className="text-muted-foreground">unassigned</span>
              )}
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>Comments</span>
              <span>{comments.length}</span>
            </div>
            <ul className="space-y-2">
              {comments.map((c) => (
                <li key={c.id} className="rounded border border-border p-2 text-xs">
                  <div className="mb-0.5 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{c.author}</span>
                    <span>{new Date(c.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="whitespace-pre-wrap">{c.body}</div>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-end gap-2">
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add a comment…"
                className="h-16 flex-1 resize-none rounded-md border border-border bg-background p-2 text-xs outline-none focus:border-primary"
              />
              <Button onClick={submitComment} size="sm" disabled={!newComment.trim()}>
                Post
              </Button>
            </div>
          </div>
          {err ? <div className="text-xs text-red-500">{err}</div> : null}
        </div>
        <footer className="flex items-center justify-between border-t border-border p-3">
          <Button onClick={remove} size="sm" variant="destructive" disabled={busy}>
            <Trash2 className="mr-1 h-3 w-3" /> Delete
          </Button>
          <div className="flex gap-2">
            <Button onClick={props.onClose} size="sm" variant="ghost" disabled={busy}>
              Close
            </Button>
            <Button onClick={save} size="sm" disabled={busy}>
              Save
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
