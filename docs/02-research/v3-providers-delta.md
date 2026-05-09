# V3 Providers Delta

SigmaLink ships 11 providers (PRODUCT_SPEC §4): claude, codex, gemini, kimi, cursor,
opencode, droid, copilot, aider, continue, custom. V3 confirms a different set.

## V3 evidence

- Wizard agent matrix + BridgeSwarm CLI strip: **BridgeCode · Claude · Codex · Gemini ·
  OpenCode · Cursor · Droid · Copilot** + Custom Command — 0055, 0184, 0205.
- Design-Mode per-prompt picker: **Claude · Codex · Gemini · OpenCode** — 0380.
- Pricing Pro tier: **BridgeCode (Coming Soon)** as a SKU — 0510.

## Diff vs current (11 → 9 default)

| id | Today | V3 | Action |
|---|---|---|---|
| `bridgecode` | absent | NEW first-party CLI agent | **add** |
| `claude` | shipped | shipped (default) | keep |
| `codex` | shipped | shipped | keep |
| `gemini` | shipped | shipped | keep |
| `opencode` | shipped | shipped (Kimi-K2.6 is its model selection) | keep |
| `cursor` | shipped | shipped | keep |
| `droid` | shipped | shipped | keep |
| `copilot` | shipped | shipped | keep |
| `kimi` | shipped (own row) | absent from matrix; visible only as `Build · Kimi K2.6 OpenRouter` chip in OpenCode | **demote** to a model option under OpenCode (and any OpenRouter-capable provider) |
| `aider` | shipped | not visible | **hide by default** behind Settings → "Show legacy" |
| `continue` | shipped | not visible | **hide by default** (same toggle) |
| `custom` | shipped | shipped — explicit Custom Command row + `+ Add custom command` | keep; rename UI to "Custom Command" |

Net default registry: **9 providers** (8 named + custom). Two retained behind toggle. One
demoted to a model option.

## BridgeCode definition `[CHOSEN]`

V3 leaves it partially undefined — wizard treats it like any CLI agent (0055), but pricing
tags it `(Coming Soon)` (0510). Ship a thin stub: `id 'bridgecode'`, `command 'bridgecode'`
(`altCommands ['bridgecode.cmd']`), mirror Claude args (`-p {prompt}` / `--resume`),
`color '#7c3aed'`, `icon 'sparkles'`, `recommendedRoles ['builder','coordinator']`. Add two
new fields to `ProviderDefinition` in `src/main/core/providers/types.ts`: `comingSoon?:
boolean` and `fallbackProviderId?: ProviderId`. When `comingSoon === true` and the binary
isn't on PATH, the launcher silently spawns the fallback (Claude) and records
`agent_sessions.providerEffective = 'claude'` so chrome renders "BridgeCode (using
Claude)".

## OpenRouter / Kimi handling

OpenCode carries `Build · Kimi K2.6 OpenRouter` (0100, 0140) — model selection, not provider.
Move Kimi into `src/main/core/providers/models.ts` as `ModelOption { providerId, modelId,
label, via?: 'openrouter'\|'native', defaultEffort? }`. Per-pane status strip (0070
`gpt-5.4 high fast · ~/Desktop/bridgemind`) renders `<model> <effort> <speed> · <cwd>` for
any `(provider, model)` combo.

## UI implications

Wizard matrix order: `BridgeCode | Claude | Codex | Gemini | OpenCode | Cursor | Droid |
Copilot | Custom Command` (0055, 0184) — update `Launcher.tsx` and
`swarm-room/RoleRoster.tsx` together. Quick-fills *Enable all / One of each / Split evenly*
(0055); *One of each* skips Coming Soon providers. Per-pane chrome variants: Claude
(`Claude Code v2.1.116 · Opus 4.7 (1M) · Claude Max`), Codex (`OpenAI Codex v0.121.0 ·
gpt-5.4 high fast`), OpenCode (giant ASCII + Build chip). Custom Command row + `+ Add
custom command` at matrix bottom.

## Wave routing

**W12** BridgeCode stub + `comingSoon`/`fallbackProviderId`; demote `kimi` to model option +
`models.ts`; hide `aider`/`continue`; wizard matrix order + Custom Command row + quick-fill
macros. **W13** per-pane chrome variants for Claude / Codex / OpenCode + model+speed strip.
