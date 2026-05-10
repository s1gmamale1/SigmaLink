# Ruflo MCP Embed — Architecture Design

**Status:** Draft  •  **Author:** ruflo-architect  •  **Date:** 2026-05-10  •  **Phase:** 4 / Design

This document specifies how SigmaLink embeds a managed Ruflo (claude-flow) MCP server as an in-process supervised child, exposes a curated subset of its tools to the renderer through a typed RPC namespace, and surfaces three user-facing features (Memory semantic search, Bridge pattern surfacing, Command-Palette autopilot suggestions) without leaking implementation details into the UI layer.

---

## 1. Bundle vs. Lazy-Download — Recommendation: **Option B (Lazy-Download)**

### Cost matrix

| Dimension | Option A — Bundle in DMG | Option B — Lazy-Download |
|---|---|---|
| DMG size impact | +250–350 MB per platform | +0 MB |
| First-run UX | Works immediately, offline | One-time prompt: "Download Ruflo (≈350 MB)" |
| Auto-update payloads | Re-ships full Ruflo every minor release | Untouched by app updates |
| Native deps cross-arch | All four `optionalDependencies` shipped per platform | Resolver picks correct platform tarball at install time |
| Failure surface | Bundling failures block the entire release | Download failures are isolated and retryable |
| User can opt out | No (bytes on disk regardless) | Yes — features degrade cleanly if they never opt in |
| Conflict with user-installed `ruflo` | Same risk both ways | Same risk both ways (mitigated by isolated cwd) |

### Why Option B wins

1. **DMG size is the controlling constraint.** SigmaLink's current DMG is well under 250 MB; bundling Ruflo would more than double that, and the auto-update delta payloads would balloon equivalently. Users on metered connections would feel every minor release.
2. **Most users will never touch Ruflo.** The three features designed below are progressive enhancements on top of token search, plain Bridge chat, and the existing command palette. A user who never opens Memory or Bridge gets zero benefit from 350 MB of always-resident binaries.
3. **Cross-platform native deps resolve cleanly at download time.** `@ruvector/sona-*`, `@ruvector/attention-*`, `@ruvector/rvf-node-*`, and `onnxruntime-node` ship per-platform tarballs via `optionalDependencies`. A lazy install on the host machine gets the right binaries deterministically; bundling forces us to ship every platform variant inside one DMG (or maintain N DMGs that diverge from the public app artifact).
4. **Competitors do this.** Cursor, Zed, and Warp all install language servers / heavy native helpers on demand rather than bundling them. The first-run prompt is a known pattern.
5. **Failure isolation.** If a Ruflo release ships a bad sona binary, lazy-download lets us pin a known-good version at runtime without re-shipping SigmaLink. Bundled, we'd need to re-cut the DMG.

### Acceptance for Option B

- Default state on first install: Ruflo features disabled, with subtle "Download Ruflo to enable" affordance in Memory search bar, Bridge composer, and Settings → Ruflo.
- Settings → Ruflo download button shows progress + size + license blurb.
- Installation target: `userData/ruflo-runtime/` (auto-update-safe).
- Health degrades to "down" silently if user deletes the directory; UI re-offers the download.

---

## 2. Supervisor + Proxy Module Shape

```
app/src/main/core/ruflo/
├── supervisor.ts        # spawns + monitors `bin/mcp-server.js` child
├── proxy.ts             # JSON-RPC client over stdio, multiplexes tool calls
├── installer.ts         # lazy-download + verify (Option B)
├── controller.ts        # builds `ruflo.*` RPC controller
└── types.ts             # shared health states + tool envelopes
```

### `supervisor.ts` — differences from `mcp-supervisor.ts`

The existing `MemoryMcpSupervisor` is a per-workspace fan-out (one child per open workspace, sharing a SQLite file). `RufloMcpSupervisor` is a **process-singleton**: there is exactly one Ruflo child for the whole app, since the renderer's three features consume the same shared embedding store + pattern bank.

Key shape:

```ts
class RufloMcpSupervisor extends EventEmitter {
  state: 'absent' | 'starting' | 'ready' | 'degraded' | 'down';
  start(): Promise<void>;
  stop(): void;
  call<T>(tool: string, params: unknown, timeoutMs?: number): Promise<T>;
  health(): { state: …; lastError?: string; pid?: number; uptimeMs?: number };
}
```

