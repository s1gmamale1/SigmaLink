import { describe, it, expect } from 'vitest';
import { createViewportShadow } from './app-state-shadow';

describe('viewport shadow', () => {
  it('starts stale and merges patches', () => {
    const s = createViewportShadow();
    expect(s.get().viewportStale).toBe(true);
    s.report({ activeWorkspaceId: 'w1', room: 'command' });
    const v = s.get();
    expect(v.viewportStale).toBe(false);
    expect(v.activeWorkspaceId).toBe('w1');
    expect(v.room).toBe('command');
    s.report({ activeSessionId: 's1' });
    expect(s.get().activeWorkspaceId).toBe('w1');
    expect(s.get().activeSessionId).toBe('s1');
  });
});
