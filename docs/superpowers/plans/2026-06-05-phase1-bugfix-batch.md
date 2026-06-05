# Phase 1 — SMK + DEV Bugfix Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed Phase-1 bugs in the three most-used surfaces — the workspace-launch wizard (SMK-2 + DEV-4), the Skills rail (SMK-3 + SMK-3b), and the embedded browser (DEV-1 + DEV-2 + DEV-3) — each with the missing regression test that made it invisible.

**Architecture:** Three **file-disjoint lanes** run in parallel, each in its own git worktree forked from the current `main` HEAD. The renderer is React 19 + Zustand; the main process is Electron + better-sqlite3 (Drizzle) with a hand-rolled forward-only migration runner; RPC flows through a typed router (`shared/router-shape.ts` ⇆ `rpc-router.ts`). Tests are **vitest** (`npm test` → `vitest run`); renderer tests opt into jsdom with `// @vitest-environment jsdom` at the top of the file. DB-touching tests use a MockDb/fake (vitest cannot load `better-sqlite3`, which is built for Electron's ABI) — **mirror the harness of the nearest existing test** rather than inventing one.

**Tech Stack:** TypeScript, React 19, Electron, better-sqlite3 + Drizzle, vitest, esbuild, Tailwind.

**Shared integration seam (LEAD-OWNED — lanes flag, lead integrates):** `shared/router-shape.ts` and `src/main/rpc-router.ts`. Lane B widens the `skills.listInstalled` return shape; Lane C adds `browser.listRecents`. Each lane edits these in its own worktree so its local `tsc` passes; the lead resolves the merge in `main` and re-runs the full gate. Everything else is disjoint.

**Scope (locked with operator):** confirmed bugs only. DEV-5 is REFUTED (it is SMK-2 seen across panes — fixed by Lane A). SMK-1's `scoped` guard already landed; its benign opencode residual is **out of scope**. DEV-6/7/8 dev-infra is **out of scope**.

**Per-bug verification status (from 3 read-only recon agents, 2026-06-05):**
| Bug | Status | Lane |
|-----|--------|------|
| SMK-2 sessions revert | CONFIRMED — inline `buildPaneRows()` → new array identity → `useEffect` self-refire loop | A |
| DEV-4 rail reorders on click | CONFIRMED — `SET_ACTIVE_WORKSPACE_ID` calls `upsertOpenWorkspace` (prepends) | A |
| SMK-3 skills tab provider-blind | CONFIRMED — 2 hard-coded cache paths; ruflo broken by version-dir depth; 437+ skills invisible; 3 mirrored type sites | B |
| SMK-3b codex `/foo` not `$foo` | CONFIRMED — `insertSkillCommand.ts:47` always writes `/` | B |
| DEV-1 element-pick no-op | CONFIRMED `\r` auto-submit (`controller.ts:290`) + prompt never seeded (operator: auto-seed editable template) | C |
| DEV-2 recents lose closed tabs | CONFIRMED — `closeTab` hard-deletes; Recents derived from open tabs only | C |
| DEV-3 address bar inert w/o tab | CONFIRMED — `disabled={!activeTab}` + `handleNavigate` early-returns | C |

---

## Lane A — Sessions (SMK-2 + DEV-4)

**Owns files:** `src/renderer/features/workspace-launcher/Launcher.tsx`, `src/renderer/state/state.reducer.ts`, plus new test files. (Does NOT modify `SessionStep.tsx` logic; only reads it. Does NOT edit `Launcher.test.tsx`'s existing stub — adds a *new* integration test file.)

> Verify line numbers before editing — Phase 0 may have shifted them. Recon-verified values are given as anchors.

### Task A1: SMK-2 — memoize `buildPaneRows` so the smart-default effect stops self-refiring

**Root cause (verified):** `Launcher.tsx:564` passes `rows={buildPaneRows(counts, skipAgents, preset)}` — a new array every render. `SessionStep.tsx:276` has `rows` in a `useEffect` dep array; the effect calls `onSelectionsChange` (`setPaneResumePlan`), which re-renders `WorkspaceLauncher`, which makes a new `rows` identity, which refires the effect → the user's explicit "All new"/"Resume" click is overwritten by the smart default on the next tick. In React tests this surfaces as a `Maximum update depth exceeded` warning.

**Files:**
- Create: `src/renderer/features/workspace-launcher/Launcher.sessions.integration.test.tsx`
- Modify: `src/renderer/features/workspace-launcher/Launcher.tsx` (the `buildPaneRows(...)` call ~line 564 + add a `useMemo`)

- [ ] **Step 1: Write the failing integration test (un-stubbed SessionStep)**

This is the test-blindness gap: `Launcher.test.tsx` stubs `SessionStep`, so the loop is invisible. Render the REAL pair and assert no update-depth blow-up + selection stability.

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
// NOTE: do NOT vi.mock('./SessionStep') here — this test exists precisely to
// exercise the real Launcher↔SessionStep integration.

// Mirror the rpc/event mocks that Launcher.test.tsx already sets up (copy the
// minimal `vi.mock('@/renderer/lib/rpc', ...)` + any provider/kv stubs it uses
// so fetchSessions resolves to an empty list quickly). Keep them in THIS file.

describe('Launcher ↔ SessionStep integration (SMK-2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not enter an infinite update loop when the sessions step mounts', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Render WorkspaceLauncher far enough to reach the sessions step.
    // (Use the same harness helper / props Launcher.test.tsx uses to advance
    //  to the sessions step; if it lacks one, drive the wizard via fireEvent.)
    renderLauncherAtSessionsStep(); // <-- implement using existing test utilities
    const loopError = errSpy.mock.calls
      .flat()
      .some((a) => typeof a === 'string' && a.includes('Maximum update depth exceeded'));
    expect(loopError).toBe(false);
    errSpy.mockRestore();
  });

  it('keeps an explicit "All new" selection after a subsequent re-render', async () => {
    renderLauncherAtSessionsStep();
    const allNew = await screen.findByRole('button', { name: /all new/i });
    fireEvent.click(allNew);
    // Force a parent re-render that does NOT change counts/skipAgents/preset.
    // After the fix, rows keeps a stable identity so the smart-default effect
    // does not refire and clobber the selection.
    fireEvent.click(allNew); // idempotent re-click — selection must remain "new"
    // Assert the per-pane mode chips still read "New" (selector per SessionStep markup).
    expect(screen.queryByText(/resume/i)).not.toBeTruthy(); // adjust to real markup
  });
});
```

> If `Launcher.test.tsx` has no reusable "advance to sessions step" helper, extract one or replicate its wizard-driving steps inline. The first test (no update-depth error) is the decisive red→green signal even if the second needs markup-specific selectors.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/features/workspace-launcher/Launcher.sessions.integration.test.tsx`
Expected: FAIL — `console.error` contains "Maximum update depth exceeded" (loop present).

