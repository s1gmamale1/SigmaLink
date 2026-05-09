# SigmaLink

An open-source Electron desktop workspace for orchestrating multiple CLI coding agents in parallel — a clone-in-spirit of BridgeMind's BridgeSpace + BridgeSwarm.

## Repo layout

```
app/                 Electron + Vite + React + Tailwind + shadcn product
docs/                Research, plans, critiques, and build reports
  ORCHESTRATION_LOG.md  Master log of every wave
  01-investigation/     Bug audit + architecture notes for the current build
  02-research/          BridgeSpace research synthesised from public sources
  03-plan/              Product spec, build blueprint, UI spec
  04-critique/          Architecture / UX / engineering-risk critiques
  05-build/             Per-feature build agent outputs (populated as work progresses)
  06-test/              Visual test reports + screenshots
  07-bugs/              Open + deferred bugs
REBUILD_PLAN.md      Original Phase-1 plan (now superseded by docs/03-plan/)
```

## Status

- Phase 1 foundation: built and compiling. Workspace launcher, command room with PTY-backed terminals, 9 providers, SQLite + Drizzle.
- Phase 2–8: planned in `docs/03-plan/BUILD_BLUEPRINT.md` and being executed by the agent swarm.

## Running the app

```bash
cd app
npm install
npm run electron:dev
```

Requirements: Node 20+, Git, and at least one CLI agent installed (Claude Code, Codex CLI, Gemini CLI, etc.) on `PATH`.

## License

MIT for product code (see `app/package.json`). Research artifacts under `docs/02-research/web-pages/` quote ≤15 words per page from public sources for analysis only.
