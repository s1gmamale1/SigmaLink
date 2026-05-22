# Ruflo MCP End-to-End Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ruflo MCP memory store+retrieve work end-to-end for the lead, the `.claude` hooks, and SigmaLink's spawned CLIs — by converging on one namespace + one read path, sharing one per-workspace store, seeding it, and verifying with a round-trip.

**Architecture:** Convention + config (Approach C). Canonical write namespace = `patterns`; canonical read = `memory_search_unified`. Env-level fixes (data migration, hook retune, docs) done by the lead directly. SigmaLink spawn-config fixes (shared store, seeding, CLAUDE.md convention block, daemon health round-trip) ship as gated **v1.15.0**.

**Tech Stack:** TypeScript 5.9, Electron 30, vitest, better-sqlite3, node-pty; Ruflo = `@claude-flow/cli@latest` MCP (black-box upstream); vendored `.claude/helpers/*.cjs` hooks.

Spec: `docs/superpowers/specs/2026-05-22-ruflo-mcp-fix-design.md`.

---

## PART A — Env-level (lead-executed, NO release)

### Task A1: Migrate `pattern` → `patterns` (data consolidation)

**Files:** none (MCP-tool operations on `.swarm/memory.db`).

- [ ] **Step 1: Snapshot** — `memory_list(namespace:"pattern", limit:50)` and `memory_list(namespace:"patterns", limit:50)`; record counts (expect ~18 / ~21-incl-canary).
- [ ] **Step 2: Dry-run plan** — for each `pattern_*` key, target key = same key in `patterns` (collision → prefix `migrated-`). No collisions expected (keys are timestamp-hashed).
- [ ] **Step 3: Migrate** — for each entry: `memory_retrieve(key, namespace:"pattern")` → `memory_store(key, value, namespace:"patterns", upsert:true, tags)` → `memory_delete(key, namespace:"pattern")`.
- [ ] **Step 4: Verify** — `memory_list(namespace:"pattern")` total == 0; `memory_list(namespace:"patterns")` total == prior patterns + migrated.
- [ ] **Step 5: Remove canary** — `memory_delete("diagnostic-canary-2026-05-22", namespace:"patterns")`.
- [ ] **Step 6: Round-trip check** — `memory_search_unified("shell-first pane architecture")` returns the shell-first entry from `patterns`.

### Task A2: `[INTELLIGENCE]` hook retune (re-gen-safe)

