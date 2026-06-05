// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WorkspaceTintSection } from './WorkspaceTintSection';

afterEach(() => cleanup());

// mock workspace-ui-kv write + the tint apply
const writes: Array<[string, string, string]> = [];
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  writeWorkspaceUi: (ws: string, panel: string, val: string) => { writes.push([ws, panel, val]); },
  readWorkspaceUi: async () => null,
}));

describe('WorkspaceTintSection', () => {
  beforeEach(() => { writes.length = 0; });
  it('renders nothing when no workspace is active', () => {
    const { container } = render(<WorkspaceTintSection activeWorkspaceId={null} />);
    expect(container.firstChild).toBeNull();
  });
  it('writes ui.<ws>.tint with the picked accent when active', () => {
    render(<WorkspaceTintSection activeWorkspaceId="ws1" />);
    const picker = screen.getByLabelText(/workspace tint/i);
    fireEvent.change(picker, { target: { value: '#b966f5' } });
    expect(writes.some(([ws, panel, val]) => ws === 'ws1' && panel === 'tint' && val.includes('b966f5'))).toBe(true);
  });
  it('reset clears the per-workspace tint', () => {
    render(<WorkspaceTintSection activeWorkspaceId="ws1" />);
    fireEvent.click(screen.getByRole('button', { name: /reset to global/i }));
    // writes an empty/cleared tint (e.g. removeWorkspaceUi or a write of '') + clears inline vars
    expect(writes.some(([ws, panel]) => ws === 'ws1' && panel === 'tint')).toBe(true);
  });
  it('reset returns the picker to the neutral default (no stale colored swatch)', () => {
    render(<WorkspaceTintSection activeWorkspaceId="ws1" />);
    const picker = screen.getByLabelText(/workspace tint/i) as HTMLInputElement;
    // Pick a non-default hue, then reset.
    fireEvent.change(picker, { target: { value: '#123456' } });
    expect(picker.value).toBe('#123456');
    fireEvent.click(screen.getByRole('button', { name: /reset to global/i }));
    // Picker reflects the neutral default again, not the previously-picked hue.
    expect(picker.value).not.toBe('#123456');
  });
});
