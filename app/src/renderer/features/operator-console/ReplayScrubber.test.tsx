// @vitest-environment jsdom
//
// UX-3 — ReplayScrubber bookmark prompt. The bookmark label is now collected
// via the themed PromptDialog (was window.prompt). These tests drive the
// `swarm.replay.*` side-band through a `window.sigma.invoke` mock and assert
// the bookmark RPC fires with the entered label on confirm (and not on cancel).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { ReplayScrubber } from './ReplayScrubber';

const SWARM = {
  swarmId: 's1',
  name: 'Mission One',
  missionExcerpt: 'do the thing',
  agentCount: 2,
  messageCount: 10,
  firstAt: 0,
  lastAt: 1,
  status: 'completed',
};

const FRAME = {
  swarmId: 's1',
  swarmName: 'Mission One',
  missionText: 'do the thing',
  frameIdx: 3,
  totalFrames: 9,
  agents: [],
  messages: [],
  counters: { escalations: 0, review: 0, quiet: 0, errors: 0 },
};

const bookmarkMock = vi.fn(async () => undefined);

const invokeMock = vi.fn(async (channel: string) => {
  switch (channel) {
    case 'swarm.replay.list':
      return { ok: true as const, data: [SWARM] };
    case 'swarm.replay.scrub':
      return { ok: true as const, data: FRAME };
    case 'swarm.replay.listBookmarks':
      return { ok: true as const, data: [] };
    case 'swarm.replay.bookmark':
      await bookmarkMock();
      return { ok: true as const, data: undefined };
    default:
      return { ok: true as const, data: undefined };
  }
});

beforeEach(() => {
  Object.defineProperty(window, 'sigma', {
    value: { invoke: invokeMock },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderScrubber() {
  render(<ReplayScrubber workspaceId="ws-1" onFrameChange={vi.fn()} />);
  // Wait for the swarm list + first frame to hydrate (Bookmark button enabled).
  await waitFor(() => {
    const btn = screen.getByRole('button', { name: /bookmark$/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });
}

describe('ReplayScrubber — UX-3 bookmark prompt', () => {
  it('saves a bookmark with the entered label on confirm', async () => {
    await renderScrubber();

    fireEvent.click(screen.getByRole('button', { name: /^bookmark$/i }));

    const dialog = await waitFor(() => screen.getByRole('dialog'));
    const input = within(dialog).getByRole('textbox') as HTMLInputElement;
    // Seeded with the current frame index.
    expect(input.value).toBe('Frame 3');

    fireEvent.change(input, { target: { value: 'milestone' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save bookmark/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'swarm.replay.bookmark',
        expect.objectContaining({ swarmId: 's1', frameIdx: 3, label: 'milestone' }),
      );
    });
  });

  it('does not save when the prompt is cancelled', async () => {
    await renderScrubber();

    fireEvent.click(screen.getByRole('button', { name: /^bookmark$/i }));
    const dialog = await waitFor(() => screen.getByRole('dialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bookmarkMock).not.toHaveBeenCalled();
  });
});
