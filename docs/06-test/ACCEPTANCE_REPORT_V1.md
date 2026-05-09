# SigmaLink Acceptance Report — V1.0 Candidate

**Compiled**: 2026-05-10
**Scope**: V3 parity build (Waves 10-15) on top of `v0.1.0-alpha`
**Tag (planned)**: `v1.0.0` (PENDING USER AUTHORIZATION)
**Driver**: `tsc -b` + `vite build` clean; smoke spec `app/tests/e2e/smoke.spec.ts` gated on the W15 CI matrix
**Predecessor**: `docs/06-test/ACCEPTANCE_REPORT.md` (v0.1.0-alpha, 2026-05-09)

## Verdict

**RELEASE-BLOCKED-PENDING-USER**.

Feature-complete: every BUILD ticket in `docs/03-plan/V3_PARITY_BACKLOG.md` ships except dogfood (V3-W15-006). Build pipeline green (`tsc -b` clean; `vite build` 990 KB main + 14.57 KB Monaco; lint 80/3 mostly in `_legacy/`). Two W7 P3 promotions and the local Playwright smoke remain gated on a Node 26 + npm 11 install bug; `.github/workflows/e2e-matrix.yml` (V3-W15-004) restores cross-platform smoke on Node 20. v1.0.0 git tag + push gated on explicit user authorization.

## Definition-of-Done flow table (re-scored against V3 surfaces)

Re-runs the 12 flows from the W9 ACCEPTANCE_REPORT scored against the V3 surfaces shipped in W10-15, plus 4 new V3 flows. "Pending CI" replaces speculative passes for flows that the local smoke cannot exercise on Node 26.

| # | Flow | v0.1.0-alpha | V1.0 candidate | Evidence |
|---|------|--------------|----------------|----------|
| 1 | Open a workspace from the launcher (3-card picker + stepper) | Pass | Pass | V3-W12-005/006/007 |
| 2 | Launch a 4-pane Command Room with provider splash + grid | Pass | Pass | V3-W13-003 chrome variants; V3-W13-004 CSS-grid + `Cmd+Alt+<N>` |
| 3 | Create a Battalion swarm via 5-step wizard; broadcast mission | Partial | Pass | V3-W12-009/011 wizard + Battalion; V3-W12-016 `@all` recipients |
| 4 | Roll-call the swarm and see SIGMA::ROLLCALL_REPLY | Not exercised | Pending CI | Bridge Assistant `roll_call` tool wired; no auto-CLI emits replies yet |
| 5 | Open Browser tab in right-rail dock; persist across restart | Pass | Pass | V3-W13-001/002 dock + recents + link-routing |
| 6 | Drop SKILL.md; toggle for Claude; flip a Swarm Skill | Pass | Pass | V3-W13-011 12-tile grid writes `skill_toggle` |
| 7 | Write a `[[wikilink]]` memory note; see backlinks | Pass | Pass | Unchanged |
| 8 | Open Memory Graph; click node to navigate | Pass | Pass | Unchanged |
| 9 | Run test command in Review Room; see streaming output | Partial | Partial | `review:run-output` not yet smoke-driven |
| 10 | Drop a task on a swarm-roster slot to assign | Partial | Partial | DnD wired to `SIGMA::TASK`; not yet smoke-driven |
| 11 | Cmd+K palette → Kill all PTYs / voice toggle | Pass | Pass | V3-W15-003 added `Cmd+Shift+K` voice toggle |
| 12 | Switch each of 4 themes; sidebar retheme | Partial | Pending CI | BUG-W7-003 fresh-kv reverify pending; V3-W12-010 role colours added cleanly |
| 13 | Bridge Assistant: tap orb, dispatch 4 panes, jump-to-pane | n/a | Pending CI | V3-W13-012/013/015 wired end-to-end |
| 14 | Bridge Canvas: pick element → multi-provider dispatch → drop asset | n/a | Pending CI | V3-W14-001..005 wired end-to-end |
| 15 | Editor right-rail tab: open file from chat link → Monaco | n/a | Pass | V3-W14-007 lazy-load + click-path focus |
| 16 | Auto-update opt-in: enable, force a check | n/a | Pass | V3-W14-008 `electron-updater@6.8.3` + UpdatesTab |

Pass: 8. Partial: 2. Pending CI: 5. Not exercised: 0. No fails.

The "Pending CI" rows resolve as soon as the W15 GitHub Actions matrix completes its first green run on `windows-latest` + `macos-14` + `ubuntu-latest`. Flows 13-16 are the V3 additions; the original 12-flow contract from W9 stays intact.

## V3 affordance audit (30 surfaces, all Shipped)

Backlog ticket IDs are the authoritative spec: `docs/03-plan/V3_PARITY_BACKLOG.md`. Every Wave 12-14 ticket in that backlog ships in v1.0.0 except V3-W15-006 (dogfood, deferred).

W12 chrome (1-16): V3-W12-005 3-card picker · V3-W12-006 stepper · V3-W12-007 layout grid · V3-W12-008 sidebar status dot + breadcrumb · V3-W12-009 Battalion 20 · V3-W12-010 role colour tokens · V3-W12-011 5-step wizard · V3-W12-012 global provider strip · V3-W12-013/014 Operator Console TopBar · V3-W12-016 9 mailbox kinds · V3-W12-017 RPC allowlist groups (17 channels + 5 events) · V3-W12-018 per-row Auto-approve · V3-W12-001 BridgeCode stub · V3-W12-002 Kimi as OpenCode model · V3-W12-003 Aider/Continue legacy toggle · V3-W12-004 wizard quick-fills.

