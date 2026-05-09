// Drop zone for SKILL.md folders. The renderer cannot read folder contents
// through the contextIsolation bridge directly, so we use the HTML5 drag/drop
// `webkitGetAsEntry()` API to walk the top level of the dropped folder, find
// `SKILL.md`, and resolve its absolute path through the preload's
// `webUtils.getPathForFile`. The skill root is the parent of that file path —
// the main process reads everything else.

import { useCallback, useRef, useState, type DragEvent } from 'react';
import { FolderUp, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DropZoneProps {
  busy?: boolean;
  /** Called when a folder containing SKILL.md is detected. */
  onFolderDetected: (skillRootAbsPath: string) => void;
  /** Called when an absolute path was discovered but no SKILL.md was found. */
  onError: (message: string) => void;
}

interface FileSystemEntryShim {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}

interface FileSystemFileEntryShim extends FileSystemEntryShim {
  file: (cb: (file: File) => void, err?: (e: unknown) => void) => void;
}

interface FileSystemDirectoryEntryShim extends FileSystemEntryShim {
  createReader: () => {
    readEntries: (cb: (entries: FileSystemEntryShim[]) => void, err?: (e: unknown) => void) => void;
  };
}

function isDirectory(entry: FileSystemEntryShim): entry is FileSystemDirectoryEntryShim {
  return entry.isDirectory === true;
}
function isFile(entry: FileSystemEntryShim): entry is FileSystemFileEntryShim {
  return entry.isFile === true;
}

function readDirectoryShallow(dir: FileSystemDirectoryEntryShim): Promise<FileSystemEntryShim[]> {
  return new Promise<FileSystemEntryShim[]>((resolve) => {
    const reader = dir.createReader();
    const all: FileSystemEntryShim[] = [];
    const pump = () => {
      reader.readEntries(
        (chunk) => {
          if (!chunk || chunk.length === 0) {
            resolve(all);
            return;
          }
          all.push(...chunk);
          pump();
        },
        () => resolve(all),
      );
    };
    pump();
  });
}

function readEntryFile(entry: FileSystemFileEntryShim): Promise<File | null> {
  return new Promise<File | null>((resolve) => {
    entry.file(
      (f) => resolve(f),
      () => resolve(null),
    );
  });
}

function getEntryFromItem(item: DataTransferItem): FileSystemEntryShim | null {
  // webkitGetAsEntry is the de-facto standard despite the prefix.
  const fn = (item as unknown as { webkitGetAsEntry?: () => FileSystemEntryShim | null }).webkitGetAsEntry;
  if (!fn) return null;
  try {
    return fn.call(item) ?? null;
  } catch {
    return null;
  }
}

export function DropZone({ busy, onFolderDetected, onError }: DropZoneProps) {
  const [hover, setHover] = useState(false);
  const lastEnterTarget = useRef<EventTarget | null>(null);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    lastEnterTarget.current = e.target;
    setHover(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (e.target === lastEnterTarget.current) setHover(false);
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setHover(false);
      const items = e.dataTransfer?.items;
      if (!items || items.length === 0) {
        onError('No files dropped.');
        return;
      }

      // Walk just the first item — multi-skill plugin layouts are deferred.
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it) continue;
        const entry = getEntryFromItem(it);
        if (!entry) continue;

        if (isDirectory(entry)) {
          // Look for SKILL.md at the top level. We need to surface a real
          // File for the preload's getPathForFile call.
          const children = await readDirectoryShallow(entry);
          const skillEntry = children.find(
            (c): c is FileSystemFileEntryShim => isFile(c) && c.name === 'SKILL.md',
          );
          if (!skillEntry) {
            onError(`No SKILL.md found at the top level of "${entry.name}".`);
            return;
          }
          const file = await readEntryFile(skillEntry);
          if (!file) {
            onError('Could not read SKILL.md from the dropped folder.');
            return;
          }
          const absPath = window.sigma.getPathForFile(file);
          if (!absPath) {
            onError('Could not resolve absolute path. Try dropping the folder again.');
            return;
          }
          // Skill root is the parent of SKILL.md.
          const sep = absPath.includes('\\') ? '\\' : '/';
          const skillRoot = absPath.substring(0, absPath.lastIndexOf(sep));
          onFolderDetected(skillRoot);
          return;
        }

        // Single SKILL.md drop — treat the parent folder as the skill root.
        if (isFile(entry) && entry.name === 'SKILL.md') {
          const file = await readEntryFile(entry);
          if (!file) {
            onError('Could not read the dropped SKILL.md.');
            return;
          }
          const absPath = window.sigma.getPathForFile(file);
          if (!absPath) {
            onError('Could not resolve absolute path for SKILL.md.');
            return;
          }
          const sep = absPath.includes('\\') ? '\\' : '/';
          const skillRoot = absPath.substring(0, absPath.lastIndexOf(sep));
          onFolderDetected(skillRoot);
          return;
        }
      }

      onError('Drop a folder containing SKILL.md (or a SKILL.md file).');
    },
    [onFolderDetected, onError],
  );

  return (
    <div
      role="region"
      aria-label="Skill drop zone"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'flex h-24 w-full items-center justify-center rounded-md border-2 border-dashed border-border bg-muted/20 text-sm text-muted-foreground transition',
        hover && !busy && 'border-primary bg-primary/5 text-foreground',
        busy && 'cursor-progress opacity-70',
      )}
    >
      {busy ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Installing skill…</span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <FolderUp className="h-4 w-4" />
          <span>Drop a folder containing SKILL.md, or a SKILL.md file, to install.</span>
        </div>
      )}
    </div>
  );
}
