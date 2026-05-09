# SigmaLink

Local-first desktop workspace for orchestrating grids of CLI coding agents in real PTYs, isolated by Git worktrees.

SigmaLink is an Electron desktop application that lets a single human operator run several coding-agent CLIs (BridgeCode, Claude Code, Codex, Gemini, Cursor, OpenCode, plus the custom shell entry, with Aider and Continue available as legacy toggles) in parallel against the same Git repository. Each agent runs in a real PTY-backed terminal pane and is checked out into its own Git worktree, so concurrent edits cannot collide on disk. A SQLite database holds workspaces, sessions, swarm rosters, tasks, conversations, and notes; nothing is sent to a remote service.

The project is in active rebuild. Phases 1–8 (foundation, swarms, in-app browser, Skills, SigmaMemory, Review/Tasks, UI polish, visual-test loop) are shipped. Phase 9 (V3 parity, waves 12–16) is in progress: bundled credential storage via Electron `safeStorage`, a Bridge Assistant room (W13), the Bridge Canvas visual-design surface (W14), and final hardening land before v0.2.0. Track the swarm in [`docs/ORCHESTRATION_LOG.md`](docs/ORCHESTRATION_LOG.md).

[![lint-and-build](https://github.com/s1gmamale1/SigmaLink/actions/workflows/lint-and-build.yml/badge.svg?branch=main)](https://github.com/s1gmamale1/SigmaLink/actions/workflows/lint-and-build.yml)
[![e2e-matrix](https://github.com/s1gmamale1/SigmaLink/actions/workflows/e2e-matrix.yml/badge.svg?branch=main)](https://github.com/s1gmamale1/SigmaLink/actions/workflows/e2e-matrix.yml)

![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-30-2B2E3A?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square)
![Status](https://img.shields.io/badge/status-WIP-orange?style=flat-square)

## Why SigmaLink

- Parallel CLI agent grids of up to sixteen panes per workspace, with per-pane provider selection, persistent ring-buffered terminal history, and layout presets (mosaic, columns, focus).
- Per-pane Git worktree isolation under a `sigmalink/<role>/<task>-<8char>` branch namespace, so two agents editing the same repo cannot stomp on each other.
- Role-bearing swarms (Coordinator, Builder, Scout, Reviewer) coordinated through a deterministic JSONL file-mailbox bus and persisted in SQLite, with broadcast and roll-call patterns built in.
- An in-app Chromium pane (planned, Phase 3) that any agent can drive through Playwright MCP over CDP, so agents can navigate, take screenshots, and click without a separate browser context.
- Drag-and-drop Anthropic-format Skills (planned, Phase 4) that fan out to each provider's native skills/extensions location after Zod validation.
- Local SigmaMemory (planned, Phase 5): a wikilink-driven notes system backed by an in-process MCP server with twelve tools and a force-directed graph view, modelled on the BridgeMemory pattern.

## Workspace types

A workspace is a saved binding of a folder, optional repo root, base branch, and the rooms / sessions opened against it. The type is fixed at creation. Detail in [`docs/03-plan/PRODUCT_SPEC.md`](docs/03-plan/PRODUCT_SPEC.md).

| Type | Purpose | Status |
|---|---|---|
| Bridge Space | Single-workspace agent grid: parallel but independent CLI agents over the same repo (1..16 panes). | Phase 1 (shipped) |
| Bridge Swarm | Role-bearing coordinated swarm with a file-mailbox bus, side chat, broadcast, and roll-call. | Phase 2 (shipped) |
| Bridge Canvas | Visual design surface: pick an element in the embedded browser, dispatch a scoped prompt, drag assets onto a selection. | In V3 build (Wave 14) |

## Supported agents

Nine providers ship in the V3 default registry: BridgeCode (coming soon, currently falls back to Claude Code at spawn time), Claude Code, Codex CLI, Gemini CLI, Cursor Agent, OpenCode, the plain Shell entry, plus Aider and Continue as legacy toggles (hidden until `kv['providers.showLegacy'] = '1'`). Kimi is a model rather than a standalone CLI, so it is selected per-provider rather than being its own row. Any other CLI on `PATH` is auto-detected and surfaces in the picker. Source: [`docs/03-plan/PRODUCT_SPEC.md`](docs/03-plan/PRODUCT_SPEC.md) section 4 and `app/src/shared/providers.ts`.

| Provider | Command | Install hint | Visibility |
|---|---|---|---|
| BridgeCode | `bridgecode` | Coming soon — BridgeMind hosted CLI | V3 default (renders disabled, falls back to Claude) |
| Claude Code | `claude` | `npm i -g @anthropic-ai/claude-code` | V3 default |
| Codex CLI | `codex` | `npm i -g @openai/codex` | V3 default |
| Gemini CLI | `gemini` | `npm i -g @google/gemini-cli` | V3 default |
| Cursor Agent | `cursor-agent` | install via Cursor app | V3 default |
| OpenCode | `opencode` | `npm i -g opencode` | V3 default |
| Shell | operator-supplied | Built-in | Always available |
| Aider | `aider` | `pipx install aider-chat` | Legacy toggle |
| Continue | `continue` | `npm i -g @continuedev/cli` | Legacy toggle |

## Quickstart

Prerequisites: Node.js 20 or newer, Git, npm, and at least one CLI agent installed on `PATH`.

```bash
git clone https://github.com/s1gmamale1/SigmaLink.git
cd SigmaLink/app
npm install
npm run electron:dev
```

Once the app is running:

1. Pick a folder (a Git repo is recommended; non-repo folders fall back to direct-folder mode).
2. Choose a grid preset (1, 2, 4, 6, 8, 10, 12, 14, or 16 panes).
3. Assign a provider per pane.
4. Click **Launch**.

The Command Room opens with one PTY per pane, each in its own worktree branch.

## Requirements

- Node.js 20 or newer.
- Git (with `user.name` and `user.email` configured for commit / merge actions).
- At least one CLI agent on `PATH`. The launcher greys out providers it cannot resolve.

Windows users: `node-pty` is rebuilt against the local Electron version on `npm install`. The known `.cmd` shim issue is tracked in [`docs/01-investigation/01-known-bug-windows-pty.md`](docs/01-investigation/01-known-bug-windows-pty.md) and is the first item on the Phase 1.5 patch list.

## Project structure

```
SigmaLink/
├── app/                       Electron + Vite + React product
│   ├── electron/              main + preload sources (esbuild output in electron-dist/)
│   ├── src/                   renderer (Vite + React 19 + Tailwind 3 + shadcn UI)
│   ├── scripts/               build helpers (build-electron.cjs)
│   ├── package.json
│   └── electron-builder.yml
├── docs/
│   ├── ORCHESTRATION_LOG.md   master log of every wave
│   ├── 01-investigation/      bug audit, architecture notes, test plan
│   ├── 02-research/           public-source research synthesis
│   ├── 03-plan/               PRODUCT_SPEC, BUILD_BLUEPRINT, UI_SPEC
│   ├── 04-critique/           architecture / UX / engineering-risk critiques
│   ├── 05-build/              per-feature build agent outputs
│   ├── 06-test/               visual test reports + screenshots
│   └── 07-bugs/               open + deferred bugs
├── REBUILD_PLAN.md            historical Phase-1 plan (superseded)
├── ATTRIBUTIONS.md
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE
```

## Current status

Each phase tracks a section of the build blueprint at [`docs/03-plan/BUILD_BLUEPRINT.md`](docs/03-plan/BUILD_BLUEPRINT.md).

| Phase | Scope | State |
|---|---|---|
| [Phase 1](docs/03-plan/BUILD_BLUEPRINT.md) | Foundation: PTY, Git worktrees, providers, SQLite, launcher, command room | Shipped |
| [Phase 1.5](docs/03-plan/BUILD_BLUEPRINT.md#phase-15--foundation-patches-apply-before-any-new-feature-work) | Foundation patches (Windows PTY shim, IPC allowlist, P0/P1 fixes) | Shipped |
| [Phase 2](docs/03-plan/BUILD_BLUEPRINT.md#phase-2--swarm-room--mailbox-bus) | Swarm Room, mailbox bus, roll-call, broadcast | Shipped |
| [Phase 3](docs/03-plan/BUILD_BLUEPRINT.md#phase-3--in-app-browser--playwright-mcp-supervisor) | In-app browser, Playwright MCP supervisor over CDP | Shipped |
| [Phase 4](docs/03-plan/BUILD_BLUEPRINT.md#phase-4--skills-drag-and-drop--per-provider-fan-out) | Skills drag-and-drop, per-provider fan-out | Shipped |
| [Phase 5](docs/03-plan/BUILD_BLUEPRINT.md#phase-5--sigmamemory-mcp-server--notes-ui--graph-view) | SigmaMemory MCP server, notes UI, graph view | Shipped |
| [Phase 6](docs/03-plan/BUILD_BLUEPRINT.md#phase-6--review-room-rebuild--taskskanban) | Review Room rebuild, Tasks / Kanban | Shipped |
| [Phase 7](docs/03-plan/BUILD_BLUEPRINT.md#phase-7--ui-polish-theme-catalog-command-palette-layout-refinements-animations) | UI polish: theme catalog, command palette, animations | Shipped |
| [Phase 8](docs/03-plan/BUILD_BLUEPRINT.md#phase-8--visual-test--bug-fix-loops) | Visual test, bug-fix loops, acceptance | Shipped (Wave 7 + Wave 8 + Wave 9 acceptance) |
| [Phase 9](docs/03-plan/BUILD_BLUEPRINT.md) | V3 parity — credential safeStorage, bundled `@playwright/mcp`, Bridge Assistant room, Bridge Canvas, hardening | In progress (Waves 12–16) |

Now shipping 9 of 11 V3 rooms (Workspaces, Command Room, Swarm Room, Browser, Skills, SigmaMemory, Review, Tasks, Settings). Bridge Assistant lands in Wave 13 and Bridge Canvas in Wave 14.

Last verified: 2026-05-10.

## What works today

A short menu of flows you can confidently demo on a fresh checkout:

- Open a Git workspace from the Workspace launcher and have it persist + activate in one click.
- Launch shell agents in a 4-pane mosaic Command Room with real PTY-backed terminals, each in its own Git worktree branch.
- Create a coordinated swarm (Squad/Team/Platoon/Legion preset), broadcast a mission, run a roll-call, and watch the SIGMA:: protocol appear in the side chat.
- Drop a folder containing a `SKILL.md` onto the Skills Room, then toggle per-provider fan-out for Claude / Codex / Gemini.
- Write a `[[wikilink]]` memory note, see the backlinks panel update, and explore the force-directed graph view.
- Switch among four themes (Obsidian, Parchment, Nord, Synthwave) and use the Cmd/Ctrl+K command palette to navigate, kill PTYs, ingest skills, or open recent workspaces.

## Architecture at a glance

```
+---------------------------------------------------------------+
| Renderer (React 19, Tailwind 3, shadcn UI, xterm.js)          |
|   rooms (9 shipped): workspaces / command / swarm / review /  |
|          memory / browser / skills / tasks / settings         |
|   rooms (V3 build): bridge-assistant (W13) / bridge-canvas    |
|          (W14)                                                |
+---------------------------------------------------------------+
                     |   typed RPC + event bridge (Proxy)
+---------------------------------------------------------------+
| Preload (single generic invoke + per-channel allowlist)       |
+---------------------------------------------------------------+
                     |   ipcMain
+---------------------------------------------------------------+
| Main process (Electron 30)                                    |
|   core/pty   core/git   core/providers   core/swarm  core/db  |
|   core/skills (planned)  core/browser (planned)               |
|   core/memory (planned)  core/mcp (planned)                   |
+---------------------------------------------------------------+
                     |   on-disk
+---------------------------------------------------------------+
| SQLite (Drizzle ORM) | Git worktrees | JSONL mailboxes |      |
| .sigmamemory/ notes  | per-workspace browser session profile  |
+---------------------------------------------------------------+
```

A more detailed walk-through lives in [`docs/01-investigation/03-architecture-notes.md`](docs/01-investigation/03-architecture-notes.md).

## Roadmap

The full phased plan is in [`docs/03-plan/BUILD_BLUEPRINT.md`](docs/03-plan/BUILD_BLUEPRINT.md). Critiques that shaped it are in [`docs/04-critique/`](docs/04-critique/). Open bugs are tracked in [`docs/07-bugs/OPEN.md`](docs/07-bugs/OPEN.md); deferred bugs in [`docs/07-bugs/DEFERRED.md`](docs/07-bugs/DEFERRED.md).

## Documentation index

Start at [`docs/README.md`](docs/README.md) for the full directory map. The intended reading order is:

1. [`docs/ORCHESTRATION_LOG.md`](docs/ORCHESTRATION_LOG.md) — what the swarm is doing and why.
2. [`docs/03-plan/PRODUCT_SPEC.md`](docs/03-plan/PRODUCT_SPEC.md) — canonical product spec.
3. [`docs/03-plan/BUILD_BLUEPRINT.md`](docs/03-plan/BUILD_BLUEPRINT.md) — phased implementation plan.
4. [`docs/04-critique/`](docs/04-critique/) — architecture, UX, engineering-risk critiques.

## Contributing

Pull requests are welcome but expect heavy churn until Wave 7 acceptance lands. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR; bug reports and feature requests use the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/).

## Security

SigmaLink runs untrusted CLI agents inside PTYs against your local repositories. Each agent has full filesystem access within its worktree, and the planned in-app browser will give agents network egress. Treat this like running anything else with `--dangerously-skip-permissions` enabled. Vulnerability reports go through a private security advisory: see [`SECURITY.md`](SECURITY.md).

## Acknowledgements

- Inspired by BridgeMind's BridgeSpace and BridgeSwarm products. SigmaLink is an independent project; we are not affiliated with, endorsed by, or sponsored by BridgeMind.
- PTY ring-buffer plumbing, generic RPC bridge, and several Git-orchestration patterns are drawn from [Emdash](https://github.com/generalaction/emdash) (Apache-2.0). See [`ATTRIBUTIONS.md`](ATTRIBUTIONS.md).
- Skill format follows the public Anthropic Skills layout (SKILL.md frontmatter + body).
- UI components use [shadcn UI](https://ui.shadcn.com/), [Radix UI](https://www.radix-ui.com/), [lucide-react](https://lucide.dev/), and [xterm.js](https://xtermjs.org/). Database access uses [Drizzle ORM](https://orm.drizzle.team/) on top of [better-sqlite3](https://github.com/WiseLibs/better-sqlite3). PTY support comes from [node-pty](https://github.com/microsoft/node-pty). The in-app browser drives Chromium through the bundled [@playwright/mcp](https://github.com/microsoft/playwright-mcp) supervisor.

## License

MIT. See [`LICENSE`](LICENSE).
