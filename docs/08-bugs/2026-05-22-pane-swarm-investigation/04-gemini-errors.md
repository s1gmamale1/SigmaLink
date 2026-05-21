# 04 — Gemini CLI Errors: Root Cause Investigation

**Date**: 2026-05-22
**Lane**: 4 — Gemini spawn/resume errors
**Severity**: High (spawn fails silently; resume routes to wrong flag)

---

## 1. Rename Status — gemini-resume-sigma.ts

The rename from `gemini-resume-bridge.ts` to `gemini-resume-sigma.ts` is complete and consistent. All three callers import from the new name:

- `src/main/core/pty/resume-launcher.ts:14` — `from './gemini-resume-sigma'`
- `src/main/core/pty/session-disk-scanner.ts:27` — `from './gemini-resume-sigma'`
- `src/main/core/workspaces/launcher.ts:28` — `from '../pty/gemini-resume-sigma'`

No dangling `gemini-resume-bridge` references exist in the codebase. The rename is not the source of errors.

---

## 2. Bug G-1 — SPAWN: `--session-id` injected for Gemini but Gemini CLI does not support the flag

**Files**:
- `src/main/core/providers/launcher.ts:43` — `PRE_ASSIGN_PROVIDERS`
- `src/main/core/providers/launcher.ts:195–211` — `buildArgs`

**Root cause**: `PRE_ASSIGN_PROVIDERS` includes `'gemini'` alongside `'claude'`. On every fresh Gemini spawn, `shouldPreAssign` returns `true` and `buildArgs` prepends `--session-id <uuid>` to the argv before `provider.args`. The Gemini CLI (`@google/gemini-cli`) has no `--session-id` flag; passing an unrecognised flag causes Gemini to print a usage error and exit immediately (exit code 1), producing a blank pane within the 1.5-second `earlyDeath` window and setting `status = 'error'` in the DB.

There is no documentation anywhere in the codebase that Gemini's CLI accepts `--session-id`. The v1.2.8 comment that added Gemini to `PRE_ASSIGN_PROVIDERS` (`launcher.ts:20–23`) says "UUID pre-assignment for `claude` and `gemini`" without citing the Gemini flag, and no Gemini CLI docs or integration tests validate this assumption. The `session-disk-scanner.ts:640` comment explicitly acknowledges that Gemini's `--resume` flag does NOT accept a filename stem — it only accepts `'latest'` or an index number — which is consistent with Gemini having its own session protocol that does not include `--session-id`.

**Effect**: Every fresh Gemini pane spawn fails silently with an immediate exit. The DB row transitions to `status='error'` (earlyDeath path in `launcher.ts:430–436`).

**Proposed fix**: Remove `'gemini'` from `PRE_ASSIGN_PROVIDERS` in `src/main/core/providers/launcher.ts:43`. Gemini does not support pre-assigned session UUIDs; its session identity is derived from the chats JSONL filename on disk, which is fully managed by `gemini-resume-sigma.ts`.

```typescript
// Before (line 43)
const PRE_ASSIGN_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'gemini']);

// After
const PRE_ASSIGN_PROVIDERS: ReadonlySet<string> = new Set(['claude']);
```

No other changes are needed for fresh spawn; the `ensureGeminiProjectDir` call in `workspaces/launcher.ts:275` already pre-creates the correct chats directory so Gemini writes its session JSONL without issue.

---

## 3. Bug G-2 — RESUME: `buildResumeArgs` passes filename-stem as `--resume <id>`

**Files**:
- `src/main/core/pty/resume-launcher.ts:77–80` — `buildResumeArgs` Gemini case
- `src/main/core/pty/session-disk-scanner.ts:639–642` — inline comment

**Root cause**: `buildResumeArgs` for `'gemini'` with a non-null `externalSessionId` returns `{ args: ['--resume', id], mode: 'id' }` (line 79). The `id` value stored in `agent_sessions.external_session_id` for Gemini is the filename stem from the JSONL file (e.g. `session-2024-01-01T12-00-abc`), as set by `listGeminiSessions` at `session-disk-scanner.ts:676`. However, `session-disk-scanner.ts:639–642` explicitly states that Gemini's `--resume` flag accepts only `'latest'` or a session index number, NOT the filename stem.

Passing `gemini --resume session-2024-01-01T12-00-abc` causes Gemini to reject the argument and exit with an error. When the stored `externalSessionId` is present but invalid as a resume argument, the session is never restored and the pane goes blank.

**Effect**: Any Gemini pane resume attempt that uses a stored `externalSessionId` (i.e. `resumeMode: 'id'`) will fail at the Gemini CLI level, despite `prepareGeminiResume` having correctly set up the `projects.json` alias. Only the `mode: 'continue'` path (`--resume latest`) actually works.

**Proposed fix**: In `buildResumeArgs`, always force the `--resume latest` fallback for Gemini regardless of whether an `externalSessionId` is present. The filename stem cannot be used as a resume target; the projects.json alias bridge already ensures the correct chats directory is resolved.

