// v1.7.1 W-5 Skills Phase 2 — Controller tests for attach / detach / listBindings.
//
// Uses an in-memory MockDb that simulates the skill_bindings table without
// importing better-sqlite3 (so this test works in the worktree environment
// where native modules are not available). The mock tracks rows in a plain
// array and implements the exact SQL patterns the controller emits.
//
// Verifies:
//   1. attach — inserts a binding, returns the row.
//   2. attach — deduplication: calling with identical inputs returns the same id.
//   3. attach — pane-scoped (non-null paneSessionId) stored correctly.
//   4. attach — workspace-wide (null paneSessionId) stored correctly.
//   5. attach — two bindings differ when paneSessionId differs.
//   6. detach — removes the row; subsequent listBindings doesn't include it.
//   7. detach — no-op on missing binding id.
//   8. listBindings — returns all bindings for a workspace (workspace + pane).
//   9. listBindings — does NOT return bindings for a different workspace.
//  10. listBindings — returns empty array when no bindings exist.
//  11. attach — validation: throws when workspaceId is empty.
//  12. attach — validation: throws when skillName is empty.
//  13. attach — validation: throws when skillSource is empty.
//  14. detach — validation: throws when bindingId is empty.
//  15. listBindings — validation: throws when workspaceId is empty.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock transitive dependencies that are not available in the worktree
// node_modules (gray-matter, marketplace HTTP fetch, etc.) so the import
// chain of controller.ts resolves cleanly without native packages.
vi.mock('./frontmatter', () => ({
  parseSkillMd: vi.fn(() => ({ ok: false, error: 'mock' })),
}));
vi.mock('./marketplace', () => ({
  installFromUrl: vi.fn(),
}));

import { buildSkillsController } from './controller';

// ---------------------------------------------------------------------------
// MockDb — in-memory implementation of the skill_bindings SQL patterns.
// ---------------------------------------------------------------------------

interface BindingRow {
  id: string;
  workspace_id: string;
  pane_session_id: string | null;
  skill_name: string;
  skill_source: string;
  attached_at: number;
}

class MockDb {
  rows: BindingRow[] = [];

