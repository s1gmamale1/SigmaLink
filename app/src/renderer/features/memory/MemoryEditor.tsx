// Markdown-ish editor with a live preview pane. Wikilinks in the preview
// become buttons that switch the active note (creating a new one when the
// target doesn't exist, after a confirm prompt). For v1 we use a plain
// textarea + a simple markdown-light preview; Monaco / CodeMirror can land
// in a future phase.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Save,
  Trash2,
  Eye,
  Pencil,
  Hash,
  RotateCw,
  Lock,
  PanelRight,
  FilePlus2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { rpc } from '@/renderer/lib/rpc';
import type { Memory } from '@/shared/types';
import { extractWikilinks, renderChunks } from './wikilink';
import { PropertiesPanel } from './PropertiesPanel';
import { OutlineRail, scrollTopForLine } from './OutlineRail';

interface Props {
  workspaceId: string;
  memory: Memory | null;
  knownNames: Set<string>;
  onNavigate(name: string): void;
  onSaved(memory: Memory): void;
  onDeleted(memoryId: string): void;
  /**
   * P4 MEM-1 — render an agent-authored Ruflo virtual note. The body is shown
   * but not editable, no auto-save/update/delete RPC ever runs, and Save/Delete
   * are hidden in favor of a read-only chip.
   */
  readOnly?: boolean;
  /** P4 MEM-1 — metadata surfaced in the read-only chip (Ruflo namespace + score). */
  readOnlyMeta?: { namespace?: string; score?: number };
  /**
   * MEM-8 — notes tagged `template`, surfaced as an "Insert template" Popover in
   * the toolbar. Selecting one REPLACES the editor body. Optional; the button
   * only renders when at least one template exists.
   */
  templates?: Memory[];
}

const SAVE_DEBOUNCE_MS = 600;
/** MEM-9 — approximate rendered line height of the mono editor textarea (px).
 *  `text-xs` (12px) × the `leading-relaxed` ratio (1.625) ≈ 19.5px. */
const EDITOR_LINE_HEIGHT = 19.5;
/** MEM-9 — the optional right-side editor panel: Properties grid or Outline rail. */
type SidePanel = 'none' | 'properties' | 'outline';

