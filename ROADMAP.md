# SigmaLink — Roadmap

SigmaLink is an Electron desktop workspace for launching and coordinating live
Claude/Codex/Gemini/Kimi/OpenCode agent panes with worktrees, Ruflo
memory/orchestration, browser tools, voice, and review workflows. The immediate
operational concern is **RAM and CPU pressure from live multipane agent trees**.

This ROADMAP is the single source of truth for what to build next.

---

## How to read this

- **Phases are ordered by value/effort**, with cross-phase prerequisites called out.
- **Effort** is S (≤½ day), M (1–2 days), L (3–5 days), XL (>1 week).
- Confirmed bugs are fixed before new feature phases.

---

## Phase 1 — Kimi Code pane compatibility (2026-07-24) — ✅ SHIPPED

Merged to main in `b6fee89` (#245). Plan:
[`app/docs/superpowers/plans/2026-07-24-kimi-code-pane-compatibility.md`](app/docs/superpowers/plans/2026-07-24-kimi-code-pane-compatibility.md).
Deferred items (FlowView scroll-pin churn, `logicalLines()` windowing, DECSET-25
`cursorHidden` gating, NAME-slot sync, shell-path cache freshness, dead
`SIGMA::LABEL` reader removal) remain in [WISHLIST.md](WISHLIST.md).

---

## Confirmed bugs to fix first (hotlist)

> **Status 2026-07-29 — all three FIXED and MERGED** in PR #247 (`5d33351`).
> ⚠️ Shipping the fix does **not** rescue already-trapped installs: an Apple
> Silicon user on the x64 build reports `process.arch === 'x64'`, so their
> updater hands them x64 one last time before the fix can take effect. Every
> such user needs **one manual arm64 install** to escape. Say so in the release
> notes.

| # | Sev | Bug | Where | Effort |
|---|-----|-----|-------|--------|
| B-1 | **Critical** | macOS auto-update serves the **x64** DMG to every Mac, including Apple Silicon. `.find()` takes the first `.dmg` in `latest-mac.yml`, which electron-builder orders x64-first. Every ARM user is silently moved onto a Rosetta-translated build and can never escape via the in-app updater. | `electron/auto-update.ts:87` | S |
| B-2 | Medium | The diagnostic window reports `process.arch`, which returns `'x64'` under Rosetta — so the one surface that could reveal B-1 confirms the wrong answer. | `electron/main.ts` (`buildDiagnosticHtml`) | S |
| B-3 | Low | Linux AppImage selection has the same unfiltered `.find()` shape. Benign today (only `x64` is published) but it breaks the moment an `arm64` AppImage ships. | `electron/auto-update.ts:68` | S |

**Measured impact of B-1** (operator's machine, Apple M4, v3.0.0, 17 live panes,
2 windows): Rosetta translation arenas account for **468 MB / 3338 MB = 14 %** of
SigmaLink's own footprint, plus a large CPU/battery tax (renderer observed at
77 % CPU). Receipts in Phase 2.

---

## Phase 2 — Establish the arm64 baseline — ✅ MEASURED (2026-08-01)

> `app/docs/perf/2026-07-28-arm64-baseline.md` now exists. Measured on the
> operator's native-arm64 v3.0.0 install: **zero Rosetta regions on all six
> processes**, total footprint 3338 MB → **1761 MB**.
>
> ⚠️ **Two caveats that change how the numbers may be quoted.**
> 1. **The A/B is not controlled.** The x64 run was 17 live panes; the arm64 run
>    was 14. The −47% total is *indicative only* — do not quote it as the
>    Rosetta saving. The clean result is the translation arenas: **468 MB → 0**,
>    which is pane-count independent.
> 2. **The heavy renderer's addressable working set is ~336 MB dirty, not the
>    715 MB footprint** (795.7 MB resident, of which `__TEXT` is 337.5 MB
>    resident / 0 dirty — shared, file-backed library code). The reclaimable
>    part is ~261 MB of V8/Blink heap. **Phase 5's constants were chosen against
>    "1684 MB", which is ~5× the addressable set** — see the follow-up below.

**Goal.** Every later optimization is measured against a native-arm64 build
rather than a Rosetta-translated one, so no effort is spent chasing translation
overhead.

**Deliverables.**
- `app/docs/perf/2026-07-28-arm64-baseline.md` — an A/B table of
  `phys_footprint` per process, x64-under-Rosetta vs native arm64, at an
  identical pane count.
- A recorded per-process breakdown for the heavy renderer
  (`vmmap -summary` region table) that later phases diff against.

