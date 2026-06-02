// P4 MEM-2 — daily-note helper. Node env: the helper is dependency-injected so
// no electron / jsdom is needed. We mock the rpc module only so the
// `typeof rpc.memory.*` type imports resolve; the tests pass their own fakes.

import { describe, expect, it, vi } from 'vitest';
import type { Memory } from '@/shared/types';
import { dailyNoteName, openDailyNote, type DailyNoteDeps } from './daily-note';

vi.mock('@/renderer/lib/rpc', () => ({ rpc: { memory: {} } }));

function makeMemory(name: string, over: Partial<Memory> = {}): Memory {
  return {
    id: `id-${name}` as Memory['id'],
    workspaceId: 'ws' as Memory['workspaceId'],
    name,
    body: '',
    tags: [],
    links: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('dailyNoteName', () => {
  it('formats a Date as zero-padded local YYYY-MM-DD', () => {
    expect(dailyNoteName(new Date('2026-06-02T12:00:00'))).toBe('2026-06-02');
  });

  it('zero-pads single-digit months and days', () => {
    expect(dailyNoteName(new Date('2026-01-05T09:30:00'))).toBe('2026-01-05');
  });
});

describe('openDailyNote', () => {
  it('returns the existing note without creating when read resolves a note', async () => {
    const existing = makeMemory('2026-06-02', { body: 'kept', tags: ['daily'] });
    const read = vi.fn().mockResolvedValue(existing);
    const create = vi.fn();
    const deps = { read, create } as unknown as DailyNoteDeps;

    const result = await openDailyNote('ws', new Date('2026-06-02T12:00:00'), deps);

    expect(result).toBe(existing);
    expect(read).toHaveBeenCalledWith({ workspaceId: 'ws', name: '2026-06-02' });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates with tags:["daily"] when the note is absent', async () => {
    const created = makeMemory('2026-06-02', { tags: ['daily'] });
    const read = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(created);
    const deps = { read, create } as unknown as DailyNoteDeps;

    const result = await openDailyNote('ws', new Date('2026-06-02T12:00:00'), deps);

    expect(result).toBe(created);
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];
    expect(arg).toMatchObject({ workspaceId: 'ws', name: '2026-06-02', tags: ['daily'] });
    expect(typeof arg.body).toBe('string');
  });

  it('falls back to read when create throws (lost the exists race)', async () => {
    const recovered = makeMemory('2026-06-02', { tags: ['daily'] });
    // read: null first (so we try create), then the recovered note after the throw.
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(recovered);
    const create = vi.fn().mockRejectedValue(new Error('already exists'));
    const deps = { read, create } as unknown as DailyNoteDeps;

    const result = await openDailyNote('ws', new Date('2026-06-02T12:00:00'), deps);

    expect(result).toBe(recovered);
    expect(create).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rethrows the create error when the fallback read also finds nothing', async () => {
    const read = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockRejectedValue(new Error('disk full'));
    const deps = { read, create } as unknown as DailyNoteDeps;

    await expect(
      openDailyNote('ws', new Date('2026-06-02T12:00:00'), deps),
    ).rejects.toThrow('disk full');
  });
});
