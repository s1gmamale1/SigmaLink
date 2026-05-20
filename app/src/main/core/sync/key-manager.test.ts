// v1.5.0 packet 09 — KeyManager tests.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { KeyManager } from './key-manager';

// ------------------------------------------------------------------
// Mock CredentialStore
// ------------------------------------------------------------------
const store = new Map<string, string>();

vi.mock('../credentials/storage', () => ({
  CredentialStore: {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    remove: vi.fn(async (key: string) => {
      return store.delete(key);
    }),
  },
}));

beforeEach(() => {
  store.clear();
});

describe('KeyManager.setupNew', () => {
  it('returns a 24-word mnemonic', async () => {
    const { mnemonic } = await KeyManager.setupNew();
    expect(mnemonic.split(' ').length).toBe(24);
  });

  it('stores a 64-hex-char key in CredentialStore', async () => {
    await KeyManager.setupNew();
    const keyHex = store.get('sync.masterKey');
    expect(keyHex).toBeDefined();
    expect(keyHex!.length).toBe(64);
  });

  it('stores a 32-hex-char machine ID', async () => {
    await KeyManager.setupNew();
    const idHex = store.get('sync.machineId');
    expect(idHex).toBeDefined();
    expect(idHex!.length).toBe(32);
  });

  it('isConfigured returns true after setupNew', async () => {
    await KeyManager.setupNew();
    expect(await KeyManager.isConfigured()).toBe(true);
  });
});

describe('KeyManager.recoverFromMnemonic', () => {
  it('stores the recovered key', async () => {
    const { mnemonic } = await KeyManager.setupNew();
    store.clear();

    await KeyManager.recoverFromMnemonic(mnemonic);
    const keyHex = store.get('sync.masterKey');
    expect(keyHex).toBeDefined();
    expect(keyHex!.length).toBe(64);
  });

  it('the recovered key matches the original key', async () => {
    const { mnemonic } = await KeyManager.setupNew();
    const originalKey = store.get('sync.masterKey')!;
    store.clear();

    await KeyManager.recoverFromMnemonic(mnemonic);
    const recoveredKey = store.get('sync.masterKey')!;
    expect(recoveredKey).toBe(originalKey);
  });

  it('generates a new machine ID for the recovery device', async () => {
    const { mnemonic } = await KeyManager.setupNew();
    store.clear();

    await KeyManager.recoverFromMnemonic(mnemonic);
    // Machine ID should exist and be valid hex
    const recoveredMachineId = store.get('sync.machineId')!;
    expect(recoveredMachineId).toBeDefined();
    expect(recoveredMachineId.length).toBe(32);
    // NOTE: machine IDs CAN differ (new device gets new ID) — this is correct
    // per the brief (machine IDs are per-device, not shared)
    expect(recoveredMachineId).toBeDefined(); // just assert it exists
  });

  it('throws on invalid mnemonic', async () => {
    await expect(KeyManager.recoverFromMnemonic('invalid mnemonic')).rejects.toThrow();
  });
});

describe('KeyManager.isConfigured', () => {
  it('returns false when not configured', async () => {
    expect(await KeyManager.isConfigured()).toBe(false);
  });

  it('returns true after setup', async () => {
    await KeyManager.setupNew();
    expect(await KeyManager.isConfigured()).toBe(true);
  });
});

describe('KeyManager.withKey', () => {
  it('throws when no key is configured', async () => {
    await expect(KeyManager.withKey(async () => 'x')).rejects.toThrow(
      'no sync key configured',
    );
  });

  it('passes the 32-byte key to the callback', async () => {
    await KeyManager.setupNew();
    let observedLength = 0;
    await KeyManager.withKey(async (key) => {
      observedLength = key.length;
    });
    expect(observedLength).toBe(32);
  });

  it('zeros the key after the callback returns', async () => {
    await KeyManager.setupNew();
    let keyRef: Uint8Array | null = null;
    await KeyManager.withKey(async (key) => {
      keyRef = key;
    });
    // After withKey completes, the key bytes should be zeroed.
    expect(keyRef).not.toBeNull();
    const allZero = Array.from(keyRef!).every((b) => b === 0);
    expect(allZero).toBe(true);
  });

  it('zeros the key even if the callback throws', async () => {
    await KeyManager.setupNew();
    let keyRef: Uint8Array | null = null;
    try {
      await KeyManager.withKey(async (key) => {
        keyRef = key;
        throw new Error('callback error');
      });
    } catch {
      // expected
    }
    expect(keyRef).not.toBeNull();
    const allZero = Array.from(keyRef!).every((b) => b === 0);
    expect(allZero).toBe(true);
  });
});

describe('KeyManager.getMachineId', () => {
  it('throws when not configured', async () => {
    await expect(KeyManager.getMachineId()).rejects.toThrow('no machine ID configured');
  });

  it('returns 16 bytes after setup', async () => {
    await KeyManager.setupNew();
    const id = await KeyManager.getMachineId();
    expect(id.length).toBe(16);
  });
});

describe('KeyManager.exportMnemonic', () => {
  it('returns null when not configured', async () => {
    expect(await KeyManager.exportMnemonic()).toBeNull();
  });

  it('returns the original mnemonic after setup', async () => {
    const { mnemonic } = await KeyManager.setupNew();
    const exported = await KeyManager.exportMnemonic();
    expect(exported).toBe(mnemonic);
  });
});

describe('KeyManager.clear', () => {
  it('clears the key and machine ID', async () => {
    await KeyManager.setupNew();
    await KeyManager.clear();
    expect(await KeyManager.isConfigured()).toBe(false);
    expect(store.has('sync.masterKey')).toBe(false);
    expect(store.has('sync.machineId')).toBe(false);
  });
});