- [ ] **Step 3: Implement the memoization in `Launcher.tsx`**

Find the inline call (recon anchor `:564`):
```tsx
rows={buildPaneRows(counts, skipAgents, preset)}
```
Add a `useMemo` near the other launcher memos and pass the stable reference. Ensure `useMemo` is imported from `react` (it already is — `kvKey`-style memos exist elsewhere; confirm).
```tsx
// Stable array identity so SessionStep's [rows]-deps effect only fires when the
// pane layout actually changes — not on every unrelated WorkspaceLauncher render
// (SMK-2: the effect calls setPaneResumePlan, which would otherwise self-refire).
const paneRows = useMemo(
  () => buildPaneRows(counts, skipAgents, preset),
  [counts, skipAgents, preset],
);
```
Then:
```tsx
rows={paneRows}
```
> Confirm `counts`, `skipAgents`, `preset` are themselves stable (state/props, not inline). If any is an inline object/array, memoize it too or the loop persists.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/features/workspace-launcher/Launcher.sessions.integration.test.tsx`
Expected: PASS — no update-depth error; selection persists.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/workspace-launcher/Launcher.tsx \
        src/renderer/features/workspace-launcher/Launcher.sessions.integration.test.tsx
git commit -m "fix(launcher): memoize buildPaneRows so sessions smart-default stops self-refiring (SMK-2)"
```

### Task A2: DEV-4 — don't reorder the workspace rail when activating an existing workspace

**Root cause (verified):** `state.reducer.ts:29-31` `upsertOpenWorkspace` always prepends. It is called from `SET_ACTIVE_WORKSPACE_ID` (`:329`, the rail-click path) and `SET_ACTIVE_WORKSPACE` (`:363`, new-open path) and `CLOSE_WORKSPACE` (`:256`, fine). Only the **rail-click** path (`SET_ACTIVE_WORKSPACE_ID`) should stop reordering; `SET_ACTIVE_WORKSPACE` (open-new) legitimately prepends.

**Files:**
- Modify: `src/renderer/state/state.reducer.ts` (the `SET_ACTIVE_WORKSPACE_ID` case ~line 327-333)
- Test: `src/renderer/state/state.reducer.test.ts` (add a case; create the file only if no reducer test exists — search first)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { reducer } from './state.reducer'; // confirm export name/path
import { /* a helper that builds initial state with N open workspaces */ } from './...';

describe('SET_ACTIVE_WORKSPACE_ID (DEV-4)', () => {
  it('activates a workspace without moving it to the front of the rail', () => {
    // Build state with openWorkspaces = [wsA, wsB, wsC], active = wsA.
    const before = makeStateWithOpen(['wsA', 'wsB', 'wsC'], 'wsA');
    const after = reducer(before, { type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: 'wsC' });
    expect(after.activeWorkspaceId).toBe('wsC');
    // Order MUST be unchanged — wsC stays in position 2, not hoisted to 0.
    expect(after.openWorkspaces.map((w) => w.id)).toEqual(['wsA', 'wsB', 'wsC']);
  });
});
```
> Use the existing state-builder/test utilities if present; otherwise construct a minimal `AppState` literal matching the reducer's expected shape.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/state/state.reducer.test.ts`
Expected: FAIL — order becomes `['wsC','wsA','wsB']` (prepended).

- [ ] **Step 3: Implement — stop calling `upsertOpenWorkspace` in `SET_ACTIVE_WORKSPACE_ID`**

