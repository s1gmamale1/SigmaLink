# SigmaLink — Master Memory

Long-form record of the orchestrated build. Pair with [`memory_index.md`](memory_index.md) for the compact task table and with [`docs/ORCHESTRATION_LOG.md`](docs/ORCHESTRATION_LOG.md) for the per-wave operating log.

The orchestrator did not write product code itself. Every wave was dispatched as one or more sub-agents; the orchestrator only wrote planning, indexing, and decoration markdown.

## Mission

Rebuild SigmaLink as a clone-in-spirit of BridgeMind's BridgeSpace + BridgeSwarm — visually and functionally — using a sub-agent swarm. Document everything. Bugs that resist five fix attempts get marked-and-skipped. Stop only when the product is alpha-ready.

## Output topology

```
docs/
  ORCHESTRATION_LOG.md     master log of every wave
  01-investigation/        bug audit, architecture notes
  02-research/             public-source research synthesis
  03-plan/                 PRODUCT_SPEC, BUILD_BLUEPRINT, UI_SPEC
  04-critique/             architecture / UX / engineering-risk critiques
  05-build/                per-feature build agent reports (W5..W9)
  06-test/                 visual sweep + acceptance reports + screenshots
  07-bugs/                 OPEN.md + DEFERRED.md
master_memory.md          this file
memory_index.md           task table
README.md                 product landing
CHANGELOG.md              Keep-a-Changelog history
```

---

## Phase 0 — Setup

- Initialised git in `C:/Users/DaddysHere/Documents/SigmaLink`, configured a per-repo identity (`s1gmamale1`), wrote `.gitignore` excluding `node_modules/`, build artefacts, native runtime data, and third-party media.
- Initial commit `4861836` containing Phase 1 product code + research artefacts.
- Added remote `origin` → `https://github.com/s1gmamale1/SigmaLink.git`. `gh auth status` confirmed `s1gmamale1` was already authenticated with `repo` scope, so push went through without credential plumbing.
- Set repo metadata via `gh repo edit`: description, 20 topics covering stack and product domain, issues on, wiki off.

## Phase 1 — Foundation (already shipped before the orchestration started)

Existed prior to the orchestration run: Electron + Vite + React + Tailwind + shadcn shell with a Proxy-based RPC bridge, ring-buffer PTY, provider registry, Git worktree pool, SQLite (Drizzle), workspace launcher, command room with xterm.js. Carried forward unchanged into Phase 1.5 patches.

## Wave 1 — Investigation (4 parallel sub-agents)

All four agents ran concurrently and wrote their outputs to `docs/01-investigation/` and `docs/02-research/`.

- **Bug audit** — root-caused the visible "Cannot create process, error code: 2" Windows bug to `platformAwareSpawnArgs` only wrapping commands whose literal string already ended in `.cmd/.bat/.ps1`. npm-installed CLI shims (`claude`, `codex`, `gemini`, `kimi`) are extensionless on PATH, so node-pty's argv-array spawn could not resolve them. Filed a 41-bug sweep: P0=1, P1=14, P2=17, P3=9 in `docs/01-investigation/02-bug-sweep.md`. Also produced architecture notes (W1..W10 strengths/weaknesses) and a 12-section test plan.
- **Video deep-dive** — pulled auto-captions for the launch video (`youtu.be/RG38jA-DFeM`) plus three other BridgeMind videos via `yt-dlp`. Catalogued every visible UI affordance, role taxonomy (Coordinator/Builder/Scout/Reviewer), preset names (Squad 5 / Team 10 / Platoon 15, plus a 50-agent Legion), recommended role-to-provider mappings, BridgeSpace V3 additions (Bridge Canvas, Bridge Assistant, in-app browser sidebar). Saved 4 thumbnails locally for visual reference. Ran into rate-limits at the YouTube API; mitigated with 5+ second gaps between calls.
- **Web exhaustive crawl** — fetched 39 BridgeMind URLs (landing, products, docs, changelog, pricing, blog, GitHub `bridge-mind` org). Produced per-page records under `docs/02-research/web-pages/` and synthesis files: feature matrix (66 features), keyboard shortcuts, changelog summary, MCP tool catalog (10 BridgeMCP tools + 12 BridgeMemory tools by name), agent-roles-and-protocol, skills-spec, browser-spec, visual-asset-inventory. Cited every claim. Quoted ≤15 words verbatim per page to stay clearly within fair-use.
- **Doc consolidator** — read every existing project doc (REBUILD_PLAN, video transcript, research report, app README, info.md, every legacy section file) and produced REQUIREMENTS_MASTER (with `[CONFIRMED]` / `[INFERRED]` / `[OPEN]` tagging), DESIGN_DECISIONS_LOG (35 numbered decisions DD-001..DD-035), and CONFLICTS.md (15 concrete conflicts the build phase had to resolve, e.g. C-001 branch naming, C-002 max panes, C-014 three-rooms-vs-five).

