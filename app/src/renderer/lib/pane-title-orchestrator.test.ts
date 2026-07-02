import { afterEach, describe, expect, it, vi } from 'vitest';

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
} from './pane-title-orchestrator';
import { getAgentLabel, __resetAgentLabels } from './pane-labels';

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  __resetPaneTitleOrchestrator();
  __resetAgentLabels();
  summarize.mockReset();
});

describe('pane-title-orchestrator', () => {
  it('titles via the summarizer — no heuristic, name-only until it lands', async () => {
    summarize.mockResolvedValue({ title: 'ecommerce website development' });
    onPrompt('s1', 'build a robust ecommerce website with cart');
    expect(getAgentLabel('s1')).toBeNull(); // name-only until the title lands
    await flush();
    expect(summarize).toHaveBeenCalledWith({ text: 'build a robust ecommerce website with cart' });
    expect(getAgentLabel('s1')).toBe('ecommerce website development');
  });

  it('keeps the name (no bs) when the summarizer returns null', async () => {
    summarize.mockResolvedValue({ title: null });
    onPrompt('s2', 'some task here');
    await flush();
    expect(getAgentLabel('s2')).toBeNull();
  });

  it('latest prompt wins — a superseded slow summary cannot clobber it', async () => {
    summarize.mockResolvedValueOnce({ title: 'OLD' }).mockResolvedValueOnce({ title: 'NEW' });
    onPrompt('s3', 'first prompt');
    onPrompt('s3', 'second prompt');
    await flush();
    expect(summarize).toHaveBeenNthCalledWith(1, { text: 'first prompt' });
    expect(summarize).toHaveBeenNthCalledWith(2, { text: 'second prompt' });
    expect(getAgentLabel('s3')).toBe('NEW');
  });

  it('onAgentLabel (voluntary SIGMA::LABEL) overrides + invalidates in-flight summary', async () => {
    summarize.mockResolvedValue({ title: 'summary title' });
    onPrompt('s4', 'do the thing');
    onAgentLabel('s4', 'Agent Title');
    expect(getAgentLabel('s4')).toBe('Agent Title');
    await flush();
    expect(getAgentLabel('s4')).toBe('Agent Title'); // summary dropped (superseded)
  });

  it('clearPaneTitle drops state so a late summary is ignored', async () => {
    let resolve!: (v: { title: string | null }) => void;
    summarize.mockReturnValue(new Promise((r) => { resolve = r; }));
    onPrompt('s5', 'task');
    clearPaneTitle('s5');
    resolve({ title: 'late' });
    await flush();
    expect(getAgentLabel('s5')).toBeNull();
  });

  it('ignores blank prompts', () => {
    onPrompt('s6', '   ');
    expect(summarize).not.toHaveBeenCalled();
  });
});
