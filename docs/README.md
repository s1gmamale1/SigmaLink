# SigmaLink Documentation Index

Every persistent design document, research artefact, critique, and bug log lives under this `docs/` tree. The orchestrator log (`ORCHESTRATION_LOG.md`) records what every wave of sub-agents produced and where their output landed.

## Start here

If you have not read SigmaLink before, read these in order:

1. [`ORCHESTRATION_LOG.md`](ORCHESTRATION_LOG.md) — what the swarm is doing now and why.
2. [`03-plan/PRODUCT_SPEC.md`](03-plan/PRODUCT_SPEC.md) — the canonical product specification.
3. [`03-plan/BUILD_BLUEPRINT.md`](03-plan/BUILD_BLUEPRINT.md) — the phased implementation plan; every PR should link to a section here.
4. [`04-critique/01-architecture.md`](04-critique/01-architecture.md), [`04-critique/02-ux-ui.md`](04-critique/02-ux-ui.md), [`04-critique/03-engineering-risk.md`](04-critique/03-engineering-risk.md) — three critiques that stress-tested the plan.
5. [`03-plan/FINAL_BLUEPRINT.md`](03-plan/FINAL_BLUEPRINT.md) — produced by Wave 4 and may not exist yet. If the link 404s, that wave has not landed; check `ORCHESTRATION_LOG.md` for status.

## `01-investigation/`

Bug audit, architecture notes, and the manual test plan written before any rebuild work began.

- [`01-known-bug-windows-pty.md`](01-investigation/01-known-bug-windows-pty.md) — the Windows `.cmd` shim PTY spawn failure, root cause, and remediation plan.
- [`02-bug-sweep.md`](01-investigation/02-bug-sweep.md) — full sweep of P0 / P1 / P2 defects in the Phase 1 build.
- [`03-architecture-notes.md`](01-investigation/03-architecture-notes.md) — current architecture walk-through that the README links to.
- [`04-test-plan.md`](01-investigation/04-test-plan.md) — manual smoke and regression flows.

## `02-research/`

Public-source research on BridgeMind, BridgeSpace, and BridgeSwarm, plus the Anthropic Skills and MCP work that informs SigmaLink's design.

- [`CONFLICTS.md`](02-research/CONFLICTS.md) — places where existing project docs disagreed and how each conflict was resolved.
- [`CONSOLIDATED_SOURCES.md`](02-research/CONSOLIDATED_SOURCES.md) — every source consulted, with a short note per source.
- [`DESIGN_DECISIONS_LOG.md`](02-research/DESIGN_DECISIONS_LOG.md) — running log of decisions that affect the spec.
- [`REQUIREMENTS_MASTER.md`](02-research/REQUIREMENTS_MASTER.md) — unified requirements list distilled from all research.
- [`RESEARCH_SUMMARY.md`](02-research/RESEARCH_SUMMARY.md) — top-level summary of what research found.
- [`agent-roles-and-protocol.md`](02-research/agent-roles-and-protocol.md) — Coordinator / Builder / Scout / Reviewer role definitions and mailbox protocol.
- [`browser-spec.md`](02-research/browser-spec.md) — documented behaviour of the in-app browser sidebar.
- [`changelog-summary.md`](02-research/changelog-summary.md) — public BridgeSpace and BridgeVoice changelog summary.
- [`feature-matrix.md`](02-research/feature-matrix.md) — feature-by-feature comparison across BridgeMind products.
- [`glossary.md`](02-research/glossary.md) — terminology used across BridgeMind, BridgeSpace, and BridgeSwarm.
- [`keyboard-shortcuts.md`](02-research/keyboard-shortcuts.md) — documented shortcuts pulled from public sources.
- [`mcp-tool-catalog.md`](02-research/mcp-tool-catalog.md) — catalog of MCP servers and tools relevant to SigmaLink.
- [`open-questions.md`](02-research/open-questions.md) — unresolved product questions.
- [`open-video-questions.md`](02-research/open-video-questions.md) — unresolved questions raised by the launch video.
- [`skills-spec.md`](02-research/skills-spec.md) — Anthropic Skills frontmatter spec and how BridgeMind extended it.
- [`video-frames-log.md`](02-research/video-frames-log.md) — frame-by-frame log of the public launch video.
- [`visual-asset-inventory.md`](02-research/visual-asset-inventory.md) — visual assets observed in public materials.
- [`visual-spec.md`](02-research/visual-spec.md) — colour, type, spacing, and component spec consolidated from research.
- [`workflows.md`](02-research/workflows.md) — end-to-end user workflows that SigmaLink must support.
- `thumbnails/`, `transcripts/`, `web-images/`, `web-pages/` — supporting raw artefacts.

