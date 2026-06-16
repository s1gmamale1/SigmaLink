import { describe, expect, it } from 'vitest';
import type { AgentProviderDefinition } from './providers';
import { providerInstallCommandFor } from './provider-install';

const npmProvider: AgentProviderDefinition = {
  id: 'codex',
  name: 'Codex CLI',
  description: 'Codex',
  command: 'codex',
  args: [],
  color: '#000000',
  icon: 'cpu',
  installHint: 'npm i -g @openai/codex',
  installCommand: {
    linux: ['npm', 'i', '-g', '@openai/codex'],
    darwin: ['npm', 'i', '-g', '@openai/codex'],
    win32: ['npm', 'i', '-g', '@openai/codex'],
  },
};

const pipProvider: AgentProviderDefinition = {
  ...npmProvider,
  id: 'kimi',
  command: 'kimi',
  installHint: 'pip install kimi-cli',
  installCommand: {
    linux: ['pip', 'install', 'kimi-cli'],
    darwin: ['pip', 'install', 'kimi-cli'],
    win32: ['pip', 'install', 'kimi-cli'],
  },
};

describe('providerInstallCommandFor', () => {
  it('wraps Linux npm global installs with a user-owned prefix', () => {
    expect(providerInstallCommandFor(npmProvider, 'linux')).toEqual([
      'bash',
      '-lc',
      'set -euo pipefail; prefix="${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"; mkdir -p "$prefix/bin"; npm config set prefix "$prefix"; npm i -g @openai/codex; printf "\\nInstalled to %s/bin\\n" "$prefix"',
    ]);
  });

  it('uses pipx first for Linux Python CLIs', () => {
    expect(providerInstallCommandFor(pipProvider, 'linux')).toEqual([
      'bash',
      '-lc',
      'set -euo pipefail; if command -v pipx >/dev/null 2>&1; then pipx install kimi-cli; else python3 -m pip install --user kimi-cli; fi',
    ]);
  });
});