- **Spawn target:** `path.join(rufloRoot, 'node_modules/@claude-flow/cli/bin/mcp-server.js')` directly. We do **not** use `ruflo-mcp-filter.mjs` (the upstream `bin/mcp-server.js` already keeps diagnostics on stderr) and we do **not** invoke the `ruflo` wrapper (which adds CLI-mode arg parsing we don't need).
- **Spawn method:** Reuse Electron's bundled Node via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`. Identical pattern to `MemoryMcpSupervisor` — avoids shipping a second Node binary and avoids version skew.
- **Working dir:** `path.join(app.getPath('userData'), 'ruflo-runtime')`. This isolates AgentDB / patterns / embeddings from any user-level `ruflo` process running in a project's cwd, satisfying the concurrency-isolation constraint.
- **Restart policy:** 3× exponential backoff (1500ms × 2ⁿ), then transitions to `down` permanently. User clicks "Restart Ruflo" in Settings to reset the counter.
- **Health emission:** On every state transition, broadcasts `ruflo:health` with `{ state, lastError, pid, uptimeMs }`. UI consumers (Settings, Memory chip, Bridge composer) subscribe and degrade gracefully.
- **Shutdown:** Hooked into `app.on('before-quit')` next to `shutdownRouter()`. SIGTERM with a 2 s SIGKILL escalation.

### `proxy.ts`

A thin JSON-RPC 2.0 client over the child's stdio. Owns:

- A monotonic `id` counter for outbound requests.
- A `Map<id, {resolve, reject, timer}>` for in-flight calls.
- A line-buffered stdout reader that dispatches on `id`.
- A stderr drain (last 4 KB rolling buffer, surfaced in Settings on degraded state).
- Per-call default timeout of 5 s, configurable per tool (e.g. `embeddings_search`: 3 s; `agentdb_pattern-store`: 8 s for cold writes).
- A circuit breaker: 5 consecutive timeouts in 10 s → mark supervisor `degraded` and short-circuit subsequent calls with a typed `RufloUnavailable` error until a probe succeeds.

The `simplify` skill recommends keeping the public surface to `proxy.call(toolName, params)` — every feature handler reads as a one-liner.

---

## 3. Three User-Facing Feature Designs

### Feature 1 — Semantic Memory Search (`MemoryRoom.tsx`)

**Behavior**

1. User types in the existing search bar.
2. On debounce (250 ms), main fires `memory.search_memories(q)` (token) and `ruflo.embeddings.search({ query: q, topK: 10, threshold: 0.5 })` (semantic) **in parallel**.
3. Results merge: token-match rows first (preserving existing ranking), then semantic-only rows that did not appear in the token set, deduped by memory id.
4. Semantic rows render with a small "Semantic" chip and a similarity score tooltip.

**UI affordances**

- Toggle below the search bar, default ON when `ruflo:health.state === 'ready'`.
- Tooltip: "Find memories by meaning, not just words."
- Toggle disabled and greyed when supervisor is `down` or `absent`. Tooltip then reads: "Download Ruflo to enable" with link to Settings.

**Failure mode**

If `ruflo.embeddings.search` rejects (timeout, supervisor degraded), the merge silently falls back to token-only results — no toast, no error. The chip simply doesn't appear.

### Feature 2 — Bridge Pattern Surfacing (`BridgeRoom.tsx`)

**Behavior**

1. As the user types in the composer, debounce 800 ms.
2. On pause, fire `ruflo.patterns.search({ query: text, topK: 3, minConfidence: 0.7 })`.
3. If at least one hit ≥ 0.7 confidence, render a single "Similar past task" suggestion ribbon above the composer:
   - Headline: "3 successful refactors used: *modular extraction with adapter pattern*"
   - CTA: "Apply" button (fills composer with the pattern's `pattern` field).
4. Dismiss icon hides the ribbon for the current composer session.
5. After a Bridge turn completes successfully (assistant returns without error), call `ruflo.patterns.store({ pattern: <user's original text>, type: 'task-completion', confidence: 0.8 })`. The store call is fire-and-forget — never blocks the UI.

**UI affordances**

- Ribbon uses the same design language as the existing "Bridge tip" surface (see `BridgeRoom` empty-state).
- Visible only when supervisor is `ready`. Hidden, never disabled, when `down`.

**Failure mode**

`ruflo.patterns.search` failure → ribbon never appears. `ruflo.patterns.store` failure → log to local debug, no user-visible feedback. We are willing to lose pattern writes silently because they are background telemetry, not user data.

### Feature 3 — Command Palette Autopilot (`CommandPalette.tsx`)

**Behavior**

1. On every cmdk open event, check a 30-second in-memory cache of the last `ruflo.autopilot.predict()` result.
2. Cache miss → fire `ruflo.autopilot.predict({})` (no args), 2 s timeout, populate cache.
3. Render the result as the topmost "Suggested" group with a single entry: e.g. "Continue refactoring auth module" or "Run /review on your recent changes".
4. Selection routes through existing palette command routing (the predict result includes a `commandId` + `args`).

**UI affordances**

- Suggested entry shows a small Ruflo glyph (one of the existing icons; we do not add a brand mark for v1).
- Group header: "Suggested for you" with subtle subtitle "powered by Ruflo".

**Failure mode**

Cache empty + predict timeout → group simply omitted. Palette renders normally.

---

## 4. Settings UX (`RufloSettings.tsx`, new file)

A new entry in the existing Settings sidebar between "Skills" and "Updates":

| Element | Behavior |
|---|---|
| Status row | Green/yellow/red dot + state label; pulls from `ruflo:health` event |
| "Ruflo embedded" toggle | Default ON if installed, OFF otherwise. Disabled state never displays "downloading" passive-aggressively — instead the toggle is hidden until install completes |
| Download button (Option B only) | Visible when `state === 'absent'`. Shows size, license link, progress, and a Cancel control |
| Disk usage row | "Ruflo data: 12 MB in `~/Library/Application Support/SigmaLink/ruflo-runtime/`" with a "Reveal in Finder" action |
| Restart Ruflo | Only enabled when `state === 'degraded' \|\| state === 'down'`. Resets restart counter |
| Last error pane | Collapsed by default; shows last 4 KB of stderr from supervisor |
| Telemetry toggle | "Share anonymous Ruflo feature usage". Default OFF. Opt-in only |

---

## 5. electron-builder + Auto-Update Interactions

### Bundling boundary

- `electron-builder.config.cjs` **excludes** `node_modules/@claude-flow/**` and `node_modules/@ruvector/**` from the asar (they would not be there anyway, since Ruflo lives under `userData/ruflo-runtime/` post-install).
- The supervisor + proxy + installer modules ship inside the asar (small TS bundle).

### Auto-update behavior

- **App version bump (e.g., 1.0.1 → 1.0.2):** `userData/ruflo-runtime/` is untouched. The new app's supervisor inspects `<runtime>/version.json` and either uses the existing install or prompts re-download if the supervisor's pinned-Ruflo-major changed.
- **Runtime corruption recovery:** Settings → Ruflo → "Reset & Re-download" deletes `<runtime>/` and triggers a fresh install.
- **First-run on a freshly-updated app:** Supervisor probes `<runtime>/node_modules/@claude-flow/cli/bin/mcp-server.js`. Missing → state `absent`, UI shows download CTA.

### Pinned-Ruflo version contract

The app pins a specific `@claude-flow/cli` semver in `installer.ts`. On app update, if the pinned major moved, the installer auto-prompts for re-download (UI: "SigmaLink updated. New Ruflo version available — Update (≈350 MB)?").

---

## 6. Zod Schemas — Six RPC Channels

Add to `app/src/main/core/rpc/schemas.ts`. All hardened (not `stub`), since we control both ends.

```ts
// ── ruflo ─────────────────────────────────────────────────────────────
const RUFLO_HEALTH = z.object({
  state: z.enum(['absent', 'starting', 'ready', 'degraded', 'down']),
  lastError: z.string().optional(),
  pid: z.number().int().optional(),
  uptimeMs: z.number().nonnegative().optional(),
});

const RUFLO_EMBED_SEARCH_IN = z.object({
  query: z.string().min(1).max(2_000),
  topK: z.number().int().min(1).max(50).optional(),
  threshold: z.number().min(0).max(1).optional(),
  namespace: z.string().max(120).optional(),
});
const RUFLO_EMBED_SEARCH_OUT = z.object({
  results: z.array(z.object({
    id: z.string(),
    score: z.number(),
    text: z.string(),
    namespace: z.string().optional(),
  })),
});

const RUFLO_PATTERN_SEARCH_IN = z.object({
  query: z.string().min(1).max(2_000),
  topK: z.number().int().min(1).max(20).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
});
const RUFLO_PATTERN_SEARCH_OUT = z.object({
  results: z.array(z.object({
    pattern: z.string(),
    type: z.string().optional(),
    confidence: z.number(),
    score: z.number(),
  })),
});

const RUFLO_PATTERN_STORE_IN = z.object({
  // NB: upstream takes { pattern, type, confidence } — NOT { namespace, key, value }
  pattern: z.string().min(1).max(8_000),
  type: z.string().max(120).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
const RUFLO_PATTERN_STORE_OUT = z.object({ ok: z.boolean(), id: z.string().optional() });

const RUFLO_AUTOPILOT_PREDICT_IN = z.object({}).strict();
const RUFLO_AUTOPILOT_PREDICT_OUT = z.object({
  suggestion: z.object({
    title: z.string(),
    detail: z.string().optional(),
    commandId: z.string().optional(),
    args: z.unknown().optional(),
  }).nullable(),
});

CHANNEL_SCHEMAS['ruflo.health']             = { input: z.undefined().optional(), output: RUFLO_HEALTH };
CHANNEL_SCHEMAS['ruflo.embeddings.search']  = { input: RUFLO_EMBED_SEARCH_IN, output: RUFLO_EMBED_SEARCH_OUT };
CHANNEL_SCHEMAS['ruflo.patterns.search']    = { input: RUFLO_PATTERN_SEARCH_IN, output: RUFLO_PATTERN_SEARCH_OUT };
CHANNEL_SCHEMAS['ruflo.patterns.store']     = { input: RUFLO_PATTERN_STORE_IN, output: RUFLO_PATTERN_STORE_OUT };
CHANNEL_SCHEMAS['ruflo.autopilot.predict']  = { input: RUFLO_AUTOPILOT_PREDICT_IN, output: RUFLO_AUTOPILOT_PREDICT_OUT };
CHANNEL_SCHEMAS['ruflo.install.start']      = { input: z.object({}).strict(), output: z.object({ jobId: z.string() }) };
```

(Six channels: `health`, `embeddings.search`, `patterns.search`, `patterns.store`, `autopilot.predict`, `install.start`. Plus one event: `ruflo:health`.)

`CHANNELS` set in `rpc-channels.ts` gains the same six entries; `EVENTS` set gains `ruflo:health` and `ruflo:install-progress`.

---

## 7. Open Questions

1. **Pinned Ruflo version policy.** Pin to a specific patch, or a range? Recommend exact patch with a 1-week alert window before bumping.
2. **Telemetry transport.** If telemetry toggle ships ON in v1.x, who receives the events? Out of scope for this design; default OFF avoids the question.
3. **Bridge pattern store namespacing.** Should patterns be scoped per-workspace or global? Recommend global for v1 — patterns are general task templates, not project-specific.
4. **Cmdk autopilot when palette opens 100×/min.** The 30 s cache covers it, but we should also debounce-coalesce duplicate predict calls in flight.
5. **Re-download size guarantee.** Does the installer support resumable downloads? Recommend HTTP `Range` support with checksum verification, deferred to a follow-up ticket.
6. **Native rebuild interaction.** The existing `app:native-rebuild-needed` modal already handles `better-sqlite3` / `node-pty`. Does Ruflo's `onnxruntime-node` need to be added to the boot probe? Recommend NO — Ruflo is opt-in and its load failure should degrade Ruflo only, not show the boot diagnostic window.
7. **Disk-usage indicator scope.** Show only `<runtime>/` or also data caches under `<userData>/ruflo-cache/`? Recommend a single combined number with a tooltip breakdown.

---

## 8. Files Touched (Reference)

- **New**: `app/src/main/core/ruflo/{supervisor,proxy,installer,controller,types}.ts`, `app/src/renderer/features/settings/RufloSettings.tsx`
- **Edit**: `app/src/shared/rpc-channels.ts` (+6 channels, +2 events), `app/src/main/core/rpc/schemas.ts` (+6 schemas), `app/src/main/rpc-router.ts` (build + register `RufloController`, add to `SharedDeps`), `app/electron/main.ts` (`before-quit` hook supervisor.stop), `app/src/renderer/features/memory/MemoryRoom.tsx` (semantic toggle + chip), `app/src/renderer/features/bridge-agent/BridgeRoom.tsx` (pattern ribbon + post-turn store), `app/src/renderer/features/command-palette/CommandPalette.tsx` (autopilot suggested group)
- **Reference only**: `app/src/main/core/memory/mcp-supervisor.ts`, `app/scripts/ruflo-mcp-filter.mjs`

---
