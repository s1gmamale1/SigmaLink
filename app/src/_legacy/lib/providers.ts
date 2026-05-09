import type { AgentProvider } from '@/types';

export const AGENT_PROVIDERS: AgentProvider[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    resumeArgs: ['--resume'],
    oneshotArgs: ['-p', '{prompt}'],
    installHint: 'npm install -g @anthropic-ai/claude-code',
    color: '#E57035',
    icon: 'Bot',
    description: 'Anthropic\'s Claude Code agent',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    command: 'codex',
    args: [],
    resumeArgs: ['--resume'],
    oneshotArgs: ['-q', '{prompt}'],
    installHint: 'npm install -g @openai/codex',
    color: '#10A37F',
    icon: 'Code2',
    description: 'OpenAI Codex CLI agent',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: [],
    resumeArgs: ['--resume'],
    oneshotArgs: ['--prompt', '{prompt}'],
    installHint: 'npm install -g @google/gemini-cli',
    color: '#4285F4',
    icon: 'Sparkles',
    description: 'Google Gemini CLI agent',
  },
  {
    id: 'kimi',
    name: 'Kimi CLI',
    command: 'kimi',
    args: [],
    resumeArgs: [],
    oneshotArgs: ['--prompt', '{prompt}'],
    installHint: 'Install Kimi Code CLI and make sure the `kimi` command is available in PATH.',
    color: '#22D3EE',
    icon: 'Moon',
    description: 'Moonshot Kimi coding CLI agent',
  },
  {
    id: 'continue',
    name: 'Continue',
    command: 'continue',
    args: [],
    resumeArgs: [],
    oneshotArgs: [],
    installHint: 'npm install -g @continuedev/cli',
    color: '#6366F1',
    icon: 'Play',
    description: 'Open-source coding assistant',
  },
  {
    id: 'custom',
    name: 'Custom CLI',
    command: '',
    args: [],
    resumeArgs: [],
    oneshotArgs: [],
    installHint: 'Configure your custom CLI agent',
    color: '#6B7280',
    icon: 'Settings',
    description: 'Any CLI agent you configure',
  },
];

export function getProviderById(id: string): AgentProvider | undefined {
  return AGENT_PROVIDERS.find(p => p.id === id);
}

export function getDefaultProvider(): AgentProvider {
  return AGENT_PROVIDERS[0];
}
