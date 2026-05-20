// v1.5.0 packet 09 — Hybrid Logical Clock (HLC).
//
// Schema: hlc = (wall_ms: int64, logical: uint16, machine_id: bytes16)
//
// Comparison: lexicographic on (wall_ms, logical, machine_id).
//   - Higher = newer = wins under LWW.
//   - Ties on (wall_ms, logical) are tie-broken by machine_id bytes —
//     deterministic across both peers.
//
// Wire format (packed = 26 bytes):
//   wall_ms(8) || logical(2) || machine_id(16)
// Stored as hex string in SQLite (52 hex chars).
//
// Why HLC over plain Lamport: wall_ms gives the UI a real "edited N minutes
// ago" timestamp. The logical counter handles non-monotonic clocks (laptop
// battery dies, wall clock jumps) without producing a bogus wall timestamp.
//
// machine_id is a random 16-byte device identifier generated at first sync
// setup. NEVER derived from hostname or any PII — the machine name must not
// leak into synced data (Risk 8 in the brief).

import { randomBytes } from 'node:crypto';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface Hlc {
  wallMs: number;
  logical: number;
  machineId: Uint8Array; // exactly 16 bytes
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const MACHINE_ID_BYTES = 16;
const MAX_LOGICAL = 0xffff;
const WALL_MS_BYTES = 8;
const LOGICAL_BYTES = 2;
const PACKED_BYTES = WALL_MS_BYTES + LOGICAL_BYTES + MACHINE_ID_BYTES; // 26

// ------------------------------------------------------------------
// Machine ID
// ------------------------------------------------------------------

/**
 * Generate a new random machine ID (16 cryptographically-random bytes).
 * Called once at sync setup; stored via CredentialStore.
 */
export function generateMachineId(): Uint8Array {
  return new Uint8Array(randomBytes(MACHINE_ID_BYTES));
}

// ------------------------------------------------------------------
// HLC state
// ------------------------------------------------------------------

let _state: Hlc | null = null;
let _machineId: Uint8Array | null = null;

/**
 * Initialise the HLC state with a machine ID. Must be called before any
 * `now()` or `recv()` calls. Safe to call multiple times with the same ID.
 */
export function init(machineId: Uint8Array): void {
  if (machineId.length !== MACHINE_ID_BYTES) {
    throw new Error(`hlc.init: machineId must be ${MACHINE_ID_BYTES} bytes`);
  }
  _machineId = machineId;
  // Do NOT pre-initialise _state — first now() call sets wallMs=Date.now(),
  // ensuring logical=0 for that first event (rather than bumping to 1 from
  // the same-millisecond case).
}

/**
 * Reset HLC state — used in tests only.
 */
export function resetForTest(): void {
  _state = null;
  _machineId = null;
}

function assertInitialised(): Uint8Array {
  if (!_machineId) {
    throw new Error('hlc: not initialised — call hlc.init(machineId) first');
  }
  return _machineId;
}

// ------------------------------------------------------------------
// Core operations
// ------------------------------------------------------------------

/**
 * Generate a new HLC timestamp for a local event.
 * Advances the clock beyond the current wall time or the last known HLC.
 */
export function now(): Hlc {
  const machineId = assertInitialised();
  const wall = Date.now();

  if (_state === null || wall > _state.wallMs) {
    _state = { wallMs: wall, logical: 0, machineId };
  } else {
    // Same or earlier wall clock: advance logical counter.
    if (_state.logical >= MAX_LOGICAL) {
      // Logical counter overflow — extremely unlikely in practice; throw so
      // operators can investigate rather than silently wrapping.
      throw new Error(
        'hlc.now: logical counter overflow — system clock may be stuck',
      );
    }
    _state = { wallMs: _state.wallMs, logical: _state.logical + 1, machineId };
  }

  return { ..._state, machineId: new Uint8Array(machineId) };
}

/**
 * Receive a remote HLC timestamp and advance the local clock to ensure
 * monotonic ordering. Returns the updated local HLC.
 *
 * Must be called when ingesting every remote event to maintain causality.
 */
export function recv(remote: Hlc): Hlc {
  const machineId = assertInitialised();
  const wall = Date.now();
  const maxWall = Math.max(wall, remote.wallMs, _state?.wallMs ?? 0);

  if (_state === null) {
    _state = { wallMs: maxWall, logical: 0, machineId };
    return { ..._state, machineId: new Uint8Array(machineId) };
  }

  if (maxWall === _state.wallMs && maxWall === remote.wallMs) {
    // Both clocks at the same wall time — take the higher logical + 1.
    const logical = Math.max(_state.logical, remote.logical) + 1;
    if (logical > MAX_LOGICAL) {
      throw new Error('hlc.recv: logical counter overflow');
    }
    _state = { wallMs: maxWall, logical, machineId };
  } else if (maxWall === _state.wallMs) {
    _state = { wallMs: maxWall, logical: _state.logical + 1, machineId };
  } else if (maxWall === remote.wallMs) {
    _state = { wallMs: maxWall, logical: remote.logical + 1, machineId };
  } else {
    _state = { wallMs: maxWall, logical: 0, machineId };
  }

  return { ..._state, machineId: new Uint8Array(machineId) };
}

// ------------------------------------------------------------------
// Comparison
// ------------------------------------------------------------------

/**
 * Compare two HLC timestamps.
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b.
 * Ordering: lexicographic on (wallMs DESC, logical DESC, machineId).
 */
export function compare(a: Hlc, b: Hlc): -1 | 0 | 1 {
  if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
  if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
  // Tie-break on machine_id bytes (lexicographic).
  for (let i = 0; i < MACHINE_ID_BYTES; i++) {
    const ai = a.machineId[i] ?? 0;
    const bi = b.machineId[i] ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

/**
 * Returns true if `a` is strictly newer than `b`.
 */
export function isNewerThan(a: Hlc, b: Hlc): boolean {
  return compare(a, b) === 1;
}

// ------------------------------------------------------------------
// Pack / unpack (wire format)
// ------------------------------------------------------------------

/**
 * Pack an HLC into 26 bytes, returned as a hex string (52 chars) for SQLite.
 * Layout: wall_ms(8 big-endian) || logical(2 big-endian) || machine_id(16)
 */
export function pack(hlc: Hlc): string {
  const buf = Buffer.alloc(PACKED_BYTES);
  // Write wall_ms as a 64-bit big-endian integer.
  // JavaScript numbers are safe up to 2^53; we split into two 32-bit halves.
  const hi = Math.floor(hlc.wallMs / 0x1_0000_0000);
  const lo = hlc.wallMs >>> 0;
  buf.writeUInt32BE(hi, 0);
  buf.writeUInt32BE(lo, 4);
  buf.writeUInt16BE(hlc.logical, 8);
  buf.set(hlc.machineId, 10);
  return buf.toString('hex');
}

/**
 * Unpack an HLC from a hex string produced by `pack`.
 */
export function unpack(hex: string): Hlc {
  if (hex.length !== PACKED_BYTES * 2) {
    throw new Error(
      `hlc.unpack: expected ${PACKED_BYTES * 2} hex chars, got ${hex.length}`,
    );
  }
  const buf = Buffer.from(hex, 'hex');
  const hi = buf.readUInt32BE(0);
  const lo = buf.readUInt32BE(4);
  const wallMs = hi * 0x1_0000_0000 + lo;
  const logical = buf.readUInt16BE(8);
  const machineId = new Uint8Array(buf.buffer, buf.byteOffset + 10, MACHINE_ID_BYTES);
  return { wallMs, logical, machineId: new Uint8Array(machineId) };
}
