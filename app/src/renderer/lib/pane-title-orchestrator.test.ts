import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const summarize = vi.fn<(a: { text: string }) => Promise<{ title: string | null }>>();
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { paneTitle: { summarize: (a: { text: string }) => summarize(a) } },
  rpcSilent: { paneTitle: { summarize: (a: { text: string }) => summarize(a) } },
}));

import {
  onPrompt,
  onAgentLabel,
  clearPaneTitle,
  __resetPaneTitleOrchestrator,
  TITLE_WAIT_MS,
} from './pane-title-orchestrator';
import { getAgentLabel, heuristicTitle, __resetAgentLabels } from './pane-labels';

beforeEach(() => {
  vi.useFakeTimers();
  summarize.mockReset();
  summarize.mockResolvedValue({ title: 'Auth Refactor' });
});
afterEach(() => {
  __resetPaneTitleOrchestrator();
  __resetAgentLabels();
  vi.useRealTimers();
});

describe('pane-title-orchestrator', () => {
  it('sets the instant heuristic floor on a prompt (no waiting, no raw prompt)', () => {
    const p = 'refactor the auth token flow to async refresh';
    onPrompt('s1', p);
    expect(getAgentLabel('s1')).toBe(heuristicTitle(p));
    expect(getAgentLabel('s1')).not.toBe(p);
  });

  it('upgrades to the opencode summary after the grace window', async () => {
    onPrompt('s2', 'refactor the auth token flow');
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
    expect(summarize).toHaveBeenCalledWith({ text: 'refactor the auth token flow' });
    expect(getAgentLabel('s2')).toBe('Auth Refactor');
  });

  it('a SIGMA::LABEL wins instantly and cancels the summarizer', async () => {
    onPrompt('s3', 'do a thing here');
    onAgentLabel('s3', 'Reviewing PR');
    expect(getAgentLabel('s3')).toBe('Reviewing PR');
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS * 2);
    expect(summarize).not.toHaveBeenCalled();
    expect(getAgentLabel('s3')).toBe('Reviewing PR');
  });

  it('keeps the heuristic when the summarizer returns null', async () => {
    summarize.mockResolvedValue({ title: null });
    const p = 'wire up the gateway service';
    onPrompt('s4', p);
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
    expect(getAgentLabel('s4')).toBe(heuristicTitle(p));
  });

  it('a new prompt supersedes the previous one (only the latest summarizes)', async () => {
    onPrompt('s5', 'first task here');
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS / 2);
    onPrompt('s5', 'second different task');
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith({ text: 'second different task' });
  });

  it('ignores a stale SIGMA::LABEL re-fire so it cannot clobber a newer prompt', () => {
    onAgentLabel('s6', 'Old Task');
    expect(getAgentLabel('s6')).toBe('Old Task');
    onPrompt('s6', 'a brand new different task');
    const heur = getAgentLabel('s6');
    expect(heur).toBe(heuristicTitle('a brand new different task'));
    onAgentLabel('s6', 'Old Task'); // label-reader re-fires the buffered sentinel
    expect(getAgentLabel('s6')).toBe(heur); // unchanged — stale ignored
  });

  it('clearPaneTitle cancels the pending summary', async () => {
    onPrompt('s7', 'some task to do');
    clearPaneTitle('s7');
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
    expect(summarize).not.toHaveBeenCalled();
  });
});
