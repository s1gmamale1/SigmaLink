// v1.5.0 packet 09 — Sync RPC controller.
//
// Exposes the sync engine to the renderer via `sync.*` IPC channels.
//
// SECURITY CONTRACT:
//   - No sync key or mnemonic appears in IPC responses EXCEPT exportMnemonic
//     (one-shot, caller must display and discard).
//   - enable() accepts SyncConfig from the renderer; username/password are
//     forwarded to git-client, NOT stored in any IPC response.
//   - The returned SyncStatus type contains NO key material.

import type Database from 'better-sqlite3';
import { SyncEngine } from './engine';
import { KeyManager } from './key-manager';
import { listUnresolvedConflicts, applyResolution } from './conflict-resolver';
import type { SyncConfig, SyncStatus, SyncConflict } from '../../../shared/types';
import { app } from 'electron';
import path from 'node:path';

// ------------------------------------------------------------------
// Factory
// ------------------------------------------------------------------

export function buildSyncController(
  db: Database.Database,
  emit: (event: string, payload: unknown) => void,
) {
  // The engine is created once and lives for the process lifetime.
  const engine = new SyncEngine(db, (status) => {
    emit('sync:status', status);
  });

  function defaultCloneDir(): string {
    return path.join(app.getPath('userData'), 'sync-repo');
  }

  return {
    enable: async (config: SyncConfig): Promise<SyncStatus> => {
      const cloneDir = defaultCloneDir();
      await engine.enable({ ...config, cloneDir });
      return engine.getStatus();
    },

    disable: async (): Promise<void> => {
      engine.disable();
    },

    status: async (): Promise<SyncStatus> => {
      return engine.getStatus();
    },

    listConflicts: async (): Promise<SyncConflict[]> => {
      return listUnresolvedConflicts(db);
    },

    resolveConflict: async (input: {
      conflictId: string;
      resolution: 'keep_local' | 'keep_remote';
    }): Promise<void> => {
      applyResolution(db, input.conflictId, input.resolution);
    },

    exportMnemonic: async (): Promise<string | null> => {
      // One-shot: caller MUST display and discard. Never stored in IPC state.
      return KeyManager.exportMnemonic();
    },

    isConfigured: async (): Promise<boolean> => {
      return KeyManager.isConfigured();
    },

    recoverFromMnemonic: async (mnemonic: string): Promise<void> => {
      await KeyManager.recoverFromMnemonic(mnemonic);
    },
  };
}

export type SyncController = ReturnType<typeof buildSyncController>;
