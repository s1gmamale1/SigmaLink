// @vitest-environment jsdom
//
// FEAT-4 — coverage for usePromptCard.
//
// Scope:
//   • disabled → no subscription, no prompt surfaced
//   • a valid SIGMA::PROMPT line (incl. one split across coalesced chunks) →
//     surfaces the prompt
//   • non-PROMPT / malformed lines are ignored
//   • answer() writes "<joined>\n" to the pane stdin and clears the prompt
//   • dismiss() clears without writing
//   • unsubscribe + prompt-clear on unmount / disable

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ---- mocks ---------------------------------------------------------------

const ptyWriteMock = vi.fn().mockResolvedValue(undefined);

// A controllable fake of the pty-data bus: tests push chunks into the active
// subscriber for a session.
type Listener = (p: { sessionId: string; data: string }) => void;
const subscribers = new Map<string, Set<Listener>>();
const unsubscribeSpy = vi.fn();

vi.mock('@/renderer/lib/pty-data-bus', () => ({
  subscribePtyData: (sessionId: string, fn: Listener) => {
    let set = subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      subscribers.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      unsubscribeSpy(sessionId);
      subscribers.get(sessionId)?.delete(fn);
    };
  },
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    pty: {
      write: (...args: unknown[]) => ptyWriteMock(...args),
    },
  },
}));

function emit(sessionId: string, data: string): void {
  subscribers.get(sessionId)?.forEach((fn) => fn({ sessionId, data }));
}

async function load() {
  const mod = await import('./use-prompt-card');
  return mod.usePromptCard;
}

const VALID_SINGLE =
  'SIGMA::PROMPT {"question":"Pick one","type":"single","choices":["red","blue"]}\n';
const VALID_MULTI =
  'SIGMA::PROMPT {"question":"Pick many","type":"multi","choices":["a","b","c"]}\n';

beforeEach(() => {
  ptyWriteMock.mockReset().mockResolvedValue(undefined);
  unsubscribeSpy.mockReset();
  subscribers.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('usePromptCard — opt-in gating', () => {
  it('does not subscribe and surfaces no prompt when disabled', async () => {
    const usePromptCard = await load();
    const { result } = renderHook(() => usePromptCard('s1', false));
    expect(subscribers.get('s1')).toBeUndefined();
    act(() => emit('s1', VALID_SINGLE));
    expect(result.current.prompt).toBeNull();
  });
});

describe('usePromptCard — parsing', () => {
  it('surfaces a valid single-select prompt', async () => {
    const usePromptCard = await load();
    const { result } = renderHook(() => usePromptCard('s1', true));
    act(() => emit('s1', VALID_SINGLE));
    expect(result.current.prompt).toMatchObject({
      question: 'Pick one',
      type: 'single',
      choices: ['red', 'blue'],
    });
  });

  it('re-buffers a prompt split across coalesced chunks', async () => {
    const usePromptCard = await load();
    const { result } = renderHook(() => usePromptCard('s1', true));
    // Split mid-line — the buffer must hold the partial until the newline.
    act(() => emit('s1', 'SIGMA::PROMPT {"question":"Q","type":"single",'));
    expect(result.current.prompt).toBeNull();
    act(() => emit('s1', '"choices":["yes","no"]}\n'));
    expect(result.current.prompt).toMatchObject({ choices: ['yes', 'no'] });
  });

  it('ignores non-PROMPT and malformed lines', async () => {
    const usePromptCard = await load();
    const { result } = renderHook(() => usePromptCard('s1', true));
    act(() => emit('s1', 'SIGMA::SAY {"body":"hi"}\n'));
    act(() => emit('s1', 'just regular terminal output\n'));
    act(() => emit('s1', 'SIGMA::PROMPT {"question":"","type":"single","choices":["a"]}\n'));
    act(() => emit('s1', 'SIGMA::PROMPT {bad json}\n'));
    expect(result.current.prompt).toBeNull();
  });
});

describe('usePromptCard — answer & dismiss', () => {
  it('writes the joined answer + newline to stdin and clears the prompt', async () => {
    const usePromptCard = await load();
    const { result } = renderHook(() => usePromptCard('s1', true));
    act(() => emit('s1', VALID_MULTI));
    expect(result.current.prompt).not.toBeNull();
    act(() => result.current.answer(['a', 'c']));
    expect(ptyWriteMock).toHaveBeenCalledWith('s1', 'a, c\n');
    expect(result.current.prompt).toBeNull();
  });

  it('writes a single choice followed by a newline', async () => {
    const usePromptCard = await load();
    const { result } = renderHook(() => usePromptCard('s1', true));
    act(() => emit('s1', VALID_SINGLE));
    act(() => result.current.answer(['blue']));
    expect(ptyWriteMock).toHaveBeenCalledWith('s1', 'blue\n');
  });

  it('C1 — strips control/newline chars from the chosen answer (no stdin injection)', async () => {
    const usePromptCard = await load();
    const { result } = renderHook(() => usePromptCard('s1', true));
    act(() => emit('s1', VALID_SINGLE));
    // A hostile choice that smuggles a second command line.
    act(() => result.current.answer(['yes\nrm -rf ~']));
    const written = ptyWriteMock.mock.calls[0][1] as string;
    // Exactly ONE trailing newline; the embedded \n is collapsed to a space.
    expect(written.endsWith('\n')).toBe(true);
    expect(written.slice(0, -1).includes('\n')).toBe(false);
    expect(written).toBe('yes rm -rf ~\n');
  });

  it('dismiss clears the prompt without writing', async () => {
    const usePromptCard = await load();
    const { result } = renderHook(() => usePromptCard('s1', true));
    act(() => emit('s1', VALID_SINGLE));
    act(() => result.current.dismiss());
    expect(result.current.prompt).toBeNull();
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });
});

describe('usePromptCard — lifecycle', () => {
  it('unsubscribes and clears the prompt on unmount', async () => {
    const usePromptCard = await load();
    const { result, unmount } = renderHook(() => usePromptCard('s1', true));
    act(() => emit('s1', VALID_SINGLE));
    expect(result.current.prompt).not.toBeNull();
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalledWith('s1');
  });

  it('clears the prompt when the feature is turned off', async () => {
    const usePromptCard = await load();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePromptCard('s1', enabled),
      { initialProps: { enabled: true } },
    );
    act(() => emit('s1', VALID_SINGLE));
    expect(result.current.prompt).not.toBeNull();
    rerender({ enabled: false });
    expect(result.current.prompt).toBeNull();
    expect(unsubscribeSpy).toHaveBeenCalledWith('s1');
  });
});
