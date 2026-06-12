import { describe, expect, it } from 'vitest';
import { resolveSpawnRendererMode } from './spawn-renderer-mode';

function fakeDb(rows: Record<string, string>) {
  return {
    prepare: () => ({
      get: (key: string) => (key in rows ? { value: rows[key] } : undefined),
    }),
  } as unknown as import('better-sqlite3').Database;
}

describe('resolveSpawnRendererMode', () => {
  it('per-session override wins', () => {
    const db = fakeDb({ 'panes.renderer.s1': 'xterm', 'panes.renderer.default': 'dom' });
    expect(resolveSpawnRendererMode(db, 's1')).toBe('xterm');
  });
  it('falls to the global KV, then the shared default', () => {
    expect(resolveSpawnRendererMode(fakeDb({ 'panes.renderer.default': 'xterm' }), 's2')).toBe('xterm');
    expect(resolveSpawnRendererMode(fakeDb({}), 's3')).toBe('dom');
    expect(resolveSpawnRendererMode(fakeDb({}))).toBe('dom');
  });
  it('garbage and throwing dbs resolve to the default', () => {
    expect(resolveSpawnRendererMode(fakeDb({ 'panes.renderer.default': 'vulkan' }), 's4')).toBe('dom');
    const throwing = { prepare: () => { throw new Error('locked'); } } as unknown as import('better-sqlite3').Database;
    expect(resolveSpawnRendererMode(throwing, 's5')).toBe('dom');
  });
});
