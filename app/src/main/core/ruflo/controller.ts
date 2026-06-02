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
//   ruflo.daemonStatus       → list all per-workspace HTTP daemon handles
//   ruflo.restartDaemon      → stop + re-spawn one workspace's HTTP daemon
//
// This controller mirrors the `defineController` pattern used by every other
// main-process controller — bodies are async, errors throw, the rpc-router
// wraps them into the `{ ok, data, error }` envelope.

import http from 'node:http';
import { defineController } from '../../../shared/rpc';
import type { RufloMcpSupervisor } from './supervisor';
import type { RufloProxy } from './proxy';
import type { RufloInstaller } from './installer';
import type { RufloHealth } from './types';
import type { RufloEntry, RufloEntryEdge } from '../../../shared/types';
import type { RufloHttpDaemonSupervisor } from './http-daemon-supervisor';
import { getRawDb } from '../db/client';
import {
  KV_RUFLO_STRICT_MCP_VERIFICATION,
  verifyForWorkspace,
  type RufloWorkspaceVerification,
} from './verify';

export interface DaemonStatusRow {
  workspaceId: string;
  status: string;
  port: number;
  pid: number;
  uptime: number;
  connections: number | null;
}

export interface RufloControllerDeps {
  supervisor: RufloMcpSupervisor;
  proxy: RufloProxy;
  installer: RufloInstaller;
  httpDaemonSupervisor?: RufloHttpDaemonSupervisor;
  emit?: (event: string, payload: unknown) => void;
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
  const emit = deps.emit ?? (() => undefined);

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

    // P4 MEM-1 — surface the Ruflo AgentDB as graph nodes. Sweeps all
    // namespaces via memory_search_unified; the renderer passes a context
    // query (e.g. the active note's name/keywords) to get a relevant
    // neighborhood. Degrades to empty (never throws) when Ruflo is offline.
    'entries.list': async (input: {
      query?: string;
      limit?: number;
    }): Promise<{ ok: true; entries: RufloEntry[] } | UnavailableEnvelope> => {
      if (!proxy.isReady()) return unavailable(`supervisor state ${supervisor.health().state}`);
      try {
        const raw = (await proxy.call('memory_search_unified', {
          query: typeof input.query === 'string' ? input.query : '',
          limit: typeof input.limit === 'number' ? input.limit : 60,
        })) as { results?: unknown };
        const results = Array.isArray(raw?.results) ? raw.results : [];
        return {
          ok: true,
          entries: results
            .map((r) => normalizeEntry(r))
            .filter((e): e is RufloEntry => e !== null),
        };
      } catch (err) {
        if (isUnavailableError(err)) return unavailable((err as Error).message);
        throw err;
      }
    },

