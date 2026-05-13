// Provider registry. Pure data + small helpers; no Node-only code so safe in renderer too.
//
// v1.2.4 cleanup (user-confirmed 2026-05-13): the registry was trimmed to the
// five CLIs SigmaLink actually targets — claude / codex / gemini / opencode /
// kimi. BridgeCode, Cursor Agent, Aider, and Continue were removed entirely.
// The `'shell'` row stays as an INTERNAL sentinel so the workspace launcher
// can still spawn a plain interactive shell when the operator skips agents;
// it is filtered out of every user-facing picker (see `listVisibleProviders`).

export type ProviderId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'kimi'
  | 'opencode'
  | 'shell'
  | 'custom';

export interface AgentProviderDefinition {
  id: string;
  name: string;
  description: string;
  // Probe + spawn
  command: string;            // canonical CLI binary name
  altCommands?: string[];     // alternates to probe on PATH (e.g. via npx)
  args: string[];             // initial args appended on plain spawn
  versionArgs?: string[];     // for `--version` probe; default ['--version']
  resumeArgs?: string[];      // appended when resuming an existing session
  oneshotArgs?: string[];     // contains `{prompt}` placeholder for one-shot use
  autoApproveFlag?: string;   // optional flag to bypass approval prompts
  initialPromptFlag?: string; // some CLIs accept an initial prompt via flag
  // UI
  color: string;              // hex
  icon: string;               // lucide-react icon id
  installHint: string;        // human-readable install instruction
  detectable?: boolean;       // include in PATH auto-scan
  // Generic capabilities retained for future stubs even though the v1.2.4
  // registry no longer ships a comingSoon / legacy / fallback provider.
  comingSoon?: boolean;          // render disabled, fall back when launched
  fallbackProviderId?: ProviderId; // when comingSoon binary missing, launcher silently spawns this
  legacy?: boolean;              // hidden by default; only shown when providers.showLegacy === '1'
  recommendedRoles?: string[];   // wizard hints (e.g. ['builder','coordinator'])
}

export const AGENT_PROVIDERS: AgentProviderDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    description: "Anthropic's Claude Code CLI",
    command: 'claude',
    altCommands: ['claude.cmd'],
    args: [],
    resumeArgs: ['--resume'],
    oneshotArgs: ['-p', '{prompt}'],
    autoApproveFlag: '--dangerously-skip-permissions',
    color: '#E57035',
    icon: 'sparkles',
    installHint: 'npm i -g @anthropic-ai/claude-code',
    detectable: true,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    description: "OpenAI's Codex CLI",
    command: 'codex',
    altCommands: ['codex.cmd'],
    args: [],
    resumeArgs: ['--resume'],
    oneshotArgs: ['-q', '{prompt}'],
    autoApproveFlag: '--dangerously-bypass-approvals-and-sandbox',
    color: '#10A37F',
    icon: 'cpu',
    installHint: 'npm i -g @openai/codex',
    detectable: true,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: "Google's Gemini CLI",
    command: 'gemini',
    altCommands: ['gemini.cmd'],
    args: [],
    // Gemini CLI v0.41+ has no documented `--resume` protocol yet (tracked in
    // `docs/08-bugs/BACKLOG.md` → P3 polish). Leave resumeArgs undefined so
    // the resume-launcher skips Gemini panes instead of spawning a broken
    // command line.
    initialPromptFlag: '-i',
    autoApproveFlag: '--yolo',
    color: '#4285F4',
    icon: 'gem',
    installHint: 'npm i -g @google/gemini-cli',
    detectable: true,
  },
  {
    id: 'kimi',
    name: 'Kimi Code CLI',
    description: "Moonshot AI's Kimi Code CLI",
    command: 'kimi',
    altCommands: ['kimi.cmd'],
    args: [],
    // Kimi CLI resume protocol unverified upstream — leave undefined like
    // Gemini until confirmed; the resume-launcher will skip kimi panes.
    color: '#22D3EE',
    icon: 'moon',
    // v1.2.8: Kimi CLI ships on PyPI, NOT npm. Upstream repo:
    //   https://github.com/MoonshotAI/kimi-cli
    // Install via `pip install kimi-cli` or run via `uvx kimi`. On Windows a
    // `kimi.cmd` shim is created after `pip install` so PATH probing works.
    installHint: 'pip install kimi-cli (or: uvx kimi)',
    detectable: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode CLI',
    description: 'OpenCode CLI',
    command: 'opencode',
    altCommands: ['opencode.cmd'],
    args: [],
    color: '#F59E0B',
    icon: 'square-code',
    installHint: 'npm i -g opencode',
    detectable: true,
  },
  // INTERNAL: not surfaced in any picker. The workspace launcher routes
  // skip-agents / custom-command rows through this providerId so the spawn
  // path falls into `defaultShell()` (see `local-pty.ts`). Filtered out of
  // `listVisibleProviders` so the Settings → Providers tab and the
  // workspace-launcher wizard never offer "Shell" as a button.
  {
    id: 'shell',
    name: 'Shell',
    description: 'Plain interactive shell — no agent',
    command: '',
    args: [],
    color: '#6B7280',
    icon: 'terminal',
    installHint: 'Built-in',
    detectable: false,
  },
];

export function findProvider(id: string): AgentProviderDefinition | undefined {
  return AGENT_PROVIDERS.find((p) => p.id === id);
}

export function listDetectable(): AgentProviderDefinition[] {
  return AGENT_PROVIDERS.filter((p) => p.detectable !== false && p.command);
}

// v1.2.4: the legacy gate machinery is retained for future use, but the
// shipped registry contains no `legacy` rows. The internal `shell` sentinel
// stays filtered out so the user never sees it in pickers.
export function listVisibleProviders(showLegacy: boolean): AgentProviderDefinition[] {
  return AGENT_PROVIDERS.filter((p) => {
    if (p.id === 'shell') return false;
    if (p.legacy) return showLegacy;
    return true;
  });
}
