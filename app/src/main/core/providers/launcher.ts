// V1.1 Provider Launcher Façade
//
// Single source-of-truth for spawning agent provider PTYs. Centralises four
// behaviours that were previously scattered across `executeLaunchPlan`,
// `spawnAgentSession`, and ad-hoc renderer calls — and were therefore broken:
//
//   1. BUG-V1.1-01-PROV — `comingSoon` providers (BridgeCode) silently swap to
//      their `fallbackProviderId` (Claude) at spawn. Caller learns the swap
//      happened via `fallbackOccurred` and can persist it to
//      `agent_sessions.providerEffective`.
//   2. BUG-V1.1-05-PROV — on ENOENT we walk `[command, ...altCommands]` and
//      try each in turn before giving up.
//   3. BUG-V1.1-06-PROV — when `autoApprove === true` and the provider exposes
//      `autoApproveFlag`, we append it to `args`.
//   4. BUG-V1.1-07-PROV — main-side re-check of `kv['providers.showLegacy']`
//      so a renderer that bypasses its gate still cannot spawn an Aider /
//      Continue session.
//
// The façade is deliberately thin: it does NOT touch the database, mailbox,
// worktree pool, or RPC. Callers (executeLaunchPlan, spawnAgentSession) own
// all of that. The façade just resolves and spawns.

import type { PtyRegistry, SessionRecord } from '../pty/registry';
import {
  AGENT_PROVIDERS,
  findProvider,
  type AgentProviderDefinition,
  type ProviderId,
} from '../../../shared/providers';

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export interface ResolveAndSpawnOpts {
  providerId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  /** Append `provider.autoApproveFlag` to args when true and a flag exists. */
  autoApprove?: boolean;
  /**
   * Caller-provided value of `kv['providers.showLegacy']`. When `false` (the
   * default) and the resolved provider is `legacy`, the façade refuses to
   * spawn. Pass `true` only after the user has explicitly opted in.
   */
  showLegacy?: boolean;
  /** Extra trailing args (e.g. one-shot prompt tokens, initial-prompt flag). */
  extraArgs?: string[];
  /** Reuse an existing SigmaLink PTY session id when relaunching a pane. */
  sessionId?: string;
}

export interface ResolveAndSpawnResult {
  ptySession: SessionRecord;
  providerRequested: string;
  providerEffective: string;
  commandUsed: string;
  argsUsed: string[];
  /** True when comingSoon → fallback substitution occurred. */
  fallbackOccurred: boolean;
}

export interface LauncherDeps {
  ptyRegistry: PtyRegistry;
  /** Defaults to the shared registry helper; overridable for tests. */
  getProvider?: (id: string) => AgentProviderDefinition | undefined;
}

// ──────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────

export type ProviderLaunchErrorCode =
  | 'unknown-provider'
  | 'legacy-disabled'
  | 'no-command'
  | 'spawn-failed';

