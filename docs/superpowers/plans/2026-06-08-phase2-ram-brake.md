# Phase 2 RAM Brake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent surprise high-RAM pane launches by detecting risky resume sessions, offering strict/no-MCP launch modes, and showing whether RSS comes from the root CLI or MCP children.

**Architecture:** Add focused main-process risk analyzers under `core/ram-brake`, then thread an explicit launch mode through workspace launches. Reuse the existing process-tree RPC from Phase 1 for renderer breakdown. Keep current full-resume/full-tools behavior available only through explicit operator choice when risk is high.

**Tech Stack:** TypeScript, Electron main process, React renderer, Vitest, better-sqlite3.

---

## File Structure

- Create `app/src/main/core/ram-brake/session-risk.ts`: provider session path resolution, JSONL byte/line analysis, risk thresholds.
- Create `app/src/main/core/ram-brake/session-risk.test.ts`: TDD coverage for low/medium/high/critical, malformed JSONL, missing sessions.
- Create `app/src/main/core/ram-brake/mcp-launch-mode.ts`: strict MCP mode types and Claude argv/config helpers.
- Create `app/src/main/core/ram-brake/mcp-launch-mode.test.ts`: strict empty/core/full launch-mode tests.
- Modify `app/src/shared/types.ts`: add `PaneLaunchMode`, `McpLaunchMode`, and optional pane launch fields.
- Modify `app/src/main/core/workspaces/launcher.ts`: apply selected launch modes before `resolveAndSpawn`.
- Modify `app/src/main/core/swarms/factory-spawn.ts`: preserve default behavior; add strict mode support only if `AddAgentToSwarmInput` later carries it.
- Modify `app/src/main/rpc-router.ts`, `app/src/shared/router-shape.ts`, `app/src/main/core/rpc/schemas.ts`: add risk-preview RPC for renderer launch flows.
- Modify renderer launch components after main-process behavior is green: workspace launcher and +Pane dialog.

---

### Task 1: Session Risk Analyzer

**Files:**
- Create: `app/src/main/core/ram-brake/session-risk.ts`
- Create: `app/src/main/core/ram-brake/session-risk.test.ts`

- [x] **Step 1: Write failing tests for risk classification**

Create `app/src/main/core/ram-brake/session-risk.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(classifyClaudeSessionRisk({ sessionBytes: 5 * 1024 * 1024, lineCount: 1000 })).toBe('high');
  });

  it('classifies an 1801-line transcript as critical risk', () => {
    expect(classifyClaudeSessionRisk({ sessionBytes: 2 * 1024 * 1024, lineCount: 1801 })).toBe('critical');
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
```

- [x] **Step 2: Run the tests and verify red**

Run:

```bash
pnpm vitest run src/main/core/ram-brake/session-risk.test.ts
```

Expected: FAIL because `session-risk.ts` does not exist.

- [x] **Step 3: Implement `session-risk.ts`**

Create `app/src/main/core/ram-brake/session-risk.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeSlugForCwd } from '../pty/claude-resume-sigma';

export type SessionRiskLevel = 'unknown' | 'low' | 'medium' | 'high' | 'critical';

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

  const ageMs = Math.max(0, now - stat.mtimeMs);
  if (ageMs > 24 * 60 * 60 * 1000) reasons.push('old-session');
  if (stat.size >= 4 * 1024 * 1024) reasons.push('large-jsonl');
  if (lines.length >= 1200) reasons.push('many-lines');

  const estimatedTokens =
    estimatedTextBytes > 0 ? Math.ceil(estimatedTextBytes / 4) : null;
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
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + sumStringBytes(item), 0);
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + sumStringBytes(item), 0);
  }
  return 0;
}
```

- [x] **Step 4: Run the tests and verify green**

Run:

```bash
pnpm vitest run src/main/core/ram-brake/session-risk.test.ts
```

Expected: PASS.

---

### Task 2: Strict MCP Launch Mode Helper

**Files:**
- Create: `app/src/main/core/ram-brake/mcp-launch-mode.ts`
- Create: `app/src/main/core/ram-brake/mcp-launch-mode.test.ts`
- Modify: `app/src/shared/types.ts`

- [x] **Step 1: Add shared launch-mode types**

In `app/src/shared/types.ts`, add:

```ts
export type PaneLaunchMode = 'fresh' | 'resume-full' | 'resume-summary';
export type McpLaunchMode = 'inherit' | 'strict-core' | 'none';
```

Extend `PaneAssignment`:

