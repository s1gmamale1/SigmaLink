# SigmaLink Desktop App

The Electron + Vite + React workspace inside `app/` is the SigmaLink desktop application. This directory holds everything that ships in the installer: the Electron main and preload sources under `electron/`, the renderer under `src/`, the build helpers under `scripts/`, and the `electron-builder` config in `electron-builder.yml`. The repository-level [README](../README.md) explains what SigmaLink is and where it is going; this README is the operational reference for working in this directory.

## Scripts

The scripts below are defined in [`package.json`](package.json) and are the entry points the project uses for development, packaging, and CI.

| Command | What it does |
|---|---|
| `npm run dev` | Run Vite alone against the renderer. Useful only when you do not need Electron. |
| `npm run build` | `tsc -b` then `vite build` — type-checks the workspace and produces the renderer bundle in `dist/`. |
| `npm run lint` | Run ESLint over the renderer and main process. |
| `npm run preview` | `vite preview` of the last renderer build. |
| `npm run electron:dev` | Full dev loop: builds the renderer, bundles `electron/main.ts` + `electron/preload.ts` via esbuild into `electron-dist/`, then launches Electron. This is the script you run day-to-day. |
| `npm run electron:build` | Production package: build, esbuild bundle, then `electron-builder` produces installers. |
| `npm run electron:compile` | esbuild bundle of `electron/main.ts` + `electron/preload.ts` only. |
| `npm run electron:pack:win` | `electron-builder --win`, after a renderer rebuild. |
| `npm run electron:pack:mac` | `electron-builder --mac`, after a renderer rebuild. |
| `npm run electron:pack:all` | `electron-builder --win --mac`, after a renderer rebuild. |
| `npm run postinstall` | Runs automatically after `npm install`; calls `electron-builder install-app-deps` to rebuild `node-pty` and `better-sqlite3` against the local Electron version. |
| `npm run product:check` | `build` + `electron:compile`. The pre-PR check. |

## Dev workflow

```bash
npm install
npm run electron:dev
```

`npm install` triggers `electron-builder install-app-deps`, which rebuilds the native modules (`node-pty` and `better-sqlite3`) against Electron 30. If a native module fails to load when Electron starts, run `npm install` again from a clean tree.

## Build pipeline

The build is split across three tools:

1. **esbuild** — bundles `electron/main.ts` and `electron/preload.ts` into `electron-dist/`. Driven by `scripts/build-electron.cjs` and exposed via `npm run electron:compile`.
2. **Vite** — builds the renderer (React 19 + Tailwind 3 + shadcn UI + xterm.js) into `dist/`. Driven by `npm run build`.
3. **electron-builder** — consumes both outputs and produces installers. Configuration lives in the `build` block of [`package.json`](package.json) and is targeted at Windows (NSIS + portable) and macOS (DMG + zip).

The `npm run electron:dev` and `npm run electron:build` scripts run these steps in order, so you rarely invoke any of them by hand.

## Source layout

The renderer and main process are organised by feature area, not by layer.

### `src/main/`

- `lib/` — shared utilities used across the main process.
- `core/db/` — Drizzle ORM schema, migrations, and the better-sqlite3 setup.
- `core/pty/` — ring-buffered PTY plumbing built on `node-pty`.
- `core/git/` — worktree pool, commit and merge ops, status and diff helpers.
- `core/providers/` — provider registry, PATH probe, and version detection.
- `core/workspaces/` — workspace factory and launcher presets.

### `src/renderer/`

- `app/` — root `App.tsx`, router, and theme setup.
- `features/` — one folder per room: `workspace-launcher/`, `command-room/`, `swarm-room/`, `review-room/`, `memory/`, `browser/`, `skills/`, `tasks/`, `command-palette/`, `settings/`.
- `lib/` — renderer-side utilities and the typed RPC client.
- `components/ui/` — the shadcn UI starter set (50+ components) seeded under here.
- `hooks/` — shared React hooks.
- `shared/` — types and schemas shared across renderer and main (RPC contracts, providers, swarm protocol, MCP catalog).

## Key dependencies

- `@xterm/xterm` and `@xterm/addon-fit` — terminal renderer.
- `node-pty` — native PTY in the main process.
- `drizzle-orm` and `better-sqlite3` — SQLite persistence layer.
- `esbuild` — bundles the Electron main and preload.
- `react-resizable-panels` — terminal grid layout primitives.
- `@dnd-kit/core` and `@dnd-kit/sortable` — drag-and-drop for the Kanban board and skill drop zone.

## Known limitation

On Windows, agent CLIs that resolve to a `.cmd` shim currently fail to spawn through `node-pty` with `Cannot create process, error code: 2`. The full diagnosis and the planned `resolveForCurrentOS` helper are documented in [`../docs/01-investigation/01-known-bug-windows-pty.md`](../docs/01-investigation/01-known-bug-windows-pty.md). This is the first item on the Phase 1.5 patch list; no new feature work begins until it lands.
