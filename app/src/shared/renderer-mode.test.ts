import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RENDERER_MODE,
  parseRendererMode,
  RENDERER_DEFAULT_KEY,
  rendererSessionKey,
} from './renderer-mode';

describe('renderer-mode (shared main+renderer)', () => {
  it('exposes the single source of truth for the default', () => {
    expect(DEFAULT_RENDERER_MODE).toBe('dom');
    expect(RENDERER_DEFAULT_KEY).toBe('panes.renderer.default');
    expect(rendererSessionKey('abc')).toBe('panes.renderer.abc');
  });

  it('parseRendererMode validates at the boundary', () => {
    expect(parseRendererMode('dom')).toBe('dom');
    expect(parseRendererMode('xterm')).toBe('xterm');
    expect(parseRendererMode('webgl2')).toBeNull();
    expect(parseRendererMode(null)).toBeNull();
    expect(parseRendererMode(undefined)).toBeNull();
  });
});
