// Phase 4 Track C — Ruflo MCP RPC controller.
//
// Exposes 6 channels under the `ruflo.*` namespace. Each method returns a
// well-typed envelope; when the supervisor is `absent` / `down` / `degraded`,
// the call returns `{ ok: false, code: 'ruflo-unavailable' }` so the renderer
// can fall back silently rather than surface a global toast.
//
// Channels:
//   ruflo.health             → RufloHealth
//   ruflo.embeddings.search  → forwards to `embeddings_search`
//   ruflo.embeddings.generate → forwards to `embeddings_generate`
//   ruflo.patterns.search    → forwards to `agentdb_pattern-search`
//   ruflo.patterns.store     → forwards to `agentdb_pattern-store`
//   ruflo.autopilot.predict  → forwards to `autopilot_predict`
//   ruflo.install.start      → kicks off the lazy installer
//
// This controller mirrors the `defineController` pattern used by every other
// main-process controller — bodies are async, errors throw, the rpc-router
// wraps them into the `{ ok, data, error }` envelope.

import { defineController } from '../../../shared/rpc';
import type { RufloMcpSupervisor } from './supervisor';
import type { RufloProxy } from './proxy';
import type { RufloInstaller } from './installer';
import type { RufloHealth } from './types';

export interface RufloControllerDeps {
  supervisor: RufloMcpSupervisor;
  proxy: RufloProxy;
  installer: RufloInstaller;
}

export interface UnavailableEnvelope {
  ok: false;
  code: 'ruflo-unavailable';
  reason: string;
}

function unavailable(reason: string): UnavailableEnvelope {
  return { ok: false, code: 'ruflo-unavailable', reason };
}

function isUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.startsWith('ruflo-unavailable') || err.message.startsWith('ruflo-timeout');
}

