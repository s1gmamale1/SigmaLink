// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/renderer/lib/rpc', () => ({ rpc: {
  pty: { snapshot: vi.fn().mockResolvedValue({ buffer: '\x1b[32m$ npm test\x1b[0m\npassed' }) },
  git: { diff: vi.fn().mockResolvedValue({ stat: ' 2 files changed', patches: '', untrackedFiles: [] }) },
} }));
import { buildPaneContext, PANE_DRAG_MIME } from './pane-context-builder';
it('assembles branch + diff stat + compacted scrollback', async () => {
  const ctx = await buildPaneContext({ kind: 'pane', sessionId: 's1', branch: 'feat/x', worktreePath: '/wt', providerId: 'claude' });
  expect(ctx).toContain('branch: feat/x');
  expect(ctx).toContain('2 files changed');
  expect(ctx).toContain('passed');
  expect(ctx).not.toContain('\x1b['); // ANSI stripped
});
it('PANE_DRAG_MIME is the correct string', () => {
  expect(PANE_DRAG_MIME).toBe('application/sigmalink-pane');
});