**Why now.** It is the prerequisite for Phase 5 and it validates the 468 MB
claim before any code is written. Zero code, ~30 minutes, and it is the only way
to learn what fraction of the 1684 MB renderer is genuinely the app's own
working set.

**Scope.**
- Quit SigmaLink. Install `SigmaLink-3.0.0-arm64.dmg` from the v3.0.0 release
  (already published; the operator's current install is `SigmaLink-3.0.0.dmg`).
- Confirm native execution: `lipo -archs /Applications/SigmaLink.app/Contents/MacOS/SigmaLink`
  must print `arm64`, and `vmmap -summary <renderer-pid> | grep Rosetta` must be
  empty.
- Restore the same workspace and pane count as the x64 measurement (17 live
  panes, 2 windows).
- Record `footprint -p <pid>` for main, both renderers, GPU, and both utility
  helpers; record `vmmap -summary` for the heaviest renderer.

**Findings + recommendation.** Measured on the x64 build: main 389 MB · renderer
A 1684 MB · renderer B 757 MB · GPU 464 MB · utilities 44 MB = **3338 MB**, of
which Rosetta arenas (`Rosetta JIT` / `Generic` / `IndirectBranch` / `Arena`)
total **468 MB**. Separately, 1813 MB across 16 hosted agent CLIs
(claude/codex/kimi) is not attributable to SigmaLink and no change here affects
it. Recommendation: measure before tuning — the renderer decomposition in
Phase 5 is currently **modeled, not measured**.

**Risks.** The arm64 build is unsigned ad-hoc like the x64 one, so Gatekeeper
will require the documented `xattr -cr` / "Open Anyway" workaround —
`build/dmg/README — Open SigmaLink.txt` already covers it. Pane count must match
the x64 run or the A/B is meaningless; record the count explicitly.

**Definition of done.** `app/docs/perf/2026-07-28-arm64-baseline.md` exists and
contains both columns at a stated identical pane count, and `vmmap` confirms
zero Rosetta regions on the native build.

**Status — met, with one clause partially met.** ✅ The doc exists with both
columns; ✅ `vmmap` confirms zero Rosetta regions on all six processes.
⚠️ *"at a stated identical pane count"* is **stated but NOT identical** —
17 (x64) vs 14 (arm64). The x64 install is gone, so it cannot be re-run; the
gap is recorded in the doc rather than papered over. This is why the total is
labelled indicative and the Rosetta-arena delta is the load-bearing result.

**Follow-up this opened.** `ROADMAP.md`'s Phase 5 renderer decomposition was
inferred from the x64 run. It should be re-derived from the measured region
table before any further renderer tuning — tracked in `WISHLIST.md`.

---

## Phase 3 — Arch-correct macOS updates — ✅ MERGED (#247)

> Merged in `5d33351`. CI 8/8 on macOS/Windows/Ubuntu; 11/11 arch-routing tests
> including the asymmetric-fallback pair (arm64 may accept x64 via Rosetta; x64
> must never receive arm64).

**Goal.** An Apple Silicon Mac that auto-updates lands on the arm64 build, and
an Intel Mac never lands on an arm64 build it cannot execute.

**Deliverables.**
- `app/electron/update-asset.ts` — two pure functions, `resolveMacArch()` and
  `pickMacDmg()`, with no Electron imports so they are unit-testable.
- `app/electron/update-asset.test.ts` — table-driven tests over the real
  published v3.0.0 `latest-mac.yml` asset list.
- `electron/auto-update.ts:87` rewired to call `pickMacDmg()`.
- The diagnostic window reporting **effective** arch (B-2).

**Why now.** It is a P0 correctness bug affecting every Apple Silicon user, the
diff is small, and it is what makes Phase 2's fix stick instead of regressing on
the next update.

**Scope.**
- Extract asset selection out of the `update-available` handler into
  `electron/update-asset.ts` (currently inline at `electron/auto-update.ts:87`,
  untested — `electron/**/*.test.ts` is already in the vitest include per
  `vitest.config.ts:24`).
- `resolveMacArch()` must see through Rosetta:
  `process.arch === 'arm64' ? 'arm64' : (app.runningUnderARM64Translation ? 'arm64' : 'x64')`.
  The API is verified present at `node_modules/electron/electron.d.ts:1810`
  (Electron 30).
- `pickMacDmg()` asymmetry is load-bearing: an arm64 host **may** fall back to
  the x64 asset (Rosetta can run it, so old releases stay updatable); an x64
  host **must never** fall back to arm64.
- Apply the same arch filter to `resolveLinuxAppImageUrl()` (B-3).
- Replace `versions.arch` in the diagnostic HTML with the resolved effective
  arch plus a "translated" flag (B-2).

**Findings + recommendation.** The published manifest orders assets
`SigmaLink-3.0.0-mac.zip`, `-arm64-mac.zip`, `SigmaLink-3.0.0.dmg`,
`-arm64.dmg`; `Array.prototype.find` therefore returns the x64 DMG on every
host. The bug is self-sealing because `process.arch` reports `'x64'` inside a
translated process, so a naive `process.arch` check would keep a trapped user
trapped. `sysctl.proc_translated` is available as a cross-check and returns `1`
on the operator's machine today. Recommendation: fix in a dedicated PR, ahead of
the packaging work, so it can ship on its own.

**Risks.** Naming coupling — the selector matches electron-builder's
`-arm64.dmg` suffix convention. If `artifactName` is ever customised for mac the
regex breaks silently, so the test asserts against the real published manifest
list and a `dmgs.length > 0` guard must surface an explicit error rather than a
silent no-update. Shipping the fix does **not** retroactively move already-
trapped users; they need one manual arm64 install (Phase 2).

**Definition of done.** `pnpm vitest run electron/update-asset.test.ts` green,
covering: arm64-native host → arm64 asset; arm64-translated host → arm64 asset;
x64 host → x64 asset; arm64 host with an x64-only manifest → x64 asset; x64 host
with an arm64-only manifest → `null`. `pnpm tsc -b` and `pnpm eslint .` green.

---

## Phase 4 — Stop shipping unused node_modules — ✅ MERGED (#247)

> Merged in `5d33351`. Verified on disk: **380 MB → 274 MB x64 / 266 MB arm64**,
> asar restored with natives in `app.asar.unpacked`. Audit:
> `app/docs/perf/2026-07-28-package-audit.md`.
>
> ⚠️ **The packaged launch is proven on macOS ONLY** — by one manual smoke, not
> by CI. `e2e-matrix.yml` never invokes electron-builder: it runs
> `pnpm run build && node scripts/build-electron.cjs` and launches
> `electron-dist/main.js` from the **unpacked source tree**
> (`.github/workflows/e2e-matrix.yml:90` and `:158` — the smoke and pane-reorder
> jobs). `electron-builder` runs only in
> `release-{macos,windows,linux}.yml`, gated on `push: tags: ['v*']`. So
> `asar: true`, the pruned `files:` keep-list, and `asarUnpack` have been
> exercised by **zero CI jobs on any platform**. Green CI proves the dev-tree
> launch cross-platform; it says nothing about the packaged artifact.
>
> **Review caught a CI-invisible CRITICAL:** `asar: true` makes
> `app.getAppPath()` return `…/app.asar`, so the operator-copyable External
> Control command ran bare `node` on a path inside the archive →
> `MODULE_NOT_FOUND`. CI could not hit it — packaged smoke covers
> launch/DB/pane/update-check, not External Control. Fixed in `5d33351` via
> `process.execPath` + `ELECTRON_RUN_AS_NODE=1`; win32 quoting followed in #248.
>
> ⚠️ **Owed before release, two separate debts:**
> 1. **Packaged launch on Windows + Linux.** Never verified by anything. The
>    v1.0.1 `lazy-val` incident above is the failure mode: a module absent from
>    the package crashes at first launch and fails no test. Build the artifacts
>    on each platform and launch them.
> 2. **Packaged smoke of all three MCP entries**, not just External Control.
>    `mcp-jorvis-host-server.cjs` and the memory server now run from inside an
>    asar for the first time ever (asar was off since v1.0.1).

**Goal.** The packaged app contains only the modules something actually resolves
at runtime, cutting install size and cold-start file I/O without changing
behaviour.

**Deliverables.**
- An updated `files:` block in `app/electron-builder.yml` that prunes
  `node_modules` to the externalized set.
- `asar: true` restored with correct `asarUnpack` patterns for the native
  modules.
- `app/docs/perf/2026-07-28-package-audit.md` — before/after `du -sh` of the
  packaged app plus a launch-smoke checklist.

**Why now.** It is mechanical, independently verifiable, and the current state
ships ~110 MB that nothing loads.

**Scope.**
- `scripts/build-electron.cjs:21-40` externalizes only `electron`,
  `better-sqlite3`, `node-pty`, and a set of unused Drizzle drivers; everything
  else is inlined into `electron-dist/main.js`. Vite likewise inlines all
  renderer deps into `dist/assets/*.js` (2.0 MB total).
- Measured today: `Resources/app/node_modules` = **128 MB**, led by
  `lucide-react` 34 MB (bundled to a 34 KB chunk), `@sigmalink` 21 MB,
  `drizzle-orm` 14 MB, `better-sqlite3` 12 MB, `@xterm` 11 MB, `react-dom`
  7.1 MB, `zod` 5.6 MB, `isomorphic-git` 4.6 MB.
- **Verify before pruning** which modules are genuinely external at runtime.
  `better-sqlite3` and `node-pty` are certain. `@sigmalink/voice-whisper` ships
  a `.node` binary and is **not** in the esbuild external list — resolve that
  contradiction before touching it. Check whether
  `src/main/core/assistant/mcp-host-server.ts` (a separate stdio bundle) pulls
  anything else from disk.
- Re-enable asar with `asarUnpack` limited to the confirmed native set, then
  package and launch the real packaged app.

**Findings + recommendation.** `asar: false` was set in v1.0.1 as a deliberate
"guarantee the native modules load" retreat; the config comment says v1.1.0
would restore it and it was still off as of v3.0.0 (`5d33351` flipped it on).
The same v1.0.1 era produced the
`lazy-val` incident — a module externalized at build time, absent from the
packaged DMG, crashing at first launch. That is precisely this phase's failure
mode. Recommendation: prune conservatively (keep anything unproven), and gate on
launching the packaged artifact, never on a passing unit suite.

**Risks.** High blast radius for a packaging change: a wrongly-pruned module
does not fail any test — it crashes the packaged app at first launch, exactly as
`lazy-val` did. Mitigation: package and actually launch on macOS before merge,
exercising DB open, PTY spawn, and an update check. Windows/Linux packaging must
be smoked the same way, **by hand or on a tagged release build** — native
resolution differs per platform and mac proves nothing about win32. CI cannot
cover this: `e2e-matrix.yml` never packages (see the header block above).

**Definition of done.** ✅ *macOS:* the packaged app launches from `release/`; a
pane spawns; the DB opens; `Check for updates` returns without error; packaged
size recorded before/after in the audit doc. ❌ *Windows + Linux:* the same
packaged-launch checklist is **still unmet** — green `e2e-matrix.yml` does not
satisfy it, because that workflow launches the unpacked `electron-dist/` tree,
never a packaged artifact.

**Re-verified at `51d3a0d8` (2026-08-01), macOS arm64.** The earlier macOS smoke
was taken at an older SHA; this one is a fresh `electron-builder --mac dmg
--arm64` off `origin/main`:

- both hooks ran — `[verify-packaged-deps] 6 keep-list module(s) present`, and
  `[adhoc-sign] chmod 0755 … spawn-helper` ×2 → `restored +x on 2
  spawn-helper(s)`. **The chmod fired, i.e. the helpers really did arrive
  non-executable** — that net is load-bearing, not defensive decoration;
- on disk: both `spawn-helper`s `-rwxr-xr-x`; `app.asar` carries all six
  keep-list modules (`@sigmalink`, `better-sqlite3`, `bindings`,
  `file-uri-to-path`, `node-gyp-build`, `node-pty`); `lipo -archs` → `arm64`;
- packaged app launched against an isolated `--user-data-dir`: renderer up,
  `sigmalink.db` + WAL created (migrations ran → `better-sqlite3` loaded from
  `app.asar.unpacked`), no `MODULE_NOT_FOUND`;
- a real PTY spawned **through the packaged layout** — node-pty required via
  `app.asar` (the path that triggers its `app.asar` → `app.asar.unpacked`
  helper-path rewrite), returning `PTY_OK_arm64`, exit 0.

⚠️ Requiring node-pty *directly* from `app.asar.unpacked` fails with
`posix_spawnp failed` — node-pty's `helperPath.replace('app.asar',
'app.asar.unpacked')` (`lib/unixTerminal.js:31`) rewrites the already-unpacked
path to `app.asar.unpacked.unpacked`. That is a **probe artifact, not an app
bug** (the app loads through the archive), but it will bite anyone smoking the
packaged tree by hand. Load through `app.asar`.

---

## Phase 5 — Renderer memory tuning — ✅ MERGED (#247), savings UNMEASURED

> Merged in `5d33351` (limits centralized · trim-on-park · `pty.scrollbackRows`
> setting · DOM-path trim). Branch commits were squashed away, so `5d33351` is
> the only resolvable reference.
>
> **Review caught a production no-op:** the first trim wired only the xterm
> presenter, but `renderer-mode.ts:14` sets `DEFAULT_RENDERER_MODE = 'dom'` and
> no `panes.renderer%` KV override exists — so `trimScrollback()` had zero
> production callers and saved nothing. Fixed with `setEngineMounted()`, called
> from `DomTerminalView`'s real mount/cleanup effect (`:189` / `:400`), making
> `.mounted` a single choke point.
>
> A second review round found the first trim did not *hold* — it clamped
> `options.scrollback` then restored it on the next line, a one-shot trim rather
> than a bound, so parked engines regrew (2032 → +9000 lines → 8032). Fixed by
> leaving the engine clamped while parked and restoring on remount, mirroring
> the xterm `detachFromHost`/`attachToHost` pair. **A bound must be tested under
> continued load, not just immediately after it is applied.**
>
> **Built:** shared 8000-visible / 2000-parked limits · caches 32 → 20 ·
> park/reattach trim on both presenters · `pty.scrollbackRows` KV round-trip
> (clamped at `MAX_SCROLLBACK_ROWS`, #248).
> **Spec-only:** the actual RAM saving — no native-arm64 before/after exists.
> Constants were chosen against the x64-under-Rosetta 17-pane workload, so
> **Phase 2 must land before any saving is claimed.**

**Goal.** A 17-pane session holds materially less renderer memory with no
user-visible loss of scrollback on the panes the operator is actually looking
at.

**Deliverables.**
- A `pty.scrollbackRows` KV setting (default 8000, unchanged) surfaced in
  Settings, threaded into both presenters.
- Trim-on-park: `detachFromHost()` trims a parked pane's buffer to a bounded
  row count; re-attach keeps the visible pane at full depth.
- `TERMINAL_CACHE_LIMIT` / `ENGINE_CACHE_LIMIT` lowered from 32 to a
  live-panes-plus-margin value.
- A before/after entry appended to `app/docs/perf/2026-07-28-arm64-baseline.md`.

**Why now.** Last, because it is the only phase whose sizing depends on Phase 2's
measurement, and the only one that can regress UX if mis-tuned.

**Scope.** *(pre-merge snapshot — these file:line references describe the code
as it stood BEFORE `5d33351`. All four constants now live centralized in
`src/renderer/lib/terminal-limits.ts`.)*
- `src/renderer/lib/terminal-engine.ts:104` (`scrollback: opts.scrollback ?? 8000`)
  and `src/renderer/lib/terminal-cache.ts:256` (`scrollback: 8000`) were the two
  independent defaults; they had to move together or the presenters diverge.
- `src/renderer/lib/terminal-cache.ts:70` `TERMINAL_CACHE_LIMIT = 32` and
  `src/renderer/lib/engine-cache.ts:22` `ENGINE_CACHE_LIMIT = 32` were two
  independent caps against a stated design target of 16 panes (now both 20).
- Trim-on-park hooks `detachFromHost()` at
  `src/renderer/lib/terminal-cache.ts:571`; the paired `attachToHost()` is at
  `:556`. The parking contract documented at `terminal-cache.ts:1-40` — output
  keeps flowing and scrollback survives a room/workspace switch — must hold for
  re-attached panes.
- Mirror the existing KV settings pattern (`RufloSettings.tsx:32`,
  `rpc.kv.get`/`set`); a new channel requires all four RPC mirror sites
  (router-shape, rpc-router, `CHANNELS` allowlist, test source) or preload
  silently rejects it.

**Findings + recommendation.** xterm stores ~12 bytes/cell, so a fully-scrolled
`8000 × 120` buffer is ≈11.5 MB; 17 live panes plus LRU-retained exited panes
puts the modeled buffer cost in the 200–420 MB range against a measured
renderer footprint of 1684 MB. **This decomposition is inferred from `vmmap`
region tags and buffer arithmetic, not from a heap snapshot — treat it as
UNVERIFIED until Phase 2 lands.** Three options were considered: (a) drop the
global default to 2500, (b) keep full depth for the focused pane and trim only
parked panes, (c) lower the LRU caps alone. Recommendation: **(b) with (c)
folded in** — see ADR-001.

**Risks.** Trimming a parked buffer is destructive and irreversible; trimming a
pane the user then scrolls back through is a visible regression, so the trim
threshold must sit well above a screenful and the focused pane must never be
trimmed. The two caches enforce a documented mutual-exclusion invariant
(`engine-cache.ts:7-10`) — a session must never hold both a live engine and a
live cached xterm; changing eviction on one side without the other can break it.
Lowering LRU caps risks evicting a pane the user switches back to, so eviction
must continue to prefer exited-PTY entries and never touch a mounted one.

**Definition of done.** Full `pnpm test` + `pnpm tsc -b` + `pnpm eslint .`
green; a 17-pane session measured on the native arm64 build shows a recorded
renderer footprint reduction versus the Phase 2 baseline; switching away from a
pane and back preserves visible scrollback; `pty.scrollbackRows` round-trips
through Settings.

---

## Architecture decisions (ADRs)

### ADR-001 — Trim parked panes rather than lowering the global scrollback default

**Decision.** Keep the 8000-row scrollback for the focused/attached pane and
trim only *parked* (offscreen) panes, combined with lower LRU cache caps. Expose
the depth as a setting, but do not change its default.

**Context.** The renderer's terminal caches keep every recent pane's buffer
alive so scrollback survives room and workspace switches — a contract stated
explicitly at `terminal-cache.ts:1-40` and driven by the operator's "normal
terminal multiplexer" mental model. Three options existed: lower the global
default to ~2500 (simplest, biggest raw win), trim parked panes only (more code,
preserves the contract where it is observable), or lower the LRU caps alone
(smallest change, smallest win).

**Consequences.**
- **+** The pane the operator is actually reading keeps full history, so the
  documented multiplexer contract is preserved where it can be observed.
- **+** Captures most of the memory win, since at any moment the large majority
  of cached panes are parked.
- **+** Lower LRU caps compose cleanly and are independently revertible.
- **−** More code than a constant change, and a new destructive operation
  (buffer truncation) that needs its own tests.
- **−** A user who parks a pane, lets it produce 8000 lines, and then scrolls
  back will see less history than today. Mitigated by keeping the trim threshold
  well above a screenful and shipping the depth as a setting.

### ADR-002 — Fix arch routing rather than migrating off Electron

**Decision.** Treat the measured RAM/CPU load as a packaging-and-tuning problem.
Do not migrate to Tauri/Rust.

**Context.** A full Tauri + Rust migration was costed against the real tree:
58,565 LOC main, 53,855 LOC renderer, 340 RPC channels, 242 main-side test
files, modelled at ~630 dev-days (10–15 months operator-led). Of the measured
3338 MB, ~468 MB is Rosetta translation, ~750 MB is Chromium fixed cost, and
~2120 MB is the app's own JS/DOM working set — which a WKWebView port carries
over unchanged. `src/main/core/browser/cdp.ts` additionally drives the browser
pane through `webContents.debugger.attach('1.3')`, a Chromium-only API with no
WKWebView equivalent.

**Consequences.**
- **+** Phases 2–5 recover an estimated 30–40 % in days, versus 40–55 % in
  10–15 months.
- **+** The browser pane survives; a Tauri port would require redesigning or
  cutting it.
- **−** The Chromium fixed cost (~750 MB) stays on the table indefinitely.
- **−** Revisit if the working set ever shrinks enough that Chromium overhead
  dominates.

### ADR-011 — Windows suppresses managed Codex *stdio* Ruflo MCP by default
**Decision.** On Windows, when no Ruflo HTTP daemon port is available, SigmaLink does NOT write a managed Codex stdio Ruflo MCP entry to `~/.codex/config.toml` and removes any SigmaLink-managed `[mcp_servers.ruflo]` (+ `.env`) table; user-managed tables are preserved (and recorded in `refused`); the operator opts back in with KV `ruflo.codexStdioMcp = 1`. The overwrite path treats any `command="npx"` ruflo block as managed (self-heal), but the DESTRUCTIVE removal uses a stricter marker (`isSigmaLinkManagedCodexStdioBlock`) that additionally requires the `@claude-flow/cli` package (or a managed localhost HTTP block), so a user's own npx-based ruflo is never silently deleted. **Context.** Codex reads user-scoped TOML and has no `--strict-mcp-config` escape hatch (unlike Claude). The per-pane stdio `npx -y @claude-flow/cli@latest mcp start` server resolves to a heavy node CLI child that, repeated across Codex sessions, dominated Windows RAM — a live sample showed ~4 repeated `@claude-flow/cli mcp start` descendants ≈ 1.57 GB. HTTP server-mode is upstream-broken (`ENABLE_RUFLO_HTTP_DAEMON = false`), so stdio was the default Windows multiplier. **Consequences.** (+) Removes the largest avoidable default Windows Codex RAM cost; (+) never touches user-managed Codex MCP entries; (+) HTTP entries still written when a port exists; (+) mac/Linux unaffected (the skip short-circuits before any DB read on non-win32). (−) Default Codex panes on Windows lose Ruflo MCP until HTTP works or the operator opts back in.

### ADR-012 — RAM Brake adds an observed-process second admission pass
**Decision.** Launch admission runs a SECOND pass over live OS process state (`PtyRegistry.list()` + cached process-tree snapshots) that blocks a launch BEFORE any worktree/PTY side effect when an existing pane already exceeds an observed RSS cap (per-workspace or total) or holds duplicate `@claude-flow/cli` stdio MCP server chains — unless `forceRamBrake` is set. Caps are KV-tunable (`ramBrake.maxObservedWorkspaceRssMb`=4096, `ramBrake.maxObservedTotalRssMb`=12288, `ramBrake.maxClaudeFlowStdioPerSession`=1); the error prefix is `RAM_BRAKE_OBSERVED_PROCESS_BUDGET:`. **Context.** The existing `checkRamBrakeAdmission` counts DB sessions/runtime profiles — necessary but blind to a single pane holding multiple MCP descendants, which was the Windows leak. **Consequences.** (+) Genuine observed leaks block before they compound; (+) fail-open by construction — unsupported/failed snapshots contribute zero and the snapshot read is locally `.catch`-guarded, so a snapshot hiccup never blocks a launch; (+) `forceRamBrake` override preserved. (−) One bounded process-tree enumeration per launch (shared TTL cache amortizes it); (+) sessions lacking `workspaceId` (legacy/scratch/swarm panes) count only toward the total-RSS cap, never a specific workspace's, so an unrelated session can't inflate the launching workspace's budget.

### ADR-013 — MCP descendant diagnostics surface through `pty.processStats.mcp`
**Decision.** `pty.processStats` returns an `mcp` summary (`summarizeMcpProcesses`) that classifies `@claude-flow/cli` stdio MCP descendants in a session's process tree, collapsing parent→child match chains so one healthy `npx → node cli.js` server counts as a single server, and reporting `claudeFlowStdioCount`, `duplicateClaudeFlowStdio`, `claudeFlowStdioRssBytes`, `claudeFlowStdioPids`, and the highest-RSS `topClaudeFlowCommand`. HTTP-transport (`-t http` / `--transport http`) servers are excluded (separate long-lived daemon, not a per-session stdio descendant). **Context.** Process snapshots existed but had no MCP-specific analysis; without chain collapse a single Windows server double-counts (the npx launcher node and its resolved cli child both carry the `@claude-flow/cli` command line). **Consequences.** (+) Makes the repeated-stdio-MCP leak observable through existing diagnostics and feeds the observed RAM Brake (ADR-012); (+) chain collapse distinguishes one server from a real duplicate. (−) Classification is a command-line heuristic keyed on `@claude-flow/cli` + `mcp` + `start`.

---

## Effort / impact table

| Item | Phase | Effort | Impact | Status |
|------|-------|--------|--------|--------|
| arm64 baseline measurement | 2 | S | **High** | ⏳ **operator-only, NOT DONE** — gates every RAM claim |
| Arch-correct macOS updates (B-1/B-2/B-3) | 3 | S | **High** | ✅ MERGED — #247 `5d33351` |
| Prune packaged `node_modules` + restore asar | 4 | M | Medium | ✅ MERGED — #247 `5d33351` |
| Renderer scrollback + LRU tuning | 5 | M | **High** | ✅ MERGED — #247 `5d33351`; saving unmeasured |
| Pre-release audit (packaging · win32 · RAM leak) | 6 | L | **High** | ✅ MERGED — #250 `33e83d49`, #251 `71eacd3b` |
| Release blockers (win32 quoting, doc drift, clamp) | — | S | Medium | ✅ MERGED — #248 `2ebd928` |
| One shared shell quoter (C-058/059/060) | 7 | M | Medium | ✅ MERGED — #253 `5e997963` |
| Audit follow-ups (C-061/062/064/065) | 7 | M | Medium | ✅ MERGED — #254 `9d92376f` |
| `forget()` sync process listing (C-063) | — | M | Low | 🟡 **open by design** — the specified fix would SIGKILL stale PIDs |

## Phase 6 — Pre-release audit (#250 · #251) — ✅ MERGED

> A 5-lane audit of `v3.0.0..main` (17 commits, 171 files) before tagging.
> Merged in `33e83d49` (#250) and `71eacd3b` (#251). Surviving minors are parked
> as C-061…C-065 in [WISHLIST.md](WISHLIST.md).
>
> **Every finding failed no existing test.** Several only surface at first launch
> of a packaged build, which no CI job produces.
>
> | | |
> |---|---|
> | `asar: true` (#247) silently disabled the spawn-helper chmod net → every macOS pane would `EACCES` | fixed; **proven on a real `electron-builder --mac` artifact** |
> | win32 shell-first was default-ON and had never been Windows-dogfooded — the "NOT yet dogfooded" comment was deleted, not earned | win32 unset now resolves to `direct`; explicit opt-in preserved |
> | ~1.57 GB Windows stdio-MCP RAM leak, diagnosed and tested, unmerged for 4 weeks | merged, workspace-scoped, with a `ramBrake.observedEnabled` kill switch |
> | `.npmrc node-linker=hoisted` stopped working in pnpm 10+ (settings moved to `pnpm-workspace.yaml`); CI pins 9, so a bump would have shipped a broken package silently | pinned in both dialects |
> | win32 traversal-guard bypass (`split(path.sep)` missed `/`-separated paths) · `forget()` stranding descendants | both fixed |
> | 4 false/stale product-truth claims incl. "Windows SAPI voice not shipped" (it shipped in v1.5.0) | corrected |
>
> New `afterPack` guard (`scripts/verify-packaged-deps.cjs`) asserts the keep-list
> survived packing and **throws** on a miss — it caught a real drift on its first run.
>
> Retired as superseded: PR #209 (rebased into #251) and PR #216 (fixes landed in
> #250; its `voice-win` stub fix salvaged into #251).

---

## Phase 7 — Close the audit follow-ups (#253 · #254) — ✅ MERGED

> Clears **C-058…C-062, C-064, C-065**. **C-063 stays open by design.**
> `5e997963` (#253) · `9d92376f` (#254).
>
> **#253 — one shared shell quoter.** Three sites formatted operator-copyable
> commands with different (or no) quoting. `shared/shell-quote.ts` is now the
> single source: posix `'\''` escaping, real `CommandLineToArgvW`
> backslash-doubling on win32. The reachable bug: cursor-agent's install
> rendered as `bash -c curl … | bash`, which runs `bash -c curl` with `$0` = the
> URL — curl writes usage to stderr, so the pipe got an empty stream and the
> operator saw a silent no-op. Review proved safety by executing 11 hostile
> specs with canary files: none fired.
>
> **#254 — ram-brake and pty minors.** The observed RAM brake now also guards
> `+ Pane` (it previously had one call site, so a blocked workspace could still
> add leaky panes); `forget()` honours `stop({tree:false})`; the keep-list
> verifier checks resolvability rather than presence-by-name.
>
> **C-063 — deliberately NOT fixed.** Routing `forget()` through the TTL-cached
> inspector would feed `stopProcessTrees` a ≤2.5 s stale process table and
> **SIGKILL stale PIDs** — killing an unrelated process is a worse bug class
> than the UI stall it fixes. Two independent reviewers reached that conclusion
> separately. The correct fix (`stopProcessTreesAsync`, noting win32 needs no
> listing at all since `taskkill /T` walks the tree itself) is recorded in
> [WISHLIST.md](WISHLIST.md).
>
> ⚠️ **The C-064 fix itself shipped two release-aborting defects**, both caught
> by review, both invisible to a green suite *and* to a real `--mac --dir` pack:
> a nested dep resolvable via a **sibling** was reported missing, and symlinked
> owner dirs were skipped entirely. Either would abort every release build on a
> healthy tree. The packed tree is flat, so no real pack exercises that code —
> synthetic nested trees are the only evidence that counts there.

---

**Release checklist (owed before any tag):**
1. ✅ **Phase 2 arm64 baseline** — done 2026-08-01,
   `app/docs/perf/2026-07-28-arm64-baseline.md`. Note the two caveats in Phase 2:
   the pane counts differ (17 vs 14), so **the −47% total may not be quoted as a
   saving**; only the 468 MB → 0 Rosetta-arena delta is clean.
2. **Packaged launch on Windows + Linux.** Still verified by *nothing*:
   `e2e-matrix.yml` launches the unpacked `electron-dist/` tree and never invokes
   electron-builder, which runs only on a `v*` tag push. macOS is now proven
   twice — at merge, and re-verified at `51d3a0d8` on 2026-08-01 (pack + launch +
   DB open + real PTY spawn through `app.asar`) — the other two platforms are
   not, and mac proves nothing about either.
3. Packaged smoke of **all three** MCP entries (External Control is proven;
   jorvis-host and memory-server run from inside an asar for the first time).
4. **Windows RAM-brake live verification.** Every receipt in #251 is source-trace
   and unit-test. Nobody has yet proven the brake contains the leak on a real
   Windows box.
5. ✅ Version bump — `app/package.json` is now `3.1.0` (minor: arch-aware
   updater, package prune, RAM brake, shell quoting, win32 spawn-mode default).
   **Bumped, not tagged** — tagging stays an explicit operator action.
6. Release notes must tell Apple Silicon users on the x64 build that they need
   **one manual arm64 install**; their updater cannot rescue them.

**Rejected:** Electron → Tauri/Rust migration. ~630 dev-days (10–15 months
operator-led) for 40–55 %, versus days for 30–40 % via Phases 2–5, and it would
cost the CDP-based browser pane. See ADR-002.
