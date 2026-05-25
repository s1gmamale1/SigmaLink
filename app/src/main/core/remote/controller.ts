// R-1 Lane B — Jorvis Telegram remote RPC controller (`telegram.*`).
//
// SECURITY-CRITICAL. Exposes the operator-facing surface for the Telegram
// bridge to the renderer's Settings → Telegram tab. The token is WRITE-ONLY:
// `setToken` persists into the encrypted CredentialStore and NEVER returns it;
// `getStatus` only reports a `tokenSet` boolean. `setToken` REFUSES with an
// error when at-rest encryption is unavailable (no plaintext secrets).
//
// Mutations that change the precondition gate (enable/token/allowlist) call
// `restart()` so the bridge re-evaluates whether it should be running.

import { defineController } from '../../../shared/rpc';
import type { AuditEntry } from './audit';
import {
  CRED_TELEGRAM_TOKEN,
  KV_TELEGRAM_ALLOWLIST,
  KV_TELEGRAM_ENABLED,
  KV_TELEGRAM_IDLE_LOCK_MIN,
  parseAllowlist,
  type BridgeStatusSnapshot,
  type CredentialStoreLike,
  type KvLike,
  type TelegramBridge,
} from './bridge';

export interface TelegramControllerDeps {
  bridge: TelegramBridge;
  kv: KvLike;
  credentials: CredentialStoreLike;
}

export function buildTelegramController(deps: TelegramControllerDeps) {
  const { bridge, kv, credentials } = deps;

  /** Re-evaluate the start gate after a config change. Best-effort. */
  async function restart(): Promise<void> {
    try {
      await bridge.stop();
    } catch {
      /* ignore */
    }
    try {
      await bridge.start();
    } catch {
      /* start swallows its own gate failures; ignore residual */
    }
  }

  return defineController({
    /** Operator-safe status. NEVER includes the token value. */
    getStatus: async (): Promise<BridgeStatusSnapshot> => {
      let token: string | null = null;
      try {
        token = await credentials.get(CRED_TELEGRAM_TOKEN);
      } catch {
        token = null;
      }
      return bridge.snapshot(token);
    },

    /**
     * Persist the bot token (encrypted). Refuses when encryption is
     * unavailable. Returns void — the token is NEVER echoed back.
     */
    setToken: async (token: string): Promise<void> => {
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new Error('telegram.setToken: token must be a non-empty string');
      }
      let encryptionAvailable = false;
      try {
        encryptionAvailable = credentials.isEncryptionAvailable();
      } catch {
        encryptionAvailable = false;
      }
      if (!encryptionAvailable) {
        throw new Error(
          'telegram.setToken: refusing to store a bot token without OS-level encryption. ' +
            'Install a system keyring (Keychain/DPAPI/libsecret) and retry.',
        );
      }
      await credentials.set(CRED_TELEGRAM_TOKEN, token.trim());
      await restart();
    },

    /** Remove the stored token + stop the bridge. */
    clearToken: async (): Promise<void> => {
      await credentials.remove(CRED_TELEGRAM_TOKEN);
      await restart();
    },

    /** Enable / disable the remote; restarts the gate evaluation. */
    setEnabled: async (enabled: boolean): Promise<void> => {
      kv.set(KV_TELEGRAM_ENABLED, enabled ? '1' : '0');
      await restart();
    },

    /** Replace the numeric chat-id allowlist. */
    setAllowlist: async (ids: number[]): Promise<void> => {
      if (!Array.isArray(ids)) {
        throw new Error('telegram.setAllowlist: ids must be an array of numbers');
      }
      const clean = Array.from(
        new Set(
          ids
            .map((v) => (typeof v === 'number' ? v : Number(v)))
            .filter((n) => Number.isInteger(n)),
        ),
      );
      kv.set(KV_TELEGRAM_ALLOWLIST, JSON.stringify(clean));
      await restart();
    },

    /** Set the idle auto-lock window (minutes; <=0 disables). */
    setIdleLockMinutes: async (minutes: number): Promise<void> => {
      const n = Number(minutes);
      const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      kv.set(KV_TELEGRAM_IDLE_LOCK_MIN, String(safe));
      await restart();
    },

    /** Manually lock the remote (drops inbound until unlocked). */
    lock: async (): Promise<void> => {
      bridge.lock();
    },

    /** Manually unlock. */
    unlock: async (): Promise<void> => {
      bridge.unlock();
    },

    /** Tail the audit log (newest first). */
    auditTail: async (n: number): Promise<AuditEntry[]> => {
      const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
      return bridge.auditTail(count);
    },
  });
}

/** Re-export so callers can read the current allowlist without importing bridge. */
export { parseAllowlist };
