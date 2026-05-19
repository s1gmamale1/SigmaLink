// v1.5.0 packet 09 — ConflictResolver tests.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  resolveRow,
  applyResolution,
  autoResolveStaleConflicts,
  listUnresolvedConflicts,
  quarantineBlob,
} from './conflict-resolver';
import { pack } from './hlc';

// ------------------------------------------------------------------
// Minimal mock DB
// ------------------------------------------------------------------

interface DbRow { [key: string]: unknown }

class MockDb {
  syncState = new Map<string, DbRow>();
  syncConflicts = new Map<string, DbRow>();
  syncQuarantine = new Map<string, DbRow>();
  syncPendingUpgrade = new Map<string, DbRow>();
  syncTombstones = new Map<string, DbRow>();
  applicationTables = new Map<string, DbRow>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();
    return {
      run: (...args: unknown[]) => {
        if (norm.includes('INSERT OR IGNORE INTO SYNC_PENDING_UPGRADE')) {
          this.syncPendingUpgrade.set(String(args[0]), {
            id: args[0], blob_path: args[1], schema_version: args[2], queued_at: args[3],
          });
        } else if (norm.includes('INSERT INTO SYNC_CONFLICTS')) {
          this.syncConflicts.set(String(args[0]), {
            id: args[0], table_name: args[1], row_id: args[2],
            local_hlc_packed: args[3], remote_hlc_packed: args[4],
            remote_machine_id: args[5], local_row_json: args[6],
            remote_row_json: args[7], resolved: 0, created_at: args[8],
          });
        } else if (norm.includes('UPDATE SYNC_CONFLICTS')) {
          for (const [k, row] of this.syncConflicts) {
            if (row.id === args[2]) {
              this.syncConflicts.set(k, { ...row, resolved: 1, resolution: args[0], resolved_at: args[1] });
            }
          }
        } else if (norm.includes('INSERT OR IGNORE INTO SYNC_QUARANTINE')) {
          this.syncQuarantine.set(String(args[0]), {
            id: args[0], blob_path: args[1], reason: args[2], detected_at: args[3],
          });
        }
      },
      get: (a?: unknown, b?: unknown) => {
        if (norm.includes('SYNC_TOMBSTONES')) {
          return this.syncTombstones.get(`${a}:${b}`);
        }
        if (norm.includes('SYNC_STATE')) {
          return this.syncState.get(`${a}:${b}`);
        }
        if (norm.includes('SELECT * FROM')) {
          return this.applicationTables.get(`${a}:${b}`) ?? undefined;
        }
        return undefined;
      },
      all: (...args: unknown[]) => {
        if (norm.includes('SYNC_CONFLICTS') && norm.includes('WHERE RESOLVED = 0')) {
          const cutoff = typeof args[0] === 'number' ? args[0] : Infinity;
          return Array.from(this.syncConflicts.values()).filter(
            (r) => r.resolved === 0 && (typeof r.created_at === 'number' ? r.created_at < cutoff : true),
          );
        }
        if (norm.includes('SYNC_CONFLICTS') && norm.includes('ORDER BY')) {
          return Array.from(this.syncConflicts.values())
            .filter((r) => r.resolved === 0)
            .map((r) => ({
              id: r.id, tableName: r.table_name, rowId: r.row_id,
              localRowJson: r.local_row_json, remoteRowJson: r.remote_row_json,
              createdAt: r.created_at,
            }));
        }
        return [];
      },
    };
  }
}

const MACHINE_A = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const MACHINE_B = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const LOCAL_SCHEMA = 19;

function makeRemoteRow(overrides?: Partial<{
  tableName: string;
  rowId: string;
  wallMs: number;
  schemaVersion: number;
}>): import('./conflict-resolver').RemoteRow {
  const wallMs = overrides?.wallMs ?? Date.now();
  return {
    tableName: overrides?.tableName ?? 'conversations',
    rowId: overrides?.rowId ?? 'row-1',
    hlcPacked: pack({ wallMs, logical: 0, machineId: MACHINE_B }),
    machineId: MACHINE_B,
    rowJson: JSON.stringify({ id: 'row-1', content: 'remote' }),
    schemaVersion: overrides?.schemaVersion ?? LOCAL_SCHEMA,
  };
}

let db: MockDb;
beforeEach(() => {
  db = new MockDb();
});

