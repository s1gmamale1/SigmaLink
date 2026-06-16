import type { AgentProviderDefinition } from './providers';

function shellJoin(tokens: string[]): string {
  return tokens.map((token) => `'${token.replace(/'/g, `'\\''`)}'`).join(' ');
}

export function providerInstallCommandFor(
  def: AgentProviderDefinition,
  platform: string,
): string[] | null {
  const ic = def.installCommand;
  if (!ic) return null;
  if (platform === 'win32') return ic.win32 ?? null;
  if (platform === 'darwin') return ic.darwin ?? ic.linux ?? null;

  const linux = ic.linux;
  if (!linux) return null;

  if (linux[0] === 'npm' && linux[1] === 'i' && linux[2] === '-g' && linux[3]) {
    return [
      'bash',
      '-lc',
      `set -euo pipefail; prefix="\${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"; mkdir -p "$prefix/bin"; npm config set prefix "$prefix"; npm i -g ${linux.slice(3).map((pkg) => pkg.replace(/[^@/a-zA-Z0-9._-]/g, '')).join(' ')}; printf "\\nInstalled to %s/bin\\n" "$prefix"`,
    ];
  }

  if ((linux[0] === 'pip' || linux[0] === 'pip3') && linux[1] === 'install' && linux[2]) {
    return [
      'bash',
      '-lc',
      `set -euo pipefail; if command -v pipx >/dev/null 2>&1; then pipx install ${linux.slice(2).map((pkg) => pkg.replace(/[^a-zA-Z0-9._-]/g, '')).join(' ')}; else python3 -m pip install --user ${linux.slice(2).map((pkg) => pkg.replace(/[^a-zA-Z0-9._-]/g, '')).join(' ')}; fi`,
    ];
  }

  if (linux[0] === 'bash' || linux[0] === 'sh') return linux;
  return ['bash', '-lc', shellJoin(linux)];
}
