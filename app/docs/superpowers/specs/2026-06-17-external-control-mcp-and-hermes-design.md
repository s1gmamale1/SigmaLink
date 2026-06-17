# Sigma Control Plane (External MCP) + Hermes Autonomous Runtime — Design

**Date:** 2026-06-17
**Status:** Approved direction (brainstorming). Awaiting spec review → implementation plan.
**Owner:** Operator (arifkhodjaev98)

## 1. Problem & Goal

Expose SigmaLink's control plane — terminals, panes, and workspaces — to **external AI agents**
(external Claude Code instances, a purpose-built **Hermes** agent, OpenClaw, etc.) over a standard
**MCP server**, so an agent can *observe, interact with, and control* SigmaLink the way a human
operator does: read what's happening in each terminal, type into agents, open/close panes, open/close
and switch workspaces.

The headline use case: an autonomous **Hermes** agent that performs development across workspaces —
spawning coder panes, supervising them, responding when they need input, opening new workspaces —
**unattended while the operator is away**, with the operator retaining a veto over irreversible actions.

### Locked decisions (from brainstorming)

- **Surface:** an MCP server exposing the control plane to external MCP clients.
- **Transport:** **local-first** (loopback HTTP), architected so an **authenticated remote** layer drops in
  later with no rearchitecture ("local now, remote later").
- **Driver:** primarily **external MCP clients** — you bring the brain; SigmaLink exposes the surface.
- **Scope of this spec:** **Gateway + Hermes runtime**, written as **one spec / two phases**
  (Phase 1 = the surface, Phase 2 = the Hermes brain that drives it). Hermes is *just another MCP
  client*, so the surface is fully usable and testable without any Hermes code.
- **Autonomy posture:** **supervised autonomy** — the agent freely does safe + agent-directed work;
  irreversible actions escalate to the operator's phone (reusing the existing Telegram confirm gate)
  with a timeout and fail-closed default-deny.