```ts
  launchMode?: PaneLaunchMode;
  mcpLaunchMode?: McpLaunchMode;
```

- [x] **Step 2: Write failing tests for Claude strict MCP args**

Create `app/src/main/core/ram-brake/mcp-launch-mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildClaudeMcpLaunchArgs } from './mcp-launch-mode';

describe('buildClaudeMcpLaunchArgs', () => {
  it('returns no args for inherited MCP mode', () => {
    expect(buildClaudeMcpLaunchArgs({ mode: 'inherit' })).toEqual([]);
  });

  it('returns strict empty MCP config for no-MCP diagnostic mode', () => {
    expect(buildClaudeMcpLaunchArgs({ mode: 'none' })).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ]);
  });

  it('returns strict core config with Ruflo HTTP URL when provided', () => {
    const args = buildClaudeMcpLaunchArgs({
      mode: 'strict-core',
      rufloHttpUrl: 'http://127.0.0.1:4317/mcp',
    });

    expect(args[0]).toBe('--strict-mcp-config');
    expect(args[1]).toBe('--mcp-config');
    expect(JSON.parse(args[2]!).mcpServers.ruflo.type).toBe('http');
  });
});
```

- [x] **Step 3: Run the tests and verify red**

Run:

```bash
pnpm vitest run src/main/core/ram-brake/mcp-launch-mode.test.ts
```

Expected: FAIL because `mcp-launch-mode.ts` does not exist.

- [x] **Step 4: Implement helper**

Create `app/src/main/core/ram-brake/mcp-launch-mode.ts`:

```ts
import type { McpLaunchMode } from '../../../shared/types';

export interface BuildClaudeMcpLaunchArgsInput {
  mode: McpLaunchMode;
  rufloHttpUrl?: string | null;
}

export function buildClaudeMcpLaunchArgs(input: BuildClaudeMcpLaunchArgsInput): string[] {
  if (input.mode === 'inherit') return [];
  if (input.mode === 'none') {
    return ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} })];
  }
  if (input.mode === 'strict-core' && input.rufloHttpUrl) {
    return [
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          ruflo: {
            type: 'http',
            url: input.rufloHttpUrl,
          },
        },
      }),
    ];
  }
  return ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} })];
}
```

- [x] **Step 5: Run tests and verify green**

Run:

```bash
pnpm vitest run src/main/core/ram-brake/mcp-launch-mode.test.ts
```

Expected: PASS.

---

### Task 3: Workspace Launcher Integration

**Files:**
- Modify: `app/src/main/core/workspaces/launcher.ts`
- Test: `app/src/main/core/workspaces/launcher.test.ts`

- [x] **Step 1: Add a launcher test for no-MCP mode**

Add a focused test near existing resume/argument tests that constructs a Claude pane with:

```ts
{
  providerId: 'claude',
  launchMode: 'resume-full',
  mcpLaunchMode: 'none',
}
```

Assert the spawned argv contains:

```ts
['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
```

- [x] **Step 2: Run the test and verify red**

Run the focused launcher test:

```bash
pnpm vitest run src/main/core/workspaces/launcher.test.ts
```

Expected: FAIL because launch modes are not applied.

- [x] **Step 3: Apply Claude MCP launch args before spawn**

In `app/src/main/core/workspaces/launcher.ts`, import:

```ts
import { buildClaudeMcpLaunchArgs } from '../ram-brake/mcp-launch-mode';
```

Before `resolveAndSpawn`, compute:

```ts
const mcpArgs =
  provider.id === 'claude'
    ? buildClaudeMcpLaunchArgs({
        mode: pane.mcpLaunchMode ?? 'inherit',
        rufloHttpUrl: undefined,
      })
    : [];
```

Append `mcpArgs` to the final provider args after resume args and before prompt/model args.

- [x] **Step 4: Run launcher tests**

Run:

```bash
pnpm vitest run src/main/core/workspaces/launcher.test.ts
```

Expected: PASS.

---

### Task 4: Risk Preview RPC

**Files:**
- Modify: `app/src/main/rpc-router.ts`
- Modify: `app/src/shared/router-shape.ts`
- Modify: `app/src/main/core/rpc/schemas.ts`
- Test: `app/src/main/core/rpc/schemas.test.ts`

- [x] **Step 1: Add schema test for `ramBrake.sessionRisk`**

Add an RPC schema test that validates:

```ts
{
  providerId: 'claude',
  cwd: '/tmp/project',
  externalSessionId: '37846eca-4143-4f3b-a1b5-5fe919ddf2b3'
}
```

