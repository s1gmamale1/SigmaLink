# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.** Low ceremony.
> Promote an item into [ROADMAP.md](ROADMAP.md) when it gets scoped into a phase.
>
> Buckets: **Deferred by design** (consciously out of scope) and **Future enhancements**
> (planned-later upgrades). **New ideas** is the untriaged inbox.

---

## 🚫 Deferred by design (out of scope for now)

_(consciously NOT built — each is a separate track or a non-goal, not a gap)_

- **[dev-workspace] multiple SigmaLink Dev instances / custom cwd** — operator chose singleton at `~` only (2026-06-11 design); revisit only if a second fixed-cwd terminal bench is requested.

---

## ✨ Future enhancements (planned-later upgrades)

_(real upgrades to build once the current system is production-grade)_

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

## 🔬 Deep review findings (2026-06-11)

_(found while grounding the SigmaLink Dev plan — recon agents + lead verification)_

- 🐞 **[high] `workspaces.rename` + `workspaces.openNew` hard-rejected at the preload bridge** — both are registered handlers (`rpc-router.ts:1482`, `router-shape.ts:323,327`) but absent from the `CHANNELS` allowlist (`rpc-channels.ts:78-83`); `isAllowedChannel` is exact-match (`rpc-channels.ts:491-493`), so `Sidebar.tsx:294`'s inline rename silently fails to persist (optimistic `RENAME_WORKSPACE` dispatch masks it until restart). The v1.5.3-B defensive test passes because its own hand-list (`rpc-channels.test.ts:108-113`) omits them too — quad-list drift. Fix: add both to `CHANNELS` + `TYPED_ROUTER_CHANNELS`. Effort: S. → **folded into ROADMAP Phase 13 plan as drive-by Task 4** (2026-06-11).

---

- ~~**[workspaces] SigmaLink Dev special workspace** — singleton workspace selectable from the sidebar "+" menu; NO git/worktree machinery (forced `repoMode:'plain'`, `repoRoot:null`); N plain shell terminals (`providerId:'shell'`, stepper 1–12, default 4) cwd'd at `os.homedir()`; shell panes respawn fresh on app restart (new `'shell'` case in `buildResumeArgs`); side-effect containment (no `.mcp.json`/memory hub written into `~`, Jorvis read-roots not widened). Spec: `docs/superpowers/specs/2026-06-11-sigmalink-dev-workspace-design.md`.~~ → **promoted to ROADMAP Phase 13** (2026-06-11).
