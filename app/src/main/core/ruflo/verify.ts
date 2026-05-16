import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type RufloVerifyMode = 'fast' | 'strict';
export type RufloVerifiedCli = 'claude' | 'codex' | 'gemini' | 'kimi' | 'opencode';

export interface RufloVerifyError {
  cli: RufloVerifiedCli;
  message: string;
}

export interface RufloWorkspaceVerification {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  kimi: boolean;
  opencode: boolean;
  detected: { kimi: boolean; opencode: boolean };
  errors: RufloVerifyError[];
  mode: RufloVerifyMode;
}

export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type ProbeRunner = (
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<ProbeResult>;

export interface RufloVerifyOptions {
  homeDir?: string;
  probeRunner?: ProbeRunner;
  strictTimeoutMs?: number;
  /** Test hook — override PATH-based detection for kimi/opencode. */
  detectCli?: (name: 'kimi' | 'opencode') => boolean;
}

const RUFLO_COMMAND = 'npx';
const STRICT_TIMEOUT_MS = 5_000;
export const KV_RUFLO_STRICT_MCP_VERIFICATION = 'ruflo.strictMcpVerification';

export async function verifyForWorkspace(
  workspaceRoot: string,
  mode: RufloVerifyMode = 'fast',
  opts: RufloVerifyOptions = {},
): Promise<RufloWorkspaceVerification> {
  const root = path.resolve(workspaceRoot);
  const home = opts.homeDir ?? os.homedir();
  const detectCli = opts.detectCli ?? defaultDetectCli;
  const detected = {
    kimi: detectCli('kimi'),
    opencode: detectCli('opencode'),
  };
  const fast = verifyFast(root, home, detected);
  if (mode === 'fast') return { ...fast, detected, mode };

  const strict = await verifyStrict(root, detected, {
    probeRunner: opts.probeRunner ?? defaultProbeRunner,
    timeoutMs: opts.strictTimeoutMs ?? STRICT_TIMEOUT_MS,
  });

  return {
    claude: fast.claude && strict.claude,
    codex: fast.codex && strict.codex,
    gemini: fast.gemini && strict.gemini,
    kimi: fast.kimi && strict.kimi,
    opencode: fast.opencode && strict.opencode,
    detected,
    errors: [...fast.errors, ...strict.errors],
    mode,
  };
}

function verifyFast(
  root: string,
  home: string,
  detected: { kimi: boolean; opencode: boolean },
): Omit<RufloWorkspaceVerification, 'mode' | 'detected'> {
  const errors: RufloVerifyError[] = [];
  const claude = checkJsonConfig('claude', path.join(root, '.mcp.json'), errors);
  const codex = checkCodexConfig(path.join(home, '.codex', 'config.toml'), errors);
  const gemini = checkJsonConfig('gemini', path.join(home, '.gemini', 'settings.json'), errors);

  const kimiTarget = path.join(home, '.kimi', 'mcp.json');
  // Silent-skip: when kimi is not detected AND config file is absent, vacuously pass.
  const kimi =
    !detected.kimi && !fs.existsSync(kimiTarget)
      ? true
      : checkJsonConfig('kimi', kimiTarget, errors);

  const opencodeTarget = path.join(home, '.config', 'opencode', 'opencode.json');
  // Silent-skip: when opencode is not detected AND config file is absent, vacuously pass.
  const opencode =
    !detected.opencode && !fs.existsSync(opencodeTarget)
      ? true
      : checkOpencodeConfig(opencodeTarget, errors);

  return { claude, codex, gemini, kimi, opencode, errors };
}

function checkJsonConfig(
  cli: 'claude' | 'gemini' | 'kimi',
  target: string,
  errors: RufloVerifyError[],
): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as {
      mcpServers?: Record<string, { command?: unknown }>;
    };
    const command = raw?.mcpServers?.ruflo?.command;
    if (command === RUFLO_COMMAND) return true;
    errors.push({ cli, message: `${target}: ruflo command is ${String(command ?? 'missing')}` });
  } catch (err) {
    errors.push({ cli, message: `${target}: ${err instanceof Error ? err.message : String(err)}` });
  }
  return false;
}

