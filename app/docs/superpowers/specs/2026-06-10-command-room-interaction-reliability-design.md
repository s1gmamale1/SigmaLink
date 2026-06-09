# Command Room Interaction Reliability — Design

**Date:** 2026-06-10 · **Status:** approved by operator · **Source:** WISHLIST "New ideas" (4 untriaged bugs, all root-caused via 3-agent /systematic-debugging sweep + earlier session investigation)

One milestone, four small independent bug fixes. Sequenced A → C → B → D (severity, then size; B and C touch `PaneShell.tsx` so they land in that order to avoid conflicts).

---

## A — Jorvis `launch_pane` panes never render in the Command Room 🐞[high]

**Symptom.** Jorvis reports it launched panes (and names them), but the grid keeps showing only pre-existing panes.

**Root cause.** The `launch_pane` tool handler (`app/src/main/core/assistant/tools.ts:283-300`) spawns via `executeLaunchPlan` but emits no event. The Command Room only adds spawned panes when `assistant:dispatch-echo` arrives (`use-jorvis-dispatch-echo.ts:35` → refetch `panes.listForWorkspace` + `ADD_SESSIONS` at `:76-80`). The controller's `dispatchPane`/`dispatchBulk` DO emit it (`controller.ts:466`, `:620`); the bare tool is their un-echoed sibling twin.

