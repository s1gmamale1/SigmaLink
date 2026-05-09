// V3-W12-001: canonical provider type façade for the main process.
//
// The actual data lives in `src/shared/providers.ts` (renderer-safe). This
// file is the import seam the V3 backlog tickets refer to so future main-only
// extensions (probe-side metadata, runtime-only flags) can land here without
// rippling through the renderer surface.

export type {
  AgentProviderDefinition as ProviderDefinition,
  ProviderId,
} from '../../../shared/providers';
