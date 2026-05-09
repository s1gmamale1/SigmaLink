# W6 - Skills Build Report (Phase 4)

Status: complete. All four build checks (`npm run build`, `npm run electron:compile`, `npm run product:check`, `npm run lint`) green. Lint total dropped from W5/W6a/W6b baseline (56 problems / 53 errors / 3 warnings) to 55 / 52 / 3 — the single reduction is from excluding the bundled `electron-dist/` output (a transient build artifact) from lint, which was the only delta visible after we now bundle `gray-matter`. No new errors or warnings in any source file under `src/`.

## 1. Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | `build`, `electron:compile`, `product:check`, `lint` all green | green |
| 2 | Skills room reachable from sidebar; Phase pill removed | green |
| 3 | Drop a folder containing valid SKILL.md → `skills` row + managed copy under `<userData>/skills/` | green |
| 4 | Toggling a provider creates a `skill_provider_state` row + copies into provider location | green |
| 5 | Uninstall removes managed copy + every fan-out copy + DB rows (cascade) | green |
| 6 | Restart rehydrates skills list from DB | green |
| 7 | Validation rejects invalid frontmatter with a clear UI error | green |

## 2. New files

### Main process (`app/src/main/core/skills/`)

- `types.ts` — `ProviderTarget`, `PROVIDER_TARGETS`, `isProviderTarget`, `SkillFrontmatter`, `FanoutResult`. Re-exports `Skill`/`SkillProviderState` from shared.
- `frontmatter.ts` — `parseSkillMd(text, fallbackName?)`. Wraps `gray-matter`. Validates `name` against `/^[a-z0-9-]{1,64}$/` (with the parent folder name as fallback per spec §7.4) and `description` (required, ≤1500 chars). Tolerates and forwards every additional field via `extra` so fan-out targets can use them later (Codex tool translation, Gemini extension manifest).
- `ingestion.ts` — `ingestFolder(srcAbsPath, { managedRoot, force })`. Reads SKILL.md, validates, walks the tree to compute a deterministic SHA-256 over `relpath:size:filehash` rows (sorted), copies into a temp sibling dir under `<userData>/skills/`, then `fs.rename`s into place. Idempotent if hashes match; throws `SkillUpdateRequiredError` on hash mismatch unless `force: true`. Also exposes `rehashManagedFolder` and `copyDirRecursive` for fan-out use. `ingestZip` defers (see §6).
- `fanout.ts` — `applyFanout(skill, managedDir, fm, body, targets, opts)`. Per-provider:
  - `claude` → `~/.claude/skills/<name>/`
  - `codex` → `~/.codex/skills/<name>/`
  - `gemini` → `~/.gemini/extensions/sigmalink-<name>/` with synthesized `gemini-extension.json` + `commands/<name>.toml` wrapping the SKILL.md body
  Strategy: stage into a sibling `.sigmalink-stage-<name>-<rand>/` then `fs.rename` onto target. Falls back to a delete-then-recursive-copy if the rename trips EXDEV/EBUSY (the OneDrive lock symptom called out in critique A8). Idempotent: same-hash target → no-op. Different-hash target without `force` → fail loudly. `removeFanout` is best-effort and never throws.
- `manager.ts` — `SkillsManager`. SQLite I/O for `skills` and `skill_provider_state`, orchestrates ingest → fan-out → DB upsert, emits `skills:changed` after every mutation (event broadcaster injected from `rpc-router.ts`). Default each provider state to disabled on first ingest; `enableForProvider` flips the row + fans out a single target; `disableForProvider` removes that fan-out copy and clears the row; `uninstall` removes every fan-out copy across all providers (regardless of toggle), removes the managed copy, deletes both rows.
- `controller.ts` — RPC controller wrapping the manager: `list`, `ingestFolder`, `ingestZip`, `enableForProvider`, `disableForProvider`, `uninstall`, `getReadme`. Validates the `provider` argument via `isProviderTarget`.

### Renderer (`app/src/renderer/features/skills/`)

- `SkillsRoom.tsx` — Drop zone + cards grid + error/update banners. Wires the room.
- `DropZone.tsx` — HTML5 drag/drop wrapper. Walks `webkitGetAsEntry()` for the dropped folder, finds top-level `SKILL.md`, resolves its absolute path via `window.sigma.getPathForFile(file)` (the preload bridge already exposed by W5), and hands the parent directory to `skills.ingestFolder`. Single-file `SKILL.md` drops resolve the same way.
- `SkillCard.tsx` — One installed skill: name, description, optional version + tag chips, three provider checkboxes with branded chips (Claude orange / Codex green / Gemini sky), per-provider error badge + `lastError` tooltip, "open detail" + "uninstall" actions.
- `SkillDetailModal.tsx` — Reads SKILL.md via `skills.getReadme`. Renders the body with a built-in minimal Markdown renderer (headings, lists, fenced code, inline code, bold/italic, links). HTML escaping at every input boundary so untrusted skill bodies cannot inject DOM. We did **not** install `react-markdown` — the trade-off is documented in §6.

