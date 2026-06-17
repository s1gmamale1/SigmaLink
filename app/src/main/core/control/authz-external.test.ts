import { describe, it, expect } from 'vitest';
import {
  classifyExternal,
  AGENT_PROVIDERS,
  EXTERNAL_ESCALATE_TOOLS,
  PROVIDER_GATED_TOOLS,
} from './authz-external';

describe('classifyExternal', () => {
  it('kill-switch denies everything, even reads', () => {
    expect(classifyExternal({ toolId: 'read_pane', targetProvider: null, killSwitch: true })).toBe('deny');
    expect(classifyExternal({ toolId: 'list_workspaces', targetProvider: null, killSwitch: true })).toBe('deny');
  });

  it('reads/lists/launch are free', () => {
    for (const id of ['read_pane', 'read_pane_since', 'list_active_sessions', 'list_workspaces', 'wait_for_pane', 'launch_pane', 'open_workspace', 'set_pane_label', 'switch_workspace', 'focus_pane']) {
      expect(classifyExternal({ toolId: id, targetProvider: null, killSwitch: false }), id).toBe('free');
    }
  });

  it('close_pane / close_workspace / browser_navigate escalate', () => {
    for (const id of ['close_pane', 'close_workspace', 'browser_navigate']) {
      expect(classifyExternal({ toolId: id, targetProvider: null, killSwitch: false }), id).toBe('escalate');
    }
  });

  it('prompt_agent/send_keys are free into an AGENT pane, escalate into a shell', () => {
    expect(classifyExternal({ toolId: 'prompt_agent', targetProvider: 'claude', killSwitch: false })).toBe('free');
    expect(classifyExternal({ toolId: 'send_keys', targetProvider: 'codex', killSwitch: false })).toBe('free');
    expect(classifyExternal({ toolId: 'prompt_agent', targetProvider: 'shell', killSwitch: false })).toBe('escalate');
    expect(classifyExternal({ toolId: 'send_keys', targetProvider: 'bash', killSwitch: false })).toBe('escalate');
  });

  it('unknown/missing provider for a gated tool fails safe (escalate)', () => {
    expect(classifyExternal({ toolId: 'prompt_agent', targetProvider: null, killSwitch: false })).toBe('escalate');
    expect(classifyExternal({ toolId: 'prompt_agent', targetProvider: 'mystery', killSwitch: false })).toBe('escalate');
  });

  it('escalate/gated/agent sets have exactly the expected members', () => {
    expect([...EXTERNAL_ESCALATE_TOOLS].sort()).toEqual(['browser_navigate', 'close_pane', 'close_workspace']);
    expect([...PROVIDER_GATED_TOOLS].sort()).toEqual(['prompt_agent', 'send_keys']);
    expect([...AGENT_PROVIDERS].sort()).toEqual(['claude', 'codex', 'gemini', 'kimi', 'opencode']);
  });
});
