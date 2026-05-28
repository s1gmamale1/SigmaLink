// @vitest-environment jsdom
//
// SF-11 layout regression guard — right-rail flex structure.
//
// Invariants asserted:
//   1. The hydrated RightRail outer wrapper is a flex ROW (three tracks:
//      center-body · splitter · aside).
//   2. The center-body wrapper carries BOTH `min-w-0` AND `flex-1` so it
//      shrinks in a flex-row context when the aside has a fixed pixel width.
//      Without `min-w-0` the child's min-width defaults to `auto` (intrinsic
//      content width), which prevents shrinking and causes horizontal overflow —
//      the root cause of SF-11.
//   3. The aside (right rail panel) is `shrink-0` so it never collapses.
//   4. Before kv hydration resolves, RightRail renders a single full-bleed
//      wrapper (no aside present yet), and that wrapper also has `min-w-0`.
//
// These tests do NOT measure pixels — jsdom has no layout engine. They verify
// the Tailwind class composition which maps 1:1 to the CSS properties that
// control flex sizing behaviour.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

// ─── Polyfills needed by Radix / React in jsdom ──────────────────────────────
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

// ─── rpc mock — kv.get returns null (no persisted width) by default ──────────
// The promise resolves immediately so the hydration effect runs in the same
// `act()` flush, giving us the post-hydration DOM in a single round-trip.
const kvGetMock = vi.fn().mockResolvedValue(null);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: (...args: unknown[]) => kvGetMock(...args),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null) },
  },
}));

// ─── RightRailContext mock — provide a stable context value ──────────────────
vi.mock('./RightRailContext.data', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./RightRailContext.data')>();
  return {
    ...orig,
    useRightRail: () => ({
      activeTab: 'editor' as const,
      setActiveTab: vi.fn(),
    }),
  };
});

// ─── Stub heavy lazy-loaded tab bodies so the test bundle stays minimal ───────
vi.mock('@/renderer/features/browser/BrowserRoom', () => ({
  BrowserRoom: () => <div data-testid="browser-stub" />,
}));
vi.mock('@/renderer/features/skills/SkillsTab', () => ({
  SkillsTab: () => <div data-testid="skills-stub" />,
}));
vi.mock('./SwarmRailTab', () => ({
  SwarmRailTab: () => <div data-testid="swarm-stub" />,
}));
vi.mock('./JorvisTabPlaceholder', () => ({
  JorvisTabPlaceholder: () => <div data-testid="jorvis-stub" />,
}));
vi.mock('./EditorTabPlaceholder', () => ({
  EditorTabPlaceholder: () => <div data-testid="editor-stub" />,
}));
vi.mock('./RightRailTabs', () => ({
  RightRailTabs: ({ bodies }: { bodies: Record<string, React.ReactNode> }) => (
    <div data-testid="rail-tabs">{bodies['editor']}</div>
  ),
}));

// ─── Component under test (imported after all mocks are registered) ───────────
import { RightRail } from './RightRail';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Classes on the element at the given test-id that are flex-related. */
function classesOf(el: Element): string[] {
  return Array.from(el.classList);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  kvGetMock.mockResolvedValue(null);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RightRail — SF-11 layout invariants', () => {
  it('hydrated: outer wrapper is a flex row (not flex-col)', async () => {
    const { container } = render(
      <RightRail>
        <div data-testid="body-slot">content</div>
      </RightRail>,
    );
    // Wait for the kv effect to resolve and flip `hydrated` to true.
    await act(async () => {});

    // The outermost element rendered by RightRail after hydration.
    const outer = container.firstElementChild as HTMLElement;
    expect(outer).not.toBeNull();
    const classes = classesOf(outer);
    expect(classes).toContain('flex');
    // Must be a row (no flex-col class).
    expect(classes).not.toContain('flex-col');
  });

  it('hydrated: center-body wrapper has both flex-1 AND min-w-0 (SF-11 fix)', async () => {
    const { container } = render(
      <RightRail>
        <div data-testid="body-slot">content</div>
      </RightRail>,
    );
    await act(async () => {});

    const outer = container.firstElementChild as HTMLElement;
    // The center-body wrapper is the first child of the outer flex row.
    const centerWrapper = outer?.firstElementChild as HTMLElement | null;
    expect(centerWrapper).not.toBeNull();

    const classes = classesOf(centerWrapper!);
    // flex-1: center column fills remaining space.
    expect(classes).toContain('flex-1');
    // min-w-0: CRITICAL — allows the column to shrink below intrinsic content
    // width so the fixed-pixel aside fits without causing overflow (SF-11).
    expect(classes).toContain('min-w-0');
  });

  it('hydrated: aside (rail panel) is shrink-0 so it never collapses', async () => {
    const { container } = render(
      <RightRail>
        <div data-testid="body-slot">content</div>
      </RightRail>,
    );
    await act(async () => {});

    // The aside is the last child of the outer flex row (center · splitter · aside).
    const outer = container.firstElementChild as HTMLElement;
    const aside = outer?.querySelector('aside') as HTMLElement | null;
    expect(aside).not.toBeNull();
    expect(classesOf(aside!)).toContain('shrink-0');
    expect(aside!.getAttribute('aria-label')).toBe('Right rail');
  });

  it('hydrated: three direct flex children (center · splitter · aside)', async () => {
    const { container } = render(
      <RightRail>
        <div data-testid="body-slot">content</div>
      </RightRail>,
    );
    await act(async () => {});

    const outer = container.firstElementChild as HTMLElement;
    expect(outer?.children.length).toBe(3);
  });

  it('pre-hydration: renders a single full-bleed wrapper with min-w-0 (no aside)', async () => {
    // Make kv.get hang indefinitely so hydration never completes during this test.
    kvGetMock.mockReturnValue(new Promise(() => {}));

    const { container } = render(
      <RightRail>
        <div data-testid="body-slot">content</div>
      </RightRail>,
    );
    // Do NOT await act so the async effect never resolves.

    const outer = container.firstElementChild as HTMLElement;
    expect(outer).not.toBeNull();

    // Pre-hydration: no <aside> rendered, just the single wrapper.
    expect(outer?.querySelector('aside')).toBeNull();

    const classes = classesOf(outer!);
    // The pre-hydration wrapper must also have min-w-0 so it doesn't overflow
    // in the parent flex context while the kv read is in-flight.
    expect(classes).toContain('min-w-0');
    expect(classes).toContain('flex-1');
  });
});
