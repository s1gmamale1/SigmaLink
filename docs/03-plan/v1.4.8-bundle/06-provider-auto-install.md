# Packet 06 — Provider auto-install prompt

> **Effort**: M (~6-8 hr). **Tier**: v1.4.9 target. **Delegate**: Sonnet (UI-heavy).
> **Blocks**: nothing. **Blocked by**: nothing (detection layer is already partially shipped via `providers.probeAll`).

---

## Original brief summary (v1.4.7 archive — `07-provider-auto-install.md`)

- Detect-then-prompt UX: pre-flight detection in the Launcher wizard; if a CLI is not on PATH, show a modal with the install command + "Install now" button.
- "Install now" spawns the install command in a PTY pane the user can watch. No silent network calls.
- New `installCommand?: { darwin?; linux?; win32? }` field on `AgentProviderDefinition`.
- Consent persisted to `kv['provider.autoinstall.consent.<cliId>']`; Settings → Providers gets a consent-reset row.
- New `providers.detect` + consent RPCs added to `router-shape.ts`.
- New `detect.ts` module under `app/src/main/core/providers/`.
- Status at v1.4.7 ship: **deferred** — not implemented.

---

## v1.4.8 review — delta against current state

### 1. Install commands in `providers.ts` vs brief

The brief assumed install commands that have since diverged from what is in the registry.

| CLI | Brief (archived) | `providers.ts` `installHint` (current) | Delta |
|---|---|---|---|
| claude | `brew install anthropic-ai/tap/claude` OR `npm i -g @anthropic-ai/claude-code` | `npm i -g @anthropic-ai/claude-code` | Brew tap path dropped from hint. npm is canonical. |
| codex | `npm i -g @openai/codex` | `npm i -g @openai/codex` | No change. |
| gemini | `brew install google-gemini/tap/gemini` OR `npm i -g @google/gemini-cli` | `npm i -g @google/gemini-cli` | Brew tap path dropped from hint. npm is canonical. |
| kimi | `pip install kimi-code-cli` | `pip install kimi-cli` (or: `uvx kimi`) | **Package name changed**: `kimi-code-cli` → `kimi-cli`. The brief has a stale name. Upstream repo is `https://github.com/MoonshotAI/kimi-cli`. |
| opencode | `brew install opencode/tap/opencode` OR `curl -fsSL opencode.ai/install.sh \| sh` | `npm i -g opencode` | Script-based install path dropped. npm is canonical per current registry. |

**Action for delegate**: Use `providers.ts` `installHint` values as the source of truth for the `installCommand` registry entries. The brew/curl paths in the archived brief are stale and should not be coded.

### 2. Detection layer — partially shipped

The archived brief assumed the detection layer needed to be built from scratch. That is no longer true:

- `providers.probeAll` and `providers.probe` RPCs **already exist** in `router-shape.ts` (lines 196–202) and return `ProviderProbe[]`.
- `AgentsStep.tsx` already renders a **"Not on PATH" amber badge** (line 209) when `row.found === false`. Clicking it shows the `installHint` string for 3 s.

The existing badge is the correct UX anchor for the modal trigger. The delegate does not need to add detection infrastructure — only:

1. Extend the badge click handler to open a `ProviderInstallModal` instead of the current 3-second hint toast.
2. Wire the modal's "Install now" path to spawn a PTY pane.

The proposed new `detect.ts` module with its own `spawn --version` probe is **still needed** as a richer version query (returns `version` string for display in the modal), but it does not replace `probeAll` — it supplements it.

### 3. `installCommand` field — not yet in registry

`AgentProviderDefinition` in `providers.ts` has `installHint: string` but does not have the proposed `installCommand?: { darwin?; linux?; win32? }` or `installDocsUrl?` fields. These must be added as part of this packet.

For the 5 CLIs, cross-platform install command arrays:

| CLI | darwin | linux | win32 |
|---|---|---|---|
| claude | `['npm', 'i', '-g', '@anthropic-ai/claude-code']` | `['npm', 'i', '-g', '@anthropic-ai/claude-code']` | `['npm', 'i', '-g', '@anthropic-ai/claude-code']` |
| codex | `['npm', 'i', '-g', '@openai/codex']` | `['npm', 'i', '-g', '@openai/codex']` | `['npm', 'i', '-g', '@openai/codex']` |
| gemini | `['npm', 'i', '-g', '@google/gemini-cli']` | `['npm', 'i', '-g', '@google/gemini-cli']` | `['npm', 'i', '-g', '@google/gemini-cli']` |
| kimi | `['pip', 'install', 'kimi-cli']` | `['pip', 'install', 'kimi-cli']` | `['pip', 'install', 'kimi-cli']` | 
| opencode | `['npm', 'i', '-g', 'opencode']` | `['npm', 'i', '-g', 'opencode']` | `['npm', 'i', '-g', 'opencode']` |

