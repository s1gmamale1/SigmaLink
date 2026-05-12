import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { closeDatabase, getDb, getRawDb, initializeDatabase } from '../db/client';
import { SwarmMailbox } from './mailbox';
import {
  createDbFake,
  seedAgent,
  seedSwarm,
  seedWorkspace,
  type DbFake,
} from '@/test-utils/db-fake';

type Role = 'coordinator' | 'builder' | 'scout' | 'reviewer';

interface SeedAgentSpec {
  role: Role;
  index: number;
}

const tmpDirs: string[] = [];

function makeUserData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-mailbox-test-'));
  tmpDirs.push(dir);
  return dir;
}

function seedSwarmRoster(
  fake: DbFake,
  mailbox: SwarmMailbox,
  swarmId: string,
  agents: SeedAgentSpec[],
): void {
  const workspace = seedWorkspace(fake, { id: randomUUID(), rootPath: `/tmp/${randomUUID()}` });
  seedSwarm(fake, { id: swarmId, workspaceId: workspace.id as string });

  for (const agent of agents) {
    const agentKey = `${agent.role}-${agent.index}`;
    const sessionId = `${swarmId}:${agentKey}`;
    const inboxPath = mailbox.ensureInbox(swarmId, agentKey);
    seedAgent(fake, {
      swarmId,
      role: agent.role,
      roleIndex: agent.index,
      providerId: 'codex',
      sessionId,
      inboxPath,
      agentKey,
    });
  }
}

function readInbox(userDataDir: string, swarmId: string, agentKey: string): string {
  const inboxPath = path.join(
    userDataDir,
    'swarms',
    swarmId,
    'inboxes',
    `${agentKey}.jsonl`,
  );
  return fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : '';
}

function sortEchoes(
  echoed: Array<{ swarmId: string; toAgent: string; body: string }>,
): Array<{ swarmId: string; toAgent: string; body: string }> {
  return [...echoed].sort((a, b) => a.toAgent.localeCompare(b.toAgent));
}

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
  vi.mocked(initializeDatabase).mockReturnValue({
    db: fake.drizzle as unknown as ReturnType<typeof initializeDatabase>['db'],
    raw: fake.raw as unknown as ReturnType<typeof initializeDatabase>['raw'],
    filePath: '/tmp/fake.db',
  });
  vi.mocked(closeDatabase).mockReturnValue(undefined);
});

afterEach(() => {
  closeDatabase();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SwarmMailbox broadcast resilience (BUG-V1.1.3-ORCH-01)', () => {
  it('continues delivering to remaining recipients when one paneEcho throws', async () => {
    // Audit fix: a single failing recipient (PTY exited, fs flap, etc.) must
    // not abort the broadcast loop. Every other roster member still receives
    // the message both in their JSONL inbox AND via paneEcho.
    const userDataDir = makeUserData();
    initializeDatabase(userDataDir);
    const mailbox = new SwarmMailbox(userDataDir);
    const swarmId = randomUUID();
    seedSwarmRoster(fake, mailbox, swarmId, [
      { role: 'coordinator', index: 1 },
      { role: 'coordinator', index: 2 },
      { role: 'coordinator', index: 3 },
    ]);

    const echoed: Array<{ swarmId: string; toAgent: string; body: string }> = [];
    mailbox.setPaneEcho((sId, toAgent, body) => {
      // Simulate a hung/destroyed PTY for coordinator-2 — the closure throws
      // mid-loop. The remaining coordinators must still get pane echo.
      if (toAgent === 'coordinator-2') {
        throw new Error('PTY exited');
      }
      echoed.push({ swarmId: sId, toAgent, body });
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await mailbox.append({
      swarmId,
      fromAgent: 'operator',
      toAgent: '@coordinators',
      kind: 'directive',
      body: 'attention',
      echo: 'pane',
    });

    // coordinator-1 and coordinator-3 still received pane echo even though
    // coordinator-2 threw.
    expect(sortEchoes(echoed)).toEqual([
      { swarmId, toAgent: 'coordinator-1', body: 'attention' },
      { swarmId, toAgent: 'coordinator-3', body: 'attention' },
    ]);
    // All three inboxes still got the JSONL mirror — JSONL is independent of
    // paneEcho and runs first.
    expect(readInbox(userDataDir, swarmId, 'coordinator-1')).toContain('attention');
    expect(readInbox(userDataDir, swarmId, 'coordinator-2')).toContain('attention');
    expect(readInbox(userDataDir, swarmId, 'coordinator-3')).toContain('attention');
    // The failure was logged with the recipient key + swarmId.
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('paneEcho failed') && m.includes('coordinator-2'))).toBe(true);

    warnSpy.mockRestore();
  });

  it('continues mirroring to remaining inboxes when one JSONL write throws', async () => {
    // Same contract as paneEcho — one bad inbox path must not strand the rest.
    // We poison `coordinator-2`'s inbox file by replacing it with a directory
    // so appendFileSync throws EISDIR; the other two still receive the line.
    const userDataDir = makeUserData();
    initializeDatabase(userDataDir);
    const mailbox = new SwarmMailbox(userDataDir);
    const swarmId = randomUUID();
    seedSwarmRoster(fake, mailbox, swarmId, [
      { role: 'coordinator', index: 1 },
      { role: 'coordinator', index: 2 },
      { role: 'coordinator', index: 3 },
    ]);

    // Replace coordinator-2's inbox with a directory so appendFileSync errors.
    const badInbox = path.join(userDataDir, 'swarms', swarmId, 'inboxes', 'coordinator-2.jsonl');
    fs.rmSync(badInbox, { force: true });
    fs.mkdirSync(badInbox, { recursive: true });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await mailbox.append({
      swarmId,
      fromAgent: 'operator',
      toAgent: '@all',
      kind: 'directive',
      body: 'hello',
    });

    // coordinator-1 and coordinator-3 still received their JSONL mirror.
    expect(readInbox(userDataDir, swarmId, 'coordinator-1')).toContain('hello');
    expect(readInbox(userDataDir, swarmId, 'coordinator-3')).toContain('hello');
    // The failure was logged with the agent key.
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('JSONL mirror failed') && m.includes('coordinator-2'))).toBe(true);

    warnSpy.mockRestore();
  });
});

