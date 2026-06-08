# Pane RAM Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce SigmaLink multipane RAM pressure by preferring shared Ruflo HTTP MCP, adding process-tree diagnostics, and making shutdown tree-aware while preserving existing pane behavior.

**Architecture:** Add one shared launch-policy helper for Ruflo MCP transport selection and use it from both workspace and swarm spawn paths. Keep the existing stdio MCP fallback, but first try to start/reuse the per-workspace HTTP daemon. Expand diagnostics and cleanup without changing pane UI flow.

**Tech Stack:** TypeScript, Electron main process, node-pty, better-sqlite3/drizzle, Vitest.

---

## File Structure

- Create `app/src/main/core/workspaces/ruflo-mcp-policy.ts`: shared Ruflo MCP transport policy for pane cwd writes.
- Create `app/src/main/core/workspaces/ruflo-mcp-policy.test.ts`: unit tests for HTTP, stdio fallback, autowrite off, and auto-trust opt-out.
- Modify `app/src/main/core/workspaces/launcher.ts`: use the shared policy in `executeLaunchPlan`.
- Modify `app/src/main/core/swarms/factory-spawn.ts`: use the shared policy in `spawnAgentSession`.
- Modify `app/src/main/core/process/process-tree.ts`: expose process node details already collected by `inspectProcessTree`.
- Modify `app/src/main/rpc-router.ts`: return process node details from `pty.processStats`.
- Modify `app/src/shared/router-shape.ts` and `app/src/main/core/rpc/schemas.ts`: type/schema support for process nodes.
- Modify `app/src/main/core/pty/registry.ts`: make `killAll()` tree-aware.
- Modify or add registry/process tests as needed.

---

### Task 1: Shared Ruflo MCP Transport Policy

**Files:**
- Create: `app/src/main/core/workspaces/ruflo-mcp-policy.ts`
- Create: `app/src/main/core/workspaces/ruflo-mcp-policy.test.ts`
- Modify: `app/src/main/core/workspaces/launcher.ts:293`
- Modify: `app/src/main/core/swarms/factory-spawn.ts:64`

- [x] **Step 1: Write failing tests for transport policy**

Create `app/src/main/core/workspaces/ruflo-mcp-policy.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ensureRufloMcpForPane } from './ruflo-mcp-policy';

function rawDb(valueByKey: Record<string, string | undefined>) {
  return {
    prepare: vi.fn(() => ({
      get: vi.fn((key: string) => ({ value: valueByKey[key] })),
    })),
  } as never;
}

describe('ensureRufloMcpForPane', () => {
  it('starts the workspace HTTP daemon and writes an HTTP Ruflo entry', async () => {
    const spawn = vi.fn().mockResolvedValue({ port: 4567 });
    const write = vi.fn().mockReturnValue({ claude: '/cwd/.mcp.json', trusted: true });

    const result = await ensureRufloMcpForPane({
      cwd: '/cwd',
      workspaceId: 'ws1',
      workspaceRoot: '/workspace',
      runtimeProfileId: 'ruflo-core',
      rawDb: rawDb({}),
      daemon: { spawn, port: vi.fn(() => null) },
      writeRuflo: write,
    });

    expect(spawn).toHaveBeenCalledWith('ws1', '/workspace');
    expect(write).toHaveBeenCalledWith('/cwd', { port: 4567, trust: true });
    expect(result.transport).toBe('http');
  });

  it('reuses an already running daemon port without spawning', async () => {
    const spawn = vi.fn();
    const write = vi.fn().mockReturnValue({ claude: '/cwd/.mcp.json', trusted: true });

    const result = await ensureRufloMcpForPane({
      cwd: '/cwd',
      workspaceId: 'ws1',
      workspaceRoot: '/workspace',
      runtimeProfileId: 'ruflo-core',
      rawDb: rawDb({}),
      daemon: { spawn, port: vi.fn(() => 7777) },
      writeRuflo: write,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('/cwd', { port: 7777, trust: true });
    expect(result.transport).toBe('http');
  });

  it('falls back to stdio when daemon start returns null', async () => {
    const write = vi.fn().mockReturnValue({ claude: '/cwd/.mcp.json', trusted: true });

    const result = await ensureRufloMcpForPane({
      cwd: '/cwd',
      workspaceId: 'ws1',
      workspaceRoot: '/workspace',
      runtimeProfileId: 'ruflo-core',
      rawDb: rawDb({}),
      daemon: { spawn: vi.fn().mockResolvedValue(null), port: vi.fn(() => null) },
      writeRuflo: write,
    });

    expect(write).toHaveBeenCalledWith('/cwd', { port: undefined, trust: true });
    expect(result.transport).toBe('stdio');
  });

  it('does nothing when Ruflo autowrite is disabled', async () => {
    const write = vi.fn();

    const result = await ensureRufloMcpForPane({
      cwd: '/cwd',
      workspaceId: 'ws1',
      workspaceRoot: '/workspace',
      runtimeProfileId: 'ruflo-core',
      rawDb: rawDb({ 'ruflo.autowriteMcp': '0' }),
      daemon: { spawn: vi.fn(), port: vi.fn(() => null) },
      writeRuflo: write,
    });

    expect(write).not.toHaveBeenCalled();
    expect(result.transport).toBe('skipped');
  });
});
```

