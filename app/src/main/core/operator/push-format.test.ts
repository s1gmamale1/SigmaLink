// P3 Task 3 (D6) — pure formatter tests for the proactive Telegram push text
// builders. No DB, no mocks needed: every function here is pure string
// composition over caller-supplied inputs.

import { describe, expect, it } from 'vitest';
import {
  formatAmendmentProposedPush,
  formatCapBlockPush,
  formatMissionDonePush,
  formatTaskBlockedPush,
} from './push-format';

describe('formatCapBlockPush', () => {
  it('includes the cap emoji, attempt count, task title, and mission label', () => {
    const text = formatCapBlockPush('Wire it up', 'Ship it', 5);
    expect(text).toBe('⛔ task capped after 5 attempts: Wire it up (mission Ship it) — needs a human');
  });

  it('accepts a raw mission id as the label (fallback when the mission row is missing)', () => {
    const text = formatCapBlockPush('Wire it up', 'mission-123', 5);
    expect(text).toContain('mission mission-123');
  });
});

describe('formatMissionDonePush', () => {
  it('includes the done emoji, mission title, and the full report when short', () => {
    const text = formatMissionDonePush('Ship the widget', 'all green, shipped 3f4d13d');
    expect(text).toBe('✅ mission done: Ship the widget\nall green, shipped 3f4d13d');
  });

  it('truncates the report to its first 400 characters', () => {
    const report = 'x'.repeat(500);
    const text = formatMissionDonePush('Ship it', report);
    const tail = text.split('\n')[1];
    expect(tail).toHaveLength(400);
    expect(tail).toBe('x'.repeat(400));
  });

  it('renders an empty tail (not "null") when report is null', () => {
    const text = formatMissionDonePush('Ship it', null);
    expect(text).toBe('✅ mission done: Ship it\n');
  });
});

describe('formatTaskBlockedPush', () => {
  it('includes the blocked emoji and the task id', () => {
    expect(formatTaskBlockedPush('task-42')).toBe('🚧 task blocked: task-42 — check the board');
  });
});

describe('formatAmendmentProposedPush', () => {
  it('includes the amendment id and both approve/deny commands', () => {
    const text = formatAmendmentProposedPush('amd-7');
    expect(text).toBe('🔏 amendment proposed (amd-7): /approve amd-7 or /deny amd-7');
  });
});
