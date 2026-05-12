// Markdown-ish editor with a live preview pane. Wikilinks in the preview
// become buttons that switch the active note (creating a new one when the
// target doesn't exist, after a confirm prompt). For v1 we use a plain
// textarea + a simple markdown-light preview; Monaco / CodeMirror can land
// in a future phase.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Save, Trash2, Eye, Pencil, Hash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import type { Memory } from '@/shared/types';
import { extractWikilinks, renderChunks } from './wikilink';

interface Props {
  workspaceId: string;
  memory: Memory | null;
  knownNames: Set<string>;
  onNavigate(name: string): void;
  onSaved(memory: Memory): void;
  onDeleted(memoryId: string): void;
}

const SAVE_DEBOUNCE_MS = 600;

export function MemoryEditor({
  workspaceId,
  memory,
  knownNames,
  onNavigate,
  onSaved,
  onDeleted,
}: Props) {
  const [body, setBody] = useState(memory?.body ?? '');
  const [tags, setTags] = useState(memory?.tags.join(', ') ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const dirtyRef = useRef(false);
  const lastSentRef = useRef({ body: memory?.body ?? '', tags: memory?.tags.join(', ') ?? '' });

  useEffect(() => {
    const nextBody = memory?.body ?? '';
    const nextTags = memory?.tags.join(', ') ?? '';
    queueMicrotask(() => {
      setBody(nextBody);
      setTags(nextTags);
      setErr(null);
      dirtyRef.current = false;
      lastSentRef.current = { body: nextBody, tags: nextTags };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory?.id]);

  const saveNow = useCallback(
    async (override?: { body?: string; tags?: string }) => {
      if (!memory) return;
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
        lastSentRef.current = { body: nextBody, tags: nextTags };
        dirtyRef.current = false;
        onSaved(updated);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [body, memory, onSaved, tags, workspaceId],
  );

  // Auto-save with debounce on body/tag changes.
  useEffect(() => {
    if (!memory) return;
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
  }, [body, tags, memory, saveNow]);

  const onDelete = useCallback(async () => {
    if (!memory) return;
    if (!window.confirm(`Delete "${memory.name}"? This cannot be undone.`)) return;
    try {
      await rpc.memory.delete_memory({ workspaceId, name: memory.name });
      onDeleted(memory.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [memory, onDeleted, workspaceId]);

  const onWikilinkClick = useCallback(
    async (target: string) => {
      const exists = knownNames.has(target.toLowerCase());
      if (!exists) {
        const ok = window.confirm(`Create new note "${target}"?`);
        if (!ok) return;
        try {
          await rpc.memory.create_memory({ workspaceId, name: target });
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
          return;
        }
      }
      onNavigate(target);
    },
    [knownNames, onNavigate, workspaceId],
  );

  const wikilinkCount = useMemo(() => extractWikilinks(body).length, [body]);

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
      </div>

      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <Hash className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="comma-separated tags"
          className="flex-1 rounded border border-input bg-background px-2 py-1 outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {err ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-xs text-destructive">
          {err}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {mode === 'edit' ? (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck
            className="h-full w-full resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed outline-none"
            placeholder="Write markdown. Wrap a name in [[double brackets]] to link to another note."
          />
        ) : (
          <PreviewPane body={body} knownNames={knownNames} onWikilinkClick={onWikilinkClick} />
        )}
      </div>
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
