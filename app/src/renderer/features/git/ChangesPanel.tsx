// BSP-G2 — Changes panel: staged / unstaged / untracked file groups.
// Clicking a file in the Staged or Unstaged group fetches the corresponding diff
// and passes it up via `onDiffRequest` so the parent can show it in DiffView.

import { useState } from 'react';
import { FilePlus, FileMinus, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import type { GitDiff, GitStatus } from '@/shared/types';

interface Props {
  status: GitStatus | null;
  repoRoot: string;
  onDiff: (diff: GitDiff | null) => void;
}

type FileGroup = 'staged' | 'unstaged' | 'untracked';

function FileRow({
  file,
  group,
  active,
  onClick,
}: {
  file: string;
  group: FileGroup;
  active: boolean;
  onClick: () => void;
}) {
  const icon =
    group === 'staged' ? (
      <FilePlus className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
    ) : group === 'unstaged' ? (
      <FileMinus className="h-3.5 w-3.5 shrink-0 text-amber-500" />
    ) : (
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    );

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-1.5 px-3 py-[3px] text-left text-xs',
        active ? 'bg-accent/40 text-foreground' : 'hover:bg-accent/20 text-muted-foreground hover:text-foreground',
      )}
      title={file}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate font-mono">{file}</span>
    </button>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <span>{label}</span>
      <span className="rounded-full bg-muted px-1.5 py-px text-[10px]">{count}</span>
    </div>
  );
}

export function ChangesPanel({ status, repoRoot, onDiff }: Props) {
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!status) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        No workspace open.
      </div>
    );
  }

  if (status.clean) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Working tree is clean.
      </div>
    );
  }

  async function handleFileClick(file: string, group: FileGroup) {
    setActiveFile(file);
    if (group === 'untracked') {
      onDiff(null);
      return;
    }
    setLoading(true);
    try {
      const diff =
        group === 'staged'
          ? await rpc.git.diffStaged(repoRoot)
          : await rpc.git.diffUnstaged(repoRoot);
      onDiff(diff);
    } catch {
      onDiff(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {loading ? (
        <div className="px-3 py-1 text-[10px] text-muted-foreground">Loading diff…</div>
      ) : null}

      {status.staged.length > 0 && (
        <div>
          <SectionHeader label="Staged" count={status.staged.length} />
          {status.staged.map((f) => (
            <FileRow
              key={`staged:${f}`}
              file={f}
              group="staged"
              active={activeFile === f}
              onClick={() => void handleFileClick(f, 'staged')}
            />
          ))}
        </div>
      )}

      {status.unstaged.length > 0 && (
        <div>
          <SectionHeader label="Unstaged" count={status.unstaged.length} />
          {status.unstaged.map((f) => (
            <FileRow
              key={`unstaged:${f}`}
              file={f}
              group="unstaged"
              active={activeFile === f}
              onClick={() => void handleFileClick(f, 'unstaged')}
            />
          ))}
        </div>
      )}

      {status.untracked.length > 0 && (
        <div>
          <SectionHeader label="Untracked" count={status.untracked.length} />
          {status.untracked.map((f) => (
            <FileRow
              key={`untracked:${f}`}
              file={f}
              group="untracked"
              active={activeFile === f}
              onClick={() => void handleFileClick(f, 'untracked')}
            />
          ))}
        </div>
      )}
    </div>
  );
}
