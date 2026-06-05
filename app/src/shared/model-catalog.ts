// FEAT-14 — shared (renderer + main) model catalog.
//
// Single source of truth for the (provider, model) pairs surfaced by the
// launcher's per-row model dropdown AND the per-pane status strip. Previously
// the catalog was duplicated:
//   • main:     `MODEL_OPTIONS` in `main/core/providers/models.ts`
//   • renderer: `DEFAULT_MODELS` in command-room/PaneHeader.tsx
//
// The renderer cannot import main-process modules, so the two drifted. This
// plain data module has NO Node-only or renderer-only imports, so both sides
// import it directly. `main/core/providers/models.ts` re-exports the catalog
// and its types verbatim so its existing public surface (ModelOption /
// ModelEffort / MODEL_OPTIONS / listModelsFor / defaultModelFor) is unchanged.

export type ModelTransport = 'openrouter' | 'native';
export type ModelEffort = 'low' | 'medium' | 'high';

export interface ModelOption {
  /** Provider this model belongs to. Kept as a string (not the shared
   *  `ProviderId` union) so this module stays import-free of `./types`; the
   *  values are always provider ids from that union in practice. */
  providerId: string;
  modelId: string;
  label: string;
  via?: ModelTransport;
  defaultEffort?: ModelEffort;
}

// Default model catalog. Sensible defaults per V3 evidence:
//  - Claude pane chrome: `Claude Code v2.1.116 · Opus 4.7 (1M) · Claude Max` (frame 0045)
//  - Codex pane chrome: `gpt-5.4 high fast · ~/Desktop/sigmamind` (frame 0070)
//  - Gemini pane chrome: `gemini-2.5-pro` (frame 0090 area)
//  - OpenCode pane chrome: `Build · OpenCode default` (frames 0100, 0140)
export const MODEL_OPTIONS: ModelOption[] = [
  // Claude — three Anthropic tiers
  { providerId: 'claude', modelId: 'claude-opus-4-7', label: 'Opus 4.7 (1M)', via: 'native', defaultEffort: 'high' },
  { providerId: 'claude', modelId: 'claude-sonnet-4-6', label: 'Sonnet 4.6', via: 'native', defaultEffort: 'medium' },
  { providerId: 'claude', modelId: 'claude-haiku-4-5', label: 'Haiku 4.5', via: 'native', defaultEffort: 'low' },
  // Codex — gpt-5.4 high default per V3 chrome
  { providerId: 'codex', modelId: 'gpt-5.4', label: 'GPT-5.4 high', via: 'native', defaultEffort: 'high' },
  // Gemini — 2.5 Pro
  { providerId: 'gemini', modelId: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', via: 'native', defaultEffort: 'medium' },
  // Kimi — Moonshot AI's K2.6
  { providerId: 'kimi', modelId: 'kimi-k2.6', label: 'Kimi K2.6', via: 'native', defaultEffort: 'medium' },
  // OpenCode — its own default
  { providerId: 'opencode', modelId: 'opencode-default', label: 'OpenCode default', via: 'native', defaultEffort: 'medium' },
  // R-2 — Cursor agent (`cursor-agent --model <model>`). `cursor-agent models`
  // lists the live set; these are the two headline defaults from the verified
  // contract. The first entry is the `defaultModelFor` pick (Sonnet 4).
  { providerId: 'cursor', modelId: 'sonnet-4', label: 'Sonnet 4', via: 'native', defaultEffort: 'high' },
  { providerId: 'cursor', modelId: 'gpt-5', label: 'GPT-5', via: 'native', defaultEffort: 'high' },
];

export function listModelsFor(providerId: string): ModelOption[] {
  return MODEL_OPTIONS.filter((m) => m.providerId === providerId);
}

export function defaultModelFor(providerId: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((m) => m.providerId === providerId);
}

/**
 * FEAT-14 — providers whose CLI accepts a `--model <id>` spawn flag. Verified
 * per-provider contract:
 *   • claude  — `claude --model <id>`
 *   • cursor  — `cursor-agent --model <id>`
 *   • gemini  — `gemini --model <id>`
 * codex / kimi / opencode / shell / custom take their model another way (or
 * not at all); passing an unknown `--model` flag would break their spawn, so
 * the launcher SKIPS them. Exported so both the launcher (gating arg
 * injection) and the renderer (deciding whether to render the dropdown) read
 * the SAME allowlist.
 */
export const MODEL_FLAG_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'cursor', 'gemini']);

/** True when `providerId`'s CLI accepts a `--model <id>` spawn flag. */
export function providerAcceptsModelFlag(providerId: string): boolean {
  return MODEL_FLAG_PROVIDERS.has(providerId);
}

// ──────────────────────────────────────────────────────────────────────────────
// BSP-V2 — fast/balanced/deep dispatch preset (Lane M).
//
// A UI shorthand that maps a 3-tier intent to a concrete claude model id. Only
// meaningful for claude panes; the preset control in AgentsStep sets the claude
// row's modelId via the existing onModelsChange callback — no new spawn flag.
//
// Locked mapping (operator decision):
//   fast     → claude-haiku-4-5
//   balanced → claude-sonnet-4-6
//   deep     → claude-opus-4-7
// ──────────────────────────────────────────────────────────────────────────────

export type DispatchPreset = 'fast' | 'balanced' | 'deep';

/**
 * Map a dispatch preset to the concrete claude model id. The ids are read from
 * MODEL_OPTIONS above so there is exactly one source of truth.
 */
export const PRESET_TO_MODEL_ID: Record<DispatchPreset, string> = {
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-4-6',
  deep: 'claude-opus-4-7',
};

/**
 * Resolve a dispatch preset to a model id. Returns the mapped id for
 * 'fast'/'balanced'/'deep'; returns undefined for unknown values so callers can
 * distinguish "no preset" from a bad string.
 */
export function presetToModelId(preset: DispatchPreset): string {
  return PRESET_TO_MODEL_ID[preset];
}
