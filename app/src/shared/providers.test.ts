// R-2 — provider registry coverage. Most of the registry is plain data, so a
// regression here (a dropped field, a mis-placed `shell` sentinel, a provider
// that silently stops being visible/detectable) is best caught by pinning the
// invariants the launcher + UI depend on. This file deliberately asserts the
// *contract* of the cursor entry that the rest of the wiring relies on, plus
// the general listVisibleProviders / listDetectable filters.

import { describe, it, expect } from 'vitest';
import {
  AGENT_PROVIDERS,
  findProvider,
  listDetectable,
  listVisibleProviders,
} from './providers';

describe('AGENT_PROVIDERS registry', () => {
  it('exposes the cursor provider with the verified spawn contract', () => {
    const cursor = findProvider('cursor');
    expect(cursor).toBeDefined();
    expect(cursor!.name).toBe('Cursor');
    expect(cursor!.command).toBe('cursor-agent');
    // Oneshot mirrors claude exactly: -p <prompt>.
    expect(cursor!.oneshotArgs).toEqual(['-p', '{prompt}']);
    // --trust is the always-on non-interactive floor for headless (-p) panes.
    expect(cursor!.args).toEqual(['--trust']);
    // --force (alias --yolo) is the conditional full-approval escalation.
    expect(cursor!.autoApproveFlag).toBe('--force');
    // resumeArgs documents the resume flag; runtime argv is built by
    // buildResumeArgs (covered in resume-launcher.test.ts).
    expect(cursor!.resumeArgs).toEqual(['--resume']);
    expect(cursor!.altCommands).toContain('cursor-agent.cmd');
    expect(cursor!.detectable).toBe(true);
  });

  it('places cursor among the real providers, NOT after the shell sentinel', () => {
    const ids = AGENT_PROVIDERS.map((p) => p.id);
    const cursorIdx = ids.indexOf('cursor');
    const shellIdx = ids.indexOf('shell');
    expect(cursorIdx).toBeGreaterThanOrEqual(0);
    expect(shellIdx).toBeGreaterThanOrEqual(0);
    expect(cursorIdx).toBeLessThan(shellIdx);
  });

  it('cursor is not flagged comingSoon/legacy (it ships a full pane)', () => {
    const cursor = findProvider('cursor')!;
    expect(cursor.comingSoon).toBeFalsy();
    expect(cursor.legacy).toBeFalsy();
    expect(cursor.fallbackProviderId).toBeUndefined();
  });
});

describe('listVisibleProviders', () => {
  it('includes cursor and excludes the shell sentinel', () => {
    const visible = listVisibleProviders(false).map((p) => p.id);
    expect(visible).toContain('cursor');
    expect(visible).not.toContain('shell');
  });

  it('lists cursor alongside the other shipped CLIs', () => {
    const visible = listVisibleProviders(false).map((p) => p.id);
    for (const id of ['claude', 'codex', 'gemini', 'kimi', 'opencode', 'cursor']) {
      expect(visible).toContain(id);
    }
  });
});

describe('listDetectable', () => {
  it('includes cursor (detectable, has a command)', () => {
    const detectable = listDetectable().map((p) => p.id);
    expect(detectable).toContain('cursor');
    // shell has an empty command → never detectable
    expect(detectable).not.toContain('shell');
  });
});
