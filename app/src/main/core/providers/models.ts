// V3-W12-002: model selection layer.
//
// V3 demotes Kimi from a top-level provider to a *model option* under
// OpenCode (and any future OpenRouter-capable provider). This file holds the
// (provider, model) pairs the per-pane status strip and wizard model
// dropdowns consume. Effort and speed are best-effort defaults; the per-pane
// chrome (V3-W13-003) renders them as `<model> <effort> <speed> · <cwd>`.

import type { ProviderId } from './types';

export type ModelTransport = 'openrouter' | 'native';
export type ModelEffort = 'low' | 'medium' | 'high';

export interface ModelOption {
  providerId: ProviderId;
  modelId: string;
  label: string;
  via?: ModelTransport;
  defaultEffort?: ModelEffort;
}

// Default model catalog. Sensible defaults per V3 evidence:
//  - Claude pane chrome: `Claude Code v2.1.116 · Opus 4.7 (1M) · Claude Max` (frame 0045)
//  - Codex pane chrome: `gpt-5.4 high fast · ~/Desktop/bridgemind` (frame 0070)
//  - Gemini pane chrome: `gemini-2.5-pro` (frame 0090 area)
//  - OpenCode pane chrome: `Build · Kimi K2.6 OpenRouter` (frames 0100, 0140)
export const MODEL_OPTIONS: ModelOption[] = [
  // Claude — three Anthropic tiers
  { providerId: 'claude', modelId: 'claude-opus-4-7', label: 'Opus 4.7 (1M)', via: 'native', defaultEffort: 'high' },
  { providerId: 'claude', modelId: 'claude-sonnet-4-6', label: 'Sonnet 4.6', via: 'native', defaultEffort: 'medium' },
  { providerId: 'claude', modelId: 'claude-haiku-4-5', label: 'Haiku 4.5', via: 'native', defaultEffort: 'low' },
  // Codex — gpt-5.4 high default per V3 chrome
  { providerId: 'codex', modelId: 'gpt-5.4', label: 'GPT-5.4 high', via: 'native', defaultEffort: 'high' },
  // Gemini — 2.5 Pro
  { providerId: 'gemini', modelId: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', via: 'native', defaultEffort: 'medium' },
  // OpenCode — its own default + Kimi K2.6 (OpenRouter)
  { providerId: 'opencode', modelId: 'opencode-default', label: 'OpenCode default', via: 'native', defaultEffort: 'medium' },
  { providerId: 'opencode', modelId: 'kimi-k2.6', label: 'Kimi K2.6 (OpenRouter)', via: 'openrouter', defaultEffort: 'medium' },
  // BridgeCode (coming soon) — falls back to Claude at spawn time but the
  // matrix still surfaces a notional default model.
  { providerId: 'bridgecode', modelId: 'bridgecode-default', label: 'BridgeCode default', via: 'native', defaultEffort: 'medium' },
];

export function listModelsFor(providerId: ProviderId): ModelOption[] {
  return MODEL_OPTIONS.filter((m) => m.providerId === providerId);
}

export function defaultModelFor(providerId: ProviderId): ModelOption | undefined {
  return MODEL_OPTIONS.find((m) => m.providerId === providerId);
}
