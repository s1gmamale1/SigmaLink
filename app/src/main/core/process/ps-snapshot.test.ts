// perf-hot-paths Task 1 — shared async process-table snapshot + TTL cache.
// Fakes the ProcessLister (no real `ps` spawn); vi.useFakeTimers drives the
// TTL (vitest fake timers mock Date.now too). vitest cannot load electron,
// so the lister is injected — never spawn a real process here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  inspectProcessTreeCached,
  parsePsOutput,
  __setProcessListerForTests,
  __resetProcessTableForTests,
  PROCESS_TABLE_TTL_MS,
} from './ps-snapshot';
import type { ProcessTreeNode } from './process-tree';

function node(pid: number, ppid: number, rssKb: number, command = 'proc'): ProcessTreeNode {
  return { pid, ppid, rssBytes: rssKb * 1024, command, args: '' };
}

const TABLE: ProcessTreeNode[] = [
  node(1, 0, 100, 'launchd'),
  node(100, 1, 500, 'claude'),
  node(101, 100, 300, 'node'),
  node(102, 101, 200, 'ruflo-mcp'),
  node(200, 1, 400, 'codex'),
];

beforeEach(() => {
  vi.useFakeTimers();
  __resetProcessTableForTests();
});

afterEach(() => {
  __resetProcessTableForTests();
  vi.useRealTimers();
});

describe('inspectProcessTreeCached', () => {
  it('12 concurrent calls share ONE lister invocation (in-flight dedupe)', async () => {
    const lister = vi.fn(async () => TABLE);
    __setProcessListerForTests(lister);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => inspectProcessTreeCached(100)),
    );

    expect(lister).toHaveBeenCalledTimes(1);
    for (const snap of results) {
      expect(snap.supported).toBe(true);
      expect(snap.rootPid).toBe(100);
      expect([...snap.descendantPids].sort((a, b) => a - b)).toEqual([101, 102]);
      expect(snap.rssBytes).toBe((500 + 300 + 200) * 1024);
    }
  });

  it('serves from cache within the TTL, refetches after expiry', async () => {
    const lister = vi.fn(async () => TABLE);
    __setProcessListerForTests(lister);

    await inspectProcessTreeCached(100);
    await inspectProcessTreeCached(200); // different root, same shared table
    expect(lister).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PROCESS_TABLE_TTL_MS + 100);
    await inspectProcessTreeCached(100);
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it('different panes get their own subtree from one shared table', async () => {
    __setProcessListerForTests(vi.fn(async () => TABLE));
    const a = await inspectProcessTreeCached(100);
    const b = await inspectProcessTreeCached(200);
    expect(a.nodes.map((n) => n.pid).sort((x, y) => x - y)).toEqual([100, 101, 102]);
    expect(b.nodes.map((n) => n.pid)).toEqual([200]);
    expect(b.rssBytes).toBe(400 * 1024);
  });

  it('returns unsupported-empty when no lister exists for the platform', async () => {
    // darwin/win32/linux all now have listers, so exercise via a truly-unknown
    // platform (freebsd has no LISTERS entry).
    __setProcessListerForTests(null);
    const snap = await inspectProcessTreeCached(100, 'freebsd');
    expect(snap.supported).toBe(false);
    expect(snap.nodes).toEqual([]);
    expect(snap.rssBytes).toBe(0);
  });

  it('linux cached snapshot uses the linux lister', async () => {
    const rows: import('./process-tree').ProcessTreeNode[] = [
      { pid: 100, ppid: 1, rssBytes: 1024, command: '/bin/bash', args: 'bash' },
      { pid: 101, ppid: 100, rssBytes: 2048, command: '/usr/bin/node', args: 'node cli.js' },
    ];
    __setProcessListerForTests(async () => rows);
    const snap = await inspectProcessTreeCached(100, 'linux');
    expect(snap.supported).toBe(true);
    expect(snap.descendantPids).toEqual([101]);
    expect(snap.rssBytes).toBe(1024 + 2048);
  });

  it('a failing lister degrades to the last cached table (never throws)', async () => {
    const lister = vi
      .fn<() => Promise<ProcessTreeNode[]>>()
      .mockResolvedValueOnce(TABLE)
      .mockRejectedValueOnce(new Error('ps blew up'));
    __setProcessListerForTests(lister);

    const first = await inspectProcessTreeCached(100);
    expect(first.rssBytes).toBeGreaterThan(0);

    vi.advanceTimersByTime(PROCESS_TABLE_TTL_MS + 100);
    const second = await inspectProcessTreeCached(100);
    expect(second.rssBytes).toBe(first.rssBytes); // stale-but-served
  });

  it('rootPid absent from the table → empty supported snapshot', async () => {
    __setProcessListerForTests(vi.fn(async () => TABLE));
    const snap = await inspectProcessTreeCached(99999);
    expect(snap.supported).toBe(true);
    expect(snap.nodes).toEqual([]);
    expect(snap.rssBytes).toBe(0);
  });
});

describe('parsePsOutput', () => {
  it('parses pid/ppid/rss/comm/args lines and skips malformed rows', () => {
    const out =
      '  100   1 500 claude --resume abc\n garbage \n  101 100 300 node ruflo mcp start\n';
    const rows = parsePsOutput(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      pid: 100,
      ppid: 1,
      rssBytes: 500 * 1024,
      command: 'claude',
      args: '--resume abc',
    });
  });
});
