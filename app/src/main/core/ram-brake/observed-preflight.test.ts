// The shared OBSERVED-process RAM-brake preflight — one inspection path behind
// both the workspace launcher and the `+ Pane` add (C-061).
//
// C-065 is pinned here too: a cap the operator explicitly SET but we reject
// (`0`, a negative, a float) used to fall back to the default in total silence,
// so `ramBrake.maxClaudeFlowStdioPerSession = 0` read as `1` and looked like the
// brake had simply been ignored. The value is still rejected — `observedEnabled`
// is the real kill switch — but no longer silently.

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  observedBrakeEnabled,
  observedBudgetCaps,
  runObservedProcessPreflight,
  type ObservedPreflightPty,
} from './observed-preflight';
import type { ProcessTreeSnapshot } from '../process/process-tree';

const MIB = 1024 * 1024;

/** A raw-db stub that answers only the kv reads this module makes. */
function kvDb(rows: Record<string, string>): Database.Database {
  return {
    prepare: () => ({
      get: (key: string) => (key in rows ? { value: rows[key] } : undefined),
    }),
  } as unknown as Database.Database;
}

function throwingDb(): Database.Database {
  return {
    prepare: () => {
      throw new Error('db closed');
    },
  } as unknown as Database.Database;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('observedBudgetCaps — cap parsing (C-065)', () => {
  it('uses the generous defaults, silently, when no key is set', () => {
    expect(observedBudgetCaps(kvDb({}))).toEqual({
      maxWorkspaceRssBytes: 4096 * MIB,
      maxTotalRssBytes: 12_288 * MIB,
      maxClaudeFlowStdioPerSession: 1,
    });
    // An absent key is the normal case, not a misconfiguration.
    expect(warn).not.toHaveBeenCalled();
  });

  it('honours a valid override without warning', () => {
    const caps = observedBudgetCaps(kvDb({ 'ramBrake.maxClaudeFlowStdioPerSession': '3' }));
    expect(caps.maxClaudeFlowStdioPerSession).toBe(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a 0 cap LOUDLY, naming the key, the value, the fallback, and the real kill switch', () => {
    const caps = observedBudgetCaps(kvDb({ 'ramBrake.maxClaudeFlowStdioPerSession': '0' }));

    // Behaviour is unchanged — a 0 still falls back to 1 — but it is no longer
    // invisible.
    expect(caps.maxClaudeFlowStdioPerSession).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('ramBrake.maxClaudeFlowStdioPerSession');
    expect(message).toContain('"0"');
    expect(message).toContain('(1)');
    expect(message).toContain('ramBrake.observedEnabled');
  });

  it('rejects negatives and non-integers the same way', () => {
    const caps = observedBudgetCaps(
      kvDb({
        'ramBrake.maxObservedWorkspaceRssMb': '-1',
        'ramBrake.maxObservedTotalRssMb': 'lots',
      }),
    );
    expect(caps.maxWorkspaceRssBytes).toBe(4096 * MIB);
    expect(caps.maxTotalRssBytes).toBe(12_288 * MIB);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('falls back silently when the db read throws', () => {
    expect(observedBudgetCaps(throwingDb()).maxClaudeFlowStdioPerSession).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('observedBrakeEnabled — the real kill switch', () => {
  it('defaults ON when the key is absent or the read throws', () => {
    expect(observedBrakeEnabled(kvDb({}))).toBe(true);
    expect(observedBrakeEnabled(throwingDb())).toBe(true);
  });

  it("treats '0' / 'false' / 'off' as OFF, case- and space-insensitively", () => {
    for (const value of ['0', 'false', 'off', ' OFF ', 'False']) {
      expect(observedBrakeEnabled(kvDb({ 'ramBrake.observedEnabled': value }))).toBe(false);
    }
  });

  it('leaves the brake ON for any other value', () => {
    for (const value of ['1', 'true', 'on', 'yes', '']) {
      expect(observedBrakeEnabled(kvDb({ 'ramBrake.observedEnabled': value }))).toBe(true);
    }
  });
});

describe('runObservedProcessPreflight', () => {
  const leaky: ProcessTreeSnapshot = {
    rootPid: 10,
    supported: true,
    rssBytes: 1024,
    descendantPids: [11, 12],
    nodes: [
      { pid: 10, ppid: 1, rssBytes: 100, command: 'claude', args: 'claude' },
      { pid: 11, ppid: 10, rssBytes: 400, command: 'node', args: 'node @claude-flow/cli/bin/cli.js mcp start' },
      { pid: 12, ppid: 10, rssBytes: 400, command: 'node', args: 'node @claude-flow/cli/bin/cli.js mcp start' },
    ],
  };

  function pty(snapshot: () => Promise<ProcessTreeSnapshot | null>): {
    pty: ObservedPreflightPty;
    processSnapshotCached: ReturnType<typeof vi.fn>;
  } {
    const processSnapshotCached = vi.fn(snapshot);
    return {
      pty: { list: () => [{ id: 'live-1', workspaceId: 'ws-1' }], processSnapshotCached },
      processSnapshotCached,
    };
  }

  it('throws on an over-budget workspace', async () => {
    await expect(
      runObservedProcessPreflight({
        db: kvDb({}),
        pty: pty(async () => leaky).pty,
        workspaceId: 'ws-1',
        force: false,
      }),
    ).rejects.toThrow('RAM_BRAKE_OBSERVED_PROCESS_BUDGET:');
  });

  it('force overrides the same verdict', async () => {
    await expect(
      runObservedProcessPreflight({
        db: kvDb({}),
        pty: pty(async () => leaky).pty,
        workspaceId: 'ws-1',
        force: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails OPEN when a snapshot rejects', async () => {
    await expect(
      runObservedProcessPreflight({
        db: kvDb({}),
        pty: pty(async () => {
          throw new Error('ps unavailable');
        }).pty,
        workspaceId: 'ws-1',
        force: false,
      }),
    ).resolves.toBeUndefined();
  });

  it('takes NO snapshots at all when the brake is disabled', async () => {
    const { pty: registry, processSnapshotCached } = pty(async () => leaky);

    await runObservedProcessPreflight({
      db: kvDb({ 'ramBrake.observedEnabled': '0' }),
      pty: registry,
      workspaceId: 'ws-1',
      force: false,
    });

    expect(processSnapshotCached).not.toHaveBeenCalled();
  });
});
