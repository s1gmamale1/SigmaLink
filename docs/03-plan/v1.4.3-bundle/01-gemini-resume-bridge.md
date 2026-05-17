# 01 — Gemini Resume Bridge (P0)

**Severity**: P0 — Gemini is completely broken on every pane spawn
**Effort**: S (~3hr)
**Cluster**: C (independent — touches different files than B and A)
**Suggested delegate**: Sonnet (Claude Code) — security-adjacent, surgical refactor
**Depends on**: nothing — parallel-safe with everything

## Context

v1.4.2 dogfood: Gemini panes exit immediately with code 1, showing only the help text. User screenshot confirms `[session exited code=1]` after gemini's help output.

**Root cause** (confirmed via investigation, explore-gemini-bridge agent):
1. SigmaLink passes `gemini --resume <sigmalink-uuid>` (e.g. `gemini --resume e8b585d8-e103-4b55-9da2-126568111317`).
2. Gemini's `--resume` flag expects `"latest"` or a numeric INDEX into `gemini --list-sessions` output. UUIDs are invalid → gemini prints help and exits 1.
3. Even if SigmaLink fell back to `--resume latest`, each per-pane worktree has an empty `~/.gemini/tmp/<worktree-slug>/chats/` directory — gemini's session history lives under the **workspace-slug**, not the **worktree-slug**.

This is the **exact same class** of bug fixed in v1.3.2 for Claude via `claude-resume-bridge.ts`.

## Gemini disk layout (confirmed via investigation)

- Global root: `~/.gemini/`
- Project registry: `~/.gemini/projects.json` — flat JSON map `{ "<absolute cwd>": "<slug>", ... }`. Slug is typically the cwd basename (with collision-suffix when basenames collide).
- Sessions: `~/.gemini/tmp/<slug>/chats/session-YYYY-MM-DDThh-mm-<short>.jsonl`
- Tool transcripts: `~/.gemini/tmp/<slug>/<uuid>/`
- Project root pointer: `~/.gemini/tmp/<slug>/.project_root` (absolute cwd that owns the slug)

**Lead decision (locked)**: use the `projects.json` alias approach (NOT symlinks). Register `<worktreeCwd> → <workspaceSlug>` so gemini reads the SAME chats dir from both cwds. Cleaner than the Claude symlink approach because gemini's design supports it natively.

## File:line targets

### NEW `app/src/main/core/pty/gemini-resume-bridge.ts`

Helper surface (mirrors `claude-resume-bridge.ts` style):

```ts
export interface GeminiBridgeDeps {
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export type GeminiResumeBridgeOutcome =
  | 'aliased'    // projects.json now maps worktreeCwd → workspaceSlug
  | 'exists'     // mapping already in place; no-op
  | 'missing'    // workspaceSlug has no sessions; caller must drop resume args
  | 'skipped';   // workspaceCwd === worktreeCwd; bridge unnecessary

// Compute gemini's slug for a cwd. Reads projects.json first for authoritative
// mapping; falls back to path.basename when not registered.
export async function geminiSlugForCwd(
  homeDir: string,
  cwd: string,
  deps?: GeminiBridgeDeps
): Promise<string>;

// Read ~/.gemini/projects.json. Returns null if missing/malformed.
export async function lookupGeminiSlug(
  homeDir: string,
  cwd: string,
  deps?: GeminiBridgeDeps
): Promise<string | null>;

// Pre-create ~/.gemini/tmp/<workspace-slug>/{chats,tool-outputs}/ AND register
// worktreeCwd → workspaceSlug in projects.json (atomic). So gemini reads the
// SAME chats dir from both cwds.
// Called for every gemini spawn (fresh OR resume).
export async function ensureGeminiProjectDir(
  worktreeCwd: string,
  workspaceCwd: string,
  deps?: GeminiBridgeDeps
): Promise<string | null>;

// Determine if gemini can resume in worktreeCwd by aliasing to workspaceCwd's
// slug. Returns 'aliased' on first alias, 'exists' on subsequent calls,
// 'missing' if workspaceCwd has no sessions (caller drops --resume entirely),
// 'skipped' if workspaceCwd === worktreeCwd.
export async function prepareGeminiResume(
  workspaceCwd: string,
  worktreeCwd: string,
  deps?: GeminiBridgeDeps
): Promise<GeminiResumeBridgeOutcome>;
```

**Defensive checks** (copy from claude-resume-bridge):
- Refuse paths containing `..` traversal segments
- Require absolute paths
- Target slug must resolve under `<homeDir>/.gemini/tmp/` (no breakout)
- `projects.json` writes are atomic via `writeFileAtomic` helper

### Integration — `app/src/main/core/workspaces/launcher.ts`

Around lines 188-204 (the existing claude resume branch), add a **parallel** gemini branch:

```ts
if (provider.id === 'gemini' && resumeSessionId) {
  const bridge = await prepareGeminiResume(workspaceRootPath, paneCwd);
  if (bridge === 'missing') {
    // Drop resume args entirely — gemini cannot resume in an empty slug,
    // and "--resume latest" would still exit 1.
    resumeSessionId = null;
  }
}
```

