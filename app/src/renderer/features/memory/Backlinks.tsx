// Backlinks panel — lists every memory whose body contains a [[wikilink]]
// pointing at the current note. Stays in lockstep with the DB by re-fetching
// whenever the active note name changes or the global memory list changes.
//
// MEM-7 — a second "Unlinked mentions" section lists notes that mention this
// note's name/alias as PLAIN TEXT (no `[[link]]` yet). Each row has a "Link"
// button that promotes the first plain-text mention in the SOURCE note's body
// to a real `[[name]]` wikilink (via `update_memory`).

import { useCallback, useEffect, useState } from 'react';
import { Link2, Link as LinkIcon } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import type { Memory, MemoryUnlinkedMention } from '@/shared/types';
import { extractWikilinks } from './wikilink';

/**
 * MEM-7 — promote the FIRST plain-text mention of `name` in `body` to a real
 * `[[name]]` wikilink. Returns `body` unchanged when there's no eligible
 * mention (already linked, inside a code fence, or absent).
 *
 * "Eligible" = a whole-word, case-insensitive occurrence of `name` that does
 * NOT already sit inside an existing `[[...]]` span (so we never double-wrap a
 * link or its alias text). We reuse the fence-aware wikilink extractor to find
 * the spans to avoid; the search itself is a simple word-boundary scan.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, exported for unit tests
export function promoteMentionToLink(body: string, name: string): string {
  if (!body || !name) return body;
  // Ranges already occupied by `[[...]]` links — skip matches that fall inside.
  const linkRanges = extractWikilinks(body).map((l) => l.range);
  const inLink = (idx: number): boolean =>
    linkRanges.some(([s, e]) => idx >= s && idx < e);

  const lower = body.toLowerCase();
  const target = name.toLowerCase();
  const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}_]/u.test(ch);

  let from = 0;
  while (from <= lower.length) {
    const idx = lower.indexOf(target, from);
    if (idx === -1) break;
    const before = body[idx - 1];
    const after = body[idx + name.length];
    const wholeWord = !isWordChar(before) && !isWordChar(after);
    if (wholeWord && !inLink(idx)) {
      // Preserve the original casing of the matched text inside the link.
      const matched = body.slice(idx, idx + name.length);
      const linkText = matched === name ? `[[${name}]]` : `[[${name}|${matched}]]`;
      return body.slice(0, idx) + linkText + body.slice(idx + name.length);
    }
    from = idx + name.length;
  }
  return body;
}

interface Props {
  workspaceId: string;
  noteName: string | null;
  memoriesVersion: number; // bump to refresh
  /** MEM-7 — the in-memory note list, so a promote can read the source body. */
  memories: Memory[];
  onSelect(name: string): void;
}

export function Backlinks({ workspaceId, noteName, memoriesVersion, memories, onSelect }: Props) {
  const [items, setItems] = useState<Memory[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // MEM-7 — unlinked mentions for the active note.
  const [mentions, setMentions] = useState<MemoryUnlinkedMention[]>([]);
  // Per-source in-flight guard so a double-click can't fire two promotes.
  const [promoting, setPromoting] = useState<string | null>(null);

  useEffect(() => {
    if (!noteName) {
      queueMicrotask(() => {
        setItems([]);
        setMentions([]);
      });
      return;
    }
    let alive = true;
    queueMicrotask(() => {
      setBusy(true);
      setErr(null);
    });
    void (async () => {
      try {
        // Backlinks + unlinked mentions in parallel; a mentions failure must
        // not blank the backlinks (allSettled, not Promise.all).
        const [backlinks, unlinked] = await Promise.allSettled([
          rpc.memory.find_backlinks({ workspaceId, name: noteName }),
          rpc.memory.find_unlinked_mentions({ workspaceId, name: noteName }),
        ]);
        if (!alive) return;
        if (backlinks.status === 'fulfilled') setItems(backlinks.value);
        else setErr(backlinks.reason instanceof Error ? backlinks.reason.message : String(backlinks.reason));
        setMentions(unlinked.status === 'fulfilled' ? unlinked.value : []);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, noteName, memoriesVersion]);

  // MEM-7 — promote a plain-text mention in `sourceName`'s body to `[[noteName]]`.
  const onPromote = useCallback(
    async (mention: MemoryUnlinkedMention) => {
      if (!noteName) return;
      const source = memories.find((m) => m.id === mention.sourceId);
      if (!source) return;
      const nextBody = promoteMentionToLink(source.body, noteName);
      // No change found (already linked / mention vanished) → drop the row.
      if (nextBody === source.body) {
        setMentions((cur) => cur.filter((m) => m.sourceId !== mention.sourceId));
        return;
      }
      setPromoting(mention.sourceId);
      try {
        await rpc.memory.update_memory({
          workspaceId,
          name: source.name,
          body: nextBody,
        });
        // Optimistically drop the promoted source; `memory:changed` + the
        // memoriesVersion bump will re-fetch the authoritative list.
        setMentions((cur) => cur.filter((m) => m.sourceId !== mention.sourceId));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setPromoting(null);
      }
    },
    [memories, noteName, workspaceId],
  );

  if (!noteName) return null;

  return (
    <div className="flex h-full flex-col border-l border-border bg-card text-xs">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 font-medium">
        <Link2 className="h-3.5 w-3.5" />
        <span>Backlinks</span>
        <span className="text-muted-foreground">({items.length})</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {busy ? <div className="text-muted-foreground">Loading…</div> : null}
        {err ? <div className="text-destructive">{err}</div> : null}
        {!busy && !err && items.length === 0 ? (
          <div className="text-muted-foreground">No notes link here yet.</div>
        ) : null}
        <ul className="space-y-1">
          {items.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onSelect(m.name)}
                className="flex w-full flex-col rounded border border-transparent px-2 py-1 text-left hover:border-border hover:bg-accent/40"
              >
                <span className="font-medium text-foreground">{m.name}</span>
                {m.tags.length ? (
                  <span className="text-[10px] text-muted-foreground">
                    {m.tags.join(' · ')}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>

        {/* MEM-7 — unlinked mentions: plain-text references promotable to links. */}
        {mentions.length > 0 ? (
          <div data-testid="unlinked-mentions" className="mt-4">
            <div className="mb-1 flex items-center gap-2 font-medium">
              <LinkIcon className="h-3.5 w-3.5" />
              <span>Unlinked mentions</span>
              <span className="text-muted-foreground">({mentions.length})</span>
            </div>
            <ul className="space-y-1">
              {mentions.map((mention) => (
                <li
                  key={mention.sourceId}
                  className="flex items-start gap-2 rounded border border-transparent px-2 py-1 hover:border-border hover:bg-accent/40"
                >
                  <button
                    type="button"
                    onClick={() => onSelect(mention.sourceName)}
                    className="flex min-w-0 flex-1 flex-col text-left"
                  >
                    <span className="truncate font-medium text-foreground">
                      {mention.sourceName}
                    </span>
                    {mention.excerpt ? (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {mention.excerpt}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    data-testid={`link-mention-${mention.sourceId}`}
                    disabled={promoting === mention.sourceId}
                    onClick={() => void onPromote(mention)}
                    title={`Link this mention to "${noteName}"`}
                    className="shrink-0 rounded border border-input bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    Link
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
