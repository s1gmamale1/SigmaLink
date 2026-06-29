# Sigma Control Plane — Interactive Parity (Phase 2.5) — Design

**Date:** 2026-06-28
**Status:** Approved direction (brainstorming). Forks resolved with operator 2026-06-28.
**Owner:** Operator (Sigma / Leo)
**Builds on:** Phase 1 (Gateway) + Phase 2 (Human-parity perception + pane/swarm management) — both merged to
`main` and shipped in v2.8.1. This phase closes the gap Phase 2 did not scope.

## 1. Problem & Reframe

Phase 2's stated goal was *"use SigmaLink instead of me — do everything a human can do."* Its **actual
scope** was perception (`get_app_state`) + 10 pane/workspace/swarm **management** tools. It never specced the
**interactive-PTY reality layer**: the moment-to-moment friction a human absorbs without thinking —
submitting a typed prompt, clicking through a first-run trust dialog, noticing "you're at the agent cap,"
re-authing a provider whose token died.

A real autonomous driver session (Hermes, 2026-06-27, against installed **v2.8.1**) hit exactly that wall.
Root-cause investigation (5 read-only lanes off `origin/main` + target-verification of the running binary)
found **one architectural shape with six faces**: every control *tool* is a thin wrapper that drops a
launch/interaction parameter or guarantee the GUI faithfully threads.

This phase adds the missing layer: a few focused, independently-testable units that normalize what every
control launch/prompt inherits, plus perception additions so an unattended driver can **see** what blocks it.

## 2. Confirmed root causes (investigation receipts)

All anchored to `origin/main` (worktree off `90736ee`). Running build `/Applications/SigmaLink.app` = v2.8.1
(Jun 23), which **contains** the `\r` fix yet still failed — proving #3 is a real residual, not a stale build.

| # | Symptom | Root cause | Anchor |
|---|---------|-----------|--------|
| 3 | prompt pasted, not submitted | `prompt_agent` writes `prompt + '\r'` as **one bulk PTY write**; TUI paste-burst-detects a large/multi-line write, buffers `[Pasted text]`, swallows the trailing `\r` → needs a *separate, settled* Enter. Unit test only sends `'hi'`. | `tools.ts:506`; test `tools.test.ts:1099` |
| 4 | trust/update interstitials block launch | `launch_pane` builds the plan **without `autoApprove`** → bypass flag never appended; GUI reads Yolo from KV (`pane.autoApprove.default.<ws>`) and threads it, the tool reads nothing. | `tools.ts:421-431`, `launcher.ts:501`, `providers/launcher.ts:239`; GUI `Launcher.tsx:609` |
| 2 | RAM_BRAKE 12/12 blocks spawn | `countLive` counts human+control in **one 12-pool, no origin split**; `sLaunchPane` has **no `forceRamBrake`** field → external control cannot pass `force` while GUI can. | `admission.ts:82,147`; `tools.ts:209-214`; `factory-add-agent.ts:57` |
| 6 | shell-pane route "TimeoutError" | `prompt_agent`→shell = `classifyExternal:'escalate'` → **60s operator-approval block**; `ControlClient.rpc()` has no timeout, so the external CLI's deadline fires an opaque timeout first. | `authz-external.ts:43-52`; `rpc-router.ts:843`; `escalation.ts:64-70` |
| 1 | codex `token_expired` → `refresh token already used` | 3 spawn paths (boot-resume, launch_pane, human-open) with **no serialization**, all sharing `~/.codex/auth.json` (no `CODEX_HOME` anywhere) → **single-use OAuth refresh-token race**. Plus genuine expiry. **Zero error surfacing** — a codex pane printing 401 still shows `dbStatus:'running'`. | `local-pty.ts:543-548`; `registry.ts:326-371`; `app-state.ts:124` |
| drift | "Sigma-Control ↔ SigmaLink mismatch" | `SIGMA_CONTROL_PROTOCOL=1` is **sent but never checked** (host reads only token+label) → no version negotiation. Host serves the **full** `JORVIS_TOOL_CATALOGUE` externally, not the spec's intended subset. | `control-mcp-host.ts:135-148`; `rpc-router.ts:853` |

**Out of scope (not a control-plane bug):** the "Claude lane meandered, wrote nothing" symptom is
behavioral/prompt-quality (the lane received and started its prompt); likely downstream of #3 mangling the
prompt. No code fix here.

