# v1.4.6 — x64 macOS voice fix

## Mission

Ship a working Speech.framework native voice binary in the x64 macOS DMG. Today the Intel DMG silently degrades to Web Speech API stub because the .node binary inside it was built for arm64 by the macos-14 release runner.

## Working environment

- Working dir (absolute): `/Users/aisigma/projects/SigmaLink-feat-v1.4.6-x64-voice`
- Branch (already on): `feat/v1.4.6-x64-voice`
- Main branch (reference only): `main` at `f12c656`
- Stay inside this worktree.

## Root-cause (verified 2026-05-18)

- `app/electron-builder.yml` line 30: `npmRebuild: true`
- `release-macos.yml` runs on `macos-14` (arm64 only)
- During DMG packaging, `npmRebuild: true` triggers `npm rebuild` → `node-gyp-build` → falls through to `node-gyp rebuild` (no prebuilds committed)
- Result: only an arm64 `sigmavoice_mac.node` is produced
- That binary gets packaged into BOTH the arm64 DMG AND the x64 DMG
- On Intel Mac startup, `voice-mac/index.js` catches the arch-mismatch dlopen error and returns the no-op stub → renderer falls through to Web Speech API
- Independent ADR-002 state-audit context: the prebuild workflow that was SUPPOSED to fix this (`.github/workflows/native-prebuild-mac.yml`) has never succeeded in 25 runs and was disabled on push triggers in commit `f12c656` 2026-05-18

## Fix approach (Option 1 from state audit § Recommended next moves)

Fold cross-arch rebuild directly into `release-macos.yml`. After `pnpm rebuild better-sqlite3 node-pty`, add a step that explicitly builds voice-mac for BOTH arches and stages them so `npmRebuild: true` (running later inside electron-builder) picks the right one per DMG.

The cleanest implementation:

