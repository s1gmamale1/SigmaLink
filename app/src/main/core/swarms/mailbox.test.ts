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
