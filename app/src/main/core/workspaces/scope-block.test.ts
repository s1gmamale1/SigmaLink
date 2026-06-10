import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { writeScopeBlock, briefPane } from './scope-block';
it('writes one marker block, idempotent, preserves prose', async () => {
  const dir = mkdtempSync(join(tmpdir(),'wt-')); writeFileSync(join(dir,'CLAUDE.md'),'# Existing\n');
  await writeScopeBlock(dir, { goal:'g', targetFiles:[], successCriteria:[], outOfScope:['billing/**'] });
  await writeScopeBlock(dir, { goal:'g', targetFiles:[], successCriteria:[], outOfScope:['billing/**'] });
  const txt = readFileSync(join(dir,'CLAUDE.md'),'utf8');
  expect(txt).toContain('# Existing');
  expect(txt.match(/sigmalink-scope:start/g)?.length).toBe(1);
  expect(txt).toContain('billing/**');
});

// Audit 2026-06-10 finding 1 — panes.brief wrote a CLAUDE.md at ANY
// renderer-supplied path. briefPane contains worktreePath against the injected
// allowed roots BEFORE any disk or PTY write (fail-closed via assertAllowedPath).
describe('briefPane — worktreePath containment', () => {
  const capsule = { goal: 'Add login', targetFiles: ['src/a.ts'], successCriteria: ['tests pass'], outOfScope: ['billing/**'] };

  it('writes the scope block + injects the capsule when worktreePath is inside an allowed root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'brief-root-'));
    const writes: Array<{ id: string; data: string }> = [];
    await briefPane(
      { sessionId: 'sess-1', worktreePath: root, capsule },
      { allowedRoots: () => [root], writePty: (id, data) => { writes.push({ id, data }); } },
    );
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('billing/**');
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe('sess-1');
    expect(writes[0].data).toContain('Add login');
  });

  it('REFUSES an out-of-roots worktreePath: throws, writes NO CLAUDE.md, injects NOTHING', async () => {
    const root = mkdtempSync(join(tmpdir(), 'brief-allowed-'));
    const outside = mkdtempSync(join(tmpdir(), 'brief-outside-'));
    const writes: string[] = [];
    await expect(
      briefPane(
        { sessionId: 'sess-1', worktreePath: outside, capsule },
        { allowedRoots: () => [root], writePty: (_id, data) => { writes.push(data); } },
      ),
    ).rejects.toThrow('path outside workspace');
    expect(existsSync(join(outside, 'CLAUDE.md'))).toBe(false);
    expect(writes).toEqual([]);
  });

  it('fail-closed: empty allowed roots refuses even a real worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'brief-noroots-'));
    await expect(
      briefPane(
        { sessionId: 'sess-1', worktreePath: root, capsule },
        { allowedRoots: () => [], writePty: () => undefined },
      ),
    ).rejects.toThrow('path outside workspace');
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('null worktreePath skips the disk write but still injects the capsule', async () => {
    const writes: string[] = [];
    await briefPane(
      { sessionId: 'sess-1', worktreePath: null, capsule },
      { allowedRoots: () => [], writePty: (_id, data) => { writes.push(data); } },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('Add login');
  });
});