In the `SET_ACTIVE_WORKSPACE_ID` case, replace the `openWorkspaces: upsertOpenWorkspace(...)` with the unchanged array (just set the active id + derived fields). Keep `deriveActiveWorkspace` / `room` / `focusedPaneId` exactly as they were.
```ts
case 'SET_ACTIVE_WORKSPACE_ID': {
  // ...existing guards (workspace exists, etc.)...
  return deriveActiveWorkspace({
    ...state,
    activeWorkspaceId: action.workspaceId, // activate in place — do NOT reorder (DEV-4)
    room,
    focusedPaneId,
  });
}
```
> Do NOT touch `SET_ACTIVE_WORKSPACE` (open-new still prepends) or `CLOSE_WORKSPACE`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/state/state.reducer.test.ts`
Expected: PASS — order preserved.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/state.reducer.ts src/renderer/state/state.reducer.test.ts
git commit -m "fix(state): activate workspace in place without reordering the rail (DEV-4)"
```

### Lane A gate

```bash
npx tsc -b && npx vitest run src/renderer/features/workspace-launcher src/renderer/state && npm run lint
```
Expected: green. Report the diff (incl. new files) with `git add -A && git diff --cached HEAD`.

---

## Lane B — Skills (SMK-3 + SMK-3b)

**Owns files:** `src/main/core/skills/discovery.ts` (NEW) + `discovery.test.ts` (NEW), `src/main/core/skills/controller.ts`, `src/renderer/features/skills/SkillsTab.tsx`, `src/renderer/features/command-room/insertSkillCommand.ts` (+ `.test.ts`), `src/renderer/features/command-room/PaneShell.tsx`. **Shared seam (edit locally, lead integrates):** `src/shared/router-shape.ts` (the `skills.listInstalled` return shape ~line 442-446).

### Task B1: SMK-3 — extract a testable `discovery.ts` that scans ALL providers

**Root cause (verified):** `controller.ts:276-357` `discoverInstalledSkills()` scans only `claude-plugins-official/superpowers` and `cache/ruflo` (the latter broken — it expects `<plugin>/skills/` but the real layout is `<plugin>/<version>/skills/`). It misses claude user skills (`~/.claude/skills`), claude commands (`~/.claude/commands`), codex (`~/.codex/skills`), gemini (`~/.agents/skills`), and every other claude plugin. The reliable source for plugin paths is the manifest `~/.claude/plugins/installed_plugins.json` (`installPath` per plugin) — read it, don't blind-glob (the cache has 80+ `temp_git_*`/`temp_subdir_*` dirs).

**Files:**
- Create: `src/main/core/skills/discovery.ts`
- Create: `src/main/core/skills/discovery.test.ts`

- [ ] **Step 1: Write the failing unit test against an injected in-memory fs**

```ts
import { describe, it, expect } from 'vitest';
import { discoverInstalledSkills } from './discovery';

// A tiny in-memory fs fake matching the Pick<typeof fs, ...> the module injects.
function makeFs(tree: Record<string, string>) {
  const files = new Set(Object.keys(tree));
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      return tree[p];
    },
    readdirSync: (p: string) =>
      [...new Set(
        [...files, ...dirs]
          .filter((x) => x.startsWith(p + '/') && x.slice(p.length + 1).indexOf('/') === -1)
          .map((x) => x.slice(p.length + 1)),
      )],
  } as const;
}

const SKILL = (name: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\nbody`;