- [x] **Step 2: Run the new tests and verify they fail**

Run:

```bash
pnpm vitest run src/main/core/workspaces/ruflo-mcp-policy.test.ts
```

Expected: FAIL because `ruflo-mcp-policy.ts` does not exist.

- [x] **Step 3: Implement the shared helper**

Create `app/src/main/core/workspaces/ruflo-mcp-policy.ts`:

```ts
import type Database from 'better-sqlite3';
import {
  profileAllowsMcp,
  type AgentRuntimeProfileId,
} from '../../../shared/runtime-profiles';
import type { RufloHttpDaemonSupervisor } from '../ruflo/http-daemon-supervisor';
import { writeRufloMcpIntoCwd, type WriteRufloIntoCwdResult } from './ruflo-worktree-mcp';
import { KV_RUFLO_AUTOTRUST_MCP, KV_RUFLO_AUTOWRITE_MCP } from './mcp-autowrite';

export type RufloMcpTransport = 'http' | 'stdio' | 'skipped';

export interface EnsureRufloMcpForPaneInput {
  cwd: string;
  workspaceId: string;
  workspaceRoot: string;
  runtimeProfileId: AgentRuntimeProfileId;
  rawDb: Pick<Database.Database, 'prepare'>;
  daemon: Pick<RufloHttpDaemonSupervisor, 'port' | 'spawn'>;
  writeRuflo?: (
    cwd: string,
    opts: { port?: number; trust?: boolean },
  ) => WriteRufloIntoCwdResult;
  logger?: Pick<Console, 'warn'>;
}

export interface EnsureRufloMcpForPaneResult {
  transport: RufloMcpTransport;
  port?: number;
  written: WriteRufloIntoCwdResult | null;
}

export async function ensureRufloMcpForPane(
  input: EnsureRufloMcpForPaneInput,
): Promise<EnsureRufloMcpForPaneResult> {
  if (!profileAllowsMcp(input.runtimeProfileId, 'ruflo')) {
    return { transport: 'skipped', written: null };
  }
  if (!readKvEnabled(input.rawDb, KV_RUFLO_AUTOWRITE_MCP, true)) {
    return { transport: 'skipped', written: null };
  }

  const trust = readKvEnabled(input.rawDb, KV_RUFLO_AUTOTRUST_MCP, true);
  const write = input.writeRuflo ?? writeRufloMcpIntoCwd;
  const logger = input.logger ?? console;

  let port = safePort(input.daemon.port(input.workspaceId));
  if (port === undefined) {
    try {
      const handle = await input.daemon.spawn(input.workspaceId, input.workspaceRoot);
      port = safePort(handle?.port ?? null);
    } catch (err) {
      logger.warn(
        `[ruflo-mcp] HTTP daemon unavailable for workspace ${input.workspaceId}; falling back to stdio: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const written = write(input.cwd, { port, trust });
  return {
    transport: port === undefined ? 'stdio' : 'http',
    port,
    written,
  };
}