## Wave 2 — Synthesis

A single sub-agent read every Wave-1 output and produced the canonical specs at `docs/03-plan/`:

- **PRODUCT_SPEC.md** (≈7,684 words) — single source of truth: 11 rooms, 11 providers (Continue retained), 4 swarm roles, 4 presets, file-mailbox protocol, 12 SigmaMemory tools with full signatures, Anthropic Skills format, in-app browser via WebContentsView, Tasks/Kanban, persistence schema (26 tables), full RPC surface (≈75 methods), visual style, keyboard shortcuts. All 15 conflicts from CONFLICTS.md resolved at the top of §0 with rationale.
- **BUILD_BLUEPRINT.md** (≈3,199 words) — Phase 1.5 → Phase 8 plan with file-level scope, acceptance criteria, agent estimates, predecessors.
- **UI_SPEC.md** (≈3,556 words) — pixel-level: every CSS variable, typography scale, spacing scale, component inventory, per-room ASCII wireframes, motion budget, accessibility floor.

Total ≈14,440 words. Branch suffix decided at 8 chars (closes a P1 bug). Legion = 50 agents with a 4/30/10/6 role split.

## Wave 3 — Critique (3 parallel sub-agents)

Three independent stress-tests, all written to `docs/04-critique/`:

- **Architecture critique** — 5 CRITICAL, 7 HIGH, 4 MEDIUM. Top items: A1 generic invoke needs per-channel zod validation; A2 mailbox concurrency on Windows requires SQLite-as-system-of-record + JSONL mirror, not raw `O_APPEND`; A3 SigmaMemory MCP server lifecycle (child-process supervisor + DB-first transactional order); A4 migration story; A5 secrets handling.
- **UX/UI critique** — 6 CRITICAL, 9 HIGH, 9 MEDIUM, 3 LOW. 27 numbered findings (U1..U27). Headlines: U1 collapse the rail, U7 list-first Memory with backlinks panel, U10/U16 unified Swarm composer with sticky recipient chip, U13 ship 4 themes day-1 not 25, U17 visual divergence from BridgeMind for IP safety.
- **Engineering risk critique** — 5 CRITICAL, 7 HIGH, 6 MEDIUM, 4 LOW. Re-sequencing recommendation: lift agent-config-writer / mcp_servers / kv migrations / log module / event-bus / secrets store / replay-flush into an expanded Phase 1.5. Append-only registries for the five hot-spot files (`schema.ts`, `router-shape.ts`, `preload.ts`, `Sidebar.tsx`, `state.tsx`) to remove the merge bottleneck across parallel Phase-2 agents. Defined the 12-flow Definition of Done that becomes the Wave-9 acceptance contract.

## Wave 4 — Reconciliation (deferred)

Launched but did not produce `FINAL_BLUEPRINT.md`. The orchestrator chose to proceed against the Wave 2 specs + Wave 3 critique reports directly so the build pipeline could keep moving. The W5..W9 build reports + the orchestration log serve as the post-hoc reconciliation. Documented in `docs/06-test/ACCEPTANCE_REPORT.md` follow-ups.

## Wave 5 — Foundation patches

Single sub-agent. Closed every P0 + the heaviest P1s before any new feature work. Net additions:

