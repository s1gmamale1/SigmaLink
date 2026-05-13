# SigmaLink

Local-first desktop workspace for orchestrating grids of CLI coding agents in real PTYs, isolated by Git worktrees.

[![Latest release](https://img.shields.io/github/v/release/s1gmamale1/SigmaLink?style=flat-square&color=2B2E3A&label=release)](https://github.com/s1gmamale1/SigmaLink/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/s1gmamale1/SigmaLink/total?style=flat-square&color=2B2E3A)](https://github.com/s1gmamale1/SigmaLink/releases)
[![lint-and-build](https://github.com/s1gmamale1/SigmaLink/actions/workflows/lint-and-build.yml/badge.svg?branch=main)](https://github.com/s1gmamale1/SigmaLink/actions/workflows/lint-and-build.yml)
[![e2e-matrix](https://github.com/s1gmamale1/SigmaLink/actions/workflows/e2e-matrix.yml/badge.svg?branch=main)](https://github.com/s1gmamale1/SigmaLink/actions/workflows/e2e-matrix.yml)

![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![Platform](https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Windows%20x64-lightgrey?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-30-2B2E3A?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square)
![Status](https://img.shields.io/badge/status-WIP-orange?style=flat-square)

## Supported platforms

| Platform | Installer | One-line install | First-launch friction | Native bridges |
|---|---|---|---|---|
| macOS 13+ (Apple Silicon arm64) | DMG | `curl … install-macos.sh` | None via curl-bash (Gatekeeper bypass) | SigmaVoice native Speech.framework |
| Windows 10/11 (x64) | NSIS EXE | `iex (irm … install-windows.ps1)` | SmartScreen warning on first run (workarounds documented) | Web Speech API (Chromium, requires internet) |

> Linux (AppImage + .deb) is built from the same `electron-builder.yml` but is not test-gated and not on the supported platform list yet — tracked in [`docs/08-bugs/BACKLOG.md`](docs/08-bugs/BACKLOG.md) (v1.3+).
> Windows x86 (ia32) was dropped in v1.2.0; the installer is x64-only.

## Install in one line (macOS, Apple Silicon)

```bash
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash
```

That downloads the latest release, installs `SigmaLink.app` into `/Applications`, and launches it — with **zero macOS Gatekeeper prompts**. `curl` doesn't tag downloads with `com.apple.quarantine`, so the bundle is exempt from Gatekeeper's first-launch check. Same pattern as the Rust, Homebrew, and Docker installers.

To pin a specific release tag:
```bash
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash -s v1.1.7
```

## Windows (10/11, x64)

```powershell
iex (irm https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-windows.ps1)
```

Or download the EXE directly from [Releases](https://github.com/s1gmamale1/SigmaLink/releases/latest).

### Windows: first launch

SigmaLink ships unsigned on Windows (no EV/OV Authenticode cert — deferred indefinitely; see [`docs/04-design/windows-port.md`](docs/04-design/windows-port.md)). The PowerShell installer above runs `Unblock-File` on the downloaded EXE to strip the Mark-of-the-Web tag, so the most common SmartScreen path is already avoided. If you download the EXE manually from the Releases page, SmartScreen may still surface a blue "Windows protected your PC" dialog on first launch. The full workaround set (Option A: **More info → Run anyway**; Option B: right-click EXE → **Properties → Unblock → OK**) is documented inside the installer itself — `README — First launch.txt` is shown by NSIS before the install completes.

**Other install paths** are documented below: [manual DMG download](#install-options) (3 options including Terminal + System Settings workarounds) and [build from source](#quickstart-build-from-source).

---

## What it is

SigmaLink is an Electron desktop application that lets a single human operator run several coding-agent CLIs (Claude Code, Codex CLI, Gemini CLI, Kimi Code CLI, OpenCode CLI, plus a custom-command escape hatch) in parallel against the same Git repository. Each agent runs in a real PTY-backed terminal pane and is checked out into its own Git worktree, so concurrent edits cannot collide on disk. A SQLite database holds workspaces, sessions, swarm rosters, tasks, conversations, and notes; nothing is sent to a remote service.

The project is in active rebuild. Phases 1–8 (foundation, swarms, in-app browser, Skills, SigmaMemory, Review/Tasks, UI polish, visual-test loop) are shipped. Phase 9 (V3 parity, waves 12–16) is in progress: bundled credential storage via Electron `safeStorage`, a Sigma Assistant room (W13), the Sigma Canvas visual-design surface (W14), and final hardening land before v0.2.0. Track the swarm in [`docs/10-memory/ORCHESTRATION_LOG.md`](docs/10-memory/ORCHESTRATION_LOG.md).

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

Five providers ship in the v1.2.4 default registry: Claude Code, Codex CLI, Gemini CLI, Kimi Code CLI, and OpenCode CLI. A "Custom Command" row in the workspace-launcher wizard opens a plain interactive shell for ad-hoc binaries. Source: [`docs/03-plan/PRODUCT_SPEC.md`](docs/03-plan/PRODUCT_SPEC.md) section 4 and `app/src/shared/providers.ts`.

| Provider | Command | Install hint |
|---|---|---|
| Claude Code | `claude` | `npm i -g @anthropic-ai/claude-code` |
| Codex CLI | `codex` | `npm i -g @openai/codex` |
| Gemini CLI | `gemini` | `npm i -g @google/gemini-cli` |
| Kimi Code CLI | `kimi` | See moonshot.ai for install instructions (upstream npm package name pending) |
| OpenCode CLI | `opencode` | `npm i -g opencode` |

> Earlier registries shipped BridgeCode, Cursor Agent, Aider, Continue, and a "Shell" provider row. v1.2.4 trimmed them: BridgeCode never materialised, Cursor's CLI fell out of scope, Aider/Continue moved off SigmaLink's support matrix, and "Shell" is now an internal-only sentinel that powers the launcher's "Skip — no agents" path without surfacing as a user-facing button.

## Install options

Three install paths are supported on macOS Apple Silicon. The first is recommended for most users.

### Option 1 — Curl-bash installer (zero prompts) — RECOMMENDED

```bash
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash
```

What the script does, in order:
1. Detects platform + arch (refuses non-arm64 macOS for now).
2. Fetches the latest release tag via the GitHub API (60 req/hour anonymous quota; pass an explicit tag to skip).
3. Downloads the matching `SigmaLink-<version>-arm64.dmg` via `curl` (no quarantine flag).
4. Quits any running SigmaLink, removes the old `/Applications/SigmaLink.app`.
5. Mounts the DMG, copies `SigmaLink.app` into `/Applications/`, strips any xattrs defensively.
6. Unmounts the DMG and (if you're on a tty) prompts to launch.

To inspect the script before running it:
```bash
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh -o install-sigmalink.sh
less install-sigmalink.sh
bash install-sigmalink.sh
```

To pin a specific release tag:
```bash
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash -s v1.1.7
```

### Option 2 — Manual DMG download

Browse https://github.com/s1gmamale1/SigmaLink/releases and download `SigmaLink-<version>-arm64.dmg`. On macOS Sequoia/Tahoe Apple's Gatekeeper will block the first launch with one of two dialogs:

| Dialog | Cause | Recovery |
|---|---|---|
| **"is damaged and can't be opened"** | DMG built before v1.1.5 (missing CodeResources seal) | Upgrade to v1.1.5+. For old DMGs, `xattr -cr /Applications/SigmaLink.app` |
| **"Apple could not verify..."** | Un-notarised app (no Apple Developer ID) | See workarounds below |

Two recoverable workarounds — pick whichever:

**A) Terminal one-liner (fastest):**
```bash
xattr -cr /Applications/SigmaLink.app && open /Applications/SigmaLink.app
```

**B) System Settings (no Terminal):**
1. Click **Done** on the warning dialog (NOT "Move to Trash").
2. Open **System Settings → Privacy & Security**.
3. Scroll down to the **Security** section.
4. Click **Open Anyway** next to `"SigmaLink" was blocked to protect your Mac`.
5. Authenticate (Touch ID / password).
6. Re-open SigmaLink; the original warning re-appears — click **Open**.

The DMG also ships a `README — Open SigmaLink.txt` file with these same instructions, visible when the DMG mounts.

### Option 3 — Build from source

See [Quickstart (build from source)](#quickstart-build-from-source) below. Local builds are not subject to Gatekeeper because the resulting `.app` never carries `com.apple.quarantine`.

### Why these workarounds exist

SigmaLink is not signed with an Apple Developer ID and is not notarised. Apple Developer Program costs $99/year and is on the v1.2 roadmap once the project is funded. Until then:
- v1.1.5+ DMG passes `codesign --verify --deep --strict` with a proper ad-hoc signature (no more "damaged" verdict).
- macOS Gatekeeper still shows "unidentified developer" on the FIRST launch of a browser-downloaded DMG. Subsequent launches work normally once accepted.
- `curl` downloads (Option 1) bypass Gatekeeper entirely because curl doesn't register as a quarantine source.

Path to the permanent fix: enroll in Apple Developer Program → flip `electron-builder.yml` to use a real Developer ID + `notarize: true` → DMG becomes a single-double-click install with no prompts → SigmaLink becomes eligible for Homebrew Cask. All documented in [`docs/09-release/release-notes-1.1.7.txt`](docs/09-release/release-notes-1.1.7.txt).

## Quickstart (build from source)

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

Windows users: `node-pty` and `better-sqlite3` are rebuilt against the local Electron version on `npm install`. The historic `.cmd` shim issue ("Cannot create process, error code: 2") was resolved by the PATH+PATHEXT resolver in `src/main/core/pty/local-pty.ts:47-85` — see [`docs/01-investigation/01-known-bug-windows-pty.md`](docs/01-investigation/01-known-bug-windows-pty.md) for the full history and [`docs/04-design/windows-port.md`](docs/04-design/windows-port.md) for the v1.2.0 Windows port design.

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
│   ├── 00-index.md            top-level index of indexes
│   ├── 01-investigation/      bug audit, architecture notes, test plan
│   ├── 02-research/           public-source research synthesis
│   ├── 03-plan/               PRODUCT_SPEC, BUILD_BLUEPRINT, UI_SPEC, REBUILD_PLAN, V3_PARITY_BACKLOG
│   ├── 04-design/             per-track design docs (voice, ruflo)
│   ├── 05-critique/           architecture / UX / engineering-risk critiques
│   ├── 06-build/              per-feature build agent outputs
│   ├── 07-test/               visual test reports + screenshots
│   ├── 08-bugs/               open + deferred bugs
│   ├── 09-release/            release-notes-*.txt per annotated tag
│   └── 10-memory/             master_memory, memory_index, ORCHESTRATION_LOG
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

The full phased plan is in [`docs/03-plan/BUILD_BLUEPRINT.md`](docs/03-plan/BUILD_BLUEPRINT.md). Critiques that shaped it are in [`docs/05-critique/`](docs/05-critique/). Open bugs are tracked in [`docs/08-bugs/OPEN.md`](docs/08-bugs/OPEN.md); deferred bugs in [`docs/08-bugs/DEFERRED.md`](docs/08-bugs/DEFERRED.md). Long-form orchestration ledger at [`docs/10-memory/master_memory.md`](docs/10-memory/master_memory.md).

## Documentation index

Start at [`docs/README.md`](docs/README.md) for the full directory map. The intended reading order is:

1. [`docs/ORCHESTRATION_LOG.md`](docs/ORCHESTRATION_LOG.md) — what the swarm is doing and why.
2. [`docs/03-plan/PRODUCT_SPEC.md`](docs/03-plan/PRODUCT_SPEC.md) — canonical product spec.
3. [`docs/03-plan/BUILD_BLUEPRINT.md`](docs/03-plan/BUILD_BLUEPRINT.md) — phased implementation plan.
4. [`docs/05-critique/`](docs/05-critique/) — architecture, UX, engineering-risk critiques.

## Releases

- **v1.1.1** (current) — UX hotfix on top of v1.1.0-rc3. Window finally draggable on macOS (chrome regions wired with `WebkitAppRegion`). "Bridge Assistant" rebranded to **Sigma Assistant** across every user-visible string. **Sigma Assistant now streams real Claude Code CLI responses** (Opus 4.7 under the hood, no raw API calls) — the long-standing W13 stub is replaced with a `child_process` driver that pipes `claude -p ... --output-format stream-json --verbose` JSONL into the existing `assistant:state` channel. **SigmaVoice diagnostics surface** added to Settings (mode radio, permission status with re-prompt, Run Diagnostics button with 4-stage probe dots). First-launch auto-enable on macOS. 8 + 7 new unit tests.
- **v1.1.0-rc3** — Hotfix on rc2: inlined `lazy-val` in the esbuild bundle to dodge the pnpm content-store hoist that crashed the rc2 DMG with `Cannot find module 'lazy-val'`.
- **v1.1.0-rc2** — Bundles Phase 4 Tracks A+B+C plus the Skills marketplace live install. Native macOS speech recognition, Ruflo MCP semantic memory + pattern surfacing + autopilot palette suggestion, IPC reliability hardening, provider launcher façade with BridgeCode silent fallback, macOS DMG PATH bootstrap. ⚠ Known DMG runtime defect (`Cannot find module 'lazy-val'`) — superseded by rc3.
- **v1.0.1** — DMG bindings hotfix + UI bug fixes (sidebar traffic-light overlap, CLI pane text alignment, Browser data-room flicker, missing zod schemas).
- **v1.0.0** — V3 parity release with Persistent Swarm Replay + Sigma Assistant cross-session memory differentiators. ⚠ Known DMG runtime defect (`Cannot find module 'bindings'`) — superseded by v1.0.1.

## Browser MCP first use (v1.2.6+)

Since v1.2.6, the browser MCP server is no longer bundled inside SigmaLink. When an agent first calls a browser tool (e.g., "navigate to example.com"), two one-time downloads happen inside the pane terminal:

1. **npx downloads `@playwright/mcp`** (~10 s on a fast connection).
2. **Playwright downloads Chromium** (~170 MB, ~30 s with progress visible).

Both are cached globally: subsequent browser tool calls in any pane are instant. If you don't have `npx` on PATH, the agent pane will show an error — make sure Node.js is installed and `bootstrapNodeToolPath()` has been run (automatic on macOS/Linux since v1.2.5).

## Known issues in v1.1.1

Full triage in [`docs/08-bugs/OPEN.md`](docs/08-bugs/OPEN.md). v1.2 milestone tracks the follow-ups.

- **Wake-word "Hey Sigma"** — Porcupine free-tier licensing forbids shipping a bundled AccessKey to public users. v1.2 will add a BYO-AccessKey UX in Settings (each user creates their own free Picovoice account).
- **Ruflo native deps** — `@claude-flow/cli`'s installer fetches the top-level tarball only in v1.1; transitive `@ruvector/sona-*` and `onnxruntime-node` are not pulled. Tools that need them surface a clear error. v1.2 will lift this to a real `npm install --omit=dev` walk.
- **macOS notarisation + Windows code-signing** — installers are unsigned. macOS users see Gatekeeper warnings; Windows users see the SmartScreen filter. Notarisation requires an Apple Developer ID (procurement deferred).
- **BridgeCode multi-provider dispatch** — BridgeCode is registered with `comingSoon` flag and silently falls back to Claude. Real dispatch lands when BridgeMind ships the BridgeCode SKU.
- **macOS-only voice** — Windows SAPI + Linux Whisper.cpp deferred to v1.2; Win/Linux remain on Web Speech API fallback.
- **`@playwright/test` 1.59 + Node 26 race** — defensive spec edits keep the suite running; proper fix (bump to ≥1.60) deferred to v1.2.
- **V3 visual parity sprint** — 9 documented gaps in `docs/03-plan/V3_PARITY_BACKLOG.md` (right-rail dock chrome, per-pane top-bar variants, multi-pane grid layout persistence, role-color tokens, Swarm Skills 12-tile grid, Bridge orb animation polish, CLI agent provider strip, coordinator task-brief envelope, general token retheme audit). Cosmetic; held for a later sweep.

## Contributing

Pull requests are welcome but expect heavy churn until Wave 7 acceptance lands. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR; bug reports and feature requests use the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/).

## Security

SigmaLink runs untrusted CLI agents inside PTYs against your local repositories. Each agent has full filesystem access within its worktree, and the planned in-app browser will give agents network egress. Treat this like running anything else with `--dangerously-skip-permissions` enabled. Vulnerability reports go through a private security advisory: see [`SECURITY.md`](SECURITY.md).

## Acknowledgements

- Inspired by BridgeMind's BridgeSpace and BridgeSwarm products. SigmaLink is an independent project; we are not affiliated with, endorsed by, or sponsored by BridgeMind.
- PTY ring-buffer plumbing, generic RPC bridge, and several Git-orchestration patterns are drawn from [Emdash](https://github.com/generalaction/emdash) (Apache-2.0). See [`ATTRIBUTIONS.md`](ATTRIBUTIONS.md).
- Skill format follows the public Anthropic Skills layout (SKILL.md frontmatter + body).
- UI components use [shadcn UI](https://ui.shadcn.com/), [Radix UI](https://www.radix-ui.com/), [lucide-react](https://lucide.dev/), and [xterm.js](https://xtermjs.org/). Database access uses [Drizzle ORM](https://orm.drizzle.team/) on top of [better-sqlite3](https://github.com/WiseLibs/better-sqlite3). PTY support comes from [node-pty](https://github.com/microsoft/node-pty). The in-app browser is driven by [@playwright/mcp](https://github.com/microsoft/playwright-mcp) via stdio (each agent pane spawns its own instance on demand; ~10 s npx download + ~30 s Chromium download on first use).

## License

MIT. See [`LICENSE`](LICENSE).
