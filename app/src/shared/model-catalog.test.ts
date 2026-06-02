// FEAT-14 — shared model-catalog contract tests.
//
// Pins the data + helper surface that BOTH the renderer (AgentsStep dropdown,
// PaneHeader strip) and the main process (launcher `--model` injection) read.
// A regression here would silently break per-pane model selection on one side
// while leaving the other intact (the exact drift FEAT-14 set out to kill).

import { describe, it, expect } from 'vitest';
import {
  MODEL_OPTIONS,
  listModelsFor,
  defaultModelFor,
  MODEL_FLAG_PROVIDERS,
  providerAcceptsModelFlag,
} from './model-catalog';

describe('model-catalog — MODEL_OPTIONS shape', () => {
  it('every entry has providerId, modelId, and label', () => {
    expect(MODEL_OPTIONS.length).toBeGreaterThan(0);
    for (const m of MODEL_OPTIONS) {
      expect(typeof m.providerId).toBe('string');
      expect(m.providerId.length).toBeGreaterThan(0);
      expect(typeof m.modelId).toBe('string');
      expect(m.modelId.length).toBeGreaterThan(0);
      expect(typeof m.label).toBe('string');
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it('modelIds are unique within a provider', () => {
    const byProvider = new Map<string, Set<string>>();
    for (const m of MODEL_OPTIONS) {
      const set = byProvider.get(m.providerId) ?? new Set<string>();
      expect(set.has(m.modelId)).toBe(false);
      set.add(m.modelId);
      byProvider.set(m.providerId, set);
    }
  });
});

describe('listModelsFor', () => {
  it('returns only the models for the requested provider', () => {
    const claude = listModelsFor('claude');
    expect(claude.length).toBeGreaterThan(0);
    expect(claude.every((m) => m.providerId === 'claude')).toBe(true);
  });

  it('returns an empty array for an unknown provider', () => {
    expect(listModelsFor('nope')).toEqual([]);
  });

  it('cursor exposes its two headline models', () => {
    const cursor = listModelsFor('cursor');
    expect(cursor.map((m) => m.modelId)).toEqual(['sonnet-4', 'gpt-5']);
  });
});

describe('defaultModelFor', () => {
  it('returns the first catalog entry for a provider (Sonnet 4 for cursor)', () => {
    expect(defaultModelFor('cursor')?.modelId).toBe('sonnet-4');
    expect(defaultModelFor('claude')?.modelId).toBe('claude-opus-4-7');
  });

  it('returns undefined for an unknown provider', () => {
    expect(defaultModelFor('nope')).toBeUndefined();
  });
});

describe('MODEL_FLAG_PROVIDERS / providerAcceptsModelFlag', () => {
  it('claude, cursor, and gemini accept the --model flag', () => {
    expect(providerAcceptsModelFlag('claude')).toBe(true);
    expect(providerAcceptsModelFlag('cursor')).toBe(true);
    expect(providerAcceptsModelFlag('gemini')).toBe(true);
  });

  it('codex, kimi, opencode, shell, and custom are SKIPPED', () => {
    expect(providerAcceptsModelFlag('codex')).toBe(false);
    expect(providerAcceptsModelFlag('kimi')).toBe(false);
    expect(providerAcceptsModelFlag('opencode')).toBe(false);
    expect(providerAcceptsModelFlag('shell')).toBe(false);
    expect(providerAcceptsModelFlag('custom')).toBe(false);
  });

  it('the allowlist set matches the helper', () => {
    expect(MODEL_FLAG_PROVIDERS.has('claude')).toBe(true);
    expect(MODEL_FLAG_PROVIDERS.has('codex')).toBe(false);
  });

  it('every model-flag provider also has catalog entries (no dead dropdowns)', () => {
    for (const id of MODEL_FLAG_PROVIDERS) {
      expect(listModelsFor(id).length).toBeGreaterThan(0);
    }
  });
});
