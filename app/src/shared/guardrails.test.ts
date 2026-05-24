import { describe, it, expect } from 'vitest';
import { GUARDRAILS, buildGuardrailMarkdown } from './guardrails';

describe('GUARDRAILS', () => {
  it('has the 4 named guardrails', () => {
    expect(Object.keys(GUARDRAILS).sort()).toEqual([
      'dry-principle',
      'keep-ci-green',
      'security-audit',
      'test-driven',
    ]);
  });

  it('each guardrail has id, title, and instruction fields', () => {
    for (const [key, g] of Object.entries(GUARDRAILS)) {
      expect(g.id).toBe(key);
      expect(typeof g.title).toBe('string');
      expect(g.title.length).toBeGreaterThan(0);
      expect(typeof g.instruction).toBe('string');
      expect(g.instruction.length).toBeGreaterThan(0);
    }
  });
});

describe('buildGuardrailMarkdown', () => {
  it('builds markdown for enabled ids, skips unknown, empty→""', () => {
    const md = buildGuardrailMarkdown(['test-driven', 'nope']);
    expect(md).toContain('Test-Driven');
    expect(md).not.toContain('nope');
    expect(buildGuardrailMarkdown([])).toBe('');
  });

  it('includes all 4 guardrail titles when all ids are enabled', () => {
    const md = buildGuardrailMarkdown(['test-driven', 'security-audit', 'keep-ci-green', 'dry-principle']);
    expect(md).toContain('Test-Driven');
    expect(md).toContain('Security Audit');
    expect(md).toContain('Keep CI Green');
    expect(md).toContain('DRY Principle');
  });

  it('returns "" for only unknown ids', () => {
    expect(buildGuardrailMarkdown(['unknown-a', 'unknown-b'])).toBe('');
  });

  it('contains the ## Active guardrails header when non-empty', () => {
    const md = buildGuardrailMarkdown(['dry-principle']);
    expect(md).toContain('## Active guardrails');
  });

  it('includes the instruction text for enabled guardrails', () => {
    const md = buildGuardrailMarkdown(['security-audit']);
    expect(md).toContain('scan the diff');
  });
});
