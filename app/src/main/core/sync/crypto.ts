// v1.5.0 packet 09 — Sync crypto layer (XChaCha20-Poly1305 + AAD).
// v1.5.1-C caveat 3 — Schema-skew design refactor.
//
// Implements authenticated encryption with associated data (AEAD) using
// libsodium's XChaCha20-Poly1305-IETF construction. The 24-byte nonce space
// of XChaCha eliminates practical nonce-reuse risk even with random generation.
//
// SECURITY PROPERTIES:
//   1. Confidentiality: XChaCha20 stream cipher.
//   2. Integrity: Poly1305 MAC authenticates ciphertext + tag + AAD.
//   3. AAD binding (v2): aad = "${table_name}|${row_id}".
//      The schema_version was moved to the unencrypted outer header (OUTER_VERSION 2)
//      so the engine can read schema BEFORE attempting AEAD decryption, enabling
//      proper routing of schema-mismatched blobs to sync_pending_upgrade instead of
//      sync_quarantine. The table_name|row_id AAD still binds the ciphertext to its
//      row context, providing the anti-blob-swap guarantee.
//   4. Quarantine on AEAD fail: callers MUST check the return value and
//      route failures to sync_quarantine. Never apply a failed blob.
//   5. Key never crosses IPC: this module runs in the main process only.
//      The renderer calls sync.* RPCs; the key material stays here.
//
// Wire format v1 (OUTER_VERSION = 1, LEGACY):
//   MAGIC(4) || OUTER_VERSION=1(1) || NONCE(24) || CT+TAG(N+16)
//   AAD = "${schema_version}|${table_name}|${row_id}"
//
// Wire format v2 (OUTER_VERSION = 2, CURRENT):
//   MAGIC(4) || OUTER_VERSION=2(1) || SCHEMA_VERSION(4, big-endian uint32)
//     || NONCE(24) || CT+TAG(N+16)
//   AAD = "${table_name}|${row_id}"
//
// Backward compatibility: v1 blobs are readable via the legacy decode path.
// New pushes always emit v2. The caller must pass the correct legacy aad for
// v1 blobs (use `buildAadV1(schemaVersion, tableName, rowId)`).
//
// Limitations in scope for v1.5.0:
//   - Single key (no key rotation protocol).
//   - No per-row key derivation (sync master key used directly).
//   - Post-quantum resistance is a v1.5.x follow-up (see S2 non-goals).

import sodium from 'libsodium-wrappers-sumo';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Wire-format magic bytes: ASCII "SGSY". */
const MAGIC = Buffer.from([0x53, 0x47, 0x53, 0x59]);

/**
 * OUTER_VERSION history:
 *   1 — v1.5.0 original. Schema_version in AAD; no schema field in header.
 *   2 — v1.5.1-C. Schema_version moved to unencrypted outer header (4 bytes,
 *       big-endian uint32) BEFORE the nonce. AAD is now "${table_name}|${row_id}".
 */
const OUTER_VERSION_V1 = 1;
const OUTER_VERSION_V2 = 2;
/** Current format version for new writes. */
const PAYLOAD_VERSION = OUTER_VERSION_V2;

const NONCE_BYTES = 24; // XChaCha20 nonce length
const KEY_BYTES = 32;   // libsodium secret-key length
const SCHEMA_BYTES = 4; // uint32, big-endian

// Ensure libsodium is ready before any operation.
let _ready = false;
async function ensureReady(): Promise<void> {
  if (_ready) return;
  await sodium.ready;
  _ready = true;
}

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface EncryptParams {
  /** 32-byte symmetric master key. NEVER pass across IPC. */
  key: Uint8Array;
  /** Row JSON or arbitrary plaintext bytes. */
  plaintext: Uint8Array | string;
  /**
   * Associated data for v2: "${table_name}|${row_id}".
   * Use `buildAad(tableName, rowId)` to build it.
   */
  aad: string;
  /**
   * Schema version to embed in the v2 outer header.
   * Required for v2 encrypt; callers should always pass this.
   */
  schemaVersion: number;
}

export interface EncryptResult {
  /** Wire-format v2 payload ready for git commit. */
  payload: Buffer;
}

export interface DecryptParams {
  /** 32-byte symmetric master key. */
  key: Uint8Array;
  /** Raw payload bytes read from the git object. */
  payload: Buffer;
  /**
   * Associated data.
   * - v2 blobs: "${table_name}|${row_id}" (use `buildAad(tableName, rowId)`)
   * - v1 blobs (legacy): "${schema_version}|${table_name}|${row_id}"
   *   (use `buildAadV1(schemaVersion, tableName, rowId)`)
   * The engine reads the outer version byte FIRST to select the correct AAD.
   */
  aad: string;
}

