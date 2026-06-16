# Full Linux Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SigmaLink a first-class Ubuntu Linux x64 desktop target with tested runtime behavior, Linux release artifacts, installer docs, and CI gates.

**Architecture:** Treat Linux support as a platform contract, not just an `electron-builder` target. The work lands in thin, testable platform seams: process listing, PATH bootstrap, provider install commands, update events, native package packaging, CI release workflow, and documentation. Existing macOS and Windows flows stay byte-for-byte stable unless a task explicitly names a shared helper.

**Tech Stack:** Electron 30, electron-builder 24, electron-updater, Vite, React, TypeScript, Vitest, Playwright Electron smoke tests, GitHub Actions Ubuntu runners, node-pty, better-sqlite3, pnpm workspaces.

---

## Support Contract

Ship Linux support for:

- Ubuntu 22.04 LTS and Ubuntu 24.04 LTS, x64 only.
- Source build: `pnpm install`, `pnpm run product:check`, `pnpm electron:pack:linux`.
- Release artifacts: `SigmaLink-<version>.AppImage`, `SigmaLink-<version>.deb`, blockmaps, and `latest-linux.yml`.
- Runtime: workspace launch, shell panes, provider panes, process-tree cleanup/stats, settings/update UI, global capture fallback-to-clipboard, and app restart.
- Distribution: documented one-line `.deb` installer and manual AppImage path.

Non-goals for this plan:

- Linux arm64 packages.
- Snap, Flatpak, rpm, AUR, or distro repository publishing.
- Wayland direct paste automation. Wayland users get clipboard fallback with clear copy.
- Signed Linux repositories. GitHub Releases is the source of truth.

## File Structure

- `.github/workflows/e2e-matrix.yml` - add Ubuntu smoke lane and Linux system packages.
- `.github/workflows/lint-and-build.yml` - make docs match actual runner names, and add a cheap Ubuntu product-check gate if not covered elsewhere.
- `.github/workflows/release-linux.yml` - new release workflow that builds AppImage and deb on `ubuntu-latest`.
- `app/package.json` - add `electron:pack:linux`; include Linux in explicit package scripts.
- `app/electron-builder.yml` - convert Linux block comments from unsupported to supported; keep x64 target.
- `app/electron/auto-update.ts` - add Linux update download and ready events.
- `app/src/shared/rpc-channels.ts` - allow the new Linux update progress/ready events if the allowlist requires explicit event names.
- `app/src/renderer/features/settings/UpdatesTab.tsx` - render Linux update states and install instructions.
- `app/src/main/core/process/process-list-linux.ts` - new Linux process-table parser/list helper.
- `app/src/main/core/process/process-tree.ts` - enable Linux process tree listing and tree kill.
- `app/src/main/core/process/ps-snapshot.ts` - add async Linux lister.
- `app/src/main/core/process/process-tree.test.ts` - replace Linux unsupported tests with supported Linux tests.
- `app/src/main/core/process/ps-snapshot.test.ts` - add Linux cached stats coverage.
- `app/src/main/core/pty/local-pty.ts` - avoid shell-first sentinel injection into non-POSIX shells on Linux.
- `app/src/main/core/pty/local-pty.test.ts` - cover Linux shell selection and non-POSIX fallback.
- `app/src/main/core/util/linux-path.ts` - new deterministic Linux PATH candidate helper.
- `app/src/main/core/util/linux-path.test.ts` - test Linux PATH candidate ordering.
- `app/electron/main.ts` - consume Linux PATH candidates in `bootstrapNodeToolPath`.
- `app/src/shared/provider-install.ts` - new provider install command resolver for platform-safe shell commands.
- `app/src/shared/provider-install.test.ts` - cover Ubuntu npm/pipx install command resolution.
- `app/src/shared/providers.ts` - delegate `installCommandFor` to the new helper.
- `app/native/voice-whisper/package.json` - add install fallback that builds from source when prebuild is missing.
- `app/package.json` - promote `@sigmalink/voice-whisper` to a root runtime dependency so bundled main can resolve it.
- `app/scripts/install-linux.sh` - new Ubuntu installer script.
- `app/README.md`, `README.md`, `docs/07-test/CI_NOTES.md`, `docs/08-bugs/BACKLOG.md` - update support documentation.

## Task 1: Support Contract, Scripts, And Linux Builder Metadata

**Files:**
- Modify: `app/package.json:20-28`
- Modify: `app/electron-builder.yml:101-113`
- Test: `app/package.json`