**Files:**
- Inspect: `app/.claude/helpers/intelligence.cjs`, `~/.claude/helpers/intelligence.cjs`
- Create: `app/.claude/ruflo.intelligence.json` (config the hook reads)
- Create: `scripts/reapply-ruflo-hook-tuning.cjs` (idempotent patcher, fallback if hook can't read config)

- [ ] **Step 1: Read** `intelligence.cjs`; locate the relevance floor constant and the namespace it searches (the `route` path that emits `[INTELLIGENCE] Relevant patterns`).
- [ ] **Step 2: Decide mechanism** — if it reads any config/env, prefer that; else the `.cjs` is patched directly + the re-apply script restores the patch after `ruflo init`.
- [ ] **Step 3: Apply** — floor → `0.3`; search across all namespaces (unified) not `default`; on `post-task`/`session-end`, auto-store the task verdict to `patterns` (key `verdict:<taskId|sessionId>`).
- [ ] **Step 4: Verify** — trigger a prompt; confirm `[INTELLIGENCE]` either shows ≥0.3 suggestions or none (no more 0.06 noise).
- [ ] **Step 5: Commit** — `git add app/.claude/ruflo.intelligence.json scripts/reapply-ruflo-hook-tuning.cjs app/.claude/helpers/intelligence.cjs && git commit -m "fix(ruflo): retune intelligence hook — floor 0.3 + unified namespace + verdict auto-store"`

### Task A3: Canonical-config doc + upstream PR draft

**Files:**
- Create: `docs/10-memory/ruflo-mcp-canonical-config.md`
- Create: `docs/10-memory/upstream/claude-flow-default-namespace-issue.md`

- [ ] **Step 1: Write** the canonical-config doc — the default-namespace trap; `patterns` write convention; `memory_search_unified` read path; the `CLAUDE_FLOW_DIR` resolution; seeding; the re-gen-safe hook tuning; cross-link the `reference-ruflo-agentdb-efficacy` memory.
- [ ] **Step 2: Write** the upstream PR/issue draft — propose `memory_search` default = search-all-namespaces (or configurable) + unify `pattern`/`patterns`. Mark "operator fires; do not auto-submit."
- [ ] **Step 3: Commit** — `git commit -m "docs(ruflo): canonical-config + upstream default-namespace PR draft"`

---

## PART B — v1.15.0 app code (parallel coders, isolated worktrees, scope-bound; lead-merges + full gate)

Three lanes, disjoint file ownership:
- **Lane 1 (autowrite + CLAUDE.md block):** `mcp-autowrite.ts` + tests
- **Lane 2 (daemon shared-store + health round-trip):** `http-daemon-supervisor.ts` + tests
- **Lane 3 (workspace-open seeding):** `factory.ts` open path + a new seeding module + tests

### Task B1 (Lane 2): Daemon sets `CLAUDE_FLOW_DIR` explicitly (shared store)

**Files:**
- Modify: `app/src/main/core/ruflo/http-daemon-supervisor.ts:234` (and the restart spawn at ~`:445`)
- Test: `app/src/main/core/ruflo/http-daemon-supervisor.test.ts`

- [ ] **Step 1: Failing test** — assert the spawn env contains `CLAUDE_FLOW_DIR === path.join(workspaceRoot, '.claude-flow')` (matching `mcp-autowrite`'s `buildRufloServer`).

```ts
it('daemon spawn sets CLAUDE_FLOW_DIR to <root>/.claude-flow (shared store with stdio)', () => {
  // existing spawn-mock harness; assert env:
  expect(spawnArgs.env).toEqual(
    expect.objectContaining({
      CLAUDE_FLOW_CWD: '/home/user/project',
      CLAUDE_FLOW_DIR: path.join('/home/user/project', '.claude-flow'),
    }),
  );
});
```

- [ ] **Step 2: Run → FAIL** — `npx vitest run src/main/core/ruflo/http-daemon-supervisor.test.ts`
- [ ] **Step 3: Implement** — in both `doSpawn` and the restart spawn, change env to `{ ...process.env, CLAUDE_FLOW_CWD: entry.workspaceRoot, CLAUDE_FLOW_DIR: path.join(entry.workspaceRoot, '.claude-flow') }`. Ensure `path` is imported.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "fix(ruflo): daemon sets CLAUDE_FLOW_DIR explicitly — shared store with stdio CLIs"`

### Task B2 (Lane 2): Daemon health store→search round-trip probe

**Files:**
- Modify: `app/src/main/core/ruflo/http-daemon-supervisor.ts` (health probe + status shape)
- Test: same test file

- [ ] **Step 1: Failing test** — after health confirmed, a `roundTrip` field on status is `true` when a `memory_store`→`memory_search_unified` canary (key `__sigmalink_healthcheck__`, TTL 300s) round-trips; `false` + warning when it doesn't. Mock the MCP call.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add a `roundTripProbe()` that POSTs `memory_store`(namespace `patterns`, ttl 300) then `memory_search_unified` for the canary; set `entry.roundTrip` + log a single warning on failure (non-fatal). Surface `roundTrip` in `status()`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ruflo): daemon health store→search round-trip probe (measurement gate)"`

### Task B3 (Lane 1): Autowrite a `CLAUDE.md` Ruflo-memory convention block

**Files:**
- Modify: `app/src/main/core/workspaces/mcp-autowrite.ts` (add a managed-block writer; call from `writeWorkspaceMcpConfig`)
- Test: `app/src/main/core/workspaces/mcp-autowrite.test.ts`

- [ ] **Step 1: Failing test** — `writeWorkspaceMcpConfig(root, …)` writes/updates `<root>/CLAUDE.md` to contain a marker-delimited block `<!-- ruflo-memory-convention:start -->…<!-- ruflo-memory-convention:end -->` instructing: store with `namespace:"patterns"`, retrieve with `memory_search_unified`. Idempotent (second call → identical file). Refuses (leaves untouched + `refused` entry) if a user-edited block between markers differs from managed AND a `ruflo-memory-convention:user` opt-out marker is present.

```ts
it('writes an idempotent ruflo-memory-convention block into CLAUDE.md', () => {
  writeWorkspaceMcpConfig(root, { homeDir, detectCli: () => false });
  const a = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  expect(a).toContain('<!-- ruflo-memory-convention:start -->');
  expect(a).toContain('memory_search_unified');
  writeWorkspaceMcpConfig(root, { homeDir, detectCli: () => false });
  expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toEqual(a);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `writeRufloConventionBlock(root)`: read-or-create `CLAUDE.md`, replace content between markers (or append if absent) with the managed block; atomic write; honor the user opt-out marker. Call it from `writeWorkspaceMcpConfig` after the MCP writers. Block text is a const.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ruflo): autowrite CLAUDE.md memory-convention block (patterns + unified)"`

### Task B4 (Lane 3): Seed workspace `.claude-flow` with project context on open

**Files:**
- Create: `app/src/main/core/ruflo/seed-workspace-memory.ts`
- Modify: `app/src/main/core/workspaces/factory.ts` (openWorkspace path — call seeding after autowrite, best-effort)
- Test: `app/src/main/core/ruflo/seed-workspace-memory.test.ts`

- [ ] **Step 1: Failing test** — `seedWorkspaceMemory({ workspaceRoot, call })` reads `<root>/CLAUDE.md` (or README fallback), and calls `call('memory_store', { key:'project-context', namespace:'patterns', value:<first ~2KB>, upsert:true })` exactly once. Workspace-local only (never reads outside root). If no CLAUDE.md/README → no-op. If `call` throws → resolves (best-effort), logs once.

```ts
it('seeds one workspace-local project-context memory into patterns', async () => {
  const call = vi.fn().mockResolvedValue({ stored: true });
  await seedWorkspaceMemory({ workspaceRoot: root, call }); // root has CLAUDE.md
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith('memory_store', expect.objectContaining({
    key: 'project-context', namespace: 'patterns', upsert: true,
  }));
});
it('is a no-op when no CLAUDE.md/README and never throws', async () => {
  const call = vi.fn().mockRejectedValue(new Error('boom'));
  await expect(seedWorkspaceMemory({ workspaceRoot: emptyDir, call })).resolves.toBeUndefined();
  expect(call).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `seed-workspace-memory.ts` per the contract (pure, injectable `call`).
- [ ] **Step 4: Wire** into `factory.ts` openWorkspace: after `writeWorkspaceMcpConfig`, `void seedWorkspaceMemory({ workspaceRoot: abs, call: (t,a)=>rufloProxy.call(t,a) }).catch(()=>{})` (best-effort, never blocks open).
- [ ] **Step 5: Run → PASS** (unit + the existing workspace-open tests).
- [ ] **Step 6: Commit** — `git commit -m "feat(ruflo): seed workspace .claude-flow with project-context memory on open"`

### Task B5 (Lane 1/2/3): win32 unit coverage (WS6)

- [ ] For each new test file, add one win32-path variant (use `path.win32`-style root in a `process.platform`-guarded case where the code branches on platform; otherwise assert the same logic with a `C:\\...` root). Commit per lane.

---

## PART C — Integration, gate, ship

### Task C1: Lead merge + full gate in main
- [ ] Apply the 3 lanes' diffs onto main (disjoint files; `git apply --check` each first).
- [ ] Gate in main: `npx tsc -b` (0) | `npx eslint . --max-warnings 0` (0) | `npx vitest run` (all pass) | `npm run product:check` (build + electron:compile) | `npx playwright test tests/e2e/smoke.spec.ts` (1 passed).

### Task C2: Release v1.15.0
- [ ] Bump `app/package.json` → `1.15.0`; CHANGELOG entry; `docs/09-release/release-notes-1.15.0.txt`.
- [ ] Commit `release(v1.15.0): ruflo mcp shared store + seeding + convention + health round-trip`; tag `v1.15.0`; push branch + tag.
- [ ] Confirm CI lanes start.

### Task C3: Memory + tasks
- [ ] Update auto-memory: new `project-v1150-ruflo-mcp-fix` + correct `reference-ruflo-agentdb-efficacy` (root cause was index/namespace, not empty store); MEMORY.md index.

---

## Self-Review

**Spec coverage:** WS1→A1; WS2→A2/B3/A3; WS3→A2; WS4→B1(shared store)/B2(round-trip)/B3(CLAUDE.md)/B4(seeding); WS5→B2; WS6→B5; WS7→A3. All covered.
**Placeholders:** none — test contracts + the exact env fix + exact commands present.
**Type consistency:** `seedWorkspaceMemory({workspaceRoot, call})`, `call('memory_store', {...})`, status `roundTrip:boolean`, marker `ruflo-memory-convention` used consistently across tasks.