export class ProviderLaunchError extends Error {
  // tsconfig has `erasableSyntaxOnly` so we cannot use TS constructor
  // parameter properties; declare + assign explicitly instead.
  readonly code: ProviderLaunchErrorCode;
  readonly details: unknown;
  constructor(
    message: string,
    code: ProviderLaunchErrorCode,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ProviderLaunchError';
    this.code = code;
    this.details = details;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve `providerId` honouring the comingSoon→fallback swap. Returns the
 * effective provider definition plus a flag indicating whether the swap
 * happened. `fallbackProviderId` is followed at most once: if the fallback is
 * itself comingSoon (misconfiguration) we surface the original definition so
 * the caller's spawn attempt produces a useful error.
 */
function resolveProvider(
  providerId: string,
  getProvider: (id: string) => AgentProviderDefinition | undefined,
): { def: AgentProviderDefinition; fallbackOccurred: boolean } {
  const requested = getProvider(providerId);
  if (!requested) {
    throw new ProviderLaunchError(
      `Unknown provider: ${providerId}`,
      'unknown-provider',
    );
  }
  if (requested.comingSoon && requested.fallbackProviderId) {
    const fallback = getProvider(requested.fallbackProviderId);
    if (fallback && !fallback.comingSoon) {
      return { def: fallback, fallbackOccurred: true };
    }
  }
  return { def: requested, fallbackOccurred: false };
}

/**
 * Build the final argv: `[...provider.args, autoApproveFlag?, ...extraArgs]`.
 * The provider's own `args` come first so caller-supplied flags can override
 * positional behaviour without surgery on the registry.
 */
function buildArgs(
  provider: AgentProviderDefinition,
  opts: ResolveAndSpawnOpts,
): string[] {
  const base = [...provider.args];
  if (opts.autoApprove && provider.autoApproveFlag) {
    base.push(provider.autoApproveFlag);
  }
  if (opts.extraArgs && opts.extraArgs.length) {
    base.push(...opts.extraArgs);
  }
  return base;
}

/**
 * Recognise an ENOENT-shaped failure. The PTY layer can surface failure as
 * either a thrown error (POSIX `execvp` ENOENT) or as a synthetic exit code
 * (-1 from spawnLocalPty's catch). We accept both.
 */
function isENOENT(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; errno?: number; message?: string };
  if (e.code === 'ENOENT') return true;
  if (typeof e.message === 'string' && /ENOENT|not found|cannot find/i.test(e.message)) {
    return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Public entrypoint
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve the requested provider, apply gating + fallback rules, then spawn
 * a PTY session via `deps.ptyRegistry.create`. The caller owns DB writes,
 * worktree wiring, and mailbox routing; this function only returns the
 * resolved session record + metadata.
 */
export function resolveAndSpawn(
  deps: LauncherDeps,
  opts: ResolveAndSpawnOpts,
): ResolveAndSpawnResult {
  const getProvider = deps.getProvider ?? findProvider;

  // 1. Resolve + apply comingSoon → fallback swap.
  const { def, fallbackOccurred } = resolveProvider(opts.providerId, getProvider);

  // 2. Legacy gate. `shell` and `custom` are never legacy-gated.
  if (def.legacy && opts.showLegacy !== true) {
    throw new ProviderLaunchError(
      `Provider "${def.id}" is marked legacy and is hidden by default. ` +
        `Enable "Show legacy providers" in Settings → Providers to launch it.`,
      'legacy-disabled',
    );
  }

  // 3. Build the final args.
  const args = buildArgs(def, opts);

  // 4. Build the candidate command list. Empty `command` means the provider
  //    is `shell` (open the user's default shell); we hand that through as-is.
  const candidates: string[] = def.command
    ? [def.command, ...(def.altCommands ?? [])].filter(Boolean)
    : [''];
  if (candidates.length === 0) {
    throw new ProviderLaunchError(
      `Provider "${def.id}" has no command configured.`,
      'no-command',
    );
  }

  // 5. Walk the candidates. PtyRegistry.create either returns a SessionRecord
  //    or throws. `spawnLocalPty` itself catches sync spawn errors and emits
  //    a synthetic exit; in that path we cannot detect ENOENT here, so we
  //    rely on POSIX `execvp` propagating ENOENT through node-pty (it does)
  //    or on Windows `resolveWindowsCommand` returning null which surfaces
  //    via the same error path. Either way we try the next alt on failure.
  const errors: { command: string; error: unknown }[] = [];
  for (const command of candidates) {
    try {
      const ptySession = deps.ptyRegistry.create({
        sessionId: opts.sessionId,
        providerId: def.id,
        command,
        args,
        cwd: opts.cwd,
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 32,
        env: opts.env,
      });
      return {
        ptySession,
        providerRequested: opts.providerId,
        providerEffective: def.id,
        commandUsed: command,
        argsUsed: args,
        fallbackOccurred,
      };
    } catch (err) {
      errors.push({ command, error: err });
      if (!isENOENT(err)) {
        // Non-ENOENT failure (permission denied, exec format error, etc.).
        // Don't keep walking — the next candidate would hit the same env.
        throw new ProviderLaunchError(
          `Failed to spawn "${command}" for provider "${def.id}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          'spawn-failed',
          err,
        );
      }
      // ENOENT — try the next candidate.
    }
  }

  // 6. All candidates failed with ENOENT.
  const tried = errors.map((e) => e.command).join(', ');
  throw new ProviderLaunchError(
    `No usable command found for provider "${def.id}". Tried: ${tried}. ` +
      `Install the CLI (\`${def.installHint}\`) or set a custom command.`,
    'spawn-failed',
    errors,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Re-exports for callers
// ──────────────────────────────────────────────────────────────────────────

export { AGENT_PROVIDERS, findProvider };
export type { AgentProviderDefinition, ProviderId };
