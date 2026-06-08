# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.** Low ceremony.
> Promote an item into [ROADMAP.md](ROADMAP.md) when it gets scoped into a phase.
>
> Buckets: **Deferred by design** (consciously out of scope) and **Future enhancements**
> (planned-later upgrades). **New ideas** is the untriaged inbox.

---

## 🚫 Deferred by design (out of scope for now)

_(consciously NOT built — each is a separate track or a non-goal, not a gap)_

- **[desktop-runtime] Tauri migration for host-shell footprint** — replacing Electron with Tauri may reduce baseline app overhead, but the current RAM bottleneck is per-pane Claude/Codex/MCP process trees. Defer until shared MCP, lazy resume, and process-tree cleanup prove the remaining host overhead is worth a platform migration.

---

## ✨ Future enhancements (planned-later upgrades)

_(real upgrades to build once the current system is production-grade)_

- **[pane-lifecycle] automatic idle suspend for completed agents** — park idle/completed panes by preserving scrollback/session metadata and killing the live process tree. Build after the shared Ruflo HTTP and explicit lazy-resume path is stable, because automatic suspension needs clear pinned/keep-alive semantics.
- **[pane-lifecycle] pinned keep-alive policy for remote/autopilot agents** — mark panes that must never be parked by idle cleanup, especially Telegram/remote/autopilot lanes. Build when idle suspend is implemented.

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

- **[mcp] detect repeated stdio MCP starts under one Codex/Claude pane** — a single pane can accumulate multiple `@claude-flow/cli mcp start` descendants. Investigate whether this is Codex plugin behavior, config reload behavior, or a leaked child cleanup issue once diagnostics can show child process history.