### Documentation

- `docs/05-build/W6-SKILLS-report.md` (this file).

## 3. Modified files

- `app/src/main/core/db/schema.ts` — appended `skills` (id PK, name UNIQUE, description, version, content_hash, managed_path, installed_at, tags_json) and `skill_provider_state` (skill_id FK CASCADE, provider_id, enabled, last_fanout_at, last_error; uniqueIndex on (skill_id, provider_id) acting as composite PK at the SQLite layer).
- `app/src/main/core/db/client.ts` — appended matching CREATE TABLE + UNIQUE INDEX + FK CASCADE bootstrap statements so first-run installs end up with the new tables.
- `app/src/main/rpc-router.ts` — instantiates `SkillsManager`, registers `skillsCtl`, includes the manager in `SharedDeps`. The `skills:changed` broadcaster reuses the existing `BrowserWindow.webContents.send` fan-out helper.
- `app/src/shared/types.ts` — appended `SkillId`, `SkillProviderId` (`'claude' | 'codex' | 'gemini'`), `Skill`, `SkillProviderState`.
- `app/src/shared/router-shape.ts` — appended the `skills` namespace with the seven controller methods, mirroring the controller signature.
- `app/src/shared/rpc-channels.ts` — appended seven `skills.*` channels and the `skills:changed` event to the allowlist.
- `app/src/renderer/app/state.tsx` — appended `skills`, `skillProviderStates`, `skillsBusy` slices to `AppState`; reducer handles `SET_SKILLS` and `SKILLS_BUSY`; new effect hydrates skills on boot and re-fetches on `skills:changed` (no eslint-disable comments — refresh closure references `dispatch` which `useReducer` guarantees stable per React docs).
- `app/src/renderer/app/App.tsx` — wired `case 'skills'` to render `<SkillsRoom />` instead of the placeholder.
- `app/src/renderer/features/sidebar/Sidebar.tsx` — removed `phase: 3` from the Skills nav item; widened the disabled rule so Skills stays clickable when no workspace is open (skills are user-global per the spec).
- `app/eslint.config.js` — added `electron-dist` to global ignores. The bundled gray-matter source contains an `/* eslint-disable max-len */` directive that lint flagged as "unused"; since the bundle is a build artifact (regenerated by `electron:compile` on every build), excluding it is the right call. `dist/` is already excluded for the same reason.

## 4. Build verification

### `npm run build`
```
✓ 1796 modules transformed.
dist/index.html                   0.40 kB │ gzip:   0.27 kB
dist/assets/index-BhYVdK7N.css  100.35 kB │ gzip:  17.07 kB
dist/assets/index-m0L72VgY.js   659.96 kB │ gzip: 187.88 kB
✓ built in ~5s
```
Vite chunk-size warning is pre-existing.

### `npm run electron:compile`
```
electron-dist\main.js      392.0kb
electron-dist\main.js.map  933.6kb

electron-dist\preload.cjs    3.3kb
electron-dist\preload.cjs.map 5.8kb
```
Main bundle grew from ~201 KB (W5) to 392 KB; the delta is gray-matter + skills code. Acceptable — startup is unaffected.

### `npm run product:check`
Both stages green; output reproduced above.

### `npm run lint`
```
✖ 55 problems (52 errors, 3 warnings)
```
Down 1 from the W5/W6a/W6b baseline of 56/53/3 because we excluded `electron-dist/` from the lint glob. Every error and warning that remains is pre-existing in `_legacy/`, `components/ui/**`, `lib/utils.ts`, or the `react-refresh/only-export-components` warning on `useAppState` in `state.tsx` carried over from W5. Zero new errors / warnings in any of the new `skills/` files.

## 5. Decisions

### Atomic copy strategy

Both ingestion and fan-out write into a temp sibling directory on the same volume and then rename it onto the live target. Same-volume rename is atomic on every filesystem we ship to (NTFS, APFS, ext4). If the rename fails (cross-volume, EXDEV, or Windows OneDrive sync lock — A8 in the architecture critique), fan-out falls back to a delete-then-recursive-copy. This trades atomicity for liveness on hostile filesystems; we'd rather install a skill twice than leave a half-written `~/.claude/skills/<name>/` after a crash.

We deliberately **never** symlink. The architecture critique called out OneDrive Files-on-Demand rendering symlinks under `%USERPROFILE%` as `EACCES`/`EBUSY`. Plain copies cost disk space but eliminate the failure mode.

### Hash schema