- [ ] **Step 1: Write the package-script expectation**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (pkg.scripts['electron:pack:linux']) process.exit(1);
NODE
```

Expected: command exits `0`, proving the script is absent before implementation.

- [ ] **Step 2: Add Linux package scripts**

In `app/package.json`, change the scripts block to include:

```json
"electron:pack:win": "npm run build && npm run electron:compile && electron-builder --win",
"electron:pack:mac": "npm run build && npm run electron:compile && electron-builder --mac",
"electron:pack:linux": "npm run build && npm run electron:compile && electron-builder --linux",
"electron:pack:all": "npm run build && npm run electron:compile && electron-builder --win --mac --linux",
"postinstall": "electron-builder install-app-deps",
"product:check": "npm run build && npm run electron:compile"
```

- [ ] **Step 3: Update builder comments**

In `app/electron-builder.yml`, replace the unsupported Linux comment above `linux:` with:

```yaml
# Linux is a supported x64 platform. CI builds and smokes AppImage + deb on
# ubuntu-latest before release upload. Runtime support targets Ubuntu 22.04 LTS
# and Ubuntu 24.04 LTS.
linux:
  target:
    - target: AppImage
      arch: [x64]
    - target: deb
      arch: [x64]
  category: Development
```

- [ ] **Step 4: Verify package scripts**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (pkg.scripts['electron:pack:linux'] !== 'npm run build && npm run electron:compile && electron-builder --linux') {
  throw new Error('electron:pack:linux missing or wrong');
}
if (!pkg.scripts['electron:pack:all'].includes('--linux')) {
  throw new Error('electron:pack:all must include --linux');
}
NODE
```

Expected: no output, exit `0`.

- [ ] **Step 5: Commit**

```bash
git add package.json electron-builder.yml
git commit -m "build(linux): add first-class linux package script"
```

## Task 2: Linux Process Tree Support

**Files:**
- Create: `app/src/main/core/process/process-list-linux.ts`
- Modify: `app/src/main/core/process/process-tree.ts:34-220`
- Modify: `app/src/main/core/process/ps-snapshot.ts:68-123`
- Test: `app/src/main/core/process/process-tree.test.ts`
- Test: `app/src/main/core/process/ps-snapshot.test.ts`

- [ ] **Step 1: Add failing Linux process tests**

Append to `app/src/main/core/process/process-tree.test.ts`:

```ts
describe('process-tree on linux', () => {
  const psOut = [
    '  10     1  1000 /usr/bin/bash bash',
    '  11    10  2000 /usr/bin/node node cli.js',
    '  12    11  3000 /usr/bin/node node mcp-memory-server.cjs',
  ].join('\n');

  it('linux: lists ps rows and computes descendants', () => {
    const exec = vi.fn(() => psOut);
    const snap = inspectProcessTree(10, { platform: 'linux', exec });

    expect(exec).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,rss=,comm=,args=']);
    expect(snap.supported).toBe(true);
    expect(snap.descendantPids).toEqual([11, 12]);
    expect(snap.rssBytes).toBe((1000 + 2000 + 3000) * 1024);
  });

  it('linux: stopProcessTrees sends signals through the POSIX path', () => {
    const exec = vi.fn(() => psOut);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const res = stopProcessTrees([10], 0, { platform: 'linux', exec });

    expect(res.stoppedPids).toEqual([12, 11, 10]);
    expect(kill).toHaveBeenCalledWith(12, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(11, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(10, 'SIGTERM');
    kill.mockRestore();
  });
});
```

Add this to `app/src/main/core/process/ps-snapshot.test.ts`:

```ts
it('linux cached snapshot uses the linux lister', async () => {
  const snap = await inspectProcessTreeCached(100, 'linux');
  expect(snap.supported).toBe(true);
});
```

If `ps-snapshot.test.ts` already uses injected listers, set the injected rows to:

```ts
[
  { pid: 100, ppid: 1, rssBytes: 1024, command: '/bin/bash', args: 'bash' },
  { pid: 101, ppid: 100, rssBytes: 2048, command: '/usr/bin/node', args: 'node cli.js' },
]
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm exec vitest run src/main/core/process/process-tree.test.ts src/main/core/process/ps-snapshot.test.ts
```

Expected: Linux tests fail because Linux is currently unsupported in the process backends.

- [ ] **Step 3: Create Linux process lister**

Create `app/src/main/core/process/process-list-linux.ts`:

```ts
import type { ProcessTreeNode } from './process-tree';

export function parseLinuxPsLine(line: string): ProcessTreeNode | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    rssBytes: Number(match[3]) * 1024,
    command: match[4] ?? '',
    args: match[5] ?? '',
  };
}

export function parseLinuxPsRows(stdout: string): ProcessTreeNode[] {
  return stdout
    .split('\n')
    .map(parseLinuxPsLine)
    .filter((row): row is ProcessTreeNode => row !== null);
}
```

- [ ] **Step 4: Wire sync process tree support**

In `app/src/main/core/process/process-tree.ts`, import the parser:

```ts
import { parseLinuxPsRows } from './process-list-linux';
```

Change `platformSupported`:

```ts
function platformSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
}
```

Inside `listProcessRows`, before the Darwin `ps` branch, add:

```ts
if (platform === 'linux') {
  return {
    supported: true,
    rows: parseLinuxPsRows(exec('ps', ['-axo', 'pid=,ppid=,rss=,comm=,args='])),
  };
}
```

Update the comment above `listProcessRows` to say:

```ts
 * darwin/linux: `ps -axo` (kilobyte rss -> bytes). win32: PowerShell CIM.
```

- [ ] **Step 5: Wire async cached stats support**

In `app/src/main/core/process/ps-snapshot.ts`, import the parser and define a lister:

```ts
import { parseLinuxPsRows } from './process-list-linux';

const linuxLister: ProcessLister = () =>
  new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,rss=,comm=,args='],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseLinuxPsRows(stdout));
      },
    );
  });
```

Add it to `LISTERS`:

```ts
const LISTERS: Partial<Record<NodeJS.Platform, ProcessLister>> = {
  darwin: darwinLister,
  linux: linuxLister,
  win32: win32Lister,
};
```

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm exec vitest run src/main/core/process/process-tree.test.ts src/main/core/process/ps-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/core/process/
git commit -m "feat(linux): support process tree stats and cleanup"
```

## Task 3: Linux Shell-First Safety

**Files:**
- Modify: `app/src/main/core/pty/local-pty.ts:125-180`
- Test: `app/src/main/core/pty/local-pty.test.ts`

- [ ] **Step 1: Add failing tests for Linux shell selection**

Append to `app/src/main/core/pty/local-pty.test.ts`:

```ts
describe('defaultShell on linux', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('uses SHELL when it is POSIX-compatible', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(defaultShell({ SHELL: '/usr/bin/zsh' })).toEqual({ command: '/usr/bin/zsh', args: ['-l'] });
  });

  it('falls back to bash when SHELL is fish', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(defaultShell({ SHELL: '/usr/bin/fish' })).toEqual({ command: '/bin/bash', args: ['-l'] });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm exec vitest run src/main/core/pty/local-pty.test.ts -t "defaultShell on linux"
```

Expected: the fish test fails because Linux currently trusts `env.SHELL`.

- [ ] **Step 3: Implement POSIX shell guard**

In `app/src/main/core/pty/local-pty.ts`, add:

```ts
function isPosixLoginShell(shellPath: string | undefined): shellPath is string {
  if (!shellPath) return false;
  const base = path.basename(shellPath).toLowerCase();
  return base === 'sh' || base === 'bash' || base === 'zsh' || base === 'dash' || base === 'ksh';
}
```

Change the Linux branch of `defaultShell` to:

```ts
const sh = isPosixLoginShell(env.SHELL) ? env.SHELL : '/bin/bash';
return { command: sh, args: ['-l'] };
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
pnpm exec vitest run src/main/core/pty/local-pty.test.ts -t "defaultShell on linux"
```

Expected: PASS.

- [ ] **Step 5: Run broader PTY tests**

Run:

```bash
pnpm exec vitest run src/main/core/pty/local-pty.test.ts src/main/core/pty/registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/pty/local-pty.ts src/main/core/pty/local-pty.test.ts
git commit -m "fix(linux): keep shell-first on POSIX shells"
```

## Task 4: Linux GUI PATH Bootstrap

**Files:**
- Create: `app/src/main/core/util/linux-path.ts`
- Create: `app/src/main/core/util/linux-path.test.ts`
- Modify: `app/electron/main.ts:426-450`

- [ ] **Step 1: Write Linux PATH candidate tests**

Create `app/src/main/core/util/linux-path.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { linuxToolPathCandidates, mergePathEntries } from './linux-path';

describe('linuxToolPathCandidates', () => {
  it('returns Ubuntu-friendly user tool directories before system dirs', () => {
    expect(linuxToolPathCandidates('/home/sigma')).toEqual([
      '/home/sigma/.local/bin',
      '/home/sigma/.npm-global/bin',
      '/home/sigma/.npm/bin',
      '/home/sigma/.bun/bin',
      '/home/sigma/.cargo/bin',
      '/home/sigma/.asdf/shims',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]);
  });
});

describe('mergePathEntries', () => {
  it('prepends existing candidates and keeps existing PATH entries without duplicates', () => {
    const merged = mergePathEntries(['/a', '/b', '/missing'], '/b:/c', {
      delimiter: ':',
      exists: (p) => p !== '/missing',
    });

    expect(merged).toBe('/a:/b:/c');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm exec vitest run src/main/core/util/linux-path.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement Linux PATH helper**

Create `app/src/main/core/util/linux-path.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

export function linuxToolPathCandidates(home: string): string[] {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.npm', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.asdf', 'shims'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
}

export function mergePathEntries(
  candidates: string[],
  currentPath: string,
  opts: {
    delimiter?: string;
    exists?: (candidate: string) => boolean;
  } = {},
): string {
  const delimiter = opts.delimiter ?? path.delimiter;
  const exists = opts.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of [...candidates.filter(exists), ...currentPath.split(delimiter)]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }

  return out.join(delimiter);
}
```

- [ ] **Step 4: Consume helper from Electron boot**

In `app/electron/main.ts`, import:

```ts
import { linuxToolPathCandidates, mergePathEntries } from '../src/main/core/util/linux-path';
```

In `bootstrapNodeToolPath`, replace the Linux candidate branch:

```ts
} else if (process.platform === 'linux') {
  process.env.PATH = mergePathEntries(linuxToolPathCandidates(home), process.env.PATH ?? '');
  return;
}
```

Keep the existing Volta/nvm enumeration for macOS after this branch.

- [ ] **Step 5: Run tests and compile**

Run:

```bash
pnpm exec vitest run src/main/core/util/linux-path.test.ts
pnpm run product:check
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts src/main/core/util/linux-path.ts src/main/core/util/linux-path.test.ts
git commit -m "fix(linux): bootstrap common user tool paths"
```

## Task 5: Ubuntu-Safe Provider Install Commands

**Files:**
- Create: `app/src/shared/provider-install.ts`
- Create: `app/src/shared/provider-install.test.ts`
- Modify: `app/src/shared/providers.ts:42-61`

- [ ] **Step 1: Write install resolver tests**

Create `app/src/shared/provider-install.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm exec vitest run src/shared/provider-install.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement provider install resolver**

Create `app/src/shared/provider-install.ts`:

```ts
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
```

- [ ] **Step 4: Delegate existing helper**

In `app/src/shared/providers.ts`, import:

```ts
import { providerInstallCommandFor } from './provider-install';
```

Replace the body of `installCommandFor` with:

```ts
export function installCommandFor(
  def: AgentProviderDefinition,
  platform: string,
): string[] | null {
  return providerInstallCommandFor(def, platform);
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm exec vitest run src/shared/provider-install.test.ts src/shared/providers.test.ts
```

Expected: PASS. If `providers.test.ts` asserts exact Linux commands, update its expected Linux command to the bash-wrapped commands above.

- [ ] **Step 6: Commit**

```bash
git add src/shared/provider-install.ts src/shared/provider-install.test.ts src/shared/providers.ts src/shared/providers.test.ts
git commit -m "fix(linux): make provider installs user-owned"
```

## Task 6: Linux Auto-Update UX

**Files:**
- Modify: `app/electron/auto-update.ts:74-185`
- Modify: `app/src/shared/rpc-channels.ts`
- Modify: `app/src/renderer/features/settings/UpdatesTab.tsx:23-315`
- Test: `app/src/renderer/features/settings/UpdatesTab.test.tsx`

- [ ] **Step 1: Add renderer test for Linux ready state**

In `app/src/renderer/features/settings/UpdatesTab.test.tsx`, add:

```tsx
it('shows Linux manual install copy when an update is ready', async () => {
  stubPlatform('linux');
  const user = userEvent.setup();
  render(<UpdatesTab />);

  await user.click(await screen.findByRole('button', { name: /check for updates/i }));
  act(() => {
    sigma.emit('app:update-available', { version: '9.9.9' });
    sigma.emit('app:update-linux-ready', {
      version: '9.9.9',
      path: '/home/user/Downloads/SigmaLink-9.9.9.AppImage',
    });
  });

  expect(await screen.findByText(/Linux update downloaded/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open download/i })).toBeEnabled();
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm exec vitest run src/renderer/features/settings/UpdatesTab.test.tsx -t "Linux manual install"
```

Expected: FAIL because Linux ready events are not handled yet.

- [ ] **Step 3: Add Linux download branch**

In `app/electron/auto-update.ts`, add module state:

```ts
let linuxDownloadPath: string | null = null;
```

Add helper:

```ts
function resolveLinuxAppImageUrl(info: UpdateInfo): { url: string; name: string } | null {
  const file = info.files.find((f) => f.url.endsWith('.AppImage'));
  if (!file) return null;
  return { url: resolveMacDmgUrl(info, file.url), name: file.url };
}
```

Inside `update-available`, after the Windows branch:

```ts
} else if (process.platform === 'linux') {
  const appImage = resolveLinuxAppImageUrl(info);
  if (!appImage) {
    broadcast('app:update-error', { error: 'No Linux AppImage found in release manifest' });
    return;
  }
  const dest = path.join(app.getPath('downloads'), appImage.name);
  linuxDownloadPath = dest;
  let cumulative = 0;
  httpDownload(appImage.url, dest, (delta, total) => {
    cumulative += delta;
    broadcast('app:update-linux-progress', {
      version: info.version,
      downloaded: cumulative,
      total,
    });
  }).then(() => {
    broadcast('app:update-linux-ready', { version: info.version, path: dest });
  }).catch((err) => {
    broadcast('app:update-error', { error: err.message });
  });
}
```

Update `quitAndInstallImpl`:

```ts
} else if (process.platform === 'linux') {
  if (!linuxDownloadPath) {
    throw new Error('No Linux download available. Check for updates first.');
  }
  await shell.showItemInFolder(linuxDownloadPath);
```

- [ ] **Step 4: Allow Linux update events**

In `app/src/shared/rpc-channels.ts`, add these events wherever update events are listed:

```ts
'app:update-linux-progress',
'app:update-linux-ready',
```

- [ ] **Step 5: Render Linux update state**

In `app/src/renderer/features/settings/UpdatesTab.tsx`, add event listeners beside macOS/Windows listeners:

```tsx
const offLinuxProgress = onEvent('app:update-linux-progress', (payload) => {
  const p = payload as { version?: string; downloaded?: number; total?: number };
  setState('downloading');
  if (p.version) setUpdateVersion(p.version);
  setProgress({
    downloaded: Number.isFinite(p.downloaded) ? Number(p.downloaded) : 0,
    total: Number.isFinite(p.total) ? Number(p.total) : 0,
  });
});
const offLinuxReady = onEvent('app:update-linux-ready', (payload) => {
  const p = payload as { version?: string };
  setState('ready');
  if (p.version) setUpdateVersion(p.version);
});
```

Return both unsubscribers from the effect cleanup.

Change the ready button branch:

```tsx
) : platform === 'linux' ? (
  <Button type="button" size="sm" onClick={() => void onInstall()} className="gap-1">
    <ExternalLink className="h-3.5 w-3.5" />
    Open download
  </Button>
) : (
```

Add Linux ready copy after the macOS copy:

```tsx
{platform === 'linux' && (
  <div className="text-[11px] text-muted-foreground">
    Linux update downloaded. Replace your AppImage manually or install the new .deb from GitHub Releases.
  </div>
)}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm exec vitest run src/renderer/features/settings/UpdatesTab.test.tsx
pnpm exec vitest run src/shared/rpc-channels.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add electron/auto-update.ts src/shared/rpc-channels.ts src/renderer/features/settings/UpdatesTab.tsx src/renderer/features/settings/UpdatesTab.test.tsx
git commit -m "feat(linux): support manual update downloads"
```

## Task 7: Native Voice Package Resolution On Linux

**Files:**
- Modify: `app/package.json`
- Modify: `app/native/voice-whisper/package.json:15-18`
- Create: `app/native/voice-whisper/scripts/install-or-stub.cjs`
- Test: `app/packages/voice-core/src/whisper-engine.test.ts`

- [ ] **Step 1: Add failing module-resolution check**

Run after `pnpm run product:check`:

```bash
node - <<'NODE'
const { createRequire } = require('module');
const req = createRequire(require('path').resolve('electron-dist/main.js'));
try {
  req('@sigmalink/voice-whisper');
} catch (err) {
  console.error(err.code);
  process.exit(1);
}
NODE
```

Expected before implementation: `MODULE_NOT_FOUND` on hosts where the workspace package is not root-linked.

- [ ] **Step 2: Promote voice-whisper to a root runtime dependency**

In `app/package.json`, add to `dependencies`:

```json
"@sigmalink/voice-whisper": "workspace:*"
```

Keep `@sigmalink/voice-core` as-is.

- [ ] **Step 3: Make voice-whisper install degrade cleanly**

Create `app/native/voice-whisper/scripts/install-or-stub.cjs`:

```js
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor', 'whisper.cpp');

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

const prebuild = run(process.execPath, [require.resolve('node-gyp-build/bin.js')]);
if (prebuild.status === 0) process.exit(0);

if (!fs.existsSync(path.join(vendor, 'src', 'whisper.cpp'))) {
  console.warn('[voice-whisper] vendor sources absent; installing JS stub only');
  process.exit(0);
}

const rebuild = run(process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp', ['rebuild']);
process.exit(rebuild.status ?? 1);
```

Change `app/native/voice-whisper/package.json`:

```json
"scripts": {
  "install": "node scripts/install-or-stub.cjs",
  "rebuild": "node-gyp rebuild",
  "prebuild": "prebuildify --napi --strip"
}
```

Add `"scripts"` to the `files` array:

```json
"files": [
  "index.js",
  "index.d.ts",
  "src",
  "scripts",
  "binding.gyp",
  "prebuilds"
]
```

- [ ] **Step 4: Install and verify resolution**

Run:

```bash
pnpm install --no-frozen-lockfile
pnpm run product:check
node - <<'NODE'
const { createRequire } = require('module');
const req = createRequire(require('path').resolve('electron-dist/main.js'));
const mod = req('@sigmalink/voice-whisper');
if (!mod || typeof mod.transcribe !== 'function') throw new Error('voice-whisper did not resolve');
NODE
```

Expected: no output, exit `0`.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml native/voice-whisper/package.json native/voice-whisper/scripts/install-or-stub.cjs
git commit -m "fix(linux): package voice-whisper runtime stub"
```

## Task 8: Linux Release Workflow

**Files:**
- Create: `.github/workflows/release-linux.yml`
- Modify: `app/electron-builder.yml`

- [ ] **Step 1: Create release workflow**

Create `.github/workflows/release-linux.yml`:

```yaml
name: release-linux

on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      attach_to_release:
        description: Attach to the GitHub Release matching this tag
        required: false
        default: 'false'

concurrency:
  group: release-linux-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: write

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

jobs:
  build:
    name: build linux installer
    runs-on: ubuntu-latest
    timeout-minutes: 35

    defaults:
      run:
        working-directory: app

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install Linux build dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            build-essential python3 make g++ pkg-config libsecret-1-dev \
            libnss3 libatk-bridge2.0-0 libdrm2 libgbm1 libasound2t64 \
            libgtk-3-0 libxss1 libxtst6 fakeroot rpm

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Setup Node 20
        uses: actions/setup-node@v4
        with:
          node-version: '20.x'
          cache: 'pnpm'
          cache-dependency-path: app/package.json

      - name: Install
        run: pnpm install --no-frozen-lockfile
        env:
          npm_config_build_from_source: 'false'

      - name: Rebuild Electron native modules
        run: npx @electron/rebuild -f -w better-sqlite3 -w node-pty

      - name: Rebuild voice-whisper for Electron
        run: npx @electron/rebuild -f -w @sigmalink/voice-whisper
        continue-on-error: true

      - name: Build renderer + electron
        run: pnpm run build && node scripts/build-electron.cjs

      - name: Build Linux AppImage and deb
        run: pnpm exec electron-builder --linux --publish never

      - name: Upload installer artefacts
        uses: actions/upload-artifact@v4
        with:
          name: sigmalink-linux-installer
          if-no-files-found: error
          retention-days: 30
          path: |
            app/release/*.AppImage
            app/release/*.AppImage.blockmap
            app/release/*.deb
            app/release/latest-linux.yml

      - name: Attach installer to GitHub Release
        if: startsWith(github.ref, 'refs/tags/v') || github.event.inputs.attach_to_release == 'true'
        uses: softprops/action-gh-release@v2
        with:
          files: |
            app/release/*.AppImage
            app/release/*.AppImage.blockmap
            app/release/*.deb
            app/release/latest-linux.yml
          fail_on_unmatched_files: true
```

- [ ] **Step 2: Validate workflow syntax locally**

Run:

```bash
ruby -e "require 'yaml'; YAML.load_file('../.github/workflows/release-linux.yml'); puts 'ok'"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add ../.github/workflows/release-linux.yml electron-builder.yml
git commit -m "ci(linux): add release workflow"
```

## Task 9: Ubuntu CI Smoke Lane

**Files:**
- Modify: `.github/workflows/e2e-matrix.yml:30-75`
- Modify: `.github/workflows/lint-and-build.yml:24-62`
- Modify: `app/package.json`

- [ ] **Step 1: Add Ubuntu to e2e matrix**

In `.github/workflows/e2e-matrix.yml`, change:

```yaml
matrix:
  os: [windows-latest, macos-14]
```

to:

```yaml
matrix:
  os: [windows-latest, macos-14, ubuntu-latest]
```

Add after checkout:

```yaml
      - name: Install Linux runtime dependencies
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            xvfb libnss3 libatk-bridge2.0-0 libdrm2 libgbm1 libasound2t64 \
            libgtk-3-0 libxss1 libxtst6
```

Change the Playwright step to:

```yaml
      - name: Run Playwright smoke
        run: ${{ runner.os == 'Linux' && 'xvfb-run --auto-servernum --server-args="-screen 0 1440x900x24" pnpm exec playwright test --reporter=line,html' || 'pnpm exec playwright test --reporter=line,html' }}
```

If GitHub expression interpolation rejects that shell form, split it into two steps:

```yaml
      - name: Run Playwright smoke
        if: runner.os != 'Linux'
        run: pnpm exec playwright test --reporter=line,html

      - name: Run Playwright smoke under Xvfb
        if: runner.os == 'Linux'
        run: xvfb-run --auto-servernum --server-args="-screen 0 1440x900x24" pnpm exec playwright test --reporter=line,html
```

- [ ] **Step 2: Add cheap Ubuntu product gate**

In `.github/workflows/lint-and-build.yml`, either rename the current macOS job accurately or add a second job. Add this second job:

```yaml
  linux-product-check:
    name: product check (ubuntu)
    runs-on: ubuntu-latest
    timeout-minutes: 15

    defaults:
      run:
        working-directory: app

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install Linux build dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y build-essential python3 make g++ pkg-config libsecret-1-dev

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Setup Node 20
        uses: actions/setup-node@v4
        with:
          node-version: '20.x'
          cache: 'pnpm'
          cache-dependency-path: app/package.json

      - name: Install
        run: pnpm install --no-frozen-lockfile

      - name: Product check
        run: pnpm run product:check
```

- [ ] **Step 3: Validate workflow YAML**

Run:

```bash
ruby -e "require 'yaml'; %w[../.github/workflows/e2e-matrix.yml ../.github/workflows/lint-and-build.yml].each { |f| YAML.load_file(f) }; puts 'ok'"
```

Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add ../.github/workflows/e2e-matrix.yml ../.github/workflows/lint-and-build.yml
git commit -m "ci(linux): add ubuntu product and smoke gates"
```

## Task 10: Linux Installer Script

**Files:**
- Create: `app/scripts/install-linux.sh`
- Modify: `.github/workflows/lint-and-build.yml`
- Modify: `app/README.md`

- [ ] **Step 1: Create installer script**

Create `app/scripts/install-linux.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="s1gmamale1/SigmaLink"
APP_NAME="SigmaLink"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "x This installer is Linux-only. Detected: $(uname -s)" >&2
  exit 2
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" && "$ARCH" != "amd64" ]]; then
  echo "x Only Linux x64 is supported. Detected: $ARCH" >&2
  exit 2
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  ID="unknown"
  VERSION_ID="unknown"
fi

if [[ "${ID:-unknown}" != "ubuntu" ]]; then
  echo "x This installer supports Ubuntu 22.04/24.04. Detected: ${ID:-unknown} ${VERSION_ID:-unknown}" >&2
  echo "  Use the AppImage from GitHub Releases for other distributions." >&2
  exit 2
fi

case "${VERSION_ID:-unknown}" in
  22.04|24.04) ;;
  *)
    echo "x Supported Ubuntu versions are 22.04 and 24.04. Detected: ${VERSION_ID:-unknown}" >&2
    exit 2
    ;;
esac

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  TAG="$(
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep '"tag_name"' \
      | head -1 \
      | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/'
  )"
fi

if [[ -z "$TAG" ]]; then
  echo "x Could not determine release tag." >&2
  exit 3
fi

VERSION="${TAG#v}"
DEB_NAME="${APP_NAME}-${VERSION}.deb"
URL="https://github.com/$REPO/releases/download/$TAG/$DEB_NAME"
WORK_DIR="$(mktemp -d -t sigmalink-linux-install.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

DEB_PATH="$WORK_DIR/$DEB_NAME"
echo "-> Downloading $URL"
curl -fL --progress-bar "$URL" -o "$DEB_PATH"

echo "-> Installing $DEB_NAME"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get install -y "$DEB_PATH"
else
  sudo dpkg -i "$DEB_PATH"
fi

echo "OK: $APP_NAME $TAG installed."
```

- [ ] **Step 2: Make script executable**

Run:

```bash
chmod +x scripts/install-linux.sh
```

- [ ] **Step 3: Add shellcheck**

In `.github/workflows/lint-and-build.yml`, change the shellcheck command:

```yaml
      - name: Shellcheck installers
        run: |
          shellcheck app/scripts/install-macos.sh
          shellcheck app/scripts/install-linux.sh
```

- [ ] **Step 4: Run shellcheck locally if installed**

Run:

```bash
shellcheck scripts/install-linux.sh
```

Expected: no output. If `shellcheck` is not installed locally, run:

```bash
bash -n scripts/install-linux.sh
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-linux.sh ../.github/workflows/lint-and-build.yml
git commit -m "feat(linux): add ubuntu installer script"
```

## Task 11: Documentation And Backlog Promotion

**Files:**
- Modify: `README.md`
- Modify: `app/README.md`
- Modify: `docs/07-test/CI_NOTES.md`
- Modify: `docs/08-bugs/BACKLOG.md`
- Modify: `WISHLIST.md`

- [ ] **Step 1: Update root support table**

In `README.md`, add Linux to the supported platforms table:

```markdown
| Ubuntu 22.04/24.04 (x64) | AppImage + deb | `curl ... install-linux.sh` | AppImage may require executable bit; deb may prompt for sudo | Web Speech / cloud STT fallback; local Whisper best-effort |
```

Replace the Linux unsupported note with:

```markdown
> Linux support targets Ubuntu 22.04/24.04 x64. Other distributions may run the AppImage, but they are not release-gated.
```

- [ ] **Step 2: Update app README distribution table**

In `app/README.md`, add:

```markdown
| Linux x64 AppImage + deb | Built by [`../.github/workflows/release-linux.yml`](../.github/workflows/release-linux.yml) on every `v*` tag push. Ubuntu 22.04/24.04 x64 is smoke-tested under Xvfb. |
| Linux one-line installer | [`scripts/install-linux.sh`](scripts/install-linux.sh). Bash, downloads the `.deb` from GitHub Releases, and installs through `apt-get`. |
```

- [ ] **Step 3: Fix CI notes**

In `docs/07-test/CI_NOTES.md`, make the workflow section match the actual end state:

```markdown
- **Runner**: macOS for the existing full lint/coverage gate plus Ubuntu product-check for Linux build coverage.
- **Matrix**: `windows-latest`, `macos-14`, `ubuntu-latest` with `fail-fast: false`.
```

- [ ] **Step 4: Preserve backlog history**

In `docs/08-bugs/BACKLOG.md`, replace the Linux WONTFIX item with:

```markdown
### ~~Linux AppImage / .deb~~ - **PROMOTED (2026-06-16)**
- Promoted from WONTFIX to the full Linux support track. Plan: `app/docs/superpowers/plans/2026-06-16-full-linux-support.md`.
```

- [ ] **Step 5: Mark wishlist entry promoted only when roadmap owns it**

If this work is added to `ROADMAP.md`, update the new `WISHLIST.md` Linux item to:

```markdown
- ~~**[linux] full Ubuntu support track**~~ -> **promoted to ROADMAP Linux support phase** (2026-06-16). Full plan: `app/docs/superpowers/plans/2026-06-16-full-linux-support.md`.
```

If no roadmap phase is created, leave the wishlist entry unstruck.

- [ ] **Step 6: Commit**

```bash
git add ../README.md README.md ../docs/07-test/CI_NOTES.md ../docs/08-bugs/BACKLOG.md ../WISHLIST.md
git commit -m "docs(linux): document ubuntu support contract"
```

## Task 12: End-To-End Verification Matrix

**Files:**
- Modify: `app/docs/superpowers/plans/2026-06-16-full-linux-support.md`

- [ ] **Step 1: Run local universal gates**

Run:

```bash
pnpm run lint
pnpm run test
pnpm run product:check
```

Expected:

```text
lint: exit 0
test: all test files pass
product:check: renderer build and electron compile pass
```

- [ ] **Step 2: Run Linux package build on Ubuntu**

On an Ubuntu 24.04 x64 runner or local VM:

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 make g++ pkg-config libsecret-1-dev fakeroot rpm
cd app
pnpm install --no-frozen-lockfile
npx @electron/rebuild -f -w better-sqlite3 -w node-pty
npx @electron/rebuild -f -w @sigmalink/voice-whisper || true
pnpm electron:pack:linux
ls -1 release/*.AppImage release/*.deb release/latest-linux.yml
```

Expected: all three release paths exist.

- [ ] **Step 3: Smoke the AppImage**

On Ubuntu with a desktop or Xvfb:

```bash
chmod +x release/*.AppImage
xvfb-run --auto-servernum --server-args="-screen 0 1440x900x24" pnpm exec playwright test --reporter=line,html
```

Expected: Playwright smoke suite passes.

- [ ] **Step 4: Smoke the deb install**

On a clean Ubuntu VM:

```bash
sudo apt-get install -y ./release/*.deb
sigmalink --version || true
```

Expected: package installs without missing shared-library errors. If the binary name is not `sigmalink`, verify launch through the desktop entry:

```bash
grep -R "Exec=" /usr/share/applications | grep -i sigmalink
```

- [ ] **Step 5: Manual runtime checklist**

Perform these checks on Ubuntu 24.04 x64:

```text
1. Launch SigmaLink from desktop menu.
2. Create a workspace from a Git repo.
3. Open one shell pane.
4. Run `echo ok`.
5. Install or detect one provider CLI.
6. Launch one provider pane.
7. Stop the pane and verify no child provider process remains.
8. Restart SigmaLink and verify the workspace restores.
9. Settings -> Updates -> Check for updates reports either "no update" or downloads the AppImage.
10. Voice global capture either writes to focused pane or copies to clipboard with a toast.
```

Expected: every item succeeds without uncaught main-process errors.

- [ ] **Step 6: Commit verification log**

Append a dated verification note to this plan:

```markdown
## Verification Log

- 2026-06-16 Ubuntu 24.04 x64: `pnpm electron:pack:linux` produced AppImage, deb, and latest-linux.yml.
- 2026-06-16 Ubuntu 24.04 x64: Playwright smoke passed under Xvfb.
- 2026-06-16 Ubuntu 24.04 x64: manual runtime checklist passed.
```

Commit:

```bash
git add docs/superpowers/plans/2026-06-16-full-linux-support.md
git commit -m "docs(linux): record verification results"
```

## Self-Review

- Spec coverage: support contract, packaging, release workflow, CI, process cleanup/stats, shell safety, PATH bootstrap, provider install safety, native package resolution, update UX, installer, docs, and verification are all assigned to tasks.
- Placeholder scan: no task depends on unspecified code or unnamed files.
- Type consistency: new helpers are named consistently: `parseLinuxPsRows`, `linuxToolPathCandidates`, `mergePathEntries`, and `providerInstallCommandFor`.
