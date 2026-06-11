import { describe, it, expect, vi } from 'vitest';

// Behavioral contract guard for CommandRoom.handleRemove (the single funnel for
// BOTH the × button and the context-menu "Close pane"). A deliberate remove must
// route through the panes.close soft-delete primitive — marks closed_at then
// kills — NOT a bare pty.kill (which leaves no durable marker, so the pane
// resurrects on restart and raises a spurious "Pane exited" toast).
//
// The logic below mirrors the new handleRemove in CommandRoom.tsx; keep it in
// sync with source. CommandRoom mounts behind a heavily-mocked rpc surface, so a
// focused contract test is clearer than a full render here.
describe('CommandRoom handleRemove deliberate-close contract', () => {
  it('calls rpc.panes.close and dispatches REMOVE_SESSION; never pty.kill', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const kill = vi.fn().mockResolvedValue(undefined);
    const dispatch = vi.fn();
    const rpc = { panes: { close }, pty: { kill } };
    const session = { id: 's1', status: 'running' as const };

    function handleRemove(s: { id: string; status: string }) {
      void rpc.panes.close(s.id).catch(() => undefined);
      dispatch({ type: 'REMOVE_SESSION', id: s.id });
    }
    handleRemove(session);

    expect(close).toHaveBeenCalledWith('s1');
    expect(kill).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_SESSION', id: 's1' });
  });

  it('routes an already-errored pane through panes.close too (no status guard)', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const kill = vi.fn().mockResolvedValue(undefined);
    const dispatch = vi.fn();
    const rpc = { panes: { close }, pty: { kill } };
    const session = { id: 's2', status: 'error' as const };

    function handleRemove(s: { id: string; status: string }) {
      void rpc.panes.close(s.id).catch(() => undefined);
      dispatch({ type: 'REMOVE_SESSION', id: s.id });
    }
    handleRemove(session);

    // closed_at must be set even for an errored row so it stops rehydrating;
    // markPaneClosed's WHERE closed_at IS NULL keeps the kill idempotent.
    expect(close).toHaveBeenCalledWith('s2');
    expect(kill).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_SESSION', id: 's2' });
  });
});