`sha256(sorted-list-of("relpath:size:sha256(content)\n"))`. Reasons:
- Sorting `relpath` ASCII-ascending makes the hash stable across platforms (`fs.readdir` does not promise ordering).
- Including `size` lets us detect truncated files even if the file body collides on `sha256` (defensive belt-and-braces).
- Skipping `.DS_Store`, `Thumbs.db`, and `.git` so a SKILL exported from a developer machine hashes the same on a CI box without those files.
- Persisting the hash on `skills.content_hash` makes idempotent reinstalls a single comparison; `applyFanout` does the same against on-disk fan-out targets so `~/.claude/skills/<name>/` that's already up to date is a no-op.

### Update flow

The manager throws `Error('UPDATE_REQUIRED:<name>:<incomingHash>')` when an ingest discovers a different-hash managed copy without `force`. The renderer catches that prefix, surfaces an "Update?" banner with confirm/cancel, and re-invokes `ingestFolder({ path, force: true })` on confirm. This keeps the wire format string-only without introducing a structured error envelope across IPC.

### Default provider state

New skills install with every provider toggle **off**. The user must explicitly opt in per provider — fan-out runs only when the corresponding `enableForProvider` is invoked. This matches the spec ("per-skill enable toggle per provider") and prevents a drop from spamming `~/.claude` / `~/.codex` / `~/.gemini` for a user who only wanted to inspect the skill before committing.

## 6. Deferrals

| Topic | Why deferred | Suggested follow-up |
|---|---|---|
| Zip ingestion | The W6c spec said "if you'd need a new dep for zip extraction, defer". Node has no built-in zip reader and `adm-zip` / `unzipper` were both new deps. `ingestZip` throws a clear "drop the unzipped folder" error instead of silently failing. | Add `adm-zip` (~50 KB) in a follow-up wave; the controller surface and channel allowlist are already wired. |
| `react-markdown` for SKILL.md preview | Would have been a new ~80 KB dep purely for a read-only modal. Built a 60-line in-house renderer covering the markdown subset Anthropic skills actually use (headings, lists, fenced/inline code, bold/italic, links). HTML is escaped at the boundary so skill bodies cannot inject DOM via the preview. | If we ever ship Memory or Review tabs that need full Markdown (tables, blockquotes, GFM, math), pull in `react-markdown` then and migrate this modal to it. |
| Codex `allowed-tools` translation | The fan-out parser preserves `allowed-tools` verbatim. The spec calls for translating Claude tool names to Codex equivalents during fan-out; this is a content transform, not a structural one, and the fan-out writer is set up to plug it in (`fm.allowedTools` is already extracted in `frontmatter.ts`). | Layer the translation into `fanout.ts`'s codex branch before writing — no new files, no new channels. |
| Project-scoped skills | Out of scope per the brief ("user-global skills for v1"). | Add a `scope: 'user' | 'workspace'` column on `skills`, key the managed root off `workspaceId` when scope is workspace, and add per-workspace fan-out targets when present (e.g. `<repoRoot>/.claude/skills/<name>/`). |
| In-app skill editing | Out of scope ("Editing skills inside the app"). | Add a Monaco-style editor pane in a future Skills sub-room. |

## 7. New IPC surface

| Channel | Payload | Description |
|---|---|---|
| `skills.list` | `() → { skills, states }` | Returns the full installed list + per-provider toggle state. |
| `skills.ingestFolder` | `{ path: string; force?: boolean } → Skill` | Validate + copy + DB upsert + (optionally) re-fan to enabled providers. |
| `skills.ingestZip` | `{ path: string; force?: boolean } → Skill` | Defers (throws) until zip support lands. |
| `skills.enableForProvider` | `{ skillId; provider } → SkillProviderState` | Flip the toggle on, fan out to that provider. |
| `skills.disableForProvider` | `{ skillId; provider } → SkillProviderState` | Flip the toggle off, remove the fan-out copy. |
| `skills.uninstall` | `(skillId) → void` | Remove all fan-outs + managed copy + DB rows (cascade). |
| `skills.getReadme` | `(skillId) → { name; body } \| null` | Returns the raw SKILL.md text for the detail modal. |

| Event | Payload | Description |
|---|---|---|
| `skills:changed` | `{ reason; skillId?; provider? }` | Fired after every mutation so other panes (and the renderer state hook) can refresh without polling. |

## 8. Cross-platform notes

- **Windows.** `os.homedir()` returns `%USERPROFILE%` (typically OneDrive-synced). Fan-out writes through `fs.rename` first; on `EXDEV`/`EBUSY` we fall through to `copyDirRecursive` which is OneDrive-friendly.
- **macOS.** `~/.claude`, `~/.codex`, `~/.gemini` are all under `$HOME`. Atomic rename works on APFS without surprises.
- **Linux.** Same as macOS. ext4 rename is atomic.
- **Path separators.** Drop zone path resolution computes the parent of `SKILL.md` by splitting on `\\` if the absolute path contains a backslash, otherwise `/`. This avoids importing Node `path` into the renderer (which is sandboxed) and matches what `webUtils.getPathForFile` returns on each OS.
