# Agent-attention notifications — sound + workspace/pane glow when an agent is waiting for you

**Date:** 2026-06-14 · **Status:** approved approach, spec under operator review
**Goal:** When a Claude Code / Codex pane **asks a question** or **finishes a turn and idles**, play a sound and make that workspace (in the sidebar) and the specific pane **glow + flicker for 10s, then settle to a static highlight** that clears when the operator looks at it.

## Problem & context (4-agent research, 2026-06-14)

The existing notification stack is mature but mis-aimed for this use case:

- **Sound infra is complete** — `app/src/renderer/lib/sounds.ts` (Web-Audio synth) over a 12-cue catalog in `app/src/shared/notification-prefs.ts`, with DND / quiet-hours / per-cue mute / volume. Cues include `agent-done` (ascending ding) and `agent-crash`. **No `agent-attention` cue exists.**
- **Workspace visuals are minimal** — `app/src/renderer/features/sidebar/WorkspacesPanel.tsx` renders each workspace row with a 3-state status dot only (`running`/`error`/`idle` ring, `STATUS_RING` at ~L98). No glow / flicker / attention state anywhere. The `.sl-bell-pulse` keyframe in `app/src/index.css` (~L659) + `.sl-bell-critical-static` (~L829, reduced-motion companion) is the one proven precedent.
- **Current "not working" smell** — the completion ding actually fires on Jorvis *dispatch* (pane spawn) in `app/src/renderer/features/jorvis-assistant/use-jorvis-dispatch-echo.ts:105` (`playDing()`), i.e. once per spawned pane → the known "20-ding storm" on a 20-agent swarm (WISHLIST). The ding means "a pane spawned," not "an agent needs you." OS notifications are off by default.
- **Competitor (BridgeSpace) research** — does sound-ding + per-pane badge + jump-to-pane. Their "every awaiting-input pane glows purple simultaneously" is explicitly flagged as an **anti-pattern** (`docs/02-research/bridgespace-day185-2026-05-31/REVIEW.md` §2.1). The per-workspace sidebar surface is the better attention channel. Design system already defines an unused `--status-blocked: #C77FE6` purple token (`docs/03-plan/UI_SPEC.md`).

### The one hard constraint

**Interactive Claude Code / Codex panes do not exit between turns.** Every "clean finish" signal the codebase already has — `pty:exit` (direct mode), the shell sentinel `onCliExited` (`app/src/main/core/pty/sentinel.ts`), OSC-133 `D` marks (`app/src/renderer/lib/terminal-engine.ts:133`) — only fires when the **whole CLI quits**. None fire for "asked a question" or "finished a turn & idle." Both of those are the **same runtime state: the agent stopped producing output and is now waiting for the human.** Detecting that transition is the only novel work; the reaction reuses existing infra.

## Decisions (operator-approved)

