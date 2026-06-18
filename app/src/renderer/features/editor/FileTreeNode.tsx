// Recursive tree node for FileTree — extracted to keep FileTree.tsx < 500 lines.

import { memo } from 'react';
import {
  ChevronRight,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { pathRelative } from '@/renderer/lib/path-relative';
import { fsPath } from './fs-path';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
}

export interface NodeProps {
  fullPath: string;
  name: string;
  type: 'file' | 'dir';
  depth: number;
  expanded: ReadonlySet<string>;
  childrenByPath: ReadonlyMap<string, DirEntry[]>;
  selectedPath: string | null;
  onToggle: (p: string) => void;
  onOpen: (p: string) => void;
  /** v1.4.8 drag-drop — passed through so the drag payload carries both paths. */
  workspaceId: string;
  rootPath: string;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (path: string, currentName: string) => void;
  onDelete: (path: string) => void;
  onMoveInto: (destDir: string, e: React.DragEvent) => void;
  dragOverDir: string | null;
  onDragOverDir: (dir: string | null) => void;
}

export const TreeNode = memo(function TreeNode(props: NodeProps) {
  const {
    fullPath,
    name,
    type,
    depth,
    expanded,
    childrenByPath,
    selectedPath,
    onToggle,
    onOpen,
    onNewFile,
    onNewFolder,
    onRename,
    onDelete,
    workspaceId,
    rootPath,
    onMoveInto,
    dragOverDir,
    onDragOverDir,
  } = props;

  const isOpen = expanded.has(fullPath);
  const isSelected = selectedPath === fullPath;
  const children = type === 'dir' && isOpen ? childrenByPath.get(fullPath) : undefined;
  // "Loading" = expanded directory whose children haven't landed yet.
  const isLoading = type === 'dir' && isOpen && !children;

  // Keep root row hidden — depth 0 is rendered by the parent header.
  const isRoot = depth === 0;

  // Create-target dir: this node's path when it's a directory, else its parent.
  const ownDir = type === 'dir' ? fullPath : fsPath.dirname(fullPath);

  return (
    <div role="treeitem" aria-expanded={type === 'dir' ? isOpen : undefined}>
      {!isRoot ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                // v1.4.8 — workspace-relative path via shared pathRelative helper.
                // Falls back to absolutePath when the file is outside the workspace root.
                const relativePath = pathRelative(fullPath, rootPath);
                e.dataTransfer.setData(
                  'application/sigmalink-file',
                  JSON.stringify({ absolutePath: fullPath, relativePath, workspaceId }),
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => (type === 'dir' ? onToggle(fullPath) : onOpen(fullPath))}
              onDoubleClick={() => type === 'dir' && onOpen(fullPath)}
              onDragOver={
                type === 'dir'
                  ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOverDir(fullPath); }
                  : undefined
              }
              onDragLeave={type === 'dir' ? () => onDragOverDir(null) : undefined}
              onDrop={type === 'dir' ? (e) => { e.stopPropagation(); onMoveInto(fullPath, e); } : undefined}
              className={cn(
                'group flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[12px] transition',
                'hover:bg-accent/30',
                isSelected && 'bg-accent text-accent-foreground',
                dragOverDir === fullPath && 'ring-1 ring-primary/60 bg-accent/40',
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
              title={fullPath}
            >
              {type === 'dir' ? (
                <ChevronRight
                  className={cn(
                    'h-3 w-3 shrink-0 text-muted-foreground transition',
                    isOpen && 'rotate-90',
                  )}
                  aria-hidden
                />
              ) : (
                <span className="inline-block w-3" aria-hidden />
              )}
              {type === 'dir' ? (
                isOpen ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )
              ) : (
                <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
              )}
              <span className="truncate">{name}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-44">
            <ContextMenuItem onSelect={() => onNewFile(ownDir)}>
              <FilePlus className="mr-2 h-3.5 w-3.5" /> New File
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onNewFolder(ownDir)}>
              <FolderPlus className="mr-2 h-3.5 w-3.5" /> New Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onRename(fullPath, name)}>
              <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onSelect={() => onDelete(fullPath)}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : null}
      {type === 'dir' && isOpen ? (
        <div role="group">
          {isLoading && !children ? (
            <div
              className="px-2 py-0.5 text-[11px] text-muted-foreground"
              style={{ paddingLeft: 16 + depth * 12 }}
            >
              Loading…
            </div>
          ) : children && children.length === 0 ? (
            <div
              className="px-2 py-0.5 text-[11px] text-muted-foreground/70"
              style={{ paddingLeft: 16 + depth * 12 }}
            >
              (empty)
            </div>
          ) : (
            children?.map((c) => {
              const childPath = fsPath.join(fullPath, c.name);
              return (
                <TreeNode
                  key={childPath}
                  fullPath={childPath}
                  name={c.name}
                  type={c.type}
                  depth={depth + 1}
                  expanded={expanded}
                  childrenByPath={childrenByPath}
                  selectedPath={selectedPath}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onNewFile={onNewFile}
                  onNewFolder={onNewFolder}
                  onRename={onRename}
                  onDelete={onDelete}
                  workspaceId={workspaceId}
                  rootPath={rootPath}
                  onMoveInto={onMoveInto}
                  dragOverDir={dragOverDir}
                  onDragOverDir={onDragOverDir}
                />
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
});
