import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeSessionRisk,
  claudeSessionFilePath,
  classifyClaudeSessionRisk,
} from './session-risk';

const tmpDirs: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-risk-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJsonl(file: string, lines: number, payloadBytes: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = 'x'.repeat(payloadBytes);
  const rows = Array.from({ length: lines }, (_, i) =>
    JSON.stringify({ type: i % 2 === 0 ? 'user' : 'assistant', message: { content: payload } }),
  );
  fs.writeFileSync(file, `${rows.join('\n')}\n`);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('classifyClaudeSessionRisk', () => {
  it('classifies a small transcript as low risk', () => {
    expect(classifyClaudeSessionRisk({ sessionBytes: 500_000, lineCount: 100 })).toBe('low');
  });

  it('classifies a 5 MB transcript as high risk', () => {
    expect(classifyClaudeSessionRisk({ sessionBytes: 5 * 1024 * 1024, lineCount: 1000 })).toBe(
      'high',
    );
  });

  it('classifies an 1801-line transcript as critical risk', () => {
    expect(classifyClaudeSessionRisk({ sessionBytes: 2 * 1024 * 1024, lineCount: 1801 })).toBe(
      'critical',
    );
  });
});

describe('claudeSessionFilePath', () => {
  it('resolves Claude project session files from cwd and external id', () => {
    const homeDir = tmpRoot();
    const cwd = '/Users/dev/project with spaces';
    const sessionId = '37846eca-4143-4f3b-a1b5-5fe919ddf2b3';

    const result = claudeSessionFilePath({ homeDir, cwd, externalSessionId: sessionId });

    expect(result).toBe(
      path.join(
        homeDir,
        '.claude/projects/-Users-dev-project-with-spaces',
        `${sessionId}.jsonl`,
      ),
    );
  });
});

describe('analyzeSessionRisk', () => {
  it('returns high risk with bytes, lines, age, and token estimate for large Claude JSONL', () => {
    const homeDir = tmpRoot();
    const cwd = '/Users/dev/project';
    const externalSessionId = '37846eca-4143-4f3b-a1b5-5fe919ddf2b3';
    const file = claudeSessionFilePath({ homeDir, cwd, externalSessionId });
    writeJsonl(file, 1400, 3800);
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(file, old / 1000, old / 1000);

    const report = analyzeSessionRisk({
      providerId: 'claude',
      cwd,
      externalSessionId,
      homeDir,
      now: old + 2 * 24 * 60 * 60 * 1000,
    });

    expect(report.riskLevel).toBe('high');
    expect(report.sessionBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(report.lineCount).toBe(1400);
    expect(report.estimatedTokens).toBeGreaterThan(1_000_000);
    expect(report.reasons).toContain('large-jsonl');
    expect(report.reasons).toContain('old-session');
  });

  it('classifies oversized Claude JSONL as critical without loading the file body', () => {
    const homeDir = tmpRoot();
    const cwd = '/Users/dev/project';
    const externalSessionId = '37846eca-4143-4f3b-a1b5-5fe919ddf2b3';
    const file = claudeSessionFilePath({ homeDir, cwd, externalSessionId });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.closeSync(fs.openSync(file, 'w'));
    fs.truncateSync(file, 9 * 1024 * 1024);
    const readSpy = vi.spyOn(fs, 'readFileSync');

    const report = analyzeSessionRisk({ providerId: 'claude', cwd, externalSessionId, homeDir });

    expect(report.riskLevel).toBe('critical');
    expect(report.sessionBytes).toBe(9 * 1024 * 1024);
    expect(report.reasons).toContain('oversized-jsonl');
    expect(readSpy).not.toHaveBeenCalledWith(file, 'utf8');
  });

  it('does not throw on malformed JSONL and records partial parse reason', () => {
    const homeDir = tmpRoot();
    const cwd = '/Users/dev/project';
    const externalSessionId = '37846eca-4143-4f3b-a1b5-5fe919ddf2b3';
    const file = claudeSessionFilePath({ homeDir, cwd, externalSessionId });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"message":{"content":"hello"}}\nnot json\n');

    const report = analyzeSessionRisk({ providerId: 'claude', cwd, externalSessionId, homeDir });

    expect(report.riskLevel).toBe('low');
    expect(report.reasons).toContain('partial-jsonl-parse');
  });

  it('returns unknown risk when a specific session file is missing', () => {
    const report = analyzeSessionRisk({
      providerId: 'claude',
      cwd: '/Users/dev/project',
      externalSessionId: '37846eca-4143-4f3b-a1b5-5fe919ddf2b3',
      homeDir: tmpRoot(),
    });

    expect(report.riskLevel).toBe('unknown');
    expect(report.reasons).toContain('session-file-missing');
  });
});
