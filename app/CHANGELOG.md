# Changelog

## [1.1.2] - 2026-05-11

Release metadata for the Sigma Assistant end-to-end follow-up to v1.1.1.

### Fixed

- Sigma Assistant tool calls now target real SigmaLink actions instead of stopping at the Tool calls trace panel. Planned coverage includes pane launch, pane dispatch, bulk dispatch, swarm creation, reference resolution, and memory tools.
- Sigma Assistant can inspect live workspace state through `list_active_sessions`, `list_swarms`, and `list_workspaces` instead of relying on stale turn-start prompt context.
- Spawned agent CLIs are expected to receive Ruflo MCP configuration automatically for the active workspace, reducing manual setup for Claude, Codex, and Gemini panes.
- Inter-agent broadcast to group recipients such as `@all` and `@coordinators` is included in the v1.1.2 plan; confirm final wording once the implementation report lands.

### Verification

- Placeholder: add final TypeScript, unit-test, e2e, smoke-test, and arm64 build results before cutting the release.