describe('resolveRow — schema version gate', () => {
  it('quarantines blob when remote schema version > local', () => {
    const remote = makeRemoteRow({ schemaVersion: LOCAL_SCHEMA + 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = resolveRow(db as any, LOCAL_SCHEMA, remote, 'blobs/r1.bin');
    expect(outcome.action).toBe('quarantine_upgrade');
    expect(db.syncPendingUpgrade.size).toBe(1);
  });
});

describe('resolveRow — new row', () => {
  it('applies remote when row does not exist locally', () => {
    const remote = makeRemoteRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = resolveRow(db as any, LOCAL_SCHEMA, remote, 'blobs/r1.bin');
    expect(outcome.action).toBe('apply_remote');
  });
});

describe('resolveRow — LWW', () => {
  it('applies remote when remote HLC is newer', () => {
    const localWallMs = Date.now() - 5000;
    const remoteWallMs = Date.now();

    // Seed local sync_state with older HLC
    db.syncState.set('conversations:row-1', {
      hlc_wall_ms: localWallMs,
      hlc_logical: 0,
      hlc_machine_id: Buffer.from(MACHINE_A).toString('hex'),
      row_hash: 'abc',
    });

    const remote = makeRemoteRow({ wallMs: remoteWallMs });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = resolveRow(db as any, LOCAL_SCHEMA, remote, 'blobs/r1.bin');
    expect(outcome.action).toBe('apply_remote');
  });

  it('keeps local when local HLC is newer', () => {
    const remoteWallMs = Date.now() - 5000;
    const localWallMs = Date.now();

    db.syncState.set('conversations:row-1', {
      hlc_wall_ms: localWallMs,
      hlc_logical: 0,
      hlc_machine_id: Buffer.from(MACHINE_A).toString('hex'),
      row_hash: 'abc',
    });

    const remote = makeRemoteRow({ wallMs: remoteWallMs });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = resolveRow(db as any, LOCAL_SCHEMA, remote, 'blobs/r1.bin');
    expect(outcome.action).toBe('keep_local');
  });
});

describe('resolveRow — tombstone', () => {
  it('keeps local tombstone when tombstone HLC is newer than remote', () => {
    const tombstoneWallMs = Date.now();
    const remoteWallMs = tombstoneWallMs - 5000;

    db.syncTombstones.set('conversations:row-1', {
      hlc_packed: pack({ wallMs: tombstoneWallMs, logical: 0, machineId: MACHINE_A }),
    });

    const remote = makeRemoteRow({ wallMs: remoteWallMs });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = resolveRow(db as any, LOCAL_SCHEMA, remote, 'blobs/r1.bin');
    expect(outcome.action).toBe('keep_local');
  });

  it('records conflict when remote edit is newer than tombstone', () => {
    const tombstoneWallMs = Date.now() - 5000;
    const remoteWallMs = Date.now();

    db.syncTombstones.set('conversations:row-1', {
      hlc_packed: pack({ wallMs: tombstoneWallMs, logical: 0, machineId: MACHINE_A }),
    });

    const remote = makeRemoteRow({ wallMs: remoteWallMs });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = resolveRow(db as any, LOCAL_SCHEMA, remote, 'blobs/r1.bin');
    expect(outcome.action).toBe('conflict');
    expect(db.syncConflicts.size).toBe(1);
  });
});

describe('applyResolution', () => {
  it('marks the conflict as resolved', () => {
    // Seed a conflict
    db.syncConflicts.set('c-1', {
      id: 'c-1', table_name: 'conversations', row_id: 'r-1', resolved: 0, created_at: Date.now(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyResolution(db as any, 'c-1', 'keep_local');
    expect(db.syncConflicts.get('c-1')?.resolved).toBe(1);
    expect(db.syncConflicts.get('c-1')?.resolution).toBe('keep_local');
  });
});

describe('autoResolveStaleConflicts', () => {
  it('auto-resolves conflicts older than 7 days', () => {
    const staleTime = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    const remoteWallMs = staleTime + 1000;
    const localWallMs = staleTime;

    db.syncConflicts.set('c-old', {
      id: 'c-old',
      local_hlc_packed: pack({ wallMs: localWallMs, logical: 0, machineId: MACHINE_A }),
      remote_hlc_packed: pack({ wallMs: remoteWallMs, logical: 0, machineId: MACHINE_B }),
      resolved: 0,
      created_at: staleTime,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = autoResolveStaleConflicts(db as any);
    expect(count).toBe(1);
    expect(db.syncConflicts.get('c-old')?.resolved).toBe(1);
    // Remote is newer → keep_remote
    expect(db.syncConflicts.get('c-old')?.resolution).toBe('keep_remote');
  });

  it('does not touch fresh conflicts', () => {
    db.syncConflicts.set('c-new', {
      id: 'c-new',
      local_hlc_packed: pack({ wallMs: Date.now(), logical: 0, machineId: MACHINE_A }),
      remote_hlc_packed: pack({ wallMs: Date.now(), logical: 1, machineId: MACHINE_B }),
      resolved: 0,
      created_at: Date.now(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = autoResolveStaleConflicts(db as any);
    expect(count).toBe(0);
    expect(db.syncConflicts.get('c-new')?.resolved).toBe(0);
  });
});

describe('listUnresolvedConflicts', () => {
  it('returns only unresolved conflicts', () => {
    db.syncConflicts.set('c-1', { id: 'c-1', resolved: 0, created_at: Date.now() });
    db.syncConflicts.set('c-2', { id: 'c-2', resolved: 1, created_at: Date.now() });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = listUnresolvedConflicts(db as any);
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe('c-1');
  });
});

describe('quarantineBlob', () => {
  it('inserts a quarantine record', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    quarantineBlob(db as any, 'blobs/bad.bin', 'aead_fail');
    expect(db.syncQuarantine.size).toBe(1);
    const q = Array.from(db.syncQuarantine.values())[0];
    expect(q?.blob_path).toBe('blobs/bad.bin');
    expect(q?.reason).toBe('aead_fail');
  });
});
