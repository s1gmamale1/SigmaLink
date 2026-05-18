# 03 — Session freeze on room switch + xterm preservation

**Severity**: P1
**Effort**: M (~1d total — XS quick-win + M architectural fix)
**Cluster**: Pane-grid Cluster A (lead packet — unblocks 12 + 07)
**Suggested delegate**: Opus (architecture) + Sonnet (quick-win sub-step)
**Depends on**: nothing
**Blocks**: 12-pane-focus-fullscreen, 07-responsiveness-raf

## Context

v1.4.1 dogfood (commit `6e635db`, 2026-05-17). User report:

> feels like sessions getting frozen, and need to click to them and wait until they resume which I want them operate like normal terminal regardless of I'm in that workspace or somewhere else in the app.

User's stated mental model: panes are a terminal multiplexer; output keeps flowing regardless of which room/workspace is focused. Current v1.2.7 shipped Approach 1 (cheaper ring-buffer replay model) instead of Approach 2 (true xterm instance preservation) — this packet upgrades to Approach 2 and additionally lands the long-pending v1.2.7 R-1.2.7-1 mount-race quick-win.

## Repro

1. Open workspace A with a Claude/Codex pane streaming heavy output.
2. Navigate to Settings (or any non-Command room) for ≥10 seconds.
3. Return to workspace A's Command Room.
4. **Expected**: panes show every byte that arrived while away, live stream resumes with no perceptible delay.
5. **Actual**: pane appears static/blank briefly after return; clicking the pane (or just waiting) makes it "come back to life"; older output may be missing.

## Architectural diagnosis (per helper-verify audit)

PTYs DO keep running in the main process — `PtyRegistry` is module-singleton and ring buffer drains regardless of renderer mount state. The problem is renderer-side:

- `app/src/renderer/app/App.tsx:91-142` `RoomSwitch` returns different subtrees per `state.room`. Visiting Settings unmounts `<CommandRoom>` entirely → cascades into every `<SessionTerminal>` unmount.
- On return, `Terminal.tsx:152-167` mount sequence is **await `rpc.pty.snapshot` → write to xterm → THEN attach `subscribePtyData`**. The IPC roundtrip + write happens inside an async IIFE; any output emitted by the PTY between the snapshot read and the subscription attach is dropped from the renderer's view (R-1.2.7-1 the v1.2.7 plan flagged as open).
- Ring buffer cap (`app/src/main/core/pty/ring-buffer.ts:4`): **256 KiB per session, NOT 64 KB** as the original investigator report claimed. Still finite — a chatty Claude tool-use loop can exceed 256 KiB across a long Settings detour.

## Two-layer fix

### Layer 1 — Mount-race quick-win (XS, ~5min)

File: `app/src/renderer/features/command-room/Terminal.tsx:152-167`

Reorder so live subscription attaches BEFORE awaiting the snapshot:

```ts
// before (current):
const snapshot = await rpc.pty.snapshot(sessionId);
term.write(snapshot.buffer);
const unsubscribe = subscribePtyData(sessionId, (chunk) => term.write(chunk));

// after:
const pending: string[] = [];
let snapshotDone = false;
const unsubscribe = subscribePtyData(sessionId, (chunk) => {
  if (snapshotDone) term.write(chunk);
  else pending.push(chunk);
});
const snapshot = await rpc.pty.snapshot(sessionId);
term.write(snapshot.buffer);
for (const chunk of pending) term.write(chunk);
snapshotDone = true;
```

Closes WISHLIST line 61 ("Terminal.tsx mount race") and the v1.2.7 R-1.2.7-1 1-5ms IPC drop window.

**Caveat (helper-verify gotcha)**: `pty.subscribe` returns `{ history }` and `pty.snapshot` returns `{ buffer }` — same payload, different field names (schema at `app/src/main/core/rpc/schemas.ts:81`). Quick-win must read `snapshot.buffer`, not `snapshot.history`.

### Layer 2 — True xterm preservation (M, ~1d)

The structural fix the user actually wants. Two equivalent approaches; pick one:

**Approach A — React 19 `<Activity>`**:
- Wrap the room-switch subtree in `<Activity mode={state.room === 'command' ? 'visible' : 'hidden'}>` so React keeps the CommandRoom subtree mounted but pauses its scheduling when hidden.
- `App.tsx:91-142` becomes: render ALL room subtrees always, gate visibility via `<Activity>`.
- Pros: idiomatic React 19, minimal code surface change, automatic event/effect pausing.
- Cons: requires React 19 (already on, check `package.json:79` confirms `^19.2.0`); other rooms (Settings, Memory, etc.) currently use Suspense+lazy — composing `<Activity>` over a lazy subtree needs verification.

