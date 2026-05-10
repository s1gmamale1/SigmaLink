// Provider registry. Pure data + small helpers; no Node-only code so safe in renderer too.

// BUG-V1.1-08-PROV: `droid` and `copilot` previously appeared in this union but
// had no registry entries — any code that resolved them at runtime fell
// through `findProvider() === undefined` and silently degraded. They are
// removed here; the renderer-side stubs in `AgentsStep` / `RoleRoster` keep
// the wizard rows visible by referencing them as plain `string`. If/when the
// real providers ship, re-add them here AND add registry entries below.
export type ProviderId =
  | 'bridgecode'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'cursor'
  | 'aider'
  | 'continue'
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
  // V3-W12-001 / 003: gating + fallback
  comingSoon?: boolean;          // BridgeCode-style stub; render disabled, fall back when launched
  fallbackProviderId?: ProviderId; // when comingSoon binary missing, launcher silently spawns this
  legacy?: boolean;              // hidden by default; only shown when providers.showLegacy === '1'
  recommendedRoles?: string[];   // wizard hints (e.g. ['builder','coordinator'])
}

export const AGENT_PROVIDERS: AgentProviderDefinition[] = [
  {
    id: 'bridgecode',
    name: 'BridgeCode',
    description: 'BridgeMind native CLI (coming soon)',
    command: 'bridgecode',
    altCommands: ['bridgecode.cmd'],
    args: [],
    resumeArgs: ['--resume'],
    oneshotArgs: ['-p', '{prompt}'],
    color: '#3b82f6',
    icon: 'bridge',
    installHint: 'Coming soon — BridgeMind hosted CLI',
    detectable: false,
    comingSoon: true,
    fallbackProviderId: 'claude',
    recommendedRoles: ['builder', 'coordinator'],
  },
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
    args: [],
    resumeArgs: ['--resume'],
    initialPromptFlag: '-i',
    autoApproveFlag: '--yolo',
    color: '#4285F4',
    icon: 'gem',
    installHint: 'npm i -g @google/gemini-cli',
    detectable: true,
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    description: 'Cursor CLI agent',
    command: 'cursor-agent',
    altCommands: ['cursor'],
    args: [],
    color: '#A78BFA',
    icon: 'mouse-pointer-2',
    installHint: 'See cursor.com for CLI access',
    detectable: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode CLI',
    command: 'opencode',
    args: [],
    color: '#F59E0B',
    icon: 'square-code',
    installHint: 'See opencode.ai',
    detectable: true,
  },
  {
    id: 'aider',
    name: 'Aider',
    description: 'Aider AI pair-programmer',
    command: 'aider',
    args: [],
    color: '#EF4444',
    icon: 'bot',
    installHint: 'pipx install aider-chat',
    detectable: true,
    legacy: true,
  },
  {
    id: 'continue',
    name: 'Continue',
    description: 'Continue CLI',
    command: 'continue',
    args: [],
    color: '#6366F1',
    icon: 'arrow-right-circle',
    installHint: 'See continue.dev',
    detectable: true,
    legacy: true,
  },
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

// V3-W12-003: legacy providers (aider, continue) are hidden unless the user
// flips kv['providers.showLegacy']='1'. comingSoon rows (BridgeCode) are kept
// in the visible list but rendered disabled by the consumer.
export function listVisibleProviders(showLegacy: boolean): AgentProviderDefinition[] {
  return AGENT_PROVIDERS.filter((p) => {
    if (p.id === 'shell') return false;
    if (p.legacy) return showLegacy;
    return true;
  });
}
