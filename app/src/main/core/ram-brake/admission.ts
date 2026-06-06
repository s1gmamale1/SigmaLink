import type Database from 'better-sqlite3';
import {
  DEFAULT_AGENT_RUNTIME_PROFILE_ID,
  normalizeAgentRuntimeProfileId,
  profileIsMcpHeavy,
  type AgentRuntimeProfileId,
} from '../../../shared/runtime-profiles';
import {
  RAM_BRAKE_ERROR_PREFIX,
  type RamBrakeAdmissionDetails,
} from '../../../shared/ram-brake';

export { RAM_BRAKE_ERROR_PREFIX } from '../../../shared/ram-brake';

export interface RamBrakeCaps {
  maxTotalLiveAgents: number;
  maxWorkspaceLiveAgents: number;
  maxTotalMcpHeavyAgents: number;
  maxWorkspaceMcpHeavyAgents: number;
}

export interface RamBrakeAdmissionRequest {
  workspaceId: string;
  requestedProfiles: unknown[];
  force?: boolean;
}

const DEFAULT_CAPS: RamBrakeCaps = {
  maxTotalLiveAgents: 12,
  maxWorkspaceLiveAgents: 8,
  maxTotalMcpHeavyAgents: 2,
  maxWorkspaceMcpHeavyAgents: 1,
};

const KV_KEYS: Record<keyof RamBrakeCaps, string> = {
  maxTotalLiveAgents: 'ramBrake.maxTotalLiveAgents',
  maxWorkspaceLiveAgents: 'ramBrake.maxWorkspaceLiveAgents',
  maxTotalMcpHeavyAgents: 'ramBrake.maxTotalMcpHeavyAgents',
  maxWorkspaceMcpHeavyAgents: 'ramBrake.maxWorkspaceMcpHeavyAgents',
};

export class RamBrakeAdmissionError extends Error {
  readonly details: RamBrakeAdmissionDetails;

  constructor(details: RamBrakeAdmissionDetails) {
    super(`${RAM_BRAKE_ERROR_PREFIX}${JSON.stringify(details)}`);
    this.name = 'RamBrakeAdmissionError';
    this.details = details;
  }
}

function readPositiveInt(db: Database.Database, key: string, fallback: number): number {
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    const parsed = Number(row?.value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function readRamBrakeCaps(db: Database.Database): RamBrakeCaps {
  return {
    maxTotalLiveAgents: readPositiveInt(db, KV_KEYS.maxTotalLiveAgents, DEFAULT_CAPS.maxTotalLiveAgents),
    maxWorkspaceLiveAgents: readPositiveInt(db, KV_KEYS.maxWorkspaceLiveAgents, DEFAULT_CAPS.maxWorkspaceLiveAgents),
    maxTotalMcpHeavyAgents: readPositiveInt(db, KV_KEYS.maxTotalMcpHeavyAgents, DEFAULT_CAPS.maxTotalMcpHeavyAgents),
    maxWorkspaceMcpHeavyAgents: readPositiveInt(
      db,
      KV_KEYS.maxWorkspaceMcpHeavyAgents,
      DEFAULT_CAPS.maxWorkspaceMcpHeavyAgents,
    ),
  };
}

function countLive(db: Database.Database, workspaceId?: string): number {
  const whereWorkspace = workspaceId ? 'AND workspace_id = ?' : '';
  const args = workspaceId ? [workspaceId] : [];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM agent_sessions
       WHERE status IN ('starting','running') ${whereWorkspace}`,
    )
    .get(...args) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function countHeavy(db: Database.Database, workspaceId?: string): number {
  const whereWorkspace = workspaceId ? 'AND workspace_id = ?' : '';
  const args = workspaceId ? [workspaceId] : [];
  const rows = db
    .prepare(
      `SELECT runtime_profile_id AS runtimeProfileId
       FROM agent_sessions
       WHERE status IN ('starting','running') ${whereWorkspace}`,
    )
    .all(...args) as Array<{ runtimeProfileId?: string | null }>;
  return rows.filter((row) => {
    const id = normalizeAgentRuntimeProfileId(
      row.runtimeProfileId ?? DEFAULT_AGENT_RUNTIME_PROFILE_ID,
    );
    return profileIsMcpHeavy(id);
  }).length;
}

export function checkRamBrakeAdmission(
  db: Database.Database,
  request: RamBrakeAdmissionRequest,
): RamBrakeAdmissionDetails {
  const caps = readRamBrakeCaps(db);
  const normalizedProfiles = request.requestedProfiles.map((profile) =>
    normalizeAgentRuntimeProfileId(profile),
  );
  const requestedTotal = normalizedProfiles.length;
  const requestedHeavy = normalizedProfiles.filter((profile) => profileIsMcpHeavy(profile)).length;
  const current = {
    totalLiveAgents: countLive(db),
    workspaceLiveAgents: countLive(db, request.workspaceId),
    totalMcpHeavyAgents: countHeavy(db),
    workspaceMcpHeavyAgents: countHeavy(db, request.workspaceId),
  };
  const projected = {
    totalLiveAgents: current.totalLiveAgents + requestedTotal,
    workspaceLiveAgents: current.workspaceLiveAgents + requestedTotal,
    totalMcpHeavyAgents: current.totalMcpHeavyAgents + requestedHeavy,
    workspaceMcpHeavyAgents: current.workspaceMcpHeavyAgents + requestedHeavy,
  };
  const violations: RamBrakeAdmissionDetails['violations'] = [];
  if (projected.totalLiveAgents > caps.maxTotalLiveAgents) violations.push('total');
  if (projected.workspaceLiveAgents > caps.maxWorkspaceLiveAgents) violations.push('workspace');
  if (projected.totalMcpHeavyAgents > caps.maxTotalMcpHeavyAgents) violations.push('total-heavy');
  if (projected.workspaceMcpHeavyAgents > caps.maxWorkspaceMcpHeavyAgents) violations.push('workspace-heavy');

  const details: RamBrakeAdmissionDetails = {
    kind: 'ram-brake-admission',
    caps,
    current,
    requested: {
      totalAgents: requestedTotal,
      mcpHeavyAgents: requestedHeavy,
    },
    projected,
    violations,
  };
  if (!request.force && violations.length > 0) {
    throw new RamBrakeAdmissionError(details);
  }
  return details;
}

export function normalizeProfilesForAdmission(values: unknown[]): AgentRuntimeProfileId[] {
  return values.map((value) => normalizeAgentRuntimeProfileId(value));
}
