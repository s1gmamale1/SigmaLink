# Jorvis terminal access & interaction reliability — design

**Date:** 2026-06-11 · **Branch:** `fix/jorvis-terminal-access` · **Status:** approved (operator-directed fix)

## Symptom

Operator report: "Jorvis is tweaking, can't access terminals, can't interact." In-app
transcript shows Jorvis opening with "The host is reconnecting — let me grab the
live-state tools," successfully listing panes/swarms, then admitting "I can't see
their actual terminal output from the list alone" and offering to "read a specific
pane's screen" — a capability it does not have.

## Root causes (verified in code + live DB, prod v2.2.0)

### RC1 — Tool catalogue triple-drift (close_pane uncallable)

Three surfaces describe the Jorvis toolset and they have drifted:

| Surface | Count | Missing |
|---|---|---|
| `tools.ts` `TOOLS` (authoritative handlers) | 18 | — |
| `mcp-host-server.ts` `TOOLS` (MCP `tools/list`) | 15 | `close_pane`, `add_agent`, `monitor_pane` |
| `system-prompt.ts` `TOOL_BLURB` | 16 | `add_agent`, `monitor_pane` |

The Claude CLI is launched with `--mcp-config … --strict-mcp-config`
(`runClaudeCliTurn.args.ts:82`), so the model can ONLY call tools in the MCP
host catalogue. `close_pane` is advertised in the system prompt but absent from
the catalogue → the model's `close_pane` attempts fail **inside the CLI**, before
the bridge — which is why the live DB shows zero `ok:false` traces ever.
History: PR #137 (`b7fac3a`) added `close_pane` to `tools.ts` + `system-prompt.ts`
but missed the `mcp-host-server.ts` mirror (last touched Phase 10 `d75d52d`).
Known sibling-miss pattern; no cross-file parity test exists
(`mcp-host-server.test.ts:115` only checks the host against itself).

### RC2 — No terminal-read tool exists

`list_active_sessions` returns metadata only. The main process already keeps a
256 KiB scrollback ring buffer per session (`PtyRegistry.snapshot(id)`,
`registry.ts:593`; `ring-buffer.ts`), but no assistant tool exposes it. Jorvis
genuinely cannot read any pane's screen.

### RC3 — `prompt_agent` silently no-ops on dead sessions

`registry.write()` is `?.`-guarded (`registry.ts:447-449`) and the `prompt_agent`
handler returns `{ok:true}` unconditionally (`tools.ts:385-388`). The swarm
roster carries ghost entries (live DB: `builder-1` has no live session), so
Jorvis can "successfully" prompt a dead pane and nothing happens — no error is
ever surfaced to the model or the operator.

Cosmetic, non-bug: "the host is reconnecting" is the model's framing of the
CLI's deferred-MCP-tools flow (it must ToolSearch-load `mcp__jorvis-host__*`
schemas — visible in traces at 19:21:59 and 02:31:32).

## Fix design

### A. Shared tool catalogue (kills the drift class)

New `src/main/core/assistant/tool-catalogue.ts` — **pure data**:
`JORVIS_TOOL_CATALOGUE: Array<{name, description, inputSchema}>` for all 19
tools (18 existing + `read_pane`). No heavy imports, so the standalone esbuild
bundle of `mcp-host-server.ts` (`scripts/build-electron.cjs:74-80`) inlines it
safely. `mcp-host-server.ts` replaces its local `TOOLS` with the catalogue.

Contract tests (new `tool-catalogue.test.ts`):
1. catalogue names === `tools.ts` `TOOLS` ids (set equality, both directions);
2. every catalogue name appears in `buildJorvisSystemPrompt()` output;
3. every catalogue entry's `required` args match the `tools.ts` schema's required list.

### B. New `read_pane` tool

`{ sessionId, maxBytes? }` → tail of `ctx.pty.snapshot(sessionId)`
(default 16 KiB, cap 64 KiB), ANSI/OSC-escape-stripped, passed through
`ctx.scanIngested` (H-19 — pane output is untrusted agent text, same precedent
as `read_files`/`browser_snapshot`). Returns `{ok, alive, text, truncated}`.
Unknown session → `ok:false, error:'session not found'`. Read-only ⇒ NOT in
`DANGEROUS_REMOTE` (the strict `authorization.test` membership
`['close_pane','prompt_agent']` is intentionally unchanged).

### C. `prompt_agent` liveness guard (+ truthful fan-out counts)

- `PtyRegistry.isLive(id): boolean` (record exists AND `alive`).
- `prompt_agent`: dead/unknown session → `ok:false, error:'session not found or exited'`.
- Mirror sweep (grep-sibling rule): `broadcast_to_swarm` and `roll_call` loop the
  roster — they now report `{delivered, skipped}` counts instead of writing
  blindly. `close_pane` stays idempotent-ok on ghosts (explicit close semantics).
  The renderer keyboard path (`rpc-router` `pty.write`) is untouched.

### D. System prompt blurb update

Add `read_pane`, `add_agent`, `monitor_pane` entries; one line noting
`prompt_agent`/`read_pane` fail on dead sessions (so the model self-corrects via
`list_active_sessions`). Stays within the ~1500-token budget.

## Alternatives considered

- **Runtime catalogue forwarding** (host asks the bridge at `tools/list` time):
  adds a socket round-trip + failure mode during CLI boot; rejected.
- **Hand-sync + parity test only** (no shared module): smaller diff but leaves
  three hand-maintained copies; the drift already recurred once; rejected.
- **read_pane via renderer xterm serialize**: requires renderer round-trip and
  breaks for background workspaces; main-process ring buffer is authoritative;
  rejected.

## Out of scope (→ wishlist)

- Swarm-roster ghost healing (stale `builder-1` row in `swarm_agents`).
- Deferred-MCP-tools UX (CLI ToolSearch flow reads as "host reconnecting").
- Scrollback persistence default-ON (v1.9 flag).

## Testing & gate

TDD per task (failing test first). Local gate: `tsc -b`, `eslint`, `vitest`,
`vite build` — no local e2e (CI e2e-matrix covers it, per project policy).