`installDocsUrl` fallback — for when the prerequisite runtime (`npm` or `pip`) is itself absent:

| CLI | `installDocsUrl` |
|---|---|
| claude | `https://docs.anthropic.com/claude-code/quickstart` |
| codex | `https://github.com/openai/codex#installation` |
| gemini | `https://github.com/google-gemini/gemini-cli#installation` |
| kimi | `https://github.com/MoonshotAI/kimi-cli` |
| opencode | `https://opencode.ai` |

**Validation step before ship**: delegate must verify each `installCommand` on a clean machine or a clean PATH environment. If a command or package name has changed upstream, update the registry + this plan file before merging.

### 4. "Install in a pane" — spawn model

The archived brief proposed spawning the install command in a PTY pane. This remains the correct approach. Rationale:

- Package installs take 10–120 s and produce streaming output. A one-shot RPC (e.g. `providers.runInstall`) would block the RPC thread and time out.
- The existing PTY pane API (`ptyRegistry.create` via `workspaces.launch` or a new lower-level RPC) already handles streaming, kill, and ENOENT. Reusing it avoids duplicating subprocess management.
- The Ruflo supervisor (`ruflo/supervisor.ts`) uses its own JSON-RPC-over-stdio approach for the MCP child. That model is **not** appropriate here — the install pane must be visible to the user and interactive.

**Recommended spawn path**: A new lightweight RPC `providers.spawnInstall(providerId: string): Promise<{ paneId: string }>` that calls `ptyRegistry.create` with the resolved `installCommand[platform]` and returns the pane id. The renderer navigates to that pane so the user sees output. This keeps the façade thin (no DB write, no session record — install panes are ephemeral).

Alternatively, reuse `workspaces.launch` with a synthetic `shell` provider and the install command as the startup command. This avoids a new RPC but couples the install flow to the workspace model.

**Recommendation**: new `providers.spawnInstall` RPC — cleaner separation, no workspace coupling.

### 5. Consent gating — design unchanged, implementation note

The `kv['provider.autoinstall.consent.<cliId>']` pattern from the archived brief is still correct. The KV store pattern is established (e.g. `providers.showLegacy`). No design changes needed.

One nuance not in the original brief: consent should be **per-invocation-result**, not just per-CLI. Specifically:

- `'declined'` — user clicked "I'll install it myself" → never prompt again for this CLI.
- `'undefined'` — not yet seen → show modal.
- There is no positive-consent store because every successful auto-install prompt results in a pane spawn, not a remembered setting.

The "Don't ask again" checkbox maps to setting `consent = 'declined'`. This differs subtly from the archived brief's framing which implied a boolean; a string enum is more extensible.

### 6. Settings consent-reset row — design unchanged

Settings → Providers gets a new section listing each provider with a "Reset install consent" button. No changes to the archived spec for this section.

### 7. Open items not resolved by this review

- **Kimi PyPI package validation**: `kimi-cli` is the name in `providers.ts` as of v1.2.8. The original brief said `kimi-code-cli`. Delegate must verify the current PyPI package name on a clean machine before ship. The upstream repo (`MoonshotAI/kimi-cli`) is the authoritative source.
- **`pip` prerequisite check**: Kimi requires Python/pip. When `pip` is not found, the modal should fall back to `installDocsUrl` rather than showing an unrunnable command. The archived brief mentioned this; no design change, but the delegate must implement the prereq check.
- **`npm` prerequisite check**: All four npm-based CLIs require Node.js. Same fallback logic applies.
- **Modal screenshot**: PR must include a screenshot per the archived brief's reporting requirement.

---

## Final brief (v1.4.8 state)

### Problem (unchanged)

When a provider CLI is not on PATH, SigmaLink spawns a pane that immediately shows ENOENT. The user must self-diagnose, install, and retry. The "Not on PATH" badge in `AgentsStep` shows the `installHint` string for 3 s but offers no install action.

### Fix approach (updated)

