import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sanitizeLabel, summarizePrompt,
  setAgentLabel, getAgentLabel, subscribeAgentLabel, clearAgentLabel, __resetAgentLabels,
} from './pane-labels';

afterEach(() => __resetAgentLabels());

describe('sanitizeLabel', () => {
  it('keeps a normal label, trimmed', () => {
    expect(sanitizeLabel('  Async token refresh refactor  ')).toBe('Async token refresh refactor');
  });
  it('strips ANSI escape sequences and control chars', () => {
    expect(sanitizeLabel('\x1b[31mReviewing auth\x1b[0m')).toBe('Reviewing auth');
    expect(sanitizeLabel('Build\x07 step')).toBe('Build step');
  });
  it('collapses internal whitespace', () => {
    expect(sanitizeLabel('a   b\t c')).toBe('a b c');
  });
  it('rejects empty / whitespace-only', () => {
    expect(sanitizeLabel('   ')).toBeNull();
    expect(sanitizeLabel('')).toBeNull();
  });
  it('caps at 80 chars', () => {
    expect(sanitizeLabel('x'.repeat(200))?.length).toBe(80);
  });
});

describe('summarizePrompt', () => {
  it('returns null for empty/nullish', () => {
    expect(summarizePrompt(null)).toBeNull();
    expect(summarizePrompt(undefined)).toBeNull();
    expect(summarizePrompt('   ')).toBeNull();
  });
  it('collapses whitespace/newlines to one line', () => {
    expect(summarizePrompt('Refactor the\n  auth module')).toBe('Refactor the auth module');
  });
  it('caps long prompts with an ellipsis', () => {
    const out = summarizePrompt('x'.repeat(200));
    expect(out?.length).toBe(60);
    expect(out?.endsWith('…')).toBe(true);
  });
});

describe('agent-label store', () => {
  it('stores a sanitized label and reads it back', () => {
    setAgentLabel('s1', 'Reviewing auth');
    expect(getAgentLabel('s1')).toBe('Reviewing auth');
  });
  it('returns null for unknown session', () => {
    expect(getAgentLabel('nope')).toBeNull();
  });
  it('keeps the last good value when junk arrives', () => {
    setAgentLabel('s1', 'Reviewing auth');
    setAgentLabel('s1', '   ');
    expect(getAgentLabel('s1')).toBe('Reviewing auth');
  });
  it('notifies on change, stops after unsubscribe', () => {
    const cb = vi.fn();
    const off = subscribeAgentLabel('s1', cb);
    setAgentLabel('s1', 'A');
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    setAgentLabel('s1', 'B');
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('does not notify when sanitized value is unchanged', () => {
    const cb = vi.fn();
    subscribeAgentLabel('s1', cb);
    setAgentLabel('s1', 'A');
    setAgentLabel('s1', 'A');
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('clearAgentLabel removes the entry and notifies', () => {
    const cb = vi.fn();
    subscribeAgentLabel('s1', cb);
    setAgentLabel('s1', 'A');
    clearAgentLabel('s1');
    expect(getAgentLabel('s1')).toBeNull();
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
