// @vitest-environment jsdom
//
// FEAT-10 — LayoutStep preset save/restore tests.
//
// Coverage:
//   - parseSavedLayout backward-compat: old `{name, preset}` entries parse;
//     new `{name, preset, counts}` entries parse; malformed rows are dropped.
//   - saving a new named layout persists `{name, preset, counts}` to kv.
//   - restoring a chip passes the full layout (incl. counts) to onRestoreLayout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { LayoutStep, parseSavedLayout, RECENT_LAYOUTS_KV_KEY } from './LayoutStep';
import type { SavedLayout } from './PresetRow';

const kvGetMock = vi.fn<(key: string) => Promise<string | null>>(async () => null);
const kvSetMock = vi.fn<(key: string, value: string) => Promise<void>>(async () => undefined);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: (key: string) => kvGetMock(key),
      set: (key: string, value: string) => kvSetMock(key, value),
    },
  },
}));

beforeEach(() => {
  kvGetMock.mockReset().mockResolvedValue(null);
  kvSetMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('parseSavedLayout — backward-compat', () => {
  it('parses a legacy {name, preset} entry (counts undefined)', () => {
    expect(parseSavedLayout({ name: 'Old', preset: 4 })).toEqual({ name: 'Old', preset: 4 });
  });

  it('parses a {name, preset, counts} entry', () => {
    expect(parseSavedLayout({ name: 'New', preset: 4, counts: { claude: 2, gemini: 2 } })).toEqual({
      name: 'New',
      preset: 4,
      counts: { claude: 2, gemini: 2 },
    });
  });

  it('drops invalid counts entries (non-int / non-positive)', () => {
    const out = parseSavedLayout({
      name: 'Mixed',
      preset: 4,
      counts: { claude: 2, bad: -1, frac: 1.5, zero: 0 },
    });
    expect(out).toEqual({ name: 'Mixed', preset: 4, counts: { claude: 2 } });
  });

  it('returns the entry WITHOUT counts when counts has no valid keys', () => {
    expect(parseSavedLayout({ name: 'Empty', preset: 2, counts: { x: 0 } })).toEqual({
      name: 'Empty',
      preset: 2,
    });
  });

  it('rejects malformed rows (missing name / bad preset / not an object)', () => {
    expect(parseSavedLayout({ preset: 4 })).toBeNull();
    expect(parseSavedLayout({ name: 'X', preset: 999 })).toBeNull();
    expect(parseSavedLayout({ name: 'X' })).toBeNull();
    expect(parseSavedLayout(null)).toBeNull();
    expect(parseSavedLayout('nope')).toBeNull();
  });
});

describe('LayoutStep — save / restore', () => {
  it('hydrates saved layouts from kv (incl. a legacy + a new entry)', async () => {
    const persisted: SavedLayout[] = [
      { name: 'Legacy', preset: 2 },
      { name: 'Modern', preset: 4, counts: { claude: 4 } },
    ];
    kvGetMock.mockResolvedValue(JSON.stringify(persisted));
    await act(async () => {
      render(
        <LayoutStep preset={4} onChange={vi.fn()} counts={{}} onRestoreLayout={vi.fn()} />,
      );
    });
    await waitFor(() => {
      expect(screen.getByText('Legacy')).toBeTruthy();
      expect(screen.getByText('Modern')).toBeTruthy();
    });
  });

  it('saving a new layout persists {name, preset, counts} to kv', async () => {
    await act(async () => {
      render(
        <LayoutStep
          preset={4}
          onChange={vi.fn()}
          counts={{ claude: 2, gemini: 2 }}
          onRestoreLayout={vi.fn()}
        />,
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText('NEW'));
    });
    const input = screen.getByLabelText('New layout name');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Pairing' } });
      fireEvent.click(screen.getByText('Save'));
    });
    expect(kvSetMock).toHaveBeenCalledTimes(1);
    const [key, value] = kvSetMock.mock.calls[0];
    expect(key).toBe(RECENT_LAYOUTS_KV_KEY);
    const written = JSON.parse(value) as SavedLayout[];
    expect(written[0]).toEqual({ name: 'Pairing', preset: 4, counts: { claude: 2, gemini: 2 } });
  });

  it('saving with no counts persists {name, preset} only', async () => {
    await act(async () => {
      render(
        <LayoutStep preset={2} onChange={vi.fn()} counts={{}} onRestoreLayout={vi.fn()} />,
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText('NEW'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('New layout name'), { target: { value: 'Bare' } });
      fireEvent.click(screen.getByText('Save'));
    });
    const written = JSON.parse(kvSetMock.mock.calls[0][1]) as SavedLayout[];
    expect(written[0]).toEqual({ name: 'Bare', preset: 2 });
  });

  it('clicking a saved chip forwards the full layout to onRestoreLayout', async () => {
    kvGetMock.mockResolvedValue(
      JSON.stringify([{ name: 'Modern', preset: 4, counts: { claude: 4 } }]),
    );
    const onRestoreLayout = vi.fn();
    await act(async () => {
      render(
        <LayoutStep preset={2} onChange={vi.fn()} counts={{}} onRestoreLayout={onRestoreLayout} />,
      );
    });
    await waitFor(() => screen.getByText('Modern'));
    await act(async () => {
      fireEvent.click(screen.getByText('Modern'));
    });
    expect(onRestoreLayout).toHaveBeenCalledWith({
      name: 'Modern',
      preset: 4,
      counts: { claude: 4 },
    });
  });
});
