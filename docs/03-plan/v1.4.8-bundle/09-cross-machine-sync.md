# Packet 09 — Cross-machine session sync (opt-in, e2ee, git-backed)

> **Effort**: L (~5-7d, +1d vs v1.4.7 brief for the hardened key-management + schema-version handshake). **Tier**: v1.4.8 headline feature.
> **Status**: **BLOCKED-ON-USER-SIGNOFF** — threat-model + key-management policy require lead approval before delegation. Sections marked LOCKED are final post-signoff; sections marked OPEN need a decision.
> **Delegate**: Sonnet (data layer + crypto wiring). Security review pass by Opus before merge.
> **Blocks**: nothing. **Blocked by**: lead signoff on S1/S5/S8 + S2 crypto-lib pick.

---

## 0. Why this brief is being re-issued

The v1.4.7 brief at `docs/03-plan/archive/v1.4.7-bundle/10-cross-machine-sync.md` was archived for two reasons:

1. **Bundle scope cut** — v1.4.7 shipped 6 paper-cuts + plumbing; sync was too large to land in the same release window.
2. **Security stakes** — the original brief committed to `age` + `keytar` + a hand-rolled lamport CRDT without locking the threat model first. Highest-blast-radius packet in the v1.4.8 bundle. SigmaLink rows contain conversation transcripts, AI tool outputs (which can leak shell history, file paths, secrets in command stdout) and Sigma's vector memory — a sync footgun here would be a customer-facing breach class, not a paper-cut.

This v1.4.8 re-issue locks: threat model (S1), crypto stack (S2), CRDT approach (S3), conflict policy (S4). It surfaces three OPEN questions (S5, S6, S8) that need lead sign-off.

## 1. Original brief — what stayed valid

Re-validated against current `main` (post-v1.4.7):

| Original claim | Status | Notes |
|---|---|---|
| User-owned git remote (no SigmaLink backend) | LOCKED-KEEP | Aligns with "user-owned storage" rule. |
| End-to-end encrypted (server sees only ciphertext) | LOCKED-KEEP | Non-negotiable. |
| Opt-in, default off, setup wizard | LOCKED-KEEP | Mount on `SettingsRoom.tsx` next to MCP/Voice tabs. |
| Append-only on remote, no `--force` | LOCKED-KEEP | Strengthened — see S4. |
| 30s push/pull interval | LOCKED-KEEP | Add jitter ±5s to avoid lockstep contention with peers. |
| Use `age` for crypto | **CHANGED** | See S2 — switching to libsodium (`@stablelib/*` or `libsodium-wrappers`) primitives. |
| `keytar` for key storage | **CHANGED** | See S5 — using existing Electron `safeStorage` + the already-shipping `CredentialStore` from migration 0002. No new keychain dep. |
| Hand-rolled `(machine_id, lamport_ts, row_hash)` CRDT | **REFINED** | See S3 — promoted to a hybrid logical clock (HLC) with a documented LWW policy. Yjs/Automerge rejected (size + dependency footprint). |
| Schema migration `0018_sync_metadata.sql` | LOCKED-KEEP | Next number confirmed: last migration on `main` is `0017_pane_split_columns.ts`, so this slot is `0018`. |
| Synced tables list | **CORRECTED** | Original brief used wrong names (e.g. `assistant_conversations`, `memory`). Real names: `conversations`, `messages`, `memories`, `sigma_pane_events`. See section 4. |
| Settings mount at `features/settings-room/` | **CORRECTED** | Real path: `app/src/renderer/features/settings/SettingsRoom.tsx`. |
| Credentials file at `credentials/store.ts` | **CORRECTED** | Real path: `app/src/main/core/credentials/storage.ts`. |

---

## 2. LOCKED threat model

### S1 — Adversaries (LOCKED, contingent on lead signoff)

The sync layer MUST defend against:

