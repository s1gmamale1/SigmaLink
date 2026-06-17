import { describe, it, expect } from 'vitest';
import {
  classifyExternal,
  AGENT_PROVIDERS,
  EXTERNAL_ESCALATE_TOOLS,
  PROVIDER_GATED_TOOLS,
  type ExternalVerdict,
} from './authz-external';
import { JORVIS_TOOL_CATALOGUE } from '../assistant/tool-catalogue';

describe('classifyExternal', () => {
  it('kill-switch denies everything, even reads', () => {
    expect(classifyExternal({ toolId: 'read_pane', targetProvider: null, killSwitch: true })).toBe('deny');
    expect(classifyExternal({ toolId: 'list_workspaces', targetProvider: null, killSwitch: true })).toBe('deny');
  });

  it('reads/lists/launch are free', () => {
    for (const id of ['read_pane', 'read_pane_since', 'list_active_sessions', 'list_workspaces', 'wait_for_pane', 'launch_pane', 'open_workspace', 'set_pane_label', 'switch_workspace', 'focus_pane', 'stop_pane', 'split_pane', 'set_pane_minimised', 'set_pane_display_provider']) {
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

  // FAIL-OPEN GUARD (reviewer flag): every externally-exposed tool must have an
  // EXPLICIT, intended verdict here. Adding a tool to the catalogue without
  // classifying it fails this test — so a new mutating tool can NEVER silently
  // default to FREE for external clients. Provider-gated tools are pinned at
  // their null-provider verdict (escalate, since the target is unknown).
  const EXPECTED_VERDICT: Record<string, ExternalVerdict> = {
    launch_pane: 'free',
    close_pane: 'escalate',
    prompt_agent: 'escalate',
    send_keys: 'escalate',
    read_pane: 'free',
    read_pane_since: 'free',
    wait_for_pane: 'free',
    read_files: 'free',
    open_url: 'free',
    create_task: 'free',
    create_swarm: 'free',
    add_agent: 'free',
    create_memory: 'free',
    search_memories: 'free',
    broadcast_to_swarm: 'free',
    roll_call: 'free',
    list_active_sessions: 'free',
    list_swarms: 'free',
    list_workspaces: 'free',
    get_app_state: 'free',
    monitor_pane: 'free',
    browser_navigate: 'escalate',
    browser_snapshot: 'free',
    switch_workspace: 'free',
    focus_pane: 'free',
    set_pane_label: 'free',
    open_workspace: 'free',
    close_workspace: 'escalate',
    stop_pane: 'free',
    split_pane: 'free',
    set_pane_minimised: 'free',
    set_pane_display_provider: 'free',
  };

  it('every externally-exposed catalogue tool has a pinned, intended verdict', () => {
    for (const entry of JORVIS_TOOL_CATALOGUE) {
      const expected = EXPECTED_VERDICT[entry.name];
      expect(
        expected,
        `tool '${entry.name}' has no pinned external verdict — add it to EXPECTED_VERDICT (and to EXTERNAL_ESCALATE_TOOLS in authz-external.ts if it should escalate)`,
      ).toBeDefined();
      expect(classifyExternal({ toolId: entry.name, targetProvider: null, killSwitch: false }), entry.name).toBe(expected);
    }
  });

  it('has no stale pinned verdicts (every pinned tool still exists in the catalogue)', () => {
    const names = new Set(JORVIS_TOOL_CATALOGUE.map((e) => e.name));
    for (const k of Object.keys(EXPECTED_VERDICT)) {
      expect(names.has(k), `EXPECTED_VERDICT has stale tool '${k}' not in the catalogue`).toBe(true);
    }
  });
});
