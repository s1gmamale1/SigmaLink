import { describe, it, expect } from 'vitest';
import { shouldSuppressPaneExitNotification } from './pty-exit-dedup';
describe('shouldSuppressPaneExitNotification', () => {
  it('false + empty set when no CLI exit', () => { const s=new Set<string>(); expect(shouldSuppressPaneExitNotification(s,'a')).toBe(false); expect(s.size).toBe(0); });
  it('true + removes when present', () => { const s=new Set(['a']); expect(shouldSuppressPaneExitNotification(s,'a')).toBe(true); expect(s.has('a')).toBe(false); });
  it('only first shell-exit suppressed', () => { const s=new Set(['a']); expect(shouldSuppressPaneExitNotification(s,'a')).toBe(true); expect(shouldSuppressPaneExitNotification(s,'a')).toBe(false); });
  it('independent sessions', () => { const s=new Set(['a']); expect(shouldSuppressPaneExitNotification(s,'b')).toBe(false); expect(s.has('a')).toBe(true); });
  it('multiple concurrent', () => { const s=new Set(['a','b']); expect(shouldSuppressPaneExitNotification(s,'a')).toBe(true); expect(shouldSuppressPaneExitNotification(s,'b')).toBe(true); expect(s.size).toBe(0); });
});
