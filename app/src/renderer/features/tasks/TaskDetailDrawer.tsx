// Side panel for editing a task and reading/posting comments.

import { useEffect, useReducer, useRef, useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Task, TaskComment, TaskStatus } from '@/shared/types';
import { useFocusTrap } from './useFocusTrap';

interface Props {
  open: boolean;
  task: Task | null;
  onClose: () => void;
}

const STATUS_OPTIONS: TaskStatus[] = ['backlog', 'in_progress', 'in_review', 'done', 'archived'];

// Form fields live in a reducer so a task-id change hydrates them with one
// dispatch instead of five chained setStates inside `useEffect` (which the
// react-hooks lint flags as a cascading-render anti-pattern).
interface FormState {
  title: string;
  description: string;
  status: TaskStatus;
  labels: string;
  err: string | null;
}

type FormAction =
  | { type: 'hydrate'; task: Task }
  | { type: 'set'; patch: Partial<FormState> };

const INITIAL_FORM: FormState = {
  title: '',
  description: '',
  status: 'backlog',
  labels: '',
  err: null,
};

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'hydrate':
      return {
        title: action.task.title,
        description: action.task.description,
        status: action.task.status,
        labels: action.task.labels.join(', '),
        err: null,
      };
    case 'set':
      return { ...state, ...action.patch };
    default:
      return state;
  }
}

export function TaskDetailDrawer(props: Props) {
  const [form, dispatch] = useReducer(formReducer, INITIAL_FORM);
  const { title, description, status, labels, err } = form;
  const [busy, setBusy] = useState(false);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [newComment, setNewComment] = useState('');
  // Store the element that triggered open so we can return focus on close.
  const returnFocusRef = useRef<Element | null>(null);
  // Ref to the dialog panel — drives both initial focus and the focus-trap.
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Depend only on the id (not the whole `props.task`) — the parent passes a
  // fresh object every render; we only want to refetch when the user opens a
  // different card.
  const taskId = props.task?.id ?? null;
  useEffect(() => {
    const t = props.task;
    if (!t) return;
    dispatch({ type: 'hydrate', task: t });
    void (async () => {
      try {
        setComments(await rpc.tasks.listComments(t.id));
      } catch {
        /* ignore */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const { open: drawerOpen, onClose } = props;

  // Return-focus + Escape support (must be unconditional hooks — placed before
  // the early return to satisfy Rules of Hooks).
  useEffect(() => {
    if (drawerOpen) {
      returnFocusRef.current = document.activeElement;
    } else {
      if (returnFocusRef.current && 'focus' in returnFocusRef.current) {
        (returnFocusRef.current as HTMLElement).focus();
      }
      returnFocusRef.current = null;
    }
  }, [drawerOpen]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, onClose]);

  // Initial focus — unlike NewTaskDrawer there is no single obvious first
  // field to autoFocus (the panel hydrates from the task), so move focus to
  // the panel container on open. The panel carries tabIndex={-1} so it is
  // programmatically focusable without becoming a Tab stop. This satisfies
  // WCAG 2.4.3 (focus order starts inside the dialog) and gives the focus-trap
  // an in-panel anchor to wrap from.
  useEffect(() => {
    if (drawerOpen && props.task) {
      // Defer to after paint so the panel ref is attached.
      const id = requestAnimationFrame(() => panelRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [drawerOpen, props.task]);

  // Contain Tab / Shift+Tab within the panel (WCAG 2.4.3 / 2.1.2). Return-focus
  // + Escape remain owned by the effects above — useFocusTrap only adds wrapping.
  useFocusTrap(panelRef, drawerOpen);

  // BUG-W7-008: drawer visibility is gated on props.open. The owning
  // <TasksRoom> watches `state.room` and forces props.open=false when the
  // user navigates away, so the drawer cannot leak across rooms.
  if (!props.open || !props.task) return null;

  const save = async () => {
    setBusy(true);
    dispatch({ type: 'set', patch: { err: null } });
    try {
      await rpc.tasks.update({
        id: props.task!.id,
        title: title.trim(),
        description: description.trim(),
        status,
        labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
      });
    } catch (e) {
      dispatch({ type: 'set', patch: { err: e instanceof Error ? e.message : String(e) } });
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
      dispatch({ type: 'set', patch: { err: e instanceof Error ? e.message : String(e) } });
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
      dispatch({ type: 'set', patch: { err: e instanceof Error ? e.message : String(e) } });
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="task-detail-drawer-title" className="absolute inset-0 z-30 flex">
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
      <div ref={panelRef} tabIndex={-1} className="flex w-[28rem] flex-col bg-background shadow-xl outline-none">
        <header className="flex items-center justify-between border-b border-border px-3 py-2">
          <span id="task-detail-drawer-title" className="truncate text-sm font-semibold">{props.task.title}</span>
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
              onChange={(e) => dispatch({ type: 'set', patch: { title: e.target.value } })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Description</span>
            <textarea
              value={description}
              onChange={(e) =>
                dispatch({ type: 'set', patch: { description: e.target.value } })
              }
              className="h-32 w-full resize-none rounded-md border border-border bg-background p-2 text-sm outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Status</span>
            <select
              value={status}
              onChange={(e) =>
                dispatch({
                  type: 'set',
                  patch: { status: e.target.value as TaskStatus },
                })
              }
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
              onChange={(e) => dispatch({ type: 'set', patch: { labels: e.target.value } })}
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