// v1.3.5 — OpenCode uses a different schema: top-level `mcp` key, flat `command` array,
// `environment` (not `env`), `type: 'local'`, `enabled: true`.
function checkOpencodeConfig(target: string, errors: RufloVerifyError[]): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as {
      mcp?: Record<string, { command?: unknown }>;
    };
    const entry = raw?.mcp?.ruflo;
    const command = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).command
      : undefined;
    if (Array.isArray(command) && command[0] === RUFLO_COMMAND) return true;
    errors.push({
      cli: 'opencode',
      message: `${target}: ruflo command is ${Array.isArray(command) ? JSON.stringify(command) : String(command ?? 'missing')}`,
    });
  } catch (err) {
    errors.push({
      cli: 'opencode',
      message: `${target}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return false;
}

function checkCodexConfig(target: string, errors: RufloVerifyError[]): boolean {
  try {
    const source = fs.readFileSync(target, 'utf8');
    const block = findTomlTableBlock(source, 'mcp_servers.ruflo');
    const command = block ? parseTomlStringValue(block, 'command') : null;
    if (command === RUFLO_COMMAND) return true;
    errors.push({ cli: 'codex', message: `${target}: ruflo command is ${command ?? 'missing'}` });
  } catch (err) {
    errors.push({
      cli: 'codex',
      message: `${target}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return false;
}

async function verifyStrict(
  root: string,
  detected: { kimi: boolean; opencode: boolean },
  opts: { probeRunner: ProbeRunner; timeoutMs: number },
): Promise<Omit<RufloWorkspaceVerification, 'mode' | 'detected'>> {
  const probes: Array<{ cli: RufloVerifiedCli; command: string; args: string[] }> = [
    { cli: 'claude', command: 'claude', args: ['mcp', 'list', '--workspace', root] },
    { cli: 'codex', command: 'codex', args: ['mcp', 'list'] },
    { cli: 'gemini', command: 'gemini', args: ['mcp', 'list'] },
    // kimi/opencode support `mcp list` (confirmed via --help); gated on detection so
    // uninstalled CLIs don't cause spurious errors.
    ...(detected.kimi
      ? [{ cli: 'kimi' as RufloVerifiedCli, command: 'kimi', args: ['mcp', 'list'] }]
      : []),
    ...(detected.opencode
      ? [{ cli: 'opencode' as RufloVerifiedCli, command: 'opencode', args: ['mcp', 'list'] }]
      : []),
  ];
  const entries = await Promise.all(
    probes.map(async (probe) => {
      const result = await opts.probeRunner(probe.command, probe.args, {
        cwd: root,
        timeoutMs: opts.timeoutMs,
      });
      const haystack = `${result.stdout}\n${result.stderr}`.toLowerCase();
      const ok = result.code === 0 && haystack.includes('ruflo');
      const message =
        result.error ??
        (ok
          ? ''
          : `${probe.command} ${probe.args.join(' ')} exited ${result.code ?? 'unknown'} without ruflo`);
      return { cli: probe.cli, ok, message };
    }),
  );

  const errors: RufloVerifyError[] = [];
  const out: Omit<RufloWorkspaceVerification, 'mode' | 'detected'> = {
    claude: false,
    codex: false,
    gemini: false,
    // When not detected, vacuously pass in strict mode (fast result governs).
    kimi: !detected.kimi,
    opencode: !detected.opencode,
    errors,
  };
  for (const entry of entries) {
    out[entry.cli] = entry.ok;
    if (!entry.ok) errors.push({ cli: entry.cli, message: entry.message });
  }
  return out;
}

function defaultProbeRunner(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      resolve({ code: null, stdout, stderr, error: `${command} probe timed out` });
    }, opts.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: err.message });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// v1.3.5 — PATH-or-`.cmd` probe for Kimi / OpenCode CLI binaries, mirroring the
// implementation in mcp-autowrite.ts. Used to gate strict-mode probes and
// silent-skip fast-mode checks for CLIs the user hasn't installed.
function defaultDetectCli(name: 'kimi' | 'opencode'): boolean {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  const candidates =
    process.platform === 'win32'
      ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
      : [name];
  for (const dir of pathEntries) {
    if (!dir) continue;
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(path.join(dir, candidate))) return true;
      } catch {
        /* PATH entry inaccessible — ignore */
      }
    }
  }
  return false;
}

function findTomlTableBlock(source: string, table: string): string | null {
  const headerRe = /^\s*\[([^\]]+)\]\s*$/gm;
  let match: RegExpExecArray | null;
  let start = -1;
  let end = source.length;
  while ((match = headerRe.exec(source))) {
    const header = match[1]?.trim();
    if (header === table) {
      start = match.index;
      continue;
    }
    if (start >= 0) {
      end = match.index;
      break;
    }
  }
  return start >= 0 ? source.slice(start, end) : null;
}

function parseTomlStringValue(source: string, key: string): string | null {
  const keyPattern = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${keyPattern}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*(?:#.*)?$`, 'm');
  const match = re.exec(source);
  return match ? (match[1] ?? match[2] ?? '') : null;
}
