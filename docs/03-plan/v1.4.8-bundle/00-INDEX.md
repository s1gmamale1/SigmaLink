# v1.4.8 bundle — index

**Status**: planning (no implementation started)
**Created**: 2026-05-19 (post-v1.4.7 ship)

## Packets

| # | Packet | Effort | Type | Delegate hint |
|---|---|---|---|---|
| 01 | [Browser auto-spawn + `about:about` fix](01-browser-cleanup.md) | XS (~20 min) | Bug | Qwen / Sonnet |
| 02 | [Sidebar resize (IDE + main)](02-sidebar-resize.md) | M (~3-5 hr) | Feature/polish | Sonnet |
| 03 | [Drag-drop file → pane `@-mention`](03-drag-drop-file-mention.md) | M (~4-6 hr) | Feature | Sonnet |
| 04 | [Global voice capture (BridgeVoice-style)](04-global-voice-capture.md) | L (research first, then 3-7d impl) | Feature | Opus research → Sonnet impl |

## Already-briefed inherited from v1.4.7 deferrals (`archive/v1.4.7-bundle/`)

| # | Packet | Effort | Brief |
|---|---|---|---|
| 5 | Notifications + bell | L (3-4d) | [archive/v1.4.7-bundle/08-notifications-bell.md](../archive/v1.4.7-bundle/08-notifications-bell.md) |
| 6 | Windows SAPI5 voice | L (3-5d) | [archive/v1.4.7-bundle/09-windows-sapi5-voice.md](../archive/v1.4.7-bundle/09-windows-sapi5-voice.md) |
| 7 | Cross-machine sync | L (4-6d) | [archive/v1.4.7-bundle/10-cross-machine-sync.md](../archive/v1.4.7-bundle/10-cross-machine-sync.md) |
| 8 | Windows auto-update verify | S (3-4hr) | [archive/v1.4.7-bundle/05-windows-autoupdate-verify.md](../archive/v1.4.7-bundle/05-windows-autoupdate-verify.md) |
| 9 | Provider auto-install | M (6-8hr) | [archive/v1.4.7-bundle/07-provider-auto-install.md](../archive/v1.4.7-bundle/07-provider-auto-install.md) |

## Total scope

**9 packets**: 4 new (this bundle) + 5 inherited from v1.4.7 deferrals.

| Effort tier | Packets |
|---|---|
| XS | 01 |
| S | 08 |
| M | 02, 03, 07, 09 |
| L | 04 (impl), 05, 06, 09 |

Total **dev-days estimate**: ~12-22d if all shipped together. Recommend splitting across v1.4.8 + v1.5.0 since L-effort packets each have their own integration story.

## Suggested release grouping

| Release | Packets | Theme |
|---|---|---|
| **v1.4.8** | 01, 02, 03, 08 | Paper-cuts + small features. ~½–1d total. |
| **v1.4.9** | 04 (research only), 07, 09 | Mid-effort features. ~1-2d. |
| **v1.5.0** | 04 (impl), 05, 06 | L-effort features. ~10-15d. |

## Sequencing notes

- **04 research must precede 04 impl** — don't dispatch impl until stack is locked
- **03 drag-drop** can ship before any other since it's standalone
- **02 sidebar resize** must not break existing CommandRoom grid (test thoroughly)
- **01 browser cleanup** is the safest start; good warm-up packet for a new agent

## Cleanup-loop pattern

Per `~/.claude/skills/orchestrator/SKILL.md`:
1. Delegate → PR push (no merge)
2. Opus 4.7 reviewer pass
3. APPROVE / CAVEATS / REQUEST CHANGES
4. Cleanup as needed
5. Lead lands the PR

**HARD RULE** (per `feedback_agent_scope_discipline.md`): agents must NOT push tags, bump versions, write release notes, or open PRs beyond their assigned packet. Bind scope at dispatch.