```typescript
// resume-launcher.ts, buildResumeArgs, 'gemini' case (lines 77–80)
// Before:
case 'gemini':
  return id
    ? { args: ['--resume', id], mode: 'id' }
    : { args: ['--resume', 'latest'], mode: 'continue' };

// After:
case 'gemini':
  // Gemini --resume only accepts 'latest' or an index number, not a
  // filename stem. The session-disk-scanner stores the filename stem as
  // external_session_id for history display only; actual resume always
  // uses '--resume latest' with the projects.json alias bridge.
  return { args: ['--resume', 'latest'], mode: 'continue' };
```

Complementary: the same bad id path exists in `workspaces/launcher.ts:251` where `buildResumeArgs(provider.id, resumeSessionId)` is called for the session-picker resume flow. That call also routes through `buildResumeArgs`, so fixing the `'gemini'` case there covers both code paths.

---

## 4. Bug G-3 — RESUME ARG ORDER: `--session-id` + `--resume` conflict on resume path

**Files**:
- `src/main/core/providers/launcher.ts:223–238` — `shouldPreAssign`
- `src/main/core/providers/launcher.ts:228–232` — `extraArgs` guard

**Root cause**: `shouldPreAssign` guards against injecting `--session-id` when `extraArgs` contains `'--resume'`, `'--continue'`, or `'resume'` (lines 229–233). However, this guard is only reached if Bug G-1 is fixed (Gemini removed from `PRE_ASSIGN_PROVIDERS`). With Gemini still in that set AND with the `resumeWorkspacePanes` path setting `extraArgs: ['--resume', 'latest']`, the guard correctly fires and suppresses `--session-id` — which means the resume path accidentally avoids G-1. In other words:

- **Fresh spawn** (no `extraArgs`): G-1 triggers — `--session-id <uuid>` is prepended, Gemini exits.
- **Resume spawn** (`extraArgs: ['--resume', 'latest']`): guard fires, `--session-id` is suppressed, but G-2 triggers if a filename-stem id was stored.

This clarifies the failure modes: fresh spawn is broken by G-1; resume is broken by G-2.

**No independent fix needed for G-3** — it resolves when G-1 (remove Gemini from `PRE_ASSIGN_PROVIDERS`) is applied.

---

## 5. Bug G-4 — RESUME: `prepareGeminiResume` argument order inverted in `resume-launcher.ts`

**Files**:
- `src/main/core/pty/resume-launcher.ts:450` — `prepareGeminiResume(row.workspaceRoot, cwd, ...)`
- `src/main/core/pty/gemini-resume-sigma.ts:293–295` — function signature: `prepareGeminiResume(workspaceCwd, worktreeCwd, ...)`
- `src/main/core/workspaces/launcher.ts:245` — `prepareGeminiResume(wsRow.rootPath, cwd)` — **correct**

**Root cause**: `prepareGeminiResume` signature is `(workspaceCwd: string, worktreeCwd: string, ...)`. In `workspaces/launcher.ts:245` the call is `prepareGeminiResume(wsRow.rootPath, cwd)` — workspace first, worktree second, which is correct. In `resume-launcher.ts:450` the call is `prepareGeminiResume(row.workspaceRoot, cwd, ...)` — also workspace first, which is also correct on the surface.

After closer inspection the argument order is consistent between the two callers. **No inversion bug exists here.** Both pass `workspaceRoot` as the first argument (matching `workspaceCwd`) and the computed `cwd` (worktree path) as the second.

---

## 6. Summary Table

| Bug | Kind | File:Line | Symptom | Fix |
|-----|------|-----------|---------|-----|
| G-1 | Spawn | `providers/launcher.ts:43` | Fresh Gemini pane immediately exits (exit 1 on unknown `--session-id` flag) | Remove `'gemini'` from `PRE_ASSIGN_PROVIDERS` |
| G-2 | Resume | `pty/resume-launcher.ts:79` | Resume with stored session id passes filename stem to `--resume`; Gemini rejects it | Always use `--resume latest` in `buildResumeArgs` for `'gemini'` |
| G-3 | Spawn/resume interaction | `providers/launcher.ts:228` | (Resolves with G-1; no independent fix) | — |
| G-4 | Non-issue | — | Arg order is correct in both callers | — |

---

## 7. Proposed Fix Diff Summary

Two one-file changes fix both active bugs:

**Change 1** — `src/main/core/providers/launcher.ts:43`
- Remove `'gemini'` from `PRE_ASSIGN_PROVIDERS`.

**Change 2** — `src/main/core/pty/resume-launcher.ts:77–80`
- In the `'gemini'` case of `buildResumeArgs`, unconditionally return `{ args: ['--resume', 'latest'], mode: 'continue' }`.
- Add a comment citing the `session-disk-scanner.ts:639` note as the rationale.

No schema migrations, no DB changes, no changes to `gemini-resume-sigma.ts` are required.