export function buildRufloController(deps: RufloControllerDeps) {
  const { supervisor, proxy, installer } = deps;

  return defineController({
    health: async (): Promise<RufloHealth> => supervisor.health(),

    'embeddings.search': async (input: {
      query: string;
      topK?: number;
      threshold?: number;
      namespace?: string;
    }): Promise<
      | { ok: true; results: Array<{ id: string; score: number; text: string; namespace?: string }> }
      | UnavailableEnvelope
    > => {
      if (!proxy.isReady()) return unavailable(`supervisor state ${supervisor.health().state}`);
      try {
        const raw = (await proxy.call('embeddings_search', {
          query: input.query,
          topK: input.topK ?? 10,
          threshold: input.threshold ?? 0.5,
          namespace: input.namespace,
        })) as { results?: unknown };
        const results = Array.isArray(raw?.results) ? raw.results : [];
        return {
          ok: true,
          results: results
            .map((r) => normalizeEmbeddingHit(r))
            .filter((r): r is { id: string; score: number; text: string; namespace?: string } => r !== null),
        };
      } catch (err) {
        if (isUnavailableError(err)) return unavailable((err as Error).message);
        throw err;
      }
    },

    'embeddings.generate': async (input: {
      text: string;
      hyperbolic?: boolean;
      normalize?: boolean;
    }): Promise<
      | { ok: true; embedding: number[]; dimensions: number }
      | UnavailableEnvelope
    > => {
      if (!proxy.isReady()) return unavailable(`supervisor state ${supervisor.health().state}`);
      try {
        const raw = (await proxy.call('embeddings_generate', {
          text: input.text,
          hyperbolic: input.hyperbolic ?? false,
          normalize: input.normalize ?? true,
        })) as { embedding?: number[]; dimensions?: number };
        return {
          ok: true,
          embedding: Array.isArray(raw?.embedding) ? raw.embedding : [],
          dimensions: typeof raw?.dimensions === 'number' ? raw.dimensions : 0,
        };
      } catch (err) {
        if (isUnavailableError(err)) return unavailable((err as Error).message);
        throw err;
      }
    },

    'patterns.search': async (input: {
      query: string;
      topK?: number;
      minConfidence?: number;
    }): Promise<
      | {
          ok: true;
          results: Array<{ pattern: string; type?: string; confidence: number; score: number }>;
        }
      | UnavailableEnvelope
    > => {
      if (!proxy.isReady()) return unavailable(`supervisor state ${supervisor.health().state}`);
      try {
        const raw = (await proxy.call('agentdb_pattern-search', {
          query: input.query,
          topK: input.topK ?? 5,
          minConfidence: input.minConfidence ?? 0.7,
        })) as { results?: unknown };
        const results = Array.isArray(raw?.results) ? raw.results : [];
        return {
          ok: true,
          results: results
            .map((r) => normalizePatternHit(r))
            .filter(
              (r): r is { pattern: string; type?: string; confidence: number; score: number } =>
                r !== null,
            ),
        };
      } catch (err) {
        if (isUnavailableError(err)) return unavailable((err as Error).message);
        throw err;
      }
    },

    'patterns.store': async (input: {
      pattern: string;
      type?: string;
      confidence?: number;
    }): Promise<{ ok: true; id?: string } | UnavailableEnvelope> => {
      if (!proxy.isReady()) return unavailable(`supervisor state ${supervisor.health().state}`);
      try {
        // CRITICAL: upstream wants `{ pattern, type, confidence }` — NOT
        // `{ namespace, key, value }`. The original Phase 4 plan got this
        // wrong; ruflo-researcher's correction is the source of truth.
        const raw = (await proxy.call('agentdb_pattern-store', {
          pattern: input.pattern,
          type: input.type ?? 'task-completion',
          confidence: input.confidence ?? 0.8,
        })) as { id?: string };
        return { ok: true, id: typeof raw?.id === 'string' ? raw.id : undefined };
      } catch (err) {
        if (isUnavailableError(err)) return unavailable((err as Error).message);
        throw err;
      }
    },

    'autopilot.predict': async (): Promise<
      | {
          ok: true;
          suggestion: { title: string; detail?: string; commandId?: string; args?: unknown } | null;
        }
      | UnavailableEnvelope
    > => {
      if (!proxy.isReady()) return unavailable(`supervisor state ${supervisor.health().state}`);
      try {
        const raw = (await proxy.call('autopilot_predict', {})) as {
          suggestion?: { title?: string; detail?: string; commandId?: string; args?: unknown };
        };
        if (!raw?.suggestion || typeof raw.suggestion.title !== 'string') {
          return { ok: true, suggestion: null };
        }
        return {
          ok: true,
          suggestion: {
            title: raw.suggestion.title,
            detail: raw.suggestion.detail,
            commandId: raw.suggestion.commandId,
            args: raw.suggestion.args,
          },
        };
      } catch (err) {
        if (isUnavailableError(err)) return unavailable((err as Error).message);
        throw err;
      }
    },

    'install.start': async (): Promise<{ jobId: string }> => {
      const { jobId, promise } = installer.start();
      // Fire-and-forget — the renderer subscribes to `ruflo:install-progress`
      // events for streaming status. When the install lands, re-probe so the
      // supervisor flips from `absent` → `down` and the user can `start()`.
      void promise.then(({ ok }) => {
        if (ok) {
          supervisor.rescanInstall();
          void supervisor.start();
        }
      });
      return { jobId };
    },
  });
}

function normalizeEmbeddingHit(
  raw: unknown,
): { id: string; score: number; text: string; namespace?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { id?: unknown; score?: unknown; text?: unknown; namespace?: unknown };
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    score: typeof r.score === 'number' ? r.score : 0,
    text: typeof r.text === 'string' ? r.text : '',
    namespace: typeof r.namespace === 'string' ? r.namespace : undefined,
  };
}

function normalizePatternHit(
  raw: unknown,
): { pattern: string; type?: string; confidence: number; score: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { pattern?: unknown; type?: unknown; confidence?: unknown; score?: unknown };
  if (typeof r.pattern !== 'string') return null;
  return {
    pattern: r.pattern,
    type: typeof r.type === 'string' ? r.type : undefined,
    confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    score: typeof r.score === 'number' ? r.score : 0,
  };
}