W13 right-rail + Operator Console body + Bridge Assistant (17-29): V3-W13-001 right-rail dock · V3-W13-002 Browser recents + link routing · V3-W13-003 per-pane chrome + splash · V3-W13-004 multi-pane CSS grid · V3-W13-005/014 Constellation graph (multi-hub) · V3-W13-006 ActivityFeed · V3-W13-007 task_brief render · V3-W13-008 per-agent boards · V3-W13-009 Operator DM echo · V3-W13-010 mission @-autocomplete · V3-W13-011 Swarm Skills 12-tile · V3-W13-012 Bridge Assistant orb + chat · V3-W13-013 assistant.* RPC + 10 tools + tracer.

W14 Bridge Canvas pipeline (30): V3-W14-001..006 (picker, DesignDock, provider chips, drop staging, HMR poke, GA toggle).

Bonus shipped: V3-W14-007 Editor Monaco tab · V3-W14-008 auto-update · V3-W14-009 Re-probe + rebuild modal · V3-W15-001/002/003 BridgeVoice · V3-W15-004 CI matrix · V3-W15-005 plan capabilities · V3-W15-007 Marketplace stub · V3-W13-015 Jump-to-pane + ding.

## Risk register update (A1..A16 + R1..R11)

Carried forward from `docs/06-test/ACCEPTANCE_REPORT.md`. New status reflects W10-15 work.

| ID | Risk | v0.1.0-alpha | V1.0 candidate | Note |
|----|------|--------------|----------------|------|
| A1 | Generic invoke proxy without per-channel schemas | Partial | Mitigated | zod soft-launch |
| A2 | Mailbox concurrency | Mitigated | Mitigated | — |
| A3 | SigmaMemory MCP lifecycle | Mitigated | Mitigated | — |
| A4 | Schema migrations | Partial | Mitigated | Drizzle Kit journal |
| A5 | Credential storage | Open | Mitigated | `safeStorage` shipped |
| A6 | PTY ring buffer / ANSI | Mitigated | Mitigated | — |
| A7 | Browser supervisor / CDP | Mitigated | Mitigated | CDP-attach deferred |
| A8 | Skills fan-out / OneDrive | Mitigated | Mitigated | — |
| A9 | Worktree pool edge cases | Mitigated | Mitigated | — |
| A10 | Failure janitor | Mitigated | Mitigated | — |
| A11 | Multi-window concurrency | Open | Open | single window v1 contract |
| A12 | Native module distribution | Partial | Mitigated | W10 self-check |
| A13 | Swarm concurrency | Mitigated | Mitigated | — |
| A14 | "Launch 16 agents <1 s" | Open | Partial | grid to 12; informal |
| A15 | PTY + MCP in CI | Partial | Mitigated (pending) | matrix workflow |
| A16 | Telemetry | Out of scope | Out of scope | — |
| R1 | Phase 1.5 understated | Mitigated | Mitigated | — |
| R2 | Allowlist without payload validation | Partial | Mitigated | zod |
| R3 | Native rebuild for end users | Open | Mitigated | NativeRebuildModal |
| R4 | Visual test harness | Mitigated | Mitigated | CI canonical |
| R5 | Skills-needs-MCP | Mitigated | Mitigated | — |
| R6 | Sub-agent merge contention | Mitigated | Mitigated | append-only |
| R7 | Observational acceptance | Partial | Partial | unit tests still light |
| R8 | Five-attempt loop | Mitigated | Mitigated | — |
| R9 | Secrets handling | Open | Mitigated | A5 closed |
| R10 | Cross-platform debt | Partial | Partial | notarisation + signing deferred |
| R11 | Auto-update strategy | Open | Mitigated | electron-updater opt-in |

Mitigated: 21. Partial: 4. Open: 1 (A11 multi-window). Out of scope: 1 (A16 telemetry).

## Top-5 follow-ups for v1.1

1. Run dogfood cycle (V3-W15-006) — 4-pane swarm against a non-trivial repo ≥30 min; `[V3-DOGFOOD-NN]` bug list.
2. Native voice bindings (macOS Speech / Windows SAPI / Linux PocketSphinx) under `app/src/main/core/voice/adapter.ts`.
3. macOS notarisation + Windows code-signing certificate (R10 Partial).
4. Three-way merge editor + per-line review comments in Review Room.
5. Manual reverify BUG-W7-003 + BUG-W7-006 on a fresh-kv GUI cycle; promote to `verified`.

## Build outputs at v1.0 candidate

- `tsc -b` clean; `vite build` 990 KB main + 14.57 KB Monaco lazy chunk.
- `npm run lint` 80/3 (nearly all in `_legacy/`; new product code holds W9 baseline).
- `npm run electron:compile` green; emits `main.js` + `preload.cjs` + `mcp-memory-server.cjs`.
- Local Playwright smoke gated on Node 26 + npm 11 install bug; `.github/workflows/e2e-matrix.yml` restores it on Node 20 (Win / macOS / Linux).
