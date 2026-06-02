// MEM-9 — Properties editor. An editable key/value grid backed by the open
// note's leading `---` frontmatter block. Edits are reflected back into the
// editor's body state (debounced by the parent) by re-splicing the block via
// `applyFrontmatter` — the panel itself never writes RPC; it hands the parent a
// new body string and the MemoryEditor auto-save path persists it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  applyFrontmatter,
  isFrontmatterFlat,
  parseFrontmatter,
  recordToRows,
  rowsToRecord,
  type PropertyRow,
} from './frontmatter';

interface Props {
  /** The full editor body (incl. any leading frontmatter block). */
  body: string;
  /** Hand the parent a new body with the frontmatter block re-spliced. */
  onBodyChange: (nextBody: string) => void;
  /** Disable editing for read-only (agent) notes. */
  readOnly?: boolean;
}

export function PropertiesPanel({ body, onBodyChange, readOnly = false }: Props) {
  // Parse the body's frontmatter into editable rows. We hold the rows in local
  // state so typing is responsive; an external body change (note switch /
  // reload) re-seeds them. We DON'T re-seed from our own edits — `lastEmitted`
  // tracks the body we last produced so the round-trip doesn't clobber the
  // row the user is mid-typing.
  const seeded = useMemo(() => recordToRows(parseFrontmatter(body).frontmatter), [body]);
  const [rows, setRows] = useState<PropertyRow[]>(seeded);
  const lastEmittedRef = useRef<string | null>(null);

  // H1 (review) — the flat parser would DESTROY rich frontmatter (multi-line
  // block scalars, `-` lists, nested maps) on write-back. When the block isn't
  // faithfully flat we force read-only and tell the user to edit it in the body,
  // so a property edit can never silently corrupt the canonical note content.
  const isFlat = useMemo(() => isFrontmatterFlat(body), [body]);
  const lockedByRich = !isFlat;
  const effectiveReadOnly = readOnly || lockedByRich;

  useEffect(() => {
    // Re-seed only when the incoming body is NOT the one we just emitted (i.e.
    // a genuine external change, not the echo of our own splice).
    if (body === lastEmittedRef.current) return;
    queueMicrotask(() => setRows(recordToRows(parseFrontmatter(body).frontmatter)));
  }, [body]);

  const commit = (nextRows: PropertyRow[]) => {
    setRows(nextRows);
    const nextBody = applyFrontmatter(body, rowsToRecord(nextRows));
    lastEmittedRef.current = nextBody;
    onBodyChange(nextBody);
  };

  const updateRow = (idx: number, patch: Partial<PropertyRow>) => {
    commit(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const addRow = () => commit([...rows, { key: '', value: '' }]);
  const removeRow = (idx: number) => commit(rows.filter((_, i) => i !== idx));

  return (
    <div
      data-testid="properties-panel"
      className="flex h-full min-h-0 flex-col border-l border-border bg-card text-xs"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="font-medium text-foreground">Properties</span>
        {!effectiveReadOnly ? (
          <button
            type="button"
            onClick={addRow}
            title="Add property"
            aria-label="Add property"
            data-testid="properties-add"
            className="rounded border border-input bg-background px-1.5 py-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Plus className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {lockedByRich ? (
          <div
            className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400"
            data-testid="properties-rich-notice"
          >
            This note has structured frontmatter (lists, multi-line, or nested
            values). Edit it directly in the body to avoid losing formatting.
          </div>
        ) : null}
        {rows.length === 0 ? (
          <div className="px-1 py-2 text-muted-foreground">
            {effectiveReadOnly ? 'No properties.' : 'No properties yet. Click + to add one.'}
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row, idx) => (
              <li key={idx} className="flex items-center gap-1">
                <input
                  type="text"
                  value={row.key}
                  readOnly={effectiveReadOnly}
                  onChange={(e) => updateRow(idx, { key: e.target.value })}
                  placeholder="key"
                  aria-label={`Property ${idx + 1} key`}
                  className="w-24 shrink-0 rounded border border-input bg-background px-1.5 py-1 font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring read-only:opacity-70"
                />
                <input
                  type="text"
                  value={row.value}
                  readOnly={effectiveReadOnly}
                  onChange={(e) => updateRow(idx, { value: e.target.value })}
                  placeholder="value"
                  aria-label={`Property ${idx + 1} value`}
                  className="min-w-0 flex-1 rounded border border-input bg-background px-1.5 py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring read-only:opacity-70"
                />
                {!effectiveReadOnly ? (
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    title="Remove property"
                    aria-label={`Remove property ${idx + 1}`}
                    className="shrink-0 rounded border border-transparent px-1 py-1 text-muted-foreground hover:border-destructive/40 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