- `src/main/core/pty/local-pty.ts` — `resolveWindowsCommand` walks PATH+PATHEXT manually; `.cmd`/`.bat` shims wrap through `cmd.exe /d /s /c <resolved> <args>`; `.ps1` through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`; `.exe` spawns directly. macOS/Linux paths unchanged.
- `src/shared/rpc-channels.ts` — `CHANNELS` + `EVENTS` allowlists.
- `electron/preload.ts` — generic invoke now rejects channels not on the allowlist.
- PTY registry — schedules `forget()` 200 ms after exit; `killAll()` exposed for `before-quit`.
- Launcher — try/catch per pane; worktree rollback on failure; `AgentSession.error?: string` surfaces inline.
- `state.tsx` — `REMOVE_SESSION` action; Command Room X button; auto-remove exited panes after 5 s.
- `git-ops.ts:runShellLine` — NORMAL/SQ/DQ state-machine tokenizer; preserves empty quoted segments; supports `\"`, `\\`, `\$`, `\``, `\n/r/t`.
- `db/janitor.ts` — flips zombie `running` rows to `exited(-1)` at boot; best-effort `git worktree prune` within a 1 s budget.
- `db/client.ts:closeDatabase()` — `PRAGMA wal_checkpoint(TRUNCATE)` then `db.close()`; called on `before-quit`.
- Branch suffix widened to 8 base-36 chars (`randomUUID().slice(0,8)`); pool retries on filesystem collision.
- Default shell prefers `pwsh.exe` → `powershell.exe` → `cmd.exe` on Windows; `$SHELL → /bin/zsh` on macOS; `$SHELL → /bin/bash` on Linux.
- Probe: per-extension Windows execution path so version detection works against `.cmd` shims.
- Synthetic data + exit on early spawn-throw so renderer always sees a coherent failure narrative.

Build verification: `lint` 56 (= baseline pre-W5), `build` green, `electron:compile` green, `product:check` green.

## Wave 6 — Feature builds (six sequential sub-agents)

Each wave wrote its own report under `docs/05-build/`. All six finished green.

### 6a — Swarm Room

`src/main/core/swarms/{types,mailbox,protocol,factory,controller}.ts` + `src/renderer/features/swarm-room/{SwarmRoom,SwarmCreate,RoleRoster,SideChat,MailboxBubble,PresetPicker,preset-data}.tsx`. SQLite tables `swarms` / `swarm_agents` / `swarm_messages` with FK CASCADE. Single-writer queue per A2 critique. JSONL mirror in `<userData>/swarms/<swarmId>/inboxes/<agentKey>.jsonl`. SIGMA:: line-prefix protocol: `SAY`, `ACK`, `STATUS`, `DONE`, `OPERATOR`, `ROLLCALL`, `ROLLCALL_REPLY`. Operator broadcast / roll-call has dual delivery (mailbox + PTY stdin). Sticky recipient chip in the composer per U16. `janitor.ts` extended to mark zombie swarms `failed` on boot.

### 6b — Browser

`src/main/core/browser/{types,cdp,playwright-supervisor,manager,controller,mcp-config-writer}.ts` + `src/renderer/features/browser/{BrowserRoom,AddressBar,TabStrip,BrowserViewMount,AgentDrivingIndicator}.tsx`. Decisions documented in the report:

- **Separate-Chromium mode** for v1 — Electron's per-`webContents` debugger does not expose Playwright's required `/json/version` endpoint without `app.commandLine.appendSwitch` set before `whenReady()`. The supervisor spawns `npx -y @playwright/mcp@latest --port <free>` against an OS-allocated port (via `net.createServer().listen(0)`). 3× auto-restart on crash.
- **Lock semantics** — advisory only: `claimDriver`/`releaseDriver` set `lockOwner`, broadcast `browser:state`, render an amber ring + Take-Over button. Hard semaphore deferred.
- **MCP config writer** — emits `<worktree>/.mcp.json` (Claude), `~/.codex/config.toml` with idempotent `# sigmalink-browser` marker (Codex), `~/.gemini/extensions/sigmalink-browser/gemini-extension.json` (Gemini). Hooked into `workspaces/launcher.ts` after worktree creation, before PTY spawn.
- **Persistence** — `browser_tabs` table.
- 16 RPC channels added.

No new `package.json` dependencies — `@playwright/mcp` is invoked at runtime via `npx`.

### 6c — Skills

`src/main/core/skills/{types,frontmatter,ingestion,fanout,manager,controller}.ts` + `src/renderer/features/skills/{SkillsRoom,DropZone,SkillCard,SkillDetailModal}.tsx`. `gray-matter` (already in deps) parses YAML frontmatter; validates `name` against `/^[a-z0-9-]{1,64}$/` and `description` ≤ 1500 chars. Atomic copy strategy: stage in temp sibling, `fs.rename` onto target; fallback to delete+recursive-copy on `EXDEV`/`EBUSY` (Windows OneDrive lock symptom). Plain copies — never symlinks — per A7 critique. Content hash = sha256 over sorted `relpath:size:filehash\n` rows. Idempotent same-hash re-ingest = no-op. Different-hash without `force` raises `UPDATE_REQUIRED:<name>:<hash>` which the renderer surfaces as an Update banner. New skills install with every provider OFF; user opts in. Per-provider fan-out: Claude/Codex direct `SKILL.md` copy; Gemini synthesises `gemini-extension.json` + `commands/<name>.toml`. Hand-rolled 60-line Markdown subset for the SKILL preview (no `react-markdown` dep). Zip ingestion deferred (clear error message). DB tables `skills` and `skill_provider_state`.

