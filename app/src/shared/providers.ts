// Provider registry. Pure data + small helpers; no Node-only code so safe in renderer too.
//
// v1.2.4 cleanup (user-confirmed 2026-05-13): the registry was trimmed to the
// five CLIs SigmaLink actually targets — claude / codex / gemini / opencode /
// kimi. SigmaCode, Cursor Agent, Aider, and Continue were removed entirely.
// The `'shell'` row stays as an INTERNAL sentinel so the workspace launcher
// can still spawn a plain interactive shell when the operator skips agents;
// it is filtered out of every user-facing picker (see `listVisibleProviders`).

export type ProviderId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'kimi'
  | 'opencode'
  | 'cursor'
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
  // v1.4.9-06 — provider auto-install prompt
  /**
   * Per-platform install command arrays. Each element is a shell token
   * (no quoting/escaping needed). Absent when the provider has no
   * installable CLI (e.g. the internal `shell` sentinel).
   */
  installCommand?: {
    darwin?: string[];
    linux?: string[];
    win32?: string[];
  };
  /**
   * Fallback docs URL shown in the install modal when the prerequisite
   * runtime (npm / pip) is itself not on PATH.
   */
  installDocsUrl?: string;
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
    installCommand: {
      darwin: ['npm', 'i', '-g', '@anthropic-ai/claude-code'],
      linux: ['npm', 'i', '-g', '@anthropic-ai/claude-code'],
      win32: ['npm', 'i', '-g', '@anthropic-ai/claude-code'],
    },
    installDocsUrl: 'https://docs.anthropic.com/claude-code/quickstart',
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
    installCommand: {
      darwin: ['npm', 'i', '-g', '@openai/codex'],
      linux: ['npm', 'i', '-g', '@openai/codex'],
      win32: ['npm', 'i', '-g', '@openai/codex'],
    },
    installDocsUrl: 'https://github.com/openai/codex#installation',
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
    installCommand: {
      darwin: ['npm', 'i', '-g', '@google/gemini-cli'],
      linux: ['npm', 'i', '-g', '@google/gemini-cli'],
      win32: ['npm', 'i', '-g', '@google/gemini-cli'],
    },
    installDocsUrl: 'https://github.com/google-gemini/gemini-cli#installation',
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
    installCommand: {
      darwin: ['pip', 'install', 'kimi-cli'],
      linux: ['pip', 'install', 'kimi-cli'],
      win32: ['pip', 'install', 'kimi-cli'],
    },
    installDocsUrl: 'https://github.com/MoonshotAI/kimi-cli',
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
    installCommand: {
      darwin: ['npm', 'i', '-g', 'opencode'],
      linux: ['npm', 'i', '-g', 'opencode'],
      win32: ['npm', 'i', '-g', 'opencode'],
    },
    installDocsUrl: 'https://opencode.ai',
  },
  {
    // R-2 (v1.20.x backlog) — Cursor's CLI agent as a first-class provider.
    // Contract verified against `cursor-agent` 2026.05.24:
    //   • Non-interactive / headless: `-p`/`--print` (positional `[prompt...]`
    //     also accepted). Oneshot mirrors claude exactly: `['-p', '{prompt}']`.
    //   • `--trust` (in `args`) trusts the workspace without prompting in
    //     `--print`/headless mode — the minimal floor that makes a `-p` pane
    //     non-interactive (no command-approval prompt). It is a no-op in plain
    //     interactive panes, so it is safe to apply on every spawn.
    //   • `--force` (autoApproveFlag, alias `--yolo`) is the full "run
    //     everything" escalation, applied only when the launcher requests
    //     autoApprove — mirrors claude `--dangerously-skip-permissions` /
    //     codex `--dangerously-bypass-approvals-and-sandbox`.
    //   • Resume: `--resume [chatId]` (+ `--continue`). The registry's
    //     `resumeArgs` is documentary; the runtime resume argv is built by
    //     `pty/resume-launcher.ts::buildResumeArgs`, which has a `cursor` case.
    //   • cwd defaults to the spawn cwd (SigmaLink manages worktrees externally,
    //     exactly like every other provider — we do NOT use cursor's own
    //     `-w/--worktree`).
    // Auth: `CURSOR_API_KEY` env or `cursor-agent login`. MCP autobind writes
    // the Ruflo server into `<workspace>/.cursor/mcp.json` (see mcp-autowrite.ts).
    id: 'cursor',
    name: 'Cursor',
    description: "Cursor's CLI coding agent (cursor-agent)",
    command: 'cursor-agent',
    altCommands: ['cursor-agent.cmd'],
    args: ['--trust'],
    resumeArgs: ['--resume'],
    oneshotArgs: ['-p', '{prompt}'],
    autoApproveFlag: '--force',
    color: '#6B7CFF',
    icon: 'mouse-pointer-2',
    installHint: 'curl https://cursor.com/install -fsS | bash',
    detectable: true,
    installCommand: {
      darwin: ['bash', '-c', 'curl https://cursor.com/install -fsS | bash'],
      linux: ['bash', '-c', 'curl https://cursor.com/install -fsS | bash'],
      win32: ['bash', '-c', 'curl https://cursor.com/install -fsS | bash'],
    },
    installDocsUrl: 'https://docs.cursor.com/en/cli/overview',
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
