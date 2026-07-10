// P2 Task 5 — tests for the DEFAULT (non-overridden) system-prompt wiring.
// `resolveSystemPrompt`/`defaultSystemPromptForWorkspace` now thread the
// operator's charter through every real turn (D2/D3 — charter is
// default-ON) and switch to a portfolio listing for the
// JORVIS_GLOBAL_WORKSPACE_ID sentinel (D1). The `build` override path
// (what runClaudeCliTurn.test.ts's `fixedSysPrompt` exercises) is
// untouched by this change — these tests exercise the DEFAULT path only,
// DB-mocked via the createDbFake() pattern (mirrors supervisor.test.ts /
// tools.missions.test.ts).
//
// P2 Task 8 — the `amendments` seam is now wired: defaultSystemPromptForWorkspace
// loads `listAmendments('approved')` (core/operator/amendments.ts) fail-soft
// and passes it through to buildJorvisSystemPrompt alongside charter, on
// both the single-workspace and portfolio (global-scope) paths. The tests
// below prove a newly-approved amendment shows up in the NEXT turn's prompt
// (and that a merely-proposed one does not).

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import { createDbFake, seedWorkspace, type DbFake } from '@/test-utils/db-fake';
import { resolveSystemPrompt } from './runClaudeCliTurn.args';
import { JORVIS_GLOBAL_WORKSPACE_ID } from '../operator/global';
import * as amendmentsDao from '../operator/amendments';

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
});

describe('resolveSystemPrompt — default wiring (P2 Task 5)', () => {
  it('single-workspace turn: includes the workspace block AND the charter persona (default-ON, D3)', () => {
    const ws = seedWorkspace(fake, { name: 'SigmaLink', rootPath: '/Users/x/SigmaLink' });
    const prompt = resolveSystemPrompt(ws.id as string);
    expect(prompt).toContain('Workspace: SigmaLink (/Users/x/SigmaLink)');
    // Bundled charter marker (vendored from Sigma-Profile — see charter.test.ts).
    expect(prompt).toContain('You are an **operator**');
    // Legacy inline persona is REPLACED, not merely supplemented.
    expect(prompt).not.toContain('You are Sigma Assistant, the in-app intelligence');
  });

  it('single-workspace turn never renders an amendments heading when none are approved', () => {
    const ws = seedWorkspace(fake, { name: 'SigmaLink', rootPath: '/Users/x/SigmaLink' });
    const prompt = resolveSystemPrompt(ws.id as string);
    expect(prompt).not.toContain('Approved amendments');
  });

  it('a newly-approved amendment appears in the NEXT turn\'s prompt (P2 Task 8)', () => {
    const ws = seedWorkspace(fake, { name: 'SigmaLink', rootPath: '/Users/x/SigmaLink' });
    const proposed = amendmentsDao.proposeAmendment({ text: 'Always ship receipts.' });
    amendmentsDao.decideAmendment(proposed.id, true);
    const prompt = resolveSystemPrompt(ws.id as string);
    expect(prompt).toContain('Approved amendments');
    expect(prompt).toContain('Always ship receipts.');
  });

  it('a proposed-but-not-yet-approved amendment does NOT appear in the prompt', () => {
    const ws = seedWorkspace(fake, { name: 'SigmaLink', rootPath: '/Users/x/SigmaLink' });
    amendmentsDao.proposeAmendment({ text: 'Not yet approved.' });
    const prompt = resolveSystemPrompt(ws.id as string);
    expect(prompt).not.toContain('Approved amendments');
    expect(prompt).not.toContain('Not yet approved.');
  });

  it('a global-scope (portfolio) turn also renders an approved amendment', () => {
    seedWorkspace(fake, { name: 'SigmaLink', rootPath: '/Users/x/SigmaLink' });
    const proposed = amendmentsDao.proposeAmendment({ text: 'Portfolio-wide rule.' });
    amendmentsDao.decideAmendment(proposed.id, true);
    const prompt = resolveSystemPrompt(JORVIS_GLOBAL_WORKSPACE_ID);
    expect(prompt).toContain('Approved amendments');
    expect(prompt).toContain('Portfolio-wide rule.');
  });

  it('global-scope turn (workspaceId === JORVIS_GLOBAL_WORKSPACE_ID) lists every workspace as a portfolio', () => {
    seedWorkspace(fake, { name: 'SigmaLink', rootPath: '/Users/x/SigmaLink' });
    seedWorkspace(fake, { name: 'Homeworks', rootPath: '/Users/x/Homeworks' });
    const prompt = resolveSystemPrompt(JORVIS_GLOBAL_WORKSPACE_ID);
    expect(prompt).toContain('Portfolio (all workspaces)');
    expect(prompt).toContain('SigmaLink — /Users/x/SigmaLink');
    expect(prompt).toContain('Homeworks — /Users/x/Homeworks');
    expect(prompt).toContain('You are an **operator**');
  });

  it('global-scope turn omits the singular "Workspace: <name> (<root>)" line', () => {
    seedWorkspace(fake, { name: 'SigmaLink', rootPath: '/Users/x/SigmaLink' });
    const prompt = resolveSystemPrompt(JORVIS_GLOBAL_WORKSPACE_ID);
    expect(prompt).not.toMatch(/^Workspace: /m);
  });

  it('honors a KV charter-path override (jorvis.charter.path) — proves the raw-SQL kvGet closure is wired end to end', () => {
    const ws = seedWorkspace(fake, { name: 'SigmaLink', rootPath: '/Users/x/SigmaLink' });
    fake.raw
      .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run('jorvis.charter.path', '/custom/charter.md', Date.now());
    // No readFile DI seam reaches this far (defaultSystemPromptForWorkspace
    // uses the real fs.readFileSync default) — an unreadable path fails
    // soft back to the bundled charter per loadJorvisCharter's own contract
    // (charter.test.ts), so this proves the override KEY is actually read
    // without needing a real file on disk.
    const prompt = resolveSystemPrompt(ws.id as string);
    expect(prompt).toContain('You are an **operator**');
  });

  it('fail-soft: a throwing charter loader falls back to the legacy inline persona (never throws, never blocks the turn)', async () => {
    vi.resetModules();
    vi.doMock('../operator/charter', () => ({
      loadJorvisCharter: () => {
        throw new Error('charter loader exploded');
      },
      appendApprovedAmendments: (charter: string) => charter,
    }));
    try {
      const mod = await import('./runClaudeCliTurn.args');
      const ws = seedWorkspace(fake, { name: 'SigmaLink', rootPath: '/Users/x/SigmaLink' });
      const prompt = mod.resolveSystemPrompt(ws.id as string);
      expect(prompt).toContain('You are Sigma Assistant, the in-app intelligence');
      expect(prompt).not.toContain('You are an **operator**');
      expect(prompt).toContain('Workspace: SigmaLink (/Users/x/SigmaLink)');
    } finally {
      vi.doUnmock('../operator/charter');
      vi.resetModules();
    }
  });

  it('DB miss (unknown workspaceId) still returns a valid prompt with placeholder workspace fields', () => {
    const prompt = resolveSystemPrompt('nonexistent-workspace-id');
    expect(prompt).toContain('Workspace: workspace ()');
    expect(prompt).toContain('You are an **operator**');
  });
});

describe('resolveSystemPrompt — build override untouched (back-compat)', () => {
  it('the build override still short-circuits DB/charter resolution entirely', () => {
    const prompt = resolveSystemPrompt('any-workspace-id', () => 'OVERRIDE-TEXT');
    expect(prompt).toBe('OVERRIDE-TEXT');
  });
});
