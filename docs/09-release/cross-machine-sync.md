# Cross-machine sync

> Available in SigmaLink v1.5.0 and later. Opt-in — disabled by default.

Cross-machine sync lets you access your SigmaLink sessions, conversations, memories, tasks, and swarms on multiple devices. Your data is end-to-end encrypted using a key that never leaves your devices.

---

## Quick start

1. Create a **private** git repository on GitHub, GitLab, Gitea, or any self-hosted server.
2. Open **Settings → Sync** and click **Set up sync**.
3. Enter the repository URL and optional credentials (personal access token for HTTPS).
4. Write down your **24-word recovery phrase** and store it somewhere safe.
5. Type the phrase back to confirm you have saved it.
6. Done — sync runs automatically every ~30 seconds in the background.

To sync a second device, install SigmaLink, go to **Settings → Sync → Set up sync**, enter the same repository URL, and choose **Recover from phrase** to enter your 24 words.

---

## Security

### Who can read my synced data?

**Only you.** Every row is encrypted with XChaCha20-Poly1305 (the same construction used by Signal and 1Password) before it is committed to your git repository. Your git host — GitHub, GitLab, or your self-hosted server — only sees opaque encrypted blobs. It cannot read your conversations, memories, or any other data.

The encryption key is stored in your operating system's secure keychain (Keychain on macOS, DPAPI on Windows, libsecret on Linux) and never leaves your device in plaintext. It is never transmitted over IPC to the renderer process.

### What happens if I lose my recovery phrase?

If you lose both your 24-word recovery phrase **and** all of your SigmaLink devices, your synced data is **permanently unrecoverable**. SigmaLink cannot recover it — there is no escrow, no backup, and no override. This is intentional and matches the policy used by Signal.

If you lose a device but still have your recovery phrase, you can recover by installing SigmaLink on the new device and entering the phrase during sync setup.

If you still have at least one device, your data is safe even without the phrase (it is stored locally and in your git repository as ciphertext).

### Can SigmaLink see my conversations?

No. SigmaLink has no servers involved in sync. Data travels from your device to your own git repository and back. The SigmaLink application itself has no access to your git credentials or your encryption key.

### What about my API keys and tokens?

Provider API tokens (OpenAI, Anthropic, etc.) are stored in a device-local keychain and are **never** included in sync. They are encrypted with a device-specific key that does not exist on any other device and cannot be reconstructed from the recovery phrase. This is an explicit hard-deny in the sync scope.

---

## What gets synced

| Data | Synced |
|---|---|
| Workspaces | Yes |
| Agent sessions | Yes |
| Swarms and swarm messages | Yes |
| Conversations and messages | Yes |
| Sigma pane events | Yes |
| Memories and memory graph | Yes |
| Tasks and comments | Yes |
| Canvases and dispatches | Yes |
| Boards | Yes |
| Swarm origins and replay snapshots | Yes |
| Provider API tokens / credentials | **Never** |
| UI state (kv, browser tabs) | No |
| Skills and skill state | No |

---

## Conflicts

If you edit the same row on two devices simultaneously (for example, edit a task title on both your laptop and desktop before the next sync cycle), SigmaLink records a **conflict**. The newer write (by timestamp) wins automatically. Both versions are preserved in the conflict log so you can review them in **Settings → Sync → Review conflicts**.

Unresolved conflicts auto-resolve after 7 days (newer wall-clock timestamp wins).

---

## Schema upgrades

If one of your devices is running a newer version of SigmaLink with schema changes, blobs from that device are held in a queue on older devices until they are updated. You will see a notice in **Settings → Sync**: "N sync blobs pending schema upgrade. Update SigmaLink to apply."

---

## Threat model

SigmaLink sync defends against:

- **Curious git host** — ciphertext only in the remote; no plaintext ever committed.
- **Network attacker** — git's TLS/SSH transport + AEAD encryption provide defence-in-depth.
- **Tampered blobs** — every blob is authenticated with AAD bound to its table name and row ID. A tampered or swapped blob fails decryption and is quarantined, never applied.
- **OS user isolation** — the sync key is sealed to the (OS user, app) tuple via safeStorage. Another OS user on the same machine cannot unseal the key.

**Explicit non-goals for v1.5.0:**

- Multi-user shared remote (sync is single-user, multi-device only).
- Post-quantum cryptography (revisit when libsodium adds a PQ-ready KEM).
- Side-channel attacks on the local machine.

---

## Privacy notes

- Commit timestamps and author email (`sigma-sync@localhost`) are visible to your git host. No real email or username is written to commits.
- Workspace `rootPath` values (e.g. `/Users/you/projects/myproject`) are encrypted but present in the sync payload. If you want to hide project path names from cross-device analysis, use the "anonymise paths" toggle in Settings → Sync (shows `~/projects/myproject` instead).
- Machine IDs are random 16-byte values with no connection to your device hostname or any personally identifiable information.
