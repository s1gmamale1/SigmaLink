# SigmaLink — Master Memory

Long-form record of the orchestrated build. Pair with [`memory_index.md`](memory_index.md) for the compact task table and with [`./ORCHESTRATION_LOG.md`](./ORCHESTRATION_LOG.md) for the per-wave operating log.

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

Three independent stress-tests, all written to `../05-critique/`:

- **Architecture critique** — 5 CRITICAL, 7 HIGH, 4 MEDIUM. Top items: A1 generic invoke needs per-channel zod validation; A2 mailbox concurrency on Windows requires SQLite-as-system-of-record + JSONL mirror, not raw `O_APPEND`; A3 SigmaMemory MCP server lifecycle (child-process supervisor + DB-first transactional order); A4 migration story; A5 secrets handling.
- **UX/UI critique** — 6 CRITICAL, 9 HIGH, 9 MEDIUM, 3 LOW. 27 numbered findings (U1..U27). Headlines: U1 collapse the rail, U7 list-first Memory with backlinks panel, U10/U16 unified Swarm composer with sticky recipient chip, U13 ship 4 themes day-1 not 25, U17 visual divergence from BridgeMind for IP safety.
- **Engineering risk critique** — 5 CRITICAL, 7 HIGH, 6 MEDIUM, 4 LOW. Re-sequencing recommendation: lift agent-config-writer / mcp_servers / kv migrations / log module / event-bus / secrets store / replay-flush into an expanded Phase 1.5. Append-only registries for the five hot-spot files (`schema.ts`, `router-shape.ts`, `preload.ts`, `Sidebar.tsx`, `state.tsx`) to remove the merge bottleneck across parallel Phase-2 agents. Defined the 12-flow Definition of Done that becomes the Wave-9 acceptance contract.

## Wave 4 — Reconciliation (deferred)

Launched but did not produce `FINAL_BLUEPRINT.md`. The orchestrator chose to proceed against the Wave 2 specs + Wave 3 critique reports directly so the build pipeline could keep moving. The W5..W9 build reports + the orchestration log serve as the post-hoc reconciliation. Documented in `../07-test/ACCEPTANCE_REPORT.md` follow-ups.

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

Each wave wrote its own report under `../06-build/`. All six finished green.

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

Single sub-agent. Installed `@playwright/test` as devDependency, wrote `app/playwright.config.ts` and `app/tests/e2e/smoke.spec.ts` driving Electron via Playwright's `_electron` API. 37-step capture across every room and theme, saved to `../07-test/screenshots/` and summarised in `visual-summary.json`. Run: 1/1 spec passed in 28.3 s, zero console errors, zero `pageerror`s, zero crashes. Filed 15 bugs in `../08-bugs/OPEN.md`: 3 P1 (workspace activation; missing global RPC error toaster; `swarms.create` race vs `workspaces.open`), 6 P2 (sidebar focus; theme defaulting; sidebar retheme audit; Tasks drawer leak; double-state in Launcher; unexplained disabled rooms), 6 P3 (PowerShell upgrade banner spam; Tasks icon weight; native-picker test limit; onboarding-skip flake; browser room test coupling; Parchment CTA contrast).

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

Wrote `../07-test/ACCEPTANCE_REPORT.md` with the 12-flow Definition-of-Done table (7 Pass / 4 Partial / 1 Not exercised / 0 Fail), bug burndown (15 → 9 fixed → 7 verified → 6 deferred P3), build outputs, A1..A16 + R1..R11 risk register marked Mitigated/Partial/Open, top-5 follow-ups, verdict **Alpha-ready**.

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

## Status snapshot — what's ready / what's left at v0.1.0-alpha

This is the canonical ready/left ledger for the alpha. Pair with `CHANGELOG.md` for the keep-a-changelog history and `../07-test/ACCEPTANCE_REPORT.md` for the smoke-flow Definition-of-Done table.

### What's ready (shipped + tagged on GitHub `v0.1.0-alpha`, commit `83e22f1`)

**Foundation**
- Electron + Vite + React 19 + TypeScript app; 11 providers; real PTYs; Git worktree pool; SQLite via Drizzle; typed RPC bridge with channel allowlist.
- Cross-platform PTY: Windows `.cmd` shim resolver via PATH+PATHEXT, `pwsh → powershell → cmd.exe` default-shell preference; macOS/Linux honour `$SHELL`.
- Boot janitor (zombie-row reaper + best-effort `git worktree prune`), graceful DB close with `PRAGMA wal_checkpoint(TRUNCATE)`, 256 KiB ring-buffer per terminal session.

**Rooms**
- Workspaces launcher — pick a folder, choose a 1/2/4/6/8/10/12/14/16-pane preset, assign a provider per pane, recents list, native folder picker.
- Command Room — mosaic / columns / focus layouts, X-to-remove, auto-remove on exit, sl-pane-enter motion.
- Swarm Room — 4 roles (Coordinator / Builder / Scout / Reviewer), Squad / Team / Platoon / Legion presets, mailbox bus (SQLite + JSONL mirror), side chat with sticky recipient chip, broadcast, roll-call, dual-delivery (durable mailbox + PTY stdin).
- Browser — `WebContentsView` pane, tab strip, address bar, `@playwright/mcp` supervisor (separate-Chromium mode), agent-driving lock with Take Over.
- Skills — drag-drop SKILL.md folder, gray-matter frontmatter validation, sha256 content hash, atomic temp+rename copies, fan-out to `~/.claude/skills/`, `~/.codex/skills/`, synthesised `~/.gemini/extensions/sigmalink-<name>/`.
- Memory — 12 MCP tools over hand-rolled stdio JSON-RPC, `.sigmamemory/<note>.md` atomic writes, wikilinks with `[[name]]` and `[[name|alias]]` syntax, backlinks panel, ~190-line canvas force-directed graph.
- Review Room — Diff / Tests / Notes / Conflicts tabs, hand-rolled split or unified diff renderer, batch commit & merge with stepper, `merge-tree` conflict prediction.
- Tasks Kanban — 5 columns (Backlog / In Progress / In Review / Done / Archived), `@dnd-kit/core`, drag-card-onto-roster assignment writes a `SIGMA::TASK` envelope.
- Settings — Appearance / Providers / MCP servers tabs.

**Polish**
- 4 themes: `obsidian` default, `parchment` warm light, `nord` cool blue, `synthwave` neon dark. Reset-to-default in Settings.
- Command palette `Cmd+K` via `cmdk` with sources for navigation, recent workspaces, theme switch, kill all PTYs, run shell command, ingest skill, create memory note, kill swarm.
- 3-step onboarding modal gated on `kv['app.onboarded']`.
- Sonner global error toaster auto-firing on rejected RPC envelopes; `rpcSilent` opt-out for probe loops.
- Σ monogram + uppercase tracked SigmaLink wordmark; sidebar manual + auto-collapse below 1100 px with Radix tooltips when collapsed; Memory + Review collapse to single column below 900 px; CSS-only motion tokens + keyframes (`sl-fade-in`, `sl-slide-up`, `sl-pane-enter`).

**Testing**
- Playwright `@electron` harness at `app/tests/e2e/smoke.spec.ts`; 37-step capture across every room and every theme.
- 0 console errors, 0 page errors, 0 crashes, 29.4 s.
- 12-flow Definition-of-Done table: 7 Pass / 4 Partial / 1 Not exercised / 0 Fail.

**Repo**
- README, LICENSE (MIT), CONTRIBUTING, SECURITY, CODE_OF_CONDUCT (Contributor Covenant 2.1 pointer), CHANGELOG (Keep-a-Changelog), ATTRIBUTIONS, .editorconfig, `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md`, `PULL_REQUEST_TEMPLATE.md`, `docs/README.md` index. GitHub metadata: description + 20 topics, issues on, wiki off.

### What's left

**Promote-to-verified (manual, ~10 min)**
- BUG-W7-003 — re-launch with cleared kv to confirm theme default = `obsidian`.
- BUG-W7-006 — manual GUI cycle to confirm `swarms.create` works immediately after `workspaces.open`.

**P3 bugs still open**
- BUG-W7-007 PowerShell upgrade banner spam in shell panes.
- BUG-W7-009 Tasks icon weight inconsistent with the rest of the sidebar set.
- BUG-W7-010 Smoke spec consumes raw IPC envelope (test-harness only — does not affect product).
- BUG-W7-012 Onboarding-skip flake on slow boot.
- BUG-W7-014 Browser room test coupling.
- BUG-W7-015 Parchment CTA contrast.

**Deferred features (from `CHANGELOG.md` Deferred section)**
- Real CDP-attach mode for the in-app browser (currently separate-Chromium).
- Per-workspace cookie isolation, bookmarks, history, downloads.
- Skills zip ingestion, project-scoped skills, `react-markdown` SKILL preview.
- Memory: Barnes-Hut quadtree above ~500 notes, Monaco editor, agent → GUI `memory:changed` push.
- Bridge Canvas (visual design tool — research only).
- SSH remote workspaces, voice assistant, ticket integrations (Linear / Jira / GitHub).
- Anthropic Skills marketplace browser.
- Auto-update channel (no `electron-updater` wired).
- Native-module rebuild diagnostic for end-users.

**Process leftovers**
- Wave 4 `FINAL_BLUEPRINT.md` was never written; per-phase W5–W9 reports stand in.
- Tasks responsive single-column at narrow widths.
- Per-room tailored skeletons (currently a single shadcn `<Skeleton>`).
- Sonner `<Toaster />` is mounted but no per-room toast strategy.

**Recommended next-session priorities**
1. Add an end-user "Re-probe agents" + native-module rebuild prompt in Settings (covers a real install-failure mode).
2. Wire `electron-updater` so alpha users can pull subsequent fixes.
3. Fix the 6 P3 bugs in one pass.
4. Manually verify BUG-W7-003 + 006 and promote to `verified`.
5. First real-world dogfood: launch Claude Code + Codex + Gemini in a 4-pane swarm against a non-trivial repo and watch what breaks.

**TL;DR** — alpha is shippable; everything BridgeSpace-parity has a working v1; remaining work is polish, deferred research-grade features (Bridge Canvas, SSH), and one round of dogfood-driven fixes.

## Repo state at hand-off

- `main` HEAD: tag-bearing release commit `83e22f1` (Wave 9 acceptance).
- Tag: `v0.1.0-alpha` annotated, pushed.
- 27 orchestration tasks logged in `memory_index.md`.
- 27+ commits on `main`, every wave commit signed `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`.

## Phase 2 — V3 parity build (Waves 10-16, May 2026)

After v0.1.0-alpha shipped, a Node 26 + npm 11 install bug blocked the local smoke; W10 spent its budget restoring `node_modules`. The user then shared *Vibe Coding With BridgeSpace 3*, and the orchestration pivoted to V3 parity. W12-15 ran as parallel-agent waves against `docs/03-plan/V3_PARITY_BACKLOG.md` (45 tickets). v1.0.0 is feature-complete, release-blocked pending CI matrix run + user authorisation for the tag.

### Wave 10 — boot self-check + Diagnostics tab

Restored the corrupt `node_modules/electron`. Shipped a boot self-check for `better-sqlite3` ABI mismatches, a `NativeRebuildModal` prompting `npm rebuild`, a Re-probe banner that re-runs provider PATH probes, and a Settings → Diagnostics tab. Closes critique R3 + risk A12 (both Open at v0.1.0-alpha).

### Wave 11 — V3 frame-by-frame multimodal research

Three multimodal walker agents covered 553 frames at `docs/02-research/frames/v3/`; a synthesiser produced 5 canonical research files (`v3-frame-by-frame.md`, `v3-delta-vs-current.md`, `v3-protocol-delta.md`, `v3-providers-delta.md`, `v3-agent-roles-delta.md`). Bridge Assistant verdict: **BUILD, do not defer**. Synthesiser also surfaced Bridge Canvas as first-class, the right-rail dock, Operator Console body, Battalion 20 preset, 9-provider matrix with BridgeCode + Kimi-as-model, 9 new mailbox envelope kinds, and BridgeVoice intake.

### Wave 11.5 — scope freeze

Cut `V3_PARITY_BACKLOG.md` (45 tickets, all grep-able as `[V3-WNN-NNN]`). Surgical PRODUCT_SPEC.md re-baseline: C-016 conflict resolution, §2.2/2.3/3.10 rebuilt, new §3.12/13/14, §4 rewritten with V3 9-provider matrix. CHANGELOG `[Unreleased]` carried the V3 scope-freeze announcement until W16.

### Wave 12 — parallel debt + V3 quick-wins (6 agents, 18 tickets)

Migrations + RPC allowlist scaffolding had to land first so W13-15 never blocked on schema or channel changes. Drizzle Kit journal; 9 mailbox envelope kinds with per-kind zod schemas; new columns `swarm_messages.resolvedAt`, `swarm_agents.autoApprove`, `swarm_agents.coordinatorId`; 17 RPC channels + 5 events; `assistant.*` / `design.*` / `voice:state` / `swarm:*` allowlist groups. BridgeCode stub + Kimi as OpenCode model + Aider/Continue legacy toggle. 3-card launcher + stepper + breadcrumb. Battalion 20 replacing Legion 50; role colour tokens; 5-step swarm wizard; Operator Console TopBar scaffold. `safeStorage` credentials (closes A5). Five P3 bugs closed: BUG-W7-007 / 009 / 010 / 012 / 014.

### Wave 13 — V3 parity sweep + Bridge Assistant (5 agents, 15 tickets)

Right-rail dock (Browser / Editor / Bridge tabs + splitter); Browser recents + click-link-in-pane routing; per-pane chrome variants + multi-pane CSS-grid + `Cmd+Alt+<N>`; Constellation graph (multi-hub via `coordinatorId`); ActivityFeed; structured `task_brief` render; per-agent boards; operator → PTY DM echo; Mission `@<workspaceSlug>` autocomplete; Swarm Skills 12-tile grid. **Bridge Assistant fully built**: 4-state orb + chat + 10 canonical tools (`launch_pane`, `prompt_agent`, `read_files`, `open_url`, `create_task`, `create_swarm`, `create_memory`, `search_memories`, `broadcast_to_swarm`, `roll_call`) + tool tracer + Jump-to-pane toast + completion ding.

### Wave 14 — Bridge Canvas + Editor + auto-update (3 agents, 9 tickets)

Bridge Canvas pipeline (element picker, DesignDock, provider chips with Shift/Alt multi-select, drag-drop asset staging, live-DOM HMR poke, GA toggle). Editor right-rail tab with Monaco lazy-loaded as 14.57 KB chunk separate from the 990 KB main; CodeMirror fallback; `fs.*` RPC. Auto-update via `electron-updater@6.8.3` opt-in; UpdatesTab; NativeRebuildModal; Re-probe banner.

### Wave 15 — voice + CI matrix + plan capabilities (4 agents, 6 of 7 tickets)

BridgeVoice intake: title-bar pill + 3 capture sources (mission, Bridge orb, Command Palette `Cmd+Shift+K`); Web Speech API stub. CI matrix on Win / macOS / Linux under Node 20. Plan capabilities default Ultra. Marketplace stub. **V3-W15-006 dogfood deferred** — needs a real human GUI session.

### Wave 16 — release prep

Release-architect produced the v1.0 doc set with no commit / tag / push actions: `ACCEPTANCE_REPORT_V1.md`, `release-notes-1.0.0.txt`, CHANGELOG `[1.0.0] - 2026-05-10 (PENDING TAG)`, this extension. Build at cut: `tsc -b` clean; `vite build` 990 KB + 14.57 KB Monaco; lint 80/3.

## Status snapshot — v1.0 candidate

Supersedes the v0.1.0-alpha snapshot above. Detailed surface inventory + risk register live in `../07-test/ACCEPTANCE_REPORT_V1.md`; full ticket-level scope in `docs/03-plan/V3_PARITY_BACKLOG.md`.

**Ready**: all Phase 1-8 surfaces from v0.1.0-alpha plus every Wave 12-14 ticket, the W15 voice / CI / plan / marketplace work, and W10 Diagnostics. Bridge Assistant + Bridge Canvas both ship full.

**Release gating**: explicit user authorization for `git tag -a v1.0.0`; W15 CI matrix first green run on Win / macOS / Linux.

