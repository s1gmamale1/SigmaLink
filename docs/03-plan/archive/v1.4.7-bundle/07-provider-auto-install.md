# Packet 07 — Provider auto-install prompt

> **Effort**: M (~6-8hr). **Tier**: v1.3 feature. **Delegate**: Codex via OpenCode (UI-heavy).
> **Blocks**: nothing. **Blocked by**: #06 (shares provider-detect layer).

## Problem

When a user tries to spawn a pane with a CLI that isn't installed, SigmaLink currently:
1. `executeLaunchPlan` calls `resolveAndSpawn` (`app/src/main/core/providers/launcher.ts`)
2. `findProvider(providerId)` returns the registry entry
3. `pty.create` spawns the `command` from the registry (e.g. `kimi`)
4. node-pty fires `ENOENT` on the spawn
5. The pane row is inserted with `status: 'error'` and an error message

The user sees a red pane with "Could not find kimi in PATH". They must alt-tab, run `pip install kimi-code-cli` themselves, restart SigmaLink, and try again.

`docs/03-plan/v1.2.8-session-capture-rewrite.md` flagged this as "Provider auto-install" in "What's NOT in this scope", effort M.

## Fix approach

Detect-then-prompt UX:

1. **Pre-flight detection** in the Launcher wizard: when a user selects a provider, immediately check whether the binary is in PATH. If missing, show a modal explaining the situation + the install command + a single "Install now" button.
2. **Consent-gated install**: the modal shows the exact command (`brew install kimi` / `pip install opencode-cli` / `npm install -g @anthropic-ai/claude-cli`). User clicks "Install now" → SigmaLink spawns the install command in a PTY pane that the user can watch. NO silent network commands.
3. **Per-CLI install metadata** in the provider registry — each row gets new optional fields:
   ```typescript
   interface AgentProviderDefinition {
     // ... existing fields
     installHint: string;  // EXISTING — human-readable hint
     installCommand?: {
       darwin?: string[];  // e.g. ['brew', 'install', 'kimi']
       linux?: string[];
       win32?: string[];
     };
     installDocsUrl?: string;  // fallback when no command is available
   }
   ```
4. **Consent persistence**: `kv['provider.autoinstall.consent.<cliId>']` — if user has explicitly said "no auto-install" once, never prompt again for that CLI. Setting cleared via Settings → Providers → "Reset install consent".

## Provider-specific install commands (research at plan time, validate before ship)

| CLI | macOS | Linux | Windows |
|---|---|---|---|
| claude | `brew install anthropic-ai/tap/claude` OR `npm i -g @anthropic-ai/claude-code` | `npm i -g @anthropic-ai/claude-code` | `npm i -g @anthropic-ai/claude-code` |
| codex | `npm i -g @openai/codex` | `npm i -g @openai/codex` | `npm i -g @openai/codex` |
| gemini | `brew install google-gemini/tap/gemini` OR `npm i -g @google/gemini-cli` | `npm i -g @google/gemini-cli` | `npm i -g @google/gemini-cli` |
| kimi | `pip install kimi-code-cli` | `pip install kimi-code-cli` | `pip install kimi-code-cli` |
| opencode | `brew install opencode/tap/opencode` OR `curl -fsSL opencode.ai/install.sh \| sh` | `curl -fsSL opencode.ai/install.sh \| sh` | docs link (Windows install is manual) |

**Validation step before ship**: each install command must be verified by the delegate on a clean machine. If a command has changed upstream, update the registry + this plan file.

## Implementation outline

### Detection layer (NEW file)

```typescript
// app/src/main/core/providers/detect.ts (NEW)
import { spawn } from 'node:child_process';
import { findProvider } from '../../../shared/providers';

export interface DetectResult {
  installed: boolean;
  version?: string;
  resolvedPath?: string;
}

export async function detectProvider(providerId: string, timeoutMs = 3000): Promise<DetectResult> {
  const provider = findProvider(providerId);
  if (!provider || !provider.command) return { installed: false };

  return new Promise<DetectResult>((resolve) => {
    const probe = spawn(provider.command, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let resolved = false;
    const finish = (result: DetectResult) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };
    probe.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    probe.on('error', () => finish({ installed: false }));
    probe.on('exit', (code) => {
      if (code === 0) {
        finish({ installed: true, version: stdout.trim().split('\n')[0] });
      } else {
        finish({ installed: false });
      }
    });
    setTimeout(() => {
      probe.kill();
      finish({ installed: false });
    }, timeoutMs);
  });
}
```

### Renderer modal

New component `app/src/renderer/features/workspace-launcher/ProviderInstallModal.tsx`. Triggered when the provider chip in the Launcher wizard shows a "not installed" badge. Modal content:
- "{Provider} is not installed."
- Install command (per-OS, copy-button)
- Two buttons: "Install now (runs in a pane)" and "I'll install it myself"
- Checkbox: "Don't ask again for {Provider}"

"Install now" spawns a `shell` pane with the install command pre-typed but not pressed enter. The user reviews + hits enter.

### RPC additions

```typescript
// app/src/shared/router-shape.ts
providers: {
  // ... existing
  detect: (providerId: string) => Promise<DetectResult>;
  setAutoinstallConsent: (providerId: string, consented: boolean) => Promise<void>;
  getAutoinstallConsent: (providerId: string) => Promise<boolean>;
};
```

### Settings tab additions

Settings → Providers gets a new section "Auto-install consent". Lists every provider with their current consent state + a "Reset" button.

## Files to touch

- `app/src/main/core/providers/detect.ts` — NEW
- `app/src/main/core/providers/detect.test.ts` — NEW
- `app/src/shared/providers.ts` — extend `AgentProviderDefinition` with `installCommand` + `installDocsUrl`; populate for 5 CLIs
- `app/src/main/rpc-router.ts` — register `providers.detect` + consent RPCs
- `app/src/renderer/features/workspace-launcher/ProviderInstallModal.tsx` — NEW
- `app/src/renderer/features/workspace-launcher/Launcher.tsx` — wire modal
- `app/src/renderer/features/settings/ProvidersTab.tsx` — consent reset row

## Verification

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false
pnpm exec vitest run src/main/core/providers/  # NEW + existing
pnpm exec eslint .
```

Manual smoke:
1. Uninstall `kimi` from PATH (`pip uninstall kimi-code-cli`).
2. Open SigmaLink, start the Launcher wizard, select Kimi.
3. Modal appears with the correct install command.
4. Click "Install now" → shell pane spawns with `pip install kimi-code-cli` pre-typed.
5. Press enter, watch install complete.
6. Close pane, retry pane spawn — works.
7. Re-uninstall, repeat with "Don't ask again" checked → modal does NOT appear; pane spawns with an error (current behavior).
8. Settings → Providers → Reset consent for Kimi → next launch shows modal again.

## Risk

- Install commands may change upstream. Validate each on a clean VM at ship time.
- `pip install` requires Python; `npm i -g` requires Node. Both are common but not universal. Show the `installDocsUrl` as the fallback when the install command's prerequisite (`pip` / `npm`) isn't available.

## Reporting back

PR title: `feat(v1.4.7): provider auto-install prompt — detect-then-prompt with consent gating`. Include the modal screenshot per provider.