describe('discoverInstalledSkills (SMK-3)', () => {
  const HOME = '/home/u';
  it('scans ruflo through the version dir (3-level), not 2-level', () => {
    const fs = makeFs({
      [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
        plugins: { 'ruflo-core': [{ installPath: `${HOME}/.claude/plugins/cache/ruflo/ruflo-core/0.2.0` }] },
      }),
      [`${HOME}/.claude/plugins/cache/ruflo/ruflo-core/0.2.0/skills/ruflo-doctor/SKILL.md`]: SKILL('ruflo-doctor'),
    });
    const out = discoverInstalledSkills({ homeDir: HOME, fs });
    expect(out.find((s) => s.name === 'ruflo-doctor')?.source).toBe('ruflo');
  });

  it('scans codex skills and marks them with the $ prefix', () => {
    const fs = makeFs({
      [`${HOME}/.codex/skills/agent-x/SKILL.md`]: SKILL('agent-x'),
    });
    const out = discoverInstalledSkills({ homeDir: HOME, fs });
    const codex = out.find((s) => s.name === 'agent-x');
    expect(codex?.source).toBe('codex');
    expect(codex?.prefix).toBe('$');
  });

  it('scans claude user skills + gemini skills with the / prefix', () => {
    const fs = makeFs({
      [`${HOME}/.claude/skills/cl-skill/SKILL.md`]: SKILL('cl-skill'),
      [`${HOME}/.agents/skills/gm-skill/SKILL.md`]: SKILL('gm-skill'),
    });
    const out = discoverInstalledSkills({ homeDir: HOME, fs });
    expect(out.find((s) => s.name === 'cl-skill')?.prefix).toBe('/');
    expect(out.find((s) => s.name === 'gm-skill')?.source).toBe('gemini');
  });

  it('returns [] (never throws) when nothing is installed', () => {
    expect(discoverInstalledSkills({ homeDir: HOME, fs: makeFs({}) })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/core/skills/discovery.test.ts`
Expected: FAIL — `Cannot find module './discovery'`.

- [ ] **Step 3: Implement `discovery.ts`**

```ts
import nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSkillMd } from './frontmatter';

export type InstalledSkillSource =
  | 'superpowers' | 'ruflo' | 'claude-plugin'
  | 'claude' | 'claude-cmd' | 'codex' | 'gemini' | 'custom';

export interface InstalledSkillEntry {
  name: string;
  description: string;
  source: InstalledSkillSource;
  /** Which CLI owns it — selects the injection prefix. */
  provider: 'claude' | 'codex' | 'gemini' | 'unknown';
  /** Slash-command prefix in that CLI: '/' for claude/gemini, '$' for codex. */
  prefix: '/' | '$';
}

type FsLike = Pick<typeof nodeFs, 'existsSync' | 'readdirSync' | 'readFileSync'>;
export interface DiscoveryOptions { homeDir?: string; fs?: FsLike; }

const CLAUDE_PREFIX = '/' as const;
const CODEX_PREFIX = '$' as const;

export function discoverInstalledSkills(opts: DiscoveryOptions = {}): InstalledSkillEntry[] {
  const home = opts.homeDir ?? os.homedir();
  const fs = opts.fs ?? nodeFs;
  const out: InstalledSkillEntry[] = [];
  const seen = new Set<string>(); // dedupe by source+name

  const readdir = (d: string): string[] => { try { return fs.readdirSync(d) as string[]; } catch { return []; } };
  const push = (e: InstalledSkillEntry) => {
    const key = `${e.source}:${e.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };

  // Scan a flat `<base>/<skill>/SKILL.md` provider dir.
  const scanFlat = (base: string, source: InstalledSkillSource, provider: InstalledSkillEntry['provider'], prefix: '/' | '$') => {
    if (!fs.existsSync(base)) return;
    for (const dir of readdir(base)) {
      const md = path.join(base, dir, 'SKILL.md');
      if (!fs.existsSync(md)) continue;
      try {
        const parsed = parseSkillMd(fs.readFileSync(md, 'utf8'), dir);
        if (parsed.ok) push({ name: parsed.data.name, description: parsed.data.description, source, provider, prefix });
      } catch { /* skip */ }
    }
  };

  // 1) Claude plugins via the manifest (correct versioned installPath; avoids temp_* pollution).
  try {
    const manifestPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        plugins?: Record<string, Array<{ installPath?: string }>>;
      };
      for (const [pluginKey, entries] of Object.entries(manifest.plugins ?? {})) {
        for (const entry of entries ?? []) {
          const installPath = entry?.installPath;
          if (!installPath) continue;
          const skillsDir = path.join(installPath, 'skills');
          const source: InstalledSkillSource =
            pluginKey === 'superpowers' ? 'superpowers'
            : installPath.includes(`${path.sep}ruflo${path.sep}`) ? 'ruflo'
            : 'claude-plugin';
          scanFlat(skillsDir, source, 'claude', CLAUDE_PREFIX);
        }
      }
    }
  } catch { /* manifest absent/corrupt — fall through */ }

  // 2) Claude user skills (flat).
  scanFlat(path.join(home, '.claude', 'skills'), 'claude', 'claude', CLAUDE_PREFIX);
  // 3) Codex skills (flat, $ prefix).
  scanFlat(path.join(home, '.codex', 'skills'), 'codex', 'codex', CODEX_PREFIX);
  // 4) Gemini skills (flat).
  scanFlat(path.join(home, '.agents', 'skills'), 'gemini', 'gemini', CLAUDE_PREFIX);

  // 5) Claude commands: ~/.claude/commands/**/*.md (skip README). Recursive, name = file stem.
  const cmdBase = path.join(home, '.claude', 'commands');
  const walkCmds = (dir: string) => {
    for (const ent of readdir(dir)) {
      const full = path.join(dir, ent);
      if (fs.existsSync(path.join(full, '')) && readdir(full).length && !ent.endsWith('.md')) {
        walkCmds(full); // subdir
      } else if (ent.endsWith('.md') && ent.toLowerCase() !== 'readme.md') {
        try {
          const parsed = parseSkillMd(fs.readFileSync(full, 'utf8'), ent.replace(/\.md$/, ''));
          const name = parsed.ok ? parsed.data.name : ent.replace(/\.md$/, '');
          const description = parsed.ok ? parsed.data.description : '';
          push({ name, description, source: 'claude-cmd', provider: 'claude', prefix: CLAUDE_PREFIX });
        } catch { /* skip */ }
      }
    }
  };
  if (fs.existsSync(cmdBase)) walkCmds(cmdBase);

  return out;
}
```
> The recursive `walkCmds` dir-vs-file check above is approximate — implement it with whatever stat/dirent capability the injected `fs` exposes (the test's fake fs only needs `existsSync`/`readdirSync`/`readFileSync`; for the real `node:fs` you may use `Dirent`/`statSync`). Keep the SKILL.md providers (the tested paths) exactly as written; commands-walk is best-effort and need not be unit-pinned beyond "doesn't throw."

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/core/skills/discovery.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/skills/discovery.ts src/main/core/skills/discovery.test.ts
git commit -m "feat(skills): provider-wide skill discovery via plugins manifest + flat dirs (SMK-3)"
```

### Task B2: SMK-3 — wire the controller to `discovery.ts` and widen the type at all 3 mirrored sites

**Files:**
- Modify: `src/main/core/skills/controller.ts` (re-export the new type; `listInstalled` → `discoverInstalledSkills()`; delete the old in-file `discoverInstalledSkills` + `safeReaddir`)
- Modify: `src/shared/router-shape.ts` (`skills.listInstalled` return shape ~line 442-446) — **shared seam**
- Modify: `src/renderer/features/skills/SkillsTab.tsx` (local `InstalledSkillEntry` interface ~line 40-44 + `SOURCE_BADGE` ~line 70-74)

- [ ] **Step 1: Update the type at the authoritative site (controller.ts)**

Replace the in-file `InstalledSkillEntry` (lines 24-28) with a re-export of the discovery type so there is one source of truth:
```ts
export type { InstalledSkillEntry, InstalledSkillSource } from './discovery';
import { discoverInstalledSkills } from './discovery';
```
Point `listInstalled` at it (it already calls a local fn at line 144-146):
```ts
listInstalled: async (): Promise<InstalledSkillEntry[]> => discoverInstalledSkills(),
```
Delete the now-dead local `discoverInstalledSkills` (276-357) and `safeReaddir` (359-365), and the now-unused `fs`/`os`/`parseSkillMd` imports if nothing else uses them (check — `parseSkillMd` may be used elsewhere; only remove truly-unused imports).

- [ ] **Step 2: Mirror the shape in `router-shape.ts` (shared seam)**

At the `listInstalled` entry (~line 442-446), widen `source` and add `provider`/`prefix` so the preload bridge type matches:
```ts
listInstalled: () => Promise<Array<{
  name: string;
  description: string;
  source: 'superpowers' | 'ruflo' | 'claude-plugin' | 'claude' | 'claude-cmd' | 'codex' | 'gemini' | 'custom';
  provider: 'claude' | 'codex' | 'gemini' | 'unknown';
  prefix: '/' | '$';
}>>;
```

- [ ] **Step 3: Mirror in the renderer (SkillsTab.tsx) + extend `SOURCE_BADGE`**

Replace the local interface (~40-44) to match, and extend `SOURCE_BADGE` (~70-74) with the new sources so each renders a label/color (give `claude`, `claude-cmd`, `claude-plugin`, `codex`, `gemini` badges; keep `superpowers`/`ruflo`/`custom`). Preserve existing `data-testid`/`aria-label` selectors.

- [ ] **Step 4: Run typecheck + the SkillsTab tests**

Run: `npx tsc -b && npx vitest run src/renderer/features/skills src/main/core/skills`
Expected: PASS (types agree across all 3 sites; existing SkillsTab tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/skills/controller.ts src/shared/router-shape.ts src/renderer/features/skills/SkillsTab.tsx
git commit -m "feat(skills): surface all providers in the Skills tab; widen InstalledSkillEntry across the 3 mirrored sites (SMK-3)"
```

### Task B3: SMK-3b — per-provider injection prefix (`$` for codex)

**Root cause (verified):** `insertSkillCommand.ts:47` writes `` `/${skillName} ` `` for every provider; codex uses `$name`. `PaneShell.tsx:267-270` calls it with `session.providerId` in scope but does not pass it.

**Files:**
- Modify: `src/renderer/features/command-room/insertSkillCommand.ts`
- Modify: `src/renderer/features/command-room/PaneShell.tsx` (the `insertSkillCommand(...)` call ~line 267-270)
- Modify: `src/renderer/features/command-room/insertSkillCommand.test.ts` (~line 51-55 — parameterize by provider)

- [ ] **Step 1: Update the failing test to expect `$` for codex**

```ts
it('writes a /name for claude', async () => {
  await insertSkillCommand('s1', 'code-review', 'running', 'claude');
  expect(rpc.pty.write).toHaveBeenCalledWith('s1', '/code-review ');
});
it('writes a $name for codex (SMK-3b)', async () => {
  await insertSkillCommand('s1', 'code-review', 'running', 'codex');
  expect(rpc.pty.write).toHaveBeenCalledWith('s1', '$code-review ');
});
it('defaults to / for gemini', async () => {
  await insertSkillCommand('s1', 'code-review', 'running', 'gemini');
  expect(rpc.pty.write).toHaveBeenCalledWith('s1', '/code-review ');
});
```
> Update the existing assertion at 51-55 to pass the new 4th arg, and add the codex/gemini cases.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/insertSkillCommand.test.ts`
Expected: FAIL — signature mismatch / codex still writes `/`.

- [ ] **Step 3: Implement the prefix map + new param**

```ts
const SKILL_COMMAND_PREFIX: Record<string, '/' | '$'> = { claude: '/', codex: '$', gemini: '/' };

export async function insertSkillCommand(
  sessionId: string,
  skillName: string,
  sessionStatus: AgentSession['status'],
  providerId: string,
): Promise<void> {
  if (sessionStatus !== 'running') {
    toast.warning('Pane is not running', { description: 'Start the pane before dropping skills.' });
    return;
  }
  const prefix = SKILL_COMMAND_PREFIX[providerId] ?? '/';
  await rpc.pty.write(sessionId, `${prefix}${skillName} `);
}
```
Then in `PaneShell.tsx` (~267-270), pass `session.providerId` as the 4th arg.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/features/command-room/insertSkillCommand.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/command-room/insertSkillCommand.ts \
        src/renderer/features/command-room/PaneShell.tsx \
        src/renderer/features/command-room/insertSkillCommand.test.ts
git commit -m "fix(skills): codex skill injection uses \$name not /name (SMK-3b)"
```

### Lane B gate

```bash
npx tsc -b && npx vitest run src/main/core/skills src/renderer/features/skills src/renderer/features/command-room && npm run lint
```
Report the diff with `git add -A && git diff --cached HEAD`. **Flag the `shared/router-shape.ts` hunk explicitly in your report** (lead-owned seam).

---

## Lane C — Browser (DEV-1 + DEV-2 + DEV-3)

**Owns files:** `src/main/core/design/controller.ts` (+ `.test.ts`), `src/renderer/features/browser/DesignDock.tsx` (+ test), `src/main/core/browser/manager.ts`, `src/main/core/db/schema.ts`, `src/main/core/db/migrations/0033_browser_tabs_closed_at.ts` (NEW) + `.test.ts` (NEW), `src/main/core/db/migrate.ts`, `src/renderer/features/browser/BrowserRoom.tsx`, `src/renderer/features/browser/AddressBar.tsx`, `src/renderer/features/browser/BrowserRecents.tsx`. **Shared seam (edit locally, lead integrates):** `src/shared/router-shape.ts` (+`rpc-router.ts`) for the new `browser.listRecents`.

### Task C1: DEV-1 — stop the element-dispatch from auto-submitting (`\r` → `\n`)

**Root cause (verified):** `core/design/controller.ts:290` writes `text + '\r'`; `\r` is Enter in a PTY → premature submit. Every other PTY writer in the repo uses `'\n'` (`rpc-router.ts:969`, `launcher.ts:589`, `assistant/tools.ts:260`). The test `controller.test.ts:120` asserts `endsWith('\r')` — it encodes the bug.

**Files:**
- Modify: `src/main/core/design/controller.ts` (~line 288-290)
- Modify: `src/main/core/design/controller.test.ts` (~line 120)

- [ ] **Step 1: Flip the test assertion to expect `\n`**

```ts
// controller.test.ts ~line 120
expect(text.endsWith('\n')).toBe(true);
expect(text.endsWith('\r')).toBe(false);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/design/controller.test.ts`
Expected: FAIL — source still appends `\r`.

- [ ] **Step 3: Implement**

```ts
await writeFn(input.targetSessionId, text + '\n'); // was '\r' — '\r' auto-submits (DEV-1)
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/core/design/controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/design/controller.ts src/main/core/design/controller.test.ts
git commit -m "fix(design): write \\n not \\r so element dispatch does not auto-submit (DEV-1)"
```

### Task C2: DEV-1 — auto-seed an editable prompt template when an element is captured

**Operator decision:** picking an element fills the prompt textarea with an editable template so Dispatch enables; the user can still edit. Today `DesignDock.tsx:110-117` only `setCapture(p)` + opens the HTML panel; the prompt stays empty so Dispatch (`:475-480`, gated on `!prompt.trim()`) stays disabled.

**Files:**
- Modify: `src/renderer/features/browser/DesignDock.tsx` (the `design:capture` handler ~110-117)
- Test: `src/renderer/features/browser/DesignDock.target.test.tsx` (add a capture→prompt case)

- [ ] **Step 1: Write the failing test**

```tsx
it('seeds an editable prompt when an element is captured so Dispatch enables (DEV-1)', async () => {
  renderDesignDock({ workspaceId: 'ws1' }); // use the existing harness
  emitDesignCapture({ workspaceId: 'ws1', selector: 'button.cta', outerHTML: '<button class="cta">Buy</button>' });
  const textarea = await screen.findByRole('textbox');
  expect((textarea as HTMLTextAreaElement).value).toMatch(/button\.cta/);
  // Dispatch is no longer disabled purely for lack of a prompt:
  expect(screen.getByRole('button', { name: /dispatch/i })).not.toBeDisabled();
});
```
> Match `emitDesignCapture`/`renderDesignDock` to the harness the existing `DesignDock.target.test.tsx` uses (it already drives `design:capture`). Use the real `CapturePayload` field names — read the type before writing the test.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/browser/DesignDock.target.test.tsx`
Expected: FAIL — prompt stays empty; Dispatch disabled.

- [ ] **Step 3: Implement the auto-seed (only when the prompt is empty — never clobber the user's text)**

```tsx
useEffect(() => {
  const off = onEvent<CapturePayload>('design:capture', (p) => {
    if (!p || p.workspaceId !== workspaceId) return;
    setCapture(p);
    setHtmlOpen(true);
    setPrompt((curr) => {
      if (curr.trim()) return curr; // respect any existing user text
      const sel = p.selector ?? p.tagName ?? 'the selected element';
      return `Update ${sel}:\n\n${p.outerHTML}\n\n`; // editable template
    });
  });
  return () => off();
}, [workspaceId]);
```
> Use the real `CapturePayload` fields (`selector`/`tagName`/`outerHTML` — confirm names). Keep the `setHtmlOpen(true)` behavior.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/features/browser/DesignDock.target.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/browser/DesignDock.tsx src/renderer/features/browser/DesignDock.target.test.tsx
git commit -m "feat(design): auto-seed an editable prompt on element capture so Dispatch enables (DEV-1)"
```

### Task C3: DEV-2 — migration `0033` adds `closed_at` soft-delete to `browser_tabs`

**Root cause (verified):** `manager.ts:127-143` `closeTab` hard-deletes; Recents (`BrowserRecents.tsx:52-68`) is built from open tabs only. Highest registered migration is `0032`; next is `0033`. Follow H-7 (no self-`BEGIN`/`COMMIT`; the runner wraps each migration in one transaction).

**Files:**
- Modify: `src/main/core/db/schema.ts` (`browserTabs` table ~232-250 — add `closedAt`)
- Create: `src/main/core/db/migrations/0033_browser_tabs_closed_at.ts`
- Create: `src/main/core/db/migrations/0033_browser_tabs_closed_at.test.ts`
- Modify: `src/main/core/db/migrate.ts` (import + append to `ALL_MIGRATIONS`)

- [ ] **Step 1: Write the failing migration test (mirror the 0032 test harness exactly)**

Open `0032_agent_session_pane_uq_status_aware.test.ts` first and copy its harness (MockDb vs better-sqlite3 — use whatever it uses). Assert that after `up(db)` the `browser_tabs` table has a `closed_at` column and the recents index exists.
```ts
import { describe, it, expect } from 'vitest';
import * as mig from './0033_browser_tabs_closed_at';
// ...same db setup as 0032's test...

describe('0033_browser_tabs_closed_at', () => {
  it('adds a nullable closed_at column and a recents index', () => {
    const db = makeDb(); // per 0032's harness; pre-create browser_tabs as 0032's test pre-creates its tables
    mig.up(db);
    const cols = tableColumns(db, 'browser_tabs'); // helper per 0032's pattern
    expect(cols).toContain('closed_at');
    // index present (query sqlite_master or the harness's index helper)
    expect(indexExists(db, 'browser_tabs_recents_idx')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/db/migrations/0033_browser_tabs_closed_at.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the migration (no self-BEGIN — H-7)**

```ts
import type Database from 'better-sqlite3';

export const name = '0033_browser_tabs_closed_at';

export function up(db: Database.Database): void {
  // Nullable: NULL = open, epoch-ms = closed. The runner owns the transaction.
  db.exec(`ALTER TABLE browser_tabs ADD COLUMN closed_at INTEGER`);
  db.exec(`CREATE INDEX IF NOT EXISTS browser_tabs_recents_idx
           ON browser_tabs (workspace_id, closed_at, last_visited_at)`);
}
```

- [ ] **Step 4: Register + extend the Drizzle schema**

In `migrate.ts`: add `import * as mig0033 from './migrations/0033_browser_tabs_closed_at';` after the 0032 import, and append `mig0033,` after `mig0032,` in `ALL_MIGRATIONS`.
In `schema.ts` `browserTabs` add the column so Drizzle queries see it:
```ts
closedAt: integer('closed_at'), // null = open; epoch-ms = closed (DEV-2)
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/main/core/db/migrations/0033_browser_tabs_closed_at.test.ts && npx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/db/schema.ts \
        src/main/core/db/migrations/0033_browser_tabs_closed_at.ts \
        src/main/core/db/migrations/0033_browser_tabs_closed_at.test.ts \
        src/main/core/db/migrate.ts
git commit -m "feat(db): migration 0033 — browser_tabs.closed_at soft-delete + recents index (DEV-2)"
```

### Task C4: DEV-2 — soft-delete on close + `listRecents` + wire Recents

**Files:**
- Modify: `src/main/core/browser/manager.ts` (`closeTab` ~127-143; `hydrateFromDb`; add `listRecents`)
- Modify: `src/shared/router-shape.ts` (+`src/main/rpc-router.ts`) — **shared seam** — add `browser.listRecents`
- Modify: `src/renderer/features/browser/BrowserRoom.tsx` + `BrowserRecents.tsx` (load + render recents)
- Test: extend/create `src/main/core/browser/manager.test.ts` (MockDb) for soft-delete + listRecents

- [ ] **Step 1: Write the failing manager test (MockDb)**

```ts
it('closeTab soft-deletes (sets closed_at) instead of hard-deleting (DEV-2)', async () => {
  // Arrange a manager with a MockDb holding one open tab.
  await manager.closeTab('t1');
  // Assert: the row still exists with closed_at != null, and listTabs() excludes it.
  expect(mockDb.rows('browser_tabs').find((r) => r.id === 't1')?.closed_at).toBeTruthy();
  expect(manager.listTabs().map((t) => t.id)).not.toContain('t1');
});
it('listRecents returns recently-closed origins (DEV-2)', () => {
  const recents = manager.listRecents();
  expect(recents.some((r) => r.url.includes('example.com'))).toBe(true);
});
```
> Use the project's MockDb pattern (search for an existing `manager.test.ts` or the nearest MockDb-based test and copy its setup). Never `new Database()` in vitest.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/browser/manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `manager.ts`**

`closeTab`: replace the hard `db.delete(...)` with a soft-delete update:
```ts
db.update(browserTabs).set({ closedAt: Date.now(), active: 0 }).where(eq(browserTabs.id, tabId)).run();
```
`hydrateFromDb`: filter out closed rows — `.where(and(eq(browserTabs.workspaceId, this.workspaceId), isNull(browserTabs.closedAt)))` (import `and`, `isNull` from drizzle).
Add `listRecents`:
```ts
/** Most-recent distinct origins from closed tabs, newest first (DEV-2). */
listRecents(limit = 30): Array<{ url: string; title: string; lastVisitedAt: number }> {
  const db = getDb();
  const rows = db.select().from(browserTabs)
    .where(and(eq(browserTabs.workspaceId, this.workspaceId), isNotNull(browserTabs.closedAt)))
    .orderBy(desc(browserTabs.lastVisitedAt)).limit(limit).all();
  return rows.map((r) => ({ url: r.url, title: r.title, lastVisitedAt: r.lastVisitedAt }));
}
```

- [ ] **Step 4: Add the RPC (shared seam) + renderer wiring**

`router-shape.ts`: under the `browser` namespace add `listRecents: (input: { workspaceId: string }) => Promise<Array<{ url: string; title: string; lastVisitedAt: number }>>;`. `rpc-router.ts`: implement it by delegating to the workspace's manager `listRecents`. `BrowserRoom.tsx`: fetch recents (on mount / when tabs change) and pass to `BrowserRecents`; `BrowserRecents.tsx`: render the fetched recents (closed origins) in addition to / instead of the open-tab-derived list, per its current UI.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/main/core/browser && npx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/browser/manager.ts src/shared/router-shape.ts src/main/rpc-router.ts \
        src/renderer/features/browser/BrowserRoom.tsx src/renderer/features/browser/BrowserRecents.tsx \
        src/main/core/browser/manager.test.ts
git commit -m "feat(browser): soft-delete tabs + listRecents so closed tabs reopen from Recents (DEV-2)"
```

### Task C5: DEV-3 — address bar bootstraps the first tab

**Root cause (verified):** `BrowserRoom.tsx:358-361` passes `disabled={!activeTab}`; `handleNavigate` (`:177-183`) early-returns when `!activeTabId`. So you cannot type a URL to open the first tab.

**Files:**
- Modify: `src/renderer/features/browser/BrowserRoom.tsx` (`handleNavigate` ~177-183; AddressBar props ~358-361)
- Modify: `src/renderer/features/browser/AddressBar.tsx` (~101-115 — URL input no longer hard-disabled; nav buttons stay gated)
- Test: `src/renderer/features/browser/BrowserRoom.test.tsx` (add the no-tab navigate case)

- [ ] **Step 1: Write the failing test**

```tsx
it('typing a URL with no open tab creates the first tab (DEV-3)', async () => {
  renderBrowserRoom({ tabs: [] }); // empty tabs harness
  const url = screen.getByRole('textbox'); // the address input
  fireEvent.change(url, { target: { value: 'example.com' } });
  fireEvent.keyDown(url, { key: 'Enter' });
  expect(rpc.browser.openTab).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('example.com') }));
});
```
> Match `renderBrowserRoom` to the existing `BrowserRoom.test.tsx` harness; it currently mocks the AddressBar — for this test render the real AddressBar (or assert via the onNavigate path it exposes).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/browser/BrowserRoom.test.tsx`
Expected: FAIL — input disabled / handleNavigate no-ops.

- [ ] **Step 3: Implement**

`handleNavigate`:
```ts
const handleNavigate = useCallback((url: string) => {
  if (!ws) return;
  if (!activeTabId) { void rpc.browser.openTab({ workspaceId: ws.id, url }).catch(console.error); return; } // DEV-3
  void rpc.browser.navigate({ workspaceId: ws.id, tabId: activeTabId, url });
}, [ws, activeTabId]);
```
AddressBar: stop disabling the `<input>` itself. Either pass a separate `urlInputDisabled={false}` prop (keep `disabled` for back/forward/reload/stop/home), or remove `disabled` from the `<input>` element and keep it on the nav buttons. Confirm `rpc.browser.openTab` exists with `{ workspaceId, url }` (it's used by the empty-state CTA per recon) — reuse it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/features/browser/BrowserRoom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/browser/BrowserRoom.tsx src/renderer/features/browser/AddressBar.tsx \
        src/renderer/features/browser/BrowserRoom.test.tsx
git commit -m "fix(browser): typing a URL with no tab opens the first tab (DEV-3)"
```

### Lane C gate

```bash
npx tsc -b && npx vitest run src/main/core/design src/main/core/browser src/main/core/db src/renderer/features/browser && npm run lint
```
Report the diff with `git add -A && git diff --cached HEAD`. **Flag the `shared/router-shape.ts` + `rpc-router.ts` hunks** (lead-owned seam).

---

## Integration (LEAD)

After all three lanes return:
1. Capture each worktree's full diff: `git -C <wt> add -A && git -C <wt> diff --cached HEAD` (captures NEW files).
2. Apply Lane A wholesale (no shared files). Apply Lane B + Lane C; **hand-merge the two `shared/router-shape.ts` hunks** (B: `skills.listInstalled` shape; C: `browser.listRecents` — different namespaces, additive) and the `rpc-router.ts` `browser.listRecents` impl (C only).
3. Re-gate in **main** (worktree tsc is laxer — it skips some test files): `npx tsc -b && npm test && npm run lint && npm run build`.
4. Run the full e2e dir before any ship decision: `npx playwright test tests/e2e/`.

## Self-review (done by author against the spec)
- **Coverage:** SMK-2 (A1), DEV-4 (A2), SMK-3 (B1+B2), SMK-3b (B3), DEV-1 (C1+C2), DEV-2 (C3+C4), DEV-3 (C5). DEV-5 dropped (refuted). ✓
- **Mirrored sites:** SMK-3's 3 `InstalledSkillEntry` sites (controller.ts, router-shape.ts, SkillsTab.tsx) + SOURCE_BADGE all in B2. PTY-writer convention (`\n`) noted for DEV-1. ✓
- **Types:** `InstalledSkillEntry` single-sourced from `discovery.ts`; `prefix` `'/'|'$'` consistent between `discovery.ts` and `insertSkillCommand.ts`'s `SKILL_COMMAND_PREFIX`. ✓
- **Migration:** 0033 is the next free number (0032 highest, 0026 stays pending); H-7 (no self-BEGIN). ✓
