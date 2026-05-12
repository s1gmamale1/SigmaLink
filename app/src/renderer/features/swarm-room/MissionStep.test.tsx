// @vitest-environment jsdom
//
// BUG-C4 regression coverage. Verifies that the voice-capture cleanup in
// MissionStep stops the live recognizer on unmount even though the handle
// was set AFTER mount. Before the fix the cleanup closed over the initial
// `null` handle and let the recognizer run forever.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Dispatch } from 'react';
import type { Action, AppState } from '@/renderer/app/state.types';
import { initialAppState } from '@/renderer/app/state.types';
import { AppDispatchContext, AppStateContext } from '@/renderer/app/state.hook';

// ─── rpc mock ───────────────────────────────────────────────────────────────
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    workspaces: { list: vi.fn().mockResolvedValue([]) },
    fs: { exists: vi.fn().mockResolvedValue(false) },
  },
}));

// ─── voice mock ────────────────────────────────────────────────────────────
const stopSpy = vi.fn();
const startCaptureMock = vi.fn(async (opts: unknown) => {
  void opts;
  return { stop: stopSpy };
});
const isVoiceSupportedMock = vi.fn(() => true);

vi.mock('@/renderer/lib/voice', () => {
  class VoiceBusyError extends Error {
    constructor() {
      super('voice-busy');
      this.name = 'VoiceBusyError';
    }
  }
  return {
    isVoiceSupported: () => isVoiceSupportedMock(),
    startCapture: (opts: unknown) => startCaptureMock(opts),
    VoiceBusyError,
  };
});

// ─── lucide-react mock — render simple icons (jsdom-friendly) ──────────────
vi.mock('lucide-react', () => ({
  Mic: () => null,
  MicOff: () => null,
}));

// ─── sonner mock ───────────────────────────────────────────────────────────
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { MissionStep } from './MissionStep';

function makeState(): AppState {
  return { ...initialAppState, ready: true };
}

function wrapper(state: AppState, dispatch: Dispatch<Action>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppDispatchContext.Provider value={dispatch}>
        <AppStateContext.Provider value={{ state, dispatch }}>{children}</AppStateContext.Provider>
      </AppDispatchContext.Provider>
    );
  };
}

beforeEach(() => {
  stopSpy.mockReset();
  startCaptureMock.mockReset();
  startCaptureMock.mockImplementation(async () => ({ stop: stopSpy }));
  isVoiceSupportedMock.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MissionStep — BUG-C4 voice cleanup on unmount', () => {
  it('stops the live voice handle when the component unmounts after capture started', async () => {
    const state = makeState();
    const dispatch = vi.fn();
    const Wrapper = wrapper(state, dispatch);

    const { getByTestId, unmount } = render(
      <Wrapper>
        <MissionStep mission="" onMissionChange={vi.fn()} />
      </Wrapper>,
    );

    // Start voice capture — this is where the bug bit before the fix: the
    // cleanup closed over the initial null handle and never called stop().
    const mic = getByTestId('mission-mic');
    await act(async () => {
      fireEvent.click(mic);
    });

    await waitFor(() => {
      expect(startCaptureMock).toHaveBeenCalledTimes(1);
    });

    // Sanity: stop has not been called yet — the recognizer is live.
    expect(stopSpy).not.toHaveBeenCalled();

    // Unmount mid-capture; the cleanup MUST stop the live recognizer.
    unmount();

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('does not call stop() on unmount when voice was never started', async () => {
    const state = makeState();
    const dispatch = vi.fn();
    const Wrapper = wrapper(state, dispatch);

    const { unmount } = render(
      <Wrapper>
        <MissionStep mission="" onMissionChange={vi.fn()} />
      </Wrapper>,
    );

    unmount();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startCaptureMock).not.toHaveBeenCalled();
  });
});
