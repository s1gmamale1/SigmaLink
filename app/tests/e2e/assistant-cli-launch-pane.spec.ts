import { test } from '@playwright/test';

test.skip('manual smoke: Sigma Assistant launch_pane creates a Codex pane', async () => {
  // Manual gate for v1.1.2 release candidates:
  // 1. Build and launch SigmaLink.
  // 2. Open Sigma Assistant.
  // 3. Ask: "launch 1 codex pane with a one-sentence intro".
  // 4. Confirm a Codex PTY appears in Command Room with the intro prompt typed.
  //
  // Unit coverage in runClaudeCliTurn.test.ts verifies the protocol-critical
  // part: Claude CLI tool_use -> dispatchTool -> matching tool_result JSONL.
  // This e2e is intentionally skipped until the Electron smoke harness has
  // stable Command Room selectors and native-module rebuilds are reliable in CI.
});
