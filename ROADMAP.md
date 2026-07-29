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

## Phase 2 — Establish the arm64 baseline — ⏳ OPERATOR-BLOCKED

> `app/docs/perf/2026-07-28-arm64-baseline.md` does not exist. This is the only
> phase no agent can execute. Until it lands, every RAM figure in Phases 3–5 is
> **modeled, not measured** — the Phase 5 tuning constants were chosen against
> the x64-under-Rosetta workload.

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
> asar restored with natives in `app.asar.unpacked`. CI green on all three
> platforms, so the packaged launch is proven beyond macOS. Audit:
> `app/docs/perf/2026-07-28-package-audit.md`.
>
> **Review caught a CI-invisible CRITICAL:** `asar: true` makes
> `app.getAppPath()` return `…/app.asar`, so the operator-copyable External
> Control command ran bare `node` on a path inside the archive →
> `MODULE_NOT_FOUND`. CI could not hit it — packaged smoke covers
> launch/DB/pane/update-check, not External Control. Fixed in `5d33351` via
> `process.execPath` + `ELECTRON_RUN_AS_NODE=1`; win32 quoting followed in #248.
>
> ⚠️ **Owed before release:** packaged smoke of **all three** MCP entries, not
> just External Control. `mcp-jorvis-host-server.cjs` and the memory server now
> run from inside an asar for the first time ever (asar was off since v1.0.1).

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
would restore it and it is still off at v3.0.0. The same v1.0.1 era produced the
`lazy-val` incident — a module externalized at build time, absent from the
packaged DMG, crashing at first launch. That is precisely this phase's failure
mode. Recommendation: prune conservatively (keep anything unproven), and gate on
launching the packaged artifact, never on a passing unit suite.

**Risks.** High blast radius for a packaging change: a wrongly-pruned module
does not fail any test — it crashes the packaged app at first launch, exactly as
`lazy-val` did. Mitigation: package and actually launch on macOS before merge,
exercising DB open, PTY spawn, and an update check. Windows/Linux packaging must
be re-smoked in CI (`e2e-matrix.yml`) since native resolution differs per
platform — mac proves nothing about win32.

**Definition of done.** The packaged app launches from `release/`; a pane
spawns; the DB opens; `Check for updates` returns without error; packaged size
is recorded before/after in the audit doc; CI `e2e-matrix.yml` green on all
three platforms.

---

## Phase 5 — Renderer memory tuning — ✅ MERGED (#247), savings UNMEASURED

> `69edfb9` (limits centralized) · `7baeb93` (trim-on-park) · `5230f7a`
> (`pty.scrollbackRows` setting) · `f968998` (DOM-path trim).
>
> **Review caught a production no-op:** `7baeb93` wired trim only to the xterm
> presenter, but `renderer-mode.ts:14` sets `DEFAULT_RENDERER_MODE = 'dom'` and
> no `panes.renderer%` KV override exists — so `trimScrollback()` had zero
> production callers and saved nothing. `f968998` fixed it with
> `setEngineMounted()`, called from `DomTerminalView`'s real mount/cleanup
> effect (`:189` / `:400`), making `.mounted` a single choke point.
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

**Scope.**
- `src/renderer/lib/terminal-engine.ts:104` (`scrollback: opts.scrollback ?? 8000`)
  and `src/renderer/lib/terminal-cache.ts:256` (`scrollback: 8000`) are the two
  independent defaults; they must move together or the presenters diverge.
- `src/renderer/lib/terminal-cache.ts:70` `TERMINAL_CACHE_LIMIT = 32` and
  `src/renderer/lib/engine-cache.ts:22` `ENGINE_CACHE_LIMIT = 32` are two
  independent caps against a stated design target of 16 panes.
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

---

## Effort / impact table

| Item | Phase | Effort | Impact | Status |
|------|-------|--------|--------|--------|
| arm64 baseline measurement | 2 | S | **High** | ⏳ **operator-only, NOT DONE** — gates every RAM claim |
| Arch-correct macOS updates (B-1/B-2/B-3) | 3 | S | **High** | ✅ MERGED — #247 `5d33351` |
| Prune packaged `node_modules` + restore asar | 4 | M | Medium | ✅ MERGED — #247 `5d33351` |
| Renderer scrollback + LRU tuning | 5 | M | **High** | ✅ MERGED — #247 `5d33351`; saving unmeasured |
| Release blockers (win32 quoting, doc drift, clamp) | — | S | Medium | ✅ MERGED — #248 `2ebd928` |
| One shared shell quoter (C-058/059/060) | — | M | Medium | 📋 parked in [WISHLIST.md](WISHLIST.md) |

**Release checklist (owed before any tag):**
1. Phase 2 arm64 baseline — otherwise no RAM saving may be claimed.
2. Packaged smoke of **all three** MCP entries (External Control is proven;
   jorvis-host and memory-server run from inside an asar for the first time).
3. Version bump — `package.json` is still `3.0.0` and that tag is taken.
4. Release notes must tell Apple Silicon users on the x64 build that they need
   **one manual arm64 install**; their updater cannot rescue them.

**Rejected:** Electron → Tauri/Rust migration. ~630 dev-days (10–15 months
operator-led) for 40–55 %, versus days for 30–40 % via Phases 2–5, and it would
cost the CDP-based browser pane. See ADR-002.
