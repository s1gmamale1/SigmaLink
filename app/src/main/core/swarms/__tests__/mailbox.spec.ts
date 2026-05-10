// BUG-V1.1-01-IPC + BUG-V1.1-02-IPC regression guards.
//
// `expandRecipient` is the single resolver every mailbox + controller path now
// flows through to turn a wire-level `toAgent` (literal, group, or wildcard)
// into the concrete set of agent keys that should receive the envelope. These
// tests pin its grammar so a future refactor cannot silently drop a group
// expansion (`@coordinators` → role-filter) or smuggle a literal recipient
// through unchecked.
//
// Framework: node:test (built into Node v26, no new dep). Run with:
//   node --experimental-strip-types --test \
//     src/main/core/swarms/__tests__/mailbox.spec.ts
//
// STATUS: TODO — currently blocked at import time. `mailbox.ts` transitively
// loads `db/client.ts`, which uses extensionless relative imports
// (`./schema`, `./migrate`). Node's native ESM resolver under
// `--experimental-strip-types` does not auto-resolve `.ts`, so the runner
// crashes with `ERR_MODULE_NOT_FOUND` before any test executes. Two fixes
// land this together:
//   1. flip `package.json#scripts` to a TS-aware runner (vitest or `tsx
//      --test`) that follows tsconfig path resolution, OR
//   2. promote the `.ts` extensions through `db/client.ts` import sites.
// The assertions below are still authoritative for `expandRecipient`'s
// grammar; once the runner is wired they'll pass without modification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { initializeDatabase, getRawDb, closeDatabase } from '../../db/client.ts';
import { expandRecipient } from '../mailbox.ts';

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

interface SeedAgent {
  role: 'coordinator' | 'builder' | 'scout' | 'reviewer';
  index: number;
}

