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
  installCommandFor,
  isImageCapableProvider,
  listDetectable,
  listVisibleProviders,
  paneLabelArgs,
  PANE_LABEL_INSTRUCTION,
  type AgentProviderDefinition,
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

describe('IMAGE_CAPABLE_PROVIDERS (spec 2026-06-10 B)', () => {
  it('claude and codex are image-capable; shell and unknown are not', () => {
    expect(isImageCapableProvider('claude')).toBe(true);
    expect(isImageCapableProvider('codex')).toBe(true);
    expect(isImageCapableProvider('shell')).toBe(false);
    expect(isImageCapableProvider('gemini')).toBe(false); // unverified upstream — OFF until proven
    expect(isImageCapableProvider('')).toBe(false);
  });
});

const fakeDef = (ic?: AgentProviderDefinition['installCommand']): AgentProviderDefinition => ({
  id: 'x',
  name: 'X',
  description: '',
  command: 'x',
  args: [],
  color: '#fff',
  icon: 'cpu',
  installHint: '',
  installCommand: ic,
});

describe('installCommandFor', () => {
  it('win32 NEVER falls back to a posix command (the bash-on-Windows bug)', () => {
    expect(installCommandFor(fakeDef({ linux: ['bash', '-c', 'curl https://x | bash'] }), 'win32')).toBeNull();
  });

  it('win32 returns the win32 command when present', () => {
    expect(installCommandFor(fakeDef({ win32: ['npm', 'i', '-g', 'x'] }), 'win32')).toEqual(['npm', 'i', '-g', 'x']);
  });

  it('darwin falls back to linux when darwin is absent', () => {
    expect(installCommandFor(fakeDef({ linux: ['npm', 'i', '-g', 'x'] }), 'darwin')).toEqual(['npm', 'i', '-g', 'x']);
  });

  it('linux pip installs are wrapped with pipx-first logic', () => {
    expect(installCommandFor(fakeDef({ linux: ['pip', 'install', 'x'] }), 'linux')).toEqual([
      'bash',
      '-lc',
      'set -euo pipefail; if command -v pipx >/dev/null 2>&1; then pipx install x; else python3 -m pip install --user x; fi',
    ]);
  });

  it('no installCommand at all → null', () => {
    expect(installCommandFor(fakeDef(undefined), 'darwin')).toBeNull();
  });
});

describe('AGENT_PROVIDERS registry pins (win32 runnability)', () => {
  it('every win32 installCommand starts with a Windows-runnable binary', () => {
    const allowed = new Set(['npm', 'pip', 'powershell.exe']);
    for (const p of AGENT_PROVIDERS) {
      const win = p.installCommand?.win32;
      if (!win) continue;
      expect(allowed.has(win[0]!), `${p.id}: win32 installCommand starts with '${win[0]}'`).toBe(true);
    }
  });

  it('no provider ships bash on win32', () => {
    for (const p of AGENT_PROVIDERS) {
      expect(p.installCommand?.win32?.[0], `${p.id} win32 cmd[0]`).not.toBe('bash');
    }
  });
});

// Ink resize-duplication mitigation (2026-06-11): SigmaLink-spawned claude
// panes run with the alt-screen renderer so SIGWINCH reprints physically
// cannot pollute scrollback (upstream anthropics/claude-code#49086 — one
// duplicated transcript frame per resize settle in the default inline
// renderer; confirmed in the operator's screen recording, codex panes clean
// through identical drags). Settings that fail validation are silently
// ignored by the CLI, so this entry must stay EXACTLY a valid settings JSON.
describe('claude xterm-mode spawns force the fullscreen TUI renderer (#160, conditional since P1c)', () => {
  it("xtermOnlyArgs carry --settings with tui:'fullscreen' (valid JSON); base args are clean", () => {
    const claude = AGENT_PROVIDERS.find((p) => p.id === 'claude')!;
    const idx = claude.xtermOnlyArgs!.indexOf('--settings');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(claude.xtermOnlyArgs![idx + 1]!)).toEqual({ tui: 'fullscreen' });
    expect(claude.args).not.toContain('--settings');
  });
});

describe('paneLabelArgs (disabled — titling is decoupled from the agent)', () => {
  it('injects nothing for any provider (no agent self-label)', () => {
    expect(paneLabelArgs('claude')).toEqual([]);
    expect(paneLabelArgs('codex')).toEqual([]);
    expect(paneLabelArgs('gemini')).toEqual([]);
    expect(paneLabelArgs('shell')).toEqual([]);
  });
  it('the instruction is empty (no transcript pollution)', () => {
    expect(PANE_LABEL_INSTRUCTION).toBe('');
  });
});
