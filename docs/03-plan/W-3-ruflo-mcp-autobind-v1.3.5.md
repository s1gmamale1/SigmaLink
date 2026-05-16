# W-3 — Auto-bind Ruflo MCP for every CLI pane (target v1.3.5)

## Context

W-3 was added to the wishlist on 2026-05-15. Investigation under plan-mode (2026-05-16) revealed two facts:

1. **Two-thirds of W-3 is already shipped.** `app/src/main/core/workspaces/mcp-autowrite.ts` already injects Ruflo MCP into Claude (`.mcp.json`), Codex (`~/.codex/config.toml`), and Gemini (`~/.gemini/settings.json`) at workspace-open time via `writeWorkspaceMcpConfig()`. `RufloReadinessPill` verifies via `verifyForWorkspace()` RPC.
2. **The shipped path has a critical bug.** Line 9 of `mcp-autowrite.ts` declares `RUFLO_ARGS = ['@claude-flow/cli@latest', 'mcp-stdio']`. There is no `mcp-stdio` subcommand in `@claude-flow/cli`. The real form is `['-y', '@claude-flow/cli@latest', 'mcp', 'start']`. Every Ruflo entry written to disk by v1.3.4 fails when an external CLI tries to actually launch the server. The fast-mode verifier only checks file presence (lines 77-95 of `verify.ts`) so the readiness pill reports green even though the servers are non-functional.

v1.3.5 fixes the canonical args AND adds the missing Kimi + OpenCode coverage so the readiness pill becomes truthful for all five supported providers.

## Scope decisions (confirmed by user 2026-05-16)

- Canonical-args bug fix bundles into W-3, not split into a separate hotfix.
- Per-provider write is gated by a soft PATH-or-existing-file detect: we won't create empty `~/.kimi/` or `~/.config/opencode/` dirs for users who don't have those CLIs installed.
- v1.3.5 is a patch release: all RPC additions are additive and backwards-compatible.

## Strategy

### Phase 1 — Canonical args fix

`mcp-autowrite.ts` line 9 → `RUFLO_ARGS = ['-y', '@claude-flow/cli@latest', 'mcp', 'start']`. The existing `mergeRufloEntry` + `isManagedRufloEntry` logic recognises any entry where `command === 'npx'` as "managed" and rewrites args on next `openWorkspace()`. Result: every user's broken `mcp-stdio` configs self-heal on the first SigmaLink launch after v1.3.5.

### Phase 2 — Provider strategy refactor

`mcp-autowrite.ts` is 286 LOC at v1.3.4. Adding Kimi + OpenCode would push it past the 500-LOC budget. Extract per-provider format-specific writers into a sibling file `mcp-autowrite-providers.ts`:

```ts
export interface RufloMcpTarget {
  id: 'claude' | 'codex' | 'gemini' | 'kimi' | 'opencode';
  resolvePath(args: { workspaceRoot: string; homeDir: string }): string | null;
  detectCustomEntry(target: string): string | null;
  write(args: { target: string; server: RufloServer; refused: string[]; logger: Pick<Console,'warn'> }): string | null;
}

export const RUFLO_MCP_TARGETS: readonly RufloMcpTarget[] = [
  claudeJsonTarget, codexTomlTarget, geminiJsonTarget, kimiJsonTarget, opencodeJsonTarget,
];
```

`mcp-autowrite.ts` keeps the public API (`writeWorkspaceMcpConfig`) and the shared helpers (`mergeRufloEntry`, `isManagedRufloEntry`, `writeFileAtomic`, `findTomlTableRanges`, etc.). The provider strategies import those helpers from the main module.

### Phase 3 — Kimi target

- Path: `~/.kimi/mcp.json` (per Moonshot docs).
- Schema: identical to Claude (`{ mcpServers: { ruflo: { command, args, env } } }`). Reuses `writeJsonMcpFile()` verbatim.
- `resolvePath` returns `~/.kimi/mcp.json` if any of: (a) file exists, (b) `kimi` on PATH, (c) `kimi.cmd` on PATH (Windows future-proof). Otherwise returns `null` → silent skip.
- `detectCustomEntry` reuses `hasCustomJsonRufloEntry` (same schema shape).

