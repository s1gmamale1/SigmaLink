// @vitest-environment jsdom
//
// v1.7.1 W-5 Skills Phase 2 — RTL tests for SkillsTab drag + SkillBindingChip.
//
// Verifies:
//   1. SkillsTab renders skill rows as draggable list items.
//   2. dragstart on a skill row sets the application/sigmalink-skill MIME payload
//      with { kind: 'skill', name, source }.
//   3. A drop target that accepts application/sigmalink-skill calls onSkillDrop
//      with the correct name + source (simulates PaneShell's handleDrop).
//   4. SkillBindingChip renders with skill name and dismiss button.
//   5. SkillBindingChip dismiss button calls onDetach with the binding id.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SkillsTab, SKILL_DRAG_MIME, type SkillDragPayload } from './SkillsTab';
import { SkillBindingChip, type SkillBinding } from './SkillBindingChip';

// jsdom does not implement DragEvent — polyfill it so tests that manually
// construct a DragEvent (to attach a custom dataTransfer mock) work correctly.
if (typeof globalThis.DragEvent === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).DragEvent = class DragEvent extends MouseEvent {
    dataTransfer: DataTransfer | null;
    constructor(type: string, init: DragEventInit = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  };
}

// ---- mocks -----------------------------------------------------------------

const listInstalledMock = vi.fn<() => Promise<Array<{ name: string; description: string; source: 'superpowers' | 'ruflo' | 'custom' }>>>();
const skillsListMock = vi.fn<() => Promise<{ skills: Array<{ id: string; name: string; description: string; contentHash: string; managedPath: string; installedAt: number }>; states: Array<{ skillId: string; providerId: string; enabled: boolean }> }>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    skills: {
      listInstalled: () => listInstalledMock(),
      list: () => skillsListMock(),
    },
  },
}));

// navigator.clipboard is not in jsdom by default.
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  skillsListMock.mockReset();
});

// ---- helpers ---------------------------------------------------------------

const SAMPLE_SKILLS = [
  { name: 'review-helper', description: 'Helps with code review', source: 'superpowers' as const },
  { name: 'debug-mode', description: 'Assists debugging', source: 'ruflo' as const },
];

function renderSkillsTab(
  skillsListResult: { skills: Array<{ id: string; name: string; description: string; contentHash: string; managedPath: string; installedAt: number }>; states: Array<{ skillId: string; providerId: string; enabled: boolean }> } = { skills: [], states: [] },
) {
  listInstalledMock.mockResolvedValue(SAMPLE_SKILLS);
  skillsListMock.mockResolvedValue(skillsListResult);
  return render(<SkillsTab />);
}

// ---- tests -----------------------------------------------------------------

describe('SkillsTab Phase 2 — draggable rows', () => {
  it('renders skill rows after loading', async () => {
    renderSkillsTab();
    await waitFor(() => {
      expect(screen.getByText('review-helper')).toBeDefined();
      expect(screen.getByText('debug-mode')).toBeDefined();
    });
  });

  it('skill rows have draggable attribute', async () => {
    renderSkillsTab();
    await waitFor(() => {
      expect(screen.getByText('review-helper')).toBeDefined();
    });

    // The <li> elements wrapping each skill should be draggable.
    const listItems = document.querySelectorAll('li[draggable="true"]');
    expect(listItems.length).toBeGreaterThanOrEqual(2);
  });

  it('dragstart sets application/sigmalink-skill MIME payload', async () => {
    renderSkillsTab();
    await waitFor(() => {
      expect(screen.getByText('review-helper')).toBeDefined();
    });

    // Find the draggable li for review-helper.
    const draggableItems = document.querySelectorAll('li[draggable="true"]');
    const reviewItem = Array.from(draggableItems).find((el) =>
      el.textContent?.includes('review-helper'),
    );
    expect(reviewItem).toBeDefined();

    // Track what gets set on dataTransfer.
    const setDataMock = vi.fn();
    const dragStartEvent = new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dragStartEvent, 'dataTransfer', {
      value: {
        setData: setDataMock,
        effectAllowed: '',
        types: [],
      },
    });

    reviewItem!.dispatchEvent(dragStartEvent);

    expect(setDataMock).toHaveBeenCalledWith(
      SKILL_DRAG_MIME,
      expect.stringContaining('"kind":"skill"'),
    );
    expect(setDataMock).toHaveBeenCalledWith(
      SKILL_DRAG_MIME,
      expect.stringContaining('"name":"review-helper"'),
    );
    expect(setDataMock).toHaveBeenCalledWith(
      SKILL_DRAG_MIME,
      expect.stringContaining('"source":"superpowers"'),
    );
  });

  it('dragstart payload parses to correct SkillDragPayload shape', async () => {
    renderSkillsTab();
    await waitFor(() => {
      expect(screen.getByText('debug-mode')).toBeDefined();
    });

    const draggableItems = document.querySelectorAll('li[draggable="true"]');
    const debugItem = Array.from(draggableItems).find((el) =>
      el.textContent?.includes('debug-mode'),
    );
    expect(debugItem).toBeDefined();

    let capturedPayload: SkillDragPayload | null = null;
    const setDataMock = vi.fn((_, value: string) => {
      capturedPayload = JSON.parse(value) as SkillDragPayload;
    });
    const dragStartEvent = new DragEvent('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragStartEvent, 'dataTransfer', {
      value: { setData: setDataMock, effectAllowed: '', types: [] },
    });

    debugItem!.dispatchEvent(dragStartEvent);

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!.kind).toBe('skill');
    expect(capturedPayload!.name).toBe('debug-mode');
    expect(capturedPayload!.source).toBe('ruflo');
  });
});

