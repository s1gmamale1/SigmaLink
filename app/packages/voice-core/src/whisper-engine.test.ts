// whisper-engine.test.ts — Unit tests for resolveTranscriptionEngine (BSP-V1).
//
// Tests that resolve picks the correct engine for each TranscriptionMode value,
// including the two new cloud modes.
//
// Run via:
//   npx vitest run packages/voice-core/src/whisper-engine.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: node:module createRequire  (so getWhisperEngine returns a stub engine)
// ---------------------------------------------------------------------------

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => () => {
    throw new Error('mocked createRequire — native not available');
  }),
}));

// We also need to mock @sigmalink/voice-whisper so the re-export type doesn't
// blow up (not actually imported at runtime in this test).
vi.mock('@sigmalink/voice-whisper', () => ({ default: {} }));

import {
  resolveTranscriptionEngine,
  _resetWhisperEngineCache,
  type WhisperEngine,
} from './whisper-engine.js';

// ---------------------------------------------------------------------------
// Helper — stub engine factory
// ---------------------------------------------------------------------------

function makeStub(name: string): WhisperEngine {
  return {
    transcribe: vi.fn(async () => ({ text: `${name} transcript`, segments: [] })),
  };
}

describe('resolveTranscriptionEngine — BSP-V1', () => {
  beforeEach(() => {
    _resetWhisperEngineCache();
  });

  it("'local' / null / undefined → native whisper (null when native unavailable)", () => {
    // Native is unavailable in tests (createRequire throws) → null
    expect(resolveTranscriptionEngine('local')).toBeNull();
    expect(resolveTranscriptionEngine(null)).toBeNull();
    expect(resolveTranscriptionEngine(undefined)).toBeNull();
    expect(resolveTranscriptionEngine('unrecognised')).toBeNull();
  });

  it("'gemini-cli' → cliEngine when provided", () => {
    const cli = makeStub('cli');
    const result = resolveTranscriptionEngine('gemini-cli', cli, null, null);
    expect(result).toBe(cli);
  });

  it("'gemini-cli' with no cliEngine → falls through to native (null)", () => {
    const result = resolveTranscriptionEngine('gemini-cli', null, null, null);
    expect(result).toBeNull();
  });

  it("'openai-whisper-api' → openaiEngine when provided", () => {
    const openai = makeStub('openai');
    const result = resolveTranscriptionEngine('openai-whisper-api', null, openai, null);
    expect(result).toBe(openai);
  });

  it("'openai-whisper-api' with no openaiEngine → falls through to native (null)", () => {
    const result = resolveTranscriptionEngine('openai-whisper-api', null, null, null);
    expect(result).toBeNull();
  });

  it("'deepgram' → deepgramEngine when provided", () => {
    const dg = makeStub('deepgram');
    const result = resolveTranscriptionEngine('deepgram', null, null, dg);
    expect(result).toBe(dg);
  });

  it("'deepgram' with no deepgramEngine → falls through to native (null)", () => {
    const result = resolveTranscriptionEngine('deepgram', null, null, null);
    expect(result).toBeNull();
  });

  it('cloud engine takes precedence over cliEngine for its mode', () => {
    const cli = makeStub('cli');
    const openai = makeStub('openai');
    // Passing both for 'openai-whisper-api' → openai wins
    const result = resolveTranscriptionEngine('openai-whisper-api', cli, openai, null);
    expect(result).toBe(openai);
  });

  it('each cloud engine is independent — wrong mode → falls through', () => {
    const dg = makeStub('deepgram');
    // deepgram engine provided but mode is 'openai-whisper-api'
    const result = resolveTranscriptionEngine('openai-whisper-api', null, null, dg);
    // openai engine is null, so falls through to native (null)
    expect(result).toBeNull();
  });
});
