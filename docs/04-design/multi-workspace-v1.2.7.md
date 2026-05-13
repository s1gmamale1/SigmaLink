# Multi-workspace State Preservation — v1.2.7

## Problem

Switching workspaces did not kill PTYs, but it felt like it did. The PTY registry lives in the main process and continues collecting output, while the renderer unmounts xterm instances for the inactive workspace. Returning to that workspace created fresh xterm surfaces with no visible scrollback.

Boot restore also had two silent failure paths: the provider-native session id scan stopped after 100 lines, and `use-session-restore` swallowed resume errors.

## Shipped Model

v1.2.7 keeps PTYs process-wide and makes terminal remounts replayable:

1. `PtyRegistry` keeps buffering output through the existing `RingBuffer`.
2. `pty.snapshot(sessionId)` returns `{ buffer }` for a session.
3. `SessionTerminal` writes the snapshot before subscribing to live `pty:data`.
4. Workspace switching stays a pure renderer state change; no kill/forget IPC is involved.

This is the cheap, low-risk approach. It preserves the user's visible terminal history without keeping every inactive xterm instance mounted.

## Resume Reliability

The default external-session scan window is now 500 complete lines. `resumeWorkspacePanes` includes rows that are otherwise resumable but missing `external_session_id`; those rows are marked failed with a concrete error instead of being filtered out. The renderer shows a toast for failed resume results.

## Verification

- Registry unit test: emitted PTY data is available through `snapshot()`.
- Reducer unit tests: `SET_ACTIVE_WORKSPACE_ID` does not mutate sessions or swarms.
- Resume launcher unit test: missing `external_session_id` returns a failed result.
- Sidebar tests: close buttons exist on every row, active row remains highlighted, and the chevron opens persisted-but-closed workspaces.
- Playwright e2e: launches a shell pane, switches between two workspaces, and asserts the PTY pid stays alive and unchanged.

## Deferred

v1.3 can add a renderer-side xterm cache or React Activity-based hidden workspace trees for zero-latency switching. That is intentionally out of v1.2.7 because the ring-buffer replay solves the data-loss perception with much less risk.