    // P4 MEM-1 / P4.2 — neighbors of one entry → similarity edges (semantic) +
    // causal edges. Both reads run side-by-side via Promise.allSettled so a
    // failure (or unexpected shape) in the causal call degrades GRACEFULLY to
    // similarity-only — the canvas already renders kind:'causal' edges (dashed).
    //
    // ASSUMED agentdb_causal-edge READ-API SHAPE (UNVERIFIED — implemented
    // defensively): we call with { id, topK } and accept either
    //   { edges: [{ from|fromId|source, to|toId|target, weight? }, ...] }
    // or a bare top-level array of the same edge objects, or
    //   { results: [...] } / { causal: [...] }.
    // Each edge must yield a target id distinct from the source; `from` is
    // ignored (we always anchor the edge at input.id) and weight defaults to 1.
    // Anything we cannot parse is dropped; a reject/throw drops ALL causal edges
    // and we still return the similarity edges. NEVER throws on causal failure.
    'entries.neighbors': async (input: {
      id: string;
      text: string;
      topK?: number;
    }): Promise<{ ok: true; edges: RufloEntryEdge[] } | UnavailableEnvelope> => {
      if (!proxy.isReady()) return unavailable(`supervisor state ${supervisor.health().state}`);
      if (typeof input.id !== 'string' || !input.id || typeof input.text !== 'string' || !input.text) {
        return { ok: true, edges: [] };
      }
      const topK = typeof input.topK === 'number' ? input.topK : 8;
      try {
        const [simSettled, causalSettled] = await Promise.allSettled([
          proxy.call('embeddings_search', { query: input.text, topK, threshold: 0.4 }),
          proxy.call('agentdb_causal-edge', { id: input.id, topK }),
        ]);

        // Similarity is the primary signal — if it failed because the supervisor
        // is unavailable, surface that; if it failed for another reason, rethrow.
        if (simSettled.status === 'rejected') {
          const err = simSettled.reason;
          if (isUnavailableError(err)) return unavailable((err as Error).message);
          throw err instanceof Error ? err : new Error(String(err));
        }

        const edges: RufloEntryEdge[] = [];
        const seen = new Set<string>();

        const simRaw = simSettled.value as { results?: unknown };
        const simResults = Array.isArray(simRaw?.results) ? simRaw.results : [];
        for (const r of simResults) {
          const hit = normalizeEmbeddingHit(r);
          if (!hit || hit.id === input.id || seen.has(hit.id)) continue;
          seen.add(hit.id);
          edges.push({ fromId: input.id, toId: hit.id, kind: 'similarity', weight: hit.score });
        }

        // Causal edges — best-effort. Any failure / odd shape → just skip them.
        if (causalSettled.status === 'fulfilled') {
          for (const e of extractCausalEdges(causalSettled.value)) {
            if (e.toId === input.id || seen.has(e.toId)) continue;
            seen.add(e.toId);
            edges.push({ fromId: input.id, toId: e.toId, kind: 'causal', weight: e.weight });
          }
        }

        return { ok: true, edges };
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

    verifyForWorkspace: async (workspaceRoot: string): Promise<RufloWorkspaceVerification> => {
      if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
        throw new Error('ruflo.verifyForWorkspace: missing workspaceRoot');
      }
      const mode = readStrictMode() ? 'strict' : 'fast';
      const result = await verifyForWorkspace(workspaceRoot, mode);
      emit('ruflo:workspace-verified', { workspaceRoot, ...result });
      return result;
    },

    // v1.6.1 B2 — Settings → Ruflo Daemon table.
    // Returns a status row for every tracked per-workspace HTTP daemon.
    // `connections` is fetched best-effort via GET /health; null on failure.
    daemonStatus: async (workspaceId?: string): Promise<DaemonStatusRow[]> => {
      const httpSup = deps.httpDaemonSupervisor;
      if (!httpSup) return [];
      const handles = typeof workspaceId === 'string'
        ? (() => {
            const h = httpSup.list().find((x) => x.workspaceRoot === workspaceId || (x as { workspaceId?: string }).workspaceId === workspaceId);
            return h ? [h] : [];
          })()
        : httpSup.list();
      const rows = await Promise.all(
        handles.map(async (h) => {
          const uptime = Date.now() - h.startedAt;
          let connections: number | null = null;
          if (h.status === 'running' && h.port > 0) {
            try {
              const body = await httpGetWithTimeout(`http://127.0.0.1:${h.port}/health`, 1_500);
              const parsed = JSON.parse(body) as { connections?: number };
              if (typeof parsed.connections === 'number') connections = parsed.connections;
            } catch {
              /* best-effort — leave null */
            }
          }
          return {
            workspaceId: (h as unknown as { workspaceId?: string }).workspaceId ?? h.workspaceRoot,
            status: h.status,
            port: h.port,
            pid: h.pid,
            uptime,
            connections,
          } satisfies DaemonStatusRow;
        }),
      );
      return rows;
    },

    // v1.6.1 B2 — Restart a single per-workspace HTTP daemon from Settings.
    restartDaemon: async (workspaceId: string): Promise<{ ok: boolean; error?: string }> => {
      const httpSup = deps.httpDaemonSupervisor;
      if (!httpSup) return { ok: false, error: 'HTTP daemon supervisor not available' };
      if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
        return { ok: false, error: 'ruflo.restartDaemon: missing workspaceId' };
      }
      try {
        await httpSup.restart(workspaceId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

export function readStrictMode(): boolean {
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KV_RUFLO_STRICT_MCP_VERIFICATION) as { value?: string } | undefined;
    return row?.value === '1';
  } catch {
    return false;
  }
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

// P4 MEM-1 — normalize a memory_search_unified row into a RufloEntry, tolerating
// the daemon's key/content/value field variants and preserving the stable id +
// namespace (which today's pattern/embedding normalizers drop).
function normalizeEntry(raw: unknown): RufloEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    key?: unknown;
    id?: unknown;
    content?: unknown;
    text?: unknown;
    value?: unknown;
    namespace?: unknown;
    score?: unknown;
    createdAt?: unknown;
    storedAt?: unknown;
  };
  const id = typeof r.key === 'string' ? r.key : typeof r.id === 'string' ? r.id : null;
  if (!id) return null;
  const text =
    typeof r.content === 'string'
      ? r.content
      : typeof r.text === 'string'
        ? r.text
        : typeof r.value === 'string'
          ? r.value
          : '';
  return {
    id,
    text,
    namespace: typeof r.namespace === 'string' ? r.namespace : 'default',
    score: typeof r.score === 'number' ? r.score : undefined,
    createdAt:
      typeof r.createdAt === 'number'
        ? r.createdAt
        : typeof r.storedAt === 'number'
          ? r.storedAt
          : undefined,
  };
}

// P4.2 — defensively extract causal edges from the UNVERIFIED agentdb_causal-edge
// response. Accepts a bare array, or an object carrying the edge list under
// `edges` / `results` / `causal`. Each edge's target id is read from the first
// present of `toId` / `to` / `target` / `id`; weight from `weight` / `score`
// (default 1, clamped to a finite number). Unparseable entries are dropped.
function extractCausalEdges(raw: unknown): Array<{ toId: string; weight: number }> {
  const list = pickEdgeArray(raw);
  const out: Array<{ toId: string; weight: number }> = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const e = item as {
      toId?: unknown;
      to?: unknown;
      target?: unknown;
      id?: unknown;
      weight?: unknown;
      score?: unknown;
    };
    const toId =
      typeof e.toId === 'string'
        ? e.toId
        : typeof e.to === 'string'
          ? e.to
          : typeof e.target === 'string'
            ? e.target
            : typeof e.id === 'string'
              ? e.id
              : null;
    if (!toId) continue;
    const rawWeight = typeof e.weight === 'number' ? e.weight : typeof e.score === 'number' ? e.score : 1;
    out.push({ toId, weight: Number.isFinite(rawWeight) ? rawWeight : 1 });
  }
  return out;
}

/** Find the array of edge objects inside an unverified causal-edge response. */
function pickEdgeArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as { edges?: unknown; results?: unknown; causal?: unknown };
  if (Array.isArray(r.edges)) return r.edges;
  if (Array.isArray(r.results)) return r.results;
  if (Array.isArray(r.causal)) return r.causal;
  return [];
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

/** Minimal HTTP GET with a ms timeout. Returns the body string or throws. */
function httpGetWithTimeout(url: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('request timeout')); });
  });
}
