import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { writeScopeBlock } from './scope-block';
it('writes one marker block, idempotent, preserves prose', async () => {
  const dir = mkdtempSync(join(tmpdir(),'wt-')); writeFileSync(join(dir,'CLAUDE.md'),'# Existing\n');
  await writeScopeBlock(dir, { goal:'g', targetFiles:[], successCriteria:[], outOfScope:['billing/**'] });
  await writeScopeBlock(dir, { goal:'g', targetFiles:[], successCriteria:[], outOfScope:['billing/**'] });
  const txt = readFileSync(join(dir,'CLAUDE.md'),'utf8');
  expect(txt).toContain('# Existing');
  expect(txt.match(/sigmalink-scope:start/g)?.length).toBe(1);
  expect(txt).toContain('billing/**');
});