| Adversary | Capability | Defense |
|---|---|---|
| **A1 — Curious git host** (GitHub, Gitea, GitLab admin) | Can read all push contents, branch history, commit metadata, push timestamps. Cannot read OS keychain. | E2EE: only ciphertext + opaque filenames in the remote. No plaintext in commit messages, branch names, or filenames. Commit author email and timestamps ARE visible to the host — we accept this. |
| **A2 — Network attacker (in-flight)** | TLS interceptor, BGP hijack, MITM on coffee-shop wifi. | Git's existing TLS/SSH transport handles confidentiality + integrity in flight. Our payload is already encrypted, so this is defense-in-depth. |
| **A3 — Malicious cloud provider** | Same as A1 plus can tamper with stored blobs, drop pushes, replay old commits. | Detect: every sync blob is authenticated (XChaCha20-Poly1305 AEAD — see S2). Tampered blobs fail decryption and are quarantined to `sync_quarantine` table; never applied. Replay: HLC + per-row monotonic sequence (see S3) — replayed older blobs are no-ops because the local HLC has already advanced past them. |
| **A4 — Lost / stolen device (with screen-lock bypassed)** | Attacker has access to user's logged-in macOS account, can read the SQLite DB and the `safeStorage`-sealed sync key. | We do NOT defend against this — same threat model as the existing `CredentialStore` (provider API tokens already live in safeStorage). Document explicitly: cross-machine sync inherits OS-account-level security; if the OS user is compromised, sync data is compromised. Mitigation guidance in setup wizard: "use FileVault + a screen-lock password." |
| **A5 — User of a different OS account on the same machine** | Can read the SQLite DB file but cannot unseal safeStorage. | Defended by `safeStorage` — sync key blob is sealed to the (OS user, app) tuple. Other accounts see ciphertext only. |
| **A6 — Compromised dependency in the supply chain** | Attacker publishes a malicious patch to our crypto lib or sync engine. | Out of scope for this packet — covered by the broader dependency audit policy. Mitigation: prefer libsodium primitives (audited, widely used) over `age` JS ports (small audience, less battle-tested in Node). |

**NOT in threat model** (explicit non-goals):

- **A7 — Multi-user shared remote**. Sync is single-user, multi-device. We do not support multiple distinct users sharing a sync remote. Two users with the same recovery mnemonic would converge on a single logical "user" with two devices; we will document this is not a supported sharing mechanism.
- **A8 — Quantum adversary**. XChaCha20-Poly1305 + X25519 are not post-quantum. Acceptable for v1.4.8; revisit when libsodium adds a PQ-ready KEM.
- **A9 — Side-channel attacks on the local machine**. RowHammer, Spectre, malicious GPU drivers. Out of scope.

### S2 — Crypto stack (LOCKED — libsodium primitives, no `age`)

**Decision**: Use `libsodium-wrappers-sumo` (or `@stablelib/xchacha20poly1305` + `@stablelib/x25519` if dep size matters). **Drop `age`** from the brief.

**Why not `age`**:
- `age` is excellent crypto but the JS bindings (`age-encryption`, the `@codemirror/age-encryption` ref in the original brief is **not a real package** — that was a hallucinated import) are early-stage. The audited Go implementation requires shipping a Go binary OR using `rage` via napi bindings — both add 5-15MB to the Electron bundle.
- We do not need `age`'s recipient/identity abstraction. SigmaLink sync has exactly ONE recipient (the user's own sync identity). The complexity buys nothing for our use case.

**Why libsodium**:
- Audited, used by Signal/WhatsApp/1Password, widely deployed in Node.js.
- `libsodium-wrappers` is pure JS (compiled from C via Emscripten, ~200KB gzipped) — no native build step, ships fine into Electron's main process.
- Provides exactly the primitives we need: XChaCha20-Poly1305 AEAD (authenticated encryption with associated data), X25519 key exchange (if we add device-to-device sealed-box later), and Argon2id (passphrase KDF for recovery mnemonic, if S5 lands on the passphrase path).

**Stack**:

