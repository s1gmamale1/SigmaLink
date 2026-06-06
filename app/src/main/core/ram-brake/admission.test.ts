import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  RAM_BRAKE_ERROR_PREFIX,
  RamBrakeAdmissionError,
  checkRamBrakeAdmission,
  readRamBrakeCaps,
} from './admission';

interface SessionRow {
  workspaceId: string;
  status: string;
  runtimeProfileId?: string | null;
}

class FakeDb {
  private readonly sessions: SessionRow[];
  private readonly kv: Record<string, string>;

  constructor(
    sessions: SessionRow[] = [],
    kv: Record<string, string> = {},
  ) {
    this.sessions = sessions;
    this.kv = kv;
  }

  prepare(sql: string) {
    return {
      get: (...args: unknown[]) => {
        if (/FROM kv/i.test(sql)) {
          const key = String(args[0]);
          return this.kv[key] == null ? undefined : { value: this.kv[key] };
        }
        if (/COUNT\(\*\)/i.test(sql)) {
          const workspaceId = args[0] as string | undefined;
          return {
            count: this.liveRows(workspaceId).length,
          };
        }
        return undefined;
      },
      all: (...args: unknown[]) => {
        if (/runtime_profile_id/i.test(sql)) {
          const workspaceId = args[0] as string | undefined;
          return this.liveRows(workspaceId).map((row) => ({
            runtimeProfileId: row.runtimeProfileId ?? null,
          }));
        }
        return [];
      },
    };
  }

  private liveRows(workspaceId?: string): SessionRow[] {
    return this.sessions.filter((row) => {
      const live = row.status === 'running' || row.status === 'starting';
      return live && (!workspaceId || row.workspaceId === workspaceId);
    });
  }
}

function db(sessions: SessionRow[], kv: Record<string, string> = {}): Database.Database {
  return new FakeDb(sessions, kv) as unknown as Database.Database;
}

describe('RAM Brake admission', () => {
  it('uses safe defaults when KV is missing or invalid', () => {
    const caps = readRamBrakeCaps(
      db([], {
        'ramBrake.maxTotalLiveAgents': '-1',
        'ramBrake.maxWorkspaceLiveAgents': 'abc',
      }),
    );
    expect(caps).toEqual({
      maxTotalLiveAgents: 12,
      maxWorkspaceLiveAgents: 8,
      maxTotalMcpHeavyAgents: 2,
      maxWorkspaceMcpHeavyAgents: 1,
    });
  });

  it('rejects a plan that exceeds total live cap before spawn side effects', () => {
    const fake = db(
      Array.from({ length: 12 }, () => ({
        workspaceId: 'ws-a',
        status: 'running',
        runtimeProfileId: 'ruflo-core',
      })),
    );
    expect(() =>
      checkRamBrakeAdmission(fake, {
        workspaceId: 'ws-a',
        requestedProfiles: ['ruflo-core'],
      }),
    ).toThrow(RamBrakeAdmissionError);
  });

  it('rejects browser-tools when the workspace heavy cap is already full', () => {
    const fake = db([
      { workspaceId: 'ws-a', status: 'running', runtimeProfileId: 'browser-tools' },
      { workspaceId: 'ws-b', status: 'running', runtimeProfileId: 'ruflo-core' },
    ]);
    try {
      checkRamBrakeAdmission(fake, {
        workspaceId: 'ws-a',
        requestedProfiles: ['browser-tools'],
      });
      throw new Error('expected RAM Brake rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(RamBrakeAdmissionError);
      const message = (err as Error).message;
      expect(message.startsWith(RAM_BRAKE_ERROR_PREFIX)).toBe(true);
      expect(message).toContain('workspace-heavy');
    }
  });

  it('allows exact-fit launches and force overrides', () => {
    const fake = db(
      [{ workspaceId: 'ws-a', status: 'running', runtimeProfileId: 'ruflo-core' }],
      {
        'ramBrake.maxTotalLiveAgents': '2',
        'ramBrake.maxWorkspaceLiveAgents': '2',
      },
    );
    expect(
      checkRamBrakeAdmission(fake, {
        workspaceId: 'ws-a',
        requestedProfiles: ['ruflo-core'],
      }).violations,
    ).toEqual([]);

    expect(
      checkRamBrakeAdmission(fake, {
        workspaceId: 'ws-a',
        requestedProfiles: ['ruflo-core', 'ruflo-core'],
        force: true,
      }).violations,
    ).toEqual(['total', 'workspace']);
  });
});