export type DecryptResult =
  | { ok: true; plaintext: Uint8Array; schemaVersion: number; outerVersion: number }
  | { ok: false; reason: 'aead_fail' | 'malformed' | 'unknown_version' };

/**
 * Read only the outer header of a payload to extract the schema version
 * WITHOUT performing AEAD decryption.
 *
 * Returns null if the payload is malformed or the version is unknown.
 * Used by the engine to decide whether to route to sync_pending_upgrade
 * BEFORE attempting decryption.
 */
export interface PeekResult {
  outerVersion: number;
  /** Defined for v2+; undefined for v1 (schema was in the AAD). */
  schemaVersion: number | undefined;
}

// ------------------------------------------------------------------
// AAD construction (exported for tests and engine consistency)
// ------------------------------------------------------------------

/**
 * Build the v2 AAD string that binds a ciphertext blob to its row.
 *
 * Format: "${table_name}|${row_id}"
 *
 * The schema_version was moved to the outer unencrypted header in v2 so the
 * engine can read it BEFORE attempting AEAD decryption, enabling proper routing
 * of schema-mismatched blobs to sync_pending_upgrade. The table_name|row_id
 * binding still provides the anti-blob-swap guarantee (A3).
 */
export function buildAad(tableName: string, rowId: string): string {
  if (!tableName) throw new Error('crypto.buildAad: tableName is required');
  if (!rowId) throw new Error('crypto.buildAad: rowId is required');
  return `${tableName}|${rowId}`;
}

/**
 * Build the LEGACY v1 AAD string.
 *
 * Format: "${schema_version}|${table_name}|${row_id}"
 *
 * Used only when decrypting v1 (OUTER_VERSION = 1) blobs for backward
 * compatibility. New pushes always use v2.
 */
export function buildAadV1(schemaVersion: number, tableName: string, rowId: string): string {
  if (!tableName) throw new Error('crypto.buildAadV1: tableName is required');
  if (!rowId) throw new Error('crypto.buildAadV1: rowId is required');
  return `${schemaVersion}|${tableName}|${rowId}`;
}

/**
 * Peek at the outer header of a payload to extract version + schema WITHOUT
 * performing AEAD decryption. Returns null if the payload is malformed.
 */
export function peekHeader(payload: Buffer): PeekResult | null {
  // Minimum v1: MAGIC(4) + VERSION(1) + NONCE(24) + TAG(16) = 45 bytes.
  if (payload.length < 45) return null;
  if (!payload.slice(0, 4).equals(MAGIC)) return null;
  const outerVersion = payload[4]!;
  if (outerVersion === OUTER_VERSION_V1) {
    // v1: no schema in header.
    return { outerVersion: OUTER_VERSION_V1, schemaVersion: undefined };
  }
  if (outerVersion === OUTER_VERSION_V2) {
    // v2: schema occupies bytes 5–8 (4-byte big-endian uint32).
    // Minimum v2: MAGIC(4)+VERSION(1)+SCHEMA(4)+NONCE(24)+TAG(16) = 49 bytes.
    if (payload.length < 49) return null;
    const schemaVersion = payload.readUInt32BE(5);
    return { outerVersion: OUTER_VERSION_V2, schemaVersion };
  }
  return null; // unknown version
}

// ------------------------------------------------------------------
// Key validation
// ------------------------------------------------------------------

