# Attributions

SigmaLink stands on the shoulders of several open-source projects. This file lists the third-party work whose patterns or APIs SigmaLink uses, with the license each is offered under and a one-paragraph note about how we use it. No code from any of these projects is copied verbatim into SigmaLink — we re-implemented the patterns we learned from in our own TypeScript.

## Pattern sources

### Emdash

- URL: https://github.com/generalaction/emdash
- License: Apache-2.0

We adapted four patterns from Emdash and re-implemented them: the Proxy-based generic RPC pattern that bridges renderer and main process through a single typed `invoke`, the ring-buffer + atomic-subscribe PTY pattern that lets a terminal pane reattach without losing output, the worktree-pool layout that names branches `<tool>/<role>/<task>-<8char>`, and the canonical-MCP-server-with-per-agent-adapter shape that lets one server definition fan out to Claude, Codex, Gemini, and other providers' native config locations. None of Emdash's source is included; we re-implemented these in our own TypeScript.

### Anthropic Skills format

- URL: https://docs.anthropic.com/en/docs/claude-code/skills

SigmaLink uses the Anthropic SKILL.md frontmatter spec as the canonical on-disk schema for ingested skills. Drag-and-drop ingestion validates a `SKILL.md` file with Zod against this spec, then fans the skill out to each provider's native skills location.

## Runtime libraries

### xterm.js

- URL: https://github.com/xtermjs/xterm.js
- License: MIT

The terminal renderer used inside every Command Room pane.

### node-pty

- URL: https://github.com/microsoft/node-pty
- License: MIT

Native PTY spawn in the Electron main process. Rebuilt against the local Electron version on `npm install`.

### Drizzle ORM

- URL: https://github.com/drizzle-team/drizzle-orm
- License: Apache-2.0

The SQLite schema layer used for workspaces, sessions, swarm rosters, tasks, conversations, and notes.

### better-sqlite3

- URL: https://github.com/WiseLibs/better-sqlite3
- License: MIT

The synchronous SQLite driver underneath Drizzle.

### shadcn UI

- URL: https://ui.shadcn.com

The component starter set seeded under `app/src/components/ui/`. shadcn ships components as source you copy into your repo, so the files in that directory are derived from shadcn templates.

### Radix UI

- URL: https://www.radix-ui.com

Radix is the underlying primitive layer (dialogs, dropdowns, popovers, tabs, and more) that the shadcn components we use are built on top of.

### lucide-react

- URL: https://lucide.dev
- License: ISC

The icon set used throughout the renderer.

### Tailwind CSS

- URL: https://tailwindcss.com
- License: MIT

The utility-first styling framework used by the renderer and the shadcn components.

## Affiliation disclaimer

SigmaLink is not affiliated with, endorsed by, or sponsored by BridgeMind, BridgeSpace, or BridgeSwarm. The product was inspired by public documentation, marketing material, and the launch video for those products, but every line of SigmaLink's code is independently authored. Any superficial similarity in terminology (Coordinator, Builder, Scout, Reviewer roles; Command Room, Swarm Room, Review Room) is functional and idiomatic, not copied.
