// V3-W12-017 / W13-XX — per-channel zod schema registry (soft-launch).
//
// Goal: every IPC channel listed in `app/src/shared/rpc-channels.ts` declares
// at minimum a placeholder zod schema here so future waves can tighten payload
// validation without a coordination round. In dev mode the rpc-router warns
// (console.warn) when a registered controller method has no entry in this map;
// in production we stay silent — enforcement (reject on validation fail) is a
// separate W13 ticket [V3-W13-XX] and **MUST NOT** flip on yet.
//
// Schema convention:
//   - `input`  — parsed against the first IPC arg (most controllers take a
//                single object). Use `z.any()` where the existing TypeScript
//                signature already covers shape; the framework wiring is what
//                matters this round.
//   - `output` — parsed against the resolved value of the controller. Same
//                rules: prefer `z.any()` for permissive soft-launch.
//
// To tighten a channel: replace the relevant `z.any()` with a concrete schema
// and (in W13) flip `MODE` below to `'enforce'`.

import { z } from 'zod';

const any = z.any();

export type ChannelSchema = {
  input?: z.ZodTypeAny;
  output?: z.ZodTypeAny;
};

const stub: ChannelSchema = { input: any, output: any };

/**
 * Validation mode for the rpc-router. Stays at `'warn'` through W12 — only
 * dev builds emit console.warn on missing schemas; production does nothing.
 * W13 is expected to flip enforcement on for namespaces that have hardened
 * schemas. Do NOT flip to `'enforce'` until every channel below has a
 * non-`z.any()` shape.
 */
export const VALIDATION_MODE: 'warn' | 'enforce' = 'warn';

// V3-W15-005 — Plan tier enum. Mirrors `Tier` in core/plan/capabilities.ts.
// Hardened (not `stub`) because the controller has a single, well-known shape
// and `app.tier` is read from the renderer on every Settings → Appearance
// mount; tightening here is free.
const TIER_ENUM = z.enum(['basic', 'pro', 'ultra']);
const APP_TIER_SCHEMA: ChannelSchema = {
  input: z.undefined().optional(),
  output: TIER_ENUM,
};

// V3-W14-001..006 — Bridge Canvas teardown hook. The design controller exposes
// a `shutdown()` method that `rpc-router.shutdownRouter` calls to tear down
// picker overlays + dev-server watchers. The preload bridge does NOT allow-
// list `design.shutdown`, so the renderer can never invoke it; the schema
// entry exists purely to silence the soft-launch missing-schema warning.
const DESIGN_SHUTDOWN_SCHEMA: ChannelSchema = {
  input: z.undefined().optional(),
  output: z.void(),
};

export const OpenWorkspacesChangedEventSchema = z.object({
  workspaceIds: z.array(z.string().min(1).max(200)),
});

export type OpenWorkspacesChangedEvent = z.infer<typeof OpenWorkspacesChangedEventSchema>;