```
plaintext row JSON
  │
  ├─ randomBytes(24) → nonce
  ├─ key = sync-master-key (32 bytes, see S5)
  ├─ aad  = `${schema_version}|${table_name}|${row_id}` (binds ciphertext to row context — defends against blob swap)
  │
  ▼
crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, nonce, key)
  │
  ▼
file payload = magic("SGSY") || version(uint8=1) || nonce(24) || ciphertext+tag
```

The AAD (associated data) binding is the critical anti-tampering defense. An attacker who swaps `sync/blobs/000-machineA.bin` (containing a row from `conversations`) into the slot for a row from `tasks` will fail authentication on decrypt because the AAD won't match.

**Why not `tweetnacl`**: tweetnacl uses XSalsa20-Poly1305, which is fine cryptographically but the rest of the ecosystem (Argon2id KDF, sealed boxes for future device-to-device handshakes) is in libsodium. One library is simpler to audit than two.

### S3 — CRDT / merge model (LOCKED — HLC + LWW, not Yjs/Automerge)

**Decision**: Hybrid Logical Clock (HLC) per row + Last-Write-Wins resolution, with all "lost" writes preserved in `sync_conflicts` for user review.

**Why not Yjs / Automerge**:
- Both ship 50-200KB minimum and require restructuring every synced row into a CRDT document. We would have to migrate every conversation, message, and memory row into a Y.Doc / Automerge document — that is a 3-month refactor, not a v1.4.8 packet.
- Our edits are mostly INSERTs (new conversation, new message, new memory). True text-merge CRDTs add value when many parties co-edit one document concurrently. SigmaLink's actual concurrent-edit case is rare and resolvable as "show both, user picks."
- Conflict frequency expected: <1/week per user (single user, two devices, rarely both online editing the same row simultaneously).

**HLC schema** (replaces the original lamport-only design):

```
hlc = (wall_ms: int64, logical: uint16, machine_id: bytes16)
```

- `wall_ms`: local `Date.now()` at write time.
- `logical`: monotonic counter, increments when wall clock is non-monotonic or two HLCs are generated within the same ms.
- `machine_id`: random 16-byte device identifier generated at first sync setup (NOT the OS hostname — never leaks the machine name into the synced data).

**Comparison rule**: lexicographic on `(wall_ms, logical, machine_id)`. Higher = newer = wins. Ties on `(wall_ms, logical)` are tie-broken by `machine_id` bytes — deterministic across both peers.

**Why HLC over plain lamport**: wall_ms gives the UI a real "edited 3m ago" timestamp without storing it separately. Logical counter handles clock-skew (laptop battery dies, wall clock jumps forward 5h on resume). Lamport alone cannot distinguish "real recent edit" from "clock skewed forward."

### S4 — Conflict resolution policy (LOCKED — LWW with conflict log)

| Case | Policy |
|---|---|
| Row exists locally, doesn't exist remotely | No-op on pull. Pushed on next push. |
| Row exists remotely, not locally | INSERT. |
| Row in both, remote HLC strictly newer | UPDATE local row. Log to `sync_history` (audit only). |
| Row in both, local HLC strictly newer | No-op on pull. Will be pushed next cycle. |
| Row in both, HLCs concur (impossible if `machine_id` ties are broken — but defensive guard) | Treat as conflict. Insert into `sync_conflicts`. |
| Row in both, NEITHER HLC dominates because BOTH machines edited since the last common ancestor | This is the real conflict case. Both versions land in `sync_conflicts`. UI surfaces "Conflict needs review." Auto-default after 7d if unresolved: take the version with newer `wall_ms`. |
| Row deleted locally, edited remotely | Surface as conflict — user picks "keep the resurrected row" vs "re-delete." |
| Schema-version mismatch (remote blob from a newer SigmaLink) | Quarantine to `sync_pending_upgrade` until the local app reaches that schema. Display "Update SigmaLink to apply N pending syncs." |

**Tombstones** (LOCKED): deletes are synced as tombstone rows with `deleted_at` set. Tombstones GC'd after 30 days. Without tombstones, machine B re-resurrects rows that A deleted.

### S7 — Sync transport (LOCKED — git only, no WebDAV/S3)

Git stays. Reasons:

1. Users already have GitHub/Gitea accounts; zero new infra.
2. We get free history (audit log of every sync), free integrity (git's content-addressing), free push/pull semantics.
3. WebDAV is unencrypted-by-default and S3 requires AWS account setup — both worse UX.

**Library**: `isomorphic-git` (not `simple-git`). Reasons:
- Pure JS — no shell-out to system git, no PATH dependency, runs in renderer or main. Critical for an Electron app shipping to users who may not have git installed.
- Smaller (~600KB) than spawning a system git subprocess.
- We already vendor `isomorphic-git` indirectly via `@isomorphic-git/lightning-fs` candidates considered in v1.4.6 — confirm before commit.

**NOT in scope for v1.4.8**:
- LFS support (sync payload stays <1MB per blob).
- Submodule support.
- Custom git server protocols beyond HTTPS + SSH.

---

## 3. OPEN questions for lead

### S5 — Key management (OPEN — needs lead pick)

Three options. **Recommendation: Option B**.

**Option A — Passphrase-derived (high friction, no extra deps)**
- User memorises a passphrase at setup. Sync key derived via Argon2id(passphrase, salt).
- Pros: nothing to lose; works offline; same passphrase recovers on any device.
- Cons: user must type passphrase on every sync setup; weak passphrases = weak crypto; no recovery if forgotten.

**Option B — `safeStorage` per-device + recovery mnemonic (RECOMMENDED)**
- At first setup on device 1: generate random 32-byte master key + derive 24-word BIP-39 mnemonic.
- Store key in `CredentialStore` (existing — wraps Electron `safeStorage`).
- Setup wizard FORCES user to write down the mnemonic and type it back.
- Adding a second device: user enters mnemonic → key reconstituted → stored in that device's `safeStorage`.
- Pros: no passphrase prompts; key sealed to OS account; works offline; we already ship `CredentialStore`.
- Cons: lost-mnemonic = unrecoverable data (acceptable — match Signal's policy).

**Option C — Hardware key (YubiKey / Secure Enclave) (defer)**
- Pros: strongest defense.
- Cons: Mac-only for Secure Enclave; YubiKey forces hardware purchase. Too much friction for v1.4.8 GA.
- **Defer to v1.5.x as an opt-in upgrade.**

**Lead decision needed**: pick A, B, or C. Brief assumes B until told otherwise.

### S6 — Sync scope (OPEN — needs lead trim)

Original brief's table list, corrected against real schema:

| Real table | Sync? | Recommendation | Rationale |
|---|---|---|---|
| `workspaces` | YES | KEEP | Cross-device workspace registry. `rootPath` IS a privacy concern — see Risk 4. |
| `agent_sessions` | YES | KEEP | Core value: see pane history across devices. |
| `swarms`, `swarm_agents`, `swarm_messages`, `swarm_skills` | YES | KEEP | Same. |
| `conversations` | YES | KEEP | Headline feature. |
| `messages` | YES | KEEP | Same. |
| `sigma_pane_events` | YES | KEEP | Sigma's pane-observation history. |
| `memories`, `memory_links`, `memory_tags` | YES | KEEP | Vector memory is high-value. |
| `tasks`, `task_comments` | YES | KEEP | Cross-device TODOs. |
| `canvases`, `canvas_dispatches` | YES | RECOMMEND-KEEP | Sigma Canvas state. |
| `boards` | YES | RECOMMEND-KEEP | Per-agent board posts. |
| `swarm_origins`, `swarm_replay_snapshots` | YES | RECOMMEND-KEEP | Audit linkage. |
| `kv` | **NO** | SKIP | UI state per-device. |
| `skills`, `skill_provider_state` | **NO** | SKIP | Local install/enablement state. |
| `credentials` | **NEVER** | EXPLICIT-DENY | Provider API tokens — never sync. Encrypted at-rest with a device-local key that doesn't exist on other devices. |
| `session_review` | NO | SKIP | Per-device debugging. |
| `browser_tabs` | NO | SKIP | UI state — and could leak browsing history. |

**Lead decision needed**: confirm the explicit DENY of `credentials`. Confirm canvases/boards/origins/replay — these were not in the original brief.

### S8 — Replay / recovery (OPEN — needs lead policy)

What if the user loses both devices + the mnemonic?

| Stance | Implication |
|---|---|
| **"Sync data is unrecoverable — same as Signal"** (RECOMMENDED) | Setup wizard forces a paper-copy mnemonic write-down + confirms with re-entry. We log nothing. User accepts the risk. |
| "Optional escrow with SigmaLink" | Requires backend infra. Out of scope. |
| "Encrypted backup to a second cloud (Drive/iCloud)" | User must opt-in twice (sync + backup). Doubles attack surface. |

**Lead decision needed**: confirm the "unrecoverable" stance. If yes, the wizard must say so in plain language ("If you lose this mnemonic AND all your SigmaLink devices, your synced data is permanently unrecoverable. SigmaLink cannot help you recover it.").

---

## 4. Final delegation brief (post-signoff)

### Schema additions

```typescript
// migration 0018_sync_metadata.ts (NEW — slot confirmed available)
// Adds:
//   - sync_state: per-row HLC tracker
//   - sync_conflicts: surfaced LWW losers awaiting user review
//   - sync_history: audit log of applied remote writes (GC'd after 30d)
//   - sync_quarantine: blobs that failed decrypt/AEAD verify
//   - sync_pending_upgrade: blobs from a newer schema, queued
//   - sync_tombstones: row-deletion markers
//
// Columns kept narrow — NO plaintext bodies stored in sync_* tables (only
// row pointers + metadata). Conflict snapshots store JSON of the row at
// conflict time so the UI can render both versions.

CREATE TABLE IF NOT EXISTS sync_state (
  table_name        TEXT NOT NULL,
  row_id            TEXT NOT NULL,
  hlc_wall_ms       INTEGER NOT NULL,
  hlc_logical       INTEGER NOT NULL,
  hlc_machine_id    BLOB    NOT NULL,
  row_hash          TEXT    NOT NULL,
  dirty             INTEGER NOT NULL DEFAULT 0,
  last_pushed_at    INTEGER,
  PRIMARY KEY (table_name, row_id)
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id                 TEXT PRIMARY KEY,
  table_name         TEXT NOT NULL,
  row_id             TEXT NOT NULL,
  local_hlc_packed   BLOB NOT NULL,
  remote_hlc_packed  BLOB NOT NULL,
  remote_machine_id  BLOB NOT NULL,
  local_row_json     TEXT NOT NULL,
  remote_row_json    TEXT NOT NULL,
  resolved           INTEGER NOT NULL DEFAULT 0,
  resolution         TEXT,
  resolved_at        INTEGER,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_history (
  id           TEXT PRIMARY KEY,
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  applied_at   INTEGER NOT NULL,
  source       TEXT NOT NULL          -- 'remote' | 'conflict_resolution'
);

CREATE TABLE IF NOT EXISTS sync_quarantine (
  id           TEXT PRIMARY KEY,
  blob_path    TEXT NOT NULL,
  reason       TEXT NOT NULL,         -- 'aead_fail' | 'schema_unknown' | 'malformed'
  detected_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_pending_upgrade (
  id              TEXT PRIMARY KEY,
  blob_path       TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  queued_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_tombstones (
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  deleted_at   INTEGER NOT NULL,
  hlc_packed   BLOB NOT NULL,
  PRIMARY KEY (table_name, row_id)
);
```

### Files to touch (corrected paths)

#### Main process

- `app/src/main/core/db/migrations/0018_sync_metadata.ts` — NEW (slot confirmed available)
- `app/src/main/core/db/schema.ts` — register sync_* tables as Drizzle exports
- `app/src/main/core/db/migrate.ts` — register 0018
- `app/src/main/core/sync/crypto.ts` — NEW (libsodium XChaCha20-Poly1305 + AAD)
- `app/src/main/core/sync/hlc.ts` — NEW (hybrid logical clock)
- `app/src/main/core/sync/engine.ts` — NEW (push + pull orchestration)
- `app/src/main/core/sync/dirty-tracker.ts` — NEW (app-level write hooks; NO SQLite triggers — too brittle across migrations)
- `app/src/main/core/sync/conflict-resolver.ts` — NEW
- `app/src/main/core/sync/key-manager.ts` — NEW (wraps existing `CredentialStore` from `credentials/storage.ts` — no new keychain dep)
- `app/src/main/core/sync/git-client.ts` — NEW (isomorphic-git wrapper)
- `app/src/main/core/sync/mnemonic.ts` — NEW (BIP-39 encode/decode)
- `app/src/main/rpc-router.ts` — register: `sync.enable`, `sync.disable`, `sync.status`, `sync.listConflicts`, `sync.resolveConflict`, `sync.exportMnemonic` (one-shot, after re-prompt)
- Vitest for every file above (target 40+ tests; crypto module 100% branch coverage)

#### Renderer

- `app/src/renderer/features/settings/SyncTab.tsx` — NEW (mounted in `SettingsRoom.tsx` next to McpServersTab/VoiceTab — confirmed path)
- `app/src/renderer/features/sync-setup/SetupWizard.tsx` — NEW (5-step flow)
- `app/src/renderer/features/sync-setup/ConflictReview.tsx` — NEW (side-by-side row diff)
- `app/src/renderer/features/sync-setup/MnemonicConfirm.tsx` — NEW (forces typed-back verification)
- React-Testing-Library tests for each

#### Shared / Deps

- `app/src/shared/types.ts` — `SyncConfig`, `SyncStatus`, `SyncConflict`, `HlcPacked`
- `app/src/shared/router-shape.ts` — sync controller shape
- `app/package.json` — add **only**: `libsodium-wrappers-sumo`, `isomorphic-git`, `@isomorphic-git/lightning-fs` (if needed for in-memory clone caches). **Confirm `keytar` is NOT added** (we use existing safeStorage). No `age*`, no `yjs`, no `automerge`.

### Verification

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false
pnpm exec vitest run src/main/core/sync/       # NEW — target 40+ tests
pnpm exec eslint .
pnpm test:e2e                                    # two-machine smoke (see below)
```

Two-machine smoke (deferred to QA, recorded in PR):

1. Machine A: setup sync with private GitHub repo. Confirm first push.
2. Machine B: install SigmaLink, set up sync with same repo + same mnemonic. Confirm pull. Conversations from A appear.
3. Machine A: new conversation. Wait 30s. Machine B: confirms.
4. Concurrent edit: A and B simultaneously edit same conversation. Confirm conflict surfaces.
5. Resolve conflict → both machines converge.
6. **Tamper test**: manually corrupt one byte of a `sync/blobs/*.bin` on the remote. Confirm Machine B quarantines, does NOT apply.
7. **Replay test**: revert remote to an older commit. Confirm Machine B detects no progress (HLC didn't advance) and doesn't re-apply old rows.
8. **Schema-skew test**: Machine A on v1.4.8, Machine B on v1.4.9 with a new column. B's blob queued in `sync_pending_upgrade` on A until A updates.
9. Disable sync on B → local data stays. Re-enable → picks up where it left off.

### Risk register

| # | Risk | Mitigation |
|---|---|---|
| 1 | Mnemonic loss = data loss | Setup wizard forces typed-back confirmation. Onboarding doc + tooltip in Sync tab. |
| 2 | Push contention with peer device | Pre-push: `git pull --rebase` (isomorphic-git equivalent). On push failure: backoff + retry once. |
| 3 | Schema evolution | Every blob carries `schema_version`. Newer-than-local blobs queue. Older-than-current blobs apply with a per-table upgrade dispatch table (start empty in v1.4.8 — no historical blobs yet). |
| 4 | `rootPath` leaks (e.g., `/Users/jdoe/SuperSecretClient/`) — encrypted but visible to all the user's devices | Offer "anonymise paths" toggle: replace home prefixes with `~`. Document in Sync tab. |
| 5 | Sync key compromise via main-process bug | Key never crosses IPC. Renderer calls `sync.*` RPCs, never receives the key. Main process holds the unsealed key in memory only for the duration of a push/pull cycle. |
| 6 | DoS by oversized blobs | Hard limit: 1MB per row. Rows that exceed it (large `messages.content`?) are split into N chunks with a manifest blob — defer chunking implementation to a follow-up if no row hits the limit in v1.4.8 GA telemetry. |
| 7 | Filesystem race on the local sync-repo clone | One-process-at-a-time lock file at `~/.sigma/sync-repo/.lock`. Refuse to push/pull if held. |
| 8 | Commit metadata leak (author email/name) | Configure the local clone with `user.email = "sigma-sync@localhost"` and `user.name = "sigma"`. NEVER use the user's git global config. |

---

## 5. Open questions for lead (priority order)

1. **S5 — Key management**: confirm Option B (safeStorage + BIP-39 mnemonic) is acceptable. If no, lead picks A or defers to v1.5.x.
2. **S1 — Threat model**: confirm the "A4 lost-device → not defended" stance is documented adequately. Confirm A7/A8/A9 non-goals.
3. **S8 — Recovery policy**: confirm "unrecoverable on full mnemonic + device loss" stance.
4. **S6 — Sync scope**: confirm `credentials` is hard-DENY. Confirm canvases/boards/replay snapshots are in (or trim them).
5. **S2 — Crypto lib alternative**: lead may prefer `@stablelib/*` (smaller, lighter audit history) over `libsodium-wrappers-sumo` (larger, broader audit). Brief assumes libsodium until told otherwise.
6. **Effort budget**: brief estimates 5-7d. If lead wants <4d, scope-cut to: workspaces + conversations + messages only (defer memory + swarms to a v1.4.9 follow-up).

---

## 6. Reporting back (post-implementation)

PR title: `feat(v1.4.8): cross-machine session sync — opt-in, e2ee via libsodium, git-backed`.

PR description MUST include:

- Two-machine smoke recording.
- Setup wizard screenshots (welcome + mnemonic confirm + done).
- Tamper-test transcript (manually corrupted blob → quarantine).
- A "What is NOT in this packet" section: explicit non-goals + deferred items.

Headline-tier user doc at `docs/09-release/cross-machine-sync.md` ships alongside the PR, blog-post quality, with a SECURITY section answering: "Who can read my synced data?" / "What happens if I lose my mnemonic?" / "Can SigmaLink see my conversations?"

---

## 7. Locked decisions summary (one-screen)

| ID | Decision | Status |
|---|---|---|
| S1 | Threat model: A1-A6 defended, A7-A9 non-goals | LOCKED pending lead nod |
| S2 | Crypto: libsodium-wrappers-sumo, XChaCha20-Poly1305 + AAD | LOCKED |
| S3 | Merge: HLC + LWW, no Yjs/Automerge | LOCKED |
| S4 | Conflicts: LWW with `sync_conflicts` table + tombstones | LOCKED |
| S5 | Keys: safeStorage + BIP-39 mnemonic (Option B) | OPEN — lead pick |
| S6 | Scope: 13 tables sync, `credentials` HARD-DENY, `kv`/`skills`/etc. skip | OPEN — lead trim |
| S7 | Transport: isomorphic-git over HTTPS/SSH, NO WebDAV/S3 | LOCKED |
| S8 | Recovery: unrecoverable on mnemonic + all-device loss | OPEN — lead confirm |
| Migration | `0018_sync_metadata.ts` — slot confirmed (last is `0017_pane_split_columns`) | LOCKED |
| Deps | ADD: libsodium-wrappers-sumo, isomorphic-git. DO NOT add: keytar, age, yjs, automerge | LOCKED |
| Mount | `app/src/renderer/features/settings/SettingsRoom.tsx` → new `SyncTab.tsx` | LOCKED |
| Key store | `app/src/main/core/credentials/storage.ts` (existing) — wrapped by new `key-manager.ts` | LOCKED |
