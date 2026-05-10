// V3-W12-001 / V3-W12-002 / V3-W12-003: provider registry façade.
//
// Re-exports the renderer-safe definitions from `shared/providers.ts` plus
// helpers that callers in `main/` can import from the canonical
// `core/providers/registry` path documented in the V3 parity backlog.
//
// V1.1: also re-exports the spawn façade (`resolveAndSpawn`) so callers can
// route every PTY spawn through the single chokepoint that handles the
// comingSoon fallback, altCommands ENOENT walk, autoApprove flag, and
// legacy-provider gate.

export {
  AGENT_PROVIDERS,
  findProvider,
  listDetectable,
  listVisibleProviders,
} from '../../../shared/providers';
export type {
  AgentProviderDefinition,
  AgentProviderDefinition as ProviderDefinition,
  ProviderId,
} from '../../../shared/providers';

export {
  resolveAndSpawn,
  ProviderLaunchError,
} from './launcher';
export type {
  ResolveAndSpawnOpts,
  ResolveAndSpawnResult,
  LauncherDeps,
} from './launcher';