1. **Disable the implicit voice-mac rebuild** inside `npmRebuild: true` (since electron-builder doesn't know about arch matrices).
2. **Add an explicit "Prebuild voice-mac for both arches" step** in `release-macos.yml` that:
   - cd into `app/native/voice-mac`
   - run `npx prebuildify --napi --strip --arch=arm64`
   - run `npx prebuildify --napi --strip --arch=x64`
   - confirms both `prebuilds/darwin-arm64/node.napi.node` AND `prebuilds/darwin-x64/node.napi.node` exist
3. **Verify electron-builder picks them up**. With both prebuilds present, `node-gyp-build` will resolve the matching arch at runtime without rebuilding. electron-builder's packing should include the entire `prebuilds/` directory because `voice-mac/package.json` has `files: [..., "prebuilds", ...]`.

Cross-compile feasibility on macos-14: Xcode supports both `arm64` and `x86_64` target archs out of the box. `node-gyp` accepts `--arch=x64` and produces a Mach-O for that arch.

## Alternative — Option 2 reference

If for any reason explicit prebuildify in the release workflow fails (e.g. node-gyp can't cross-compile a specific symbol from `recognizer.mm`), fall back to spawning a separate `macos-13` runner job inside the same workflow that only builds x64, uploads the .node artefact, and the macos-14 job downloads it before electron-builder runs. macos-13 runner availability is poor (root cause of the broken prebuild workflow) so prefer Option 1 — but document the failure mode in BRIEF.md `## Result` if you have to switch.

## Files to touch

| File | Why |
|---|---|
| `.github/workflows/release-macos.yml` | Add the explicit prebuildify-both-arches step before electron-builder runs |
| `app/native/voice-mac/package.json` | Verify `files: ["prebuilds"]` already there (line ~10); if not, add it |
| `app/electron-builder.yml` | Probably no change. The `files:` glob already packages everything in `app/`; double-check that `app/native/voice-mac/prebuilds/**` is reachable via the existing `files:` patterns or via electron-builder's auto-detection of native modules |
| `.gitignore` | Verify `app/native/voice-mac/prebuilds/` is NOT gitignored — these need to be CI-generated, not committed, but also not excluded from electron-builder's packaging |

## Setup

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.6-x64-voice/app
pnpm install --no-frozen-lockfile
node node_modules/electron/install.js
```

## Local verification (before pushing)

Cross-compile must work locally on this arm64 dev machine:

```bash
cd app/native/voice-mac
# arm64 first (matches the runner this is on)
npx prebuildify --napi --strip --arch=arm64
ls -la prebuilds/darwin-arm64/
file prebuilds/darwin-arm64/node.napi.node | grep -q "arm64"
# then x64 cross-compile
npx prebuildify --napi --strip --arch=x64
ls -la prebuilds/darwin-x64/
file prebuilds/darwin-x64/node.napi.node | grep -q "x86_64"
```

Both should produce `node.napi.node` files of the correct arch. If x64 fails to compile, that's the genuine blocker — document it in `## Result`.

Then verify the loader picks them correctly:

```bash
cd app/native/voice-mac
node -e "const m = require('./'); console.log('isAvailable:', m.isAvailable())"
# On arm64 dev machine: should print `isAvailable: true` (assuming Speech.framework permissions OK)
```

## Verification gate (must ALL pass before commit)

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.6-x64-voice/app
pnpm exec tsc -b --pretty false              # clean
pnpm exec eslint .                             # 0 errors / 1 pre-existing warning OK
pnpm exec vitest run                           # 505 pass / 1 skip baseline preserved
# Voice-specific unit tests (if any):
pnpm exec vitest run --grep voice              # if such suite exists; otherwise skip
```

The actual cross-arch DMG verification happens in CI on the next tag. Add a brief comment to `release-macos.yml` step describing what to look for in `dist/mac-x64/*.app/Contents/Resources/app.asar.unpacked/native/voice-mac/prebuilds/`.

## Git workflow

- **Read every file before editing** (project rule)
- Stage explicitly by path, no `git add -A`
- One commit (this is a small focused change). Format:
  ```
  fix(v1.4.6): ship working Speech.framework voice in x64 macOS DMG

  Previously the macos-14 release runner built only an arm64 sigmavoice_mac.node
  binary via electron-builder's npmRebuild:true. That binary was packaged into
  both DMGs; on Intel Macs the dlopen failed and voice-mac/index.js fell through
  to the no-op stub → renderer used Web Speech API instead of native.

  Fix: explicit `npx prebuildify --arch={arm64,x64}` step in release-macos.yml
  before electron-builder runs. Both prebuilds are present at pack time, so
  node-gyp-build resolves the right binary per arch at runtime.

  Cross-compile verified locally: file prebuilds/darwin-x64/node.napi.node
  reports "Mach-O 64-bit dynamically linked shared library x86_64".

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
  ```
- Push, open ONE PR against `main`:
  ```bash
  gh pr create --title "fix(v1.4.6): x64 macOS voice — cross-arch prebuild step in release-macos" \
    --body "$(cat <<'EOF'
  ## Summary

  Closes the x64-mac-voice-degraded issue discovered in the v1.4.5 state audit.
  Today Intel-mac users silently fall through to Web Speech API; this PR makes
  the next release ship a real x86_64 Speech.framework binary inside the Intel DMG.

  ## Approach

  Explicit `prebuildify --arch=arm64` + `--arch=x64` step in release-macos.yml.
  electron-builder picks the matching arch via node-gyp-build at pack time.

  ## Verification

  - tsc / vitest / eslint: clean (local)
  - Cross-compile local: both prebuilds produced, file(1) confirms arches
  - CI cross-arch verification: lands on the next v1.4.6 tag push

  Refs the v1.4.5 state-audit Option 1 recommendation.

  🤖 Generated with Sonnet 4.6
  EOF
  )"
  ```
- **DO NOT MERGE the PR**. The lead does the reviewer pass + merge.

## When to stop

- If `prebuildify --arch=x64` fails on this arm64 dev machine due to a genuine cross-compile incompatibility (e.g. a header that only exists on x86_64 builds, or a Sequoia SDK problem), stop and switch to Option 2 (macos-13 runner side-job). Document the cross-compile failure mode in `## Result`.
- If electron-builder's `files:` glob doesn't pack the `prebuilds/` directory, that's a packaging fix (add an explicit pattern). Document and fix.
- If `pnpm install` fails, stop and report.

## Reporting back

Append to this BRIEF.md a `## Result` section with:
- File diffs summary (release-macos.yml + any package.json/builder.yml changes)
- Local cross-compile evidence (file(1) output for both arches)
- Verification gate output
- Time taken
- Any out-of-scope findings

The lead reviews this section + the PR before the next reviewer pass.

## Result

### Files changed

**`.github/workflows/release-macos.yml`** — added "Prebuild voice-mac for both arches" step between "Rebuild native modules for Electron" and "Build renderer + electron". The step:
- `cd`s into `native/voice-mac` (relative to the job's `working-directory: app`)
- runs `npm install --ignore-scripts` to pull prebuildify + node-gyp-build locally
- runs `npx prebuildify --napi --strip --arch=arm64`
- runs `npx prebuildify --napi --strip --arch=x64`
- asserts both `.node` files exist with correct arch via `file(1) | grep -q`

**`app/electron-builder.yml`** — added four explicit `files:` patterns so electron-builder includes voice-mac at pack time:
```
- native/voice-mac/index.js
- native/voice-mac/index.d.ts
- native/voice-mac/prebuilds/**/*
- native/voice-mac/node_modules/node-gyp-build/**/*
```
`native/` was not previously in the `files:` list. The bundled `electron-dist/main.js` resolves `../native/voice-mac/index.js` at runtime; that relative path requires `native/voice-mac/` to be present alongside `electron-dist/` inside the packaged app. `node-gyp-build` (voice-mac's runtime loader) must also be present since it is not in the app's own node_modules.

**`app/native/voice-mac/package.json`** — no change needed; `"prebuilds"` was already in the `files:` array (line 13).

**`.gitignore`** — no change; `app/native/voice-mac/.gitignore` already has `!prebuilds/**/*.node` which allows the prebuilds to be committed but our approach keeps them CI-generated (not committed to the repo).

### Cross-compile evidence (arm64 dev machine, Node v26.0.0)

```
prebuilds/darwin-arm64/@sigmalink+voice-mac.node: Mach-O 64-bit bundle arm64
prebuilds/darwin-x64/@sigmalink+voice-mac.node:   Mach-O 64-bit bundle x86_64
```

File sizes:
- `darwin-arm64/@sigmalink+voice-mac.node`  128,080 bytes
- `darwin-x64/@sigmalink+voice-mac.node`     67,624 bytes

Loader smoke test (arm64 host):
```
isAvailable: true
```

### Verification gate

- `pnpm exec tsc -b --pretty false` — clean (no output)
- `pnpm exec eslint .` — 0 errors, 1 pre-existing warning (react-hooks/exhaustive-deps in use-session-restore.ts)
- `pnpm exec vitest run` — 505 passed / 1 skipped (baseline preserved)
- `pnpm exec vitest run --grep voice` — N/A (flag not supported by vitest v4.1.5; voice tests ran as part of full suite: 5 VoiceTab tests passed)

### Out-of-scope findings

1. **prebuild filename**: `prebuildify` names the output `@sigmalink+voice-mac.node` (scoped-package convention), not `node.napi.node` as the old `native-prebuild-mac.yml` expected. The `node-gyp-build` loader supports both naming conventions; no code change needed.

2. **`native-prebuild-mac.yml` expected path mismatch**: The old workflow uploaded `prebuilds/darwin-$arch/node.napi.node` but the actual file is `prebuilds/darwin-$arch/@sigmalink+voice-mac.node`. This upload step would have always failed with `if-no-files-found: error` — likely contributing to the 25 failed runs. This workflow remains disabled (no tag trigger) and is out of scope for this PR.

3. **`node_modules/` cleanup**: `npm install --ignore-scripts` in the new CI step will create `app/native/voice-mac/node_modules/`. This directory is gitignored (voice-mac `.gitignore` excludes `node_modules/`) and is only needed during the CI build step, not committed.

### Time taken

~25 minutes (setup + cross-compile test + verification gate + documentation).