1. **Extend `AgentProviderDefinition`** with `installCommand` + `installDocsUrl` (see registry tables above). Populate for all 5 CLIs.
2. **Extend the existing "Not on PATH" badge click** in `AgentsStep.tsx` to open a `ProviderInstallModal` instead of the current 3-second hint display.
3. **`ProviderInstallModal`**: shows CLI name, per-OS install command (copy button), docs link fallback, "Install now (opens a pane)" button, "I'll install it myself" button, "Don't ask again" checkbox.
4. **"Install now"** calls `providers.spawnInstall(providerId)` → new RPC → `ptyRegistry.create` with the install command → renderer navigates to the new ephemeral pane.
5. **Consent** stored in `kv['provider.autoinstall.consent.<cliId>']` as `'declined'`. Absence = prompt next time.
6. **Settings → Providers** consent-reset section per archived brief.
7. **`detect.ts`** supplement (optional for v1.4.9): richer `detectProvider` that returns a `version` string for display in the modal header (e.g. "Claude Code is not installed" vs "Claude Code v1.2.3 is installed — reinstall?"). Can be deferred to v1.5.0 since `probeAll` already covers the binary-absent case.

### Interface additions

```typescript
// app/src/shared/providers.ts — extend AgentProviderDefinition
installCommand?: {
  darwin?: string[];
  linux?: string[];
  win32?: string[];
};
installDocsUrl?: string;

// app/src/shared/router-shape.ts — providers namespace additions
providers: {
  // ... existing: list, probeAll, probe
  spawnInstall: (providerId: string) => Promise<{ paneId: string }>;
  setInstallConsent: (providerId: string, decision: 'declined') => Promise<void>;
  getInstallConsent: (providerId: string) => Promise<'declined' | null>;
};
```

### Files to touch

- `app/src/shared/providers.ts` — extend `AgentProviderDefinition`; populate `installCommand` + `installDocsUrl` for 5 CLIs
- `app/src/shared/router-shape.ts` — add `providers.spawnInstall`, `setInstallConsent`, `getInstallConsent`
- `app/src/main/rpc-router.ts` — implement the 3 new RPC handlers
- `app/src/main/core/providers/launcher.ts` — no changes needed (spawn path unchanged)
- `app/src/renderer/features/workspace-launcher/AgentsStep.tsx` — extend badge click to open modal
- `app/src/renderer/features/workspace-launcher/ProviderInstallModal.tsx` — NEW
- `app/src/renderer/features/settings/ProvidersTab.tsx` — consent-reset section
- `app/src/main/core/providers/detect.ts` — NEW (optional, can defer)
- `app/src/main/core/providers/detect.test.ts` — NEW (optional, can defer)

### Verification

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false
pnpm exec vitest run src/main/core/providers/
pnpm exec eslint .
```

Manual smoke (per archived brief, unchanged):

1. Uninstall a CLI from PATH.
2. Open SigmaLink, start Launcher wizard, select that provider.
3. "Not on PATH" badge appears. Click it.
4. Modal shows correct per-OS install command + docs link.
5. Click "Install now" → ephemeral pane spawns with the install command.
6. Watch install complete. Close pane, retry pane spawn → succeeds.
7. Re-uninstall, check "Don't ask again", click "I'll install it myself" → consent stored.
8. Re-open wizard → badge still shows, modal does NOT open.
9. Settings → Providers → Reset consent → wizard reopens modal next time.

### Risk

- Kimi PyPI package name must be verified on clean environment before ship (`kimi-cli` per current registry; was `kimi-code-cli` in archived brief).
- All npm-based installs require Node.js; pip-based require Python. Detect prereq absence and show `installDocsUrl` fallback.
- Install commands may change upstream. Validate on a clean machine at ship time.

### PR title

`feat(v1.4.9): provider auto-install prompt — consent-gated pane spawn`

---

## Open questions

1. **`providers.spawnInstall` vs reusing `workspaces.launch`**: new RPC is cleaner but adds surface area. If the team prefers minimal RPC growth, the `workspaces.launch` + synthetic shell approach works but couples install UX to workspace state.
2. **Ephemeral pane lifecycle**: should the install pane auto-close on exit-0, or stay open so the user sees the final output? Current pane behavior keeps them open; consistency suggests staying open.
3. **Kimi `uvx kimi` alternative**: `providers.ts` installHint mentions `uvx kimi` as an alternative. Should the modal offer both `pip install kimi-cli` and `uvx kimi` (as radio buttons), or just the primary? Recommendation: single primary command; docs link for alternatives.
4. **`detect.ts` deferral**: the existing `probeAll` covers the binary-absent detection path. `detect.ts` (richer version string) is useful for the modal header but not blocking. Safe to defer to v1.5.0.
