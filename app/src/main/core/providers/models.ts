// V3-W12-002 / v1.2.4 model selection layer.
//
// FEAT-14 — the model catalog moved to `src/shared/model-catalog.ts` so the
// renderer (which cannot import main-process modules) and the main process
// share ONE source of truth. This module is now a thin re-export that keeps
// the existing main-side public surface (`MODEL_OPTIONS`, `listModelsFor`,
// `defaultModelFor`, and the `ModelOption` / `ModelEffort` / `ModelTransport`
// types) byte-compatible for any importer.

export type {
  ModelTransport,
  ModelEffort,
  ModelOption,
} from '../../../shared/model-catalog';

export {
  MODEL_OPTIONS,
  listModelsFor,
  defaultModelFor,
  MODEL_FLAG_PROVIDERS,
  providerAcceptsModelFlag,
} from '../../../shared/model-catalog';