describe('SkillsTab Phase 2 — drop target simulation', () => {
  it('a drop target accepting application/sigmalink-skill can parse the payload and call onSkillDrop', () => {
    // Render a minimal drop-target element and simulate the drop handler
    // (same logic as PaneShell.handleDrop for the skill branch).
    const onSkillDrop = vi.fn();

    function DropTargetFixture() {
      function handleDrop(e: React.DragEvent<HTMLDivElement>) {
        e.preventDefault();
        const raw = e.dataTransfer.getData(SKILL_DRAG_MIME);
        if (raw) {
          try {
            const payload = JSON.parse(raw) as SkillDragPayload;
            if (payload.kind === 'skill' && payload.name) {
              onSkillDrop(payload.name, payload.source);
            }
          } catch {
            /* ignore */
          }
        }
      }
      return <div data-testid="drop-target" onDrop={handleDrop} />;
    }

    render(<DropTargetFixture />);
    const target = screen.getByTestId('drop-target');

    const payload: SkillDragPayload = { kind: 'skill', name: 'review-helper', source: 'superpowers' };
    const dropEvent = createDropEvent(SKILL_DRAG_MIME, JSON.stringify(payload));
    fireEvent.drop(target, dropEvent);

    expect(onSkillDrop).toHaveBeenCalledOnce();
    expect(onSkillDrop).toHaveBeenCalledWith('review-helper', 'superpowers');
  });
});

describe('SkillBindingChip', () => {
  it('renders the skill name', () => {
    const binding: SkillBinding = {
      id: 'bind-1',
      skillName: 'review-helper',
      skillSource: 'superpowers',
      paneSessionId: 'pane-1',
    };
    render(<SkillBindingChip binding={binding} onDetach={vi.fn()} />);
    expect(screen.getByText('review-helper')).toBeDefined();
  });

  it('calls onDetach with the binding id when dismiss is clicked', () => {
    const onDetach = vi.fn();
    const binding: SkillBinding = {
      id: 'bind-42',
      skillName: 'debug-mode',
      skillSource: 'ruflo',
      paneSessionId: null,
    };
    render(<SkillBindingChip binding={binding} onDetach={onDetach} />);

    const dismissBtn = screen.getByTestId('skill-binding-chip-dismiss');
    fireEvent.click(dismissBtn);

    expect(onDetach).toHaveBeenCalledOnce();
    expect(onDetach).toHaveBeenCalledWith('bind-42');
  });

  it('has the correct data attributes', () => {
    const binding: SkillBinding = {
      id: 'bind-99',
      skillName: 'brainstorm',
      skillSource: 'superpowers',
      paneSessionId: null,
    };
    render(<SkillBindingChip binding={binding} onDetach={vi.fn()} />);

    const chip = screen.getByTestId('skill-binding-chip');
    expect(chip.getAttribute('data-binding-id')).toBe('bind-99');
    expect(chip.getAttribute('data-skill-name')).toBe('brainstorm');
  });
});

// ---- Phase 3 — provider compat badges ----------------------------------------

