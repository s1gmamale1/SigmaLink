# CI Notes

Continuous integration is configured via two GitHub Actions workflows under
`.github/workflows/`. This file documents the wiring, the required-check
posture, and known toolchain quirks.

## Workflows

### `lint-and-build.yml` — fast PR gate

- **Trigger**: `pull_request` to `main`, `push` to `main`.
- **Runner**: `ubuntu-latest` only (single OS, optimised for speed).
- **Steps**: checkout → pnpm 9 → Node 20.x → `pnpm install --frozen-lockfile
  --ignore-scripts` → `pnpm run lint` → `pnpm run build`.
- **Purpose**: cheap, fast feedback (~2-4 min) on every push and PR. Catches
  ESLint regressions and TypeScript / Vite build errors before the heavier
  Electron matrix runs.

### `e2e-matrix.yml` — cross-platform Electron smoke

- **Trigger**: `pull_request` to `main`, `push` to `main`.
- **Matrix**: `windows-latest`, `macos-14`, `ubuntu-latest` with
  `fail-fast: false` so each platform reports independently.
- **Steps per OS**: checkout → pnpm 9 → Node 20.x → install (skip postinstall)
  → `pnpm rebuild better-sqlite3 node-pty` for the active Node ABI → build
  renderer + electron main → `pnpm exec playwright test` (under `xvfb-run` on
  Linux) → upload artefacts.
- **Artefacts** (per OS, `e2e-<os>`): `app/test-results/`,
  `app/playwright-report/`, `docs/06-test/screenshots/`,
  `docs/06-test/visual-summary.json`, `docs/06-test/console-output.txt`.
- **Concurrency**: keyed on `pull_request.head.sha` so duplicate runs cancel
  on rapid pushes.

## Required check (manual)

GitHub branch-protection settings are not codifiable in the workflow YAML.
Configure them in the repo admin UI:

> Settings → Branches → Branch protection rules → `main` → Require status
> checks to pass before merging.

Required checks for the `main` branch:

| Check | Workflow | Why required |
|---|---|---|
| `lint + build (ubuntu)` | `lint-and-build.yml` | Fast must-pass gate. |
| `smoke (ubuntu-latest)` | `e2e-matrix.yml` | Linux Electron smoke. |
| `smoke (macos-14)` | `e2e-matrix.yml` | macOS Electron smoke. |
| `smoke (windows-latest)` | `e2e-matrix.yml` | Windows Electron smoke. |

Recommended: also enable "Require branches to be up to date before merging"
and "Require conversation resolution before merging".

## Known toolchain quirks

### Node 26 + npm 11 broken — pin Node 20 in CI

GitHub-hosted runners can default to a newer Node major. We explicitly pin
`actions/setup-node` to `20.x`. Do not bump to Node 26 until upstream npm 11 +
node-gyp + electron-rebuild interplay is fixed. Symptoms of the bad combo:

- `npm install` fails with `EACCES` or `unsupported lockfile version` on
  postinstall scripts that shell out to `electron-builder install-app-deps`.
- `electron-rebuild` segfaults or links against the wrong `NODE_MODULE_VERSION`.

**Workaround used in both workflows**: install with
`pnpm install --frozen-lockfile --ignore-scripts`, then run
`pnpm rebuild better-sqlite3 node-pty` explicitly against Node 20's ABI. This
sidesteps `electron-builder install-app-deps` entirely and keeps the native
modules pinned to the runtime that actually executes the smoke test.

### Linux needs xvfb for Electron

`ubuntu-latest` images are headless. The matrix wraps the Playwright command
in `xvfb-run --auto-servernum --server-args="-screen 0 1440x900x24"` so the
Electron window can render. The runner also installs the GTK/NSS/ALSA
runtime libs (`libnss3`, `libatk-bridge2.0-0`, `libdrm2`, `libgbm1`,
`libasound2`/`libasound2t64`) needed by Electron 30.

### Playwright `_electron` does not need a Chromium download

The smoke spec uses `_electron.launch(...)` against the locally-built
`electron-dist/main.js`. We do **not** run `playwright install chromium`; the
local Electron binary that `pnpm install` already pulled is enough. This
keeps the matrix under five minutes per OS in the steady state.

### pnpm version

Both workflows pin `pnpm/action-setup@v4` with `version: 9` to match the
lockfile (`lockfileVersion: '9.0'`). If the local toolchain bumps to
pnpm 10/11, bump the workflow `version:` field in lock-step.

## Touching CI

Any change to `.github/workflows/*.yml` should be reviewed by a CODEOWNER.
The matrix is intentionally lightweight (~5-8 min per OS) — keep it that
way. Heavier coverage (full Wave-7-style 37-screenshot sweep, perf bench,
release packaging) belongs in a nightly workflow, not the PR gate.