describe('SwarmMailbox operator broadcast delivery', () => {
  it('fans out @coordinators and @all only inside the addressed swarm', async () => {
    const userDataDir = makeUserData();
    initializeDatabase(userDataDir);
    const mailbox = new SwarmMailbox(userDataDir);
    const swarmA = randomUUID();
    const swarmB = randomUUID();
    seedSwarmRoster(fake, mailbox, swarmA, [
      { role: 'coordinator', index: 1 },
      { role: 'coordinator', index: 2 },
      { role: 'builder', index: 1 },
    ]);
    seedSwarmRoster(fake, mailbox, swarmB, [
      { role: 'coordinator', index: 1 },
      { role: 'coordinator', index: 2 },
      { role: 'builder', index: 1 },
    ]);

    const echoed: Array<{ swarmId: string; toAgent: string; body: string }> = [];
    mailbox.setPaneEcho((swarmId, toAgent, body) => {
      echoed.push({ swarmId, toAgent, body });
    });

    await mailbox.append({
      swarmId: swarmA,
      fromAgent: 'operator',
      toAgent: '@coordinators',
      kind: 'directive',
      body: 'sync up',
      echo: 'pane',
    });

    expect(sortEchoes(echoed)).toEqual([
      { swarmId: swarmA, toAgent: 'coordinator-1', body: 'sync up' },
      { swarmId: swarmA, toAgent: 'coordinator-2', body: 'sync up' },
    ]);
    expect(readInbox(userDataDir, swarmA, 'coordinator-1')).toContain('sync up');
    expect(readInbox(userDataDir, swarmA, 'coordinator-2')).toContain('sync up');
    expect(readInbox(userDataDir, swarmA, 'builder-1')).toBe('');
    expect(readInbox(userDataDir, swarmB, 'coordinator-1')).toBe('');
    expect(readInbox(userDataDir, swarmB, 'coordinator-2')).toBe('');
    expect(readInbox(userDataDir, swarmB, 'builder-1')).toBe('');

    echoed.length = 0;
    await mailbox.append({
      swarmId: swarmA,
      fromAgent: 'operator',
      toAgent: '@all',
      kind: 'directive',
      body: 'all hands',
      echo: 'pane',
    });

    expect(sortEchoes(echoed)).toEqual([
      { swarmId: swarmA, toAgent: 'builder-1', body: 'all hands' },
      { swarmId: swarmA, toAgent: 'coordinator-1', body: 'all hands' },
      { swarmId: swarmA, toAgent: 'coordinator-2', body: 'all hands' },
    ]);
    expect(readInbox(userDataDir, swarmA, 'coordinator-1')).toContain('all hands');
    expect(readInbox(userDataDir, swarmA, 'coordinator-2')).toContain('all hands');
    expect(readInbox(userDataDir, swarmA, 'builder-1')).toContain('all hands');
    expect(readInbox(userDataDir, swarmB, 'coordinator-1')).toBe('');
    expect(readInbox(userDataDir, swarmB, 'coordinator-2')).toBe('');
    expect(readInbox(userDataDir, swarmB, 'builder-1')).toBe('');
  });
});