Around lines 218-224 (after the claude `ensureClaudeProjectDir` call), add a parallel call for gemini:

```ts
if (provider.id === 'gemini') {
  await ensureGeminiProjectDir(paneCwd, workspaceRootPath);
}
```

### `app/src/main/core/pty/resume-launcher.ts`

**Line 73-76** — `buildResumeArgs` gemini case currently:
```ts
case 'gemini':
  return { args: ['--resume', id], mode: 'id' };
// (or fallback to '--resume', 'latest')
```

Change to handle the `'missing'` bridge outcome from caller — when the bridge says `'missing'`, the launcher upstream sets `resumeSessionId = null` so `buildResumeArgs` isn't called. No change needed here IF launcher integration is correct.

**Line 401-420** — `resumeWorkspacePanes` (boot-restore path). Add the same parallel gemini branch.

### `app/src/main/core/pty/session-disk-scanner.ts:620-622`

Currently:
```ts
case 'gemini':
  // Deferred to v1.3.1 — disk layout undocumented.
  return [];
```

Implement now that the layout is known:
```ts
case 'gemini': {
  const slug = await geminiSlugForCwd(homeDir, cwd);
  const chatsDir = path.join(homeDir, '.gemini', 'tmp', slug, 'chats');
  // Scan chatsDir for session-*.jsonl files; return discovered session ids.
  // Filter by workspaceId if opts.workspaceId is set (uses agent_sessions whitelist
  // from v1.4.2 packet 10 — reuse listSessionExternalIdsForWorkspace).
}
```

This unblocks the session picker UI for Gemini sessions.

## Tests

NEW `app/src/main/core/pty/gemini-resume-bridge.test.ts` (mirror `claude-resume-bridge.test.ts` shape). Required cases:

1. `geminiSlugForCwd` — derives basename when no registry entry
2. `geminiSlugForCwd` — respects existing `projects.json` mapping
3. `lookupGeminiSlug` — returns null when projects.json missing
4. `lookupGeminiSlug` — returns null when projects.json malformed
5. `ensureGeminiProjectDir` — creates `~/.gemini/tmp/<slug>/chats/` idempotently
6. `ensureGeminiProjectDir` — registers worktreeCwd → workspaceSlug in projects.json
7. `ensureGeminiProjectDir` — preserves other entries in projects.json on write
8. `prepareGeminiResume` — returns `'skipped'` when workspaceCwd === worktreeCwd
9. `prepareGeminiResume` — returns `'missing'` when workspaceCwd's slug has empty chats/
10. `prepareGeminiResume` — returns `'aliased'` on first call (new mapping)
11. `prepareGeminiResume` — returns `'exists'` on second call (idempotent)
12. Traversal refusal — paths containing `..` rejected
13. Absolute-path requirement — relative paths rejected

Plus an integration test in `launcher.test.ts` (if exists) or a new one covering the launcher branch.

## Gate

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.3-01-gemini-bridge/app
pnpm exec tsc -b --pretty false           # clean
pnpm exec vitest run                       # 417 baseline + ~13 new = ~430
pnpm exec eslint .                         # 0 errors
pnpm run build                              # clean
node scripts/build-electron.cjs             # clean
```

**Manual smoke (REQUIRED — P0 fix):**
1. `pnpm electron:dev`
2. Open a workspace with a Gemini pane in slot 1.
3. Verify Gemini spawns successfully (NO exit code 1, no help text dump).
4. Send a turn ("what is 2+2?"); verify response.
5. Quit app entirely.
6. Reopen → Gemini pane should resume from prior session (history visible in pane).
7. Verify `~/.gemini/projects.json` now has an entry for the worktree cwd → workspace slug.

## Risks

- **R-01-1** Gemini's `projects.json` schema is undocumented. The bridge READS first, MERGES, WRITES atomically. If gemini changes schema in a future release, bridge fails gracefully (spawn proceeds without resume).
- **R-01-2** Atomic write race — if two panes spawn simultaneously and both try to write `projects.json`, file lock not guaranteed by `writeFileAtomic`. Mitigation: serialize the bridge calls via a per-process mutex on the file path. Low risk; document for future v1.4.4 if encountered.
- **R-01-3** Plain (non-git) workspaces don't have worktrees — `workspaceCwd === worktreeCwd`. Bridge returns `'skipped'`; spawn proceeds normally. Verified via the early-return guard.

## Pairs with

- v1.3.2 Claude bridge precedent
- v1.4.2 #10 disk-scan workspace scoping (reused for the disk-scanner gemini case)

## Closes ship-claims / debt

- v1.4.2 deferred #04 (OpenCode font — actually this was wrong; v1.4.2 deferred #04 was a font issue, not gemini)
- Note: gemini disk-scanner stub at `session-disk-scanner.ts:620-622` originally marked "deferred to v1.3.1" — finally implemented.