**Manual reverify (still `fixed`)**: BUG-W7-003 (theme default on fresh kv); BUG-W7-006 (`swarms.create` race vs `workspaces.open`).

**P3 still open**: BUG-W7-015 (Parchment CTA contrast); BUG-W7-000 (Node 26 + npm 11 install — bypassed by Node 20 CI matrix).

**Top 5 v1.1 follow-ups**: dogfood (V3-W15-006); native voice bindings; macOS notarisation + Win signing; 3-way merge editor + per-line review; promote BUG-W7-003 + 006 to `verified`.

**TL;DR** — v1.0 is feature-complete and release-blocked-pending-user.

---

## Phase 3 — Polish + Differentiators + v1.0.0 release (May 10, 2026)

Three explore agents (bug hunter, V3 design refresher, state auditor) ran in parallel against the Phase 2 codebase, then three Plan agents debated next-phase priorities from contrasting stances (ship-fast / polish-first / differentiate-from-V3). User locked the synthesis: **repair + 2 differentiators → v1.0.0**. Plan filed at `~/.claude/plans/download-a-skill-plugin-that-lexical-pinwheel.md`.

Exploration surfaced three problems Phase 2 missed:
1. **Operator Console fully built but ORPHANED** — 534 LoC of canvas-driven graph with no Sidebar entry, no `RoomSwitch` case, no `RoomId` type entry. Wave 13 acceptance failure that nobody caught.
2. **Two silent P1 bugs**: migration `0002_credentials.ts` exports `id` instead of `name` (runner skips it; credentials table never inits); Gemini MCP config writes `httpUrl` instead of `url` (handshake fails).
3. **Brand drift**: workspace picker still labels cards "BridgeSpace / BridgeSwarm / BridgeCanvas" instead of "SigmaLink / SigmaSwarm / SigmaCanvas".

Two architectural wins ready to harvest cheap:
- Mailbox is **already event-sourced** on disk (`swarm_messages` rows with timestamps) — turn that into Persistent Swarm Replay (V3 cannot match without backend rewrite).
- Bridge Assistant has a tool-tracer; conversations + messages tables exist from W13 migration 0006 but weren't wired in — turn that into cross-session persistence.

### Step 1 — P1 emergency fixes
Migration `0002_credentials` `id`→`name` + registered in `migrate.ts ALL_MIGRATIONS`; self-bootstrap in `core/credentials/storage.ts` removed; Gemini MCP `httpUrl`→`url`. Two new test files: `migrate.spec.ts` (asserts every `0NNN_*.ts` is registered) + `mcp-config-writer.spec.ts` (snapshots Gemini JSON shape with `url`). 6 tests passing. Migration chain `0001 → 0007` unbroken.

### Step 2 — Operator Console rescue
Added `'operator'` to `RoomId` union, `case 'operator':` to `RoomSwitch`, `{id:'operator', label:'Operator Console', icon:Network}` to Sidebar ITEMS, and a palette command. The orphan code's prop contracts were sound — no fallback flag needed. Smoke spec extended. ~40 LoC, 0 new lint errors.

### Step 3 — Brand sweep + CI guard
Substituted "BridgeSpace/BridgeSwarm/BridgeCanvas" → "SigmaLink/SigmaSwarm/SigmaCanvas" in `PickerCards.tsx`, `Launcher.tsx`. Renamed `Sidebar.tsx` + `RightRailTabs.tsx` "Bridge" → "Bridge Assistant". New `scripts/check-brand.sh` exits non-zero on user-visible drift; wired into `lint-and-build.yml` as required step. (RoleRoster, PaneSplash, PaneStatusStrip, AgentsStep had zero in-scope strings — already clean.)

### Step 4 — P2 fix sweep + W7 closeout
PaneHeader z-20 (over PaneSplash z-10); BridgeCode "coming soon" splash branch removed (falls through to generic Claude fallback splash); Playwright supervisor now `await mcpConfigWriter.write(...)` before `start()`; demoted `console.warn` to debug; Codex regex more robust with explicit START/END markers + append-on-no-match fallback; PaneStatusStrip fallback model entries for Droid + Copilot; **react-hooks violations in `TaskDetailDrawer.tsx:35-36` fixed via `useReducer` + ref pattern**. 5 P2 bugs `fixed`; manual W7-003 + W7-006 verification deferred to Step 9.

### Step 5 — Phase 2 atomic commit + lint hygiene
124 uncommitted files staged in **13 logical commits** (planned 11; agent added `chore(gitignore)` first to exclude orchestration dirs and `chore: remove dead Phase-1 _legacy directory` last). The `_legacy/` deletion removed **2,791 LoC** of dead Phase-1 code. Final lint: **54 errors / 0 warnings** (down from 79/3; W9 baseline of 53 within 1). 8 `eslint-disable` lines audited via `simplify` skill — all justified. 16 commits ahead of `v0.1.0-alpha`.

### Step 6 — Persistent Swarm Replay (Differentiator #1) — commit `1e5a0af`
Migration `0008_swarm_replay` adds `swarm_replay_snapshots(id, swarmId, label, frameIdx, createdAt)`. New `core/swarms/replay.ts` `ReplayManager` with `list / scrub / bookmark / listBookmarks / deleteBookmark` + LRU(32) frame cache; `scrub(swarmId, frameIdx)` returns cumulative state at any historical frame. 5 new RPC channels under `swarm.replay.*` + `swarm:replay-frame` event. New `ReplayScrubber.tsx` (range slider + frame counter + bookmark dropdown + swarm picker); Constellation + ActivityFeed accept optional `replayFrame` prop. New "Replays" tab in Operator Console TopBar. **V3 cannot match this** — V3 swarms vanish when the window closes; SigmaLink's mailbox already wrote every envelope to disk.

### Step 7 — Bridge Assistant cross-session persistence (Differentiator #2) — commit `9769b25`
Tool-tracer rewritten from in-memory ring buffer to DB-backed: every tool call persisted to `messages.toolCallId`. New `conversations-controller.ts` with `assistant.conversations.{list,get,delete}` RPC. Migration `0009_swarm_origins` adds `swarm_origins(swarmId, conversationId, messageId, createdAt)` linking table. When the Bridge Assistant invokes `create_swarm`, the resulting swarm gets a `swarm_origins` row keying back to the conversation + tool-call message. New `ConversationsPanel.tsx` left-side sidebar in `BridgeRoom`. New `OriginLink.tsx` widget in Operator Console: when scrubbing a replay, fetches `swarm.origin.get(swarmId)` and shows "Started from Bridge Assistant chat · <date> · Open chat" — clicking jumps to the right conversation, scrolls to the triggering tool-call message, flashes a primary ring. Connective tissue between Steps 2 + 6.

### Step 8 — Smoke + bundle chunks — commit `baede6a`
Smoke spec extended (Steps 2 + 6 + 7 surfaces) — **40/40 Pass**, 0 console errors, 0 page errors. `vite.config.ts` `manualChunks` split: `vendor-react` (227 KB), `vendor-xterm` (333 KB), `vendor-radix` (50 KB), `vendor-cmdk` (45 KB), `vendor-dnd` (38 KB), `vendor-icons` (21 KB). Monaco kept lazy at 14.57 KB. **Main initial bundle: 1025 KB → 311 KB** (70% reduction; well under 700 KB target). `ACCEPTANCE_REPORT_V1.md` verdict flipped to RELEASE-READY-PENDING-USER-AUTH.

### Step 9 — Automated dogfood — commit `3905108`
`dogfood-tester` agent extended `tests/e2e/dogfood.spec.ts` (320 lines, 3 tests) covering Operator Console Replays tab, Bridge Conversations panel, OriginLink mount, Diagnostics tab. Programmatically verified **BUG-W7-003** (per-test fresh-kv Electron launch → Obsidian default theme) and **BUG-W7-006** (open workspace → immediately create swarm → no race). Both promoted from `fixed` → `verified` in `OPEN.md`. **40/40 smoke + 3 dogfood specs PASS**, 0 console errors, 0 page errors, 0 P1/P2 emerged. 2 P3 BUG-DF flagged for v1.1: `BUG-DF-01` (Browser room data-room flicker), `BUG-DF-02` (zod schema stubs missing for `app.tier` + `design.shutdown`). Verdict: **GREENLIGHT-FOR-RELEASE**. DOGFOOD_V1.md filed.

### Step 10 — v1.0.0 tag + GitHub release — commit `28ac378`
Stripped `(PENDING TAG)` from CHANGELOG `[1.0.0] - 2026-05-10`; bumped `package.json` to 1.0.0 (already there from W16); README "Known issues in v1.0" section added. Quick security review: clean (no hardcoded creds; `safeStorage` fallback contract correct; 3 `dangerouslySetInnerHTML` sites verified to escape user content). Annotated tag `v1.0.0` cut, body sourced from `../09-release/release-notes-1.0.0.txt`. **`git push origin main` + `git push origin v1.0.0` succeeded.** GitHub release published at https://github.com/s1gmamale1/SigmaLink/releases/tag/v1.0.0.

Installer build hit the **Node 26 + npm 11 + prebuild-install crash**; worked around with `--config.npmRebuild=false` so electron-builder packed the already-resident native binaries verbatim. Both artefacts produced and attached: `SigmaLink-1.0.0-arm64.dmg` (122 MB), `SigmaLink-1.0.0-arm64-mac.zip` (117 MB). **macOS notarisation skipped** (no Apple Developer ID configured) — v1.0 ships unsigned.

### Post-release: launch path defects discovered + fixed — commit `3caa7c7`

Two issues surfaced when actually launching:

1. **DMG broken**: `Cannot find module 'bindings'` at `app.asar/node_modules/better-sqlite3/lib/database.js:48`. Root cause: `--npmRebuild=false` workaround dropped transitive deps (`bindings`, `prebuild-install`) from the asar bundle. **Hole in boot self-check exposed**: `electron/main.ts` does `require('better-sqlite3')` which loads `database.js` but doesn't trigger inner `require('bindings')` until `new Database(...)` is called. v1.0.1 hotfix needs both fixes.
2. **Source launch broken**: `node_modules/electron/` was a flat directory missing `dist/` and `path.txt`; pnpm hadn't fully linked the binary from its `.pnpm/electron@30.5.1/...` stash. **Non-destructive fix**: two symlinks from flat path to pnpm stash. Verified: app launches with all helper processes spawning, no errors.

Wrote **`/Users/aisigma/projects/SigmaLink/RUNNING.md`** (131 lines) documenting the verified launch sequence:
- Quickstart: `cd app && node node_modules/electron/cli.js electron-dist/main.js`
- First-time setup: pnpm install → build → @electron/rebuild → symlink fix
- 5 troubleshooting recipes
- Why `pnpm exec electron .` fails (wrapper trap + Node 26/npm 11 crash)
- Why the v1.0.0 DMG is broken (bindings dropped from asar)

### Lessons stored to AgentDB (`agentdb_pattern-store`)

6 patterns saved for future-session recall:
- `error-recovery`: Node 26 + npm 11 + better-sqlite3@12.9.0 install crash workaround
- `error-recovery`: pnpm exec electron wrapper trap
- `error-recovery`: missing `electron/path.txt` symlink fix from `.pnpm/` stash
- `build-defect`: v1.0.0 DMG `bindings` missing → v1.0.1 fix path
- `orchestration-pattern`: sub-agents don't truly block on inbox SendMessages — every agent prompt must include concrete initial work
- `project-state`: SigmaLink v1.0.0 differentiators + known issues snapshot

Future Claude Code sessions will recall these via `agentdb_pattern-search` when they hit similar errors.

## Status snapshot — v1.0.0 SHIPPED

Supersedes the v1.0-candidate snapshot above.

- **`main` HEAD**: `3caa7c7` (RUNNING.md commit, local only) → `28ac378` (release commit, pushed).
- **Tag**: `v1.0.0` annotated, pushed to `origin`.
- **Commits since `v0.1.0-alpha`**: 22 (21 pushed + 1 local).
- **GitHub release**: https://github.com/s1gmamale1/SigmaLink/releases/tag/v1.0.0 (published, not draft).
- **Build**: `tsc -b` clean; `vite build` 311 KB main + 6 vendor chunks + 14.57 KB Monaco lazy.
- **Lint**: 54 errors / 0 warnings (= ceiling, pinned in CI).
- **Smoke**: 40/40 + 3 dogfood specs Pass, 0 console errors, 0 page errors.
- **Bug ledger**: 0 P1, 0 P2, 2 P3 (`BUG-DF-01` Browser flicker, `BUG-DF-02` zod stubs). BUG-W7-003 + BUG-W7-006 promoted to `verified`.
- **DMG status**: ⚠ broken at runtime (`bindings` missing). Yank or replace in v1.0.1 hotfix.
- **Source launch**: ✓ verified via `node node_modules/electron/cli.js electron-dist/main.js` after symlink fix; documented in `RUNNING.md`.

**Top v1.0.1 hotfix priorities**: rebuild DMG with `bindings` + `prebuild-install` as explicit deps; strengthen boot self-check to actually instantiate `new Database(':memory:')` + `node-pty.spawn`; resolve Browser room data-room flicker; backfill 2 missing zod schemas.

**Top v1.1 priorities**: macOS notarisation (Apple Developer ID); native voice bindings (macOS Speech / Win SAPI / Linux PocketSphinx); BridgeCode multi-provider dispatch when BridgeMind ships the SKU; Skill marketplace live install from GitHub URL; three-way merge editor (Review Room v2); first real-world dogfood with screen recording.

**TL;DR** — v1.0.0 SHIPPED via tag + GitHub release. Source launch verified end-to-end. Bundled DMG has a known defect blocked behind v1.0.1 hotfix. Two world-first differentiators (Persistent Swarm Replay + Bridge Assistant cross-session memory) are live and exercise architectural advantages V3 cannot match.

---

## Phase 4 — v1.0.1 hotfix shipped + research wave for v1.1.0 (May 10, 2026)

User report after using v1.0.0: macOS traffic-light buttons overlap "SigmaLink" wordmark on sidebar header; CLI agent panes have misaligned text on first paint. These plus the known DMG `bindings` defect + 2 P3 BUG-DF items defined Phase 4 Step 1 (v1.0.1 hotfix). User then defined the broader Phase 4 scope autonomously: full app testing → bug-fix → Agent IPC reliability + SigmaVoice native + Ruflo MCP integration. Plan retired Phase 3's contents; new 7-step plan saved at `~/.claude/plans/download-a-skill-plugin-that-lexical-pinwheel.md`. User stance locked via AskUserQuestion: synthesis sequencing (v1.0.1 hotfix THEN demo-first features), macOS-only voice in v1.1, both push-to-talk AND wake-word (default OFF, opt-in).

### Step 1 — v1.0.1 hotfix shipped — commits `1f457ce` `9ce61e3` `52123a8` `4afd109` (tag `v1.0.1`)

Three explore agents in parallel (UI defect audit + voice/skills state + Ruflo opportunities) found that:
- `Sidebar.tsx:104-117` had no left padding for macOS traffic lights; user-reported overlap was real.
- `Terminal.tsx:153` `requestAnimationFrame`-deferred `fit.fit()` could fire while GridLayout was still flex-shrinking → cells one column off until first window resize.
- `0002_credentials.ts` migration ID typo (already fixed in P3); `httpUrl` Gemini MCP typo (already fixed in P3).

