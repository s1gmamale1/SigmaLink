# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.** Low ceremony.
> Promote an item into [ROADMAP.md](ROADMAP.md) when it gets scoped into a phase.
>
> Buckets: **Deferred by design** (consciously out of scope) and **Future enhancements**
> (planned-later upgrades). **New ideas** is the untriaged inbox.
>
> **Cleared 2026-07-14** after the v3.0.0 release. The full jorvis-cycle inbox
> (P1b/P1c review minors, pre-release parks, TCC/worktree-config findings, telegram/test-infra
> flakes, …) is preserved verbatim in
> [docs/03-plan/archive/WISHLIST-jorvis-cycle-v3.0.0-2026-07-14.md](docs/03-plan/archive/WISHLIST-jorvis-cycle-v3.0.0-2026-07-14.md)
> — still-alive items get re-promoted from there when they come up.

---

## 🚫 Deferred by design (out of scope for now)

_(consciously NOT built — each is a separate track or a non-goal, not a gap)_

---

## ✨ Future enhancements (planned-later upgrades)

_(real upgrades to build once the current system is production-grade)_

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

---

## 🔬 Deep review findings (2026-07-14) — claude account-switch does not propagate to running panes

_3-lane read-only recon (SigmaLink codebase · installed claude CLI binary internals · upstream docs/issues)
run on `fix/claude-account-switch-propagation`. Symptom: `/login` account switch in one pane leaves every
other RUNNING claude pane on the OLD account until manually restarted (effectively multi-account-simultaneous)._

### Root cause (CONFIRMED, high confidence)

**Not SigmaLink code — the claude CLI child process caches credentials per-process, and its staleness
probe has a macOS-specific blind spot.**

- SigmaLink is auth-neutral: every claude spawn (pane PTY `app/src/main/core/pty/local-pty.ts:562,751`;
  headless Jorvis `app/src/main/core/assistant/runClaudeCliTurn.ts:283` → `spawn-cross-platform.ts:66`)
  inherits live `process.env` untouched — zero `ANTHROPIC_*` / OAuth injection anywhere in `src/`
  (grep-verified), no watcher on `~/.claude*`, no login-reactive respawn hook.
- The CLI (2.1.207 binary, strings-inspected) holds creds in a **memoized in-memory getter**; its
  re-read probe busts the memo on **`.credentials.json` file mtime change** — but on macOS the
  **keychain** (`Claude Code-credentials`) is the authoritative store read-priority-over-file, so a
  keychain-side account switch never trips the file-mtime probe → sibling sessions serve the old
  account until their ~1h expiry check or process restart.
- Upstream-known class: no propagation + refresh-token rotation races between concurrent sessions
  (anthropics/claude-code #24317, #54443, #56339); `/login` may not even update `oauthAccount` in the
  same session (#23906); **no supported hot-reload** of creds in a running session (open feat reqs
  #36847, #23892). Restart is the only reliable adopt path. Bonus hazard: a stale old-account session's
  own refresh can write old-account-derived tokens back over the new login (single shared slot, lock is
  accessToken-equality-guarded but **not account-aware**) — prompt restarts also close this clobber window.
- Account-identity signal for detection: `~/.claude.json` → `oauthAccount.accountUuid` / `emailAddress`
  (verified present on-machine; ~160KB file, cheap to parse on change).

### Fix (this branch)

Detect the switch in main (poll-watch `~/.claude.json` identity) → auto-restart every live claude pane
in place with `--resume <external_session_id>` (existing ghost-heal/resume semantics) → toast the
operator. KV escape hatch `claude.accountSwitch.autoRestart` (default ON; OFF = notify-only toast).

### Parked follow-ups / adjacent findings

- **[panes][polish] quiet-window deferral for account-switch restarts** — v1 restarts every live claude
  pane immediately (incl. mid-generation ones and the pane the operator ran `/login` in; conversation
  resumes, in-flight turn is lost — the old-account turn is exactly what we don't want anyway). Polish:
  defer restart until a pane has been output-quiet ~5s + detect the switcher pane via a login-success
  scrollback sentinel (mirror `auth-error-scan.ts` pattern) and skip it. Build when the immediate-restart
  UX annoys. Effort: S–M.
- ⚠️ **[upstream][watch] `/login` sometimes fails to update `oauthAccount`** (anthropics/claude-code
  #23906, open) — our detector keys on `oauthAccount` identity change, so an upstream no-op write means
  no detection. Nothing to do on our side; re-test when upstream fixes land.
- 🐞 **[low][security] `ptyCtl.create` accepts a renderer-supplied `env` override with zero live callers**
  — `app/src/main/rpc-router.ts:1552-1589` forwards an IPC-reachable `env?: Record<string,string>` into
  PTY spawn; no renderer call site populates it today (grep-verified). Latent surface — drop the field or
  allowlist permitted keys. Effort: S.
- ℹ️ **[machine][hygiene] both credential stores coexist on this Mac** — keychain entry (authoritative)
  AND a 322-byte `~/.claude/.credentials.json` (CLI labels the file backend "plaintext" fallback);
  whether they're mirror-written per login is UNVERIFIED. Only matters for detector edge cases; the
  detector deliberately keys on `~/.claude.json` identity, not either credential store.