## 3. Approach

Targeted, well-bounded units — **not** scattered inline patches (drift-prone) and **not** a heavyweight
"adapter framework" (YAGNI). Each unit is one concern, vitest-testable with injected deps (MockDb / fake
registries / injected clocks), no live Electron. All units share one perception surface: additions to
`get_app_state`, which is what makes units 3/4/5 *observable* to the driver.

## 4. Units

### Unit 1 — Reliable submit (#3)

Replace the single bulk write with a **submit-settle** sequence:

1. `ctx.pty.write(sessionId, prompt)` — body only.
2. `await settle(delayMs)` — injected delay (default **80ms**) + injected clock.
3. `ctx.pty.write(sessionId, submitByte(providerId))` — provider-correct Enter (`\r` for
   claude/codex/opencode/gemini/kimi; the map lives next to `key-encode.ts`).

The settle guarantees the Enter lands in a **distinct PTY read**, outside the paste-burst the TUI coalesces.
Gate on pane-**ready** where a signal exists (prompt-sink / attention idle) — otherwise the settle + Unit 2
(no interstitial) covers readiness. `prompt_agent` still returns `{ok:true}` synchronously after scheduling;
the delayed submit is awaited internally so tests are deterministic.

- **Provider-awareness:** a `submitByte(providerId)` helper (pure, unit-tested) — today all known providers
  submit on `\r`, but the seam is provider-keyed so a future divergence is a one-line map change.
- **Test:** inject a fake clock + capture writes; assert exactly two ordered writes `[prompt]` then `['\r']`
  with the settle between them; assert `submitByte('claude') === '\r'`.

### Unit 2 — Launch auto-approve parity (#4)

`launch_pane` reads `pane.autoApprove.default.<workspaceId>` from KV (the same key the GUI reads) and sets
`autoApprove` on each pane in the `LaunchPlan`. **Plus** an optional `autoApprove?: boolean` arg on the tool;
when provided it overrides the KV default (operator decision 2026-06-28: *honor KV default + optional opt-in
arg*). Resolution order: `args.autoApprove ?? kvDefault(workspaceId) ?? false`.

- **Security framing:** auto-approve = launching the agent CLI with its `--dangerously-*` bypass flag (claude
  `--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`, gemini `--yolo`).
  This is the *same* capability Yolo already grants in the GUI; exposing it to the external driver is a
  conscious parity choice, gated by the existing kill-switch + the workspace's own default.
- **Residual (wishlisted):** codex's "Update available" interstitial may survive the bypass flag (unverified
  from source). Mitigation deferred: a deterministic codex update-check suppression (env/flag, TBD by live
  test); meanwhile the driver can dismiss via `send_keys`.
- **Test:** KV default true → plan panes carry `autoApprove:true`; arg `false` overrides KV true; arg absent +
  KV absent → false.

### Unit 3 — Capacity parity (#2)

Two halves — action + perception:

- **Action:** add `forceRamBrake?: boolean` to `sLaunchPane` → threads to `plan.forceRamBrake` → admission
  `force`. Classified **FREE** for external (resource pressure, not a destructive/irreversible act). The
  kill-switch still gates it first.
- **Perception:** `get_app_state` gains `capacity: { liveAgents, cap, workspaceLiveAgents, workspaceCap,
  headroom }` (read from `readRamBrakeCaps` + `countLive`). The driver sees the limit and can `stop_pane` /
  `kill_swarm` to make room *before* launching — perceive-then-act, the Unity/Blender-MCP pattern Phase 2
  already espouses.

No reserved control headroom (a separate pool adds bookkeeping for little gain now; the `force` arg +
visibility covers the case). Wishlisted as a future option.

- **Test:** `forceRamBrake:true` bypasses a violation; `capacity` block reflects a seeded `agent_sessions`
  count + KV-overridden cap.

### Unit 4 — Non-blocking escalation (#6)

For `origin:'external'`, an escalate-class tool returns **immediately** with
`{ ok:false, status:'needs_approval', escalationId }` instead of blocking 60s into an opaque external-CLI
timeout (operator decision 2026-06-28: *non-blocking + check tool*).

- The escalation is registered (id + tool + summary + ts) in a main-side pending map; the operator still
  approves/denies via the existing renderer/phone path.
