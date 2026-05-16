# 05 — "+ Pane" button UX

**Severity**: P2
**Effort**: S (~2-3hr after user recording)
**Cluster**: Pane-grid Cluster B (pairs with #13)
**Suggested delegate**: Codex via OpenCode
**Depends on**: user screen recording (PREREQUISITE — see Gating)

## Context

v1.4.1 dogfood: user complained "make the + Pane button actually work alr."

Investigation finding: the button is **fully wired**, not a stub. It works. The user's frustration is UX/discoverability, not missing logic.

Wiring trace:
- Button: `app/src/renderer/features/command-room/CommandRoom.tsx:223-282` (top-bar + DropdownMenu)
- Click handler: line 262 → `addPane()` at line 201
- RPC: `addPane()` → `rpc.swarms.addAgent` (line 204)
- Main process: `addAgentToSwarm()` at `app/src/main/core/swarms/factory.ts:198` — transaction insert (line 246) + PTY spawn at `spawnAgentSession()` line 284
- Success dispatch: lines 206-208
- Error toast: line 213 (`toast.error(...)`)
- Disabled-state tooltip: line 51 (`disabledReason`)

The button does the right things. So why does the user think it's broken?

## Three conditional fix shapes

### H1 — Disabled-state tooltip is invisible

`disabledReason` (line 51) renders as a hover tooltip. Tooltips require mouse-hover; the user clicks and nothing happens (button is disabled) without ever seeing the explanation.

**Fix**: Replace the hover-only tooltip with a **visible inline pill** next to the button when disabled. e.g. `[+ Pane] [swarm paused — resume to add panes]`.

### H2 — Dropdown-first surprises one-click expectation

Current click opens a DropdownMenu listing providers (Claude / Codex / Gemini / Kimi / OpenCode). User expects a single click to add a pane immediately.

**Fix**: **Split-button** pattern. Single-click on the button itself adds a pane with the last-used provider (or workspace's default). The dropdown arrow `▾` is a separate target for changing provider.

### H3 — Silent toast failures

`toast.error` fires when `rpc.swarms.addAgent` rejects, but the toast disappears after ~3s. If the user clicked and looked away, they miss it. Returning, they think "I clicked and nothing happened."

**Fix**: Surface failed-add errors as a **persistent error chip** in the pane header until dismissed.

## Gating

**DO NOT IMPLEMENT WITHOUT USER RECORDING.** All three hypotheses are plausible; the fix shape depends on what the user actually sees. Request:

> 30-second screen recording of: open SigmaLink → click + Pane → narrate what you expect to happen and what actually happens.

Once you have the recording, the right hypothesis is usually obvious. Then implement the matching fix.

## File:line targets

| File | Line | Edit (conditional) |
|---|---|---|
| `app/src/renderer/features/command-room/CommandRoom.tsx` | 223-282 | H1: replace hover tooltip with inline pill; H2: split-button refactor; H3: persistent error chip |
| `app/src/renderer/features/command-room/CommandRoom.tsx` | 51 | H1: lift `disabledReason` to visible pill component |
| `app/src/renderer/features/command-room/CommandRoom.tsx` | 213 | H3: persist toast error to local state, dismiss-on-click |
| `app/src/renderer/features/command-room/CommandRoom.test.tsx` | (new) | Cover the chosen fix; assert e.g. "disabled state pill visible when swarm paused" |

## Reusable utilities

- Existing `rpc.providers.list()` for provider enum
- `rpc.swarms.addAgent()` — already wired
- `addPane()` at line 201 — already correct
- `disabledReason` at line 51 — already computed
- `toast.error` from sonner — already imported

**Pure UI work. No new helpers needed.**

## Cross-file dependencies

Same files as #13-pane-split-minimise. **Bundle 05 + 13 into one PR** (Cluster B) to avoid merge collisions.

## Verification

- Vitest: new `CommandRoom.test.tsx` case for chosen fix
- Manual: user reproduces v1.4.1 frustration → confirm fixed flow matches their mental model
- E2E: extend `tests/e2e/swarm-launch.spec.ts` with "add pane via top-bar button" path

## Risks

- R-05-1: All three hypotheses are speculation without the recording. Picking wrong wastes 2-3hr.

## Pairs with

- #13 (Split / Minimise — same files, ship as one PR)
