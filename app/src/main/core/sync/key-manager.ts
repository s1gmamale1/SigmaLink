// v1.5.0 packet 09 — Sync key manager.
//
// Wraps the existing CredentialStore (safeStorage per-device) to store and
// retrieve the 32-byte sync master key and machine ID.
//
// SECURITY CONTRACT:
//   - The key NEVER leaves this module as a plain value visible to the renderer.
//   - Renderer calls sync.* RPCs. The main process calls withKey() to get a
//     transient reference valid for the duration of one push/pull cycle.
//   - Key material is held in a Uint8Array; when done, callers SHOULD zero it
//     (see withKey helper).
//   - No key field is ever serialised into any IPC response.
//
// Key recovery: user enters their 24-word BIP-39 mnemonic → decodeMnemonic()
// → store via init(). This is the ONLY recovery path (S8: unrecoverable on
// full mnemonic + all-device loss).

import { CredentialStore } from '../credentials/storage';
import { decodeMnemonic, encodeMnemonic } from './mnemonic';
import { generateKey } from './crypto';
import { generateMachineId } from './hlc';

// ------------------------------------------------------------------
// Credential store keys
// ------------------------------------------------------------------

const CRED_KEY_SYNC_MASTER = 'sync.masterKey';
const CRED_KEY_MACHINE_ID = 'sync.machineId';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface SyncKeyInitResult {
  /** 24-word BIP-39 mnemonic — SHOW ONCE, then discard. */
  mnemonic: string;
}

// ------------------------------------------------------------------
// Key manager
// ------------------------------------------------------------------

export const KeyManager = {
  /**
   * Initialise sync on this device for the first time.
   * Generates a new random 32-byte key + 16-byte machine ID.
   * Stores both in the existing CredentialStore (safeStorage).
   * Returns the mnemonic — caller MUST display it and require typed-back
   * confirmation before proceeding.
   */
  async setupNew(): Promise<SyncKeyInitResult> {
    const keyBytes = await generateKey();
    const machineId = generateMachineId();
    const mnemonic = encodeMnemonic(keyBytes);

    await CredentialStore.set(
      CRED_KEY_SYNC_MASTER,
      Buffer.from(keyBytes).toString('hex'),
    );
    await CredentialStore.set(
      CRED_KEY_MACHINE_ID,
      Buffer.from(machineId).toString('hex'),
    );

    // Zero the transient key bytes after storing.
    keyBytes.fill(0);

    return { mnemonic };
  },

  /**
   * Recover sync on a new device using an existing mnemonic.
   * Decodes the mnemonic → extracts the key → stores in CredentialStore.
   * Also generates a new machine ID for this device (machine IDs are
   * per-device, NOT shared; they exist only to break HLC ties).
   *
   * Throws if the mnemonic is invalid (bad word, bad checksum).
   */
  async recoverFromMnemonic(mnemonic: string): Promise<void> {
    const keyBytes = decodeMnemonic(mnemonic); // throws on invalid
    const machineId = generateMachineId(); // new device, new ID

    await CredentialStore.set(
      CRED_KEY_SYNC_MASTER,
      Buffer.from(keyBytes).toString('hex'),
    );
    await CredentialStore.set(
      CRED_KEY_MACHINE_ID,
      Buffer.from(machineId).toString('hex'),
    );

    keyBytes.fill(0);
  },

  /**
   * Check whether this device has a sync key configured.
   */
  async isConfigured(): Promise<boolean> {
    const keyHex = await CredentialStore.get(CRED_KEY_SYNC_MASTER);
    return keyHex !== null && keyHex.length === 64;
  },

  /**
   * Export the mnemonic for the current device's key.
   * This is a sensitive one-shot operation — caller should re-prompt the
   * user for confirmation before invoking.
   *
   * Returns null if no key is configured.
   */
  async exportMnemonic(): Promise<string | null> {
    const keyHex = await CredentialStore.get(CRED_KEY_SYNC_MASTER);
    if (!keyHex || keyHex.length !== 64) return null;

    const keyBytes = Uint8Array.from(Buffer.from(keyHex, 'hex'));
    const mnemonic = encodeMnemonic(keyBytes);
    keyBytes.fill(0);
    return mnemonic;
  },

  /**
   * Load the sync master key for the duration of a callback.
   * The key reference is zeroed after the callback returns (even on throw).
   * This is the ONLY way to obtain the key — never cache the return value.
   *
   * Throws if no key is configured.
   *
   * SECURITY: The key Uint8Array is valid only inside the callback.
   * Callers MUST NOT retain a reference to it after the callback returns.
   */
  async withKey<T>(fn: (key: Uint8Array) => Promise<T>): Promise<T> {
    const keyHex = await CredentialStore.get(CRED_KEY_SYNC_MASTER);
    if (!keyHex || keyHex.length !== 64) {
      throw new Error('key-manager: no sync key configured on this device');
    }

    const keyBytes = Uint8Array.from(Buffer.from(keyHex, 'hex'));
    try {
      return await fn(keyBytes);
    } finally {
      keyBytes.fill(0);
    }
  },

  /**
   * Load the machine ID for this device.
   * Throws if sync has not been configured.
   */
  async getMachineId(): Promise<Uint8Array> {
    const idHex = await CredentialStore.get(CRED_KEY_MACHINE_ID);
    if (!idHex || idHex.length !== 32) {
      throw new Error('key-manager: no machine ID configured — run setupNew() or recoverFromMnemonic()');
    }
    return Uint8Array.from(Buffer.from(idHex, 'hex'));
  },

  /**
   * Remove sync key + machine ID from CredentialStore. Disables sync on
   * this device. Existing synced data in the local DB is NOT deleted.
   */
  async clear(): Promise<void> {
    await CredentialStore.remove(CRED_KEY_SYNC_MASTER);
    await CredentialStore.remove(CRED_KEY_MACHINE_ID);
  },
};

export type KeyManagerT = typeof KeyManager;
