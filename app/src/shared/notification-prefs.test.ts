import { describe, it, expect } from 'vitest';
import {
  hhmmToMinutes,
  parseQuietHours,
  isWithinQuietHours,
  notificationSource,
  parseMutedSources,
  isQuietActive,
  isOsSuppressed,
  isSoundSuppressedByPrefs,
  severityCue,
  cueDef,
  SOUND_CATALOG,
  DEFAULT_QUIET_HOURS,
  type NotificationPrefs,
  type QuietHoursConfig,
} from './notification-prefs';

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  dnd: false,
  quietHours: { ...DEFAULT_QUIET_HOURS },
  mutedSources: [],
  ...over,
});

describe('hhmmToMinutes', () => {
  it('parses valid times', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('08:30')).toBe(510);
    expect(hhmmToMinutes('23:59')).toBe(1439);
  });
  it('rejects malformed / out-of-range', () => {
    expect(hhmmToMinutes('24:00')).toBeNull();
    expect(hhmmToMinutes('12:60')).toBeNull();
    expect(hhmmToMinutes('noon')).toBeNull();
    expect(hhmmToMinutes('')).toBeNull();
  });
});

describe('parseQuietHours', () => {
  it('falls back to disabled default on null / malformed', () => {
    expect(parseQuietHours(null)).toEqual(DEFAULT_QUIET_HOURS);
    expect(parseQuietHours('{not json')).toEqual(DEFAULT_QUIET_HOURS);
  });
  it('keeps valid windows and coerces bad times to default', () => {
    expect(parseQuietHours(JSON.stringify({ enabled: true, start: '23:00', end: '06:30' })))
      .toEqual({ enabled: true, start: '23:00', end: '06:30' });
    const bad = parseQuietHours(JSON.stringify({ enabled: true, start: '99:99', end: '06:30' }));
    expect(bad.start).toBe(DEFAULT_QUIET_HOURS.start);
    expect(bad.end).toBe('06:30');
  });
});

describe('isWithinQuietHours', () => {
  const win = (start: string, end: string): QuietHoursConfig => ({ enabled: true, start, end });
  it('returns false when disabled', () => {
    expect(isWithinQuietHours({ enabled: false, start: '00:00', end: '23:59' }, 600)).toBe(false);
  });
  it('non-wrapping window', () => {
    expect(isWithinQuietHours(win('09:00', '17:00'), 8 * 60)).toBe(false);
    expect(isWithinQuietHours(win('09:00', '17:00'), 12 * 60)).toBe(true);
    expect(isWithinQuietHours(win('09:00', '17:00'), 17 * 60)).toBe(false); // end exclusive
  });
  it('wrapping window (spans midnight)', () => {
    const w = win('22:00', '08:00');
    expect(isWithinQuietHours(w, 23 * 60)).toBe(true);
    expect(isWithinQuietHours(w, 3 * 60)).toBe(true);
    expect(isWithinQuietHours(w, 8 * 60)).toBe(false); // end exclusive
    expect(isWithinQuietHours(w, 12 * 60)).toBe(false);
  });
  it('zero-width window is never active', () => {
    expect(isWithinQuietHours(win('10:00', '10:00'), 10 * 60)).toBe(false);
  });
});

describe('notificationSource', () => {
  it('maps kinds to coarse sources', () => {
    expect(notificationSource('pty-exit')).toBe('pty');
    expect(notificationSource('swarm-broadcast')).toBe('swarm');
    expect(notificationSource('swarm-summary')).toBe('swarm');
    expect(notificationSource('tool-error')).toBe('tool');
    expect(notificationSource('tool-error-summary')).toBe('tool');
    expect(notificationSource('whatever-else')).toBe('system');
  });
});

describe('parseMutedSources', () => {
  it('keeps known sources, drops the rest', () => {
    expect(parseMutedSources(JSON.stringify(['pty', 'nope', 'swarm']))).toEqual(['pty', 'swarm']);
    expect(parseMutedSources(null)).toEqual([]);
    expect(parseMutedSources('garbage')).toEqual([]);
  });
});

describe('isOsSuppressed', () => {
  it('per-source mute always wins (even for critical)', () => {
    const p = prefs({ mutedSources: ['pty'] });
    expect(isOsSuppressed(p, { source: 'pty', severity: 'critical' }, 600)).toBe(true);
    expect(isOsSuppressed(p, { source: 'swarm', severity: 'info' }, 600)).toBe(false);
  });
  it('critical bypasses DND/quiet', () => {
    const p = prefs({ dnd: true });
    expect(isOsSuppressed(p, { source: 'swarm', severity: 'critical' }, 600)).toBe(false);
    expect(isOsSuppressed(p, { source: 'swarm', severity: 'error' }, 600)).toBe(true);
  });
  it('non-critical suppressed only while quiet active', () => {
    expect(isOsSuppressed(prefs(), { source: 'pty', severity: 'warn' }, 600)).toBe(false);
    expect(isOsSuppressed(prefs({ dnd: true }), { source: 'pty', severity: 'warn' }, 600)).toBe(true);
  });
});

describe('isSoundSuppressedByPrefs', () => {
  it('silences all severities while quiet active', () => {
    expect(isSoundSuppressedByPrefs(prefs({ dnd: true }), {}, 600)).toBe(true);
    expect(isSoundSuppressedByPrefs(prefs(), {}, 600)).toBe(false);
  });
  it('per-source mute wins', () => {
    expect(isSoundSuppressedByPrefs(prefs({ mutedSources: ['tool'] }), { source: 'tool' }, 600)).toBe(true);
    expect(isSoundSuppressedByPrefs(prefs({ mutedSources: ['tool'] }), { source: 'pty' }, 600)).toBe(false);
  });
});

describe('isQuietActive', () => {
  it('true under DND or in-window', () => {
    expect(isQuietActive(prefs({ dnd: true }), 600)).toBe(true);
    expect(isQuietActive(prefs({ quietHours: { enabled: true, start: '00:00', end: '23:59' } }), 600)).toBe(true);
    expect(isQuietActive(prefs(), 600)).toBe(false);
  });
});

describe('sound catalog', () => {
  it('severityCue resolves to a real catalog entry for every severity', () => {
    for (const sev of ['info', 'warn', 'error', 'critical'] as const) {
      const cue = severityCue(sev);
      expect(cueDef(cue)).toBeDefined();
    }
  });
  it('every cue has at least one tone and a category', () => {
    for (const def of SOUND_CATALOG) {
      expect(def.tones.length).toBeGreaterThan(0);
      expect(['alert', 'ui']).toContain(def.category);
    }
  });
});