  prepare(sql: string) {
    // Normalise whitespace for easier matching.
    const normalised = sql.replace(/\s+/g, ' ').trim();

    // INSERT INTO skill_bindings (...)
    if (/INSERT INTO skill_bindings/i.test(normalised)) {
      return {
        run: (id: string, workspaceId: string, paneSessionId: string | null, skillName: string, skillSource: string, attachedAt: number) => {
          this.rows.push({ id, workspace_id: workspaceId, pane_session_id: paneSessionId, skill_name: skillName, skill_source: skillSource, attached_at: attachedAt });
        },
      };
    }

    // DELETE FROM skill_bindings WHERE id = ?
    if (/DELETE FROM skill_bindings WHERE id/i.test(normalised)) {
      return {
        run: (id: string) => {
          this.rows = this.rows.filter((r) => r.id !== id);
        },
      };
    }

    // SELECT ... FROM skill_bindings WHERE workspace_id = ? AND skill_name = ? ...
    // (dedup check — has `pane_session_id IS` fragment)
    if (/FROM skill_bindings/i.test(normalised) && /pane_session_id IS/i.test(normalised)) {
      return {
        // The SQL passes paneId twice (IS ? and = ?) — the mock only needs it once.
        get: (workspaceId: string, skillName: string, skillSource: string, paneId: string | null) => {
          return this.rows.find((r) =>
            r.workspace_id === workspaceId &&
            r.skill_name === skillName &&
            r.skill_source === skillSource &&
            r.pane_session_id === paneId,
          ) ?? undefined;
        },
      };
    }

    // SELECT ... FROM skill_bindings WHERE workspace_id = ? ORDER BY attached_at ASC
    // (listBindings — has ORDER BY)
    if (/FROM skill_bindings/i.test(normalised) && /ORDER BY attached_at/i.test(normalised)) {
      return {
        all: (workspaceId: string) => {
          return [...this.rows]
            .filter((r) => r.workspace_id === workspaceId)
            .sort((a, b) => a.attached_at - b.attached_at);
        },
      };
    }

    throw new Error(`MockDb.prepare — unhandled SQL: ${normalised.slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------------------
// Patch getRawDb so the controller uses our MockDb.
// ---------------------------------------------------------------------------

vi.mock('../db/client', () => ({
  getRawDb: vi.fn(),
}));

import { getRawDb } from '../db/client';

// Minimal SkillsManager stub.
const fakeManager = {
  list: vi.fn(),
  ingestFolder: vi.fn(),
  ingestZip: vi.fn(),
  enableForProvider: vi.fn(),
  disableForProvider: vi.fn(),
  uninstall: vi.fn(),
  getReadme: vi.fn(),
  verifyFanoutForWorkspace: vi.fn(),
} as unknown as import('./manager').SkillsManager;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: MockDb;
let ctrl: ReturnType<typeof buildSkillsController>;

beforeEach(() => {
  db = new MockDb();
  vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
  ctrl = buildSkillsController({
    manager: fakeManager,
    marketplaceTempDir: '/tmp/test-marketplace',
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests: skills.attach
// ---------------------------------------------------------------------------

describe('skills.attach', () => {
  it('inserts a binding and returns the row', async () => {
    const result = await ctrl.attach({
      workspaceId: 'ws-1',
      paneSessionId: 'pane-1',
      skillName: 'review',
      skillSource: 'superpowers',
    });

    expect(result.workspaceId).toBe('ws-1');
    expect(result.paneSessionId).toBe('pane-1');
    expect(result.skillName).toBe('review');
    expect(result.skillSource).toBe('superpowers');
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(typeof result.attachedAt).toBe('number');
    expect(db.rows).toHaveLength(1);
  });

  it('deduplicates — identical binding returns same id without inserting duplicate', async () => {
    const first = await ctrl.attach({
      workspaceId: 'ws-1',
      paneSessionId: 'pane-1',
      skillName: 'review',
      skillSource: 'superpowers',
    });
    const second = await ctrl.attach({
      workspaceId: 'ws-1',
      paneSessionId: 'pane-1',
      skillName: 'review',
      skillSource: 'superpowers',
    });

    expect(second.id).toBe(first.id);
    expect(db.rows).toHaveLength(1);
  });

  it('stores a pane-scoped binding (non-null paneSessionId)', async () => {
    const result = await ctrl.attach({
      workspaceId: 'ws-1',
      paneSessionId: 'pane-42',
      skillName: 'debug',
      skillSource: 'ruflo',
    });

    expect(result.paneSessionId).toBe('pane-42');
  });

  it('stores a workspace-wide binding (null paneSessionId)', async () => {
    const result = await ctrl.attach({
      workspaceId: 'ws-1',
      paneSessionId: null,
      skillName: 'brainstorm',
      skillSource: 'superpowers',
    });

    expect(result.paneSessionId).toBeNull();
  });

  it('does not confuse pane-scoped and workspace-wide bindings for same skill', async () => {
    const paneResult = await ctrl.attach({
      workspaceId: 'ws-1',
      paneSessionId: 'pane-1',
      skillName: 'review',
      skillSource: 'superpowers',
    });
    const wsResult = await ctrl.attach({
      workspaceId: 'ws-1',
      paneSessionId: null,
      skillName: 'review',
      skillSource: 'superpowers',
    });

    expect(paneResult.id).not.toBe(wsResult.id);
    expect(db.rows).toHaveLength(2);
  });

  it('throws when workspaceId is missing', async () => {
    await expect(
      ctrl.attach({ workspaceId: '', skillName: 'review', skillSource: 'superpowers' }),
    ).rejects.toThrow('skills.attach: missing workspaceId');
  });

  it('throws when skillName is missing', async () => {
    await expect(
      ctrl.attach({ workspaceId: 'ws-1', skillName: '', skillSource: 'superpowers' }),
    ).rejects.toThrow('skills.attach: missing skillName');
  });

  it('throws when skillSource is missing', async () => {
    await expect(
      ctrl.attach({ workspaceId: 'ws-1', skillName: 'review', skillSource: '' }),
    ).rejects.toThrow('skills.attach: missing skillSource');
  });
});

// ---------------------------------------------------------------------------
// Tests: skills.detach
// ---------------------------------------------------------------------------

describe('skills.detach', () => {
  it('removes an existing binding', async () => {
    const binding = await ctrl.attach({
      workspaceId: 'ws-1',
      paneSessionId: null,
      skillName: 'review',
      skillSource: 'superpowers',
    });

    await ctrl.detach({ bindingId: binding.id });

    expect(db.rows).toHaveLength(0);
  });

  it('is a no-op for a missing binding id (does not throw)', async () => {
    await expect(ctrl.detach({ bindingId: 'does-not-exist' })).resolves.toBeUndefined();
  });

  it('throws when bindingId is missing', async () => {
    await expect(ctrl.detach({ bindingId: '' })).rejects.toThrow('skills.detach: missing bindingId');
  });
});

// ---------------------------------------------------------------------------
// Tests: skills.listBindings
// ---------------------------------------------------------------------------

describe('skills.listBindings', () => {
  it('returns all bindings for a workspace (both scopes)', async () => {
    await ctrl.attach({ workspaceId: 'ws-1', paneSessionId: null, skillName: 'review', skillSource: 'superpowers' });
    await ctrl.attach({ workspaceId: 'ws-1', paneSessionId: 'pane-1', skillName: 'debug', skillSource: 'ruflo' });
    // Different workspace — must NOT appear.
    await ctrl.attach({ workspaceId: 'ws-2', paneSessionId: null, skillName: 'other', skillSource: 'custom' });

    const results = await ctrl.listBindings({ workspaceId: 'ws-1' });

    expect(results).toHaveLength(2);
    const names = results.map((r) => r.skillName).sort();
    expect(names).toEqual(['debug', 'review']);
  });

  it('does NOT return bindings from a different workspace', async () => {
    await ctrl.attach({ workspaceId: 'ws-other', paneSessionId: null, skillName: 'review', skillSource: 'superpowers' });

    const results = await ctrl.listBindings({ workspaceId: 'ws-1' });
    expect(results).toHaveLength(0);
  });

  it('returns empty array when no bindings exist', async () => {
    const results = await ctrl.listBindings({ workspaceId: 'ws-empty' });
    expect(results).toHaveLength(0);
  });

  it('throws when workspaceId is missing', async () => {
    await expect(ctrl.listBindings({ workspaceId: '' })).rejects.toThrow('skills.listBindings: missing workspaceId');
  });

  it('reflects detach — removed binding no longer appears in list', async () => {
    const binding = await ctrl.attach({
      workspaceId: 'ws-1',
      paneSessionId: null,
      skillName: 'review',
      skillSource: 'superpowers',
    });

    await ctrl.detach({ bindingId: binding.id });

    const results = await ctrl.listBindings({ workspaceId: 'ws-1' });
    expect(results).toHaveLength(0);
  });
});