function assertKeyLength(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `crypto: key must be exactly ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
}

// ------------------------------------------------------------------
// Encrypt
// ------------------------------------------------------------------

/**
 * Encrypt plaintext with XChaCha20-Poly1305-IETF using wire format v2.
 *
 * The AAD MUST be built with `buildAad(tableName, rowId)` so the ciphertext
 * is cryptographically bound to its row context (anti-blob-swap).
 * The schemaVersion is written to the unencrypted outer header so the engine
 * can read it before attempting decryption.
 *
 * Wire format v2: MAGIC(4) | VERSION=2(1) | SCHEMA(4) | NONCE(24) | CT+TAG(N+16)
 */
export async function encrypt(params: EncryptParams): Promise<EncryptResult> {
  await ensureReady();
  const { key, plaintext, aad, schemaVersion } = params;
  assertKeyLength(key);

  const ptBytes =
    typeof plaintext === 'string'
      ? sodium.from_string(plaintext)
      : plaintext;

  // Random 24-byte nonce. XChaCha20's extended nonce eliminates the birthday
  // bound concern at this usage volume (<2^32 rows × devices).
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const aadBytes = sodium.from_string(aad);

  const ciphertextWithTag = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    ptBytes,
    aadBytes,
    null, // nsec: not used in this construction
    nonce,
    key,
  );

  // Wire format v2: MAGIC(4) | OUTER_VERSION=2(1) | SCHEMA(4 big-endian uint32)
  //                 | NONCE(24) | CT+TAG(N+16)
  const schemaHeader = Buffer.allocUnsafe(SCHEMA_BYTES);
  schemaHeader.writeUInt32BE(schemaVersion, 0);

  const payload = Buffer.concat([
    MAGIC,
    Buffer.from([PAYLOAD_VERSION]), // = OUTER_VERSION_V2 = 2
    schemaHeader,
    Buffer.from(nonce),
    Buffer.from(ciphertextWithTag),
  ]);

  return { payload };
}

// ------------------------------------------------------------------
// Decrypt
// ------------------------------------------------------------------

/**
 * Decrypt a sync blob payload.
 *
 * Handles both wire format v1 (OUTER_VERSION = 1, legacy) and v2 (OUTER_VERSION = 2,
 * current). The caller MUST supply the correct AAD for the version:
 *   - v2: use `buildAad(tableName, rowId)`
 *   - v1: use `buildAadV1(schemaVersion, tableName, rowId)`
 *
 * The engine should call `peekHeader()` first to determine the version and
 * schema, then construct the appropriate AAD before calling decrypt.
 *
 * Returns `{ ok: true, plaintext, schemaVersion, outerVersion }` on success.
 * Returns `{ ok: false, reason }` on ANY failure — AEAD verification failure,
 * malformed header, or unknown version. The caller MUST route failures to
 * `sync_quarantine` and NEVER apply the blob.
 */
export async function decrypt(params: DecryptParams): Promise<DecryptResult> {
  await ensureReady();
  const { key, payload, aad } = params;
  assertKeyLength(key);

  // Minimum v1 size: MAGIC(4) + VERSION(1) + NONCE(24) + TAG(16) = 45 bytes.
  if (payload.length < 4 + 1 + NONCE_BYTES + 16) {
    return { ok: false, reason: 'malformed' };
  }

  // Check magic bytes.
  if (!payload.slice(0, 4).equals(MAGIC)) {
    return { ok: false, reason: 'malformed' };
  }

  const outerVersion = payload[4]!;

  // ── v1 legacy path ──────────────────────────────────────────────────────
  if (outerVersion === OUTER_VERSION_V1) {
    // v1 layout: MAGIC(4) | VERSION=1(1) | NONCE(24) | CT+TAG(N+16)
    const nonce = new Uint8Array(payload.buffer, payload.byteOffset + 5, NONCE_BYTES);
    const ciphertextWithTag = new Uint8Array(
      payload.buffer,
      payload.byteOffset + 5 + NONCE_BYTES,
      payload.length - 5 - NONCE_BYTES,
    );
    const aadBytes = sodium.from_string(aad);
    try {
      const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, ciphertextWithTag, aadBytes, nonce, key,
      );
      // v1 blobs carry schemaVersion in the AAD string; return 0 as sentinel
      // (the engine reads it from the row envelope JSON for v1 blobs).
      return { ok: true, plaintext, schemaVersion: 0, outerVersion: OUTER_VERSION_V1 };
    } catch {
      return { ok: false, reason: 'aead_fail' };
    }
  }

  // ── v2 current path ─────────────────────────────────────────────────────
  if (outerVersion === OUTER_VERSION_V2) {
    // v2 layout: MAGIC(4) | VERSION=2(1) | SCHEMA(4) | NONCE(24) | CT+TAG(N+16)
    // Minimum v2 size: 4+1+4+24+16 = 49 bytes.
    if (payload.length < 4 + 1 + SCHEMA_BYTES + NONCE_BYTES + 16) {
      return { ok: false, reason: 'malformed' };
    }
    const schemaVersion = payload.readUInt32BE(5);
    const nonceOffset = 5 + SCHEMA_BYTES;
    const ctOffset = nonceOffset + NONCE_BYTES;
    const nonce = new Uint8Array(payload.buffer, payload.byteOffset + nonceOffset, NONCE_BYTES);
    const ciphertextWithTag = new Uint8Array(
      payload.buffer,
      payload.byteOffset + ctOffset,
      payload.length - ctOffset,
    );
    const aadBytes = sodium.from_string(aad);
    try {
      const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, ciphertextWithTag, aadBytes, nonce, key,
      );
      return { ok: true, plaintext, schemaVersion, outerVersion: OUTER_VERSION_V2 };
    } catch {
      return { ok: false, reason: 'aead_fail' };
    }
  }

  return { ok: false, reason: 'unknown_version' };
}

// ------------------------------------------------------------------
// Key generation utility
// ------------------------------------------------------------------

/**
 * Generate a new random 32-byte sync master key.
 * Called once at first-time setup; result stored via KeyManager.
 */
export async function generateKey(): Promise<Uint8Array> {
  await ensureReady();
  return sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
}

/**
 * Constant-time comparison of two byte arrays. Returns false if lengths differ.
 * Used in tests to compare keys without timing side-channels.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // libsodium memcmp is constant-time
  return sodium.memcmp(a, b);
}
