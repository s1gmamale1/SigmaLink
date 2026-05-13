// V1.1 Provider Launcher Façade
//
// Single source-of-truth for spawning agent provider PTYs. Centralises four
// behaviours that were previously scattered across `executeLaunchPlan`,
// `spawnAgentSession`, and ad-hoc renderer calls — and were therefore broken:
//
//   1. BUG-V1.1-01-PROV — `comingSoon` providers silently swap to their
//      `fallbackProviderId` at spawn. Caller learns the swap happened via
//      `fallbackOccurred` and can persist it to
//      `agent_sessions.providerEffective`. (v1.2.4: registry no longer ships
//      a comingSoon row, but the capability is retained for future stubs.)
//   2. BUG-V1.1-05-PROV — on ENOENT we walk `[command, ...altCommands]` and
//      try each in turn before giving up.
//   3. BUG-V1.1-06-PROV — when `autoApprove === true` and the provider exposes
//      `autoApproveFlag`, we append it to `args`.
//   4. BUG-V1.1-07-PROV — main-side re-check of `kv['providers.showLegacy']`
//      so a renderer that bypasses its gate cannot spawn a legacy provider.
//      (v1.2.4: registry no longer ships a legacy row, but the capability is
//      retained for future use.)
//   5. v1.2.8 — UUID pre-assignment for `claude` and `gemini`. We mint a
//      random UUID before spawn, inject `--session-id <uuid>` into args, and
//      return it on the result so the caller can persist it as
//      `external_session_id` without waiting for the CLI to print anything.
//
// The façade is deliberately thin: it does NOT touch the database, mailbox,
// worktree pool, or RPC. Callers (executeLaunchPlan, spawnAgentSession) own
// all of that. The façade just resolves and spawns.

import { randomUUID } from 'node:crypto';
import type { PtyRegistry, SessionRecord } from '../pty/registry';
import {
  AGENT_PROVIDERS,
  findProvider,
  type AgentProviderDefinition,
  type ProviderId,
} from '../../../shared/providers';

/**
 * Providers that accept a pre-assigned session UUID via `--session-id <uuid>`.
 * For everything else (codex, kimi, opencode) we fall back to the async disk
 * scan in `pty/session-disk-scanner.ts`.
 */
const PRE_ASSIGN_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'gemini']);

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
  /**
   * v1.2.8 — UUID we pre-injected into the CLI args via `--session-id <uuid>`
   * for providers that support pre-assignment (claude, gemini). The caller
   * stores this in `agent_sessions.external_session_id` immediately so
   * resume-on-restart no longer waits for the CLI to print anything.
   *
   * Undefined for providers that do not support pre-assignment, when the
   * caller passed `sessionId` (resume path), or when a comingSoon→fallback
   * swap moved us off a pre-assign-capable provider.
   */
  preassignedExternalSessionId?: string;
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
 * Build the final argv: `[--session-id uuid]?, [...provider.args],
 * autoApproveFlag?, ...extraArgs`. The optional pre-assign flag (claude /
 * gemini only) comes FIRST so the CLI sees it before any positional args.
 *
 * The provider's own `args` come next so caller-supplied flags can override
 * positional behaviour without surgery on the registry.
 */
function buildArgs(
  provider: AgentProviderDefinition,
  opts: ResolveAndSpawnOpts,
  preassignedUuid: string | null,
): string[] {
  const out: string[] = [];
  if (preassignedUuid) {
    out.push('--session-id', preassignedUuid);
  }
  out.push(...provider.args);
  if (opts.autoApprove && provider.autoApproveFlag) {
    out.push(provider.autoApproveFlag);
  }
  if (opts.extraArgs && opts.extraArgs.length) {
    out.push(...opts.extraArgs);
  }
  return out;
}

/**
 * Decide whether this spawn should mint a fresh external session UUID and
 * prepend `--session-id <uuid>` to the args.
 *
 * Pre-assign only fires on FRESH spawns (no `opts.sessionId`) for providers
 * known to accept the flag. The resume path supplies its own `sessionId` to
 * reuse the SigmaLink DB row and routes the provider-native resume id through
 * `extraArgs` (`--resume <id>` etc.), so pre-assigning there would inject a
 * conflicting second id.
 */
function shouldPreAssign(
  provider: AgentProviderDefinition,
  opts: ResolveAndSpawnOpts,
): boolean {
  if (opts.sessionId) return false;
  return PRE_ASSIGN_PROVIDERS.has(provider.id);
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

  // 3. Pre-assign a UUID for providers that support `--session-id <uuid>`
  //    (claude, gemini). The flag goes first in argv; we also stamp the
  //    resulting SessionRecord with `externalSessionId` so the caller sees it
  //    on the synchronous return and can persist it immediately.
  const preassignedUuid = shouldPreAssign(def, opts) ? randomUUID() : null;

  // 4. Build the final args.
  const args = buildArgs(def, opts, preassignedUuid);

  // 5. Build the candidate command list. Empty `command` means the provider
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

  // 6. Walk the candidates. PtyRegistry.create either returns a SessionRecord
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
        // v1.2.8 — wire the pre-assigned UUID onto the session record so
        // `executeLaunchPlan` / `spawnAgentSession` can persist it on the
        // same INSERT they already do, without an extra UPDATE round-trip.
        externalSessionId: preassignedUuid ?? undefined,
      });
      return {
        ptySession,
        providerRequested: opts.providerId,
        providerEffective: def.id,
        commandUsed: command,
        argsUsed: args,
        fallbackOccurred,
        preassignedExternalSessionId: preassignedUuid ?? undefined,
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