function readKvEnabled(
  rawDb: Pick<Database.Database, 'prepare'>,
  key: string,
  defaultValue: boolean,
): boolean {
  try {
    const row = rawDb.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    if (row?.value === '0') return false;
    if (row?.value === '1' || row?.value === 'true') return true;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

function safePort(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
```

- [x] **Step 4: Replace workspace launcher Ruflo autowrite block**

In `app/src/main/core/workspaces/launcher.ts`, import `ensureRufloMcpForPane`:

```ts
import { ensureRufloMcpForPane } from './ruflo-mcp-policy';
```

Replace the direct `writeRufloMcpIntoCwd` call inside `executeLaunchPlan` with:

```ts
          await ensureRufloMcpForPane({
            cwd,
            workspaceId: wsRow.id,
            workspaceRoot: wsRow.repoRoot ?? wsRow.rootPath,
            runtimeProfileId,
            rawDb: getRawDb(),
            daemon: shared.rufloHttpDaemonSupervisor,
          });
```

- [x] **Step 5: Replace swarm launcher Ruflo helper internals**

In `app/src/main/core/swarms/factory-spawn.ts`, import `ensureRufloMcpForPane` and make `ensureRufloInWorktreeCwd` async:

```ts
import { ensureRufloMcpForPane } from '../workspaces/ruflo-mcp-policy';
```

Then replace its body with a call to `ensureRufloMcpForPane`, passing `args.wsRow.repoRoot ?? args.wsRow.rootPath` at the call site. Await the helper before spawning.

- [x] **Step 6: Run focused tests**

Run:

```bash
pnpm vitest run src/main/core/workspaces/ruflo-mcp-policy.test.ts src/main/core/swarms/factory-spawn.test.ts
```

Expected: PASS.

---

### Task 2: Process Tree Diagnostics Payload

**Files:**
- Modify: `app/src/main/core/process/process-tree.ts`
- Modify: `app/src/main/rpc-router.ts:1008`
- Modify: `app/src/shared/router-shape.ts`
- Modify: `app/src/main/core/rpc/schemas.ts`

- [x] **Step 1: Add process node fields to router/schema tests if present**

Search:

```bash
rg -n "processStats|descendantPids|rssBytes|processCount" app/src app/src/main/core/rpc app/src/shared
```

Expected: identify the current schema and type locations.

- [x] **Step 2: Extend `pty.processStats` return payload**

In `app/src/main/rpc-router.ts`, update `processStats` to return:

```ts
nodes: snapshot?.nodes ?? [],
```

alongside the existing fields.

- [x] **Step 3: Update shared types/schema**

Add `nodes` to the TypeScript router shape and Zod schema:

```ts
nodes: Array<{
  pid: number;
  ppid: number;
  rssBytes: number;
  command: string;
  args: string;
}>;
```

- [x] **Step 4: Run RPC/schema tests**

Run:

```bash
pnpm vitest run src/main/core/rpc/schemas.test.ts src/shared/rpc-channels.test.ts
```

Expected: PASS.

---

### Task 3: Tree-Aware Bulk Shutdown

**Files:**
- Modify: `app/src/main/core/pty/registry.ts`
- Modify: `app/src/main/core/pty/registry.test.ts` if present

- [x] **Step 1: Locate `killAll()`**

Run:

```bash
rg -n "killAll\\(" app/src/main/core/pty app/src/main
```

Expected: find `PtyRegistry.killAll()`.

- [x] **Step 2: Add or update test for tree-aware bulk stop**

If `app/src/main/core/pty/registry.test.ts` exists, add a test that spies on `stopProcessTree` or uses a fake PTY process snapshot seam. If there is no existing seam, keep this task to implementation plus existing registry tests.

- [x] **Step 3: Change `killAll()` to use tree-aware bulk stop**

Use a snapshot of session ids to avoid mutating during iteration:

```ts
killAll(): void {
  for (const id of Array.from(this.sessions.keys())) {
    this.stop(id, { tree: true });
  }
}
```

If the current method also clears records, preserve existing record cleanup semantics after stopping.

- [x] **Step 4: Run PTY tests**

Run:

```bash
pnpm vitest run src/main/core/pty
```

Expected: PASS.

---

### Task 4: Verification And RAM Evidence

**Files:**
- No required source changes.

- [x] **Step 1: Run focused changed-module tests**

Run:

```bash
pnpm vitest run src/main/core/workspaces/ruflo-mcp-policy.test.ts src/main/core/swarms/factory-spawn.test.ts src/main/core/pty src/main/core/rpc/schemas.test.ts
```

Expected: PASS.

- [x] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS, or use the repo's actual typecheck script from `package.json` if named differently.

- [ ] **Step 3: Capture process evidence manually**

Launch a small test workspace with two Ruflo panes, then run:

```bash
ps -axo pid,ppid,rss,comm,args | rg -i "claude|codex|ruflo|claude-flow|mcp start"
```

Expected: pane `.mcp.json` files use `url` for Ruflo when the daemon is running, and ordinary panes no longer each have their own Ruflo stdio child.

---

## Self-Review

- Spec coverage: shared Ruflo HTTP, stdio fallback, diagnostics payload, and tree-aware cleanup are all covered.
- Placeholder scan: no TBD/TODO/fill-later instructions are present.
- Type consistency: `EnsureRufloMcpForPaneResult.transport` is consistently `'http' | 'stdio' | 'skipped'`; process node shape matches `ProcessTreeNode`.