export function MemoryEditor({
  workspaceId,
  memory,
  knownNames,
  onNavigate,
  onSaved,
  onDeleted,
  readOnly = false,
  readOnlyMeta,
  templates,
}: Props) {
  const [body, setBody] = useState(memory?.body ?? '');
  const [tags, setTags] = useState(memory?.tags.join(', ') ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  // MEM-9 — which (if any) right-side editor panel is open. Persists across
  // note switches within the room (it's a viewing preference, not note state).
  const [sidePanel, setSidePanel] = useState<SidePanel>('none');
  // MEM-8 — "Insert template" Popover open state.
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  // MEM-9 — the editor textarea, so the outline can scroll it to a heading line.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // UX-3 — themed confirm state (replaces the two window.confirm calls).
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The wikilink target awaiting a "create missing note?" confirm. `null`
  // closes the dialog.
  const [pendingWikilink, setPendingWikilink] = useState<string | null>(null);
  // BUG-11 — the on-disk version changed under us while we held unsaved local
  // edits. We surface a non-destructive "Reload" banner instead of clobbering.
  const [staleOnDisk, setStaleOnDisk] = useState(false);
  const dirtyRef = useRef(false);
  const lastSentRef = useRef<{ id: string | undefined; body: string; tags: string }>({
    id: memory?.id,
    body: memory?.body ?? '',
    tags: memory?.tags.join(', ') ?? '',
  });
  // BUG-11 — the updatedAt we last hydrated from. Lets the hydration effect
  // distinguish a true external bump from our own optimistic re-render.
  const hydratedUpdatedAtRef = useRef(memory?.updatedAt);

  // Pull the current `memory` prop into the editable fields. Hydrate when the
  // selected note changes (id) and — BUG-11 — when an external writer (agent
  // MCP / sync) advances `updatedAt` on the OPEN note. If the user has unsaved
  // local edits when that happens, we do NOT clobber them: a Reload banner lets
  // them opt in. Read-only notes always re-hydrate (no local edits possible).
  useEffect(() => {
    const nextBody = memory?.body ?? '';
    const nextTags = memory?.tags.join(', ') ?? '';
    const idChanged = lastSentRef.current.id !== memory?.id;
    const updatedAtAdvanced =
      !idChanged &&
      memory?.updatedAt !== undefined &&
      hydratedUpdatedAtRef.current !== undefined &&
      memory.updatedAt > hydratedUpdatedAtRef.current;

    // Switching notes, or an external bump while there are no unsaved edits:
    // hydrate. An external bump while dirty (and not read-only): show banner.
    if (!idChanged && updatedAtAdvanced && dirtyRef.current && !readOnly) {
      queueMicrotask(() => setStaleOnDisk(true));
      return;
    }
    queueMicrotask(() => {
      setBody(nextBody);
      setTags(nextTags);
      setErr(null);
      setStaleOnDisk(false);
      dirtyRef.current = false;
      lastSentRef.current = { id: memory?.id, body: nextBody, tags: nextTags };
      hydratedUpdatedAtRef.current = memory?.updatedAt;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory?.id, memory?.updatedAt, readOnly]);

  // BUG-11 — discard local edits and re-hydrate from the newer on-disk version.
  const reloadFromDisk = useCallback(() => {
    const nextBody = memory?.body ?? '';
    const nextTags = memory?.tags.join(', ') ?? '';
    setBody(nextBody);
    setTags(nextTags);
    setErr(null);
    setStaleOnDisk(false);
    dirtyRef.current = false;
    lastSentRef.current = { id: memory?.id, body: nextBody, tags: nextTags };
    hydratedUpdatedAtRef.current = memory?.updatedAt;
  }, [memory?.body, memory?.id, memory?.tags, memory?.updatedAt]);

  const saveNow = useCallback(
    async (override?: { body?: string; tags?: string }) => {
      // BUG-11 / MEM-1 — never write back a read-only (agent) note, and never
      // auto-save over a newer on-disk version (the Reload banner is the guard).
      if (!memory || readOnly || staleOnDisk) return;
      const nextBody = override?.body ?? body;
      const nextTags = override?.tags ?? tags;
      if (
        nextBody === lastSentRef.current.body &&
        nextTags === lastSentRef.current.tags
      ) {
        return;
      }
      const tagList = nextTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      setBusy(true);
      setErr(null);
      try {
        const updated = await rpc.memory.update_memory({
          workspaceId,
          name: memory.name,
          body: nextBody,
          tags: tagList,
        });
        lastSentRef.current = { id: memory.id, body: nextBody, tags: nextTags };
        dirtyRef.current = false;
        // Our own write advances updatedAt; track it so the resulting prop
        // re-render isn't mistaken for an external bump (false stale banner).
        hydratedUpdatedAtRef.current = updated.updatedAt;
        onSaved(updated);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [body, memory, onSaved, readOnly, staleOnDisk, tags, workspaceId],
  );

  // Auto-save with debounce on body/tag changes. Read-only (Ruflo) notes never
  // run this — their body is never editable, so it can never diverge.
  useEffect(() => {
    if (!memory || readOnly) return;
    if (
      body === lastSentRef.current.body &&
      tags === lastSentRef.current.tags
    ) {
      return;
    }
    dirtyRef.current = true;
    const t = setTimeout(() => {
      void saveNow();
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [body, tags, memory, readOnly, saveNow]);

  // UX-3 — open the themed destructive confirm; the delete runs in
  // `confirmDelete`.
  const onDelete = useCallback(() => {
    if (!memory) return;
    setDeleteOpen(true);
  }, [memory]);

  const confirmDelete = useCallback(async () => {
    if (!memory) return;
    setDeleteOpen(false);
    try {
      await rpc.memory.delete_memory({ workspaceId, name: memory.name });
      onDeleted(memory.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [memory, onDeleted, workspaceId]);

  const onWikilinkClick = useCallback(
    (target: string) => {
      // P4 MEM-1 — a read-only Ruflo virtual note must never trigger a local
      // write or navigation from its (agent-authored) body. Inert in readOnly.
      if (readOnly) return;
      const exists = knownNames.has(target.toLowerCase());
      if (!exists) {
        // UX-3 — stage a themed "create missing note?" confirm instead of the
        // blocking window.confirm. The create + navigate run in
        // `confirmCreateWikilink`.
        setPendingWikilink(target);
        return;
      }
      onNavigate(target);
    },
    [knownNames, onNavigate, readOnly],
  );

  const confirmCreateWikilink = useCallback(async () => {
    const target = pendingWikilink;
    if (!target) return;
    setPendingWikilink(null);
    try {
      await rpc.memory.create_memory({ workspaceId, name: target });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    onNavigate(target);
  }, [onNavigate, pendingWikilink, workspaceId]);

  const wikilinkCount = useMemo(() => extractWikilinks(body).length, [body]);

  // MEM-8 — replace the editor body with a chosen template's body. The
  // auto-save effect persists the change like any other edit (read-only notes
  // never reach this — the button isn't rendered for them).
  const onInsertTemplate = useCallback((templateBody: string) => {
    setTemplateMenuOpen(false);
    setBody(templateBody);
  }, []);

  // MEM-9 — scroll the editor textarea so a clicked outline heading sits at the
  // top. Mono, non-wrapping editor → lineIndex × lineHeight is the row offset.
  const onOutlineJump = useCallback((lineIndex: number) => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.scrollTop = scrollTopForLine(lineIndex, EDITOR_LINE_HEIGHT);
  }, []);

  // MEM-8 — the available template notes (filtered upstream; defensive here).
  const availableTemplates = useMemo(
    () => (readOnly ? [] : (templates ?? []).filter((t) => t.id !== memory?.id)),
    [templates, readOnly, memory?.id],
  );

  const toggleSidePanel = useCallback((panel: 'properties' | 'outline') => {
    setSidePanel((cur) => (cur === panel ? 'none' : panel));
  }, []);

  // MEM-1 — read-only chip label, e.g. "agent memory · patterns · 0.62".
  const readOnlyChip = useMemo(() => {
    if (!readOnly) return null;
    const parts = ['agent memory'];
    if (readOnlyMeta?.namespace) parts.push(readOnlyMeta.namespace);
    if (typeof readOnlyMeta?.score === 'number') parts.push(readOnlyMeta.score.toFixed(2));
    return parts.join(' · ');
  }, [readOnly, readOnlyMeta]);

  if (!memory) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select or create a note to start writing.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <div className="flex-1 truncate">
          <div className="text-sm font-semibold text-foreground">{memory.name}</div>
          <div className="text-muted-foreground">
            {wikilinkCount} wikilinks · updated {new Date(memory.updatedAt).toLocaleString()}
            {busy ? ' · saving…' : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
          className="flex items-center gap-1 rounded border border-input bg-background px-2 py-1 hover:bg-accent"
          title="Toggle preview"
        >
          {mode === 'edit' ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
          {mode === 'edit' ? 'Preview' : 'Edit'}
        </button>
        {/* MEM-8 — Insert template (only when ≥1 template note exists + editable). */}
        {availableTemplates.length > 0 ? (
          <Popover open={templateMenuOpen} onOpenChange={setTemplateMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="insert-template-trigger"
                className="flex items-center gap-1 rounded border border-input bg-background px-2 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title="Replace the body with a template"
              >
                <FilePlus2 className="h-3.5 w-3.5" /> Template
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-1">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Insert template
              </div>
              <ul className="max-h-64 overflow-y-auto">
                {availableTemplates.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      data-testid={`insert-template-${t.name}`}
                      onClick={() => onInsertTemplate(t.body)}
                      className="block w-full truncate rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {t.name}
                    </button>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        ) : null}
        {/* MEM-9 — Properties + Outline panel toggles. */}
        <button
          type="button"
          data-testid="toggle-properties"
          aria-pressed={sidePanel === 'properties'}
          onClick={() => toggleSidePanel('properties')}
          className={cn(
            'flex items-center gap-1 rounded border border-input px-2 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            sidePanel === 'properties' ? 'bg-accent text-accent-foreground' : 'bg-background',
          )}
          title="Toggle the properties editor"
        >
          <Hash className="h-3.5 w-3.5" /> Props
        </button>
        <button
          type="button"
          data-testid="toggle-outline"
          aria-pressed={sidePanel === 'outline'}
          onClick={() => toggleSidePanel('outline')}
          className={cn(
            'flex items-center gap-1 rounded border border-input px-2 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            sidePanel === 'outline' ? 'bg-accent text-accent-foreground' : 'bg-background',
          )}
          title="Toggle the document outline"
        >
          <PanelRight className="h-3.5 w-3.5" /> Outline
        </button>
        {readOnly ? (
          // MEM-1 — agent-authored Ruflo entry: a read-only chip in place of
          // Save/Delete. No write/destructive action is reachable.
          <span
            data-testid="readonly-chip"
            className="flex items-center gap-1 rounded border border-input bg-muted px-2 py-1 text-muted-foreground"
            title="Read-only agent memory"
          >
            <Lock className="h-3.5 w-3.5" /> {readOnlyChip}
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void saveNow()}
              disabled={busy}
              className="flex items-center gap-1 rounded border border-input bg-background px-2 py-1 hover:bg-accent disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" /> Save
            </button>
            <button
              type="button"
              onClick={() => void onDelete()}
              className="flex items-center gap-1 rounded border border-destructive/40 bg-background px-2 py-1 text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          </>
        )}
      </div>

      {/* BUG-11 — the open note changed on disk while we held unsaved edits.
          Non-destructive: nothing is overwritten until the user clicks Reload. */}
      {staleOnDisk ? (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400">
          <span className="flex-1">
            This note changed on disk — your local edits are unsaved.
          </span>
          <button
            type="button"
            onClick={reloadFromDisk}
            className="flex items-center gap-1 rounded border border-amber-500/40 bg-background px-2 py-1 font-medium hover:bg-amber-500/10"
          >
            <RotateCw className="h-3.5 w-3.5" /> Reload
          </button>
        </div>
      ) : null}

      {readOnly ? null : (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
          <Hash className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="comma-separated tags"
            className="flex-1 rounded border border-input bg-background px-2 py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      )}

      {err ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-xs text-destructive">
          {err}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          {mode === 'edit' ? (
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              readOnly={readOnly}
              spellCheck={!readOnly}
              wrap="off"
              className={cn(
                'h-full w-full resize-none whitespace-pre overflow-auto border-0 bg-transparent p-3 font-mono text-xs leading-relaxed outline-none',
                readOnly && 'cursor-default text-muted-foreground',
              )}
              placeholder="Write markdown. Wrap a name in [[double brackets]] to link to another note."
            />
          ) : (
            <PreviewPane body={body} knownNames={knownNames} onWikilinkClick={onWikilinkClick} />
          )}
        </div>
        {/* MEM-9 — optional right-side editor panel. */}
        {sidePanel === 'properties' ? (
          <div className="w-64 shrink-0">
            <PropertiesPanel body={body} onBodyChange={setBody} readOnly={readOnly} />
          </div>
        ) : null}
        {sidePanel === 'outline' ? (
          <div className="w-56 shrink-0">
            <OutlineRail body={body} onJump={onOutlineJump} />
          </div>
        ) : null}
      </div>

      {/* UX-3 — themed destructive delete confirm (replaces window.confirm). */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{memory.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the note. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* UX-3 — themed "create missing note?" confirm (replaces
          window.confirm). Constructive action, so the default (non-red)
          button variant is used. */}
      <AlertDialog
        open={pendingWikilink !== null}
        onOpenChange={(o) => {
          if (!o) setPendingWikilink(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create new note &ldquo;{pendingWikilink}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This note does not exist yet. Create it and open it now?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmCreateWikilink();
              }}
            >
              Create note
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PreviewPane({
  body,
  knownNames,
  onWikilinkClick,
}: {
  body: string;
  knownNames: Set<string>;
  onWikilinkClick(target: string): void;
}) {
  const chunks = useMemo(() => renderChunks(body), [body]);
  return (
    <div className="h-full overflow-y-auto p-3 text-xs leading-relaxed text-foreground">
      <pre className="whitespace-pre-wrap break-words font-sans">
        {chunks.map((chunk, i) =>
          chunk.kind === 'text' ? (
            <span key={i}>{chunk.value}</span>
          ) : (
            <button
              key={i}
              type="button"
              onClick={() => onWikilinkClick(chunk.target)}
              className={cn(
                'mx-0.5 inline-flex items-center rounded border px-1 py-0.5 text-[11px] font-medium',
                knownNames.has(chunk.target.toLowerCase())
                  ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20',
              )}
            >
              {chunk.alias ?? chunk.target}
            </button>
          ),
        )}
      </pre>
    </div>
  );
}
