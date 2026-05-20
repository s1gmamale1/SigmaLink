// v1.5.0 packet 09 — Sync crypto layer (XChaCha20-Poly1305 + AAD).
//
// Implements authenticated encryption with associated data (AEAD) using
// libsodium's XChaCha20-Poly1305-IETF construction. The 24-byte nonce space
// of XChaCha eliminates practical nonce-reuse risk even with random generation.
//
// SECURITY PROPERTIES:
//   1. Confidentiality: XChaCha20 stream cipher.
//   2. Integrity: Poly1305 MAC authenticates ciphertext + tag + AAD.
//   3. AAD binding: aad = "${schema_version}|${table_name}|${row_id}".
//      An attacker who swaps blobs across tables or rows fails authentication
//      on decrypt because the AAD won't match. This is the primary anti-
//      tampering defence for cross-table blob swap attacks (A3).
//   4. Quarantine on AEAD fail: callers MUST check the return value and
//      route failures to sync_quarantine. Never apply a failed blob.
//   5. Key never crosses IPC: this module runs in the main process only.
//      The renderer calls sync.* RPCs; the key material stays here.
//
// File payload wire format (per brief §2 S2):
//   MAGIC(4) || VERSION(1) || NONCE(24) || CIPHERTEXT+TAG(N+16)
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
/** Payload version byte. Increment when wire format changes. */
const PAYLOAD_VERSION = 1;
const NONCE_BYTES = 24; // XChaCha20 nonce length
const KEY_BYTES = 32;   // libsodium secret-key length

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
  /** Associated data: "${schema_version}|${table_name}|${row_id}" */
  aad: string;
}

export interface EncryptResult {
  /** Wire-format payload ready for git commit. */
  payload: Buffer;
}

export interface DecryptParams {
  /** 32-byte symmetric master key. */
  key: Uint8Array;
  /** Raw payload bytes read from the git object. */
  payload: Buffer;
  /** Associated data that MUST match the value used during encryption. */
  aad: string;
}

export type DecryptResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; reason: 'aead_fail' | 'malformed' | 'unknown_version' };

// ------------------------------------------------------------------
// AAD construction (exported for tests and engine consistency)
// ------------------------------------------------------------------

/**
 * Build the canonical AAD string that binds a ciphertext blob to its row.
 *
 * Format: "${schema_version}|${table_name}|${row_id}"
 *
 * The schema_version is a monotonically increasing integer matching the
 * application's current migration ceiling. It ensures that a blob encrypted
 * under schema N cannot be silently applied when the local app is at schema M.
 * That case is caught earlier (schema-version header check) but AAD adds
 * defence-in-depth.
 */
export function buildAad(schemaVersion: number, tableName: string, rowId: string): string {
  if (!tableName) throw new Error('crypto.buildAad: tableName is required');
  if (!rowId) throw new Error('crypto.buildAad: rowId is required');
  return `${schemaVersion}|${tableName}|${rowId}`;
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
 * Encrypt plaintext with XChaCha20-Poly1305-IETF.
 *
 * The AAD MUST be built with `buildAad(schemaVersion, tableName, rowId)` so
 * the ciphertext is cryptographically bound to its row context.
 */
export async function encrypt(params: EncryptParams): Promise<EncryptResult> {
  await ensureReady();
  const { key, plaintext, aad } = params;
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

  // Wire format: MAGIC(4) | VERSION(1) | NONCE(24) | CIPHERTEXT+TAG(N+16)
  const payload = Buffer.concat([
    MAGIC,
    Buffer.from([PAYLOAD_VERSION]),
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
 * Returns `{ ok: true, plaintext }` on success.
 * Returns `{ ok: false, reason }` on ANY failure — AEAD verification
 * failure, malformed header, or unknown version. The caller MUST route
 * failures to `sync_quarantine` and NEVER apply the blob.
 *
 * The AAD MUST be the identical string used during encryption for the
 * authentication tag to verify. If the blob was moved to a different row
 * or table, decryption will fail with `reason: 'aead_fail'`.
 */
export async function decrypt(params: DecryptParams): Promise<DecryptResult> {
  await ensureReady();
  const { key, payload, aad } = params;
  assertKeyLength(key);

  // Minimum size: MAGIC(4) + VERSION(1) + NONCE(24) + TAG(16) = 45 bytes.
  if (payload.length < 4 + 1 + NONCE_BYTES + 16) {
    return { ok: false, reason: 'malformed' };
  }

  // Check magic bytes.
  if (!payload.slice(0, 4).equals(MAGIC)) {
    return { ok: false, reason: 'malformed' };
  }

  // Check version.
  const version = payload[4];
  if (version !== PAYLOAD_VERSION) {
    return { ok: false, reason: 'unknown_version' };
  }

  const nonce = new Uint8Array(payload.buffer, payload.byteOffset + 5, NONCE_BYTES);
  const ciphertextWithTag = new Uint8Array(
    payload.buffer,
    payload.byteOffset + 5 + NONCE_BYTES,
    payload.length - 5 - NONCE_BYTES,
  );
  const aadBytes = sodium.from_string(aad);

  try {
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, // nsec: not used
      ciphertextWithTag,
      aadBytes,
      nonce,
      key,
    );
    return { ok: true, plaintext };
  } catch {
    // libsodium throws on AEAD verification failure.
    return { ok: false, reason: 'aead_fail' };
  }
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
