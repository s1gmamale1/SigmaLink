// Provider registry. Pure data + small helpers; no Node-only code so safe in renderer too.
import { providerInstallCommandFor } from './provider-install';
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
  /**
   * Args appended ONLY when the spawning pane renders through the legacy
   * xterm path (P1c, spec §Renderer flag). The claude fullscreen injection
   * (#160) lives here: the xterm grid needs alt-screen to keep Ink's
   * SIGWINCH reprints out of scrollback, while the DOM presenter WANTS
   * inline mode (no scrollback grid to corrupt; FlowView renders the
   * transcript as flowing lines — spec G3).
   */
  xtermOnlyArgs?: string[];
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

/**
 * Resolve the install command for `platform`. win32 NEVER falls back to a
 * POSIX (linux) command — `['bash','-c',…]` is unrunnable on stock Windows
 * and silently spawning it produced a dead install pane. A null return means
 * "no automated installer on this platform" → callers hide the Install
 * button and surface `installDocsUrl` instead. darwin/linux keep the
 * linux-as-fallback convenience (those commands are interchangeable here).
 * Pure + platform-injected: safe in both main and renderer.
 */
export function installCommandFor(
  def: AgentProviderDefinition,
  platform: string,
): string[] | null {
  return providerInstallCommandFor(def, platform);
}

export const AGENT_PROVIDERS: AgentProviderDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    description: "Anthropic's Claude Code CLI",
    command: 'claude',
    altCommands: ['claude.cmd'],
    // --settings (xterm-mode panes ONLY since P1c): force the alt-screen
    // (fullscreen) TUI renderer inside SigmaLink xterm panes — the default
    // inline renderer reprints its frame into scrollback on every SIGWINCH
    // (upstream anthropics/claude-code#49086), so each pane-resize settle
    // appended a duplicate transcript copy that select-to-copy then picked
    // up. Alt-screen redraws can't touch scrollback. The DOM presenter
    // (GridView/FlowView) has no scrollback grid to corrupt and WANTS inline
    // mode, so the injection is now keyed off rendererMode in the launcher.
    // Scoped to SigmaLink spawns only (the user's own terminal claude is
    // untouched); unknown settings are silently ignored by the CLI, so a
    // future key rename degrades to a no-op, never a crash.
    args: [],
    xtermOnlyArgs: ['--settings', '{"tui":"fullscreen"}'],
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
      // Windows PowerShell installer per cursor.com/docs/cli/installation
      // (`irm 'https://cursor.com/install?win32=true' | iex`). cursor-agent's
      // first-class targets are macOS/Linux — treat win32 as best-effort and
      // device-verify before relying on it (win32-platform-services plan).
      win32: [
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "irm 'https://cursor.com/install?win32=true' | iex",
      ],
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

/**
 * Spec 2026-06-10 (B) — providers whose CLIs ingest an image FILE PATH from
 * the prompt (Claude Code detects image paths; Codex accepts paths / -i).
 * Drives the pane drop/paste image-staging interceptor. Gemini stays OFF
 * until its PTY image-path support is verified. Precedent:
 * SLASH_CAPABLE_PROVIDERS (renderer insertSkillCommand.ts).
 */
export const IMAGE_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex']);

export function isImageCapableProvider(providerId: string): boolean {
  return IMAGE_CAPABLE_PROVIDERS.has(providerId);
}

/** Injected into pane Claude spawns via --append-system-prompt so the pane
 *  self-labels. Kept short for compliance; label-watcher parses the line. */
export const PANE_LABEL_INSTRUCTION =
  'When you start working on a task, output one line exactly in the form ' +
  '"SIGMA::LABEL <a 2-4 word summary of the task>" and nothing else on that ' +
  'line, before your other output. Emit it again whenever the task changes.';

/** Claude-only auto-label args. Other providers get the launch-prompt floor +
 *  manual rename instead. Pure (no node deps) so it\'s unit-testable. */
export function paneLabelArgs(providerId: string): string[] {
  return providerId === 'claude'
    ? ['--append-system-prompt', PANE_LABEL_INSTRUCTION]
    : [];
}