**Approach B — Renderer-side terminal-instance cache**:
- Introduce `app/src/renderer/lib/terminal-cache.ts` storing live `Terminal` instances keyed by `sessionId` in a module-singleton `Map`.
- `<SessionTerminal>` mount: if cache has instance, call `terminal.open(divRef.current)` to attach to the new DOM node; else `new Terminal(...)` + cache.
- `<SessionTerminal>` unmount: do NOT `term.dispose()`; just leave instance in cache. Add `term.detach()` or set div to a hidden offscreen container before unmount.
- Subscribe is created once on first cache miss and persists across remounts (the bus listener is keyed by sessionId, not DOM).
- Pros: works on any React; explicit lifecycle.
- Cons: more code; needs LRU eviction when many sessions accumulate (e.g. 16 panes × N workspaces); needs careful focus/resize re-attach.

**Recommendation**: A first (cleaner). Fall back to B if `<Activity>` doesn't compose with the existing lazy-suspense fallbacks in App.tsx.

## Reusable utilities

- `rpc.pty.snapshot(sessionId) → { buffer }` — `app/src/main/rpc-router.ts:490-492`
- `rpc.pty.subscribe(sessionId) → { history }` — same file, line 493-495 (returns same data, alternate field name)
- `subscribePtyData(sessionId, fn)` — `app/src/renderer/lib/pty-data-bus.ts:66` (snapshots listener Set before iterate; safe synchronous unsubscribe)
- `RingBuffer` ctor accepts `limit` override — `app/src/main/core/pty/ring-buffer.ts:4`; currently called with default 256 KiB at `registry.ts:145`. If Layer 2 still misses bytes on long detours, bump default OR thread limit through `PtyRegistry.create({ limit })`.

## File:line targets

| File | Line | Edit (Layer) |
|---|---|---|
| `app/src/renderer/features/command-room/Terminal.tsx` | 152-167 | Layer 1 — reorder mount sequence (subscription before snapshot await) |
| `app/src/renderer/app/App.tsx` | 91-142 | Layer 2A — wrap room subtrees in `<Activity>` (React 19) |
| `app/src/renderer/lib/terminal-cache.ts` | NEW | Layer 2B — module-singleton instance cache (only if Approach A fails) |
| `app/src/renderer/features/command-room/Terminal.tsx` | 267-278 | Layer 2 — skip `term.dispose()` on unmount when cache is in use |

## Tests to add/update

- `app/src/renderer/features/command-room/Terminal.test.tsx` — Layer 1: assert that PTY chunks emitted during snapshot await are NOT lost (use a mock that emits before snapshot resolves).
- `tests/e2e/multi-workspace.spec.ts` — extend with "no buffer loss across room switch": drive N known bytes through a shell pane, switch to Settings, switch back after Ns, assert `term.buffer.length === N + epsilon`.
- `tests/e2e/no-replay-flash.spec.ts` (new, optional) — Layer 2: assert that switching rooms does NOT cause a visible "clear + replay" flash (use Playwright's `page.screenshot()` diff before/after switch).

## Verification

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false         # clean
pnpm exec vitest run                     # 368 baseline + 2-3 new
pnpm exec eslint .                       # 0 errors
pnpm run build                            # clean
node scripts/build-electron.cjs           # clean
```

**Manual smoke** (electron:dev):
1. Open Claude pane that streams output (e.g. `find / -name '*.ts' 2>/dev/null | head -10000`).
2. Switch to Settings for 30s; confirm output stays flowing in main-process logs.
3. Switch back; pane shows ALL bytes that arrived during the detour; no replay flash, no "frozen until clicked" gap.
4. Switch workspaces (A → B → A); same expectations.
5. Open 16-pane grid; confirm all 16 xterm instances survive room switch with no memory leak (Activity Monitor / Task Manager).

## Risks

- R-03-1: `<Activity>` (Approach A) may not compose with React Suspense fallback boundaries in App.tsx — needs verification at the start of implementation. If it doesn't compose, fall back to Approach B.
- R-03-2: Layer 2 increases steady-state renderer memory (kept xterm instances). 16-pane × 4-workspace = 64 instances. Worth a Memory benchmark.
- R-03-3: ResizeObserver re-attach on remount in Approach B needs handling — see existing `Terminal.tsx:174-217` resize logic.

## Closes ship-claims

- v1.2.7 R-1.2.7-1 (mount race) — Layer 1
- v1.2.7 follow-up: "True xterm instance preservation" (`docs/08-bugs/BACKLOG.md` line 40) — Layer 2
- WISHLIST: "Terminal.tsx mount race" line 61 — Layer 1

## Doc source

This brief replaces `docs/08-bugs/v1.4.2-workspace-routing-and-session-freeze.md` Bug B section. File deleted in bundle commit.
