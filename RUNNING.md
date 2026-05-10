# Running SigmaLink locally

> macOS (Apple Silicon) + Node 20–22 recommended. Verified 2026-05-10 on
> macOS 25.4 (Darwin arm64), Electron 30.5.1, pnpm.

## Quickstart (verified 2026-05-10)

From a fresh clone with `pnpm install` already run:

```bash
cd /Users/aisigma/projects/SigmaLink/app
node node_modules/electron/cli.js electron-dist/main.js
```

The window should appear within ~3 seconds. If it doesn't, see Troubleshooting.

## First-time setup

The repository uses `pnpm`. Native modules and the Electron binary need an
extra hand on this codebase because the `npm postinstall` path is broken
on Node 26 + npm 11 (see "Why not just `pnpm exec electron .`" below).

```bash
cd /Users/aisigma/projects/SigmaLink/app

# 1. Install JS deps. Use pnpm; do NOT use `npm install`.
pnpm install --ignore-scripts

# 2. Compile the renderer bundle (Vite) and the Electron main/preload (esbuild).
pnpm run build           # tsc -b && vite build
pnpm run electron:compile # node scripts/build-electron.cjs -> electron-dist/

# 3. Rebuild native modules (better-sqlite3, node-pty) against Electron's ABI.
node node_modules/@electron/rebuild/lib/cli.js -f -w better-sqlite3,node-pty

# 4. Make sure the Electron binary is reachable at node_modules/electron/dist/.
#    On this checkout the flat node_modules/electron/ directory is missing
#    its dist/ and path.txt. The pnpm content-addressed store under
#    node_modules/.pnpm/electron@30.5.1/ has the working binary; symlink it.
ln -s ../.pnpm/electron@30.5.1/node_modules/electron/dist     node_modules/electron/dist
ln -s ../.pnpm/electron@30.5.1/node_modules/electron/path.txt node_modules/electron/path.txt
```

Sanity check the binary resolves:

```bash
node -e "console.log(require('electron'))"
# -> /Users/.../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
```

Then launch:

```bash
node node_modules/electron/cli.js electron-dist/main.js
```

## Troubleshooting

- **`Error: Electron failed to install correctly, please delete node_modules/electron and try installing again`**
  `node_modules/electron/path.txt` and/or `node_modules/electron/dist/` are
  missing. Do NOT delete `node_modules/electron` (the user explicitly
  avoids that path — it triggers a re-install which fails on this Node).
  Recreate the two symlinks from step 4 above.

- **`Cannot find module 'bindings'` from `better-sqlite3/lib/database.js`**
  This is the v1.0.0 DMG bug — that artifact was packaged with
  `--config.npmRebuild=false`, which dropped transitive deps from the
  asar. Run from source (this guide) instead until v1.0.1 ships. If you
  see it from a source launch, run `pnpm install --ignore-scripts` again
  and re-run `@electron/rebuild` from step 3.

- **Window opens then immediately closes**
  Look at the terminal. The main process logs to stdout. Common causes:
  a renderer crash (check for `Error: ...` from Vite-built code), or
  a native-module ABI mismatch (re-run step 3).

- **Native module ABI mismatch (`NODE_MODULE_VERSION ... was compiled against ...`)**
  Re-run step 3 (`@electron/rebuild`). If pnpm changes the Electron
  version pin, re-create the symlinks from step 4 with the new version.

- **Black/white blank window**
  `pnpm run build` was skipped or stale. Re-run `pnpm run build` and
  `pnpm run electron:compile`, then relaunch.

## Why not just `pnpm exec electron .`?

Two reasons:

1. The `pnpm exec electron` wrapper resolves the bin via
   `node_modules/electron/cli.js`, which calls `require('electron')` ->
   `getElectronPath()` in `index.js`. That function reads
   `node_modules/electron/path.txt`. On this checkout that file lives
   only inside the pnpm content-addressed store under
   `node_modules/.pnpm/electron@30.5.1/...`, not at the flat path the
   wrapper expects, so it errors with "Electron failed to install
   correctly". The symlink fix in step 4 makes both `pnpm exec electron`
   and the raw `node node_modules/electron/cli.js ...` form work.

2. Running `npm install` (which `electron`'s postinstall scripts can
   trigger transitively) crashes on Node 26 + npm 11 — a documented
   regression we hit during Phase 3. Always pass `--ignore-scripts` to
   `pnpm install`, and run `@electron/rebuild` and `electron/install.js`
   manually as needed.

## Why not the v1.0.0 DMG?

The published DMG was built with `electron-builder --config.npmRebuild=false`
as a workaround for the npm-install crash above. That flag also disables
copying transitive dependencies into the asar bundle, so packages like
`bindings` and `prebuild-install` (loaded at runtime by `better-sqlite3`)
are missing. The DMG launches and then crashes with
`Cannot find module 'bindings'`. A v1.0.1 hotfix is planned that drives
the rebuild via `@electron/rebuild` directly and packs deps explicitly.

Until then, run from source using this guide.

## Building the dev bundle

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm run build            # renderer (Vite + tsc)
pnpm run electron:compile # main + preload + mcp-memory-server (esbuild)
```

Outputs land in `electron-dist/` (Electron entrypoints) and `dist/`
(renderer assets served from the asar / file:// URL).

For an iterative renderer loop you can use `pnpm run dev` (Vite dev
server) and point Electron at the dev URL — but that requires patching
`main.ts` to load `http://localhost:5173`; the committed entrypoint
loads the built bundle.
