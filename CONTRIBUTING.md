# Contributing to SigmaLink

Thanks for considering a contribution. SigmaLink is in active rebuild and a few rules keep it predictable.

## Project state

Phase 1 (foundation) ships. Phases 2–8 are being built by a sub-agent swarm orchestrated from [`docs/ORCHESTRATION_LOG.md`](docs/ORCHESTRATION_LOG.md). Pull requests are welcome, but expect heavy churn until the Wave 7 acceptance pass lands. If you want to land non-trivial work, file an issue first so we can confirm it does not collide with an in-flight phase.

The canonical surface to read before contributing:

- [`docs/03-plan/PRODUCT_SPEC.md`](docs/03-plan/PRODUCT_SPEC.md) — what we are building.
- [`docs/03-plan/BUILD_BLUEPRINT.md`](docs/03-plan/BUILD_BLUEPRINT.md) — the phased plan; every PR should link to the phase it belongs to.
- [`docs/05-critique/`](docs/05-critique/) — known risks and constraints.

## Local development

```bash
git clone https://github.com/s1gmamale1/SigmaLink.git
cd SigmaLink/app
npm install
npm run electron:dev
```

Requirements:

- Node.js 20 or newer.
- Git (with `user.name` and `user.email` configured).
- At least one CLI agent on `PATH` to exercise launch flows.

`npm install` runs `electron-builder install-app-deps`, which rebuilds `node-pty` and `better-sqlite3` against the local Electron version. If a native module fails to load at runtime, rerun `npm install` from a clean tree and confirm Electron 30 is the active version.

## Lint, type-check, build

| Command | What it does |
|---|---|
| `npm run lint` | ESLint over the renderer and main process. |
| `npm run build` | `tsc -b` then `vite build` for the renderer. |
| `npm run electron:compile` | esbuild bundle of `electron/main.ts` + `electron/preload.ts` into `electron-dist/`. |
| `npm run product:check` | `build` + `electron:compile`. Run this before opening a PR. |
| `npm run electron:dev` | Full dev loop: build renderer, bundle main, launch Electron. |
| `npm run electron:build` | Production package via `electron-builder`. |

A PR that does not pass `npm run lint` and `npm run product:check` will not be reviewed.

## Branch naming

- New features: `feat/<area>-<slug>` (for example `feat/swarm-mailbox-watcher`).
- Bug fixes: `fix/<bug-id>` matching the bug ID in [`docs/01-investigation/02-bug-sweep.md`](docs/01-investigation/02-bug-sweep.md) or [`docs/08-bugs/OPEN.md`](docs/08-bugs/OPEN.md), for example `fix/P0-PTY-WIN-CMD`.
- Doc-only: `docs/<area>-<slug>`.
- Refactors: `refactor/<area>-<slug>`.

The bug-fix branch convention is mandatory; it lets the orchestrator cross-link PRs to the bug-sweep grid (see [`docs/05-critique/03-engineering-risk.md`](docs/05-critique/03-engineering-risk.md) for the policy).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`. Scope is the feature area (`pty`, `swarm`, `review`, `skills`, `memory`, `browser`, `db`, `rpc`, `ui`). Reference the bug ID or phase in the footer when applicable, for example `Refs: P0-PTY-WIN-CMD` or `Phase: 3`.

## Pull request checklist

Before requesting review, confirm every item:

- [ ] One feature or fix per PR; no drive-by refactors mixed in.
- [ ] Linked to the relevant phase in [`docs/03-plan/BUILD_BLUEPRINT.md`](docs/03-plan/BUILD_BLUEPRINT.md), or to a bug ID.
- [ ] `npm run lint` passes.
- [ ] `npm run product:check` passes.
- [ ] Smoke flow exercised: launch the app, open a workspace, run a pane, exit cleanly.
- [ ] Schema migration committed if any Drizzle schema changed.
- [ ] Screenshots or a short recording attached for any UI change.
- [ ] Docs updated when surface area moves (PRODUCT_SPEC, BUILD_BLUEPRINT, or in-feature READMEs).

The PR template at [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) reproduces this checklist.

## Filing bugs

Use the bug report template at [`.github/ISSUE_TEMPLATE/bug_report.md`](.github/ISSUE_TEMPLATE/bug_report.md). Include the OS, Node version, Electron version (`30.x`), and which providers are installed. Reproduction steps and the actual versus expected behaviour are required; logs and screenshots speed triage. Security issues never go in public issues — see [`SECURITY.md`](SECURITY.md).

For feature requests, use [`.github/ISSUE_TEMPLATE/feature_request.md`](.github/ISSUE_TEMPLATE/feature_request.md). If your idea overlaps an in-flight phase, the maintainers will mark the issue as a tracking link to the phase rather than a parallel implementation.

## Code of conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). Report violations via a private GitHub security advisory until a dedicated channel exists.
