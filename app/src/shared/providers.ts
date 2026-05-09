// Provider registry. Pure data + small helpers; no Node-only code so safe in renderer too.

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
    id: 'kimi',
    name: 'Kimi CLI',
    description: 'Moonshot Kimi CLI',
    command: 'kimi',
    args: [],
    color: '#22D3EE',
    icon: 'moon',
    installHint: 'npm i -g @moonshot-ai/kimi-cli',
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