and expects output fields including `riskLevel`, `sessionBytes`, `lineCount`, and `reasons`.

- [x] **Step 2: Add router shape**

Add:

```ts
ramBrake: {
  sessionRisk: (input: {
    providerId: string;
    cwd: string;
    externalSessionId?: string | null;
  }) => Promise<SessionRiskReport>;
};
```

- [x] **Step 3: Add controller implementation**

In `rpc-router.ts`, import `analyzeSessionRisk` and expose:

```ts
ramBrake: {
  sessionRisk: async (input) => analyzeSessionRisk(input),
}
```

- [x] **Step 4: Run schema tests**

Run:

```bash
pnpm vitest run src/main/core/rpc/schemas.test.ts
```

Expected: PASS.

---

### Task 5: Renderer Decision Dialog

**Files:**
- Modify: workspace launcher component that submits `LaunchPlan`
- Modify: `app/src/renderer/features/command-room/AddPaneButton.tsx`
- Test adjacent renderer tests

- [x] **Step 1: Add high-risk dialog test**

Mock `rpc.ramBrake.sessionRisk` to return:

```ts
{
  riskLevel: 'high',
  sessionBytes: 7_100_000,
  lineCount: 1803,
  ageMs: 2 * 24 * 60 * 60 * 1000,
  estimatedTokens: 431_500,
  reasons: ['large-jsonl', 'many-lines', 'old-session']
}
```

Assert the launch surface renders "Resume from summary", "Resume full session", "Start fresh", and "No MCP diagnostic".

- [x] **Step 2: Implement minimal dialog state**

Add local state for pending high-risk launch. On user action:

- `Resume from summary`: submit with `launchMode: 'resume-summary'`, `mcpLaunchMode: 'strict-core'`.
- `Resume full session`: submit with `launchMode: 'resume-full'`, `mcpLaunchMode: 'inherit'`, and existing `forceRamBrake`.
- `Start fresh`: clear resume session id and submit `launchMode: 'fresh'`.
- `No MCP diagnostic`: submit with selected resume/fresh mode and `mcpLaunchMode: 'none'`.

- [x] **Step 3: Run renderer tests**

Run:

```bash
pnpm vitest run src/renderer/features/workspace-launcher/Launcher.test.tsx src/renderer/features/command-room/AddPaneButton.test.tsx
```

Expected: PASS.

---

### Task 6: Pane RSS Breakdown

**Files:**
- Modify: `app/src/renderer/features/command-room/usePaneLiveStats.ts`
- Modify: pane header component that renders RSS
- Test: `app/src/renderer/features/command-room/usePaneLiveStats.test.ts`

- [x] **Step 1: Extend live stats test**

Mock `pty.processStats` to include:

```ts
nodes: [
  { pid: 1, ppid: 0, rssBytes: 500 * 1024 * 1024, command: 'claude', args: 'claude --resume x' },
  { pid: 2, ppid: 1, rssBytes: 300 * 1024 * 1024, command: 'node', args: 'mcp start' },
]
```

Assert the hook/component exposes total RSS, root RSS, MCP RSS, process count, and top child command.

- [x] **Step 2: Implement breakdown helper**

Compute:

```ts
const root = nodes.find((node) => node.pid === pane.pid) ?? nodes[0];
const rootRssBytes = root?.rssBytes ?? 0;
const mcpRssBytes = nodes
  .filter((node) => node.pid !== root?.pid && /mcp|ruflo|claude-flow|context7/i.test(`${node.command} ${node.args}`))
  .reduce((sum, node) => sum + node.rssBytes, 0);
```

- [x] **Step 3: Run live stats tests**

Run:

```bash
pnpm vitest run src/renderer/features/command-room/usePaneLiveStats.test.ts
```

Expected: PASS.

---

### Task 7: Verification

- [x] **Step 1: Run focused Phase 2 tests**

Run:

```bash
pnpm vitest run src/main/core/ram-brake/session-risk.test.ts src/main/core/ram-brake/mcp-launch-mode.test.ts src/main/core/workspaces/launcher.test.ts src/main/core/rpc/schemas.test.ts src/renderer/features/command-room/usePaneLiveStats.test.ts
```

Expected: PASS.

- [x] **Step 2: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [x] **Step 3: Manual verification**

Launch a high-risk Claude resume and verify:

- The UI warns before spawn.
- "No MCP diagnostic" passes `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`.
- Process stats show no MCP child processes under the pane root.
- "Resume full session" still works after explicit confirmation.
