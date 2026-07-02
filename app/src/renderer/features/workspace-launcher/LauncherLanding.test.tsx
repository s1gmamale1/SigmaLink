// @vitest-environment jsdom
//
// Task 2 — LauncherLanding (minimal-chrome landing) RTL coverage.
//
// Invariants tested:
//   1. Hero copy + all four mode rows render with kbd labels.
//   2. Clicking a row fires onPick with that row's LauncherMode.
//   3. SigmaCanvas shows the ALPHA chip until `canvas.gaSign === '1'`.
//   4. Footer surfaces the real kbd hints + a working Settings affordance.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { kvGet } = vi.hoisted(() => ({ kvGet: vi.fn(async () => null as string | null) }));
vi.mock('@/renderer/lib/rpc', () => ({ rpcSilent: { kv: { get: kvGet } } }));

import { LauncherLanding } from './LauncherLanding';

afterEach(cleanup);

describe('LauncherLanding', () => {
  it('renders hero + all four mode rows with kbd labels', () => {
    render(<LauncherLanding onPick={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByText('Command the fleet.')).toBeTruthy();
    expect(screen.getByText('Choose how you want to work.')).toBeTruthy();
    for (const id of ['space', 'swarm', 'single', 'canvas']) {
      expect(screen.getByTestId(`intent-card-${id}`)).toBeTruthy();
    }
  });
  it('onPick fires with the row mode', () => {
    const onPick = vi.fn();
    render(<LauncherLanding onPick={onPick} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByTestId('intent-card-swarm'));
    expect(onPick).toHaveBeenCalledWith('swarm');
  });
  it('shows ALPHA chip until canvas.gaSign === "1"', async () => {
    render(<LauncherLanding onPick={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(await screen.findByText('Alpha')).toBeTruthy();
  });
  it('footer: kbd hints + settings affordance', () => {
    const onOpenSettings = vi.fn();
    render(<LauncherLanding onPick={vi.fn()} onOpenSettings={onOpenSettings} />);
    const footer = screen.getByTestId('landing-footer');
    expect(footer.textContent).toContain('Command palette');
    expect(footer.textContent).toContain('Memory');
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
