import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const summarize = vi.fn<(a: { text: string }) => Promise<{ title: string | null }>>();
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { paneTitle: { summarize: (a: { text: string }) => summarize(a) } },
  rpcSilent: { paneTitle: { summarize: (a: { text: string }) => summarize(a) } },
}));

import {
  onPrompt,
  onAgentLabel,
  isPaneTitlePending,
  clearPaneTitle,
  __resetPaneTitleOrchestrator,
  TITLE_WAIT_MS,
} from './pane-title-orchestrator';
import { getAgentLabel, __resetAgentLabels } from './pane-labels';

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
  it('a prompt goes pending immediately with no label yet', () => {
    onPrompt('s1', 'refactor the auth token flow to async refresh');
    expect(isPaneTitlePending('s1')).toBe(true);
    expect(getAgentLabel('s1')).toBeNull();
  });

  it('summarizes after the wait window when no SIGMA::LABEL arrives', async () => {
    onPrompt('s2', 'refactor the auth token flow to async refresh');
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
    expect(summarize).toHaveBeenCalledWith({ text: 'refactor the auth token flow to async refresh' });
    expect(getAgentLabel('s2')).toBe('Auth Refactor');
    expect(isPaneTitlePending('s2')).toBe(false);
  });

  it('a SIGMA::LABEL within the window wins and cancels the summarizer', async () => {
    onPrompt('s3', 'do a thing');
    onAgentLabel('s3', 'Reviewing PR');
    expect(getAgentLabel('s3')).toBe('Reviewing PR');
    expect(isPaneTitlePending('s3')).toBe(false);
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS * 2);
    expect(summarize).not.toHaveBeenCalled();
    expect(getAgentLabel('s3')).toBe('Reviewing PR');
  });

  it('a new prompt supersedes the previous one (only the latest summarizes)', async () => {
    onPrompt('s4', 'first task');
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS / 2); // not yet fired
    onPrompt('s4', 'second task');
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith({ text: 'second task' });
    expect(getAgentLabel('s4')).toBe('Auth Refactor');
  });

  it('falls back to a truncated prompt when the summarizer returns null', async () => {
    summarize.mockResolvedValue({ title: null });
    onPrompt('s5', 'wire up the gateway');
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
    expect(getAgentLabel('s5')).toBe('wire up the gateway'); // summarizePrompt of a short prompt
    expect(isPaneTitlePending('s5')).toBe(false);
  });

  it('clearPaneTitle cancels the pending cycle (no summarizer call)', async () => {
    onPrompt('s6', 'some task');
    clearPaneTitle('s6');
    expect(isPaneTitlePending('s6')).toBe(false);
    await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
    expect(summarize).not.toHaveBeenCalled();
  });
});
