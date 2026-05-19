// v1.5.0 packet 09 — HLC tests.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  generateMachineId,
  init,
  now,
  recv,
  compare,
  isNewerThan,
  pack,
  unpack,
  resetForTest,
} from './hlc';

const MACHINE_A = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const MACHINE_B = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

beforeEach(() => {
  resetForTest();
});

describe('generateMachineId', () => {
  it('produces 16 bytes', () => {
    const id = generateMachineId();
    expect(id.length).toBe(16);
  });

  it('produces unique IDs', () => {
    const a = generateMachineId();
    const b = generateMachineId();
    // Very unlikely to collide with 16 random bytes
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });
});

describe('init', () => {
  it('throws on wrong-length machine id', () => {
    expect(() => init(new Uint8Array(8))).toThrow('machineId must be 16 bytes');
  });

  it('accepts correct 16-byte machine id', () => {
    expect(() => init(MACHINE_A)).not.toThrow();
  });
});

describe('now', () => {
  it('throws when not initialised', () => {
    expect(() => now()).toThrow('not initialised');
  });

  it('returns an HLC with the current machine ID', () => {
    init(MACHINE_A);
    const h = now();
    expect(h.machineId).toEqual(MACHINE_A);
  });

  it('wallMs is close to Date.now()', () => {
    init(MACHINE_A);
    const before = Date.now();
    const h = now();
    const after = Date.now();
    expect(h.wallMs).toBeGreaterThanOrEqual(before);
    expect(h.wallMs).toBeLessThanOrEqual(after);
  });

  it('logical counter starts at 0 for the first call', () => {
    init(MACHINE_A);
    const h = now();
    expect(h.logical).toBe(0);
  });

  it('successive calls in the same millisecond increment logical', () => {
    // We cannot guarantee same-ms in a test, but we CAN call now() twice
    // and verify the second HLC is strictly newer.
    init(MACHINE_A);
    const h1 = now();
    const h2 = now();
    expect(compare(h2, h1)).toBe(1);
  });
});

describe('recv', () => {
  it('throws when not initialised', () => {
    const remote = { wallMs: Date.now(), logical: 0, machineId: MACHINE_B };
    expect(() => recv(remote)).toThrow('not initialised');
  });

  it('advances local clock when remote is newer', () => {
    init(MACHINE_A);
    const local = now();
    const remote = { wallMs: local.wallMs + 10000, logical: 0, machineId: MACHINE_B };
    const updated = recv(remote);
    expect(updated.wallMs).toBeGreaterThanOrEqual(remote.wallMs);
  });

  it('result is strictly newer than remote when remote is old', () => {
    init(MACHINE_A);
    const current = now();
    const oldRemote = { wallMs: current.wallMs - 1000, logical: 0, machineId: MACHINE_B };
    const updated = recv(oldRemote);
    expect(compare(updated, oldRemote)).toBe(1);
  });
});

describe('compare', () => {
  it('newer wallMs wins', () => {
    const a = { wallMs: 2000, logical: 0, machineId: MACHINE_A };
    const b = { wallMs: 1000, logical: 0, machineId: MACHINE_A };
    expect(compare(a, b)).toBe(1);
    expect(compare(b, a)).toBe(-1);
  });

  it('equal wallMs, higher logical wins', () => {
    const a = { wallMs: 1000, logical: 5, machineId: MACHINE_A };
    const b = { wallMs: 1000, logical: 3, machineId: MACHINE_A };
    expect(compare(a, b)).toBe(1);
    expect(compare(b, a)).toBe(-1);
  });

  it('equal wallMs and logical, higher machine_id byte wins', () => {
    const a = { wallMs: 1000, logical: 0, machineId: MACHINE_B }; // starts with 2
    const b = { wallMs: 1000, logical: 0, machineId: MACHINE_A }; // starts with 1
    expect(compare(a, b)).toBe(1);
    expect(compare(b, a)).toBe(-1);
  });

  it('identical HLCs compare as 0', () => {
    const a = { wallMs: 1000, logical: 0, machineId: MACHINE_A };
    const b = { wallMs: 1000, logical: 0, machineId: new Uint8Array(MACHINE_A) };
    expect(compare(a, b)).toBe(0);
  });
});

describe('isNewerThan', () => {
  it('returns true when a is strictly newer', () => {
    const a = { wallMs: 2000, logical: 0, machineId: MACHINE_A };
    const b = { wallMs: 1000, logical: 0, machineId: MACHINE_A };
    expect(isNewerThan(a, b)).toBe(true);
    expect(isNewerThan(b, a)).toBe(false);
  });

  it('returns false for equal HLCs', () => {
    const a = { wallMs: 1000, logical: 0, machineId: MACHINE_A };
    const b = { wallMs: 1000, logical: 0, machineId: new Uint8Array(MACHINE_A) };
    expect(isNewerThan(a, b)).toBe(false);
  });
});

describe('pack / unpack round-trip', () => {
  it('round-trips correctly', () => {
    const original = { wallMs: 1_700_000_000_000, logical: 42, machineId: MACHINE_A };
    const packed = pack(original);
    const unpacked = unpack(packed);
    expect(unpacked.wallMs).toBe(original.wallMs);
    expect(unpacked.logical).toBe(original.logical);
    expect(unpacked.machineId).toEqual(original.machineId);
  });

  it('pack produces 52 hex chars (26 bytes)', () => {
    const h = { wallMs: Date.now(), logical: 0, machineId: MACHINE_A };
    expect(pack(h).length).toBe(52);
  });

  it('unpack throws on wrong-length string', () => {
    expect(() => unpack('abc')).toThrow('expected 52 hex chars');
  });

  it('packing preserves ordering — newer HLC packs to lexicographically larger hex', () => {
    init(MACHINE_A);
    const h1 = now();
    const h2 = now();
    const packed1 = pack(h1);
    const packed2 = pack(h2);
    // Lexicographic string comparison should match HLC comparison
    expect(packed2 > packed1).toBe(true);
  });
});