- `get_app_state` gains `pendingEscalations: [{ id, tool, summary, requestedAt }]`.
- New tool **`check_escalation(id)`** → `{ status: 'pending'|'approved'|'denied'|'expired' }` (FREE). The
  driver polls it (or waits) and, on `approved`, **re-issues the original call**. To make the re-issue pass
  (instead of escalating again), an operator approval records a **one-shot grant** keyed by
  `(toolName + argsHash, clientLabel)` with a short TTL (e.g. 120s). `classifyExternal` consults the grant
  store: a matching unconsumed grant downgrades the verdict to FREE for that single call and is consumed on
  use. This keeps the escalation seam stateless about the *action itself* — it tracks only the *decision* +
  a consumable grant — and avoids holding a server-side continuation across the (possibly long) approval gap.
- **Scope:** external origin only. `origin:'local'` and `origin:'telegram'` keep today's blocking behavior —
  blast-radius control.
- **SDK escalation response contract:** an escalate-verdict tool call returns `{ ok:false, result:{ status:'needs_approval', escalationId } }` — drivers MUST check `ok===false && result.status==='needs_approval'` and poll `check_escalation(escalationId)` before re-issuing.
- **Test:** an external escalate call returns `needs_approval` synchronously (no 60s wait, fake clock);
  `check_escalation` reflects approve/deny/expire; local origin still blocks.

### Unit 5 — Codex spawn safety (#1)

Operator decision 2026-06-28: *serialize the shared spawn path (all codex)*.

- **(a) Spawn-serialization mutex keyed by `CODEX_HOME`** (default `~/.codex`). A promise-chain async lock
  held across each codex launch's **auth-settle window** (until the process emits a ready/first-output signal
  or a short cap, e.g. 4s), so two codex starts cannot overlap their single-use OAuth refresh. Applied at the
  one chokepoint all three spawn paths funnel through (`resolveAndSpawn` / `local-pty` codex branch), so
  human + control + boot-resume are all serialized. Non-codex spawns are unaffected (lock keyed only when
  `providerId === 'codex'`).
- **(b) PTY auth-error scanner** for codex panes: the registry `onData` path scans codex output for
  `token_expired` / `refresh token` / `401` auth signatures → sets `dbStatus:'error'` + emits `pty:error` +
  adds `authError: { kind, atMs }` to the session's `get_app_state` entry. The driver is no longer blind.
- **Not done (wishlisted):** per-workspace `CODEX_HOME` (breaks single-login; would force per-workspace
  `codex login`).
- **Test:** two concurrent codex spawn requests serialize (second starts only after the first releases —
  assert via a fake spawn that records start order under the lock); the scanner flips status + populates
  `authError` on a seeded `token_expired` line; a non-codex spawn is not serialized.

### Unit 6 — Protocol handshake hardening (drift)