describe('SkillsTab Phase 3 — provider compat badges', () => {
  const MANAGED_SKILLS = [
    { id: 'skill-1', name: 'review-helper', description: 'Helps with code review', contentHash: 'abc', managedPath: '/path/review-helper', installedAt: 0 },
    { id: 'skill-2', name: 'debug-mode', description: 'Assists debugging', contentHash: 'def', managedPath: '/path/debug-mode', installedAt: 0 },
  ];

  const STATES_ALL_ENABLED = [
    { skillId: 'skill-1', providerId: 'claude', enabled: true },
    { skillId: 'skill-1', providerId: 'codex', enabled: true },
    { skillId: 'skill-1', providerId: 'gemini', enabled: true },
    { skillId: 'skill-2', providerId: 'claude', enabled: true },
    { skillId: 'skill-2', providerId: 'codex', enabled: false },
    { skillId: 'skill-2', providerId: 'gemini', enabled: false },
  ];

  it('shows compat badges for enabled providers when skill row is expanded', async () => {
    renderSkillsTab({ skills: MANAGED_SKILLS, states: STATES_ALL_ENABLED });

    // Wait for skills to load.
    await waitFor(() => {
      expect(screen.getByText('review-helper')).toBeDefined();
    });

    // Click to expand the review-helper row.
    const expandButton = screen.getByRole('button', { name: /review-helper/i });
    fireEvent.click(expandButton);

    // After expansion, compat badges should be visible.
    await waitFor(() => {
      expect(screen.getByTestId('skill-compat-badges-review-helper')).toBeDefined();
    });

    // All three providers are enabled for review-helper.
    expect(screen.getByTestId('skill-compat-badge-claude')).toBeDefined();
    expect(screen.getByTestId('skill-compat-badge-codex')).toBeDefined();
    expect(screen.getByTestId('skill-compat-badge-gemini')).toBeDefined();
  });

  it('shows only claude badge for debug-mode (only claude enabled)', async () => {
    renderSkillsTab({ skills: MANAGED_SKILLS, states: STATES_ALL_ENABLED });

    await waitFor(() => {
      expect(screen.getByText('debug-mode')).toBeDefined();
    });

    // Expand debug-mode.
    const buttons = screen.getAllByRole('button');
    const debugButton = buttons.find((b) => b.textContent?.includes('debug-mode'));
    expect(debugButton).toBeDefined();
    fireEvent.click(debugButton!);

    await waitFor(() => {
      expect(screen.getByTestId('skill-compat-badges-debug-mode')).toBeDefined();
    });

    expect(screen.getByTestId('skill-compat-badge-claude')).toBeDefined();
    // codex and gemini are disabled for debug-mode.
    expect(screen.queryByTestId('skill-compat-badge-codex')).toBeNull();
    expect(screen.queryByTestId('skill-compat-badge-gemini')).toBeNull();
  });

  it('shows no compat badges for skills not in the managed store', async () => {
    // Only provide managed data for review-helper; debug-mode is absent from managed store.
    renderSkillsTab({
      skills: [MANAGED_SKILLS[0]],
      states: [{ skillId: 'skill-1', providerId: 'claude', enabled: true }],
    });

    await waitFor(() => {
      expect(screen.getByText('debug-mode')).toBeDefined();
    });

    // Expand debug-mode.
    const buttons = screen.getAllByRole('button');
    const debugButton = buttons.find((b) => b.textContent?.includes('debug-mode'));
    expect(debugButton).toBeDefined();
    fireEvent.click(debugButton!);

    // No compat badges should appear for debug-mode.
    await waitFor(() => {
      // The expanded panel should be visible (description renders).
      expect(screen.getAllByText('Assists debugging').length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId('skill-compat-badges-debug-mode')).toBeNull();
  });

  it('renders without compat badges when skills.list() fails', async () => {
    listInstalledMock.mockResolvedValue(SAMPLE_SKILLS);
    skillsListMock.mockRejectedValue(new Error('network error'));
    render(<SkillsTab />);

    // Skills list should still load from listInstalled.
    await waitFor(() => {
      expect(screen.getByText('review-helper')).toBeDefined();
    });

    // Expand review-helper; no compat badges since list() failed.
    const expandButton = screen.getByRole('button', { name: /review-helper/i });
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(screen.getAllByText('Helps with code review').length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId('skill-compat-badges-review-helper')).toBeNull();
  });
});

// ---- utilities -------------------------------------------------------------

/**
 * Creates a synthetic drop event with the given MIME data.
 * jsdom's DragEvent doesn't support dataTransfer.getData in fireEvent, so we
 * construct the dataTransfer manually.
 */
function createDropEvent(
  mimeType: string,
  data: string,
): Partial<DragEvent> & { dataTransfer: DataTransfer } {
  const dataTransferMap = new Map<string, string>([[mimeType, data]]);
  return {
    dataTransfer: {
      getData: (key: string) => dataTransferMap.get(key) ?? '',
      setData: () => undefined,
      types: [mimeType],
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      dropEffect: 'copy',
      effectAllowed: 'all',
      clearData: () => undefined,
    } as unknown as DataTransfer,
  };
}
