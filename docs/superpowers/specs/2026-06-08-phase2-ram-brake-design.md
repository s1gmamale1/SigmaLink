# Phase 2 RAM Brake Design

Date: 2026-06-08

## Summary

Phase 1 reduced one avoidable memory source by preferring shared Ruflo HTTP MCP and by making process cleanup tree-aware. Live testing showed that is necessary but not sufficient. The next RAM problem is launch-time risk: old Claude resumes and inherited MCP/tool config can make a pane expensive before the user does any new work.

Phase 2 adds a provider-aware launch guard. It estimates resume-session risk before spawning, lets the operator choose summary/full/fresh/no-MCP launch modes, and makes the pane show which process family is consuming memory. Existing pane behavior remains available through explicit choices.

## Evidence

Manual measurements outside SigmaLink:

- Fresh `claude` in a trusted temp folder: about 327 MB RSS, no MCP children.
- Fresh `codex` in a trusted temp folder: about 54 MB RSS before MCP startup.
- `claude --resume 37846eca-4143-4f3b-a1b5-5fe919ddf2b3` with strict empty MCP config: about 503 MB RSS at Claude's 431.5k-token resume gate.
- The same Claude resume with inherited MCP config: about 1.58 GB total RSS.
- In that 1.58 GB tree, Claude itself was about 524 MB and MCP/npm/node children were about 1.08 GB.
- The relevant Claude JSONL files were only about 4.9-7.1 MB, so raw file size alone is not a precise risk signal. Token count, file shape, age, and MCP profile all matter.

## Goals

- Prevent surprise 700 MB-1.5 GB panes by warning before high-risk resumes and heavy MCP startup.
- Preserve current functionality: users can still resume full sessions and enable full tool profiles when they choose to.
- Prefer cheap defaults for risky sessions: summary resume, fresh pane, or strict core/no-MCP launch.
- Make the reason for high RAM visible in the UI: root CLI RSS versus MCP child RSS.
- Keep the first implementation narrow enough to validate with focused tests and manual process evidence.

## Non-Goals

- Do not migrate Electron/Tauri in this phase.
- Do not rewrite Claude or Codex session storage.
- Do not delete or mutate provider session JSONL files.
- Do not disable user/project MCP globally. SigmaLink should constrain launches it owns, not change the user's external CLI setup.
- Do not invent exact token counts from JSONL alone. Use calibrated risk estimates and provider output when available.

## Approaches Considered

### Option A: Warn Only

Show a warning when a session file is large or old, but otherwise launch exactly as today.

Pros: small implementation, low behavior risk.

Cons: does not stop heavyweight MCP startup, does not offer a practical lower-RAM path, and still lets one click create a 1 GB pane.

### Option B: Force Fresh Panes Above A Threshold

Automatically start fresh when a session looks too large.

Pros: strong RAM reduction.

Cons: breaks the core value of resume panes and will feel destructive or surprising. Users sometimes need the full old context.

### Option C: Launch Guard With Explicit Modes

Recommended. Detect risk, show a launch decision, and pass provider-specific flags/config for the selected mode.

Pros: preserves full functionality, makes expensive actions intentional, supports exact diagnostics, and directly addresses both root causes: large context and MCP fan-out.

Cons: more UI and provider-specific logic; requires careful defaults and tests.

## Recommended Design

### 1. Session Risk Analyzer

Add a main-process analyzer that takes a workspace, provider, cwd, and optional external session id. It returns a `SessionRiskReport`.

Fields:

- `providerId`
- `externalSessionId`
- `sessionFilePath`
- `sessionBytes`
- `lineCount`
- `ageMs`
- `estimatedTextBytes`
- `estimatedTokens`
- `riskLevel`: `low | medium | high | critical`
- `reasons`: short machine-readable strings such as `old-session`, `large-jsonl`, `many-lines`, `claude-resume-risk`

The first implementation should use cheap filesystem analysis:

- Find the provider-native session JSONL path using existing session-disk scanner logic.
- Count bytes and lines.
- Estimate text bytes by parsing JSONL lines and summing string payload fields where feasible. If a line is malformed, skip it and add `partial-jsonl-parse` to `reasons`.
- Estimate tokens as a heuristic, not an exact claim. The UI should label it "estimated".

Initial Claude thresholds, calibrated from the live evidence:

- `low`: under 1 MB and under 500 lines
- `medium`: 1-4 MB or 500-1200 lines
- `high`: 4-8 MB or 1200-1800 lines
- `critical`: over 8 MB, over 1800 lines, or any prior observed pane RSS over 750 MB

These thresholds deliberately classify the 4.9-7.1 MB Homeworks sessions as high. Provider output can later refine this with actual token warnings.

### 2. MCP Risk Analyzer

Add a main-process analyzer for the effective MCP launch surface.

Fields:

- `mcpProfileId`: `none | core | browser-tools | security-tools | full-tools`
- `strictMcp`: boolean
- `declaredServers`: server names from generated `.mcp.json`
- `inheritedRisk`: `unknown | likely | blocked`
- `riskLevel`
- `reasons`

For Claude, high-risk launches should support a strict config path:

- `none`: append `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
- `core`: append `--strict-mcp-config --mcp-config <generated core Ruflo HTTP config>`
- `full`: current behavior, except still prefer shared Ruflo HTTP where SigmaLink writes config

This matters because user/plugin/project config can still start heavyweight servers. `.mcp.json` alone is not enough to control Claude startup.

For Codex, use config-profile overrides where available and keep diagnostics explicit if Codex cannot fully suppress inherited MCP in the same way.

### 3. Launch Decision UX

Before spawning a pane, if `SessionRiskReport` or `McpRiskReport` is high/critical, the renderer receives a structured admission warning instead of immediately spawning.

Dialog options:

- `Resume from summary`: default for high/critical Claude resumes. Launches provider's summary resume flow when supported.
- `Resume full session`: launches as-is, but requires explicit confirmation when critical.
- `Start fresh`: launches without resume args.
- `Start fresh + keep old link`: fresh pane with a small note/link to the old session id in pane metadata.
- `Strict core tools`: resume/fresh with strict generated Ruflo-only MCP.
- `No MCP diagnostic`: resume/fresh with strict empty MCP where provider supports it.

The dialog should show concise evidence:

- "Session: 7.1 MB, 1803 lines, 2d 7h old"
- "Estimated risk: high"
- "MCP: inherited config may start extra servers"
- "Expected: Claude base is usually hundreds of MB; full MCP can add hundreds more"

The user should not have to understand implementation details to choose. The default highlighted action is `Resume from summary` for old Claude sessions and `Start fresh` for critical sessions with no clear summary path.

### 4. Provider Launch Policy

Add a provider launch policy layer that converts the selected launch mode into CLI arguments and config.

Claude:

- `fresh`: no `--resume` or `--continue`.
- `resume-full`: existing resume args.
- `resume-summary`: existing resume args, then rely on Claude's own resume gate default selection where possible. If no reliable flag exists, SigmaLink should still open the pane at the gate with the recommended option highlighted by Claude.
- `strict-core-mcp`: add `--strict-mcp-config --mcp-config <path-or-json>`.
- `no-mcp`: add strict empty MCP config.

Codex:

- `fresh`: no `resume` subcommand.
- `resume-full`: existing resume behavior.
- MCP restriction: use available Codex config overrides if supported; otherwise show diagnostics that inherited MCP could still start.

### 5. Live Process Breakdown

Phase 1 already added process nodes to `pty.processStats`. Phase 2 should consume that in the renderer.

Pane header or hover details should show:

- total RSS
- root CLI RSS
- MCP child RSS
- process count
- top child command by RSS

Badge examples:

- `RSS 503 MB · CLI 503 · MCP 0`
- `RSS 1.6 GB · CLI 524 · MCP 1.1 GB`

When MCP child RSS exceeds 300 MB, show a warning state. The message should recommend `Strict core tools` or `No MCP diagnostic` for the next launch.

### 6. Runtime Observation Store

Persist lightweight observations for future risk decisions:

- `sessionId`
- `providerId`
- `externalSessionId`
- `workspaceId`
- `observedAt`
- `rootRssBytes`
- `mcpRssBytes`
- `totalRssBytes`
- `processCount`

This lets the analyzer treat a previously observed 1 GB session as critical even if JSONL size alone is ambiguous.

Retention: keep the latest 20 observations per workspace or 30 days, whichever is smaller.

### 7. Error Handling

- If session file lookup fails, return `riskLevel: unknown` and launch normally unless the requested mode was strict/no-MCP.
- If JSONL parsing partially fails, still return bytes/line count and note `partial-jsonl-parse`.
- If strict MCP config generation fails, do not silently fall back to full inherited MCP. Show a launch error and let the user choose full inherited MCP explicitly.
- If a provider does not support no-MCP/strict-MCP, hide that option or show it disabled with a short reason.

### 8. Testing

Unit tests:

- Session risk analyzer classifies synthetic JSONL fixtures into low/medium/high/critical.
- Analyzer handles malformed JSONL without throwing.
- MCP risk analyzer produces strict empty and strict core Claude configs.
- Provider launch policy appends Claude strict MCP args only for selected modes.
- Existing resume/full launch modes preserve current args.

Renderer tests:

- High-risk report opens the launch decision dialog.
- Default selected action is summary/fresh based on report.
- Force full resume still calls the original launch path with an explicit override.
- Pane RSS breakdown renders total/root/MCP/process count.

Integration/manual verification:

- Fresh Claude pane: confirm baseline roughly matches manual ~327 MB class.
- Large Claude resume with no MCP: confirm around the 500 MB class.
- Large Claude resume with full inherited MCP: confirm warning and child breakdown.
- Strict no-MCP mode: confirm no MCP child processes under the pane root.

## Acceptance Criteria

- Opening a high-risk old Claude session no longer silently creates a full inherited-MCP pane.
- User can still resume the full old session with full tools after explicit confirmation.
- User can start fresh or resume with strict/no-MCP mode from the same launch flow.
- Pane chrome explains whether memory is root CLI or MCP children.
- The Homeworks-style 431k-token session is classified as high or critical before launch.
- Focused tests and `pnpm build` pass.

## Open Implementation Questions

- Whether Claude exposes a non-interactive flag to force "resume from summary" without waiting at the interactive gate. If not, Phase 2 should still warn before spawn and let Claude's own gate handle summary selection.
- Whether Codex has a clean per-invocation equivalent of Claude's `--strict-mcp-config`. If not, Phase 2 should support strict MCP first for Claude and diagnostics for Codex.
- Resolved in implementation: ordinary `ruflo-core` Claude launches default to strict Ruflo-only MCP to block inherited global/user MCP. Explicit heavy tool profiles keep inherited MCP behavior, and the high-risk safe action uses strict no-MCP.