| Decision | Choice |
|---|---|
| Detection | **Bell + idle hybrid** |
| Cue per event | **Same cue** for "question" and "done/idle" (they're one state) |
| Clear condition | **On focus / visit** |
| Surfaces | **Sidebar workspace row** + **the specific pane** (no OS dock, no toast) |
| Idle timer default | **4 s** of silence after activity (KV-tunable) |
| Per-spawn dispatch ding | **Remove / repurpose** — the ding should mean "an agent needs you" |

## Design

### Detection (main process)

Runs main-side so it is independent of presenter (xterm *and* DOM presenter) and of which OS window owns the pane.

#### 1. OSC-aware bell scanner (primary signal)
New pure module, e.g. `app/src/main/core/pty/bell-scanner.ts`. Feeds on the per-session PTY byte stream already flowing through `PtyRegistry.onData` (`app/src/main/core/pty/registry.ts:282`).

Critical subtlety: `\x07` (BEL) is **also** the String Terminator for OSC sequences — `ESC ] 0 ; <title> BEL` sets the window title, `ESC ] 133 ; ... BEL`, etc. A naive `indexOf('\x07')` would false-fire on every title update. So a minimal byte walker tracks one bit of state — "inside an OSC string" (entered on `ESC ]`, left on `BEL` or `ESC \`) — and counts a BEL as a **real bell only when not terminating an OSC string.** State must persist across chunk boundaries (an OSC string can split across coalesced chunks).

```ts
// pure, no electron imports
class BellScanner {            // one instance per session
  feed(chunk: string): number; // returns count of REAL bells in this chunk
}
```

Each real bell → an attention signal for that session (`reason: 'bell'`).

#### 2. Idle timer (fallback signal)
New pure module, e.g. `app/src/main/core/pty/idle-detector.ts`. Per session: arm/reset a timer on every PTY output chunk; if a session **that has produced output** then goes silent for `idleMs` (default **4000**, read from KV `notifications.idleMs`), fire an idle attention (`reason: 'idle'`). Resets on next output. Injected clock (`setTimeout`/`clearTimeout` passed in) for deterministic tests.

**Bell ⇄ idle dedupe:** if a real bell fired for a session within the last `~6 s`, suppress that session's pending idle fire (the bell already covered it). Prevents double notifications when a CLI both rings and then sits silent.

#### 3. Attention emitter (wiring)
In `app/src/main/rpc-router.ts`, where `PtyRegistry.onData` is consumed, drive both detectors and emit a single routed IPC event to the **owning window** via the existing `WindowRegistry.sendToSessionOwner(sessionId, ...)` (`app/src/main/core/windows/registry.ts`) — so detached-window workspaces (v2.5.0) work with no extra broadcast:

```ts
'agent:attention' → { sessionId, workspaceId, reason: 'bell' | 'idle', ts }
```

This is a **transient UI event** — it does **not** write a `notifications` DB row or a bell-dropdown entry (operator did not pick toast/OS surfaces). `workspaceId` is resolved from the session record.

### Reaction (renderer)

#### 4. Sound — new `agent-attention` cue
Add a `SoundCue` literal + `CueDef` to `SOUND_CATALOG` in `app/src/shared/notification-prefs.ts`, `category: 'alert'` (plays even when the window is backgrounded; inherits the full mute/volume/DND/quiet machinery). Distinct from the dispatch ding — a soft two-note tone.

**Throttle: ≤ 1 attention sound per 2 s (global).** Kills the swarm "machine-gun" — if 20 agents finish together the workspace/pane glows still all light up, but only one sound plays. Lives next to the play call in `app/src/renderer/app/state-hooks/use-live-events.ts`.

**Remove the per-spawn ding:** drop / repurpose `playDing()` in `use-jorvis-dispatch-echo.ts:105` so the audible ding no longer fires per pane spawn. (Jump-to-pane toast behaviour itself is unchanged; only the spurious audio is removed.)

#### 5. State
Two maps in `AppState` (`app/src/renderer/app/state.types.ts`), updated by the reducer (`app/src/renderer/app/state.reducer.ts`):

```ts
attentionWorkspaces: Record<string /*workspaceId*/, number /*ts*/>; // drives sidebar glow
attentionSessions:   Record<string /*sessionId*/,  number /*ts*/>; // drives pane glow
```

- `SET_ATTENTION { workspaceId, sessionId, ts }` → set both maps.
- `CLEAR_WORKSPACE_ATTENTION { workspaceId }` → delete from `attentionWorkspaces`. Dispatched on `SET_ACTIVE_WORKSPACE` for that id (you switched to it).
- `CLEAR_SESSION_ATTENTION { sessionId }` → delete from `attentionSessions`. Dispatched on pane focus (`SET_ACTIVE_SESSION` / `sigma:pty-focus`) for that id.

Two independently-cleared flags by design: **arriving at a workspace** stops the *sidebar* glow (you're here now); each **pane keeps glowing** until you actually focus/engage it — which guides the eye in a multi-pane grid.

`use-live-events.ts` subscribes to `agent:attention`, dispatches `SET_ATTENTION`, and plays the throttled cue.

#### 6. Sidebar glow — `WorkspacesPanel.tsx`
Row reads `attentionWorkspaces[ws.id]`. When present, apply `.sl-attention` (10 s flicker) → swaps to `.sl-attention-settled` (static glow) after 10 s. Pass `attentionWorkspaces` into the panel from `Sidebar.tsx` alongside `sessions` (it already receives the full session list and rolls up status).

#### 7. Pane glow — pane component
The pane border/header (`CommandRoom` / `PaneShell`) reads `attentionSessions[sessionId]` and applies the same `.sl-attention` → `.sl-attention-settled` treatment, keyed on session id.

#### 8. CSS — `app/src/index.css`
Add, mirroring the `.sl-bell-pulse` + `.sl-bell-critical-static` pattern:

```css
.sl-attention          { animation: sl-attention-flicker 1s ease-in-out infinite;
                         box-shadow: 0 0 0 1px hsl(var(--ring)/.6), 0 0 8px 2px hsl(var(--ring)/.25); }
.sl-attention-settled  { box-shadow: 0 0 0 1px hsl(var(--ring)/.4), 0 0 6px 1px hsl(var(--ring)/.15); }
@keyframes sl-attention-flicker {
  0%,100% { box-shadow: 0 0 0 1px hsl(var(--ring)/.6), 0 0 8px 2px hsl(var(--ring)/.25); }
  50%     { box-shadow: 0 0 0 1px hsl(var(--ring)/.2), 0 0 2px 0   hsl(var(--ring)/.10); }
}
```

The global `prefers-reduced-motion` rule (index.css ~L767) already collapses `animation-duration` to `0.01ms`, so reduced-motion users skip the flicker and land on the static glow with no extra code. The flicker is presentation only; the persistent highlight lives in state until cleared on focus.

### Flicker → settle mechanics
The keyframe runs `infinite`; **JS owns the lifecycle.** On first attention for a workspace/session the component renders `.sl-attention` (flicker) and the renderer plays the throttled sound. A single **10 s `setTimeout`** (per workspace-id / session-id, keyed in a `useEffect`) swaps the rendered class `.sl-attention` → `.sl-attention-settled` (static glow). The underlying state flag persists across the swap, so the static glow stays until the focus-clear dispatch removes it. (JS control — rather than CSS `iteration-count` + `animationend` — keeps the 10 s independent of the 1 s cycle count and survives re-renders without restarting the flicker.)

## Component boundaries (each independently testable)

| Unit | Responsibility | Location |
|---|---|---|
| `BellScanner` | bytes → real-bell count (OSC-aware, cross-chunk) | `app/src/main/core/pty/bell-scanner.ts` (new) |
| `IdleDetector` | output gaps → idle events, bell-deduped, injected clock | `app/src/main/core/pty/idle-detector.ts` (new) |
| attention emitter | both detectors → routed `agent:attention` IPC | `app/src/main/rpc-router.ts` |
| attention reducer | event → `attention{Workspaces,Sessions}`; focus-clear | `app/src/renderer/app/state.reducer.ts` + `state.types.ts` |
| sound throttle + cue | ≤1/2 s `agent-attention`; drop dispatch ding | `use-live-events.ts`, `notification-prefs.ts`, `sounds.ts`, `use-jorvis-dispatch-echo.ts` |
| sidebar glow | row reads `attentionWorkspaces` | `WorkspacesPanel.tsx`, `Sidebar.tsx` |
| pane glow | pane reads `attentionSessions` | `CommandRoom` / `PaneShell` |
| CSS keyframes | flicker + settled, reduced-motion safe | `index.css` |

## Edge cases
- **Swarm storm (N agents finish together):** every workspace/pane glows; sound throttled to ≤1/2 s. No machine-gun.
- **Bell + idle both apply:** dedupe window suppresses the idle fire when a bell fired ≤6 s prior.
- **Silent long task (build/download):** idle timer false-fires after 4 s of silence. Accepted trade-off of the hybrid (operator chose it); `notifications.idleMs` is tunable and the bell remains the primary signal.
- **Already on the workspace when a pane finishes:** sidebar glow is moot; the pane border glow guides the eye; clears on pane focus.
- **Re-arming:** focus-clear removes the flag; a later turn-end re-sets it and re-flickers.
- **OSC string split across chunks:** scanner state persists per session, so a title-set BEL landing in the next chunk is still correctly ignored.
- **Detached window (v2.5.0):** `sendToSessionOwner` routes to the owning window; that window's sidebar/pane react. No cross-window broadcast needed.

## Out of scope
OS dock bounce / taskbar flash / badge; in-app toast for this event; distinguishing "question" vs "done" with different cues; persisting attention as bell-dropdown / DB notification rows; non-Claude/Codex CLIs are not a target (though the hybrid is generic and benefits them).

## Risks
- **Bell assumption unverified.** Claude/Codex emitting `BEL` on turn-end/permission-prompt is asserted from knowledge, not a live capture (operator's "no local app launch" rule). **First implementation task: a spike** capturing a real Claude and a real Codex pane's PTY stream to confirm BEL presence/timing. The idle timer is the guaranteed backstop if a CLI does not ring.

## Testing
- **Unit (vitest):** `BellScanner` (lone BEL vs OSC-terminator BEL vs `ESC]0;title BEL` vs split-across-chunks); `IdleDetector` arm/fire/reset + bell-dedupe with injected clock; sound throttle (≤1/2 s); reducer set + clear-on-focus + workspace-vs-session independence.
- **Component (jsdom):** row gains `.sl-attention` on event → `.sl-attention-settled` after 10 s → cleared on active-workspace switch; pane glow clears on pane focus.
- **DB caveat honored:** feature is transient IPC + renderer state; no `new Database()` in tests (better-sqlite3 Electron-ABI rule).
- **Gate:** `tsc -b` + full `vitest run` + lint + build in MAIN; e2e deferred to CI.