### Phase 4 — OpenCode target

- Path: `~/.config/opencode/opencode.json` (per OpenCode docs; literal — `OPENCODE_CONFIG` env override is out of scope for v1.3.5).
- **Schema differs from all other providers:**
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "ruflo": {
        "type": "local",
        "command": ["npx", "-y", "@claude-flow/cli@latest", "mcp", "start"],
        "environment": { "CLAUDE_FLOW_DIR": "<workspaceRoot>/.claude-flow" },
        "enabled": true
      }
    }
  }
  ```
  Note: top-level key is `mcp` not `mcpServers`; `command` is a single flat array (no separate `args`); env-vars key is `environment` not `env`; entry has `type: 'local'` and `enabled: true`.
- New `toOpencodeEntry(server: RufloServer): JsonObject` helper flattens `[command, ...args]` and renames `env → environment`. Preserves user-set `enabled: false`, `timeout`, and any other arbitrary keys via shallow merge.
- `detectCustomEntry`: walks `parsed.mcp?.ruflo`; returns the path if `command[0] !== 'npx'` (treats `bunx`, `uvx`, absolute-path commands as user-managed; refuses to clobber).
- $schema preservation: read existing top-level `$schema` and re-emit unchanged.

### Phase 5 — verify.ts extension

Extend the verification result type:

```ts
export interface RufloWorkspaceVerification {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  kimi: boolean;
  opencode: boolean;
  detected: { kimi: boolean; opencode: boolean };  // tri-state for soft-skip
  errors: RufloVerifyError[];
  mode: RufloVerifyMode;
}
```

`verifyFast()`:
- Existing `checkJsonConfig(home + '/.claude.json', 'claude')` (unchanged).
- Existing `checkCodexConfig(home + '/.codex/config.toml', 'codex')` (unchanged).
- Existing `checkJsonConfig(home + '/.gemini/settings.json', 'gemini')` (unchanged).
- NEW `checkJsonConfig(home + '/.kimi/mcp.json', 'kimi')` (reuses helper).
- NEW `checkOpencodeConfig(home + '/.config/opencode/opencode.json')` — reads JSON, looks at `parsed.mcp?.ruflo`, validates `Array.isArray(command) && command[0] === 'npx'`.

`detected.kimi` / `detected.opencode` are populated by a one-shot PATH probe (`fs.existsSync` against each PATH entry per platform). When `detected[cli] === false` AND the config file is missing, do NOT push an error — silent skip.

`verifyStrict()` probes:
- Existing: `claude mcp list`, `codex mcp list`, `gemini mcp list`.
- NEW (gated by `detected[cli]`): `kimi mcp list`, `opencode mcp list`.
- R2 risk: `kimi mcp list` / `opencode mcp list` may not be real subcommands on the installed binary. Verify during implementation. If absent, skip strict-mode probe for that CLI (treat as `true`); document as a known limitation in release notes.

### Phase 6 — RufloReadinessPill update

```ts
// 5 CLIs; vacuously-pass when undetected
const cliResults = [
  result.claude,
  result.codex,
  result.gemini,
  !result.detected.kimi || result.kimi,
  !result.detected.opencode || result.opencode,
];
const passed = cliResults.filter(Boolean).length;
if (passed === 5) return 'verified';
if (passed >= 3) return 'partial';
return 'unavailable';
```

Tooltip (lines 80-89) gains a row each for Kimi / OpenCode with their status (or "not detected" greyed-out).

### Phase 7 — RPC shape

`app/src/shared/router-shape.ts` `verifyForWorkspace` return type gains `kimi: boolean`, `opencode: boolean`, `detected: { kimi: boolean; opencode: boolean }`. All additive — non-breaking.

## Critical files

| File | Change | Approx LOC after |
|---|---|---|
| `app/src/main/core/workspaces/mcp-autowrite.ts` | Refactor — keep public API + shared helpers; canonical-args fix | ~220 |
| `app/src/main/core/workspaces/mcp-autowrite-providers.ts` (NEW) | 5 `RufloMcpTarget` strategies | ~140 |
| `app/src/main/core/workspaces/mcp-autowrite.test.ts` | +11 new cases | ~370 |
| `app/src/main/core/ruflo/verify.ts` | Type extension + 5-CLI fast/strict probes + detect | ~280 |
| `app/src/main/core/ruflo/verify.test.ts` | +7 new cases | ~200 |
| `app/src/shared/router-shape.ts` | Additive type | minor |
| `app/src/renderer/components/RufloReadinessPill.tsx` | 5-CLI count + tooltip | ~150 |

## Reuse callouts — DO NOT reinvent

- `mergeRufloEntry`, `isManagedRufloEntry`, `writeFileAtomic`, `findTomlTableRanges`, `parseTomlStringValue`, `replaceTomlTables` — all in `mcp-autowrite.ts`, stay as shared helpers exported for the providers module.
- `writeJsonMcpFile` — moves into providers file; Kimi target imports it verbatim.
- `checkJsonConfig` in `verify.ts` — reusable for Kimi (Claude-shape schema).
- `CLAUDE_FLOW_DIR` env var convention from existing entries — extend to Kimi + OpenCode.
- Path-detection (`PATH` split + `fs.existsSync` per platform) — new helper but small, lives in `mcp-autowrite-providers.ts`.

## Test plan

### `mcp-autowrite.test.ts` — 11 new cases

1. `writes Kimi mcp.json when kimi binary is detected`
2. `skips Kimi when binary missing and no existing config`
3. `writes Kimi when existing file is present even without binary on PATH`
4. `writes OpenCode opencode.json with type:local, array command, environment key`
5. `preserves OpenCode $schema and unrelated top-level keys (model, ...)`
6. `merges OpenCode entry without clobbering user env vars or enabled=false`
7. `refuses OpenCode when command[0] is not npx (bunx/uvx/absolute path)`
8. `refuses Kimi when existing ruflo entry is user-managed`
9. `canonical args use 'mcp start' not 'mcp-stdio'` (regression test against pre-v1.3.5 bug)
10. `idempotency across all 5 providers — second call is a no-op`
11. `all-or-nothing refusal triggers when a custom Kimi or OpenCode entry exists`

### `verify.test.ts` — 7 new cases

1. `fast mode verifies all 5 CLIs when configured`
2. `fast mode treats missing Kimi config as OK when binary not detected`
3. `fast mode flags missing Kimi config when binary IS detected`
4. `fast mode verifies OpenCode array-command format`
5. `fast mode rejects OpenCode with non-npx command[0]`
6. `strict mode probes kimi mcp list and opencode mcp list when detected`
7. `strict mode skips probe for undetected CLIs`

### Optional: `RufloReadinessPill.test.tsx`

Skip unless existing renderer test infra is in place; the verify-side coverage is the load-bearing one.

## Verification gate

```bash
cd /Users/aisigma/projects/SigmaLink/app
npm exec tsc -b --pretty false                       # clean
npm exec vitest run                                  # 323 baseline + ~18 new = ~341 expected
npm exec eslint .                                    # clean (existing use-session-restore warning unchanged)
npm run build                                        # vite + tsc clean
node scripts/build-electron.cjs                      # electron compile clean
```

Manual smoke (after install/update on user's machine):

1. Open a workspace.
2. Verify `~/.kimi/mcp.json` and `~/.config/opencode/opencode.json` are created (if those CLIs are on PATH) with the canonical args including `mcp start`.
3. Verify existing `~/.codex/config.toml` `[mcp_servers.ruflo]` args are silently updated from `mcp-stdio` to `mcp start` on first launch.
4. RufloReadinessPill shows 5/5 verified (or 3/5 + "Kimi/OpenCode not detected" greyed when those CLIs aren't installed).

## Risk register

| ID | Risk | Mitigation |
|---|---|---|
| R1 | `npx -y @claude-flow/cli@latest mcp start` may exit early when invoked by an MCP client because the cli's stdin-check (cli.js:44) requires `!process.stdin.isTTY`. MCP clients pipe stdin → condition holds → should work. But verify with `echo '' \| npx -y @claude-flow/cli@latest mcp start` during implementation. | If fails: switch to direct binary `args: ['-y', '-p', '@claude-flow/cli@latest', 'claude-flow-mcp']` (the cli's package.json declares the `claude-flow-mcp` bin). |
| R2 | `kimi mcp list` / `opencode mcp list` may not be real subcommands. | Skip strict-mode probe for those CLIs if their `mcp` subcommand exits non-zero on `--help`. Fast-mode (config-file inspection) is sufficient for the readiness pill. Document as known limitation. |
| R3 | OpenCode future schema change (e.g., `command` becomes a string instead of array). | Comment in `toOpencodeEntry` documents the v1.0 schema. If OpenCode breaks compat, our refusal logic falls back to "user-managed" → no clobber. |
| R4 | Pre-existing v1.3.4 configs with `mcp-stdio` get rewritten silently on first v1.3.5 launch. | Acceptable; mention in CHANGELOG "Migration" note so power-users who manually edited their ruflo entries aren't surprised. |
| R5 | Atomic write race: `~/.kimi/mcp.json` open by kimi CLI while SigmaLink rewrites. | Existing `writeFileAtomic` uses `writeFileSync + renameSync` (atomic on POSIX, same trade-off as current Codex/Gemini path). |
| R6 | `OPENCODE_CONFIG` env override makes our default-path write wrong. | Out of scope. Document in release notes: "if you override `OPENCODE_CONFIG`, run the ruflo MCP merge into your custom file manually." |

## Effort

| Task | Estimate |
|---|---|
| Provider strategy refactor + canonical args fix (§2 + §1) | 3.0 h |
| Kimi + OpenCode targets (§3 + §4) | included above |
| verify.ts extension + `detected` field (§5) | 1.5 h |
| Router shape + RufloReadinessPill (§6 + §7) | 1.0 h |
| mcp-autowrite tests (11 cases) | 2.5 h |
| verify.test.ts (7 cases) | 1.5 h |
| R1 smoke verify (`mcp start` via piped stdin) | 0.5 h |
| Verification gate + lint drift fixes | 0.5 h |
| CHANGELOG + version bump + commit hygiene + PR | 0.5 h |
| **Total** | **~11 h / 1.5 dev-days** |

Add ~1 h buffer for R2 fallout if strict-mode probes need fallback wiring.

## Sequencing

1. Phase 2 (refactor) + Phase 1 (canonical args fix) — single commit on the worktree branch.
2. Phase 3 (Kimi) — second commit, with first 4 `mcp-autowrite.test.ts` cases.
3. Phase 4 (OpenCode) — third commit, with next 5 test cases.
4. Phase 5 (verify.ts extension) — fourth commit, with all 7 verify tests.
5. Phase 6 + 7 (renderer + RPC shape) — fifth commit.
6. Verification gate run (sixth commit if lint/test drift fixes needed).
7. Version bump + CHANGELOG + release notes (seventh commit).
8. Push, open PR.

## Version bump

1.3.4 → **1.3.5** (patch). RPC additions are additive; renderer is backwards-compatible if it ignores new fields.

CHANGELOG header: `## [1.3.5] - 2026-05-XX`
Sections:
- `### Fixed` — canonical args bug (G1), self-heal of existing user configs (R4)
- `### Added` — Kimi target, OpenCode target, `detected` tri-state in `verifyForWorkspace`, 5-CLI readiness count
- `### Verification` — the gate block above

## Migration

For users on v1.3.4 with manual edits in their Ruflo MCP entries (anywhere — Claude / Codex / Gemini / future Kimi / future OpenCode):
- If `command !== 'npx'`: SigmaLink refuses to autowrite → user's manual config preserved.
- If `command === 'npx'` (default / managed entry): SigmaLink rewrites `args` to `['-y', '@claude-flow/cli@latest', 'mcp', 'start']` on next `openWorkspace()`.
- `env` keys are merged — user-added env vars survive.

## Out of scope (v1.3.6+ candidates)

- Detection-gated writes for Claude / Codex / Gemini (currently unconditional). Cosmetic — defer.
- `OPENCODE_CONFIG` env override support.
- `kimi mcp list` / `opencode mcp list` strict-mode fallback if those subcommands don't exist.
- Auto-pruning of stale `mcp-stdio` entries in user configs that have BOTH `mcp-stdio` and `mcp start` (shouldn't happen given merge semantics; just defensive).
