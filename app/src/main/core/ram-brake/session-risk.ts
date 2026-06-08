import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeSlugForCwd } from '../pty/claude-resume-sigma';

export type SessionRiskLevel = 'unknown' | 'low' | 'medium' | 'high' | 'critical';
const MAX_JSONL_BODY_READ_BYTES = 8 * 1024 * 1024;

export interface SessionRiskReport {
  providerId: string;
  cwd: string;
  externalSessionId: string | null;
  sessionFilePath: string | null;
  sessionBytes: number;
  lineCount: number;
  ageMs: number | null;
  estimatedTextBytes: number;
  estimatedTokens: number | null;
  riskLevel: SessionRiskLevel;
  reasons: string[];
}

export interface AnalyzeSessionRiskInput {
  providerId: string;
  cwd: string;
  externalSessionId?: string | null;
  homeDir?: string;
  now?: number;
}

export function claudeSessionFilePath(input: {
  homeDir?: string;
  cwd: string;
  externalSessionId: string;
}): string {
  return path.join(
    input.homeDir ?? os.homedir(),
    '.claude',
    'projects',
    claudeSlugForCwd(input.cwd),
    `${input.externalSessionId}.jsonl`,
  );
}

export function classifyClaudeSessionRisk(input: {
  sessionBytes: number;
  lineCount: number;
  priorTotalRssBytes?: number;
}): SessionRiskLevel {
  if ((input.priorTotalRssBytes ?? 0) > 750 * 1024 * 1024) return 'critical';
  if (input.sessionBytes > 8 * 1024 * 1024 || input.lineCount > 1800) return 'critical';
  if (input.sessionBytes >= 4 * 1024 * 1024 || input.lineCount >= 1200) return 'high';
  if (input.sessionBytes >= 1 * 1024 * 1024 || input.lineCount >= 500) return 'medium';
  return 'low';
}

export function analyzeSessionRisk(input: AnalyzeSessionRiskInput): SessionRiskReport {
  const providerId = input.providerId.toLowerCase();
  const externalSessionId = input.externalSessionId?.trim() || null;
  const now = input.now ?? Date.now();
  const reasons: string[] = [];
  const sessionFilePath =
    providerId === 'claude' && externalSessionId
      ? claudeSessionFilePath({
          homeDir: input.homeDir,
          cwd: input.cwd,
          externalSessionId,
        })
      : null;

  if (!sessionFilePath) {
    return baseReport(input, externalSessionId, null, 'unknown', ['unsupported-provider']);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(sessionFilePath);
  } catch {
    return baseReport(input, externalSessionId, sessionFilePath, 'unknown', [
      'session-file-missing',
    ]);
  }

  const ageMs = Math.max(0, now - stat.mtimeMs);
  if (stat.size > MAX_JSONL_BODY_READ_BYTES) {
    if (ageMs > 24 * 60 * 60 * 1000) reasons.push('old-session');
    reasons.push('large-jsonl', 'oversized-jsonl');
    return {
      providerId: input.providerId,
      cwd: input.cwd,
      externalSessionId,
      sessionFilePath,
      sessionBytes: stat.size,
      lineCount: 0,
      ageMs,
      estimatedTextBytes: 0,
      estimatedTokens: null,
      riskLevel: 'critical',
      reasons,
    };
  }

  const text = fs.readFileSync(sessionFilePath, 'utf8');
  const lines = text.length === 0 ? [] : text.split('\n').filter((line) => line.length > 0);
  let estimatedTextBytes = 0;
  let malformed = false;
  for (const line of lines) {
    try {
      estimatedTextBytes += sumStringBytes(JSON.parse(line));
    } catch {
      malformed = true;
    }
  }
  if (malformed) reasons.push('partial-jsonl-parse');

  if (ageMs > 24 * 60 * 60 * 1000) reasons.push('old-session');
  if (stat.size >= 4 * 1024 * 1024) reasons.push('large-jsonl');
  if (lines.length >= 1200) reasons.push('many-lines');

  const estimatedTokens = estimatedTextBytes > 0 ? Math.ceil(estimatedTextBytes / 4) : null;
  const riskLevel =
    providerId === 'claude'
      ? classifyClaudeSessionRisk({ sessionBytes: stat.size, lineCount: lines.length })
      : 'unknown';

  return {
    providerId: input.providerId,
    cwd: input.cwd,
    externalSessionId,
    sessionFilePath,
    sessionBytes: stat.size,
    lineCount: lines.length,
    ageMs,
    estimatedTextBytes,
    estimatedTokens,
    riskLevel,
    reasons,
  };
}

function baseReport(
  input: AnalyzeSessionRiskInput,
  externalSessionId: string | null,
  sessionFilePath: string | null,
  riskLevel: SessionRiskLevel,
  reasons: string[],
): SessionRiskReport {
  return {
    providerId: input.providerId,
    cwd: input.cwd,
    externalSessionId,
    sessionFilePath,
    sessionBytes: 0,
    lineCount: 0,
    ageMs: null,
    estimatedTextBytes: 0,
    estimatedTokens: null,
    riskLevel,
    reasons,
  };
}

function sumStringBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + sumStringBytes(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + sumStringBytes(item), 0);
  }
  return 0;
}