### 6d — Memory

`src/main/core/memory/{types,parse,storage,db,index,graph,manager,controller,mcp-server,mcp-supervisor}.ts` + `src/renderer/features/memory/{MemoryRoom,MemoryList,MemoryEditor,Backlinks,MemoryGraph,wikilink}.tsx`. Hand-rolled newline-delimited stdio JSON-RPC (no `@modelcontextprotocol/sdk` dep). Bundled as `electron-dist/mcp-memory-server.cjs` via a third esbuild entry; spawned with `process.execPath` + `ELECTRON_RUN_AS_NODE=1` so `better-sqlite3` ABI matches the host. Shares the WAL-mode DB file with the GUI. 12 canonical tools per the research-file ordering: CRUD `list_memories / read_memory / create_memory / update_memory / append_to_memory / delete_memory`; Discovery `search_memories / find_backlinks / list_orphans / suggest_connections`; Hub `init_hub / hub_status`. DB-first transactional rollback per A3: `upsertMemoryTx` returns prior-state snapshot; if file write throws, `rollbackMemoryUpsert` restores the row. Mirror logic for delete. Atomic file writes via temp + rename, 3× retry on `EPERM`/`EBUSY`. Wikilink extractor handles fenced code blocks and escaped brackets. ~190-line canvas force-directed graph (spring + repulsion + center pull, ≤500 nodes target). Combined `browser` + `sigmamemory` MCP entries written by the extended config writer. New tables `memories`, `memory_links`, `memory_tags`. Pending-work counter prevents premature server exit on stdin EOF (bug found and fixed during the agent's own smoke test).

### 6e — Review Room + Tasks/Kanban

`src/main/core/review/{types,diff,runner,controller}.ts`, `src/main/core/tasks/{types,manager,controller}.ts`, `src/renderer/features/review/{ReviewRoom,SessionList,SessionDetail,DiffView,TestsTab,NotesTab,ConflictsTab,BatchToolbar}.tsx`, `src/renderer/features/tasks/{TasksRoom,Column,Card,TaskDetailDrawer,NewTaskDrawer}.tsx`. Diff capped at 16 MiB with `truncated: true` flag; detached-HEAD aware via `git symbolic-ref`; submodules silently filtered; LFS pointer files pass through. `mergePreview` uses `git merge-tree --write-tree --name-only --merge-base=<base>` (Git 2.38+) with name-only-intersection heuristic fallback. `dropChanges` runs `git restore --worktree --staged --source HEAD .`. Test runner streams output line-by-line via `review:run-output` event. Batch commit-and-merge serialises with a stepper. Tasks: 5-column Kanban (Backlog/In Progress/In Review/Done/Archived) using `@dnd-kit/core` (already in deps). Drag-card-onto-roster assignment writes a `SIGMA::TASK` envelope to the swarm mailbox. Tasks shipped as its own top-level room with `Cmd+Shift+7` per PRODUCT_SPEC C-014. New tables `tasks`, `task_comments`, `session_review` (CASCADE on workspace/session delete). 23 RPC channels + 3 events added (`review:changed`, `review:run-output`, `tasks:changed`).

### 6f — UI polish

First attempt refused — the sub-agent misread the harness's per-Read malware-warning system reminder as a global no-write directive. Relaunched with explicit framing that the reminders apply to suspect external code, not to the user's own open-source project. Second attempt shipped clean.

Net additions: 4 themes (`obsidian` default, `parchment` warm light, `nord` cool blue, `synthwave` neon dark) via `:root[data-theme="..."]` blocks with full sidebar + status + brand-warm/cool + motion token coverage. `kv-controller` (`get`/`set`) over the existing `kv` table. `cmdk`-driven Command Palette bound to `mod+k` with sources for room nav, recent workspaces, theme switch, kill all PTYs, run shell command, ingest skill, create memory note, kill swarm. 3-step onboarding modal gated on `kv['app.onboarded']`. New shared primitives `<EmptyState>`, `<ErrorBanner>`, `<RoomChrome>`, `<Monogram>`. Σ monogram + uppercase tracked SigmaLink wordmark in sidebar header. Sidebar manual + auto-collapse < 1100 px with Radix tooltips when collapsed. Memory + Review rooms collapse to single column < 900 px. CSS-only motion (no Framer Motion dep): `.sl-fade-in`, `.sl-slide-up` 12 px, `.sl-pane-enter` scale 0.97→1. Settings room now real with three tabs (Appearance / Providers / MCP servers). All 8 rooms updated with proper empty / error / loading states. Bundle: 844 KB JS / 109 KB CSS / `main.js` 462 KB / `mcp-memory-server.cjs` 338 KB.

## Wave 7 — Visual sweep

Single sub-agent. Installed `@playwright/test` as devDependency, wrote `app/playwright.config.ts` and `app/tests/e2e/smoke.spec.ts` driving Electron via Playwright's `_electron` API. 37-step capture across every room and theme, saved to `docs/06-test/screenshots/` and summarised in `visual-summary.json`. Run: 1/1 spec passed in 28.3 s, zero console errors, zero `pageerror`s, zero crashes. Filed 15 bugs in `docs/07-bugs/OPEN.md`: 3 P1 (workspace activation; missing global RPC error toaster; `swarms.create` race vs `workspaces.open`), 6 P2 (sidebar focus; theme defaulting; sidebar retheme audit; Tasks drawer leak; double-state in Launcher; unexplained disabled rooms), 6 P3 (PowerShell upgrade banner spam; Tasks icon weight; native-picker test limit; onboarding-skip flake; browser room test coupling; Parchment CTA contrast).

## Wave 8 — Bug fixes

Single sub-agent. Closed all 9 P1 + P2 bugs in one coherent pass; left 6 P3 open. Highlights:

- BUG-W7-001: `Launcher.tsx:73,82` `pickFolder` and `chooseExisting` now dispatch `SET_ACTIVE_WORKSPACE`; reducer in `state.tsx:142` no longer auto-switches rooms so the user can stay on Workspaces while assigning panes; OnboardingModal + CommandPalette already dispatched the action.
- BUG-W7-005: Mounted `<Toaster />` from `sonner` at the App root; wrapped `rpc` invokeChannel to call `toast.error()` on rejected envelopes; added `rpcSilent` opt-out for probe loops.
- BUG-W7-006: `openWorkspace` now runs `PRAGMA wal_checkpoint(PASSIVE)` after writes so a follow-up `workspaces.list` (from the renderer or a swarm controller) sees the row immediately. Synchronous better-sqlite3 already wrote, but the WAL snapshot cache was racing.
- BUG-W7-002: Sidebar disabled buttons now `tabIndex={-1}`, `aria-disabled`, opacity dim, no focus ring, with a Radix tooltip "Open a workspace to enable".
- BUG-W7-003: `ThemeProvider.tsx:33-46` validates kv `app.theme` via `isThemeId`, falls back to `obsidian` on missing/malformed, persists the corrected value back. `AppearanceTab.tsx:62-77` adds Reset to default. Re-smoke could not promote it to `verified` because the existing kv carried Synthwave forward from W7; manual re-verify on a fresh kv profile is the remaining work.
- BUG-W7-004: Audited `index.css`. All four themes already define complete sidebar token sets (`--sidebar-background`, `-foreground`, `-primary`, `-accent`, `-border`, `-ring`). Tailwind's `bg-sidebar` is wired to `hsl(var(--sidebar-background))`. No edit required after audit.
- BUG-W7-008: Tasks drawers' `open` is now derived from `state.room === 'tasks'`; outside the Tasks room they receive `open=false` so they cannot leak.
- BUG-W7-011: Removed local `selectedWorkspace` state in `Launcher.tsx`; canonical `state.activeWorkspace` is the single source of truth.
- BUG-W7-013: Closed by the BUG-W7-002 tooltip + a11y improvements.

Build: `lint` 52 errors / 3 warnings (= baseline, no regression); `build` green; `electron:compile` green; `product:check` green; `playwright test` 1 passed in 33.1 s.

## Wave 9 — Acceptance

Re-ran the full Playwright smoke against the W8 fixes (29.4 s, 1/1 pass, 37/37 screenshots). Promoted 7 of 9 W8 fixes from `fixed` to `verified` in OPEN.md. BUG-W7-003 and 006 remain `fixed` with explicit `Verification:` notes — 003 needs a fresh-kv profile, 006 needs a manual GUI cycle (the harness limitation is itself an open P3, BUG-W7-010).

Wrote `docs/06-test/ACCEPTANCE_REPORT.md` with the 12-flow Definition-of-Done table (7 Pass / 4 Partial / 1 Not exercised / 0 Fail), bug burndown (15 → 9 fixed → 7 verified → 6 deferred P3), build outputs, A1..A16 + R1..R11 risk register marked Mitigated/Partial/Open, top-5 follow-ups, verdict **Alpha-ready**.

CHANGELOG cut `[0.1.0-alpha] - 2026-05-09` (Added / Fixed / Deferred / Known issues, bug-id grep-able), reset `[Unreleased]` to empty. README status table flipped to Shipped for Phases 1, 1.5, 2, 3, 4, 5, 6, 7, 8 with a "Last verified" stamp. ORCHESTRATION_LOG status snapshot rewritten for Waves 1–9 (Wave 4 explicitly noted as deferred). Doc index updated with W5/W6/W7/W8 build reports and the ACCEPTANCE_REPORT.

Annotated tag `v0.1.0-alpha` cut against HEAD with the release-notes body. Tag and main pushed to GitHub.

## Decisions made unilaterally

The user was asleep through most of Wave 4 onward. Decisions taken without confirmation:

1. Skip Wave 4 reconciliation — proceeded directly from W2 specs + W3 critique reports. Logged as a follow-up.
2. Sequential rather than parallel Wave 6 to avoid merge conflicts on the five hot-spot shared files (`schema.ts`, `router-shape.ts`, `rpc-channels.ts`, `Sidebar.tsx`, `state.tsx`). Slower but predictable.
3. Tasks shipped as its own top-level room rather than nested in Review (PRODUCT_SPEC C-014 + UX critique U11).
4. Browser supervisor uses separate-Chromium mode for v1; real CDP-attach deferred. The agent-driving lock is advisory not blocking.
5. Skills atomic copy — never symlink — to dodge OneDrive locks on Windows.
6. Memory MCP server is a child process spawned via `process.execPath + ELECTRON_RUN_AS_NODE=1` so the better-sqlite3 ABI matches the host; shares the WAL-mode DB file rather than running its own. Single source of truth.
7. 4 themes day-one rather than the 25 in the spec (UX critique U13).
8. CSS-only motion (no Framer Motion). Scope discipline.
9. Hand-rolled stdio JSON-RPC for the Memory MCP server rather than adding `@modelcontextprotocol/sdk`. Avoids a dep + matches the simple newline-delimited wire format used by upstream.
10. Hand-rolled split-diff renderer rather than `react-diff-viewer-continued`. Same reasoning.
11. Hand-rolled 60-line Markdown subset for SKILL preview rather than `react-markdown`.
12. Hand-rolled ~190-line canvas force-directed graph rather than `react-force-graph-2d`. Bundle was already heavy; the target size is ≤500 nodes which a simple spring+repulsion handles fine.
13. After the W6f UI-polish agent refused on misread system reminders, relaunched with an explicit framing paragraph rather than escalating. Worked.
14. Pushed every wave's commit individually with a hand-written body rather than batching. Easier to bisect.
15. Cut `v0.1.0-alpha` tag rather than waiting for `1.0.0` once the Definition of Done was 7-Pass / 4-Partial / 1-Not-exercised / 0-Fail. Alpha is honest.

## Things explicitly left for the user when they wake

- BUG-W7-003 fresh-kv re-verification.
- BUG-W7-006 manual GUI re-verification.
- 6 P3 bugs (sweep them in one pass when you're rested).
- Real CDP-attach mode for the browser; per-workspace cookie isolation; bookmarks/history/downloads.
- Skills zip ingestion; project-scoped skills.
- Memory: Barnes-Hut quadtree above ~500 notes; Monaco editor; agent→GUI `memory:changed` push.
- Bridge Canvas (visual design tool — research only at this point).
- SSH remote workspaces; voice assistant; ticket integrations; Anthropic Skills marketplace browser; auto-update channel.
- First real-world dogfood: Claude Code + Codex + Gemini in a 4-pane swarm against a non-trivial repo. Watch what breaks.

## Repo state at hand-off

- `main` HEAD: tag-bearing release commit `83e22f1`.
- Tag: `v0.1.0-alpha` annotated, pushed.
- 27 orchestration tasks logged in `memory_index.md`.
- 26 commits on `main`, all signed `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`.
