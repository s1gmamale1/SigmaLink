// Hand-rolled diff renderer: file tree on the left + patch on the right.
// We avoid pulling in `react-diff-viewer-continued` to keep the bundle small;
// the renderer streams the raw `git diff HEAD` output and parses hunks for a
// simple split-or-unified visualisation.

import { useMemo, useState } from 'react';
import { ChevronRight, FileDiff, FilePlus, FileMinus, FileText, Files, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DiffFileSummary, ReviewDiff } from '@/shared/types';

interface Props {
  diff: ReviewDiff | null;
  loading?: boolean;
}

interface ParsedFile {
  path: string;
  oldPath?: string;
  hunks: Array<{ header: string; lines: Array<{ kind: ' ' | '+' | '-'; text: string }> }>;
  isBinary?: boolean;
}

function parsePatches(patches: string): ParsedFile[] {
  if (!patches) return [];
  const out: ParsedFile[] = [];
  let cur: ParsedFile | null = null;
  let curHunk: ParsedFile['hunks'][number] | null = null;
  const lines = patches.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      if (cur) out.push(cur);
      // diff --git a/path b/path
      const m = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const newPath = m ? m[2] : 'unknown';
      const oldPath = m ? m[1] : undefined;
      cur = {
        path: newPath,
        oldPath: oldPath !== newPath ? oldPath : undefined,
        hunks: [],
      };
      curHunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('Binary files ')) {
      cur.isBinary = true;
      continue;
    }
    if (line.startsWith('@@')) {
      curHunk = { header: line, lines: [] };
      cur.hunks.push(curHunk);
      continue;
    }
    if (!curHunk) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    const c = line[0];
    if (c === '+' || c === '-' || c === ' ') {
      curHunk.lines.push({ kind: c as ' ' | '+' | '-', text: line.slice(1) });
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function DiffView(props: Props) {
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const parsed = useMemo(() => parsePatches(props.diff?.patches ?? ''), [props.diff?.patches]);

  // Combine status-only entries (untracked, deletions w/o patch) with the
  // parsed file list for the file tree.
  const allFiles: DiffFileSummary[] = props.diff?.files ?? [];

  const focused =
    parsed.find((f) => f.path === activeFile) ?? parsed[0] ?? null;

  if (props.loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading diff…
      </div>
    );
  }
  if (!props.diff) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Select a session with a worktree to see its diff.
      </div>
    );
  }
  if (props.diff.files.length === 0 && !props.diff.patches) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Worktree is clean — no diff against HEAD.
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-[11px]">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Files className="h-3.5 w-3.5" />
          <span>{allFiles.length} file{allFiles.length === 1 ? '' : 's'}</span>
          {props.diff.detached ? (
            <span className="rounded bg-amber-500/10 px-1.5 py-px text-amber-500">
              detached HEAD
            </span>
          ) : null}
          {props.diff.truncated ? (
            <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-px text-amber-500">
              <AlertTriangle className="h-3 w-3" /> diff truncated
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {(['unified', 'split'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px]',
                mode === m
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent/30',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-border text-xs">
          {allFiles.map((f) => (
            <button
              type="button"
              key={`${f.status}-${f.path}`}
              onClick={() => setActiveFile(f.path)}
              className={cn(
                'flex w-full items-center gap-1.5 px-2 py-1 text-left',
                focused?.path === f.path
                  ? 'bg-accent/40'
                  : 'hover:bg-accent/20',
              )}
            >
              <FileIconForStatus status={f.status} />
              <span className="flex-1 truncate" title={f.path}>{f.path}</span>
              <span className="text-emerald-500">+{f.additions}</span>
              <span className="text-red-500">-{f.deletions}</span>
            </button>
          ))}
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          {focused ? (
            <PatchPane file={focused} mode={mode} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              {allFiles.length > 0
                ? 'Select a file with patches to inspect.'
                : 'Worktree clean.'}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function FileIconForStatus({ status }: { status: DiffFileSummary['status'] }) {
  if (status === 'A' || status === 'U') return <FilePlus className="h-3.5 w-3.5 text-emerald-500" />;
  if (status === 'D') return <FileMinus className="h-3.5 w-3.5 text-red-500" />;
  if (status === 'R' || status === 'C') return <FileDiff className="h-3.5 w-3.5 text-blue-500" />;
  if (status === 'M') return <FileText className="h-3.5 w-3.5 text-amber-500" />;
  return <FileText className="h-3.5 w-3.5" />;
}

function PatchPane({ file, mode }: { file: ParsedFile; mode: 'unified' | 'split' }) {
  if (file.isBinary) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Binary file changed.
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto bg-background font-mono text-[12px]">
      {file.hunks.length === 0 ? (
        <div className="p-4 text-muted-foreground">No textual hunks.</div>
      ) : (
        file.hunks.map((h, i) =>
          mode === 'unified' ? (
            <UnifiedHunk key={i} header={h.header} lines={h.lines} />
          ) : (
            <SplitHunk key={i} header={h.header} lines={h.lines} />
          ),
        )
      )}
    </div>
  );
}

function UnifiedHunk({ header, lines }: { header: string; lines: ParsedFile['hunks'][number]['lines'] }) {
  return (
    <div className="border-b border-border/40">
      <div className="flex items-center gap-1 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
        <ChevronRight className="h-3 w-3" />
        <span>{header}</span>
      </div>
      <div>
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              'flex',
              l.kind === '+'
                ? 'bg-emerald-500/10'
                : l.kind === '-'
                ? 'bg-red-500/10'
                : '',
            )}
          >
            <span className="w-6 shrink-0 select-none text-center text-muted-foreground">
              {l.kind}
            </span>
            <pre className="whitespace-pre-wrap break-all px-2 py-px">{l.text}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function SplitHunk({ header, lines }: { header: string; lines: ParsedFile['hunks'][number]['lines'] }) {
  type Cell = { kind: ' ' | '+' | '-'; text: string };
  const pairs: Array<{ left?: Cell; right?: Cell }> = [];
  let i = 0;
  while (i < lines.length) {
    const l: Cell = lines[i];
    if (l.kind === ' ') {
      pairs.push({ left: l, right: { kind: ' ', text: l.text } });
      i++;
      continue;
    }
    if (l.kind === '-') {
      const next = lines[i + 1];
      if (next && next.kind === '+') {
        pairs.push({ left: l, right: next });
        i += 2;
        continue;
      }
      pairs.push({ left: l });
      i++;
      continue;
    }
    if (l.kind === '+') {
      pairs.push({ right: l });
      i++;
      continue;
    }
    i++;
  }
  return (
    <div className="border-b border-border/40">
      <div className="flex items-center gap-1 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
        <ChevronRight className="h-3 w-3" />
        <span>{header}</span>
      </div>
      <div className="grid grid-cols-2">
        {pairs.map((p, idx) => (
          <span key={idx} className="contents">
            <pre
              className={cn(
                'overflow-hidden whitespace-pre-wrap break-all border-r border-border/40 px-2 py-px',
                p.left?.kind === '-' && 'bg-red-500/10',
              )}
            >
              {p.left ? p.left.text : ''}
            </pre>
            <pre
              className={cn(
                'overflow-hidden whitespace-pre-wrap break-all px-2 py-px',
                p.right?.kind === '+' && 'bg-emerald-500/10',
              )}
            >
              {p.right ? p.right.text : ''}
            </pre>
          </span>
        ))}
      </div>
    </div>
  );
}
