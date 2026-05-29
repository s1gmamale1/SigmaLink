# SigmaLink — Wishlist (quick capture)

> **Capture inbox.** Jot findings + new ideas here as they land — low ceremony.
> - **Execution sequence** (what we do next, priority-ordered) → `ROADMAP.md`
> - **Shipped record / archive** → `CHANGELOG.md` + `docs/09-release/` + the
>   master memory (`~/.claude/projects/.../memory/`) + Ruflo AgentDB
>
> Flow: capture here → triage into `ROADMAP.md` for the next phase → on ship,
> it moves to the archive (CHANGELOG + memory) and leaves both working docs.

---

## 🆕 New ideas (untriaged)

- _(empty — capture new ideas here)_

## ✅ SigmaVoice standalone — realized + shipping (2026-05-29)

Was the big "new idea" above; now built + released. **Standalone system-wide dictation app
in its own repo** `s1gmamale1/SigmaVoice` (operator-created), voice engine consumed from
SigmaLink via a **git submodule** (single source of truth; dev continues here in `sigma-voice/`,
that repo is the release home). Relocated `app/apps/sigma-voice` → top-level `sigma-voice/`; real
push-to-talk (`node-global-key-listener`, lazy-loaded); focus-preserving recording HUD;
dictionary/macros + stats UI; **model-download UX** (list + size + download w/ live % + activate);
persistent KV; Apple-grade settings + distinct icon; single-instance. Merged to SigmaLink `main`.
✅ **macOS DMG RELEASED — `SigmaVoice v0.3.2` (arm64)** (`releases/tag/v0.3.2`); `curl | bash`
installer (`scripts/install-macos.sh`). v0.3.0/v0.3.1 deleted (each crashed; superseded).

**Open follow-ups:**
- **W-SV1 — Windows NSIS build BLOCKED (native bug).** release.yml win job: `voice-win` compiles,
  `voice-whisper` x64 **fails to LINK** (`LNK1120: 40 unresolved ggml_* externals` —
  `ggml_cpu_init`, `ggml_threadpool_new`, `ggml_barrier`, `ggml_backend_cuda_reg`, …). The shared
  `app/native/voice-whisper/binding.gyp` links on macOS/clang but **not MSVC** (whisper.cpp is
  CMake-on-Windows; gyp Windows port incomplete — `ggml_backend_cuda_reg` w/ no CUDA, arch-cond
  CPU sources). Needs binding.gyp surgery + CI iteration on a Windows runner. Operator: mac now, Windows next.
- **W-SV2 — quit-time SIGABRT (native TSFN teardown).** Quitting AFTER a recording session can throw
  a crash report: `napi_release_threadsafe_function` → `uv_mutex_lock` abort during the voice
  natives' ThreadSafeFunction release. App has already quit (no data loss; capture/transcribe
  unaffected). `app.exit`/`process.exit` don't dodge it (abort is inside `dispose()`'s native
  release). Proper fix is in `tsfn_bridge` release semantics (release/abort the TSFN before loop
  teardown). Affects SigmaLink in-app voice too. Quit-only → lower priority.
- ① live mic/permission smoke (Mic + Accessibility + Input-Monitoring grants — needs hardware)
- ② deferred features: Windows keystroke-inject, AI-cleanup/cloud, floating pill, wake-word.

---

## 🔎 Open findings (raw — sequenced in ROADMAP.md)

All remaining findings are BLOCKED or operator-owned — nothing an agent can pick up unblocked. Add new findings above.

- **W-4 P8–P9 + win32 shell-first dogfood** — resume simplification + drop `external_session_id`; win32 un-dogfooded. → ROADMAP **B1** (BLOCKED on operator win32 dogfood).
- **FE-4 voice (blocked) + device a11y QA** — PCM sample-rate, whisper.cpp v1.7.x port, voice prebuildify (all behind unshipped native builds); device VoiceOver/Switch-Control QA needs hardware. → ROADMAP **B2** / operator. *(FE-4 a11y code — focus-trap, reduced-transparency, room prefetch — ✅ shipped `dbce7e6`; breadcrumb contrast = verified no-op.)*
- **SF-12 migration `0026` (operator-owned)** — data-repair migration dormant pending the operator running the diagnostic SQL on a real `agent_sessions` dump. On sign-off → register `0026` + follow-up release. SQL in `docs/09-release/release-notes-1.35.0.txt`.
- **SF-14 optional polish (low)** — auto-trigger the lazy Ruflo install on first workspace open (renderer-triggered today). *(Room-chunk prefetch half ✅ shipped `dbce7e6`.)*

> Everything else (C-class M0–M5, FE-1…4 incl. **a11y subset**, R-1/R-2, W-class, **H-class fully complete incl. H-7**, **SF-14 daemon offline-CLI tier**, SF-1…15, CI Node-24 + e2e flake, **video+perf review harness**) is **shipped** — see `CHANGELOG.md` + master-memory. **Cursor skill fan-out DROPPED** (no-op). Don't re-note shipped items here.

---

## 📌 Standing references (not findings — kept for quick lookup)

- **Distribution posture:** internal use only. No signed-distribution paths (EV cert, MS Store, WinGet, Apple Developer, wake-word licensing). Canonical: `app/build/nsis/README — First launch.txt` + `scripts/install-macos.sh`.
- **ADR 2026-05-16 — Linux not supported:** macOS arm64 + Windows x64 only; no Linux CI/smoke/installer/docs. Reversal needs a new ADR (re-add Ubuntu CI lanes + a Linux release workflow + install docs).
- **Source ledgers:** `docs/08-bugs/BACKLOG.md` (bugs/optimizations) · `docs/03-plan/V3_PARITY_BACKLOG.md` (V3 parity — resolved v1.5.1, historical) · `docs/02-research/bridgemind-review-2026-05-22/` (C-class source).
