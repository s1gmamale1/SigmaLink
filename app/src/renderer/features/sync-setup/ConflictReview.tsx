// v1.5.0 packet 09 — ConflictReview component.
//
// Shows a side-by-side diff of conflicting rows.
// User picks "keep local" or "keep remote" for each conflict.

import { useState, useCallback } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import type { SyncConflict } from '@/shared/types';
import { AlertTriangle, CheckCircle2, ChevronLeft } from 'lucide-react';

interface ConflictReviewProps {
  conflicts: SyncConflict[];
  onResolved: () => void;
  onBack: () => void;
}

type Resolution = 'keep_local' | 'keep_remote';

export function ConflictReview({ conflicts, onResolved, onBack }: ConflictReviewProps) {
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allResolved = conflicts.length > 0 && conflicts.every((c) => resolutions[c.id]);

  const handleResolve = useCallback(
    (conflictId: string, resolution: Resolution) => {
      setResolutions((prev) => ({ ...prev, [conflictId]: resolution }));
    },
    [],
  );

  const handleApply = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      for (const [conflictId, resolution] of Object.entries(resolutions)) {
        await rpc.sync.resolveConflict({ conflictId, resolution });
      }
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [resolutions, onResolved]);

  if (conflicts.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h3 className="text-sm font-semibold">Conflict review</h3>
        </div>
        <div className="flex items-center gap-2 text-sm text-green-500">
          <CheckCircle2 className="h-4 w-4" />
          No conflicts to review.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h3 className="text-sm font-semibold">
          Conflict review ({conflicts.length} unresolved)
        </h3>
      </div>

      <p className="text-xs text-muted-foreground">
        These rows were edited on two devices simultaneously. Choose which version to keep.
        The other version will be discarded.
      </p>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="space-y-4">
        {conflicts.map((conflict) => (
          <ConflictCard
            key={conflict.id}
            conflict={conflict}
            resolution={resolutions[conflict.id]}
            onChoose={(r) => handleResolve(conflict.id, r)}
          />
        ))}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          onClick={onBack}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="apply-resolutions-btn"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          disabled={!allResolved || saving}
          onClick={() => void handleApply()}
        >
          {saving ? 'Applying…' : `Apply ${Object.keys(resolutions).length} resolution${Object.keys(resolutions).length !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
}

interface ConflictCardProps {
  conflict: SyncConflict;
  resolution: Resolution | undefined;
  onChoose: (r: Resolution) => void;
}

function ConflictCard({ conflict, resolution, onChoose }: ConflictCardProps) {
  const localObj = tryParse(conflict.localRowJson);
  const remoteObj = tryParse(conflict.remoteRowJson);

  return (
    <div className="rounded-md border border-border bg-muted/10 overflow-hidden">
      <div className="border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium">
        <span className="text-muted-foreground">{conflict.tableName}</span>
        <span className="mx-1 text-muted-foreground">/</span>
        <span className="font-mono">{conflict.rowId}</span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-border">
        <VersionPane
          label="Local version"
          data={localObj}
          selected={resolution === 'keep_local'}
          onSelect={() => onChoose('keep_local')}
          testId={`keep-local-${conflict.id}`}
        />
        <VersionPane
          label="Remote version"
          data={remoteObj}
          selected={resolution === 'keep_remote'}
          onSelect={() => onChoose('keep_remote')}
          testId={`keep-remote-${conflict.id}`}
        />
      </div>
    </div>
  );
}

interface VersionPaneProps {
  label: string;
  data: Record<string, unknown> | null;
  selected: boolean;
  onSelect: () => void;
  testId: string;
}

function VersionPane({ label, data, selected, onSelect, testId }: VersionPaneProps) {
  return (
    <div
      className={`p-3 space-y-2 cursor-pointer transition-colors ${selected ? 'bg-primary/10' : 'hover:bg-muted/20'}`}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        {selected && <CheckCircle2 className="h-3.5 w-3.5 text-primary" />}
      </div>
      <pre className="max-h-48 overflow-auto rounded bg-muted/30 p-2 text-xs font-mono whitespace-pre-wrap break-all">
        {data
          ? JSON.stringify(data, null, 2)
          : <span className="text-muted-foreground italic">deleted / empty</span>}
      </pre>
      <button
        type="button"
        data-testid={testId}
        className={`w-full rounded-sm border px-2 py-1 text-xs font-medium transition-colors ${
          selected
            ? 'border-primary bg-primary/20 text-primary'
            : 'border-border hover:border-primary hover:text-primary'
        }`}
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
      >
        {selected ? 'Selected' : 'Keep this version'}
      </button>
    </div>
  );
}

function tryParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