## `03-plan/`

The canonical specs that drive every PR.

- [`PRODUCT_SPEC.md`](03-plan/PRODUCT_SPEC.md) — single source of truth for what SigmaLink is.
- [`BUILD_BLUEPRINT.md`](03-plan/BUILD_BLUEPRINT.md) — phased implementation plan with file-level scope.
- [`UI_SPEC.md`](03-plan/UI_SPEC.md) — pixel and style spec consolidated from research.
- `FINAL_BLUEPRINT.md` — produced by Wave 4. May not exist yet; check `ORCHESTRATION_LOG.md` for status.

## `04-critique/`

Three critiques of the plan, written by independent sub-agents.

- [`01-architecture.md`](04-critique/01-architecture.md) — architectural risks, layering issues, and counter-proposals.
- [`02-ux-ui.md`](04-critique/02-ux-ui.md) — UX and UI critique against the visual and interaction specs.
- [`03-engineering-risk.md`](04-critique/03-engineering-risk.md) — engineering risk register and bug-policy recommendations.

## `05-build/`

Per-feature build agent outputs. Each file in this directory is a standalone report from a build wave.

- [`W-DOCS-report.md`](05-build/W-DOCS-report.md) — initial documentation pass.
- [`W5-FOUNDATION-report.md`](05-build/W5-FOUNDATION-report.md) — Phase 1.5 foundation patches (Windows PTY shim, IPC allowlist, P0/P1/P2 fixes).
- [`W6-SWARM-report.md`](05-build/W6-SWARM-report.md) — Phase 2 Swarm Room, mailbox bus, SIGMA:: protocol.
- [`W6-BROWSER-report.md`](05-build/W6-BROWSER-report.md) — Phase 3 Browser Room + Playwright MCP supervisor.
- [`W6-SKILLS-report.md`](05-build/W6-SKILLS-report.md) — Phase 4 Skills drag-and-drop + per-provider fan-out.
- [`W6-MEMORY-report.md`](05-build/W6-MEMORY-report.md) — Phase 5 SigmaMemory MCP server, notes UI, graph view.
- [`W6-REVIEW-report.md`](05-build/W6-REVIEW-report.md) — Phase 6 Review Room rebuild + Tasks/Kanban.
- [`W6-UI-POLISH-report.md`](05-build/W6-UI-POLISH-report.md) — Phase 7 UI polish (themes, command palette, onboarding).
- [`W8-BUGFIX-report.md`](05-build/W8-BUGFIX-report.md) — Wave 8 visual-sweep bug-fix pass.

## `06-test/`

Visual test reports, screenshots, and machine-readable summaries.

- [`W7-VISUAL-report.md`](06-test/W7-VISUAL-report.md) — Wave 7 visual sweep (15 bugs filed).
- [`ACCEPTANCE_REPORT.md`](06-test/ACCEPTANCE_REPORT.md) — Wave 9 acceptance verdict for `v0.1.0-alpha`.
- [`visual-summary.json`](06-test/visual-summary.json) — Wave 7 step log.
- [`visual-summary-acceptance.json`](06-test/visual-summary-acceptance.json) — Wave 9 step log + bug reverification status.
- `console-output.txt` — driver console output from the smoke run.
- `screenshots/` — 37 captured frames per smoke run.

## `07-bugs/`

The live bug log.

- [`OPEN.md`](07-bugs/OPEN.md) — bugs currently being worked on.
- [`DEFERRED.md`](07-bugs/DEFERRED.md) — bugs marked-and-skipped after the five-attempt limit.

## Release notes

- [`release-notes-0.1.0-alpha.txt`](release-notes-0.1.0-alpha.txt) — plain-text release notes used for the `v0.1.0-alpha` annotated tag.
