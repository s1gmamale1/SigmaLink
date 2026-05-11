# SigmaLink — Project Context & Guidelines

SigmaLink is an Electron-based desktop workspace designed for orchestrating multiple CLI coding agents (Claude, Codex, Gemini) within isolated Git worktrees. It provides a unified command center for agent swarms, featuring real-time PTY terminals, shared memory via Ruflo, and integrated tools for browser interaction, skill management, and task tracking.

## 🏗 Architecture Overview

- **Electron Main Process (`electron/`, `src/main/`)**: Handles PTY management (`node-pty`), SQLite persistence (`Drizzle` + `better-sqlite3`), Git operations, and agent orchestration.
- **Electron Preload (`electron/preload.ts`)**: Bridges the Main and Renderer processes via a typed, channel-allowlisted RPC system.
- **Renderer Process (`src/renderer/`)**: A React 19 application built with Vite, Tailwind CSS, and shadcn/ui. Organized by "rooms" (features) such as `command-room`, `swarm-room`, and `review-room`.
- **Shared (`src/shared/`)**: Contains typed RPC contracts, provider definitions, and Zod schemas used across both processes.
- **Ruflo Integration**: Embedded orchestration layer providing vector search (HNSW), neural learning (SONA), and a standardized MCP tool interface.

## 🚀 Building and Running

| Command | Description |
|---|---|
| `npm install` | Installs dependencies and rebuilds native modules (`better-sqlite3`, `node-pty`) for Electron. |
| `npm run electron:dev` | **Primary Dev Command**. Builds the renderer, compiles Electron sources, and launches the app. |
| `npm run build` | Compiles the React renderer into `dist/`. |
| `npm run electron:compile` | Bundles `electron/main.ts` and `electron/preload.ts` into `electron-dist/` using esbuild. |
| `npm run vitest run` | Executes the unit test suite. |
| `pnpm exec playwright test` | Executes end-to-end smoke and dogfood tests. |
| `npm run electron:build` | Produces production installers (DMG, Zip) via `electron-builder`. |

> **Note**: Native module mismatches (e.g., `better-sqlite3` compiled for the wrong Node version) can be fixed by running `npm rebuild better-sqlite3 node-pty`.

## 🛠 Development Conventions

### General Rules
- **Surgical Edits**: Prefer targeting specific lines or blocks. Use the `replace` tool for precision.
- **File Length**: Aim to keep source files under 500 lines. Refactor complex logic into sub-modules.
- **Type Safety**: Maintain strict TypeScript typing. Ensure the RPC router (`src/main/rpc-router.ts`) and its shapes (`src/shared/router-shape.ts`) remain in sync.
- **Validation**: Every RPC channel should have a corresponding Zod schema in `src/main/core/rpc/schemas.ts`.

### Persistence & State
- **Database**: All persistent state lives in SQLite. Schema is managed via Drizzle in `src/main/core/db/schema.ts`.
- **KV Store**: Lightweight settings and transient flags should use the `kv` controller.
- **Memory**: Project-wide narrative and task history are maintained in `docs/10-memory/master_memory.md` and `memory_index.md`. Update these after every significant milestone.

### 🤖 Ruflo & Agent Swarms
- **Coordination**: Use `SendMessage`-first coordination between named agents. Avoid polling for status.
- **Routing**: Utilize the 3-tier model routing (Agent Booster → Haiku → Sonnet/Opus) based on task complexity.
- **Intelligence**: Leverage `agentdb_pattern-store` to persist successful implementation patterns across sessions.
- **Codex/Ruflo Split**: Codex (you) handles the implementation, tests, and file edits. Ruflo manages the swarm orchestration, memory search, and cross-session learning.

### UI & Styling
- **Components**: Use existing shadcn/ui primitives in `src/renderer/components/ui/`.
- **Themes**: Preserve the 4 core themes (Obsidian, Parchment, Nord, Synthwave).
- **Icons**: Use `lucide-react`.

## 📂 Key File Map

- `CLAUDE.md`: Detailed configuration and rules for the Ruflo/Claude Flow ecosystem.
- `AGENTS.md`: Specific notes on how Codex should interact with the Ruflo orchestration layer.
- `src/main/rpc-router.ts`: The central wiring point for all backend controllers.
- `docs/10-memory/master_memory.md`: The "Source of Truth" for the project's build history and current state.
