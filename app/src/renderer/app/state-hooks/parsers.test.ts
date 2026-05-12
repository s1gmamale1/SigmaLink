// v1.1.10 — coverage for the warning-level audit fixes in `parsers.ts`.
//
// Focuses on:
//   - parseSwarmMessage rejects payloads with an unknown `kind` discriminant
//     instead of silently smuggling them into AppState via an `as` cast.
//   - parseSwarmMessage still accepts every documented kind and falls back
//     to 'OPERATOR' when `kind` is absent (legacy main-process payloads).

import { describe, expect, it } from 'vitest';
import { parseSwarmMessage } from './parsers';
import type { SwarmMessageKind } from '../../../shared/types';

const baseRaw = {
  id: 'msg-1',
  swarmId: 'sw-1',
  from: 'operator',
  to: '*',
  body: 'hello',
  ts: 1700000000000,
};

const VALID_KINDS: SwarmMessageKind[] = [
  'SAY',
  'ACK',
  'STATUS',
  'DONE',
  'OPERATOR',
  'ROLLCALL',
  'ROLLCALL_REPLY',
  'SYSTEM',
];

describe('parseSwarmMessage runtime kind validation', () => {
  it('accepts every documented SwarmMessageKind', () => {
    for (const kind of VALID_KINDS) {
      const parsed = parseSwarmMessage({ ...baseRaw, kind });
      expect(parsed?.kind).toBe(kind);
    }
  });

  it('rejects payloads with an unknown kind string', () => {
    // Pre-v1.1.10 this would return a SwarmMessage with `kind: 'INVALID' as any`.
    expect(parseSwarmMessage({ ...baseRaw, kind: 'INVALID' })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, kind: '' })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, kind: 'system' })).toBeNull(); // case-sensitive
  });

  it('rejects payloads where kind is a non-string non-nullish value', () => {
    expect(parseSwarmMessage({ ...baseRaw, kind: 1 })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, kind: {} })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, kind: true })).toBeNull();
  });

  it('falls back to OPERATOR when kind is missing (legacy payloads)', () => {
    const parsed = parseSwarmMessage(baseRaw);
    expect(parsed?.kind).toBe('OPERATOR');
  });

  it('falls back to OPERATOR when kind is explicitly null', () => {
    const parsed = parseSwarmMessage({ ...baseRaw, kind: null });
    expect(parsed?.kind).toBe('OPERATOR');
  });

  it('still rejects payloads missing required identifiers regardless of kind', () => {
    expect(parseSwarmMessage({ kind: 'SAY' })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, id: '' })).toBeNull();
    expect(parseSwarmMessage({ ...baseRaw, swarmId: '' })).toBeNull();
  });
});