- **Validate `protocol`:** the host reads `params.protocol` in `control.hello`, validates against a host
  `[MIN_PROTOCOL, MAX_PROTOCOL]` range. Out-of-range → reject the handshake with a clear error
  (`protocol vN unsupported; host accepts [MIN,MAX]`). A missing/old field is treated as the floor for
  forward-compat (warn, don't hard-fail, unless below MIN). Today it is ignored entirely.
- **Filtered external catalogue:** `tools.list` serves only tools that carry a **pinned external verdict**
  (derived from `authz-external`'s `EXPECTED_VERDICT` allowlist) rather than the full
  `JORVIS_TOOL_CATALOGUE`. This makes the external surface intentional and kills the "every new internal tool
  auto-exposes externally" drift. (The fail-open "every catalogue tool pinned" test already guarantees the
  verdict map is complete; this just uses it as the source of truth for the served list.)
- **Test:** a hello with `protocol` out of range is rejected; in-range/absent accepted; `tools.list` excludes
  a tool with no external verdict pin and includes the pinned ones.

## 5. Perception additions to `get_app_state` (shared surface)

`buildAppState` (`app-state.ts`) gains, defensively (a missing sub-source degrades that field, never throws):

- `capacity: { liveAgents, cap, workspaceLiveAgents, workspaceCap, headroom }` (Unit 3)
- per-session `authError: { kind, atMs } | null` (Unit 5)
- `pendingEscalations: [{ id, tool, summary, requestedAt }]` (Unit 4)

These are the keystone — perception is what turns "blocked" into "blocked, and here's why, and here's the
lever." Each is covered by `app-state.test.ts` with a MockDb + fakes.

## 6. Authorization

- `forceRamBrake` arg → **FREE** (resource, not destructive). `autoApprove` arg → **FREE** (parity with
  GUI Yolo; kill-switch + workspace default still gate). `check_escalation` → **FREE** (read).
- `EXPECTED_VERDICT` (`authz-external.test.ts`) gains pins for `check_escalation`; the "every catalogue tool
  pinned" + "no stale pin" tests cover the new tool automatically.
- No change to `EXTERNAL_ESCALATE_TOOLS` / `DANGEROUS_REMOTE` membership — Unit 4 changes *how* an escalate
  resolves (non-blocking), not *which* tools escalate.

## 7. Testing

- All units: vitest, MockDb + fake registries + injected clocks; **no real `better-sqlite3`** (Electron ABI),
  **no live Electron** (E2E deferred to `tests/e2e/` in CI).
- 3-mirror parity (`tool-catalogue.test.ts`) for the new `check_escalation` tool (handler + catalogue entry +
  `TOOL_BLURB`).
- Re-gate in the MAIN tree after merge (`tsc -b` checks test files; worktree tsc is laxer).
- Grep sibling call sites when adding the `submitByte` / spawn-lock seams — the gate misses mirrored sites.

## 8. File plan

**New:**
- `src/main/core/control/submit-encode.ts` (+ test) — `submitByte(providerId)` + settle helper (Unit 1).
- `src/main/core/control/codex-spawn-lock.ts` (+ test) — CODEX_HOME-keyed async mutex (Unit 5a).
- `src/main/core/pty/auth-error-scan.ts` (+ test) — codex auth-error signature scanner (Unit 5b).
- `src/main/core/control/pending-escalations.ts` (+ test) — pending map + `check_escalation` backing (Unit 4).

**Modified:**
- `src/main/core/assistant/tools.ts` — `prompt_agent` (Unit 1); `launch_pane` schema + handler
  (`autoApprove`, `forceRamBrake`) (Units 2,3); new `check_escalation` handler (Unit 4).
- `src/main/core/assistant/tool-catalogue.ts` + `system-prompt.ts` — `check_escalation` mirror; arg docs.
- `src/main/core/workspaces/launcher.ts` — thread `autoApprove` from KV + `forceRamBrake` (Units 2,3).
- `src/main/core/control/control-mcp-host.ts` — `protocol` validation; filtered `tools.list` (Unit 6).
- `src/main/core/control/app-state.ts` — `capacity`, `authError`, `pendingEscalations` (§5).
- `src/main/core/control/authz-external.ts` (+ test) — `check_escalation` pin; external-allowlist source.
- `src/main/core/pty/local-pty.ts` (or `providers/launcher.ts`) — codex spawn lock chokepoint (Unit 5a).
- `src/main/core/pty/registry.ts` — wire the codex auth-error scanner into `onData` (Unit 5b).
- escalation wiring (`escalation.ts` / `rpc-router.ts`) — non-blocking external path + pending registry (Unit 4).

## 9. Sequencing (plan tasks; mostly independent)

1. **Units 1 + 2** — unblock basic driving (type a task into a launched, trusted pane). Smallest, highest value.
2. **Units 3 + 4** — capacity force + visibility; non-blocking escalation. Share the `get_app_state` additions.
3. **Unit 5** — codex spawn lock + auth scan. Highest risk (hot shared path) → isolated task, full re-gate.
4. **Unit 6** — handshake validation + filtered catalogue.

Each task: failing test → implement → full vitest green → receipts.

## 10. Deferred (→ WISHLIST)

- Deterministic codex "Update available" interstitial suppression (needs live codex run to confirm
  mechanism).
- Per-workspace `CODEX_HOME` isolation (breaks single-login).
- Reserved control-plane RAM headroom (separate pool).
- A generic `dismiss_interstitial` / dialog-aware tool (vs. the current read_pane + send_keys inference).
- Standalone `github.com/s1gmamale1/Sigma-Control` bridge: bump its `protocol` + tool-name set in lockstep
  once Unit 6 lands (cross-repo follow-up).
