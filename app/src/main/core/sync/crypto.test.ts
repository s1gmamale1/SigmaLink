// v1.5.0 packet 09 — Crypto module tests.
// Target: 100% branch coverage on crypto.ts.
//
// Tests:
//   - Encrypt → decrypt round-trip succeeds.
//   - Correct AAD verifies; swapped AAD fails with 'aead_fail'.
//   - Tampered ciphertext fails with 'aead_fail'.
//   - Malformed payloads (wrong magic, truncated) fail with 'malformed'.
//   - Wrong version byte fails with 'unknown_version'.
//   - Wrong key fails with 'aead_fail'.
//   - buildAad format and validation.
//   - generateKey produces 32 bytes.
//   - Key length enforcement.
//   - timingSafeEqual.

import { describe, expect, it } from 'vitest';
import {
  encrypt,
  decrypt,
  generateKey,
  buildAad,
  timingSafeEqual,
} from './crypto';

const SCHEMA_V = 19;
const TABLE = 'conversations';
const ROW_ID = 'row-abc-123';

async function makeKey(): Promise<Uint8Array> {
  return generateKey();
}

describe('buildAad', () => {
  it('produces the canonical format', () => {
    const aad = buildAad(19, 'conversations', 'row-1');
    expect(aad).toBe('19|conversations|row-1');
  });

  it('throws on empty tableName', () => {
    expect(() => buildAad(1, '', 'id')).toThrow('tableName is required');
  });

  it('throws on empty rowId', () => {
    expect(() => buildAad(1, 'table', '')).toThrow('rowId is required');
  });

  it('encodes schema version as decimal integer', () => {
    expect(buildAad(0, 't', 'r').startsWith('0|')).toBe(true);
    expect(buildAad(100, 't', 'r').startsWith('100|')).toBe(true);
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

describe('encrypt → decrypt round-trip', () => {
  it('decrypts to the original plaintext (string input)', async () => {
    const key = await makeKey();
    const aad = buildAad(SCHEMA_V, TABLE, ROW_ID);
    const plaintext = JSON.stringify({ id: ROW_ID, content: 'hello sync' });

    const { payload } = await encrypt({ key, plaintext, aad });
    const result = await decrypt({ key, payload, aad });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrowing
    const decoded = new TextDecoder().decode(result.plaintext);
    expect(decoded).toBe(plaintext);
  });

  it('decrypts to the original plaintext (Uint8Array input)', async () => {
    const key = await makeKey();
    const aad = buildAad(SCHEMA_V, TABLE, ROW_ID);
    const raw = new TextEncoder().encode('binary content');

    const { payload } = await encrypt({ key, plaintext: raw, aad });
    const result = await decrypt({ key, payload, aad });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(timingSafeEqual(result.plaintext, raw)).toBe(true);
  });

  it('two encryptions of the same plaintext produce different payloads (random nonce)', async () => {
    const key = await makeKey();
    const aad = buildAad(SCHEMA_V, TABLE, ROW_ID);
    const plaintext = 'same content';

    const { payload: p1 } = await encrypt({ key, plaintext, aad });
    const { payload: p2 } = await encrypt({ key, plaintext, aad });

    expect(p1.equals(p2)).toBe(false);
  });

  it('encrypted payload has the correct magic bytes', async () => {
    const key = await makeKey();
    const { payload } = await encrypt({
      key,
      plaintext: 'test',
      aad: buildAad(SCHEMA_V, TABLE, ROW_ID),
    });

    // MAGIC: 'SGSY' = 0x53 0x47 0x53 0x59
    expect(payload[0]).toBe(0x53);
    expect(payload[1]).toBe(0x47);
    expect(payload[2]).toBe(0x53);
    expect(payload[3]).toBe(0x59);
  });

  it('encrypted payload has version byte 1', async () => {
    const key = await makeKey();
    const { payload } = await encrypt({
      key,
      plaintext: 'test',
      aad: buildAad(SCHEMA_V, TABLE, ROW_ID),
    });
    expect(payload[4]).toBe(1);
  });
});

describe('AAD binding (anti-tampering)', () => {
  it('fails with aead_fail when AAD is swapped to different table', async () => {
    const key = await makeKey();
    const encryptAad = buildAad(SCHEMA_V, 'conversations', ROW_ID);
    const decryptAad = buildAad(SCHEMA_V, 'tasks', ROW_ID); // different table

    const { payload } = await encrypt({ key, plaintext: 'secret', aad: encryptAad });
    const result = await decrypt({ key, payload, aad: decryptAad });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('aead_fail');
  });

  it('fails with aead_fail when AAD is swapped to different row_id', async () => {
    const key = await makeKey();
    const encryptAad = buildAad(SCHEMA_V, TABLE, 'row-A');
    const decryptAad = buildAad(SCHEMA_V, TABLE, 'row-B'); // different row

    const { payload } = await encrypt({ key, plaintext: 'secret', aad: encryptAad });
    const result = await decrypt({ key, payload, aad: decryptAad });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('aead_fail');
  });

  it('fails with aead_fail when schema version differs', async () => {
    const key = await makeKey();
    const encryptAad = buildAad(19, TABLE, ROW_ID);
    const decryptAad = buildAad(20, TABLE, ROW_ID); // newer schema

    const { payload } = await encrypt({ key, plaintext: 'secret', aad: encryptAad });
    const result = await decrypt({ key, payload, aad: decryptAad });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('aead_fail');
  });
});

describe('tampering detection', () => {
  it('fails with aead_fail on single-byte ciphertext modification', async () => {
    const key = await makeKey();
    const aad = buildAad(SCHEMA_V, TABLE, ROW_ID);

    const { payload } = await encrypt({ key, plaintext: 'important data', aad });
    // Flip a byte in the ciphertext region (after magic+version+nonce = 29 bytes)
    const tampered = Buffer.from(payload);
    tampered[30] ^= 0x01;

    const result = await decrypt({ key, payload: tampered, aad });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('aead_fail');
  });

  it('fails with aead_fail on wrong key', async () => {
    const key1 = await makeKey();
    const key2 = await makeKey();
    const aad = buildAad(SCHEMA_V, TABLE, ROW_ID);

    const { payload } = await encrypt({ key: key1, plaintext: 'secret', aad });
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
    const aad = buildAad(SCHEMA_V, TABLE, ROW_ID);

    const { payload } = await encrypt({ key, plaintext: 'test', aad });
    const bad = Buffer.from(payload);
    bad[0] = 0x00; // corrupt magic

    const result = await decrypt({ key, payload: bad, aad });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed');
  });

  it('returns unknown_version when version byte is unrecognised', async () => {
    const key = await makeKey();
    const aad = buildAad(SCHEMA_V, TABLE, ROW_ID);

    const { payload } = await encrypt({ key, plaintext: 'test', aad });
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
    const aad = buildAad(SCHEMA_V, TABLE, ROW_ID);
    await expect(encrypt({ key: shortKey, plaintext: 'x', aad })).rejects.toThrow(
      'key must be exactly 32 bytes',
    );
  });

  it('throws when decrypt key is not 32 bytes', async () => {
    const key = await makeKey();
    const aad = buildAad(SCHEMA_V, TABLE, ROW_ID);
    const { payload } = await encrypt({ key, plaintext: 'x', aad });
    await expect(decrypt({ key: new Uint8Array(16), payload, aad })).rejects.toThrow(
      'key must be exactly 32 bytes',
    );
  });
});
