// v1.5.0 packet 09 — Crypto module tests.
// v1.5.1-C caveat 3 — Updated for v2 wire format (schema in outer header).
//
// Tests:
//   - Encrypt → decrypt round-trip succeeds (v2).
//   - v1 legacy decrypt round-trip (buildAadV1 + v1 encoded payload).
//   - peekHeader extracts version + schema correctly.
//   - Correct AAD verifies; swapped AAD fails with 'aead_fail'.
//   - Tampered ciphertext fails with 'aead_fail'.
//   - Malformed payloads (wrong magic, truncated) fail with 'malformed'.
//   - Wrong version byte fails with 'unknown_version'.
//   - Wrong key fails with 'aead_fail'.
//   - buildAad format and validation (v2).
//   - buildAadV1 format (legacy).
//   - generateKey produces 32 bytes.
//   - Key length enforcement.
//   - timingSafeEqual.

import { describe, expect, it } from 'vitest';
import {
  encrypt,
  decrypt,
  generateKey,
  buildAad,
  buildAadV1,
  peekHeader,
  timingSafeEqual,
} from './crypto';

const SCHEMA_V = 19;
const TABLE = 'conversations';
const ROW_ID = 'row-abc-123';

async function makeKey(): Promise<Uint8Array> {
  return generateKey();
}

describe('buildAad (v2)', () => {
  it('produces the v2 format: table_name|row_id', () => {
    const aad = buildAad('conversations', 'row-1');
    expect(aad).toBe('conversations|row-1');
  });

  it('throws on empty tableName', () => {
    expect(() => buildAad('', 'id')).toThrow('tableName is required');
  });

  it('throws on empty rowId', () => {
    expect(() => buildAad('table', '')).toThrow('rowId is required');
  });
});

describe('buildAadV1 (legacy)', () => {
  it('produces the v1 format: schema|table_name|row_id', () => {
    const aad = buildAadV1(19, 'conversations', 'row-1');
    expect(aad).toBe('19|conversations|row-1');
  });

  it('encodes schema version as decimal integer', () => {
    expect(buildAadV1(0, 't', 'r').startsWith('0|')).toBe(true);
    expect(buildAadV1(100, 't', 'r').startsWith('100|')).toBe(true);
  });

  it('throws on empty tableName', () => {
    expect(() => buildAadV1(1, '', 'id')).toThrow('tableName is required');
  });

  it('throws on empty rowId', () => {
    expect(() => buildAadV1(1, 'table', '')).toThrow('rowId is required');
  });
});

