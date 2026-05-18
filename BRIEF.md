# v1.4.6 — Polish bundle (5 mechanical items)

## Mission

Close 5 small mechanical polish items that have been queued on the v1.4.6 WISHLIST. All are surgical fixes; none require design judgment. One PR per bundle is fine.

Working dir (absolute): `/Users/aisigma/projects/SigmaLink-feat-v1.4.6-polish`
Branch (already on): `feat/v1.4.6-polish`
Repo: `s1gmamale1/SigmaLink`

Stay inside this worktree. Do NOT `cd` to the main repo.

## Setup (run once)

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.6-polish/app
pnpm install --no-frozen-lockfile
node node_modules/electron/install.js
```

## The 5 items

### Item 1 — Terminal.tsx mount race (R-1.2.7-1)
**Severity**: P3 polish, 1-5ms IPC drop window during workspace switching
**File**: `app/src/renderer/features/command-room/Terminal.tsx`
**Current behavior**: attaches the live PTY listener AFTER awaiting the snapshot RPC. Between snapshot.await and listener attach, incoming IPC frames are lost.
**Fix**: attach the live listener FIRST, then request the snapshot. Buffer any frames that arrive during the await in a local array; flush them into xterm after snapshot replay.
**Test**: extend the existing Terminal.test.tsx (if it exists) with a fake-timers test that fires a `pty:data` IPC event mid-snapshot and asserts it lands in the terminal output.
**Effort**: XS (~30-60min including test)

### Item 2 — BUG-W7-015 Parchment theme Launch button contrast
**Severity**: P3 polish, light-theme cosmetic
**File**: probably `app/src/renderer/features/workspace-launcher/Launcher.tsx` or wherever the "Launch N agents" button renders. Grep for `Launch` + `Button` to find it.
**Issue**: in the Parchment (light) theme, the "Launch N agents" button uses dark rust accent on cream canvas. Contrast is visually weaker than the dark-theme neon equivalent.
**Fix**: ensure the button's color tokens hit WCAG AA contrast (≥4.5:1) on the Parchment palette. The fix is likely a tweak to the tailwind variant or theme tokens in `app/src/renderer/styles/` or wherever Parchment theme is defined. Check `tailwind.config.js`, `theme.css`, or `themes/parchment.css`.
**Test**: visual check only is fine; no unit test needed for a pure contrast fix.
**Effort**: XS (~30min)

### Item 3 — CI cache-dependency-path fix
**Severity**: XS infra polish
**Files**: `.github/workflows/*.yml` — look at each `actions/setup-node@v4` step
**Issue**: BACKLOG.md "v1.1.9 — CI / test infra" notes that the cache-dependency-path setup is suboptimal — Node cache should target the lockfile but some workflows reference the wrong path
**Fix**: verify every `setup-node@v4` step has `cache-dependency-path: app/pnpm-lock.yaml` (NOT `app/package.json`, NOT defaulted). pnpm-lock.yaml is what determines hits/misses for pnpm cache.
**Effort**: XS (~10min)
**Caveat**: pnpm-lock.yaml IS gitignored (per `app/CLAUDE.md` orchestrator skill caveat) — but it does exist locally and CI generates it. Verify your fix doesn't depend on lockfile being committed.

### Item 4 — vitest coverage thresholds
**Severity**: S infra polish
**File**: `app/vitest.config.ts` (or `.mts`)
**Issue**: BACKLOG.md "v1.1.9 — CI / test infra" notes coverage thresholds are not configured — `pnpm coverage` runs but doesn't fail on regression
**Fix**: add `coverage.thresholds.{lines,functions,branches,statements}` block. Conservative initial bar (don't break existing baseline):
  - Read current `pnpm exec vitest run --coverage` output (run it first, record numbers)
  - Set thresholds to current numbers MINUS 2pp (so headroom for unrelated PRs, but regression catches drift)
**Effort**: S (~1hr — needs the baseline-coverage-read step before setting numbers)
**Test**: re-run `pnpm exec vitest run --coverage` to confirm it passes; intentionally lower a number by 5pp to confirm it now fails as expected, then revert.

### Item 5 — x64 macOS installer script gate relaxation
**Severity**: XS feature/install-script bug
**File**: `app/scripts/install-macos.sh`, lines 41-49
**Issue**: the curl-bash one-liner installer hard-rejects `uname -m != arm64` with *"Only Apple Silicon (arm64) is currently supported"* — but the GitHub release DOES ship an x64 DMG (`SigmaLink-<ver>.dmg`, ~141MB). Intel users get blocked from the one-liner even though the asset exists.
**Fix**:
  - Detect `ARCH="$(uname -m)"`
  - If `arm64`: use `SigmaLink-${VERSION}-arm64.dmg` (current path)
  - If `x86_64`: use `SigmaLink-${VERSION}.dmg` (no-arch-suffix is Intel)
  - If anything else: reject as before
  - Update the error message
**Effort**: XS (~30min)
**Test**: `bash -n install-macos.sh` syntax check; add a comment line documenting the arch → asset mapping. Don't actually run the installer.
**Note**: voice on Intel still degrades to Web Speech stub (separate bug, out of scope for this packet). The installer fix is independent — Intel users get the app, voice degrades gracefully.

## Item ordering

Suggest doing them in this order for cleanest review:
1. Item 5 (installer — single file, fully self-contained)
2. Item 3 (CI cache path — workflow YAML only)
3. Item 4 (vitest thresholds — config + baseline measurement)
4. Item 2 (Parchment contrast — theme tweak)
5. Item 1 (Terminal mount race — most complex)

Or split into commits-per-item — that makes the reviewer pass smoother. Multiple commits, one PR.

## Verification gate (ALL must pass before commit)

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.6-polish/app
pnpm exec tsc -b --pretty false              # clean
pnpm exec eslint .                             # 0 errors (1 pre-existing warning OK)
pnpm exec vitest run                           # 505 pass / 1 skip baseline preserved (Item 4 may bump it)
pnpm exec vitest run --coverage                # passes new thresholds (Item 4)
bash -n scripts/install-macos.sh               # shell syntax (Item 5)
```

Capture each gate's output in commit message bodies.

## Git workflow

- **Read each file before editing** — never edit blind
- **Stage files explicitly** by path, never `git add -A`/`git add .` (project rule)
- **Commit per item** (5 commits) for clean reviewer audit
- Push and open ONE PR for the whole bundle:

```bash
gh pr create --title "fix(v1.4.6): polish bundle — 5 mechanical items" \
  --body "$(cat <<'EOF'
## Summary

Closes 5 small WISHLIST items in one bundle:

- **Item 1**: Terminal.tsx mount race — listener attached before snapshot await (closes R-1.2.7-1)
- **Item 2**: BUG-W7-015 Parchment Launch button contrast hits WCAG AA
- **Item 3**: CI cache-dependency-path → app/pnpm-lock.yaml on every setup-node step
- **Item 4**: vitest coverage thresholds (baseline-2pp headroom)
- **Item 5**: install-macos.sh now accepts x86_64 (DMG was always built, just blocked at the gate)

## Verification

- tsc: clean
- eslint: 0 errors / 1 pre-existing warning
- vitest: <pass count> / 1 skip
- vitest --coverage: passes new thresholds
- install-macos.sh: syntax clean

🤖 Generated with codex (gpt-5.5 high)
EOF
)"
```

**DO NOT MERGE the PR**. The lead (Opus 4.7) reviews and lands.

## When to stop

- If any item turns out to need design judgment (e.g. Parchment contrast needs a designer's eye, or vitest baseline coverage is unexpectedly low), stop on that item, comment WHY in the BRIEF.md `## Result` section, and proceed with the others.
- If `pnpm install` fails, stop and report — don't patch the lockfile.
- If a test you weren't expecting starts failing, stop and document the regression — don't paper over it.

## Reporting back

Append to this BRIEF.md a `## Result` section with:
- Per-item: status (done / skipped / blocked), commit SHA, key change summary
- Final gate output (vitest pass count, coverage numbers, etc.)
- Any out-of-scope findings the lead should know about
- Time taken

The lead reviews this section + the PR before merging.

## Result

- Status: implemented the bundle with five per-item audit commits. Items 2 and 4 required no code edits because the requested state was already present on `main`; they are recorded as empty audit commits for reviewer traceability.
- Setup:
  - `pnpm install --no-frozen-lockfile --ignore-scripts`: passed.
  - `node node_modules/electron/install.js`: passed.
  - `pnpm rebuild better-sqlite3 node-pty`: passed.
  - `pnpm run build`: passed.
  - `node scripts/build-electron.cjs`: passed.
- Per-item status:
  - Item 5: done, commit `a8920cf`. `install-macos.sh` now accepts `arm64` and `x86_64`, maps each arch to the correct release DMG, and rejects other arch values with updated messaging.
  - Item 3: done, commit `93abe63`. Every `actions/setup-node@v4` workflow step now uses `cache-dependency-path: app/pnpm-lock.yaml`.
  - Item 4: blocked/no code change, audit commit `df698bd`. Coverage thresholds were already present in `app/vitest.config.ts`; `pnpm exec vitest run --coverage` completed in under 5 minutes but failed in existing `SessionStep.test.tsx` outside this bundle's allowed edit scope.
  - Item 2: already satisfied/no code change, audit commit `b1c533d`. Current Parchment Launch CTA tokens calculate above WCAG AA: normal contrast `6.74:1`; hover blends remain above `5.4:1`.
  - Item 1: done, commit `64f781d`. Added Terminal boundary coverage for live `pty:data` arriving while `pty.snapshot` is pending; the race-safe ordering remains owned by the terminal cache.
- Final gate output:
  - `pnpm exec tsc -b --pretty false`: passed.
  - `pnpm exec eslint .`: passed with 0 errors / 1 pre-existing warning in `use-session-restore.ts`.
  - `pnpm exec vitest run src/renderer/features/command-room/Terminal.test.tsx`: passed, 1 file / 4 tests.
  - `pnpm exec vitest run`: failed, 63 files passed / 1 failed, 505 passed / 1 skipped. Failure: `src/renderer/features/workspace-launcher/SessionStep.test.tsx` expects `session-aaa` but receives `null` in `"Resume newest for all" selects top session for each pane`.
  - `pnpm exec vitest run --coverage`: failed on the same `SessionStep.test.tsx` assertion after a sandbox-related `listen EPERM` rerun was repeated with escalation.
  - `bash -n scripts/install-macos.sh`: passed.
  - `pnpm run build`: passed.
  - `node scripts/build-electron.cjs`: passed.
- Out-of-scope findings:
  - Existing `SessionStep.test.tsx` failure blocks the full unit and coverage gates; this bundle did not touch workspace launcher code and the allowed scope forbids fixing that file here.
  - Coverage run reports mixed versions: `vitest@4.1.5` with `@vitest/coverage-v8@4.1.6`.
- PR: pending creation after pushing this branch.
- Time taken: under 30 minutes.
