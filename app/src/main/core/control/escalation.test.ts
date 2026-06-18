import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExternalEscalator } from './escalation';

afterEach(() => vi.useRealTimers());

describe('ExternalEscalator', () => {
  it('delegates to telegram when available (no renderer prompt)', async () => {
    const notify = vi.fn();
    const esc = new ExternalEscalator({ notify, telegramConfirm: () => Promise.resolve(true) });
    expect(await esc.confirm('close_pane', 'close_pane(...)', 'hermes')).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('surfaces a renderer prompt and resolves on operator approve', async () => {
    let captured = '';
    const esc = new ExternalEscalator({ notify: (r) => { captured = r.id; } });
    const p = esc.confirm('close_pane', 's', 'hermes');
    expect(esc.pendingCount()).toBe(1);
    esc.resolve(captured, true);
    expect(await p).toBe(true);
    expect(esc.pendingCount()).toBe(0);
  });

  it('denies on timeout', async () => {
    vi.useFakeTimers();
    const esc = new ExternalEscalator({ notify: () => {}, timeoutMs: 1000 });
    const p = esc.confirm('close_pane', 's', 'hermes');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(false);
  });

  it('denies when no channel is available (fail-closed)', async () => {
    const esc = new ExternalEscalator({});
    expect(await esc.confirm('close_pane', 's', 'hermes')).toBe(false);
  });

  it('falls through to renderer when telegramConfirm returns null', async () => {
    let captured = '';
    const esc = new ExternalEscalator({ notify: (r) => { captured = r.id; }, telegramConfirm: () => null });
    const p = esc.confirm('close_pane', 's', 'hermes');
    esc.resolve(captured, false);
    expect(await p).toBe(false);
  });

  it('cancelAll denies all pending', async () => {
    const esc = new ExternalEscalator({ notify: () => {} });
    const p = esc.confirm('close_pane', 's', 'hermes');
    esc.cancelAll();
    expect(await p).toBe(false);
  });
});