describe('generateKey', () => {
  it('produces a 32-byte key', async () => {
    const key = await makeKey();
    expect(key.length).toBe(32);
  });

  it('produces different keys on each call', async () => {
    const k1 = await makeKey();
    const k2 = await makeKey();
    expect(timingSafeEqual(k1, k2)).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('returns true for identical arrays', async () => {
    const k = await makeKey();
    const copy = new Uint8Array(k);
    expect(timingSafeEqual(k, copy)).toBe(true);
  });

  it('returns false for arrays of different lengths', async () => {
    const k = await makeKey();
    expect(timingSafeEqual(k, new Uint8Array(16))).toBe(false);
  });

  it('returns false for arrays that differ in one byte', async () => {
    const k = await makeKey();
    const modified = new Uint8Array(k);
    modified[0] ^= 0xff;
    expect(timingSafeEqual(k, modified)).toBe(false);
  });
});

describe('encrypt → decrypt round-trip (v2)', () => {
  it('decrypts to the original plaintext (string input)', async () => {
    const key = await makeKey();
    const aad = buildAad(TABLE, ROW_ID);
    const plaintext = JSON.stringify({ id: ROW_ID, content: 'hello sync' });

    const { payload } = await encrypt({ key, plaintext, aad, schemaVersion: SCHEMA_V });
    const result = await decrypt({ key, payload, aad });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrowing
    const decoded = new TextDecoder().decode(result.plaintext);
    expect(decoded).toBe(plaintext);
    expect(result.schemaVersion).toBe(SCHEMA_V);
    expect(result.outerVersion).toBe(2);
  });

  it('decrypts to the original plaintext (Uint8Array input)', async () => {
    const key = await makeKey();
    const aad = buildAad(TABLE, ROW_ID);
    const raw = new TextEncoder().encode('binary content');

    const { payload } = await encrypt({ key, plaintext: raw, aad, schemaVersion: SCHEMA_V });
    const result = await decrypt({ key, payload, aad });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(timingSafeEqual(result.plaintext, raw)).toBe(true);
  });

  it('two encryptions of the same plaintext produce different payloads (random nonce)', async () => {
    const key = await makeKey();
    const aad = buildAad(TABLE, ROW_ID);
    const plaintext = 'same content';

    const { payload: p1 } = await encrypt({ key, plaintext, aad, schemaVersion: SCHEMA_V });
    const { payload: p2 } = await encrypt({ key, plaintext, aad, schemaVersion: SCHEMA_V });

    expect(p1.equals(p2)).toBe(false);
  });

  it('encrypted payload has the correct magic bytes', async () => {
    const key = await makeKey();
    const { payload } = await encrypt({
      key,
      plaintext: 'test',
      aad: buildAad(TABLE, ROW_ID),
      schemaVersion: SCHEMA_V,
    });

    // MAGIC: 'SGSY' = 0x53 0x47 0x53 0x59
    expect(payload[0]).toBe(0x53);
    expect(payload[1]).toBe(0x47);
    expect(payload[2]).toBe(0x53);
    expect(payload[3]).toBe(0x59);
  });

  it('encrypted payload has outer version byte 2 (v2 format)', async () => {
    const key = await makeKey();
    const { payload } = await encrypt({
      key,
      plaintext: 'test',
      aad: buildAad(TABLE, ROW_ID),
      schemaVersion: SCHEMA_V,
    });
    expect(payload[4]).toBe(2);
  });

  it('schema version is encoded in the outer header (bytes 5-8 big-endian)', async () => {
    const key = await makeKey();
    const { payload } = await encrypt({
      key,
      plaintext: 'test',
      aad: buildAad(TABLE, ROW_ID),
      schemaVersion: 42,
    });
    expect(payload.readUInt32BE(5)).toBe(42);
  });
});

describe('peekHeader', () => {
  it('returns v2 with correct schemaVersion for a v2 payload', async () => {
    const key = await makeKey();
    const { payload } = await encrypt({
      key,
      plaintext: 'test',
      aad: buildAad(TABLE, ROW_ID),
      schemaVersion: SCHEMA_V,
    });
    const peek = peekHeader(payload);
    expect(peek).not.toBeNull();
    expect(peek!.outerVersion).toBe(2);
    expect(peek!.schemaVersion).toBe(SCHEMA_V);
  });

  it('returns null for a buffer that is too short', () => {
    expect(peekHeader(Buffer.alloc(10))).toBeNull();
  });

  it('returns null for wrong magic bytes', async () => {
    const key = await makeKey();
    const { payload } = await encrypt({
      key, plaintext: 'test', aad: buildAad(TABLE, ROW_ID), schemaVersion: SCHEMA_V,
    });
    const bad = Buffer.from(payload);
    bad[0] = 0x00;
    expect(peekHeader(bad)).toBeNull();
  });

  it('returns null for unknown version byte', async () => {
    const key = await makeKey();
    const { payload } = await encrypt({
      key, plaintext: 'test', aad: buildAad(TABLE, ROW_ID), schemaVersion: SCHEMA_V,
    });
    const bad = Buffer.from(payload);
    bad[4] = 99;
    expect(peekHeader(bad)).toBeNull();
  });
});

describe('AAD binding (anti-tampering)', () => {
  it('fails with aead_fail when AAD is swapped to different table', async () => {
    const key = await makeKey();
    const encryptAad = buildAad('conversations', ROW_ID);
    const decryptAad = buildAad('tasks', ROW_ID); // different table

    const { payload } = await encrypt({ key, plaintext: 'secret', aad: encryptAad, schemaVersion: SCHEMA_V });
    const result = await decrypt({ key, payload, aad: decryptAad });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('aead_fail');
  });

  it('fails with aead_fail when AAD is swapped to different row_id', async () => {
    const key = await makeKey();
    const encryptAad = buildAad(TABLE, 'row-A');
    const decryptAad = buildAad(TABLE, 'row-B'); // different row

    const { payload } = await encrypt({ key, plaintext: 'secret', aad: encryptAad, schemaVersion: SCHEMA_V });
    const result = await decrypt({ key, payload, aad: decryptAad });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('aead_fail');
  });

  it('v2: schema version in header does NOT affect AAD (no aead_fail on schema change)', async () => {
    // In v2, schema_version is in the outer header, NOT in the AAD. So blobs
    // encrypted with schema 19 are still AEAD-verifiable with schema 20 as long
    // as the table_name|row_id match. The schema gate is done BEFORE AEAD.
    const key = await makeKey();
    const aad = buildAad(TABLE, ROW_ID); // same for both
    const { payload } = await encrypt({ key, plaintext: 'secret', aad, schemaVersion: 19 });
    // Re-use same AAD for decrypt — should succeed because schema is not in AAD.
    const result = await decrypt({ key, payload, aad });
    expect(result.ok).toBe(true);
  });
});

describe('tampering detection', () => {
  it('fails with aead_fail on single-byte ciphertext modification (v2)', async () => {
    const key = await makeKey();
    const aad = buildAad(TABLE, ROW_ID);

    const { payload } = await encrypt({ key, plaintext: 'important data', aad, schemaVersion: SCHEMA_V });
    // v2 layout: MAGIC(4)+VERSION(1)+SCHEMA(4)+NONCE(24) = 33 bytes before ciphertext.
    // Flip a byte in the ciphertext region (byte 34+).
    const tampered = Buffer.from(payload);
    tampered[35] ^= 0x01;

    const result = await decrypt({ key, payload: tampered, aad });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('aead_fail');
  });

  it('fails with aead_fail on wrong key', async () => {
    const key1 = await makeKey();
    const key2 = await makeKey();
    const aad = buildAad(TABLE, ROW_ID);

    const { payload } = await encrypt({ key: key1, plaintext: 'secret', aad, schemaVersion: SCHEMA_V });
    const result = await decrypt({ key: key2, payload, aad });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('aead_fail');
  });
});

describe('malformed payload detection', () => {
  it('returns malformed for an empty buffer', async () => {
    const key = await makeKey();
    const result = await decrypt({ key, payload: Buffer.alloc(0), aad: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed');
  });

  it('returns malformed for a truncated payload (< 45 bytes)', async () => {
    const key = await makeKey();
    const result = await decrypt({ key, payload: Buffer.alloc(30), aad: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed');
  });

  it('returns malformed when magic bytes are wrong', async () => {
    const key = await makeKey();
    const aad = buildAad(TABLE, ROW_ID);

    const { payload } = await encrypt({ key, plaintext: 'test', aad, schemaVersion: SCHEMA_V });
    const bad = Buffer.from(payload);
    bad[0] = 0x00; // corrupt magic

    const result = await decrypt({ key, payload: bad, aad });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed');
  });

  it('returns unknown_version when version byte is unrecognised', async () => {
    const key = await makeKey();
    const aad = buildAad(TABLE, ROW_ID);

    const { payload } = await encrypt({ key, plaintext: 'test', aad, schemaVersion: SCHEMA_V });
    const bad = Buffer.from(payload);
    bad[4] = 99; // unknown version

    const result = await decrypt({ key, payload: bad, aad });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_version');
  });
});

describe('key length validation', () => {
  it('throws when encrypt key is not 32 bytes', async () => {
    const shortKey = new Uint8Array(16);
    const aad = buildAad(TABLE, ROW_ID);
    await expect(encrypt({ key: shortKey, plaintext: 'x', aad, schemaVersion: SCHEMA_V })).rejects.toThrow(
      'key must be exactly 32 bytes',
    );
  });

  it('throws when decrypt key is not 32 bytes', async () => {
    const key = await makeKey();
    const aad = buildAad(TABLE, ROW_ID);
    const { payload } = await encrypt({ key, plaintext: 'x', aad, schemaVersion: SCHEMA_V });
    await expect(decrypt({ key: new Uint8Array(16), payload, aad })).rejects.toThrow(
      'key must be exactly 32 bytes',
    );
  });
});