export const CHANNEL_SCHEMAS: Record<string, ChannelSchema> = {
  // ── app ──────────────────────────────────────────────────────────────
  'app.getVersion': stub,
  'app.getPlatform': stub,
  'app.diagnostics': stub,
  // V3-W14-008 — manual electron-updater trigger.
  'app.checkForUpdates': stub,
  // V3-W15-005 — read the current plan tier (default 'ultra' on SigmaLink).
  'app.tier': APP_TIER_SCHEMA,
  // ── pty ──────────────────────────────────────────────────────────────
  'pty.create': stub,
  'pty.write': stub,
  'pty.resize': stub,
  'pty.kill': stub,
  'pty.subscribe': stub,
  'pty.list': stub,
  'pty.forget': stub,
  // ── panes ───────────────────────────────────────────────────────────────
  'panes.resume': stub,
  // ── providers ────────────────────────────────────────────────────────
  'providers.list': stub,
  'providers.probeAll': stub,
  'providers.probe': stub,
  // ── workspaces ───────────────────────────────────────────────────────
  'workspaces.pickFolder': stub,
  'workspaces.open': stub,
  'workspaces.list': stub,
  'workspaces.remove': stub,
  'workspaces.launch': stub,
  // ── git ──────────────────────────────────────────────────────────────
  'git.status': stub,
  'git.diff': stub,
  'git.runCommand': stub,
  'git.commitAndMerge': stub,
  'git.worktreeRemove': stub,
  // ── fs ───────────────────────────────────────────────────────────────
  'fs.exists': stub,
  // V3-W14-007 — Editor tab. Tightening to z.object lives with W13's
  // enforcement flip; for now `stub` keeps the soft-launch contract.
  'fs.readDir': stub,
  'fs.readFile': stub,
  'fs.writeFile': stub,
  // ── swarms ───────────────────────────────────────────────────────────
  'swarms.create': stub,
  'swarms.addAgent': stub,
  'swarms.list': stub,
  'swarms.get': stub,
  'swarms.sendMessage': stub,
  'swarms.broadcast': stub,
  'swarms.rollCall': stub,
  'swarms.tail': stub,
  'swarms.kill': stub,
  // ── browser ──────────────────────────────────────────────────────────
  'browser.openTab': stub,
  'browser.closeTab': stub,
  'browser.navigate': stub,
  'browser.back': stub,
  'browser.forward': stub,
  'browser.reload': stub,
  'browser.stop': stub,
  'browser.listTabs': stub,
  'browser.getActiveTab': stub,
  'browser.setActiveTab': stub,
  'browser.setBounds': stub,
  'browser.getState': stub,
  'browser.claimDriver': stub,
  'browser.releaseDriver': stub,
  'browser.getMcpUrl': stub,
  'browser.teardown': stub,
  // ── skills ───────────────────────────────────────────────────────────
  'skills.list': stub,
  'skills.ingestFolder': stub,
  'skills.ingestZip': stub,
  // Phase 4 Step 5 — marketplace install from a GitHub URL. Hardened
  // (not `stub`) because both ends are first-party and the result envelope
  // is the controller's stable contract.
  'skills.installFromUrl': {
    input: z.object({
      ownerRepo: z.string().min(1).max(280),
      ref: z.string().max(120).optional(),
      subPath: z.string().max(280).optional(),
      force: z.boolean().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      skill: z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          version: z.string().optional(),
          contentHash: z.string(),
          managedPath: z.string(),
          installedAt: z.number(),
          tags: z.array(z.string()).optional(),
        })
        .optional(),
      fanoutResults: z
        .array(
          z.object({
            provider: z.enum(['claude', 'codex', 'gemini']),
            enabled: z.boolean(),
            ok: z.boolean(),
            reason: z.string().optional(),
          }),
        )
        .optional(),
      error: z
        .object({
          code: z.enum([
            'invalid-url',
            'metadata-failed',
            'download-failed',
            'extract-failed',
            'no-skill-md',
            'invalid-skill',
            'ingest-failed',
            'update-required',
          ]),
          message: z.string(),
        })
        .optional(),
    }),
  },
  'skills.enableForProvider': stub,
  'skills.disableForProvider': stub,
  'skills.uninstall': stub,
  'skills.getReadme': stub,
  'skills.verifyForWorkspace': stub,
  // ── memory ───────────────────────────────────────────────────────────
  'memory.list_memories': stub,
  'memory.read_memory': stub,
  'memory.create_memory': stub,
  'memory.update_memory': stub,
  'memory.append_to_memory': stub,
  'memory.delete_memory': stub,
  'memory.search_memories': stub,
  'memory.find_backlinks': stub,
  'memory.list_orphans': stub,
  'memory.suggest_connections': stub,
  'memory.init_hub': stub,
  'memory.hub_status': stub,
  'memory.getGraph': stub,
  'memory.getMcpCommand': stub,
  // ── review ───────────────────────────────────────────────────────────
  'review.list': stub,
  'review.getDiff': stub,
  'review.getConflicts': stub,
  'review.runCommand': stub,
  'review.killCommand': stub,
  'review.setNotes': stub,
  'review.markPassed': stub,
  'review.markFailed': stub,
  'review.commitAndMerge': stub,
  'review.dropChanges': stub,
  'review.pruneOrphans': stub,
  'review.batchCommitAndMerge': stub,
  // ── kv ───────────────────────────────────────────────────────────────
  'kv.get': stub,
  'kv.set': stub,
  // ── tasks ────────────────────────────────────────────────────────────
  'tasks.list': stub,
  'tasks.get': stub,
  'tasks.create': stub,
  'tasks.update': stub,
  'tasks.remove': stub,
  'tasks.setStatus': stub,
  'tasks.assign': stub,
  'tasks.assignToSwarmAgent': stub,
  'tasks.listComments': stub,
  'tasks.addComment': stub,
  'tasks.removeComment': stub,
  // ── V3-W12-017 stubs ────────────────────────────────────────────────
  'assistant.send': stub,
  'assistant.list': stub,
  'assistant.cancel': stub,
  'assistant.dispatchPane': stub,
  'assistant.tools': stub,
  'assistant.invokeTool': stub,
  // P3-S7 — Bridge Assistant cross-session persistence + origin back-link.
  'assistant.conversations.list': stub,
  'assistant.conversations.get': stub,
  'assistant.conversations.delete': stub,
  'swarm.origin.get': stub,
  'design.captureElement': stub,
  'design.dispatch': stub,
  'design.history': stub,
  // V3-W14-001..006 — Bridge Canvas live channels.
  'design.startPick': stub,
  'design.stopPick': stub,
  'design.attachFile': stub,
  'design.listCanvases': stub,
  'design.createCanvas': stub,
  'design.openCanvas': stub,
  'design.setDevServerRoots': stub,
  'design.reloadTab': stub,
  // V3-W14-001..006 — Bridge Canvas teardown hook (main-process internal;
  // not allow-listed in rpc-channels.ts so the renderer cannot reach it).
  'design.shutdown': DESIGN_SHUTDOWN_SCHEMA,
  'swarm.console-tab': stub,
  'swarm.stop-all': stub,
  'swarm.constellation-layout': stub,
  'swarm.agent-filter': stub,
  'swarm.mission-rename': stub,
  'swarm.update-agent': stub,
  // P3-S6 — Persistent Swarm Replay. Soft-launch z.any(); tighten in v1.1
  // once the scrubber UI hardens its payload shapes.
  'swarm.replay.list': stub,
  'swarm.replay.scrub': stub,
  'swarm.replay.bookmark': stub,
  'swarm.replay.listBookmarks': stub,
  'swarm.replay.deleteBookmark': stub,
  'voice.start': stub,
  'voice.stop': stub,
  // V1.1 — SigmaVoice dispatcher channels. Hardened (not `stub`) because the
  // shapes are stable and the controller validates them at runtime anyway.
  'voice.dispatch': {
    input: z.object({ transcript: z.string() }),
    output: z.object({
      intent: z.string(),
      controller: z.string(),
      ok: z.boolean(),
      reason: z.string(),
    }),
  },
  'voice.setMode': {
    input: z.object({
      mode: z.enum(['auto', 'web-speech', 'native-mac', 'off']),
    }),
    output: z.object({
      mode: z.enum(['auto', 'web-speech', 'native-mac', 'off']),
    }),
  },
  // V1.1.1 — Settings → Voice diagnostics. Each field is independently
  // probed with try/catch so the controller never throws; `lastError`
  // carries the first non-null probe failure.
  'voice.diagnostics.run': {
    input: z.undefined().optional(),
    output: z.object({
      nativeLoaded: z.boolean(),
      permissionStatus: z.enum(['granted', 'denied', 'undetermined', 'unsupported']),
      dispatcherReachable: z.boolean(),
      mode: z.enum(['off', 'auto', 'on']),
      lastError: z.string().nullable(),
    }),
  },
  // V1.1.1 — Settings → Voice "Re-prompt microphone" CTA. Resolves with
  // `'unsupported'` on non-darwin or when the native module is missing,
  // so callers can render a steady-state row without special-casing.
  'voice.permissionRequest': {
    input: z.undefined().optional(),
    output: z.object({
      status: z.enum(['granted', 'denied', 'undetermined', 'unsupported']),
    }),
  },
  // ── Phase 4 Track C — Ruflo MCP embed ────────────────────────────────
  // Hardened (not `stub`) since both ends are first-party. The output
  // shapes for tool calls also accept the unavailable envelope so the
  // controller can emit `{ ok: false, code: 'ruflo-unavailable' }` without
  // tripping the soft-launch validator.
  'ruflo.health': {
    input: z.undefined().optional(),
    output: z.object({
      state: z.enum(['absent', 'starting', 'ready', 'degraded', 'down']),
      lastError: z.string().optional(),
      pid: z.number().int().optional(),
      uptimeMs: z.number().nonnegative().optional(),
      version: z.string().optional(),
      runtimePath: z.string().optional(),
    }),
  },
  'ruflo.embeddings.search': {
    input: z.object({
      query: z.string().min(1).max(2_000),
      topK: z.number().int().min(1).max(50).optional(),
      threshold: z.number().min(0).max(1).optional(),
      namespace: z.string().max(120).optional(),
    }),
    output: z.union([
      z.object({
        ok: z.literal(true),
        results: z.array(
          z.object({
            id: z.string(),
            score: z.number(),
            text: z.string(),
            namespace: z.string().optional(),
          }),
        ),
      }),
      z.object({
        ok: z.literal(false),
        code: z.literal('ruflo-unavailable'),
        reason: z.string(),
      }),
    ]),
  },
  'ruflo.embeddings.generate': {
    input: z.object({
      text: z.string().min(1).max(8_000),
      hyperbolic: z.boolean().optional(),
      normalize: z.boolean().optional(),
    }),
    output: z.union([
      z.object({
        ok: z.literal(true),
        embedding: z.array(z.number()),
        dimensions: z.number().int().nonnegative(),
      }),
      z.object({
        ok: z.literal(false),
        code: z.literal('ruflo-unavailable'),
        reason: z.string(),
      }),
    ]),
  },
  'ruflo.patterns.search': {
    input: z.object({
      query: z.string().min(1).max(2_000),
      topK: z.number().int().min(1).max(20).optional(),
      minConfidence: z.number().min(0).max(1).optional(),
    }),
    output: z.union([
      z.object({
        ok: z.literal(true),
        results: z.array(
          z.object({
            pattern: z.string(),
            type: z.string().optional(),
            confidence: z.number(),
            score: z.number(),
          }),
        ),
      }),
      z.object({
        ok: z.literal(false),
        code: z.literal('ruflo-unavailable'),
        reason: z.string(),
      }),
    ]),
  },
  'ruflo.patterns.store': {
    // CRITICAL — upstream `agentdb_pattern-store` accepts
    // `{ pattern, type, confidence }`. The original Phase 4 plan said
    // `{ namespace, key, value }`; that schema is wrong. Reference: the
    // ruflo-researcher pattern at `agentdb_pattern-search` namespace
    // `phase4-ruflo-research` key `claude-flow-embed-strategy-2026-05-10`.
    input: z.object({
      pattern: z.string().min(1).max(8_000),
      type: z.string().max(120).optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
    output: z.union([
      z.object({ ok: z.literal(true), id: z.string().optional() }),
      z.object({
        ok: z.literal(false),
        code: z.literal('ruflo-unavailable'),
        reason: z.string(),
      }),
    ]),
  },
  'ruflo.autopilot.predict': {
    input: z.object({}).strict().optional(),
    output: z.union([
      z.object({
        ok: z.literal(true),
        suggestion: z
          .object({
            title: z.string(),
            detail: z.string().optional(),
            commandId: z.string().optional(),
            args: z.unknown().optional(),
          })
          .nullable(),
      }),
      z.object({
        ok: z.literal(false),
        code: z.literal('ruflo-unavailable'),
        reason: z.string(),
      }),
    ]),
  },
  'ruflo.install.start': {
    input: z.object({}).strict().optional(),
    output: z.object({ jobId: z.string() }),
  },
  'ruflo.verifyForWorkspace': {
    input: z.string().min(1),
    output: z.object({
      claude: z.boolean(),
      codex: z.boolean(),
      gemini: z.boolean(),
      mode: z.enum(['fast', 'strict']),
      errors: z.array(
        z.object({
          cli: z.enum(['claude', 'codex', 'gemini']),
          message: z.string(),
        }),
      ),
    }),
  },
};

/** Look up the schema entry for a `<namespace>.<method>` channel id. */
export function getChannelSchema(channel: string): ChannelSchema | undefined {
  return CHANNEL_SCHEMAS[channel];
}

/** Returns true if every registered channel has a schema entry. */
export function hasSchemaCoverage(channels: Iterable<string>): {
  covered: string[];
  missing: string[];
} {
  const covered: string[] = [];
  const missing: string[] = [];
  for (const ch of channels) {
    if (ch in CHANNEL_SCHEMAS) covered.push(ch);
    else missing.push(ch);
  }
  return { covered, missing };
}
