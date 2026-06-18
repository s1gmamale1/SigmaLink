// File-tree mutation hook. Wraps the contained fs.* RPC channels with toast
// feedback and returns the resulting path (or null/false) so the tree can
// refresh the affected directory and auto-open new files. Holds no state.

import { useMemo } from 'react';
import { toast } from 'sonner';
import { rpcSilent } from '@/renderer/lib/rpc';
import { fsPath } from './fs-path';

export interface FileMutations {
  /** Create an empty file `name` inside `dir`. Returns the new path or null. */
  createFile(dir: string, name: string): Promise<string | null>;
  /** Create a directory `name` inside `dir`. Returns the new path or null. */
  createFolder(dir: string, name: string): Promise<string | null>;
  /** Rename a node in place. Returns the new path or null. */
  rename(fromPath: string, newName: string): Promise<string | null>;
  /** Move a node into `destDir`, keeping its basename. Returns the new path or null. */
  move(fromPath: string, destDir: string): Promise<string | null>;
  /** Move a node to the OS Trash. Returns true on success. */
  trash(targetPath: string): Promise<boolean>;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useFileMutations(): FileMutations {
  return useMemo<FileMutations>(
    () => ({
      async createFile(dir, name) {
        const target = fsPath.join(dir, name);
        try {
          await rpcSilent.fs.createFile({ path: target });
          toast.success(`Created ${name}`);
          return target;
        } catch (err) {
          toast.error(errMsg(err, `Failed to create ${name}`));
          return null;
        }
      },
      async createFolder(dir, name) {
        const target = fsPath.join(dir, name);
        try {
          await rpcSilent.fs.mkdir({ path: target });
          toast.success(`Created ${name}`);
          return target;
        } catch (err) {
          toast.error(errMsg(err, `Failed to create folder ${name}`));
          return null;
        }
      },
      async rename(fromPath, newName) {
        const to = fsPath.join(fsPath.dirname(fromPath), newName);
        try {
          await rpcSilent.fs.rename({ from: fromPath, to });
          toast.success(`Renamed to ${newName}`);
          return to;
        } catch (err) {
          toast.error(errMsg(err, 'Rename failed'));
          return null;
        }
      },
      async move(fromPath, destDir) {
        const to = fsPath.join(destDir, fsPath.basename(fromPath));
        try {
          await rpcSilent.fs.rename({ from: fromPath, to });
          toast.success(`Moved ${fsPath.basename(fromPath)}`);
          return to;
        } catch (err) {
          toast.error(errMsg(err, 'Move failed'));
          return null;
        }
      },
      async trash(targetPath) {
        try {
          await rpcSilent.fs.trash({ path: targetPath });
          toast.success(`Moved ${fsPath.basename(targetPath)} to Trash`);
          return true;
        } catch (err) {
          toast.error(errMsg(err, 'Delete failed'));
          return false;
        }
      },
    }),
    [],
  );
}
