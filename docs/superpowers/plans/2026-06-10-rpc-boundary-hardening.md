# RPC Boundary Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close five evidence-verified boundary gaps from the 2026-06-10 audit: contain the renderer-supplied `panes.brief` worktreePath before the CLAUDE.md write (HIGH), sandbox `fs.exists` (existence oracle), restore M1 model-allowlist parity in the swarm spawn twin, thread the notifications/pty-error sinks through the assistant/design/sigmabench launch paths, and always-wire the scrollback exit sink so runtime toggle-ON works.

**Architecture:** Every fix is "validate/wire at the boundary" — no new subsystems. Logic that needs unit tests is extracted into the existing DI-factory seams (`core/workspaces/scope-block.ts`, `core/fs/controller.ts`, `core/pty/scrollback-store.ts`) because `rpc-router.ts` cannot load under vitest (it pulls electron + better-sqlite3, which is built for Electron's ABI). The router keeps only one-line wiring that is verified by `tsc` + a grep step. Containment reuses the existing keystone `assertAllowedPath` (`core/security/path-guard.ts` — realpath-safe, fail-closed, already unit-tested).

**Tech Stack:** TypeScript (Electron main process), Zod RPC schemas, vitest (node ABI — NEVER import electron/better-sqlite3 in tests; use the established mock/DI patterns: `vi.mock('../db/client')`, injected `allowedRoots` providers, `makeCtx`/`makeDeps` helpers).

---

## Preflight — re-verify before every task (MANDATORY)

This repo runs MANY concurrent sessions; the shared tree + line numbers drift. This plan was written against `main` @ `a4156ac` (2026-06-10). At plan time the conversation-start git snapshot showed uncommitted WIP on `app/src/main/core/assistant/tools.ts` (branch `feat/bsp-pane-tiling`); by recon time that WIP had already landed on main and the tree was clean. **Treat every `file:line` below as an anchor hint, not gospel.**

Before EACH task, from `/Users/aisigma/projects/SigmaLink/app`:

- [ ] **Step 0: Re-verify the finding against the then-current tree**

```bash
git -C /Users/aisigma/projects/SigmaLink status --short   # expect clean or know why not
git -C /Users/aisigma/projects/SigmaLink rev-parse --short HEAD
# Per-task grep anchors are listed in each task. If an anchor no longer matches
# (a concurrent session fixed or moved it), STOP, re-read the region, and either
# mark the finding "already fixed" in the commit message or adapt the edit.
```

Especially Task 4: `tools.ts` / `tools.test.ts` are active WIP targets — re-grep `executeLaunchPlan(` in `tools.ts` and confirm the deps object still lacks `notifications`/`broadcastPtyError` before editing.

---

## File Structure

No new source files — every fix lands in an existing file (repo rule: prefer editing existing files; all stay well under 500 lines except the pre-existing `rpc-router.ts`, which gets only one-line wiring edits, no restructure).

```
app/src/main/
  rpc-router.ts                          # wiring-only edits: panes.brief handler, fs.exists,
                                         #   onSessionExit sink, sigmabench deps, assistant/design ctl deps
  core/workspaces/
    scope-block.ts                       # + briefPane() — containment + scope-write + PTY inject (Task 1)
    scope-block.test.ts                  # + briefPane tests
  core/fs/
    controller.ts                        # + fsExists() — sandboxed existence probe (Task 2)
    controller.test.ts                   # + fsExists tests
  core/swarms/
    factory-spawn.ts                     # buildExtraArgs gains the M1 catalog allowlist (Task 3)
    factory-spawn.test.ts                # + allowlist tests
  core/assistant/
    tools.ts                             # ToolContext + launch_pane sink threading (Task 4)
    tools.test.ts                        # + launch_pane sink test
    controller.ts                        # AssistantControllerDeps + ctx + 2 dispatch sites (Task 4)
    controller.test.ts                   # + dispatchPane sink test
  core/design/
    controller.ts                        # DesignControllerDeps + 1 dispatch site (Task 4)
  core/pty/
    scrollback-store.ts                  # + makeScrollbackExitSink() (Task 5)
    scrollback-store.test.ts             # + sink tests
```

All commands below run from `/Users/aisigma/projects/SigmaLink/app`.

---

### Task 1: Contain `panes.brief` worktreePath (HIGH, security)

**Finding (verified):** `rpc-router.ts:1293-1300` — the `panes.brief` handler does `if (worktreePath) await writeScopeBlock(worktreePath, capsule)` with NO containment. `writeScopeBlock` (`core/workspaces/scope-block.ts:35-65`) does `fs.mkdirSync(path.dirname(target), { recursive: true })` + an atomic write of `CLAUDE.md` at ANY renderer-supplied path — a prompt-injection vector for any CLI that reads CLAUDE.md (it can plant scope guidance in `~`, another repo, etc.). The Zod schema (`core/rpc/schemas.ts:412-423`) only checks `z.string().max(4096).nullable()`. Sibling handlers already contain renderer paths: `git.worktreeCreate` (rpc-router.ts:1522), `git.openInPane` (:1534), `git.runCommand` (:1494), all `fs.*` via `allowedRoots`.

**Approach:** Extract the handler body into `briefPane()` in `scope-block.ts` (the established "extract to a DI seam because vitest can't load rpc-router" pattern — same as `core/fs/controller.ts`, `checkpoint-controller`). `briefPane` statically imports `assertAllowedPath` (pure node, vitest-safe) and takes only `allowedRoots` + `writePty` as injected deps. Containment throws BEFORE any disk write or PTY write. The Zod schema is intentionally NOT changed — containment is a runtime decision against DB-derived roots, which a static schema cannot express.

**Files:**
- Modify: `app/src/main/core/workspaces/scope-block.ts` (66 lines → ~100)
- Modify: `app/src/main/rpc-router.ts:1293-1300` (anchor: `grep -n "brief: async" src/main/rpc-router.ts`)
- Test: `app/src/main/core/workspaces/scope-block.test.ts`

- [ ] **Step 1: Write the failing tests**

In `scope-block.test.ts`, extend the existing import lines and append the new tests. Change the top of the file from:

```ts
import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { writeScopeBlock } from './scope-block';
```

to:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { writeScopeBlock, briefPane } from './scope-block';
```

Append at the end of the file:

```ts
// Audit 2026-06-10 finding 1 — panes.brief wrote a CLAUDE.md at ANY
// renderer-supplied path. briefPane contains worktreePath against the injected
// allowed roots BEFORE any disk or PTY write (fail-closed via assertAllowedPath).
describe('briefPane — worktreePath containment', () => {
  const capsule = { goal: 'Add login', targetFiles: ['src/a.ts'], successCriteria: ['tests pass'], outOfScope: ['billing/**'] };

  it('writes the scope block + injects the capsule when worktreePath is inside an allowed root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'brief-root-'));
    const writes: Array<{ id: string; data: string }> = [];
    await briefPane(
      { sessionId: 'sess-1', worktreePath: root, capsule },
      { allowedRoots: () => [root], writePty: (id, data) => { writes.push({ id, data }); } },
    );
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('billing/**');
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe('sess-1');
    expect(writes[0].data).toContain('Add login');
  });

  it('REFUSES an out-of-roots worktreePath: throws, writes NO CLAUDE.md, injects NOTHING', async () => {
    const root = mkdtempSync(join(tmpdir(), 'brief-allowed-'));
    const outside = mkdtempSync(join(tmpdir(), 'brief-outside-'));
    const writes: string[] = [];
    await expect(
      briefPane(
        { sessionId: 'sess-1', worktreePath: outside, capsule },
        { allowedRoots: () => [root], writePty: (_id, data) => { writes.push(data); } },
      ),
    ).rejects.toThrow('path outside workspace');
    expect(existsSync(join(outside, 'CLAUDE.md'))).toBe(false);
    expect(writes).toEqual([]);
  });

  it('fail-closed: empty allowed roots refuses even a real worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'brief-noroots-'));
    await expect(
      briefPane(
        { sessionId: 'sess-1', worktreePath: root, capsule },
        { allowedRoots: () => [], writePty: () => undefined },
      ),
    ).rejects.toThrow('path outside workspace');
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('null worktreePath skips the disk write but still injects the capsule', async () => {
    const writes: string[] = [];
    await briefPane(
      { sessionId: 'sess-1', worktreePath: null, capsule },
      { allowedRoots: () => [], writePty: (_id, data) => { writes.push(data); } },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('Add login');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/core/workspaces/scope-block.test.ts`
Expected: FAIL — `briefPane` is not exported by `./scope-block` (import/SyntaxError).

- [ ] **Step 3: Implement `briefPane` in scope-block.ts**

Replace the existing import block at the top of `scope-block.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { PlanCapsule } from '@/shared/plan-capsule';
```

with:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { buildCapsuleText, type PlanCapsule } from '@/shared/plan-capsule';
// Audit 2026-06-10 — containment keystone (pure node, fail-closed; see
// core/security/path-guard.ts). briefPane judges the renderer-supplied
// worktreePath against the injected allowed roots BEFORE any disk write.
import { assertAllowedPath } from '../security/path-guard';
```

(The `@` alias resolves under vitest — `vitest.config.ts` maps `'@' → ./src`; `worktree-mode.ts` already runtime-imports from `@/shared` in tested code.)

Append at the end of `scope-block.ts`:

```ts
/**
 * C-5 / audit 2026-06-10 — the `panes.brief` RPC body, extracted from
 * rpc-router so the containment guard is unit-testable (the router cannot
 * load under vitest). Order matters: the containment check throws BEFORE the
 * CLAUDE.md write AND before the PTY capsule injection, so an out-of-roots
 * path produces no side effects at all ('path outside workspace').
 *
 * Sibling parity: git.worktreeCreate / git.openInPane / git.runCommand and
 * the fs.* controller all contain renderer paths the same way.
 */
export async function briefPane(
  input: { sessionId: string; worktreePath: string | null; capsule: PlanCapsule },
  deps: {
    /** Authoritative allowed-roots provider (rpc-router's fsAllowedRoots). */
    allowedRoots: () => string[];
    /** PTY write sink — (sessionId, data). */
    writePty: (sessionId: string, data: string) => void;
  },
): Promise<void> {
  if (input.worktreePath) {
    const safe = assertAllowedPath(input.worktreePath, deps.allowedRoots());
    await writeScopeBlock(safe, input.capsule);
  }
  deps.writePty(input.sessionId, buildCapsuleText(input.capsule) + '\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/core/workspaces/scope-block.test.ts`
Expected: PASS (existing writeScopeBlock test + 4 new tests).

- [ ] **Step 5: Rewire the router handler**

In `rpc-router.ts` (anchor: `grep -n "brief: async" src/main/rpc-router.ts`, currently ~:1295), replace:

```ts
    brief: async ({ sessionId, worktreePath, capsule }: { sessionId: string; worktreePath: string | null; capsule: import('@/shared/plan-capsule').PlanCapsule }) => {
      const { writeScopeBlock } = await import('./core/workspaces/scope-block');
      const { buildCapsuleText } = await import('@/shared/plan-capsule');
      if (worktreePath) await writeScopeBlock(worktreePath, capsule);
      pty.write(sessionId, buildCapsuleText(capsule) + '\n');
    },
```

with:

```ts
    brief: async ({ sessionId, worktreePath, capsule }: { sessionId: string; worktreePath: string | null; capsule: import('@/shared/plan-capsule').PlanCapsule }) => {
      // Audit 2026-06-10 — contain the renderer-supplied worktreePath to the
      // workspace/worktree allowed roots BEFORE the CLAUDE.md write (sibling
      // parity with git.worktreeCreate/:openInPane). briefPane throws
      // 'path outside workspace' and produces NO side effects out-of-roots.
      const { briefPane } = await import('./core/workspaces/scope-block');
      await briefPane(
        { sessionId, worktreePath, capsule },
        { allowedRoots: fsAllowedRoots, writePty: (id, data) => pty.write(id, data) },
      );
    },
```

(`fsAllowedRoots` is the existing `AllowedRootsSource` defined at rpc-router.ts:~320 — the same provider every `fs.*`/`git.*` handler uses. Keep the dynamic import — it was dynamic before.)

- [ ] **Step 6: Type-check + targeted tests**

Run: `npx tsc -b && npx vitest run src/main/core/workspaces/`
Expected: clean build, all workspaces tests PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/core/workspaces/scope-block.ts app/src/main/core/workspaces/scope-block.test.ts app/src/main/rpc-router.ts
git commit -m "fix(security): contain panes.brief worktreePath to allowed roots before CLAUDE.md write

Renderer-supplied worktreePath reached writeScopeBlock (mkdir -p + CLAUDE.md
write at ANY path — prompt-injection vector). Extracted briefPane() into
scope-block.ts with assertAllowedPath containment BEFORE any side effect;
sibling parity with git.worktreeCreate/openInPane. Audit 2026-06-10 finding 1.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Sandbox `fs.exists` (LOW, security — existence oracle)

**Finding (verified):** `rpc-router.ts:1612` — `exists: async (p) => fs.existsSync(p)` is the ONLY `fs.*` channel that skips the allowedRoots sandbox (`readDir`/`readFile`/`writeFile` all thread it at :1615-1620) → any renderer compromise can probe arbitrary filesystem paths (`~/.ssh/id_rsa`, other users' homes).

**Decision — return `false` out-of-roots, do NOT throw.** Justification (call sites verified): `MissionStep.tsx:164` probes `${ws.rootPath}/<candidate>` — inside roots, unaffected. `ProviderInstallModal.tsx:66` best-effort-probes well-known install paths (`/usr/local/bin/npm`, …) that ARE outside the roots — its logic returns `true` ("assume runtime available") both when a probe hits and when all probes miss, and wraps everything in `catch → true`, so `false` is behavior-identical there while a thrown error would only add console noise. `false` also makes out-of-roots indistinguishable from "absent", which is exactly the oracle-closing semantic. Fail-closed: no `allowedRoots` wired ⇒ `false`.

**Files:**
- Modify: `app/src/main/core/fs/controller.ts` (165 lines → ~185)
- Modify: `app/src/main/rpc-router.ts:1612` (anchor: `grep -n "exists: async" src/main/rpc-router.ts`) and the import at :123
- Test: `app/src/main/core/fs/controller.test.ts`

- [ ] **Step 1: Write the failing tests**

In `controller.test.ts`, add `fsExists` to the existing import:

```ts
import { fsWriteFile, fsExists } from './controller';
```

(If the current import line also pulls `fsReadDir`/`fsReadFile`, keep them — just append `fsExists`.) Then append at the end of the file (reuses the file's existing `withTmpDir` + `roots` helpers):

```ts
// Audit 2026-06-10 finding 2 — fs.exists was the only fs.* channel skipping
// the allowedRoots sandbox (filesystem existence oracle). Out-of-roots must be
// indistinguishable from "absent": return false, never throw.
describe('fsExists — sandboxed existence probe', () => {
  it('returns true for an existing file inside an allowed root', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'present.txt');
      await fsp.writeFile(target, 'x', 'utf8');
      expect(fsExists({ path: target, allowedRoots: roots(dir) })).toBe(true);
    });
  });

  it('returns false for a missing file inside an allowed root', async () => {
    await withTmpDir(async (dir) => {
      expect(fsExists({ path: path.join(dir, 'absent.txt'), allowedRoots: roots(dir) })).toBe(false);
    });
  });

  it('returns false for an EXISTING file outside every allowed root (oracle closed)', async () => {
    await withTmpDir(async (dir) => {
      await withTmpDir(async (outside) => {
        const target = path.join(outside, 'secret.txt');
        await fsp.writeFile(target, 'x', 'utf8');
        expect(fsExists({ path: target, allowedRoots: roots(dir) })).toBe(false);
      });
    });
  });

  it('fail-closed: returns false when no allowedRoots provider is wired', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'present.txt');
      await fsp.writeFile(target, 'x', 'utf8');
      expect(fsExists({ path: target })).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/core/fs/controller.test.ts`
Expected: FAIL — `fsExists` is not exported by `./controller`.

- [ ] **Step 3: Implement `fsExists`**

In `controller.ts`, change the fs import from:

```ts
import { promises as fsp } from 'node:fs';
```

to:

```ts
import fs, { promises as fsp } from 'node:fs';
```

Append after `fsWriteFile` (end of file):

```ts
/**
 * Audit 2026-06-10 — sandboxed existence probe. The old rpc-router handler
 * was a bare `fs.existsSync(p)` — the only fs.* channel skipping the
 * allowedRoots sandbox, i.e. a filesystem existence oracle for the renderer.
 *
 * Out-of-roots (or no provider wired — fail-closed) returns FALSE rather than
 * throwing: an existence probe outside the sandbox must be indistinguishable
 * from "not there", and the two renderer call sites (MissionStep in-roots
 * probe; ProviderInstallModal best-effort well-known-path probe) both treat
 * false as a benign miss.
 */
export function fsExists(input: { path: string; allowedRoots?: AllowedRootsSource }): boolean {
  if (!input.path || typeof input.path !== 'string') return false;
  try {
    return fs.existsSync(containPath(input.path, input.allowedRoots));
  } catch {
    return false; // out-of-roots / no roots — indistinguishable from absent
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/core/fs/controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire the router handler**

In `rpc-router.ts:123`, extend the import:

```ts
import { fsReadDir, fsReadFile, fsWriteFile, fsExists } from './core/fs/controller';
```

At the anchor (~:1612), replace:

```ts
    exists: async (p: string) => fs.existsSync(p),
```

with:

```ts
    // Audit 2026-06-10 — fs.exists was the only fs.* channel skipping the
    // allowedRoots sandbox (existence oracle). Out-of-roots now reads as false.
    exists: async (p: string) => fsExists({ path: p, allowedRoots: fsAllowedRoots }),
```

- [ ] **Step 6: Type-check + targeted tests**

Run: `npx tsc -b && npx vitest run src/main/core/fs/`
Expected: clean build, PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/core/fs/controller.ts app/src/main/core/fs/controller.test.ts app/src/main/rpc-router.ts
git commit -m "fix(security): sandbox fs.exists behind allowedRoots — close the existence oracle

fs.exists was the only fs.* channel skipping the allowedRoots sandbox.
Out-of-roots (and fail-closed no-roots) now returns false — indistinguishable
from absent; both renderer call sites tolerate false (verified). Audit
2026-06-10 finding 2.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: M1 model-allowlist parity in the swarm spawn twin (LOW, security)

**Finding (verified):** `core/swarms/factory-spawn.ts:138-139` — `buildExtraArgs` emits `['--model', modelId]` gated only by `providerAcceptsModelFlag(providerId)`. Its launcher twin (`core/workspaces/launcher.ts:126-135` — note: NOT `providers/launcher.ts`; the audit's path was off, the code+drift are real) ADDITIONALLY requires `listModelsFor(p.id).some((m) => m.modelId === modelId)` (the M1 review fix). Spawn is `shell:false` argv so the blast radius is a bounded rogue CLI flag — but the boundary twins drifted, and the factory-spawn comment even claims "Mirrors the launcher path".

**Files:**
- Modify: `app/src/main/core/swarms/factory-spawn.ts:26` (import) and `:128-152` (anchor: `grep -n "providerAcceptsModelFlag" src/main/core/swarms/factory-spawn.ts`)
- Test: `app/src/main/core/swarms/factory-spawn.test.ts` (existing `describe('buildExtraArgs — provider oneshot substitution')` at ~:168)

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('buildExtraArgs — provider oneshot substitution', …)` block in `factory-spawn.test.ts`:

```ts
  // Audit 2026-06-10 finding 3 — M1 allowlist parity with the launcher twin
  // (core/workspaces/launcher.ts buildExtraArgs): a modelId missing from the
  // shared catalog must be DROPPED, never forwarded as a CLI arg.
  it('drops a modelId not in the shared catalog (M1 allowlist parity)', () => {
    expect(buildExtraArgs('claude', undefined, 'not-a-real-model')).toEqual([]);
    expect(buildExtraArgs('claude', 'hi', '--dangerously-skip-permissions')).toEqual(['-p', 'hi']);
  });

  it('keeps a catalog-listed modelId (with and without a oneshot prompt)', () => {
    expect(buildExtraArgs('claude', undefined, 'claude-sonnet-4-6')).toEqual(['--model', 'claude-sonnet-4-6']);
    expect(buildExtraArgs('claude', 'hi', 'claude-sonnet-4-6')).toEqual(['--model', 'claude-sonnet-4-6', '-p', 'hi']);
  });
```

(`claude-sonnet-4-6` is a real catalog entry — `src/shared/model-catalog.ts:37`. If the catalog has rotated by execution time, pick any current `providerId: 'claude'` entry's `modelId` and use it in both assertions.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/core/swarms/factory-spawn.test.ts`
Expected: FAIL — `buildExtraArgs('claude', undefined, 'not-a-real-model')` currently returns `['--model', 'not-a-real-model']`.

- [ ] **Step 3: Implement the allowlist**

In `factory-spawn.ts:26`, extend the import:

```ts
import { providerAcceptsModelFlag, listModelsFor } from '../../../shared/model-catalog';
```

In `buildExtraArgs` (anchor ~:134-139), replace:

```ts
  // BSP-V2 — inject `--model <id>` for providers whose CLI accepts the flag
  // (claude / cursor / gemini per MODEL_FLAG_PROVIDERS). Mirrors the launcher
  // path (launcher.ts:buildExtraArgs) so both spawn sites are consistent.
  const modelArgs: string[] =
    modelId && providerAcceptsModelFlag(providerId) ? ['--model', modelId] : [];
```

with:

```ts
  // BSP-V2 — inject `--model <id>` for providers whose CLI accepts the flag
  // (claude / cursor / gemini per MODEL_FLAG_PROVIDERS). Audit 2026-06-10 —
  // ALSO allowlist against the shared catalog, restoring true parity with the
  // launcher twin (core/workspaces/launcher.ts buildExtraArgs, M1 review fix):
  // an unknown modelId is dropped silently (the CLI default applies). Spawn is
  // shell:false argv, but this is defense-in-depth at the renderer→spawn
  // boundary.
  const modelArgs: string[] =
    modelId &&
    providerAcceptsModelFlag(providerId) &&
    listModelsFor(providerId).some((m) => m.modelId === modelId)
      ? ['--model', modelId]
      : [];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/core/swarms/factory-spawn.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/core/swarms/factory-spawn.ts app/src/main/core/swarms/factory-spawn.test.ts
git commit -m "fix(security): allowlist swarm-spawn --model against the shared catalog (M1 twin parity)

factory-spawn buildExtraArgs skipped the listModelsFor allowlist its launcher
twin (workspaces/launcher.ts) enforces — boundary twins drifted. argv-only so
bounded, restored as defense-in-depth. Audit 2026-06-10 finding 3.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Thread notifications + pty-error sinks through assistant/design/sigmabench launches (MED-LOW, wiring)

**Finding (verified at HEAD):** `executeLaunchPlan` (`core/workspaces/launcher.ts:92-99`) accepts optional `notifications` + `broadcastPtyError` sinks; the router's `workspaces.launch` threads BOTH (rpc-router.ts:1459-1471). But FOUR sibling call sites pass neither, so a `WorktreeDiskGuardError` CRITICAL bell and crash `pty:error` fan-out are silent no-ops on assistant-dispatched launches:
1. `core/assistant/tools.ts` `launch_pane` (~:295) — **WIP hazard: re-verify this file's then-current state first; plan written against `git show a4156ac:app/src/main/core/assistant/tools.ts`**
2. `core/assistant/controller.ts` `dispatchPane` (~:457)
3. `core/assistant/controller.ts` `dispatchPanes` batch (~:598)
4. `core/design/controller.ts` dispatch (~:328)

Additionally `sigmabenchSwarmFactoryDeps` (rpc-router.ts:1669-1674) lacks the `notifications` sink that `buildSwarmController` gets (:1651-1661); `SwarmFactoryDeps` (`core/swarms/factory.ts:42-56`) already declares the optional field — wiring only.

**Approach:** Add the two optional sinks to `ToolContext` (tools.ts), `AssistantControllerDeps` (assistant/controller.ts), and `DesignControllerDeps` (design/controller.ts); thread them at each `executeLaunchPlan` call; wire the live sinks in rpc-router at the three controller-construction sites. TDD on the two seams that already have launcher mocks (`tools.test.ts`, `controller.test.ts`); design/controller + rpc-router wiring are one-liners verified by `tsc` + the Task 6 grep.

**Files:**
- Modify: `app/src/main/core/assistant/tools.ts` (ToolContext ~:39-92; launch_pane ~:295; anchors: `grep -n "export interface ToolContext\|executeLaunchPlan(" src/main/core/assistant/tools.ts`)
- Modify: `app/src/main/core/assistant/controller.ts` (deps ~:37-70; ctx build ~:217-253; dispatch sites ~:457, ~:598; anchors: `grep -n "executeLaunchPlan(\|export interface AssistantControllerDeps" src/main/core/assistant/controller.ts`)
- Modify: `app/src/main/core/design/controller.ts` (deps :23-31; dispatch ~:328)
- Modify: `app/src/main/rpc-router.ts` (~:1669 sigmabench deps; ~:1888 assistant build; ~:1969 design build)
- Test: `app/src/main/core/assistant/tools.test.ts`, `app/src/main/core/assistant/controller.test.ts`

- [ ] **Step 1: Write the failing test — launch_pane tool**

In `tools.test.ts`, add a launcher mock alongside the existing `vi.mock('../db/client', …)` / `vi.mock('../browser/cdp', …)` blocks (mocks must precede imports):

```ts
vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: vi.fn(),
}));
```

Add to the imports:

```ts
import { executeLaunchPlan } from '../workspaces/launcher';
```

Append the test (uses the file's existing `makeCtx` helper and `ToolContext` import — the `{ ...makeCtx(), extra } as unknown as ToolContext` cast is the file's established pattern, see the `scanIngested`/`kvGet` tests):

```ts
// Audit 2026-06-10 finding 4 — assistant-dispatched launches must thread the
// notifications + broadcastPtyError sinks (disk-guard CRITICAL bell + crash
// pty:error were silent no-ops vs the rpc-router workspaces.launch sibling).
describe('launch_pane — sink threading', () => {
  it('threads ctx.notifications + ctx.broadcastPtyError into executeLaunchPlan', async () => {
    vi.mocked(executeLaunchPlan).mockResolvedValue(
      { workspace: {}, sessions: [] } as unknown as Awaited<ReturnType<typeof executeLaunchPlan>>,
    );
    const notifications = { add: vi.fn() };
    const broadcastPtyError = vi.fn();
    const ctx = { ...makeCtx(), notifications, broadcastPtyError } as unknown as ToolContext;
    await findTool('launch_pane')!.handler({ workspaceRoot: '/tmp/ws', provider: 'claude' }, ctx);
    expect(vi.mocked(executeLaunchPlan)).toHaveBeenCalledTimes(1);
    const deps = vi.mocked(executeLaunchPlan).mock.calls[0][1];
    expect(deps.notifications).toBe(notifications);
    expect(deps.broadcastPtyError).toBe(broadcastPtyError);
  });
});
```

- [ ] **Step 2: Write the failing test — assistant dispatchPane**

`controller.test.ts` ALREADY mocks `../workspaces/launcher` (:15-16) and has a `dispatchPane` describe + `makeDeps(overrides)` helper (:67-79). Append inside/after the existing `describe('assistant.dispatchPane count=8 valid preset', …)`:

```ts
  it('threads deps.notifications + deps.broadcastPtyError into executeLaunchPlan (audit 2026-06-10)', async () => {
    const root = makeTmp();
    seedWorkspace(fake, { id: 'ws-1', rootPath: root });
    vi.mocked(executeLaunchPlan).mockResolvedValue(makeLaunchResult([makeSession('pane-1', 'claude')]));
    const notifications = { add: vi.fn() };
    const broadcastPtyError = vi.fn();
    const { controller } = buildAssistantController(makeDeps({ notifications, broadcastPtyError }));
    const ctl = controller as unknown as {
      dispatchPane: (input: { workspaceId: string; provider: string; count: number; initialPrompt: string }) => Promise<{ sessionIds: string[] }>;
    };
    await ctl.dispatchPane({ workspaceId: 'ws-1', provider: 'claude', count: 1, initialPrompt: 'hi' });
    const deps = vi.mocked(executeLaunchPlan).mock.calls[0][1];
    expect(deps.notifications).toBe(notifications);
    expect(deps.broadcastPtyError).toBe(broadcastPtyError);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/main/core/assistant/tools.test.ts src/main/core/assistant/controller.test.ts`
Expected: FAIL — `deps.notifications` is `undefined` in both new tests (the `makeDeps` override also won't type-check until Step 4's interface change; if tsc-in-vitest complains first, that IS the failing state). All pre-existing tests must still pass.

- [ ] **Step 4: Implement — tools.ts**

In `ToolContext` (after `cdpCallCounter`), add:

```ts
  /**
   * Audit 2026-06-10 — optional launch sinks, threaded into executeLaunchPlan
   * by `launch_pane` so a WorktreeDiskGuardError CRITICAL bell and a crash
   * `pty:error` broadcast fire on assistant-dispatched launches exactly like
   * the rpc-router `workspaces.launch` sibling. Absent ⇒ console-only
   * (back-compat for every existing caller/test).
   */
  notifications?: { add: (input: import('../notifications/manager').AddInput) => unknown };
  broadcastPtyError?: (payload: { sessionId: string; exitCode: number | null; signal?: string | null }) => void;
```

In the `launch_pane` handler, replace:

```ts
      const out = await executeLaunchPlan(plan, {
        pty: ctx.pty,
        worktreePool: ctx.worktreePool,
      });
```

with:

```ts
      const out = await executeLaunchPlan(plan, {
        pty: ctx.pty,
        worktreePool: ctx.worktreePool,
        // Audit 2026-06-10 — disk-guard bell + crash pty:error sinks (parity
        // with rpc-router workspaces.launch).
        notifications: ctx.notifications,
        broadcastPtyError: ctx.broadcastPtyError,
      });
```

- [ ] **Step 5: Implement — assistant/controller.ts**

In `AssistantControllerDeps` (after `mcpHost`), add:

```ts
  /**
   * Audit 2026-06-10 — optional launch sinks for every executeLaunchPlan call
   * this controller makes (dispatchPane / dispatchPanes / the launch_pane tool
   * via ToolContext). Wired live from rpc-router; absent ⇒ console-only.
   */
  notifications?: { add: (input: import('../notifications/manager').AddInput) => unknown };
  broadcastPtyError?: (payload: { sessionId: string; exitCode: number | null; signal?: string | null }) => void;
```

In the ToolContext construction inside `invokeAssistantTool` (the `tool.handler(parsed, { pty: deps.pty, … })` object, anchor ~:217), add after `cdpCallCounter: input.cdpCallCounter,`:

```ts
        // Audit 2026-06-10 — launch sinks ride the tool ctx so launch_pane
        // (including the MCP-host bridge path) gets them too.
        notifications: deps.notifications,
        broadcastPtyError: deps.broadcastPtyError,
```

At BOTH `executeLaunchPlan` call sites (~:457 `dispatchPane` and ~:598 `dispatchPanes` — grep finds exactly two), replace:

```ts
        pty: deps.pty,
        worktreePool: deps.worktreePool,
```

with:

```ts
        pty: deps.pty,
        worktreePool: deps.worktreePool,
        notifications: deps.notifications,
        broadcastPtyError: deps.broadcastPtyError,
```

(Use `replace_all`-style care: that two-line pattern may appear elsewhere in the file — edit each call site individually, matching on the surrounding `executeLaunchPlan(plan, {` context.)

- [ ] **Step 6: Implement — design/controller.ts**

In `DesignControllerDeps` (:23-31), add after `ptyWrite?`:

```ts
  /** Audit 2026-06-10 — optional launch sinks (parity with workspaces.launch). */
  notifications?: { add: (input: import('../notifications/manager').AddInput) => unknown };
  broadcastPtyError?: (payload: { sessionId: string; exitCode: number | null; signal?: string | null }) => void;
```

At the `executeLaunchPlan` call (~:328), thread them the same way:

```ts
      const out = await executeLaunchPlan(plan, {
        pty: deps.pty,
        worktreePool: deps.worktreePool,
        notifications: deps.notifications,
        broadcastPtyError: deps.broadcastPtyError,
      });
```

- [ ] **Step 7: Implement — rpc-router.ts wiring (three sites)**

(a) `buildAssistantController({ … })` (anchor: `grep -n "buildAssistantController({" src/main/rpc-router.ts`, ~:1888) — add alongside `mcpHost`:

```ts
    // Audit 2026-06-10 — launch sinks: disk-guard CRITICAL bell + crash
    // pty:error now fire on assistant-dispatched launches (parity with the
    // workspaces.launch handler above).
    notifications: notificationsManager,
    broadcastPtyError: (payload) => broadcast('pty:error', payload),
```

(b) `buildDesignController({ … })` (~:1969) — add the same two lines after `ptyWrite`.

(c) `sigmabenchSwarmFactoryDeps` (~:1669) — replace:

```ts
  const sigmabenchSwarmFactoryDeps = {
    pty,
    worktreePool,
    mailbox,
    userDataDir: userData,
  };
```

with:

```ts
  const sigmabenchSwarmFactoryDeps = {
    pty,
    worktreePool,
    mailbox,
    userDataDir: userData,
    // Audit 2026-06-10 — C6 parity: same notifications sink buildSwarmController
    // gets above, so a disk-guard refusal in a sigmabench-driven spawn bells
    // instead of being console-only. (SwarmFactoryDeps already declares it.)
    notifications: notificationsManager,
  };
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx tsc -b && npx vitest run src/main/core/assistant/ src/main/core/design/ 2>/dev/null || npx vitest run src/main/core/assistant/`
Expected: clean build; both new tests PASS; all existing assistant tests PASS. (If `src/main/core/design/` has no test files vitest exits non-zero on the empty pattern — the fallback runs assistant only; design changes are covered by `tsc`.)

- [ ] **Step 9: Commit**

```bash
git add app/src/main/core/assistant/tools.ts app/src/main/core/assistant/tools.test.ts app/src/main/core/assistant/controller.ts app/src/main/core/assistant/controller.test.ts app/src/main/core/design/controller.ts app/src/main/rpc-router.ts
git commit -m "fix(rpc): thread notifications + pty-error sinks through assistant/design/sigmabench launches

executeLaunchPlan call sites in launch_pane, assistant dispatchPane/dispatchPanes,
and design dispatch lacked the sinks the workspaces.launch sibling threads —
WorktreeDiskGuardError CRITICAL bell + crash pty:error were silent no-ops on
assistant-dispatched launches. sigmabenchSwarmFactoryDeps likewise gains the
C6 notifications sink. Audit 2026-06-10 finding 4.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Always-wire the scrollback exit sink — gate inside (LOW, wiring)

**Finding (verified):** `rpc-router.ts:585-602` — `onSessionExit` is wired by a boot-time IIFE that reads `KV_PTY_SCROLLBACK_PERSISTENCE` ONCE and returns `undefined` when off, so a runtime toggle-ON does nothing until restart (only toggle-OFF works, via the inner per-exit re-read at :591-597) — contradicting the in-code comment "toggle-on starts persisting immediately". The load side (`panes.resume` :1058-1069, and its :1084-1100 twin) and the shutdown persist (:2421-2446) DO re-read live. Fix: always wire the sink; the gate (re-read) already exists inside — keep it as the ONLY gate.

**Approach:** Extract a pure sink factory `makeScrollbackExitSink({ isEnabled, persist })` into `core/pty/scrollback-store.ts` (which stays flag-unaware — the gate is injected), unit-test the mid-session toggle semantics, then replace the router IIFE. Cost when flag-off: one KV read per session exit (negligible; `PtyRegistry` calls the sink only on exit, registry.ts:300-316).

**Files:**
- Modify: `app/src/main/core/pty/scrollback-store.ts` (105 lines → ~135)
- Modify: `app/src/main/rpc-router.ts:585-602` (anchor: `grep -n "onSessionExit" src/main/rpc-router.ts`) + import at :144
- Test: `app/src/main/core/pty/scrollback-store.test.ts`

- [ ] **Step 1: Write the failing tests**

`scrollback-store.test.ts` mocks `node:fs` wholesale — fine: the sink factory never touches fs (it calls the injected `persist`). Extend the module import (:22):

```ts
import { persistScrollback, loadScrollback, gcScrollback, makeScrollbackExitSink, SCROLLBACK_MAX_BYTES } from './scrollback-store';
```

Append at the end of the file:

```ts
// Audit 2026-06-10 finding 5 — the router's boot-time IIFE returned undefined
// when the KV flag was off at boot, so runtime toggle-ON silently did nothing
// until restart. The sink is now ALWAYS wired and gates per-call.
describe('makeScrollbackExitSink — always-wired, gated per call', () => {
  it('runtime toggle-ON takes effect without a restart', () => {
    let enabled = false;
    const persist = vi.fn();
    const sink = makeScrollbackExitSink({ isEnabled: () => enabled, persist });
    sink('sess-1', 'before-enable');
    expect(persist).not.toHaveBeenCalled();
    enabled = true; // operator flips the KV flag mid-session
    sink('sess-1', 'after-enable');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('sess-1', 'after-enable');
  });

  it('runtime toggle-OFF stops persisting (regression guard for the old inner re-read)', () => {
    let enabled = true;
    const persist = vi.fn();
    const sink = makeScrollbackExitSink({ isEnabled: () => enabled, persist });
    sink('sess-1', 'while-on');
    expect(persist).toHaveBeenCalledTimes(1);
    enabled = false;
    sink('sess-1', 'while-off');
    expect(persist).toHaveBeenCalledTimes(1); // unchanged
  });

  it('an isEnabled throw is swallowed and skips persist (never blocks the PTY exit path)', () => {
    const persist = vi.fn();
    const sink = makeScrollbackExitSink({
      isEnabled: () => { throw new Error('kv read failed'); },
      persist,
    });
    expect(() => sink('sess-1', 'snap')).not.toThrow();
    expect(persist).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/core/pty/scrollback-store.test.ts`
Expected: FAIL — `makeScrollbackExitSink` is not exported.

- [ ] **Step 3: Implement the sink factory**

Append to `scrollback-store.ts` (module stays flag-UNAWARE — the gate is injected):

```ts
/**
 * Audit 2026-06-10 — PTY-exit persistence sink, ALWAYS wired by the router.
 *
 * The gate (`isEnabled` — re-reads the `pty.scrollbackPersistence` KV flag) is
 * evaluated on EVERY call, so both runtime toggle-ON and toggle-OFF take
 * effect without an app restart. (The previous rpc-router boot-time IIFE
 * returned `undefined` when the flag was off at boot, making toggle-ON a
 * silent no-op until restart.)
 *
 * Never throws: a failing `isEnabled` reads as OFF so the PTY exit path is
 * never blocked. `persist` is already best-effort (persistScrollback swallows
 * all I/O errors).
 */
export function makeScrollbackExitSink(deps: {
  isEnabled: () => boolean;
  persist: (sessionId: string, snapshot: string) => void;
}): (sessionId: string, snapshot: string) => void {
  return (sessionId, snapshot) => {
    let enabled = false;
    try {
      enabled = deps.isEnabled();
    } catch {
      return; // KV read failed — treat as OFF, never block the exit path
    }
    if (!enabled) return;
    deps.persist(sessionId, snapshot);
  };
}
```

Also update the module header comment (:8-10) from "Callers must check the `pty.scrollbackPersistence` KV flag BEFORE invoking any function here" to:

```ts
// Callers either check the `pty.scrollbackPersistence` KV flag BEFORE invoking
// persist/load/gc, or use `makeScrollbackExitSink` with an injected gate; the
// module itself stays flag-unaware by design (single responsibility, easy to
// unit-test without mocking KV).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/core/pty/scrollback-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire the router**

In `rpc-router.ts:144`, extend the import:

```ts
import { persistScrollback, loadScrollback, gcScrollback, makeScrollbackExitSink } from './core/pty/scrollback-store';
```

Replace the whole `onSessionExit` IIFE inside the `new PtyRegistry(…)` options (anchor `grep -n "onSessionExit" src/main/rpc-router.ts`, ~:581-602 — from the `// v1.9-scrollback — DEFAULT-OFF.` comment through the closing `})(),`):

```ts
      // v1.9-scrollback — DEFAULT-OFF. The sink is ALWAYS wired; the KV flag
      // is re-read inside on every exit, so BOTH runtime toggle-ON and
      // toggle-OFF take effect without a restart. (The previous boot-time IIFE
      // returned undefined when the flag was off at boot, so toggle-ON was a
      // silent no-op until restart — audit 2026-06-10 finding 5. The load side
      // (panes.resume) and shutdown persist already re-read live.)
      onSessionExit: makeScrollbackExitSink({
        isEnabled: () => {
          const row = getRawDb()
            .prepare('SELECT value FROM kv WHERE key = ?')
            .get(KV_PTY_SCROLLBACK_PERSISTENCE) as { value?: string } | undefined;
          return parseScrollbackPersistence(row?.value ?? null);
        },
        persist: (sessionId, snapshot) => persistScrollback(userData, sessionId, snapshot),
      }),
```

(All referenced names — `getRawDb`, `KV_PTY_SCROLLBACK_PERSISTENCE`, `parseScrollbackPersistence`, `userData` — are already in scope at this spot; the old IIFE used every one of them. The DB read now happens lazily per-exit instead of once at construction, which is strictly safer at boot.)

- [ ] **Step 6: Type-check + targeted tests**

Run: `npx tsc -b && npx vitest run src/main/core/pty/`
Expected: clean build; scrollback-store, registry-scrollback, and the other pty suites PASS (registry-scrollback's "flag-off → not seeded" tests inject their own sinks/flags and are unaffected).

- [ ] **Step 7: Commit**

```bash
git add app/src/main/core/pty/scrollback-store.ts app/src/main/core/pty/scrollback-store.test.ts app/src/main/rpc-router.ts
git commit -m "fix(rpc): always wire the scrollback exit sink — runtime toggle-ON now works

The boot-time IIFE read the KV flag once and wired NOTHING when off, so
toggle-ON did nothing until restart (contradicting its own comment; the resume
load side + shutdown persist already re-read live). Sink is now always wired
via makeScrollbackExitSink with the per-exit KV gate inside. Audit 2026-06-10
finding 5.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Grep-the-siblings verification + full gate

The lead repeatedly fixes one of N mirrored sites and misses a twin — this task is the explicit sweep. Run from `/Users/aisigma/projects/SigmaLink/app`.

- [ ] **Step 1: Sweep — every executeLaunchPlan call site is sinked**

```bash
grep -rn "executeLaunchPlan(" src/main --include="*.ts" | grep -v "\.test\."
```

Expected EXACTLY these (besides the definition in `core/workspaces/launcher.ts`): `rpc-router.ts` (workspaces.launch — pre-existing sinks), `core/assistant/tools.ts`, `core/assistant/controller.ts` ×2, `core/design/controller.ts` — ALL now passing `notifications` + `broadcastPtyError`. Any NEW call site that appeared since `a4156ac` → thread the sinks there too (same two lines) and add it to the Task 4 commit's pattern.

- [ ] **Step 2: Sweep — renderer-supplied paths reaching disk writes without containment**

```bash
# (a) The scope-block twin: guardrail-block writes <path>/CLAUDE.md the same way.
grep -rn "writeGuardrailBlock(" src/main --include="*.ts" | grep -v "\.test\."
# Expected callers: core/workspaces/launcher.ts:~250 and core/swarms/factory-spawn.ts:~301.
# In BOTH, worktreePath comes from the main-process WorktreePool (not the
# renderer) — verify that is still true by reading 5 lines above each call.
# If a renderer-supplied path now reaches writeGuardrailBlock, apply the Task 1
# briefPane pattern there and file it in the commit.

# (b) Router handlers taking a path-ish input: every fs.*/git.* path must hit
# assertAllowedPath or an allowedRoots-threaded controller.
grep -n "assertAllowedPath\|allowedRoots" src/main/rpc-router.ts
# Cross-check against the fs/git/panes controller definitions: any handler
# whose input includes a cwd/path/root that does NOT appear in this list is a
# NEW finding — do NOT fix in this batch; capture it in WISHLIST.md instead
# (scope discipline: this plan ships the five audited findings only).
```

- [ ] **Step 3: Sweep — KV-flag boot-time-read pattern (finding 5's shape)**

```bash
grep -n "getRawDb()" src/main/rpc-router.ts | head -30
```

Eyeball any other construction-time IIFE that snapshots a KV flag into wiring (the finding-5 shape: read-once → `return undefined`). Known-good live re-readers: panes.resume (~:1058), its subset twin (~:1084), shutdownRouter (~:2421). Anything else found → WISHLIST.md, not this batch.

- [ ] **Step 4: Full gate (NO local e2e — CI's e2e-matrix owns that)**

```bash
npx tsc -b
npx eslint . --max-warnings 0
npx vitest run
npm run product:check
```

Expected: all green. Known flake note: under load, full-suite `swarms/factory` and `VoiceTab` timeouts are flakes — re-run the failing FILE in isolation before reacting. Do NOT run `npx playwright test` or `electron:dev` locally (competing Electron windows steal the operator's focus).

- [ ] **Step 5: Commit (only if the sweeps changed anything)**

```bash
git add -A app/src
git commit -m "fix(rpc): sibling-sweep follow-ups from the boundary-hardening audit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Coordination notes

- **Serialize rpc-router merges.** This plan's sibling batch (pty-lifecycle, perf-hot-paths, win32-spawn) ALSO touches `rpc-router.ts`. Land this plan's rpc-router edits as small, early commits (each task commits independently) and coordinate so only ONE lane has rpc-router edits in flight at a time; otherwise expect conflicts in the 2,500-line wiring file. If running as a worktree lane, branch from origin/main and FF-align before starting (`git merge --ff-only <foundation SHA>`).
- **tools.ts WIP hazard.** This plan was authored against `git show a4156ac:app/src/main/core/assistant/tools.ts`. The conversation-start snapshot showed uncommitted tools.ts WIP that had ALREADY landed by recon time — this tree moves between sessions. Task 4 MUST re-grep its anchors (`executeLaunchPlan(`, `export interface ToolContext`) and re-read the handler before editing; if `notifications`/`broadcastPtyError` are already threaded by then, mark finding 4 partially/fully fixed in the commit message and skip the redundant edits.
- **Refuted findings: none.** All five verified in code at `a4156ac`. One correction: finding 3's "launcher twin" lives at `core/workspaces/launcher.ts:126-135`, not `core/providers/launcher.ts` (which has no model logic).
- **Worktree isolation.** If executed by sub-agents, pass `isolation: "worktree"` on the Agent call (prompt prose does not isolate), capture diffs with `git add -A && git diff --cached HEAD`, and re-gate in MAIN (`tsc -b` checks test files; worktree tsc is laxer).
- **Test-ABI rule.** Never `new Database()` / import electron in the new tests — every test above uses injected deps or existing mock fixtures only.

---

## Self-review (performed at write time)

- **Spec coverage:** finding 1 → Task 1; 2 → Task 2; 3 → Task 3; 4 (both halves: tool/controller sinks + sigmabench) → Task 4; 5 → Task 5; required sibling-grep step → Task 6. Gate commands + no-local-e2e + tools.ts-at-HEAD callout present.
- **Placeholder scan:** every code step contains complete code; every run step names the command + expected outcome; no TBDs.
- **Type consistency:** `briefPane(input, deps)` matches Task 1's router call; `fsExists({ path, allowedRoots })` matches Task 2's router call; ToolContext/AssistantControllerDeps/DesignControllerDeps all use the identical sink shapes that `core/workspaces/launcher.ts:92-99` already declares, so `executeLaunchPlan` needs NO type change; `makeScrollbackExitSink({ isEnabled, persist })` matches the router wiring; `SwarmFactoryDeps.notifications` pre-exists (factory.ts:42-56) so the sigmabench edit is type-safe with no interface change.