**Decision.** Thread `emit` into `ToolContext` (chosen over routing the tool through `dispatchPane`, which would force a workspaceRoot→workspaceId remap of the tool's contract):
- Add `emit?: (event: string, payload: unknown) => void` to the `ToolContext` interface (`tools.ts:39-92` region).
- Pass `emit: deps.emit` where the ctx object is built inline in `invokeAssistantTool` (`controller.ts:218-235`).
- In the `launch_pane` handler, after `executeLaunchPlan`, loop `out.sessions` and emit `assistant:dispatch-echo` per session — same payload shape as `dispatchPane:464-477`: `{ workspaceId, sessionId, providerId, ok, error, conversationId: null }`. `workspaceId` comes from `ctx.defaultWorkspaceId` (the conversation's workspace — the same source `requireWs` uses). Best-effort try/catch per emit; optional-chained so a ctx without `emit` (tests) is a no-op.
- One fix covers both invocation paths (direct RPC and the MCP host), since both funnel through `invokeAssistantTool`.

**Testing.** `tools.test.ts`: ctx gains a `vi.fn()` emit; assert `launch_pane` emits one echo per spawned session with the right payload, and that a missing `emit` doesn't throw.

---

## B — Screenshot drop/paste never reaches the agent as an image 🐞[medium]

**Symptom.** Dropping a screenshot inserts a path-mention text (degrading to `/var/folders/…` for out-of-workspace files); pasting a screenshot does nothing at all.

**Root cause.**
- Drop: `handleDrop` (`PaneShell.tsx:256-321`) Finder-fallback (`:303-321`) path-mentions every file with no MIME check — image bytes never read.
- Paste: xterm's `handlePasteEvent` reads only `text/plain`; an `image/png` clipboard yields `""` which `terminal-cache.ts:287-291` early-returns. No app-level paste listener exists.
- CLI constraint (researched, cited in WISHLIST): Claude Code & Codex read images CLI-side from the system clipboard via **Ctrl+V**; the PTY is text-only. Electron's `clipboard.writeImage` writes `public.png` but Claude Code reads legacy `«class PNGf»` → clipboard-write silently fails for Claude Code (anthropics/claude-code#30936, open). Both CLIs DO accept an image **file path** in the prompt.

**Decision.** Stage-to-temp-file + inject absolute `@path` (works today for both CLIs; avoid the clipboard-write path entirely):
1. **Capability gate:** `IMAGE_CAPABLE_PROVIDERS = new Set(['claude','codex'])` in a shared module (precedent: `SLASH_CAPABLE_PROVIDERS`, `insertSkillCommand.ts:18`).
2. **New RPC `panes.stageImage({ bytesBase64, ext })`** → main writes to `<userData>/staged-images/sigmalink-img-<ts>-<rand>.<ext>` (mkdir -p; ext allowlist `png|jpg|jpeg|gif|webp`; size cap 20 MB) → returns `{ absPath }`. Touches the known channel triple: `rpc-channels.ts` + `router-shape.ts` + `rpc-router.ts` (sibling-mirror trap — all three or none).
3. **Drop branch:** in `handleDrop`'s Finder fallback, files with `file.type.startsWith('image/')` AND image-capable provider → `file.arrayBuffer()` → base64 → `stageImage` → inject `@<absPath> ` via the existing `rpc.pty.write`. All other files/providers keep the current relative-mention behavior.
4. **Paste interception:** capture-phase DOM `paste` listener on `paneContainerRef` (`PaneShell.tsx:148`), mirroring the Cmd+T handler pattern (`:192-217`). When `clipboardData` contains an image item AND the provider is image-capable AND the session is running → `preventDefault()` + `stopPropagation()` → `getAsFile()` → stage → inject. Otherwise do nothing (xterm's text paste untouched).
5. **Affordance:** success toast "Screenshot staged — @path inserted".

**Testing.** Main-side: stageImage rejects bad ext / oversized / writes file + returns path (tmpdir). Renderer-side (jsdom): drop with an image File on a claude pane stages+injects absolute path; non-image file keeps mention path; shell provider keeps mention path; paste with image item interception vs text paste pass-through.

---

## C — No Copy/Paste on right-click in a terminal pane 🐞[medium]

**Symptom.** Selection + right-click → menu has Reveal/Open shell/Stop/Close but no Copy/Paste; selection can't be copied.

**Root cause.** Radix `ContextMenuTrigger` (`PaneShell.tsx:443`) wraps the pane body and `preventDefault()`s `contextmenu` → xterm/native copy never fires; the 7 menu items (`:534-581`) never included Copy/Paste; no clipboard wiring in `terminal-cache.ts` (no `copyOnSelect`, no `@xterm/addon-clipboard`; xterm `^6.0.0`).

**Decision** (operator chose menu + copy-on-select):
- `terminal-cache.ts`: add one-line `export function getCached(sessionId: string): CacheEntry | undefined` (cache map at `:129`; `hasCached` at `:439` doesn't return the entry). Add `copyOnSelect: true` to `buildTerminalOptions` (`:175-196`).
- `PaneShell.tsx`: two new `ContextMenuItem`s at the top of `ContextMenuContent` (`:534`) + a separator:
  - **Copy** — `getCached(activeTabId)?.terminal.getSelection()` → `navigator.clipboard.writeText` (pattern: `ErrorBoundary.tsx:111`); disabled when `!hasSelection()`.
  - **Paste** — `navigator.clipboard.readText()` → `rpc.pty.write(activeTabId, text)` (`router-shape.ts:162`, channel `rpc-channels.ts:28`; `rpc` already imported `PaneShell.tsx:26`); disabled when the active session is not running.
- Keyed on `activeTabId` (`:146`) so scratch tabs work.

**Testing.** jsdom: Copy item disabled with no selection / writes selection to a stubbed `navigator.clipboard`; Paste writes clipboard text to a stubbed `rpc.pty.write`; existing menu items unchanged.

---

## D — `+ Pane` dead after restart (gate pill "Swarm is paused") 🐞[medium] — shrunk by PR #134

**Symptom.** After app restart, `+ Pane` is gated (`AddPaneButton.tsx:74-76`: `status !== 'running'`).

**Updated root cause.** The boot janitor marks zombie `running` swarms `failed` (`janitor.ts:82`); nothing sets `'paused'` anywhere in main — the pill text is just the generic non-running message. PR #134 (merged 2026-06-10) added `unfailZombieSwarms` (`resume-launcher.ts:344`) healing `failed`→`running` at resume — but ONLY when `spawned > 0` (`:526`) / `resumed.length > 0` (`:728`), and the renderer can hold a stale status if `swarms.list` (`use-session-restore.ts:146`) races the heal. No `swarms.resume` RPC exists as an escape hatch.

**Decision** (operator chose auto-resume on click):
- New `swarms.resume(swarmId)` RPC (triple: `router-shape.ts` swarms block `:400-431` + `rpc-router.ts` handler + types): `UPDATE swarms SET status='running', ended_at=NULL WHERE id=? AND status IN ('failed','paused')`. Returns `{ ok, healed }`. Deliberate end-states (`completed`) stay ended — same policy as `unfailZombieSwarms`.
- `AddPaneButton.tsx`: in `addPane()`, when `activeSwarm && activeSwarm.status !== 'running' && activeSwarm.status !== 'completed'` → `await rpc.swarms.resume(activeSwarm.id)` then proceed; refresh swarm state after. Relax `getAddPaneDisabledReason` (`:74-76`) so `failed|paused` no longer disables (keep disabled for `completed`).

**Testing.** Resume RPC via the raw-DB shim/MockDb (never `new Database()` — Electron ABI); AddPaneButton jsdom: paused swarm click → resume called then addAgent; completed swarm stays gated.

---

## Cross-cutting

- **Gate:** `tsc -b` + full `vitest run` + `eslint` + `vite build`/`electron:compile` locally; e2e via CI e2e-matrix (never local with a live app).
- **Files under 500 lines:** `PaneShell.tsx` is already large; B adds ~60 lines, C ~40 — if it crosses the threshold, extract `usePaneImageStaging.ts` (B's drop/paste logic) as a hook.
- **Execution:** independent lanes possible; B and C share `PaneShell.tsx` → land C first (smaller) then B rebases, or same lane.
- **Out of scope:** clipboard-write image path (blocked upstream by Claude Code PNGf bug), boot-path swarm status rework (covered by #134 + escape hatch), Gemini image capability (unverified), Windows paste specifics (image staging is platform-neutral; Windows clipboard formats untested).