- **Hard constraint:** **process-singleton discipline.** No per-client / per-pane child-process fan-out
  (this is exactly the pre-v2 memory leak — PR #154). One shared in-process server, connections
  multiplexed; the only new child process is the single managed Hermes agent.

## 2. Ground Truth (what already exists — ~80% reuse)

Confirmed by codebase research (2026-06-17). All file:line references are entry points the design reuses.

- **In-process tool host:** `src/main/core/assistant/mcp-host-sigma.ts` already runs a JSON-RPC server in
  `main` (Unix socket / Windows named pipe) that forwards tool calls; tool *implementations* live in `main`.
- **Tool registry + strict catalogue:** `assistant/tools.ts` (`TOOLS`, handlers), `assistant/tool-catalogue.ts`
  (pure-data MCP `tools/list`), `assistant/system-prompt.ts` (`TOOL_BLURB`). Three mirrored surfaces kept in
  sync by parity tests (`tool-catalogue.test.ts`). **19 tools already exist** (launch_pane, close_pane,
  prompt_agent, read_pane, read_files, list_active_sessions, list_workspaces, create_swarm, add_agent,
  browser_navigate, browser_snapshot, …).
- **Central auth gate:** `assistant/controller.ts:~191` `invokeAssistantTool()` — `origin: 'local' | 'telegram'`
  + `DANGEROUS_REMOTE = {prompt_agent, close_pane}` (`tools.ts:~1119`) + `confirmDangerous` callback,
  fail-closed. Enforced by `authorization.test.ts` (strict `toEqual` membership).
- **A production external transport to model on:** the Telegram bridge `src/main/core/remote/bridge.ts` +
  `remote/safety.ts` — enable flag, allowlist, idle-lock, audit JSONL, outbound scrubbing (aidefence),
  `confirmDangerous` chain with 60s timeout.
- **PTY control is fully programmatic:** `pty.create / write / resize / kill / snapshot / list / processStats`
  RPC (`rpc-router.ts:~1014–1083`); `pty:data / pty:exit / pty:error / pty:link-detected` IPC events;
  256 KiB ring buffer; PTY data coalescer (~12 ms batches).
- **Waiting-detection exists:** `src/renderer/lib/prompt-watcher.ts` parses `SIGMA::PROMPT` protocol lines
  (agent-waiting), survives React unmounts; agent-attention idle detection (bell + idle) ships in v2.6.0.
- **Control-plane choke points:** workspace `rpc.workspaces.open/remove/rename/list/launch`
  (`rpc-router.ts:~1541–1602`), pane `rpc.panes.close/rename` (`~1170/1384`), windows
  `rpc.windows.detachWorkspace/redockWorkspace` (`~1625`); renderer mutations via reducer + `use-live-events`.
- **Multi-window routing:** `SESSION_ROUTED_EVENTS` (`rpc-router.ts:237`) + window registry
  `sendToSessionOwner`.
- **Process-singleton discipline (the leak fix, PR #154):** `MemoryMcpSupervisor`, `RufloMcpSupervisor`
  (one child per app, refcounted), ordered awaited quit teardown (`rpc-router.ts:~2611–2764`), win32 boot
  orphan-sweep by CIM CommandLine marker (`core/process/orphan-sweep.ts`), `busy_timeout` before WAL,
  bounded `waitForPidsExit` before DB close.

## 3. Gaps to close (net-new work)

1. **No external-facing MCP endpoint** — the existing host serves SigmaLink's *own* CLI, not arbitrary clients.
2. **Missing control tools** — there is `list_workspaces` but **no `open/close/switch_workspace` tool**, no
   `focus_pane`/fullscreen, no `set_pane_label`, no explicit `send_keys`/Ctrl-C, no `wait_for_pane`. Today
   only the local UI performs these (pane-map flagged ~10 such gaps).
3. **`read_pane` is a static snapshot** — no incremental read and no "block until this agent needs input"
   primitive, which an unattended supervisor needs to avoid blind polling.
4. **`origin` union has no `external` member**, and danger classification is **name-only** (it must become
   **provider-aware**: typing into a `claude` pane ≠ typing into a `shell` pane).
5. **No Hermes runtime** — mission model, supervisor process, supervision loop, escalation, kill-switch UI.

## 4. Architecture — Components & Boundaries

```
External AI (external Claude Code / Hermes / OpenClaw)
   │  claude mcp add sigmalink -- node <appResources>/mcp-sigma-control-server.cjs   (token via env)
   ▼  (client spawns+owns the stdio bridge; it connects to main's control socket)
┌────────────────────────── SigmaLink main process ──────────────────────────┐
│ (1) Control MCP Host  ── ONE net socket (Unix socket / Win named pipe),     │
│      stateless per-connection, forces origin:'external', token handshake,   │
│      kill-switch-aware; ZERO child processes spawned by main per client     │
│        │  origin:'external' (+ client label, token scope)                   │
│        ▼                                                                    │
│ (3) External Authorization Policy  ── provider-aware FREE / ESCALATE        │
│        │                                                                    │
│        ▼                                                                    │
│ (2) Control tool layer  ── invokeAssistantTool(): 19 existing + ~8 new      │
│        │            (3-mirror catalogue + parity tests)                     │
│        ▼                                                                    │
│     RPC choke points: pty.* · workspaces.* · panes.* · windows.*            │
│        │                                                                    │
│ (4) Escalation bridge ──► operator phone (reuse Telegram confirmDangerous)  │
│ (5) Hermes runtime (singleton managed Claude process) ── an MCP *client*    │
│ (6) Mission store + Hermes control UI (kill-switch)                         │
│ (7) Observation primitives (wait_for_pane / incremental read)              │
└─────────────────────────────────────────────────────────────────────────────┘
   ▼
Redux reducer + IPC events (pty:data, assistant:dispatch-echo, …) → live UI mutation
```

| # | Unit | Responsibility | Boundary |
|---|------|----------------|----------|
| 1 | **Control MCP Host** (`core/control/control-mcp-host.ts`) + external stdio bridge (`build/mcp-sigma-control-server.cjs`) | A `net` socket server in main (mirrors `mcp-host-sigma.ts`), stateless per-connection, **forces `origin:'external'`**, token handshake, kill-switch-aware. The stdio bridge is a tiny MCP server the *external client* spawns and owns; it relays to the socket. | Swap transport (HTTP shim / remote tunnel) without touching tools. **Leak-safe: main spawns no per-client process** — the bridge is the client's child (see §8). |
| 2 | **Control tool layer** (`assistant/tools.ts` + `control/tools-control.ts`) | Existing 19 + ~8 new tools via `invokeAssistantTool`; 3-mirror catalogue + parity tests. | Pure effect layer; same code serves Jorvis, Telegram, external. |
| 3 | **External authorization policy** (`control/authz-external.ts`) | `origin:'external'`; provider-aware FREE/ESCALATE decision; kill-switch check first. Pure function. | One place encodes supervised-autonomy; unit-testable. |
| 4 | **Escalation bridge** (`remote/escalation.ts`, generalizes the Telegram seam) | Route `confirmDangerous` → operator; timeout → default-deny + audit; channel-down → fail-closed. | Non-Telegram escalation drops in later. |
| 5 | **Hermes runtime** (`core/hermes/supervisor.ts`) | ONE singleton managed Claude agent process pointed at the loopback server, driven by a Mission, supervising via `wait_for_pane`. | Just an MCP client → surface works without it; replaceable. |
| 6 | **Mission store + Hermes control UI** (`core/hermes/missions.ts`, renderer Hermes room) | Create/start/pause/stop missions, workspace scope, live activity, **kill-switch**, escalation queue, audit view. | UI/state only; no agent logic. |
| 7 | **Observation primitives** (`control/observe.ts`) | `wait_for_pane` (block until `SIGMA::PROMPT` / output-settle / exit / timeout, supports a list → wait-for-any) + incremental `read_pane_since(cursor)`. | Built on existing watcher + ring buffer; reusable by any client. |

## 5. Tool Surface

### 5.1 Existing tools (re-exposed via the external origin)
All 19 current tools, unchanged, subject to the external authorization policy (§6).

### 5.2 New control tools (~8)

| Tool | Args | Effect | Default class (external) |
|------|------|--------|--------------------------|
| `open_workspace` | `root` \| `workspaceId`, `targetRoom?` | `rpc.workspaces.open` + atomic land-on-room (closes pane-map gap #3) | FREE |
| `close_workspace` | `workspaceId` | `rpc.workspaces.remove` (stops panes, deletes rows) | **ESCALATE** |
| `switch_workspace` | `workspaceId` | emit → `SET_ACTIVE_WORKSPACE_ID` (focus, multi-window aware) | FREE |
| `focus_pane` | `sessionId`, `fullscreen?` | emit → `SET_ACTIVE_SESSION` / `SET_FOCUSED_PANE` (closes gap #1) | FREE |
| `set_pane_label` | `sessionId`, `label` | persist display name + `panes:session-renamed` (closes gap #7) | FREE |
| `send_keys` | `sessionId`, `keys[]` (named keys / control chars, e.g. `C-c`, `Enter`) | encode → `pty.write` (distinct from `prompt_agent`) | provider-aware (see §6) |
| `wait_for_pane` | `sessionId` \| `sessionIds[]`, `until: 'prompt'\|'idle'\|'exit'`, `timeoutMs` | block server-side until condition or timeout; return reason + output tail | FREE |
| `read_pane_since` | `sessionId`, `cursor?` | incremental scrollback since cursor + new cursor | FREE |

Optional (Phase 1.5, low priority): `detach_workspace`, `redock_workspace` (wrap `rpc.windows.*`).

Every new tool is added to **all three mirrors** (`tools.ts`, `tool-catalogue.ts`, `system-prompt.ts`) and
covered by the parity test. The strict-MCP catalogue is the only callable surface; drift = silent failure.

## 6. Supervised-Autonomy Authorization Policy

`ToolOrigin` gains `'external'`. The policy is a **pure function** `classifyExternal(toolId, resolvedTargetProvider, killSwitch) → 'free' | 'escalate' | 'deny'`.

**Kill-switch wins first:** if engaged → `deny` for *every* external call (even reads).

**ESCALATE (route `confirmDangerous` → operator phone; timeout/channel-down → deny + audit):**
- `close_pane`, `close_workspace` (irreversible teardown).
- `prompt_agent` / `send_keys` **when the target session's provider is a shell** (`shell`/`bash`/`zsh`/`pwsh`)
  — raw input to a shell = arbitrary command execution.
- `browser_navigate` (agent driving a logged-in browser; already feature-gated + SSRF-checked).

**FREE (runs immediately, always audited):**
- All read/list/observe tools: `read_pane`, `read_pane_since`, `read_files`, `list_*`, `wait_for_pane`,
  `browser_snapshot`, `search_memories`, `monitor_pane`, `open_url` (https-only navigation).
- `launch_pane`, `create_swarm`, `add_agent` (spawning agents — creative, recoverable).
- `prompt_agent` / `send_keys` **when the target provider is an agent CLI**
  (`claude`/`codex`/`gemini`/`kimi`/`opencode`) — talking to an agent, not a shell.
- `open_workspace`, `switch_workspace`, `focus_pane`, `set_pane_label`, `create_task`, `create_memory`.

**Provider resolution:** the policy looks up the target session's `provider_id` from the registry/DB to
classify `prompt_agent`/`send_keys`. Unknown/missing provider → treat as shell → ESCALATE (fail-safe).

**Per-mission override (Phase 2):** a Mission may *narrow* (never widen beyond) — e.g. "observe-only".
A Mission cannot self-grant escalated actions without the operator pre-approving that mission's policy.

**Backwards-compatible:** `origin:'local'` (in-app) and `origin:'telegram'` behavior is unchanged; the new
classification applies only to `origin:'external'`.

## 7. Hermes Runtime (Phase 2)

### 7.1 Mission model
`hermes_missions` table (or KV): `{ id, title, instruction, workspaceScope: ws_id[] | 'all', policy:
'supervised' | 'observe-only', status: draft|running|paused|completed|failed, createdAt, lastActivityAt, log }`.

### 7.2 Hermes process — `HermesSupervisor` (singleton, mirrors the existing supervisors)
- Launches **one** managed agent process: a Claude Code / Agent-SDK instance (**Claude — Opus for planning,
  configurable**), with: a **supervisor system prompt**, an MCP config pointing at the loopback Sigma Control
  server using a **Hermes-scoped control token**, and the Mission instruction as its task.
- Hermes drives itself with the tools — we do **not** hand-code its loop. The pattern it follows:
  read mission → for each in-scope workspace: `open_workspace` → `launch_pane` coder(s) with a sub-task →
  `wait_for_pane(until:'prompt'|'exit')` → `read_pane_since` → `prompt_agent` to unblock / proceed →
  escalate irreversible ops → update mission log → report.
- `wait_for_pane(sessionIds[])` (wait-for-any) is the multiplexed supervision primitive that lets one Hermes
  efficiently watch N sub-agents.

### 7.3 Controls & UI (Hermes room)
- **Kill-switch:** "Hermes: Active / Frozen". Frozen = `HermesSupervisor.stop()` **and** policy denies all
  `origin:'external'`/Hermes calls. The switch is the always-available emergency stop.
- Mission list (create/start/pause/stop, scope picker), live activity feed, pending-escalations panel
  (mirrors phone), audit-trail view.

### 7.4 Lifecycle / leak discipline (CRITICAL — from PR #154)
- `HermesSupervisor` is a **singleton**, refcounted; a second `start()` no-ops.
- The Sigma Control MCP server is **in-process** → no new child to reap.
- Hermes **is** a child process → it joins the **quit-order teardown**:
  external clients → Hermes process → MCP server connections → existing supervisors → DB, all awaited+bounded.
- Hermes process gets a unique **CommandLine marker** so the win32 boot orphan-sweep can reap a survivor; its
  pid joins `waitForPidsExit` before DB close.
- Hermes's sub-agent panes are ordinary PTY sessions (already governed by the registry + reaper) — no new
  leak surface.

## 8. Transport, Auth, Remote-Later, Cross-Platform

> **Transport revision (2026-06-17, post-extraction).** The earlier draft assumed a loopback **HTTP**
> Streamable-MCP server. Codebase extraction showed (a) **no HTTP server is hosted in `main`** today and
> (b) **no MCP SDK / JSON-RPC / express / ws dependency** exists — all MCP framing is hand-rolled. Meanwhile
> the app already ships the proven pattern: `mcp-host-sigma.ts` (a `net` Unix-socket / Windows-named-pipe
> JSON-RPC server) + a bundled stdio MCP server the Claude CLI connects to. Phase 1 therefore **reuses the
> socket + stdio-bridge pattern** rather than building an HTTP MCP server. (Operator-approved 2026-06-17.)

- **Phase 1 transport:** a dedicated **Control MCP Host** — a `net` socket server in `main` (separate socket
  path from the in-app Jorvis host; mirrors `mcp-host-sigma.ts`), **stateless per-connection**. External
  clients add a tiny stdio MCP bridge: `claude mcp add sigmalink -- node <appResources>/mcp-sigma-control-server.cjs`
  (token + socket path via env). **The bridge process is spawned and reaped by the external client, not by
  `main`** → zero per-client fan-out on our side (the v2-leak rule). Optional Phase 1.5 / Phase 3: a loopback
  **HTTP shim** proxying to the same control socket for HTTP-only clients.
- **Auth:** a **bearer token** in `CredentialStore` (encrypted) that the bridge presents in a one-line
  handshake before any `tools.invoke`; the socket also relies on filesystem permissions (Unix socket / named
  pipe is local-only). The control socket **hard-codes `origin:'external'`** for every call (a client cannot
  claim `local`). Enable flag `control.mcp.enabled`, **default OFF**. Token scope (`observe` | `control`) and
  client **label** (audit attribution).
- **Remote later (Phase 3, not now):** put a tunnel/relay in front of the control socket, **or** add the
  loopback-HTTP shim + TLS + stronger auth (mTLS / rotating tokens) + rate limits. The tool + authz layers are
  transport-agnostic, so this is additive — no rearchitecture. The token/scope/label model is the remote auth seam.
- **Cross-platform:** the `net` socket server uses a Unix domain socket on macOS/Linux and a **named pipe** on
  Windows (the existing host already handles both). No `.cmd`/PATHEXT issues for the server. The only child
  process spawned **by main** is Hermes (Phase 2) — apply the documented win32 discipline; the external stdio
  bridge is the client's child. Sub-agent PTY spawn is already cross-platform-hardened.

## 9. Error Handling

- **MCP server:** per-call timeout; max in-flight per client (backpressure, reuse `MAX_INFLIGHT` pattern);
  client disconnect cancels its in-flight calls; a bad client never crashes `main`.
- **Tools:** strict-MCP catalogue + parity tests; tool errors return `ok:false` — never silent (the
  strict-mcp lesson). New tools fail loudly if `ctx.emit` is missing (pane-map gap #9).
- **Escalation:** timeout → default-deny + audit; escalation channel unavailable → dangerous action
  auto-denied (fail-closed) and surfaced in the Hermes UI.
- **Kill-switch:** checked before any classification; always wins.

## 10. Testing

- **Catalogue parity** (extend `tool-catalogue.test.ts`): all new tools present in all 3 mirrors.
- **Authorization** (`authz-external.test.ts`): provider-aware classification
  (`prompt_agent`→shell = escalate, →claude = free; `close_pane`/`close_workspace` = escalate); kill-switch
  denies all; escalation timeout = deny; **membership regression test** for every set we touch
  (per the plan-base-drift lesson — diff allowlists vs `origin/main`).
- **MCP server lifecycle:** connect/disconnect refcount → no orphan; teardown order; **process count is
  constant across N client connections** (directly asserts the leak fix).
- **`wait_for_pane`:** fires on `SIGMA::PROMPT`, on idle-settle, on exit, on timeout; wait-for-any returns
  the first-ready session.
- **Hermes supervisor:** singleton (second start no-ops); quit teardown awaited; win32 orphan marker present.
- **DB tests:** MockDb / fakes only — `better-sqlite3` can't load under vitest (Electron ABI). Assert emitted
  DDL / in-memory arrays.
- **E2E:** deferred to CI (`tests/e2e/`) — never run a live Electron app locally (it steals operator focus).

## 11. Phasing

- **Phase 1 — Gateway (surface):** Units 1, 2, 3, 7 + escalation seam (4). Singleton loopback HTTP MCP server,
  `origin:'external'` + provider-aware policy, the ~8 new control tools, observation primitives, token auth,
  kill-switch flag (server-level). Exit criteria: an external Claude Code can `claude mcp add` and drive
  panes/workspaces under supervised autonomy; escalation reaches the phone; no per-client process; parity +
  authz + lifecycle tests green.
- **Phase 2 — Hermes runtime (brain):** Units 5, 6 + per-mission policy. Mission model, `HermesSupervisor`
  singleton managed Claude process, supervision via `wait_for_pane`, Hermes control room + kill-switch UI,
  quit-order + win32 orphan integration. Exit criteria: a mission runs a real cross-workspace dev task
  unattended, escalates irreversible ops to the phone, and freezes instantly on kill-switch.
- **Phase 3 — Remote (later, separate spec):** authenticated remote transport (tunnel/TLS/mTLS, rate limits).

## 12. Open Questions (defaults chosen; flag if you disagree)

1. **Hermes brain model:** default **Claude Opus** for the supervisor (planning/judgment); sub-agent coder
   panes can be cheaper (Sonnet/external CLI). Configurable per mission.
2. **Control socket path:** a stable per-user path (Unix socket under the user data dir on macOS/Linux; a
   named pipe `\\.\pipe\sigmalink-control-<hash>` on Windows), surfaced in the Settings UI as a copyable
   `claude mcp add sigmalink -- node …` command with the token wired via env.
3. **`prompt_agent` into a shell pane:** classified ESCALATE by default. If you want a per-mission
   "trusted shell" opt-in (operator pre-authorizes shell writes for a mission), that's a small policy
   extension — not in Phase 1.
4. **OpenClaw/other clients:** reached via the same stdio bridge (`claude mcp add … -- node <cjs>`). If a
   target client speaks HTTP-only, the optional Phase 1.5/Phase 3 HTTP shim covers it.

## 13. Non-Goals

- Remote/network exposure in Phase 1 (local Unix socket / named pipe only — no network bind).
- A bespoke non-MCP REST API (MCP is the surface; a REST adapter can wrap the same tools later if needed).
- Replacing xterm/the in-app Jorvis — this is an *additional* surface, not a rewrite.
- Hand-coding Hermes's reasoning loop — Hermes is a Claude agent driven by tools + prompt, not a state machine.
