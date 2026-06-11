import { describe, it, expect } from 'vitest';
import {
  DEV_WORKSPACE_KV_KEY,
  DEV_WORKSPACE_NAME,
  DEV_WORKSPACE_MAX_PANES,
} from './special-workspace';

describe('special-workspace constants', () => {
  it('exposes the singleton KV pointer key', () => {
    expect(DEV_WORKSPACE_KV_KEY).toBe('workspace.devWorkspace.id');
  });
  it('exposes the display name and pane cap', () => {
    expect(DEV_WORKSPACE_NAME).toBe('SigmaLink Dev');
    expect(DEV_WORKSPACE_MAX_PANES).toBe(12);
  });
});
