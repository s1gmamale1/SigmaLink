import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeGuardrailBlock } from './guardrail-block';

describe('writeGuardrailBlock', () => {
  it('writes a guardrail block into a fresh CLAUDE.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-gb-'));
    await writeGuardrailBlock(dir, ['test-driven']);
    const txt = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(txt).toContain('sigmalink-guardrails:start');
    expect(txt).toContain('sigmalink-guardrails:end');
    expect(txt).toContain('Test-Driven');
  });

  it('writing twice with same ids is idempotent (one block)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-gb-'));
    writeFileSync(join(dir, 'CLAUDE.md'), '# Existing\n');
    await writeGuardrailBlock(dir, ['test-driven', 'dry-principle']);
    await writeGuardrailBlock(dir, ['test-driven', 'dry-principle']);
    const txt = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(txt.match(/sigmalink-guardrails:start/g)?.length).toBe(1);
  });

  it('preserves prose outside markers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-gb-'));
    writeFileSync(join(dir, 'CLAUDE.md'), '# My project notes\n\nSome prose.\n');
    await writeGuardrailBlock(dir, ['security-audit']);
    const txt = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(txt).toContain('# My project notes');
    expect(txt).toContain('Some prose.');
    expect(txt).toContain('Security Audit');
  });

  it('updating ids replaces the block content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-gb-'));
    await writeGuardrailBlock(dir, ['test-driven']);
    await writeGuardrailBlock(dir, ['dry-principle']);
    const txt = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(txt).toContain('DRY Principle');
    expect(txt).not.toContain('Test-Driven');
    expect(txt.match(/sigmalink-guardrails:start/g)?.length).toBe(1);
  });

  it('empty ids writes a block with markers but no guardrail content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-gb-'));
    writeFileSync(join(dir, 'CLAUDE.md'), '# Existing\n');
    await writeGuardrailBlock(dir, []);
    const txt = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    // Markers present but no Active guardrails heading
    expect(txt).toContain('sigmalink-guardrails:start');
    expect(txt).toContain('sigmalink-guardrails:end');
    expect(txt).not.toContain('## Active guardrails');
  });

  it('creates CLAUDE.md if it does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-gb-'));
    // No CLAUDE.md pre-created
    await writeGuardrailBlock(dir, ['keep-ci-green']);
    const txt = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(txt).toContain('Keep CI Green');
  });
});