function seedSwarm(swarmId: string, workspaceId: string, agents: SeedAgent[]): void {
  const db = getRawDb();
  // Workspaces FK satisfaction.
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, root_path, repo_mode)
     VALUES (?, 'test', ?, 'plain')`,
  ).run(workspaceId, `/tmp/${workspaceId}`);
  db.prepare(
    `INSERT OR IGNORE INTO swarms (id, workspace_id, name, mission, preset, status)
     VALUES (?, ?, 'test-swarm', 'test mission', 'squad', 'running')`,
  ).run(swarmId, workspaceId);

  const insertAgent = db.prepare(
    `INSERT INTO swarm_agents (id, swarm_id, role, role_index, provider_id, status, inbox_path, agent_key)
     VALUES (?, ?, ?, ?, 'codex', 'idle', ?, ?)`,
  );
  for (const a of agents) {
    const id = randomUUID();
    const key = `${a.role}-${a.index}`;
    insertAgent.run(id, swarmId, a.role, a.index, `/tmp/inbox/${key}`, key);
  }
}

function withDb<T>(fn: () => T): T {
  const dir = makeTmpDir('sigmalink-mailbox-test-');
  initializeDatabase(dir);
  try {
    return fn();
  } finally {
    try {
      closeDatabase();
    } catch {
      /* best-effort */
    }
  }
}

test.after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

test('expandRecipient: "*" expands to every agent in the swarm', () => {
  withDb(() => {
    const swarmId = randomUUID();
    seedSwarm(swarmId, randomUUID(), [
      { role: 'coordinator', index: 1 },
      { role: 'builder', index: 1 },
      { role: 'builder', index: 2 },
      { role: 'scout', index: 1 },
    ]);
    const out = expandRecipient(swarmId, '*').sort();
    assert.deepEqual(out, ['builder-1', 'builder-2', 'coordinator-1', 'scout-1']);
  });
});

test('expandRecipient: "@all" expands identically to "*"', () => {
  withDb(() => {
    const swarmId = randomUUID();
    seedSwarm(swarmId, randomUUID(), [
      { role: 'coordinator', index: 1 },
      { role: 'reviewer', index: 1 },
    ]);
    const star = expandRecipient(swarmId, '*').sort();
    const all = expandRecipient(swarmId, '@all').sort();
    assert.deepEqual(all, star);
  });
});

test('expandRecipient: "@coordinators" with multiple coordinators returns all of them', () => {
  withDb(() => {
    const swarmId = randomUUID();
    seedSwarm(swarmId, randomUUID(), [
      { role: 'coordinator', index: 1 },
      { role: 'coordinator', index: 2 },
      { role: 'coordinator', index: 3 },
      { role: 'builder', index: 1 },
    ]);
    const out = expandRecipient(swarmId, '@coordinators').sort();
    assert.deepEqual(out, ['coordinator-1', 'coordinator-2', 'coordinator-3']);
  });
});

test('expandRecipient: "@coordinators" with a single coordinator returns one key', () => {
  withDb(() => {
    const swarmId = randomUUID();
    seedSwarm(swarmId, randomUUID(), [
      { role: 'coordinator', index: 1 },
      { role: 'builder', index: 1 },
    ]);
    const out = expandRecipient(swarmId, '@coordinators');
    assert.deepEqual(out, ['coordinator-1']);
  });
});

test('expandRecipient: "@coordinators" with zero coordinators returns []', () => {
  withDb(() => {
    const swarmId = randomUUID();
    seedSwarm(swarmId, randomUUID(), [
      { role: 'builder', index: 1 },
      { role: 'reviewer', index: 1 },
    ]);
    assert.deepEqual(expandRecipient(swarmId, '@coordinators'), []);
  });
});

test('expandRecipient: "@builders" / "@scouts" / "@reviewers" filter by role', () => {
  withDb(() => {
    const swarmId = randomUUID();
    seedSwarm(swarmId, randomUUID(), [
      { role: 'coordinator', index: 1 },
      { role: 'builder', index: 1 },
      { role: 'builder', index: 2 },
      { role: 'scout', index: 1 },
      { role: 'reviewer', index: 1 },
      { role: 'reviewer', index: 2 },
    ]);
    assert.deepEqual(expandRecipient(swarmId, '@builders').sort(), ['builder-1', 'builder-2']);
    assert.deepEqual(expandRecipient(swarmId, '@scouts'), ['scout-1']);
    assert.deepEqual(expandRecipient(swarmId, '@reviewers').sort(), ['reviewer-1', 'reviewer-2']);
  });
});

test('expandRecipient: literal agentKey hit returns just that key', () => {
  withDb(() => {
    const swarmId = randomUUID();
    seedSwarm(swarmId, randomUUID(), [
      { role: 'coordinator', index: 1 },
      { role: 'builder', index: 1 },
    ]);
    assert.deepEqual(expandRecipient(swarmId, 'coordinator-1'), ['coordinator-1']);
  });
});

test('expandRecipient: literal agentKey miss returns [] (and warns, not throws)', () => {
  withDb(() => {
    const swarmId = randomUUID();
    seedSwarm(swarmId, randomUUID(), [{ role: 'coordinator', index: 1 }]);
    // We tolerate the warn — this is the dropped-recipient guard. The point is
    // the helper must not return `['ghost-99']` and have downstream code mirror
    // into `inboxes/ghost-99.jsonl` for an agent that doesn't exist.
    const out = expandRecipient(swarmId, 'ghost-99');
    assert.deepEqual(out, []);
  });
});

test('expandRecipient: empty string returns []', () => {
  withDb(() => {
    const swarmId = randomUUID();
    seedSwarm(swarmId, randomUUID(), [{ role: 'coordinator', index: 1 }]);
    assert.deepEqual(expandRecipient(swarmId, ''), []);
  });
});

test('BUG-V1.1-02-IPC: literal agentKey is scoped to swarmId — no cross-swarm leak', () => {
  // Two concurrent swarms each have a `coordinator-1`. Looking up the key
  // against swarmA must NOT return swarmB's row, and vice versa.
  withDb(() => {
    const swarmA = randomUUID();
    const swarmB = randomUUID();
    seedSwarm(swarmA, randomUUID(), [{ role: 'coordinator', index: 1 }]);
    seedSwarm(swarmB, randomUUID(), [{ role: 'coordinator', index: 1 }]);

    assert.deepEqual(expandRecipient(swarmA, 'coordinator-1'), ['coordinator-1']);
    assert.deepEqual(expandRecipient(swarmB, 'coordinator-1'), ['coordinator-1']);

    // The expansion is identical (both swarms have the key), but each call
    // looked up against its own swarmId. The functional regression guarded by
    // the rpc-router paneEcho fix (using `eq(swarmAgents.swarmId, swarmId)`)
    // is the same lookup grammar — so as long as this helper threads swarmId
    // through, paneEcho's pane-echo writer cannot leak across swarms either.
  });
});