Five fixes shipped in v1.0.1:
1. **DMG `bindings` defect**: tried 3 escalating asarUnpack patterns (`**/*.node`, `node_modules/<pkg>/**`, `node_modules/.pnpm/**/<pkg>/**`); only `node-pty` ever unpacked correctly because electron-builder special-cases it. **Root cause unresolved**: how pnpm's content-addressed `node_modules` interact with electron-builder's pattern matcher. **Workaround**: `asar: false` in `electron-builder.yml` AND deleted the duplicate `build` block in `package.json` that was overriding the YAML and re-enabling asar. Cost ~50 MB extra DMG; benefit is 100% guaranteed native modules load. Boot self-check hardened to actually instantiate `new Database(':memory:')` + `node-pty.spawn().kill()` so the inner `require('bindings')` failure is caught at boot rather than first DB write.
2. **Sidebar traffic-light overlap**: 28-px draggable spacer at top of sidebar on macOS only (`PLATFORM_IS_MAC` exported from `lib/shortcuts.ts`); spacer hidden on Win/Linux.
3. **Terminal text alignment**: dropped `requestAnimationFrame` defer; `ResizeObserver` now gates `fit()` on non-zero `contentRect` dimensions and runs the first fit synchronously when container measures non-zero. Subsequent debounce 50→25 ms.
4. **BUG-DF-02**: zod schemas `app.tier` (`enum(['basic','pro','ultra'])` — corrected from plan's `['free','pro','ultra']` to match real `Tier` union) + `design.shutdown` (`z.void()`).
5. **BUG-DF-01**: `BrowserViewMount.tsx` + `TabStrip.tsx` + `BrowserRecents.tsx` wrapped in `React.memo` with content-aware comparators; `setBounds` IPC dedup'd against last-sent rect. Eliminates the cascade triggered by `browser:state` ticks on every `page-title-updated`.

Repo cleanup (commit `52123a8`): deleted 4× `.DS_Store`, `app/info.md` (init scaffold), `app/package-lock.json` (stale npm lockfile), 3 one-shot setup scripts (`patch-main.cjs`, `patch-package.cjs`, `fix-electron-bridge.ps1`) already baked into source. Extended `app/.gitignore` to mask `electron-dist/`, `release/`, `test-results/`, Ruflo runtime (`.swarm/`, `.claude-flow/`, `.claude/`, `agentdb.rvf*`, `*.db*`), and `package-lock.json`. Root `.gitignore` was already comprehensive (lines 67-87).

Build: 1921 modules, 1.51s vite build, 311 KB main + 6 vendor chunks (vendor-react 227, vendor-xterm 333, vendor-radix 53, vendor-cmdk 45, vendor-dnd 38, vendor-icons 21 KB). Lint baseline ≤54 retained.

DMG built via direct `node node_modules/.pnpm/electron-builder@.../cli.js --mac --arm64` invocation (the flat `node_modules/.bin/electron-builder` shim was empty due to pnpm install hooks being skipped). Both arm64 + x64 produced (4 artefacts total: 2 DMG + 2 zip; 121-139 MB each, larger than v1.0.0 due to `asar: false`). Tag `v1.0.1` cut + pushed; GitHub release published at https://github.com/s1gmamale1/SigmaLink/releases/tag/v1.0.1 with all 4 binaries attached. App boot verified via `open release/mac-arm64/SigmaLink.app` — process alive past boot self-check.

### Phase 4 research wave (parallel to Step 1) — 3 background agents

While Step 1 finalised, three Ruflo-skill-equipped researcher agents gathered docs for v1.1 features. Reports stored to AgentDB under `phase4-voice-research` and `phase4-ruflo-research` namespaces.

**voice-researcher** (macOS Speech Framework + NAPI):
- macOS minimum bumped from 10.12 → **10.15 Catalina** (`requiresOnDeviceRecognition` requires it).
- Toolchain: `node-addon-api ^8.5.0` + `node-gyp ^12.2.0` + Objective-C++ `.mm` + `prebuildify --napi --strip --arch=x64+arm64`. ABI-stable via Node-API: ONE binary per arch.
- Pipeline (verbatim from `sveinbjornt/hear`): `[SFSpeechRecognizer requestAuthorization]` → `recognizer = [SFSpeechRecognizer alloc] initWithLocale:NSLocale]` → `request = [SFSpeechAudioBufferRecognitionRequest alloc] init` with `shouldReportPartialResults=YES, requiresOnDeviceRecognition=YES, addsPunctuation=YES` → `engine = [AVAudioEngine alloc] init; inputNode = engine.inputNode` → `[inputNode installTapOnBus:0 ...]` → `task = [recognizer recognitionTaskWithRequest ...]` → `[engine startAndReturnError]`. Stop: `[engine stop]; [inputNode removeTapOnBus:0]; [request endAudio]; [task cancel]`.
- Server-side recognition is capped at ~1 minute per session; on-device has no cap (WWDC19 #256). Continuous mode requires `requiresOnDeviceRecognition = YES`.
- Permissions: `electron.systemPreferences.askForMediaAccess('microphone')` works for mic, but does NOT handle Speech — call `[SFSpeechRecognizer requestAuthorization:]` directly inside the native module (mirroring `node-mac-permissions.askForSpeechRecognitionAccess`).
- Hardened-runtime entitlements (mandatory for notarisation): `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.device.audio-input`.
- Reference projects: `codebytere/node-mac-permissions` (auth + ThreadSafeFunction pattern), `sveinbjornt/hear` (full pipeline), `prebuild/prebuildify` (distribution).

**wake-researcher** (Porcupine wake-word — CRITICAL LEGAL FINDING):
- `@picovoice/porcupine-node@4.0.2` (Apache-2.0 binding, but engine itself proprietary). 7.17 MB unpacked. Audio: 16-bit PCM, 16 kHz mono, 512-sample frames (~32 ms).
- Built-in keywords: `alexa, americano, blueberry, bumblebee, computer, grapefruit, grasshopper, hey google, hey siri, jarvis, ok google, picovoice, porcupine, terminator`. **"Hey Sigma" requires custom `.ppn` per-platform** (4 files: mac-arm64/x64, win-x64, linux-x64).
- **SHOWSTOPPER**: Picovoice Free Tier ToU §7 prohibits "allowing third parties to use the Services on your behalf without Picovoice's written consent." **SigmaLink CANNOT legally ship a single bundled AccessKey to public users.** Two compliant paths: (a) BYO-AccessKey UX (each user signs up + pastes their own free key in Settings; legal but high friction) or (b) Enterprise license (must contact sales; pricing not published).
- Open-source alternatives all blocked: `openWakeWord` Apache-2.0 code but pretrained models are **CC-BY-NC-SA 4.0 (non-commercial only)**, same blocker. `Snowboy` archived 2020. `Mycroft Precise` shut down 2023. Only fully MIT-licensable path: train a custom ONNX model + `onnxruntime-node` (~30k hours negative audio + thousands of synthetic positive samples; realistic Phase 5+ work).
- **Phase 4 decision**: defer wake-word to v1.2. v1.1 ships push-to-talk only. If user explicitly wants wake-word, ship BYO-AccessKey UX (Settings → "Get a free Picovoice key" link).

**ruflo-researcher** (Ruflo MCP embed):
- User-facing pkg: `ruflo@3.7.0-alpha.20`; actual implementation: `@claude-flow/cli@3.7.0-alpha.18`. ESM-only, Node ≥ 20.
- **SIZE BLOCKER**: ESM tarball is 10 MB but transitive install expands to **1.4 GB on disk** across 422 sub-modules. Top hogs: `onnxruntime-node` 210 MB (ships all-platforms in `bin/napi-v6/{darwin,linux,win32}/`), `onnxruntime-web` 130 MB, `@claude-flow/cli` 89 MB, `agentdb` 66 MB, `agentic-flow` 66 MB, `@ruvector/*` 29 MB. Per-platform install (npm `optionalDependencies`) trims to ~250-350 MB per platform.
- Spawn target: `node_modules/@claude-flow/cli/bin/mcp-server.js` directly (NOT `ruflo` wrapper, NOT `ruflo-mcp-filter.mjs` shim). Diagnostics already on stderr-only; filter unnecessary.
- **Tool name correction (CRITICAL — Phase 4 plan was wrong)**: `agentdb_pattern-store` accepts `{ pattern, type, confidence }`, NOT `{ namespace, key, value, metadata }`. For k/v needs use `agentdb_hierarchical-store`. Other canonical names: `embeddings_search { query, topK?, threshold?, namespace? }`, `embeddings_generate { text, hyperbolic?, normalize? }`, `agentdb_pattern-search { query, topK?, minConfidence? }`, `autopilot_predict {}`.
- No daemon required for the 3 target tools. The `ruflo daemon` is for background workers (audit/optimize/map/consolidate/testgaps) which we don't need.
- All cross-platform native crates published per-platform on npm (verified live): `@ruvector/sona-{darwin-arm64,darwin-x64,linux-x64-gnu,win32-x64-msvc}`, `@ruvector/attention-*`, `@ruvector/rvf-node-*`, `onnxruntime-node` (bundles arm64+x64). Risk: `win-ia32` and `linux-arm64-gnu` for some `@ruvector/*` crates unverified.
- Cwd isolation: spawn with `cwd: app.getPath('userData')/'ruflo-runtime'` so AgentDB doesn't conflict with the user's separate Ruflo CLI usage.
- **Phase 4 decision pending**: bundle (+250-350 MB DMG) vs lazy-download into `userData/ruflo/` on first use. Architect agent debating; recommendation expected to favour lazy-download given size impact.

### Phase 4 work in flight (May 10 evening, autonomous)

Overnight autonomous run. Currently dispatched:
- **Testing wave** (3 agents): `e2e-runner` (Playwright suite), `ipc-auditor` (swarm mailbox + agent comm code review), `provider-prober` (provider launch path audit).
- **Architecture wave** (2 agents): `voice-architect` (SigmaVoice native module design doc), `ruflo-architect` (Ruflo embed architecture incl. bundle vs lazy decision).

Next waves planned (autonomous; will dispatch on testing+architecture completion):
- Bug-fix swarm consuming `BUG-V1.1-NN-*` from testing reports
- Track A coding: Agent IPC reliability hardening (per ipc-auditor findings)
- Track B coding: SigmaVoice native module + dispatcher (per voice-architect design)
- Track C coding: Ruflo MCP supervisor + 3 user-facing features (per ruflo-architect design)
- Final smoke + dogfood + commit + push (potentially `v1.1.0-rc1` tag)

Stop conditions (will pause + ask): destructive action, permanently broken build no agent debate resolves, request to leak credentials, anything requiring Apple Developer ID procurement.

### v1.1.0-rc1 SHIPPED (May 10, 2026 — autonomous overnight run)

The autonomous Phase 4 wave completed without hitting any of the stop conditions. Final tag + GitHub release at https://github.com/s1gmamale1/SigmaLink/releases/tag/v1.1.0-rc1 (prerelease; 4 binaries: mac arm64+x64, DMG + zip, 131-139 MB each, unsigned).

**Three commits landed on `main` after v1.0.1**:
- `83520bb` `fix(P4-trackA)`: IPC reliability + provider launcher façade + macOS PATH bootstrap. 21 files changed (+1484 / -70 lines). Closes 9 testing-swarm bugs.
- `2944132` `feat(P4-tracksB+C)`: SigmaVoice native macOS module + Ruflo MCP supervisor with three user-facing features. Larger commit (Track B + C share rpc-channels.ts/schemas/router-shape/rpc-router/BridgeRoom — splitting would tear an atomic interface change).
- `0266eea` `chore(release)`: v1.1.0-rc1 — CHANGELOG entry + release notes + version bump.

**Final build state**: `tsc -b` clean. `vite build` 322 KB main + 6 vendor chunks (well under 700 KB target). `electron:compile` clean. Lint 42 errors / 10 warnings — net DOWN from 54/10 baseline.

**DMG verification**: `open app/release/mac-arm64/SigmaLink.app` → process alive past boot self-check. Native modules confirmed on disk (`Resources/app/node_modules/{bindings,better-sqlite3,node-pty}/`). The asar:false workaround from v1.0.1 carried forward.

**Autonomous swarm summary**:
- 3 background research agents (voice, wake, ruflo) → 3 reports stored to AgentDB.
- 3 background testing agents (e2e-runner, ipc-auditor, provider-prober) → 21 bugs filed.
- 2 background architecture agents (voice, ruflo) → 2 design docs at `docs/04-design/`.
- 4 background fixer agents (mailbox, provider-launcher, providereffective, pane-sync) → 9 bugs closed.
- 2 background coder agents (voice-coder 18 files, ruflo-coder 15 files) → Tracks B + C complete.
- Lead direct edits: PATH bootstrap (electron/main.ts), Playwright spec defenses (smoke + dogfood), CHANGELOG, release notes, version bump, bug ledger.
- Total agent wall-clock: ~3 hours across 14 background agents + lead orchestration.

**11 bugs closed** (3 P1-IPC, 5 P1/P2-PROV, 1 P2-IPC, 1 P3-IPC, 1 P1 Playwright defensive). Plus carry-over from v1.0.1: 2 P3 BUG-DF + 4 v1.0.1 fix items. **10 bugs deferred to v1.2** with explicit reasons (Porcupine licensing for wake-word, V3 envelope kinds need new producers, scope-bounding).

**Next session restart point**: SigmaLink is at v1.1.0-rc1 on `main`. Real-world dogfood + visual recording validates → tag v1.1.0 final on the same SHA. Track A bugs deferred to v1.2 are catalogued in `../08-bugs/OPEN.md` Phase 4 section.


---

## Phase 5 — v1.1.1 UX hotfix (2026-05-11)

User dogfooded v1.1.0-rc3 DMG and surfaced four interlocking defects that all needed to ship together:

1. **Window immovable on macOS** — `titleBarStyle: 'hiddenInset'` exposed only a 28-px sliver of drag region in the sidebar header. Everywhere else (breadcrumb, right-rail header, sidebar wordmark) was non-draggable.
2. **"Bridge Assistant" branding wrong** — product is SigmaLink; every feature should be `Sigma <Name>`. The right-rail panel must be **Sigma Assistant**, voice is **SigmaVoice**.
3. **Sigma Assistant was a stub** — every reply began "Got it — '<your text>'. I'm in stub mode for W13; the LLM-backed turn lands in W14." User mandate: power the assistant with the **local Claude Code CLI binary** (Opus 4.7), no raw API calls.
4. **SigmaVoice "voice not enabled or something"** — silent failure mode where the mic button rendered but tapping it produced nothing visible.

**5-step plan executed via SendMessage-first swarm coordination**:
- Step 1 (window drag): I directly edited 3 chrome containers + new `drag-region.ts` helper.
- Step 2 (rebrand): I directly swapped 8 user-visible strings + added `sigmavoice.enabled` capability.
- Step 3 (Claude CLI streaming): `coder-cli` background agent — 8 unit tests + 1 e2e, 497-line driver, live JSON shape verified against `claude` CLI v2.1.138. Critical discovery: `--verbose` REQUIRED with `--output-format stream-json`.
- Step 4 (voice diagnostics): `coder-voice` background agent — root cause was a diagnostics gap (auth `not-determined` until first prompt → silent throw), shipped 4-stage probe + Settings → Voice tab.
- Step 5 (release): direct lead — git push, gh release create, GitHub release with arm64 DMG attached.

**Convergent review**: `code-review-swarm` background agent ran `git diff` + tsc + vitest + lint over the 19 modified + 11 new files; flagged 4 leftover toast strings (Bridge dispatch toasts + ChatTranscript empty-state + voice fallback). Patched in same session, re-verified clean.

**Two unplanned fixes added during release**:
- **arm64-only scope** — first DMG build packaged x86_64 native modules (`better_sqlite3.node`); user crashed on first launch with "incompatible architecture". Root cause: `--config.npmRebuild=false` (from rc3 to dodge node-pty TS test errors under pnpm) skips per-arch rebuilds. Fix: ran `electron-rebuild --module-dir ... --types prod -f` against the real pnpm path under `node_modules/.pnpm/better-sqlite3@12.9.0/...`, then rebuilt arm64-only DMG. x64 deferred to v1.2 CI matrix.
- **Single-instance lock missing** — user reported "multiple SigmaLink instances launch when creating agents." Root cause: `electron/main.ts` was missing `app.requestSingleInstanceLock()`. Without it, every LaunchServices activation (second `.app` double-click, agent CLI URL handler, dock drag-drop) spawned a parallel instance fighting the original for the SQLite WAL lock. Fix: acquired lock at boot; on `second-instance` we focus the existing window and quit the duplicate. Two commits stacked on rc3 (`8cbc173` + `0262383`).

**Final build state**:
- `tsc -b` clean.
- `pnpm exec vitest run` → 15/15 pass (8 CLI driver + 7 voice diagnostics).
- `pnpm exec vite build` → 334 KB main + vendor chunks, 92 KB gzip (well under target).
- Lint at 54/0 once `release/` added to `globalIgnores` in `eslint.config.js` (matches rc3 effective baseline; new files contribute zero errors).
- Smoke tested: window drags from breadcrumb / right-rail / sidebar; Sigma Assistant streams real Claude CLI responses; Settings → Voice diagnostics renders 4-stage probe; single SigmaLink dock icon when launching agents.

**Released as `v1.1.1`** on 2026-05-11 (https://github.com/s1gmamale1/SigmaLink/releases/tag/v1.1.1). Tag pushed, GitHub release published with `SigmaLink-1.1.1-arm64.dmg` (130 MB) + `SigmaLink-1.1.1-arm64-mac.zip` (133 MB) + blockmaps.

**Smoke-test follow-ups** (4 P2 bugs filed in `../08-bugs/OPEN.md`, target v1.1.2):
- BUG-V1.1.1-01 — Sigma Assistant `launch_pane` tool emits but doesn't actually spawn a PTY (CLI tool_use envelope visible in Tool calls panel, but never feeds into `controller.invokeTool()`).
- BUG-V1.1.1-02 — Sigma Assistant cannot enumerate active sessions (system-prompt builder reads from DB instead of live registry; sees "(no active swarms)" even with 4 agents running).
- BUG-V1.1.1-03 — Inter-agent broadcast / side-chat to `@all` / `@coordinators` lands in the operator log but every agent shows `0 msgs`. Possible regression from the rc3 cross-swarm-leak fix tightening.
- BUG-V1.1.1-04 — Ruflo MCP not auto-connected for spawned agent CLIs (agents see Ruflo as disconnected because no per-workspace `.mcp.json` is auto-written pointing at SigmaLink's embedded daemon's shared `.claude-flow/` state dir).

**Architecture decision (informal)**: Ruflo MCP federation is v1.2 work. v1.1.x stop-gap is auto-write workspace-scoped MCP configs (`.mcp.json` for claude code, `.codex/mcp.json` for codex, `~/.gemini/.../...` for gemini) pointing each spawned CLI at a shared `.claude-flow/` state dir. They each spawn their own MCP stdio client but converge on one on-disk SQLite/HNSW brain. True federation (one daemon, all agents as TCP clients) is later — needs Ruflo's HTTP/WS transport + per-workspace port allocator.

**Phase 5 commits**:
- `8cbc173` `feat(v1.1.1)`: window drag + Sigma rebrand + Claude CLI + voice diagnostics. 33 files changed (+2531 / -38 lines).
- `0262383` `fix(v1.1.1)`: acquire single-instance lock in electron/main.ts.

**Next session restart point**: SigmaLink is at v1.1.1 on `main` (commit `0262383`). v1.1.2 backlog: 4 smoke bugs (`BUG-V1.1.1-01` through `-04`) + the deferred V3 visual parity sprint + the deferred wake-word / x64 native build / @playwright bump items.

---

## Phase 6 — v1.1.2 Sigma Assistant parity (May 11, 2026)

Resumed work from a hand-off session to achieve full end-to-end parity for the Sigma Assistant. This phase transformed the assistant from a conversational stream into an operational driver capable of executing real host tools.

### Step 1 — Tool dispatch parity
Extended `src/main/core/assistant/runClaudeCliTurn.ts` with a `dispatchTool` callback. Implemented a serialized `stdin` write queue (`createStdinWriter`) using a promise-chain pattern to ensure `tool_result` envelopes are written back to the Claude CLI sequentially without corruption. All tool calls are wrapped in a 30s timeout and correctly report errors back to the CLI.

### Step 2 — Live workspace-state tools
Implemented three new canonical tools in `src/main/core/assistant/tools.ts`:
- `list_active_sessions`: Returns live PTY registry data including provider and status.
- `list_swarms`: Returns the full role roster and status for all swarms in the workspace.
- `list_workspaces`: Lists known workspaces and identifies the active one.
Aliased `memory.search` → `search_memories`, `memory.create` → `create_memory`, and `dispatch_pane` → `prompt_agent`.

### Step 3 — Ruflo MCP autowrite
Shipped `src/main/core/workspaces/mcp-autowrite.ts` to automatically configure external agent CLIs. On workspace open, SigmaLink now writes or merges `.mcp.json` (Claude), `.codex/config.toml` (Codex), and `~/.gemini/settings.json` (Gemini), pointing them to the shared Ruflo runtime. The logic refuses to overwrite user-customized Ruflo entries.

PR also synced upstream Ruflo agent-prompt docs into `app/.agents/ruflo/*.upstream.md` and added a top-level `app/AGENTS.md` parity file. These four files are documentation-only (no runtime effect); kept for cross-tool consistency with the @claude-flow/cli docs vendor.

### Step 4 — Inter-agent group broadcast fix
Resolved BUG-V1.1.1-03 in `src/main/core/swarms/mailbox.ts`. The mailbox now correctly fans out group recipients (`@all`, `@coordinators`) into individual agent keys before calling the PTY pane echo closure, ensuring operator broadcasts increment agent inboxes as expected.

### Verification
- `pnpm exec tsc -b` → clean (exit 0).
- `pnpm exec vitest run` → 28/28 pass (13 new tests: 5 in `runClaudeCliTurn.test.ts` for dispatch + trajectory, 3 in `tools.test.ts` for the live tools, 4 in `mcp-autowrite.test.ts`, 1 in `mailbox.test.ts` for group fanout).
- `pnpm exec vite build` → main bundle `index-*.js` 335 KB raw / 92.84 KB gzipped (well under 700 KB target).
- `pnpm run lint` → 54 errors / 0 warnings — at-or-below the rc3 baseline; no new errors introduced.
- Ruflo SONA trajectory hooks wired into `runClaudeCliTurn` so the assistant accumulates cross-session learning from its own tool-call outcomes.

**Phase 6 commits** (on branch `v1.1.2-final`, PR #1):
- `c2fc5d8` `feat(v1.1.2)`: tool dispatch parity + live tools + mcp autowrite (the work).
- `b21f58d` `docs(v1.1.2)`: update master memory and index.
- `1bc182e` (historical, on main) docs: snapshot v1.1.2 plan for Codex hand-off.

**Convergent review** (`pr-reviewer` agent on commit b21f58d): SHIP-WITH-PATCH. 5 steps + 1b all PASS. 6 doc-only punch list items applied by lead inline before tag (real commit SHAs, release notes authored, CHANGELOG past-tense rewrite, memory_index "Latest commit + tag" updated for v1.1.2, `.agents/ruflo/*.upstream.md` files kept with a one-line provenance note — they are upstream Ruflo agent-prompt docs synced into the repo for parity and don't affect runtime).

**Deferred to v1.1.3** (P2/P3, non-blocking):
- Refactor `runClaudeCliTurn.ts` (643→<500 lines) by extracting tool-dispatch helpers into a sibling module.
- Refactor `tools.ts` (525→<500) by extracting `list_*` trio.
- `list_swarms` workspaceId-optional fix at `tools.ts:463` (currently throws via `requireWs`; should fall through to `defaultWorkspaceId ?? null`).
- CI workflow `pnpm-lock.yaml` cache-path resolution (4 jobs failed at Setup Node, but local gates green).

**Next session restart point**: SigmaLink is at v1.1.2 on `main` after PR #1 merge. Phase 7 focus: V3 visual parity sprint (9 cosmetic tickets) and v1.1.3 housekeeping (file-size refactors + CI workflow fix + the deferred P3 tool fix).

---

## Phase 7 — v1.1.3 multi-workspace, pane resume, and Ruflo pre-flight (May 12, 2026)

Resumed work from a hand-off session to implement multi-workspace support and pane resume capabilities. This phase shifted SigmaLink from a single-workspace Electron app into a multi-tab productivity hub.

### Step 1 — Rebrand completion
Finished the "BRIDGE" to "Sigma Assistant" rebrand in `ChatTranscript.tsx`. All user-facing chat role labels now consistently use "Sigma Assistant".

### Step 2 — Multi-workspace tabs
Transformed the application state to support parallel opened workspaces. Added `openWorkspaces` and `activeWorkspaceId` to the core state. Built `src/main/core/workspaces/lifecycle.ts` to synchronize the open list across IPC and updated the Sidebar with an 8-tab limit, overflow drawer, and per-tab closing.

### Step 3 — Pane resume (CLI process persistence)
Implemented persistence for agent CLI processes across SigmaLink restarts.
- Added `external_session_id` column to `agent_sessions` via migration `0011`.
- Built `src/main/core/pty/session-id-extractor.ts` to capture session IDs from Claude/Codex startup banners and JSONL envelopes.
- Created `src/main/core/pty/resume-launcher.ts` to relaunch PTYs using each provider's `resumeArgs` (e.g., `claude --resume <id>`).

### Step 4 — Growable swarms
Enabled adding agents to existing swarms post-creation. Added the `swarms.addAgent` RPC and the `add_agent` Sigma tool. Bound maximum swarm capacity at 20 agents and updated `src/renderer/features/workspace-launcher/grid.ts` with corresponding 18/20 terminal layouts.

### Step 5 — Ruflo pre-flight & verification
Hardened the Ruflo orchestration layer. Added `RufloMcpSupervisor.ensureStarted()` with a ready-wait lock. Implemented fast/strict verification in `src/main/core/ruflo/verify.ts` that probes for the CLI executable and config path before spawning agents, surfacing readiness via a new Breadcrumb "Readiness Pill".

### Step 6 — Multi-workspace session restore
Extended `src/main/core/session/session-restore.ts` to persist and restore the full list of open workspaces and their respective active rooms. Added legacy v1.1.2 normalization to ensure seamless migration.

### Step 7 — Skills verification sweep
Built `SkillsManager.verifyFanoutForWorkspace` in `src/main/core/skills/manager.ts`. On workspace open, SigmaLink now performs a content-hash check of enabled skills and automatically refreshes missing or corrupted copies in the workspace worktree.

### Verification & Environment
Resolved a `better-sqlite3` Node 26 `NODE_MODULE_VERSION` mismatch via manual `node-gyp` rebuild. Converted new test files from `node:test` to `vitest` for full test suite integration.
- `pnpm exec vitest run` → 86/86 pass.
- `npm run build` → Success (frontend + main/preload).

**Phase 7 commits**:
- `989a350` `feat(v1.1.3)`: multi-workspace + pane resume + grow swarms + ruflo pre-flight.

---

## Phase 8 — v1.1.4 V3 visual parity sweep (2026-05-11)

User dogfooded v1.1.3 and confirmed multi-workspace + pane resume work. Real bottleneck became **visual drift from V3 BridgeMind** — the reference layout the user has been targeting. Four regions diverged. Phase 8 ported them. Frontend-only release; backend touches: zero; RPC channels touched: zero.

### Step 1 — Workspaces panel
Promoted the inline `WorkspaceTabs` block out of `Sidebar.tsx` into a dedicated `WorkspacesPanel.tsx` (216 lines). The sidebar dropped from ~500 lines to 147 lines (dropped the 12-item ITEMS nav array + Cmd+K launcher card + inline tabs). Workspace rows now show a deterministic colour dot (`workspace-color.ts` hashes id → 8-colour palette: pink/blue/purple/amber/emerald/rose/cyan/indigo) + pane-count badge (running sessions only) + close-× on hover for the active row. No 8-tab cap; the list scrolls. Added `@testing-library/react` + `jsdom` devDeps to support the new TSX vitest specs.

### Step 2 — Top-left rooms menu
Built `RoomsMenuButton.tsx` (72 lines) — a `LayoutGrid` icon at the left edge of the Breadcrumb that opens a Radix DropdownMenu listing all 11 rooms from the `RoomId` union (the plan said 12; the union actually has 11). Item icons + labels lifted from the now-deleted sidebar ITEMS array. Disabled-when-no-workspace logic mirrors v1.1.3 sidebar behaviour exactly. Pure-data module `rooms-menu-items.ts` split out so the TSX file stays Fast-Refresh-clean.

### Step 3 — Top-right right-rail switcher + settings gear
Built `RightRailSwitcher.tsx` (86 lines) — a three-button segmented control (Globe/FileCode2/Bot icons labelled Browser/Editor/Sigma) plus a sibling Settings gear. State lifted into a new `RightRailContext` so the top-bar switcher and the rail content stay in sync; kv persistence of the last-active tab is preserved. The in-rail tab strip is hidden via a new `tabsVisible={false}` prop on `RightRailTabs`. Gear dispatches `SET_ROOM('settings')`.

### Step 4 — Pane header collapse + 3×3 grid for 9 panes
`PaneHeader.tsx` rewritten as a single h-7 strip (was h-7 + h-6): 2px colour stripe → truncated `PROVIDER·index` label (max-w-80px) → spacer → 4 icon buttons (Focus / Split-disabled / Minimise-disabled / Close). Branch/model/effort/cwd labels moved into a Radix tooltip on hover of the provider name. Stop button moved into a right-click context menu on the pane body (with disabled state when session is exited/errored). `PaneStatusStrip.tsx` deleted. `GridLayout.shapeFor(9)` now returns `{ cols: 3, rows: 3 }` instead of `{ cols: 4, rows: 3 }` (no empty trailing cell). 10/11/12 unchanged.

### Build hygiene
- `pnpm exec tsc -b` → clean (after fixing a 2-line Element.prototype narrowing in PaneHeader.test.tsx via a typed cast).
- `pnpm exec vitest run` → 108/114 pass renderer-side. The 6 failures are the pre-existing better-sqlite3 NMV-123-vs-147 mismatch on host-Node main-process tests, unchanged from v1.1.3.
- `pnpm exec vite build` → 354.95 KB raw / 97.57 KB gzip main bundle (under 700 KB target).
- `pnpm run lint` → 59 problems (58 errors / 1 warning), DOWN 1 from v1.1.3's 60-problem ceiling. All pre-existing families.
- 28 new vitest specs across 5 new test files. No new `any`, `@ts-ignore`, or `eslint-disable` introduced.

### Coordination
Four parallel coder agents (`coder-workspaces-panel`, `coder-rooms-menu`, `coder-rail-switcher`, `coder-pane-header`) executed in one swarm dispatch. `coder-rail-switcher` waited on SendMessage from `coder-rooms-menu` before editing Breadcrumb.tsx (both touched the same file). Each coder self-tested. Lead verified aggregate gates + fixed the PaneHeader.test.tsx tsc errors flagged by coder-workspaces-panel before tagging.

**Phase 8 commits**:
- `4a8d7c7` `feat(v1.1.4)`: V3 visual parity layout sweep.

---

## Phase 9 — v1.1.5 Gatekeeper "damaged" hotfix (2026-05-12)

Hours after the v1.1.4 ship, user downloaded the DMG from GitHub via Chrome and got "SigmaLink is damaged and can't be opened" on drag to /Applications. Deployed a two-agent investigation team. `dmg-forensics` confirmed: `Signature=adhoc, flags=adhoc,linker-signed, Sealed Resources=none, _CodeSignature/CodeResources missing entirely`. `builder-config-research` clarified that electron-builder 24.13.3 does NOT parse `identity: "-"` as ad-hoc (treats it as a keychain qualifier) — so the only working path is `identity: null` plus an `afterSign` hook that runs codesign manually.

### Root cause

v1.1.0 turned on `hardenedRuntime: true` for SigmaVoice with a comment claiming hardened runtime was "harmless without a Developer ID". It wasn't. electron-builder's identity auto-discovery found no Developer ID, silently produced a bundle whose only signature was the linker-injected ad-hoc stamp ld(1) puts on every Mach-O, and the bundle never gained a `Contents/_CodeSignature/CodeResources` resource seal. Chrome attaches `com.apple.quarantine` to downloads, Gatekeeper checks the signature, sees a seal-asserting ad-hoc sig with no actual `CodeResources` directory, and rejects with "damaged" (the destructive verdict). Every DMG from v1.1.0..v1.1.4 carries the same defect; only fresh local builds escaped because they had no quarantine flag.

### Fix

- New `scripts/adhoc-sign.cjs` electron-builder `afterSign` hook (~70 lines including header comment). Runs `codesign --force --deep --sign - --timestamp=none "<App>.app"` after packaging completes, then runs `codesign --verify --deep --strict` and throws if it fails.
- `electron-builder.yml` mac block: `identity: null` (skip builder's signing pass), `hardenedRuntime: false`. Long inline comment documents the regression history and the migration path when a Developer ID is eventually acquired.
- Bundle now passes verification with `Sealed Resources version=2 rules=13 files=20492` (was `Sealed Resources=none` in v1.1.4).

### Outcome

DMG now ships with proper ad-hoc signature + resource seal. Gatekeeper surfaces "unidentified developer" (recoverable right-click → Open) instead of "damaged" (destructive). Still no notarisation; that requires Apple Developer ID + APPLE_ID env vars + `notarize: true` config — held until SigmaLink monetises and can absorb the membership fee.

**Phase 9 commits**:
- `696d599` `fix(v1.1.5)`: Gatekeeper "damaged" dialog hotfix.

---

## Phase 10 — v1.1.6 DMG ships first-launch README (2026-05-12)

v1.1.5 cleared the "damaged" verdict but the user still hit the next Gatekeeper layer: "Apple could not verify SigmaLink is free of malware that may harm your Mac or compromise your privacy." with [Move to Trash] / [Done] buttons. This is the macOS Sequoia/Tahoe un-notarised-app dialog (recoverable). Deployed `sequoia-research` agent (web-search-enabled). Key findings:

- Apple removed the Control-click → Open shortcut in Sequoia (15.0). Replacement: System Settings → Privacy & Security → scroll to Security section → "Open Anyway" → authenticate. Available for ~1 hour after the failed launch.
- `xattr -cr /Applications/SigmaLink.app` still works in 26.x to strip `com.apple.quarantine` and bypass Gatekeeper entirely.
- `spctl --master-disable` is neutered in Sequoia; only configuration profiles (MDM) can globally disable Gatekeeper.
- Notarisation requires Apple Developer Program — $99/year, no free tier, no open-source exception (FSFE petitioned Apple Nov 2025; no movement).
- Homebrew Cask is removing un-notarised casks by Sept 2026 — not a viable channel.
- Self-strip-quarantine on first launch is impossible (chicken-and-egg: Gatekeeper runs before the app can touch its own xattrs).

### Fix shipped

`build/dmg/README — Open SigmaLink.txt` — plain-ASCII walkthrough now bundled in the DMG. When the user mounts SigmaLink-1.1.6-arm64.dmg they see three items in the window:

  [SigmaLink.app]   [Applications →]   [README — Open SigmaLink.txt]

The README covers both options: Terminal one-liner and System Settings flow. `electron-builder.yml` `dmg.contents` extended with a third coordinate pointing at the file.

### Path to real fix (v1.2 candidate)

Buy Apple Developer Program ($99/year), generate "Developer ID Application" cert, set CI secrets (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, CSC_LINK, CSC_KEY_PASSWORD), flip `electron-builder.yml` mac block to use the real identity + `hardenedRuntime: true` + `notarize: true`, drop the adhoc-sign.cjs afterSign hook + the in-DMG README. After that, DMG becomes a single-double-click install and Homebrew Cask submission opens up.

**Phase 10 commits**:
- `005f059` `docs(v1.1.6)`: bundle first-launch README inside the DMG.

---

## Phase 11 — v1.1.7 curl-bash installer (2026-05-12)

User asked: "if there's no way to just make dmg files and ship them on github as a release, then we should create a script that auto makes the dmg when launched on other PCs. This is for internal use only, not for commercial purposes anyway. Find out if there're no other ways to ship dmgs without paying fee."

### Research outcome

Deployed `curl-bypass-research` agent + ran empirical test on this Mac. Result:

- **`curl` and `wget` do NOT tag downloads with `com.apple.quarantine`** on macOS. Only LaunchServices-registered apps (Safari, Chrome, Mail, Messages, AirDrop receive, App Store) do.
- Files without `com.apple.quarantine` are NOT subject to Gatekeeper's first-launch assessment.
- This is the documented mechanism behind every `curl | bash` installer (Rust, Homebrew, Docker, oh-my-zsh).
- Empirically confirmed on macOS 26.4 (Tahoe): a curl-downloaded test file has empty xattr output.
- Apple has not introduced a "quarantine everything" mode; their 2026-02-18 App Store Connect requirement says the opposite (`com.apple.quarantine` is still source-attached, not universal).

The bypass is legitimate for internal-use distribution. The DMG itself was never the problem; the problem was the channel (browser download attaches quarantine). Curl-installed apps skip the entire Gatekeeper pipeline.

### Fix shipped

`app/scripts/install-macos.sh` — 170-line POSIX-Bash installer:

1. Platform + arch gate (macOS arm64 only for now).
2. Resolves latest release via GitHub API; accepts explicit tag arg.
3. Downloads matching DMG via curl.
4. Quits any running SigmaLink via AppleScript.
5. Replaces `/Applications/SigmaLink.app` (sudo fallback).
6. Strips xattrs defensively.
7. Unmounts DMG, optionally launches.

Plus README.md Install section + updated in-DMG README preamble pointing at the one-liner.

One-line install:
```
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash
```

### Why this is the right answer for internal distribution

- $0 cost (no Apple Developer Program).
- Zero macOS prompts.
- Same UX as Rust/Homebrew/Docker installers (users trust this pattern).
- The DMG path still exists as a fallback for users who prefer GUI installs.
- When SigmaLink is funded and Apple Developer ID is purchased, drop the install script + adhoc-sign hook + in-DMG README; flip electron-builder.yml to use the real cert.

**Phase 11 commits**:
- `ad27db4` `docs(readme)`: promote curl-bash installer to top of repo README + `6799af1` `feat(v1.1.7)`: curl-bash install script bypasses Gatekeeper.

---

## Phase 12 — v1.1.8 5-agent optimization swarm (2026-05-12)

User asked for an optimization session with agent swarm, "do not break what's working, make agent tests their fixes. Tell them use the relevant skills". Dispatched a 3-investigator Phase 1 + 5-coder Phase 2 swarm with skill instructions (sparc:optimizer, sparc:tester, analysis:performance-bottlenecks).

### Phase 1 investigators

- **`perf-investigator`** — bundle / React render / IPC chattiness / SQLite n+1 / PTY survey. Top finding: 10 rooms statically imported into the main chunk; useAppState() has no selector so every dispatch re-renders 27 consumers; pty:data is broadcast to 32 listeners on 16 panes.
- **`quality-investigator`** — file sizes (state.tsx 996, factory.ts 713, runClaudeCliTurn.ts 709, sidebar.tsx 726, BridgeRoom 721), lint baseline 60 errors broken down by family, 3 stub schemas, dead code in `src/lib/utils.ts`.
- **`test-investigator`** — picked Option B (`vi.mock('../db/client')` + shared `fakeDb()`) for the NMV-mismatch fix; identified factory.test.ts as the highest-impact new coverage.

### Phase 2 coders — 5 parallel, NON-OVERLAPPING file scopes

- **`quality-lint-fixer`** — deleted dead `utils.ts` exports (19 errors), promoted 3 stub schemas to real zod (caught Role enum drift: actual `coordinator|builder|scout|reviewer`, not plan's hallucinated `tester|researcher`), `.data.ts` split for 8 shadcn UI files + RightRailContext. -27 lint errors.
- **`perf-bundle-lazy`** — `React.lazy()` for 10 rooms (CommandRoom eager), BrowserRoom latch-on-first-activation, BridgeTabPlaceholder + RightRail also converted to lazy. Main bundle 97.57 → 38.26 KB gzip (-61%).
- **`perf-ptybus`** — new `renderer/lib/pty-data-bus.ts` (88 lines) routes pty:data by sessionId through a Map; Terminal + PaneSplash migrated. 32→1 listener per chunk. 9 new bus tests.
- **`test-nmv-fixer`** — shared `src/test-utils/db-fake.ts`, migrated mailbox.test.ts + tools.test.ts to vi.mock pattern, added factory.test.ts for paneIndex + 20-cap. 108/114 → 128/128.
- **`refactor-state-split`** — state.tsx 996 → 553 + 3 sibling modules (types 157, reducer 316, hook 19). Re-exports preserve all consumer imports. Residual 553 LOC is irreducible provider + IPC-listener cohesion.

### Parallel-agent integration outcome

One conflict surfaced: quality-lint-fixer's `.data.ts` split for `button.tsx` initially broke `alert-dialog.tsx`'s `buttonVariants` import. Resolved within the same dispatch when quality-lint-fixer updated the 4 consumer files (alert-dialog, pagination, calendar, toggle-group). Lead verified aggregate gates green before tag — no commit-time integration debt.

### Aggregate gates

- `pnpm exec tsc -b` → clean
- `pnpm exec vitest run` → 128/128 (was 108/114)
- `pnpm run lint` → 32 problems (was 60, -28)
- `pnpm exec vite build` → main 38.26 KB gzip (was 97.57, -61%)
- 10 lazy chunks emitted

The 31 remaining lint errors are React-compiler structural family (set-state-in-effect, immutability, exhaustive-deps) — scheduled for a dedicated v1.1.9 wave together with the `useAppStateSelector` + precomputed `sessionsByWorkspace` slices refactor (which is the higher-impact runtime perf work the perf-investigator flagged but parked for v1.1.9 as a paired refactor).

**Phase 12 commits**: TBD (set at tag time).

**Next session restart point**: SigmaLink is at v1.1.8 on `main`. Cold boot ~60% faster, full test suite green, lint baseline halved, state.tsx splits applied. v1.1.9 backlog: `useAppStateSelector` + `sessionsByWorkspace` paired refactor, `factory.ts` + `runClaudeCliTurn.ts` splits, React-compiler structural lint wave, CI cache-dependency-path fix. v1.2 candidate still: Apple Developer Program for proper notarisation.

---

## Codex branch — v1.1.9 backlog PR handoff (2026-05-12)

User asked Codex to create a fresh worktree, execute from `docs/08-bugs/BACKLOG.md`, and end with a PR, no merge. Work started in:

- Worktree: `/Users/aisigma/projects/SigmaLink-bug-backlog-codex`
- Branch: `codex/bug-backlog-pr`
- Ruflo task: `task-1778545436963-gtb750`
- Detailed handoff: [`../08-bugs/CODEX-BACKLOG-HANDOFF-2026-05-12.md`](../08-bugs/CODEX-BACKLOG-HANDOFF-2026-05-12.md)

### Implemented in the dirty worktree

- Added `useAppStateSelector<T>` via `useSyncExternalStore`, plus `useAppDispatch`.
- Added reducer-maintained `sessionsByWorkspace` and `swarmsByWorkspace` slices.
- Converted the first high-churn selector consumers: Command Room, Command Palette, Swarm Room, Operator Console.
- Added reducer tests for session/swarms workspace indexes.
- Fixed CI cache path drift by targeting `app/package.json`.
- Added explicit Electron binary install after `--ignore-scripts` installs in CI.
- Added `pnpm run coverage`, `@vitest/coverage-v8`, baseline coverage thresholds, and `app/coverage/` ignore.
- Added CI ShellCheck step for `app/scripts/install-macos.sh`.
- Cleared the React compiler lint wave currently visible in the branch: set-state-in-effect, purity, immutability, exhaustive-deps, and `no-explicit-any`.
- Updated `docs/08-bugs/BACKLOG.md` with 2026-05-12 status notes for completed v1.1.9 items.
- Fixed stale smoke failure-log path from `docs/07-bugs/OPEN.md` to `docs/08-bugs/OPEN.md`.

### Validation completed before context pressure

Passing in `app/`:

```bash
pnpm run lint
pnpm exec tsc -b --pretty false
pnpm exec vitest run
pnpm run coverage
pnpm run build
```

Observed results:

- Vitest: 20 files passed, 130 tests passed.
- Coverage: 21.92% statements, 18.8% branches, 21.23% functions, 22.72% lines.
- Build: Vite production build passed.
- `bash -n app/scripts/install-macos.sh` passed.
- Local ShellCheck binary was absent; CI now installs ShellCheck before checking the installer.

### Playwright status

Initial full Playwright run failed with Electron launch timeouts because only `pnpm run build` had been run. The CI-equivalent path also needs:

```bash
node scripts/build-electron.cjs
```

After rebuilding `electron-dist`, focused smoke launched Electron successfully. It then failed on an older visual-sweep assertion:

```text
expect(conversationsPanelCount).toBeGreaterThan(0)
Received: 0
```

Smoke logs showed stale navigation labels for rooms such as `Bridge Assistant`, `Swarm Room`, and `Operator Console`. That is now the main unresolved e2e cleanup before PR. BUG-W7-000's pure app-launch timeout did not reproduce after `node scripts/build-electron.cjs`.

### Current restart point

Do not restart from `main`. Continue in:

```bash
cd /Users/aisigma/projects/SigmaLink-bug-backlog-codex
git status --short --branch
```

Then:

1. Review whether untracked `docs/06-test/` smoke artifacts should be deleted or committed.
2. Fix/update stale Playwright visual-sweep navigation selectors or document the residual test debt.
3. Re-run final gates.
4. Commit branch.
5. Push `codex/bug-backlog-pr`.
6. Open PR against `main`.
7. Record Ruflo completion with `hooks_post_task`.

---

## Phase 13 — v1.1.9 release: PR #3 merge + 3-coder file-size sweep (2026-05-12)

User chose Path 2 (batch the leftover file-size work into v1.1.9 instead of tagging the merged perf+lint commit standalone). Result: v1.1.9 ships PR #3 (Codex+Claude finalizer) bundled with three additional file splits.

### PR #3 finalisation

`codex-handoff-finalizer` agent picked up Codex's uncommitted worktree (`SigmaLink-bug-backlog-codex`, branch `codex/bug-backlog-pr`):
- Confirmed `docs/06-test/` was test-artifact noise → added to .gitignore
- Committed handoff doc as historical artifact
- Added `coverage` to ESLint globalIgnores for vendor coverage HTML
- Decided Option B for the stale Playwright selectors → new "v1.1.10 — Playwright e2e refresh" BACKLOG entry instead of fixing in-PR
- All gates green: tsc clean, lint 0/0, vitest 130/130, coverage above thresholds, build clean
- Opened PR #3, pushed branch

Lead rebased the PR branch on main (clean — both v1.1.10 BACKLOG additions auto-merged since they touched different sections) and merged via `gh pr merge --rebase --delete-branch`. Main HEAD: `ba1212a`.

### 3-coder file-size sweep

Three parallel coders on disjoint file scopes, each using `sparc:optimizer` + `sparc:tester` skills:

- **`coder-factory-split`** — `core/swarms/factory.ts` **713 → 396 LOC**. Private spawn helpers (`spawnAgentSession`, `pickCoordinatorId`, `buildExtraArgs`, `loadAgentSession`, plus a new `materializeRosterAgent` that dedups two near-identical roster passes in `createSwarm`) moved to `factory-spawn.ts` (344 LOC). Public surface unchanged. `factory.test.ts` 5/5 still green.

- **`coder-cli-turn-split`** — `core/assistant/runClaudeCliTurn.ts` **709 → 348 LOC**. Stateless emit layer (`streamDelta`, `emitDelta`, `emitState`, `emitFinal`, `emitErrorFinal`, `persistFinal`, `createStdinWriter`, `withTimeout`) → `runClaudeCliTurn.emit.ts` (186 LOC). Tool routing + Ruflo trajectory + readline-loop dispatchers → `runClaudeCliTurn.trajectory.ts` (193 LOC). Public surface + `__resetProbeCache` + `__resetActiveChildren` test helpers preserved. `runClaudeCliTurn.test.ts` 16/16 green.

- **`coder-state-residual-split`** — `renderer/app/state.tsx` **562 → 97 LOC** (way under the ≤200 target). 14 IPC-event listener effects extracted into custom hooks under `state-hooks/`: `use-session-restore.ts` (142), `use-workspace-mirror.ts` (65), `use-live-events.ts` (140), `use-exited-session-gc.ts` (49), plus shared `parsers.ts` (163) with a deduplicated `runRefreshOnEvent` helper that collapses four near-identical refresh-on-event effects. All Codex re-exports preserved: `useAppDispatch`, `useAppState`, `useAppStateSelector`, `initialAppState`, `selectActiveWorkspace`, `appStateReducer`. `sessionsByWorkspace` + `swarmsByWorkspace` slices intact.

### Aggregate gates after the sweep

- `pnpm exec tsc -b` → clean
- `pnpm exec vitest run` → 130/130
- `pnpm run lint` → 0/0 (one trailing `.claude/helpers/statusline.cjs` lint leak fixed by adding `.claude` to globalIgnores)
- `pnpm exec vite build` → main bundle 38.26 KB gzip (unchanged)
- `codesign --verify --deep --strict` → Sealed Resources files=20492

### File-size budget compliance

Every v1.1.x churn file now under the 500-LOC rule. Four feature-active files still over budget but out-of-v1.1.x-scope:
- `rpc-router.ts` 985 LOC (wave-13 territory)
- `router-shape.ts` 770 LOC (same)
- `sidebar.tsx` 726 LOC (v1.2 candidate)
- `BridgeRoom.tsx` 721 LOC (v1.2 candidate)

The 5 v1.1.x flagged files are now closed:
- `state.tsx` 996 → 97 LOC (v1.1.8 + v1.1.9 splits)
- `factory.ts` 713 → 396 LOC (v1.1.9)
- `runClaudeCliTurn.ts` 709 → 348 LOC (v1.1.9)
- renderer `Sidebar.tsx` ~500 → 147 LOC (v1.1.4)
- `PaneHeader.tsx` collapsed h-7+h-6 → h-7 (v1.1.4)

### v1.1.9 commit + tag + release

TBD (set at tag time).

**Next session restart point**: SigmaLink at v1.1.9 on `main`. Lint at zero. Tests at 130/130. All v1.1.x file-size targets closed. v1.1.10 backlog: provider registry cleanup (Claude/Codex/Gemini/OpenCode/Kimi — drop BridgeCode/Cursor/Shell/Aider/Continue), Playwright e2e refresh for v1.1.4 layout. v1.2 candidate: Apple Developer Program for notarisation. Gemini + Kimi CLIs deployed in parallel for read-only dead-code + optimization investigation; findings expected as documentation.

---

## Phase 14 — Gemini Codebase Audit (May 12, 2026)

Gemini CLI + 10-agent Ruflo swarm ran a read-only audit, documented at `app/docs/investigation/codebase-audit-v1.1.3.md` (path reflects when Gemini audited — against v1.1.3 codebase; most findings still applied on v1.1.9 main HEAD `d824c42`).

### Key findings

- **Backend (3 P1 bugs)**: `pty.forget()` leaks ghost processes; `resolveAndSpawn` fallback unreachable because `spawnLocalPty` swallows ENOENT; `execCmd` doesn't kill child on maxBuffer overflow.
- **Orchestration (3 P1 bugs)**: Mailbox broadcast aborts on single recipient failure; `addAgentToSwarm` non-atomic role index → DB constraint violation under concurrency; StdinWriter queue hangs indefinitely if CLI stops reading.
- **Frontend (4 perf wins)**: Terminal/Sidebar/Launcher still on full `useAppState` (Codex v1.1.9 only migrated 4 hot rooms); Constellation `requestAnimationFrame` loop runs even when tab hidden; BrowserRoom state smearing; React 19 `useActionState` + `useTransition` adoption.
- **Dead code**: `PhasePlaceholder.tsx` zero callers; `RoomChrome.tsx` under-utilized.
- **🟠 P3 optimizations (deferred)**: RingBuffer O(N) shift, janitor batch updates, ON DELETE CASCADE on agent_sessions, per-swarm queue isolation, out-of-order tool result guard.

---

## Phase 15 — v1.1.10 reliability hotfix from Gemini audit (May 12, 2026)

4-coder Ruflo swarm landed Gemini's P1 findings. Disjoint file scopes per coder; each used `sparc:debug` / `sparc:optimizer` / `sparc:tester` / `analysis:performance-bottlenecks` skills:

### `backend-reliability-fixer` — 3 P1 fixes + 22 new tests
- `resolveAndSpawn` fallback now reaches alternatives via sync ENOENT pre-flight in `pty/local-pty.ts`.
- `pty/registry.ts` `forget()` SIGTERMs alive PTY + arms 5s SIGKILL. `killAll()` uses ONE 5s timer (was N).
- `lib/exec.ts` kills child on maxBuffer overflow + new `maxBufferExceeded` field on ExecResult.

### `orchestration-reliability-fixer` — 3 P1 fixes + 10 new tests
- `swarms/mailbox.ts` per-recipient try/catch in JSONL mirror + paneEcho loops.
- `swarms/factory.ts` `addAgentToSwarm` wraps count + INSERT in `db.transaction()`.
- `runClaudeCliTurn.emit.ts` StdinWriter has 30s per-write timeout + `onTimeout` callback (turn driver passes `() => child.kill('SIGTERM')`).

### `frontend-perf-fixer` — 4 perf wins + 6 new tests
- Terminal (1 slice) / Sidebar (5 slices) / Launcher (2 slices + dispatch-only inner row) migrated to `useAppStateSelector`.
- `operator-console/Constellation.tsx` rAF loop dual-gated by Page Visibility API + IntersectionObserver.

### `dead-code-sweeper` — -82 LOC
- `PhasePlaceholder.tsx` + `placeholders/` dir deleted.
- `RoomChrome.tsx` inlined into single SettingsRoom caller and deleted.
- Survey of `lib/` dirs found no other zero-caller modules.

### Aggregate gates
- `pnpm exec tsc -b` → clean
- `pnpm exec vitest run` → **168/168** (was 130/130; +38 new tests across 7 new + extended files)
- `pnpm run lint` → 0/0 (unchanged)
- `pnpm exec vite build` → 38.26 KB gzip main (unchanged shape)
- `codesign --verify --deep --strict` → Sealed Resources files=20492

**Next session restart point**: SigmaLink at v1.1.10 on `main`. All Gemini P1 audit findings closed. v1.1.11 backlog: provider registry cleanup (BridgeCode/Cursor/Shell/Aider/Continue out, Kimi in) + Playwright e2e refresh + Kimi report (if landed) + Gemini's 🟠 P3 optimizations.

---

## Phase 16 — Kimi codebase audit (May 12, 2026)

Kimi CLI + 10-agent Ruflo swarm ran a second parallel audit covering 5 file scopes (App Core, Features, Electron/Main, Build/Config, Shared). Output at `app/CODEBASE_AUDIT_REPORT.md` (538 lines, ~43 KB). 129 issues catalogued across bugs (38) / dead code (23) / optimizations (35) / better logic (33); 5 marked critical, 52 warning, 72 suggestion.

### Verified findings

- **C1 binding.gyp + ThreadSafeFunction**: TRUE. Native voice-mac had both `NAPI_DISABLE_CPP_EXCEPTIONS` + `GCC_ENABLE_CPP_EXCEPTIONS: "NO"` while node-addon-api throws on TSFn failure.
- **C2 use-workspace-mirror desync**: TRUE. `catch { return; }` swallowed RPC errors leaving state stale.
- **C3 use-exited-session-gc timer leak**: PARTIAL — second effect cleaned up on unmount, but the timer-fire-during-unmount race was real (narrow window).
- **C4 MissionStep voice cleanup**: TRUE. `eslint-disable-next-line` was hiding a real closure-over-null bug.
- **State-hook warnings** in v1.1.9 code: 6 of 8 confirmed (per-workspace room snapshot, SET_ACTIVE_WORKSPACE_ID silent no-op, REMOVE_SESSION exited fallback, UPSERT_SWARM auto-active override, review-effect dep churn, parseSwarmMessage kind validation).

### False positives

- **C5 "No CI/CD pipeline"**: 3 workflows already exist (`lint-and-build.yml`, `e2e-matrix.yml`, `native-prebuild-mac.yml`).
- **Fix 5 `voice.diagnostics.run` channel missing handler**: handler IS registered via side-band map at `rpc-router.ts:884-890`, schema at `schemas.ts:369`.

### Remaining triage

~100 warning-level findings across 20+ feature files (Composer voice gate key, MemoryRoom keystroke RPC spam, EditorTab listener thrash, NotesTab edit clobber, ReplayScrubber off-by-one + stale callback, Constellation/MemoryGraph rAF hover stale closure, BridgeRoom listener thrash, TaskDetailDrawer stale prop, RoleRoster useCanDo NaN, etc.) deferred to a "Kimi warning sweep" release (v1.1.12 or later). 35 P3 optimizations also catalogued for later.

---

## Phase 17 — v1.1.11 Kimi audit P1 + state-hook fix wave (May 12, 2026)

2-coder Ruflo swarm landed Kimi's verified critical + high-confidence state-hook items. Each used `sparc:debug` + `sparc:tester` skills.

### `kimi-critical-fixer` — 4 critical fixes + 9 new tests
- **C1** native voice-mac: flipped exception flags ON, added `-fobjc-arc-exceptions` + `-fexceptions`, wrapped every `ThreadSafeFunction::New` site in `try/catch (const Napi::Error&)`. `node-gyp rebuild` clean.
- **C2** useWorkspaceMirror: catch + fall-through; SYNC_OPEN_WORKSPACES always dispatches with cached workspacesRef. 3 new test specs.
- **C3** useExitedSessionGc: `timers.has(sessionId)` guard inside the setTimeout callback. 4 new test specs.
- **C4** MissionStep: introduced `voiceHandleRef` mirroring `voiceHandle`; cleanup reads from ref. 2 new test specs.

### `kimi-state-fixer` — 6 reducer + state-hook fixes + 28 new tests
- **Fix 1** per-workspace room state preserved: new `roomByWorkspace: Record<string, RoomId>` + `SET_ROOM_FOR_WORKSPACE` action + WORKSPACE_OPEN/CLOSE/READY/SET_WORKSPACES/SYNC_OPEN_WORKSPACES maintenance.
- **Fix 2** SET_ACTIVE_WORKSPACE_ID warns on unknown ID.
- **Fix 3** REMOVE_SESSION fallback filters for `status === 'running'`.
- **Fix 4** UPSERT_SWARM only auto-activates on first arrival.
- **Fix 5** voice.diagnostics.run: VERIFIED ALREADY REGISTERED (false positive in Kimi's report; no code change).
- **Fix 6** review effect no longer depends on `state.sessions.length`.
- **Fix 7** parseSwarmMessage `VALID_SWARM_KINDS` allowlist + type guard.
- **Fix 8** appStateStore double-render: DEFERRED to v1.1.12 (needs paired refactor with useSyncExternalStore wiring).

### Aggregate gates
- `pnpm exec tsc -b` → clean
- `pnpm exec vitest run` → **196/196** (was 168/168; +28 new specs across 7 new + extended files; +9 critical-fixer + 19 state-fixer = 28 total new this release)
- `pnpm run lint` → 0/0 (unchanged)
- `pnpm exec vite build` → 38.26 KB gzip main (unchanged shape)
- `codesign --verify --deep --strict` → Sealed Resources files=20492
- native `node-gyp rebuild` voice-mac → clean with exceptions enabled

**Next session restart point**: SigmaLink at v1.1.11 on `main`. Kimi audit's verified critical + high-confidence state-hook items closed. v1.1.12 backlog: provider registry cleanup (still pending), Playwright e2e refresh, Kimi warning sweep across 20+ feature files, Fix 8 appStateStore paired refactor, Gemini + Kimi P3 optimizations.

---

## Phase 18 — v1.2.0 Windows platform port (May 12, 2026)

The macOS stream stabilised through v1.1.11 (196/196 tests, lint 0/0, native voice exceptions cleaned up, Kimi + Gemini P1 audits closed). The next growth lever is platform reach — Windows is the largest installed dev workstation base SigmaLink isn't shipping to yet. v1.2.0 makes Windows 10/11 (x64) a first-class peer to macOS without regressing the macOS surface.

### Pre-flight verification of Windows-readiness

Three Explore agents ran in parallel before any code was written, surveying the codebase for what was already platform-aware versus what needed work. Headline: roughly 80% of the Windows-relevant plumbing was already in place, mostly as side-effects of foundation patches (Wave 5) and reliability sweeps (v1.1.10 + v1.1.11). Concrete pre-existing platform-aware surfaces:

- `app/src/main/core/pty/local-pty.ts:47-85` — `resolveWindowsCommand` (PATH+PATHEXT walker) shipped in v1.1.x and re-verified during the v1.1.10 reliability sweep (`backend-reliability-fixer` agent added the ENOENT pre-flight at `:215-230` that lets the launcher fallback walk reach alternative commands).
- `app/src/main/core/pty/local-pty.ts:175-197` — `platformAwareSpawnArgs` resolves first, then wraps `.cmd`/`.bat` through `cmd.exe /d /s /c` and `.ps1` through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`. Closes the long-standing P0 from [`docs/01-investigation/01-known-bug-windows-pty.md`](../01-investigation/01-known-bug-windows-pty.md).
- `app/src/main/core/assistant/mcp-host-bridge.ts:84-90` — already routes through `\\.\pipe\<name>` on win32 vs Unix-domain socket on darwin/linux. No v1.2.0 change.
- `app/electron/main.ts:235` — already branched `titleBarStyle: 'hiddenInset'` for darwin, `'default'` (native frame) for everything else.
- `app/src/main/core/voice/native-mac.ts:107` — already gated to return `null` on non-darwin so the dispatcher falls through to the renderer's Web Speech API.

What remained was the distribution layer (CI workflow + NSIS config + PowerShell installer), a handful of renderer polish items (WCO clearance + font + voice copy), and the documentation sweep.

### Implementation, 5 steps + 1 release

Five implementation steps were dispatched as named coder sub-agents over a single working session; lead orchestrator stitched the docs in Step 5 (this entry) and tagged the release in Step 6.

- **Step 1 — CI workflow.** `.github/workflows/release-windows.yml` (70 LOC). Tag-triggered (`v*`) plus `workflow_dispatch`. Single `windows-latest` runner. Setup verbatim copied from `e2e-matrix.yml` (Node + pnpm + `pnpm install --frozen-lockfile` + `pnpm rebuild better-sqlite3 node-pty`). Builds via `pnpm electron:pack:win`. Uploads `dist-electron/SigmaLink-Setup-*.exe` to the GitHub Release via `softprops/action-gh-release@v2`. Concurrency group `release-windows-${{ github.ref }}` with `cancel-in-progress: false` (multiple tag pushes don't cancel an in-flight release). Permissions `contents: write`.

- **Step 2 — Installer plumbing.** `app/electron-builder.yml` edits: dropped `ia32` from `win.target.nsis.arch` (now `[x64]` only); added `nsis.installerIcon` + `nsis.uninstallerIcon` + `nsis.installerHeaderIcon` all pointing at `build/icon.ico`; added `nsis.license: build/nsis/README — First launch.txt` to surface the SmartScreen explainer during install. Plus `app/build/nsis/README — First launch.txt` (72 lines) explaining SmartScreen + the two workarounds. Known cosmetic issue: `nsis.license` shows the README behind a forced "I accept" radio gate — semantically odd but cheap; v1.2.1 polish replaces it with a custom NSH page.

- **Step 3 — PowerShell installer.** `app/scripts/install-windows.ps1` (234 lines / ~180 LOC). Mirrors `install-macos.sh`: PowerShell 5+ gate, AMD64 detect, `Invoke-RestMethod` to `/releases/latest` or `/releases/tags/<tag>`, picks `SigmaLink-Setup-*.exe`, downloads to `$env:TEMP`, `Unblock-File` strips MOTW, `Start-Process` invokes the NSIS installer, cleanup unless `-KeepInstaller`. Params: `-Version <tag>`, `-Quiet` (forwards NSIS `/S`), `-KeepInstaller`.

- **Step 4 — Renderer polish.** `app/electron/preload.ts` exposes `window.sigma.platform = process.platform`. New `app/src/renderer/lib/platform.ts` (12 LOC) exports `getPlatform()` + `IS_WIN32`. `Breadcrumb.tsx` conditional 140px right-padding on win32 to clear the native WCO buttons. `Terminal.tsx:112` prepends `"Cascadia Mono"` to the xterm font stack. `VoiceTab.tsx` becomes platform-aware: `NATIVE_ENGINE_LABEL` + `NATIVE_ENGINE_AVAILABLE` flip on non-darwin; copy reads "Web Speech API (Chromium, requires internet)"; diagnostics dot is grey neutral instead of red error. 2 new test files (`Breadcrumb.test.tsx`, `VoiceTab.test.tsx`) — 9 new cases. Repo total now **205/205**.

- **Step 5 — Docs sweep.** This entry plus updates to root `README.md` (platform badge, Supported platforms table, Windows first-launch subsection), `app/README.md` (Windows install + Distribution table row + "building locally" subsection), `docs/04-design/windows-port.md` (NEW, ~150 lines covering all architectural decisions + touch-point reference table + trade-offs), `docs/01-investigation/01-known-bug-windows-pty.md` (appended "Status: RESOLVED 2026-05-12" section preserving the original investigation as historical record), `docs/08-bugs/BACKLOG.md` (snapshot header v1.1.8 → v1.2.0; v1.2 platform section restructured into shipped + remaining v1.3 backlog), `docs/10-memory/memory_index.md` (T-96…T-103 appended), `docs/09-release/release-notes-1.2.0.txt` (NEW, ~80 lines), `CHANGELOG.md` (new `[1.2.0]` entry).

- **Step 6 — Release tag.** `v1.2.0` annotated tag created and pushed; the CI workflow from Step 1 builds + uploads the EXE to the GitHub Release automatically.

### Decisions taken

- **v1.2.0 minor version bump**: Windows port is a meaningful new platform surface, not a patch. SemVer minor for the new platform; no API-breaking changes for macOS users.
- **Unsigned EXE + PowerShell installer**: EV cert ($300-700/yr) deferred indefinitely. PowerShell installer calls `Unblock-File` to strip MOTW so the most common SmartScreen path is avoided. Manual EXE download still hits SmartScreen — workaround documented in the in-installer welcome page.
- **Web Speech API only on Windows**: native SAPI5 binding is real work (~3-5d) for a feature most users won't notice on a one-rung-down release. Web Speech is honest about requiring internet via the platform-aware VoiceTab copy.
- **x64 only, ia32 dropped**: Windows-on-32-bit is single-digit-percent of the 2026 installed base; doubling CI runtime + asset size isn't worth it.
- **Native frame, not WCO**: 140px Breadcrumb padding is cosmetically awkward but lands the platform in days instead of weeks. WCO is v1.3+ polish.

### What deferred

- Native Windows SAPI5 voice binding → v1.3+ (offline + always-on capture).
- EV cert + signed Windows builds → indefinitely (funded-only).
- `windowsControlsOverlay` frameless chrome → v1.3+ (polish).
- Linux AppImage + .deb test gating → v1.3+ (no CI runner yet).
- Microsoft Store / WinGet distribution → after EV cert.
- Windows auto-update → after signing.
- `nsis.license` → custom NSH page → v1.2.1 (cosmetic).

### Test status

- `pnpm exec tsc -b` → clean
- `pnpm exec vitest run` → **205/205** (was 196/196 at v1.1.11; +9 new specs across `Breadcrumb.test.tsx` + `VoiceTab.test.tsx`)
- `pnpm exec eslint .` → 0/0 (unchanged)
- macOS DMG sign → unchanged from v1.1.11
- Windows EXE → built by CI on `windows-latest`; smoke verified locally via `pnpm electron:pack:win`; Windows VM smoke deferred to first beta tag

### Stale doc closure

`docs/01-investigation/01-known-bug-windows-pty.md` had been carrying a "Status: Root cause confirmed by code inspection" header since Phase 1. The fix actually landed in the v1.1.x stream as part of Wave 5 + the v1.1.10 reliability sweep, but the investigation doc was never updated to reflect that. v1.2.0 appends a new "Status: RESOLVED 2026-05-12" section at the bottom citing the shipping `local-pty.ts:47-230` implementation and cross-linking to the new Windows-port design doc. The original investigation is preserved verbatim as the root-cause record.

**Next session restart point**: SigmaLink at v1.2.0 on `main`. Windows 10/11 x64 is now a peer platform to macOS arm64 (unsigned EXE + PowerShell installer + Web Speech voice fallback). v1.2.1 backlog: `nsis.license` → custom NSH welcome page. v1.3+ backlog: native SAPI5 voice, WCO frameless chrome, Linux test gating. Funded-only: EV cert (Windows), Apple Developer ID (macOS), Picovoice (wake-word).

---

## Phase 20 — v1.2.6 browser MCP stdio switch (May 13, 2026)

The v1.2.5 post-install regression sweep fixed bundling and PATH for the Playwright MCP supervisor, but the deeper bug remained: Playwright needs Chromium binaries (~170 MB) that the DMG doesn't ship, and Playwright can't auto-download without a TTY. The user's stdio suggestion (from the v1.2.5 DMG report thread) was the right answer.

### Pre-flight validation

Four investigator validations confirmed the diagnosis:
1. `@playwright/mcp` needs Chromium via `playwright-core` registry — TRUE.
2. DMG (501 MB) contains no `.local-browsers/` — TRUE.
3. Playwright auto-downloads only with a TTY — our supervisor spawn had `stdio: ['ignore', 'pipe', 'pipe']` — TRUE.
4. Supervisor's `app:browser-mcp-failed` broadcast fires only after 3 retries (~4.5 s) — agent MCP handshake times out first — TRUE.

Conclusion: the HTTP supervisor approach (v1.2.0–v1.2.5) was fundamentally flawed for packaged builds.

### Implementation — 3 steps

**Step 1 — Config writer rewrite.** `mcp-config-writer.ts` changed from HTTP URL to stdio command:
- Claude `.mcp.json`: `{ command: 'npx', args: ['-y', '@playwright/mcp@0.0.75'] }`
- Codex `config.toml`: `transport = 'stdio'`, `command = 'npx'`, `args = ["-y", "@playwright/mcp@0.0.75"]`
- Gemini `extension.json`: same command/args shape
`sigmamemory` stdio config unchanged (already stdio, already works).

**Step 2 — Supervisor deletion.** Deleted `playwright-supervisor.ts` (~400 LOC). Removed from:
- `rpc-router.ts` (import, instantiation, sharedDeps field, shutdown hook)
- `launcher.ts` (dropped `playwrightSupervisor.start()` call, dropped `mcpUrl` parameter)
- `manager.ts` (removed supervisor from ManagerDeps/RegistryDeps, removed `ensureSupervisor()`/`getMcpUrl()`, `teardown()` no longer stops supervisor)
- `controller.ts` (removed `getMcpUrl` RPC, `openTab` no longer calls `ensureSupervisor()`)
- `router-shape.ts` (removed `browser.getMcpUrl` type)
- `rpc-channels.ts` (removed `browser.getMcpUrl` from CHANNELS, `app:browser-mcp-failed` from EVENTS)
- `schemas.ts` (removed `browser.getMcpUrl` stub)

**Step 3 — Renderer cleanup + dep move.**
- `RufloReadinessPill.tsx`: removed `app:browser-mcp-failed` subscription and `browserMcpFailed` state/map.
- `McpServersTab.tsx`: shows static stdio command instead of querying a dynamic URL.
- `package.json`: `@playwright/mcp` moved from `dependencies` back to `devDependencies`.
- Test file `mcp-config-writer.spec.ts`: 3 cases rewritten for stdio output shape.

### Aggregate gates
- `pnpm exec tsc -b` → clean
- `pnpm exec vitest run` → **194/194** (34/36 files pass; 2 pre-existing Electron install failures in assistant tests unrelated to this change)
- `pnpm exec eslint .` → 0/0
- DMG size reduction: ~50 MB (no `@playwright/mcp` in bundled node_modules)

### Decisions taken
- **Pin to `@playwright/mcp@0.0.75`** instead of `@latest` — avoids upstream surprise breakage.
- **Keep `bootstrapNodeToolPath()`** — still needed because agents (spawned by our PTY launcher) inherit `process.env.PATH`; without `/opt/homebrew/bin`, `npx` is still unreachable.
- **Accept no shared browser state across panes** — each pane spawns its own Chromium. Theoretical benefit was never realized in practice; concurrent automation drivers on one Chrome instance creates more races than it solves.

### Risks documented
1. No `npx` on PATH (rare; mitigated by PATH bootstrap + documented requirement).
2. First-call latency (~10 s npx + ~30 s Chromium download; visible in pane terminal).
3. Pinned version means we miss upstream fixes until we bump intentionally.
4. Each pane gets its own browser — no shared cookies/localStorage.

**Next session restart point**: SigmaLink at v1.2.6 on branch `v1.2.6-stdio-mcp`. Browser MCP is now stdio-only. v1.2.7 backlog: Playwright e2e selector refresh; provider registry edge cases; true pane fullscreen. v1.3+ backlog: Apple Developer ID / notarisation, EV cert, WCO frameless chrome, Linux test gating.

---

## Phase 21 — v1.2.7 multi-workspace state preservation (May 13, 2026)

Codex implemented the approved v1.2.7 plan in a dedicated worktree on branch `v1.2.7-multi-workspace-state`. Ruflo MCP was healthy in stdio mode and used for coordination status.

The fix clarifies the actual failure mode: PTYs were not killed on workspace switch, but xterm unmounts erased visible scrollback. v1.2.7 exposes `pty.snapshot(sessionId)` over RPC and replays the existing registry ring buffer before attaching live PTY data on terminal remount.

Resume reliability was hardened by extending external session id scanning from 100 to 500 lines, reporting rows missing `external_session_id` as failed resume results, and surfacing restore failures through sonner toasts. Sidebar polish makes close buttons available on every row and verifies the persisted workspace dropdown.

Verification added: registry snapshot test, resume missing-id failure test, reducer non-destructive workspace-switch tests, sidebar dropdown/close tests, and a Playwright multi-workspace pid-stability spec.

---

## Phase 22 — v1.2.8 session capture rewrite (May 13, 2026)

A Windows user hit the v1.2.7 resume-failure toast: spawned 4 panes, sat at the MCP approval prompt, quit without interacting, relaunched → "Could not resume 4 panes: missing external_session_id." Investigation confirmed the toast was correctly reporting two real bugs:

1. **session-id-extractor only handled Claude** — codex/gemini/kimi/opencode all returned `null`. 4 of 5 providers could never capture a session.
2. **Claude prints its session ID only AFTER the MCP approval prompt** is dismissed. Spawning + quitting without interaction never captured anything for Claude either.

### Architecture pivot

Research confirmed every provider supports `--continue`-style "resume latest in cwd", and two providers (Claude, Gemini) support `--session-id <uuid>` for pre-assignment. Replaced the fragile stdout-scrape pipeline with a hybrid strategy:

**Spawn-time capture:**
- **Claude + Gemini**: SigmaLink generates a UUID locally (`crypto.randomUUID()`) BEFORE spawn, passes it via `--session-id <uuid>`, and writes the DB row synchronously. Zero extraction. Zero race.
- **Codex + Kimi + OpenCode**: Spawn normally; async disk-scan at +2s/+5s/+15s post-spawn reads the provider's deterministic session directory and stamps the row.
  - Codex: glob `~/.codex/sessions/**/rollout-*.jsonl` (UUID in filename, 5-min mtime window).
  - Kimi: walk `~/.kimi/sessions/<project-hash>/<uuid>/`.
  - OpenCode: `opencode session list --format json` filtered by `directory === cwd`.

**Resume strategy:**
- Try captured `external_session_id` via provider-specific resume flag.
- If missing OR if ID-resume fails: fall back to universal `--continue` / `--last` / `--resume latest`. Every provider supports this fallback.
- Missing `external_session_id` is NO LONGER a failure — silently routes to `--continue`. Only genuine spawn errors surface a toast.

**UI:**
- Aggregate toast instead of per-workspace: "Resumed N panes. M panes need to be respawned. [Respawn fresh]"
- New `panes.respawnFailed` RPC re-spawns failed-resume rows in their existing worktrees with no resume args. Same provider, same cwd, fresh PTY. Worktree files + branches preserved.

**Cleanup:**
- DELETED `session-id-extractor.ts` + tests (~174 LOC).
- DELETED registry scan loop (`scanExternalSessionId`, `recordExternalSessionId`, `pendingLine`, `scanDone`, `scannedLines`, `scan-line-limit`).
- Replaced `onExternalSessionId` option with `onPostSpawnCapture` hook.
- Kimi install hint corrected from npm to PyPI: `pip install kimi-cli`.

### Files touched
- `app/src/main/core/pty/session-disk-scanner.ts` (NEW) — per-provider disk-scan logic
- `app/src/main/core/pty/resume-launcher.ts` — resume args matrix per provider
- `app/src/main/core/pty/registry.ts` — onPostSpawnCapture hook, deleted scan loop
- `app/src/main/core/workspaces/launcher.ts` — pre-assign UUID for claude/gemini
- `app/src/shared/providers.ts` — Kimi install hint corrected
- `app/src/main/core/pty/session-id-extractor.ts` (DELETED)
- `CHANGELOG.md` — v1.2.8 entry

### Aggregate gates
- `pnpm exec tsc -b` → clean
- `pnpm exec vitest run` → **248/248** (was 221/221; net +27)
- `pnpm exec eslint .` → 0/0
- `pnpm run build` → clean

**Next session restart point**: SigmaLink at v1.2.8 on `main`. Session capture is now reliable across all 5 providers. v1.2.9 backlog: drop Ubuntu CI lanes, Playwright e2e refresh, Terminal.tsx mount race, disk-scan scoping.

---

## Phase 23 — v1.2.9 drop Linux from supported platforms (May 16, 2026)

User decision 2026-05-16: SigmaLink will no longer support Linux. Supported platforms going forward are **macOS arm64 (primary) + Windows x64**.

### Rationale

Linux was never test-gated, never had a release workflow, never had an installer script, and was explicitly excluded from the supported-platform list since v1.2.0. The only remaining Linux surface was two Ubuntu CI lanes (`lint-and-build.yml` and `e2e-matrix.yml`) that were red more often than green due to node-pty prebuild mismatches and xvfb fragility. Removing them simplifies CI and makes the platform stance honest.

### Edits (5 files, single commit)

**Docs:**
- `docs/03-plan/WISHLIST.md`: Removed BUG-W7-000 row (node-pty linux-x64 prebuild missing — moot without Ubuntu CI), removed Linux AppImage / .deb row from v1.3 table, updated v1.2.9 grouping paragraph, added `## Architectural decisions` section documenting the Linux drop and reversal requirements.
- `docs/08-bugs/BACKLOG.md`: Linux AppImage section → `wontfix (2026-05-16)`; Platform / distribution index count 6 → 5.

**CI:**
- `.github/workflows/lint-and-build.yml`: `runs-on: ubuntu-latest` → `macos-14`; job name `lint + build (ubuntu)` → `lint + build (macos)`.
- `.github/workflows/e2e-matrix.yml`: Removed `ubuntu-latest` from matrix; deleted "Install xvfb (Linux)" step; deleted "Run Playwright smoke (Linux under xvfb)" step; unified remaining Playwright step (removed redundant `if: runner.os != 'Linux'`).

**Config:**
- `app/electron-builder.yml`: Added comment above `linux:` block explaining it's for local-build completeness only. Block itself untouched per scope.

### Scope clarifications honored
- `electron-builder.yml linux:` target left alone (docs-only change per user selection).
- No version bump — rides into v1.2.9 release.
- No CHANGELOG.md update — small enough for v1.2.9 "CI + polish" grouping.

### Verification
- `python3 -c "import yaml; yaml.safe_load(...)"` on both workflows → parse cleanly.
- `pnpm exec tsc -b` (from `app/`) → clean.
- `grep` confirms Linux mentions exist only in wontfix / architectural-decision contexts.

## v1.3.0 Phase 24 — Session picker shipment (May 16, 2026)

v1.3.0 ships wishlist item W-1: a per-pane session picker inserted as a new `SessionStep` in the Workspace Launcher wizard (after AgentsStep, before Launch). The feature closes the user-agency gap that v1.2.8 left open — silent automatic resume with no override path. Users now see a chip per pane pre-populated with the smart default (newest session on disk for that provider + cwd) and can override any pane individually via a filterable Popover list (up to 50 sessions, timestamp + first-message preview) or bulk-apply "Resume newest for all" / "All new" / "Reset to suggested" across all panes at once. Scenario B (re-opening a persisted workspace from the sidebar dropdown) routes through SessionStep with chips pre-populated from the previous run's `agent_sessions` rows; no schema migration was needed.

The data layer extension (`listSessionsInCwd` added to `session-disk-scanner.ts`) plus two new RPCs (`panes.listSessions`, `panes.lastResumePlan`) are the only backend changes. The spawn path is unchanged except that `executeLaunchPlan` now pre-stamps `externalSessionId` when the user selects a session, making the v1.2.8 `onPostSpawnCapture` hook a no-op for those rows. Gemini session enumeration is deferred to v1.3.1 (disk layout undocumented upstream). Net test delta: +12-15 Vitest cases, target 263+/263+. Version bumped from 1.2.8 to 1.3.0.

**Next session restart point**: SigmaLink at v1.2.9 on branch `chore/drop-linux-platforms` (commit `a29fdb4`). CI is now macOS + Windows only. v1.3.0 backlog: W-1 session picker + W-3 Ruflo auto-bind. v1.4.0 backlog: W-2 Sigma Assistant orchestrator.

## v1.3.1 Phase 24b — Session picker hotfix (May 16, 2026)

v1.3.1 patches two bugs that shipped with v1.3.0 the same day. The user-reported symptom: a 4-pane workspace re-opened from the sidebar dropdown surfaced 14 panes on Launch (Claude×3, Codex×3, Gemini×3, Kimi×3, OpenCode×1, + 1 stray) AND none of the explicitly-picked sessions actually resumed — every pane started fresh.

Two distinct root causes:

- **Bug A — `panes.lastResumePlan` SQL deduplication failure.** The v1.3.0 controller synthesised `paneIndex` from `ROW_NUMBER() OVER (ORDER BY started_at DESC)` against `agent_sessions`. After three launches of a 4-pane workspace the table held 12 rows, so the picker returned 12 entries; the Launcher's `chooseExisting()` set `preset = plan.length` (12) → the AgentsStep matrix overflowed into 14 panes. Fix: migration `0012_agent_session_pane_index` adds an `INTEGER pane_index` column + `agent_sessions_ws_pane_idx` composite index; the launcher writes the slot on every insert; the controller rewrites the SQL to a correlated `INNER JOIN ... MAX(started_at)` subquery returning one row per `(workspace_id, pane_index)` group. Legacy rows with NULL `pane_index` are filtered out so they cannot inflate the count.

- **Bug B — `paneResumePlan` payload mismatch.** v1.3.0's `Launcher.launch()` emitted `sessionId` inside each `panes[i]` object, but `executeLaunchPlan` reads `plan.paneResumePlan?.find(...)` at the top level. The per-pane field was silently dropped → `resumeSessionId` was always null → `buildResumeArgs` was never called → every pane spawned fresh. Fix: extracted `buildPaneResumePlanArray(paneCount, selections)` helper that emits the top-level array shape the backend expects, plus a dedicated test file (`Launcher.test.tsx`, 7 cases) pinning the contract.

Test delta: 282 → 291 (+9 cases). Files touched: 8 (1 new migration, 1 new test, 6 edits). All four gates green (`tsc`, `vitest`, `eslint`, `build`). Version bumped 1.3.0 → 1.3.1.

## v1.3.2 Phase 24c — Claude pane hotfix (May 16, 2026)

v1.3.2 patches two production bugs reported against v1.3.1 — both specific to Claude's launch path. User opened a 6-pane workspace (Claude × 2, Codex, Gemini, Kimi, OpenCode). The four non-Claude panes worked perfectly (banner + REPL prompt visible, OpenCode even resumed a prior session with full context). Both Claude panes — pane 1 resuming an existing session, pane 2 starting fresh — were completely blank: no banner, no prompt, no output.

Two distinct root causes, both in the spawn path:

- **Pane 1 (resume) — session-slug mismatch across worktrees.** Claude derives its on-disk history path from cwd: `~/.claude/projects/<cwd.replace(/\//g, '-')>/<session-id>.jsonl`. SigmaLink's v1.3.0 SessionStep scans for sessions at `workspace.rootPath` (e.g. `/Users/aisigma/projects/SigmaLink/app`), but every pane spawns inside a per-pane Git worktree at `~/Library/Application Support/SigmaLink/worktrees/<repo-hash>/<branch-seg>` — a different cwd, therefore a different slug. `claude --resume <id>` running in the worktree cannot find the workspace-slug JSONL → Claude exits silently before any output → blank pane.

- **Pane 2 (fresh) — missing parent dir for `--session-id`.** v1.2.8 pre-assigns a UUID via `--session-id <uuid>` for fresh Claude spawns. On a brand-new per-pane worktree, the parent directory `~/.claude/projects/<worktree-slug>/` does not yet exist. Recent Claude versions silently exit when attempting to open the JSONL for write before printing the banner.

Fix design (Option A from the hotfix brief): a new `claude-resume-bridge.ts` module exposes two pure async fs helpers. `prepareClaudeResume(workspaceCwd, worktreeCwd, sessionId)` symlinks the workspace-slug JSONL into the worktree-slug dir BEFORE Claude spawn, using an absolute target path; Claude reads and APPENDS through the link, so the user's project-level history stays unified across worktrees. `ensureClaudeProjectDir(worktreeCwd)` pre-creates the worktree-slug dir for fresh spawns. `executeLaunchPlan` calls the bridge only when `provider.id === 'claude'`. If the resume source JSONL is missing on disk (deleted / pruned) the launcher drops the id and falls through to `--continue` so the pane still spawns instead of going blank.

Security: both helpers refuse paths containing `..` traversal segments, require absolute paths, and require UUID-shaped session ids. Symlink targets are always under `<homeDir>/.claude/projects/` — never outside the user's own Claude data store. `aidefence_scan` clean.

Test delta: 291 → 314 (+23 cases). Files touched: 5 (1 new bridge module, 1 new bridge test, 1 new launcher gate test, 1 edit to `executeLaunchPlan`, 1 edit to `package.json` version bump). All four gates green (`tsc`, `vitest`, `eslint`, `build`). Version bumped 1.3.1 → 1.3.2.

## v1.3.4 Phase 24e — Claude resume spawn fix (May 16, 2026)

v1.3.4 resolves the v1.3.3 reviewer caveat where `claude --resume <uuid>` could exit with code 1 almost immediately inside SigmaLink's per-pane worktrees despite the v1.3.2 JSONL bridge. Live investigation captured the actual process shape (`claude --resume e8b585d8-e103-4b55-9da2-126568111317`) and confirmed the important mismatch: the selected workspace was `/Users/aisigma/projects/SigmaLink/app`, but git worktrees are created at the repository root. The launcher persisted/spawned `cwd=<worktree-root>`, not `<worktree-root>/app`.

That cwd drift broke two Claude assumptions at once. First, Claude's project identity and session history are cwd-derived, while the session picker scanned at the workspace cwd. Second, workspace-local Claude context (`CLAUDE.md`, `.claude/`) is ignored/local and therefore absent from a fresh git worktree checkout.

Fixes shipped:

- New `workspaceCwdInWorktree()` maps repo-root worktrees back to the selected workspace-relative subdirectory.
- `executeLaunchPlan`, swarm agent spawns, boot-time resume, and failed-pane respawn now use that resolved cwd.
- `prepareClaudeWorkspaceContext()` symlinks ignored `CLAUDE.md` and `.claude/` from the real workspace into the pane worktree cwd without overwriting existing files.
- `resumeWorkspacePanes()` now runs the Claude bridge/project-dir setup before boot-time `claude --resume`, so restart restore no longer bypasses the v1.3.2 launcher-only protections.
- Provider launcher suppresses fresh `--session-id` preassignment when resume/continue args are present, avoiding `claude --session-id <new> --resume <picked>`.
- Malformed Claude resume IDs fall back to `--continue` rather than being passed to Claude.

Verification: `pnpm exec tsc -b --pretty false` clean; focused Vitest regression set 47/47 pass; full `pnpm exec vitest run` 323/323 pass after running Electron's install script directly; `pnpm exec eslint .` clean with the existing `use-session-restore.ts:263` warning; `pnpm run build` clean; `node scripts/build-electron.cjs` clean. `pnpm install` populated dependencies but exited nonzero at the known `electron-builder install-app-deps` / ignored native-build-script step.

## v1.3.5 Phase 25 — W-3 Ruflo MCP auto-bind for 5 CLIs + canonical-args fix (2026-05-16)

v1.3.5 ships wishlist item W-3. Investigation revealed that v1.3.4's RUFLO_ARGS shipped `['@claude-flow/cli@latest', 'mcp-stdio']` to every pane's MCP config, but `mcp-stdio` is not a real `claude-flow` subcommand — the canonical form is `['-y', '@claude-flow/cli@latest', 'mcp', 'start']`. Every Ruflo entry written to disk by v1.3.4 failed silently when an external CLI tried to launch the server; RufloReadinessPill's fast-mode check only verified file presence so the pill reported green even though every spawned server exited immediately. The fix ships alongside the long-pending Kimi + OpenCode coverage that closes W-3's "5 CLIs in readiness pill" promise.

`mcp-autowrite.ts` was extended in-place (407 LOC final, under the 500-LOC budget) with the canonical args fix and two new provider targets. Kimi uses the same Claude-Desktop-compatible `mcpServers.{name}.{command, args, env}` schema and reuses `writeJsonMcpFile()` verbatim. OpenCode uses a fundamentally different schema with top-level `mcp` key (not `mcpServers`), entry shape `{ type: 'local', command: flat-array, environment: {...}, enabled: true }`; `mergeOpencodeRufloEntry()` preserves user-set `enabled: false`, top-level `$schema`, and unrelated keys via shallow merge. Both new targets are gated by soft PATH detection (`defaultDetectCli`) or pre-existing file presence to avoid polluting users' home dirs with empty config directories. `verify.ts` extends `RufloWorkspaceVerification` with `kimi`, `opencode`, and a `detected` tri-state so the readiness pill can treat "CLI not installed" as a vacuous pass instead of a red. R1 (npx `mcp start` works with piped stdin) and R2 (`kimi mcp list` / `opencode mcp list` are real subcommands) were verified live before merge.

Test delta: 323 → 339 (+16 new cases — 9 in `mcp-autowrite.test.ts` covering Kimi/OpenCode/regression, 7 in `verify.test.ts` covering vacuous-pass + strict probes). Reviewer (Opus 4.7) approved unconditionally; one low-priority follow-up noted (PATH-detect helper duplicated between `mcp-autowrite.ts` and `verify.ts` — DRY candidate for v1.3.6+). Pre-existing v1.3.4 configs self-heal on first v1.3.5 launch because `isManagedRufloEntry()` recognises any `command === 'npx'` entry and merges the corrected args list; user-set env vars survive the merge.

## v1.4.0 Phase 26 — Sigma Assistant orchestrator resume (May 16, 2026)

v1.4.0 ships wishlist item W-2 in a separate worktree/branch:
`feat/v1.4.0-sigma-assistant-orchestrator`. W-3 / v1.3.5 was shipped on a
parallel lane (Phase 25) the same day.

The feature promotes Sigma Assistant from a fresh one-shot Claude call into a
resumable orchestrator thread. Migration `0013_conversations_claude_session_id`
adds `conversations.claude_session_id`; the assistant runtime captures Claude's
`system.init` `session_id`, persists it via the conversations DAO, and prepends
`--resume <id>` on future turns in the same conversation. If a resume attempt
fails with a likely stale/missing session error, the runtime clears the id and
retries the turn once without resume.

Renderer polish landed in the right rail: compact conversation dropdown,
resumable pill, resume notice, and interrupted-turn banner. Assistant message
rows now start with `toolCallId=sigma-in-flight:<turnId>` and clear that marker
when a final result is persisted, so a restart/crash can surface retry/dismiss
instead of hiding the lost intent.

Codex executed the full W-2 plan in a single sitting against an originally-
estimated 4.5-day budget. Reviewer audit (Opus 4.7) confirmed the estimate was
inflated for plan-specificity reasons — Codex shipped the retry-once safety net
as specified plus two strengthenings: a broader `isLikelyResumeFailure` regex
covering more Claude CLI wording variants, and a `findInterruptedTurn` helper
that requires a real assistant follow-up (not just any later message) before
treating the sentinel as recoverable.

Verification: `pnpm exec tsc -b --pretty false` clean; full `pnpm exec vitest run`
338/338 pass (323 baseline + 15 new — capture, resume args, retry-once with
stale-id clear, sentinel write, Resumable pill, rail dropdown, resume banner,
interrupted-turn retry, migration registration + idempotency); migration node
tests 5/5 pass; `pnpm exec eslint .` clean (one pre-existing `use-session-
restore.ts:263` warning unchanged); `pnpm run build` clean. Pane → Sigma mailbox
back-channel deferred to v1.4.1.

## Phase 27 — v1.4.1 Bridge → Sigma rename + pane mailbox back-channel + SigmaRoom split (May 16, 2026)

v1.4.1 bundles three workstreams approved by the lead, executed in a dedicated
worktree (`feat/v1.4.1-rename-completeness`).

### Workstream 1 — Bridge → Sigma rename sweep

Tier 1 (UI strings): 7 files — Orb state labels, toast, Launcher canvas tile,
SwarmCreate, operator console, RufloSettings, DesignDock.

Tier 2 (code identifiers): `git mv bridge-agent/` → `sigma-assistant/`;
`BridgeRoom.tsx` → `SigmaRoom.tsx`; `BridgeTabPlaceholder.tsx` →
`SigmaTabPlaceholder.tsx`; RoomId union `'bridge'` → `'sigma'` across type
definition, parsers, command palette, right-rail tabs, rooms menu, OriginLink,
tests. KV migration at boot: `bridge.activeConversationId` →
`sigma.activeConversationId` and `bridge.autoFocusOnDispatch` →
`sigma.autoFocusOnDispatch` (idempotent, old key deleted after copy).

Tier 3 (comments): 23 files — Bridge Assistant → Sigma Assistant, Bridge Canvas
→ Sigma Canvas, BridgeVoice → SigmaVoice, BridgeCode → SigmaCode, BridgeMind →
SigmaMind, Bridge pattern → Sigma pattern across all comments/JSDoc strings.

Preserved: generic "bridge" in `claude-resume-bridge.ts` (symlink helper) and
`mcp-host-bridge.ts` (IPC bridge); historical research docs and screenshots.

### Workstream 2 — Pane → Sigma mailbox back-channel

Completes the W-2 vision deferred from v1.4.0. Migration 0014 creates
`sigma_pane_events` table (id, conversation_id, session_id, kind, body, ts)
with composite index. Migration 0015 adds `sigma_monitor_conversation_id` column
to `agent_sessions`. New `monitor_pane({ sessionId, conversationId })` tool
writes the subscription mapping. PtyRegistry's `onPaneEvent` sink (wired in
`rpc-router.ts`) looks up the monitor conversation, INSERTs into
`sigma_pane_events`, and broadcasts `assistant:pane-event` IPC. Renderer-side
`useSigmaPaneEvents` hook subscribes to the IPC; `PaneEventCard` renders inline
event cards in the transcript with "Reply to pane" action.

### Workstream 3 — SigmaRoom.tsx file split

The 922 LOC monolith (already 611 after WS1+WS2) was split into 14 focused
files: 9 custom hooks (`use-sigma-conversations`, `use-sigma-resume-flow`,
`use-sigma-pane-events`, `use-sigma-ruflo-health`, `use-sigma-pattern-probe`,
`use-sigma-dispatch-echo`, `use-sigma-jump-to-message`, `use-sigma-voice`,
`use-sigma-assistant-state`) and 5 sub-components (`SigmaRailDropdown`,
`InterruptedTurnBanner`, `ResumeBanner`, `PaneEventCard`, `PatternRibbon`).
SigmaRoom.tsx reduced to 283 LOC (target was <400).

### Verification

- `pnpm exec tsc -b --pretty false`: clean
- `pnpm exec vitest run`: 363/363 pass (354 baseline + 9 new)
- `pnpm exec eslint .`: clean (pre-existing warning OK)
- `pnpm run build`: clean
- `node scripts/build-electron.cjs`: clean

### Release plumbing

Version bump 1.4.0 → 1.4.1, CHANGELOG.md prepended, release notes created,
master_memory.md + memory_index.md updated.
