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

// H-8 — bounded primitives reused by the security-relevant, command-carrying
// channels tightened below. `path`/`cwd` strings are capped at the common
// filesystem PATH_MAX ceiling so a malformed renderer payload can't smuggle an
// unbounded string into a controller. The validator only ever sees the FIRST
// positional IPC arg (see `core/rpc/validate.ts` + the schema convention at the
// top of this file), so channels whose first arg is a plain string are matched
// with a string schema, and object-first-arg channels with an object schema.
const PATH_STR = z.string().min(1).max(4096);

// ARCH-9 — concrete OUTPUT shapes for the highest-traffic / largest-payload
// channels (mirroring the router-shape return types). These are drift-DETECTION
// only: `validateChannelOutput` fail-opens (logs once, returns the original) —
// the main process is the trusted producer, so a shape mismatch is a controller
// bug to surface in dev, never a reason to reject a working response. `.passthrough()`
// tolerates extra fields so a benign additive change doesn't warn.
const GIT_STATUS_OUTPUT = z
  .object({
    branch: z.string(),
    ahead: z.number(),
    behind: z.number(),
    staged: z.array(z.string()),
    unstaged: z.array(z.string()),
    untracked: z.array(z.string()),
    clean: z.boolean(),
  })
  .passthrough()
  .nullable();
const GIT_DIFF_OUTPUT = z
  .object({
    stat: z.string(),
    patches: z.string(),
    untrackedFiles: z.array(z.string()),
    truncated: z.boolean(),
  })
  .passthrough()
  .nullable();
const SHELL_RESULT_OUTPUT = z
  .object({ stdout: z.string(), stderr: z.string(), code: z.number() })
  .passthrough();
const SESSION_CHECKPOINT_OUTPUT = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    sha: z.string(),
    label: z.string().nullable(),
    kind: z.enum(['auto', 'manual']),
    createdAt: z.number(),
  })
  .passthrough();
const FS_READDIR_OUTPUT = z
  .object({
    entries: z.array(
      z
        .object({
          name: z.string(),
          type: z.enum(['file', 'dir']),
          size: z.number().optional(),
          modifiedAt: z.number().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const FS_READFILE_OUTPUT = z
  .object({
    content: z.string(),
    encoding: z.enum(['utf8', 'binary']),
    truncated: z.boolean(),
  })
  .passthrough();
const USAGE_SUMMARY_OUTPUT = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheCreationTokens: z.number(),
    cacheReadTokens: z.number(),
    totalCostUsd: z.number().nullable(),
    turnCount: z.number(),
  })
  .passthrough();

/**
 * Validation mode for the rpc-router.
 *
 * H-8 — flipped to `'enforce'`. In enforce mode the router `.parse()`s the
 * first positional IPC arg against the channel's `input` schema and surfaces a
 * `ZodError` as an RPC error when it fails. Channels still carrying `z.any()`
 * inputs (the soft-launch `stub`) pass anything through unchanged, so only the
 * concretely-hardened, security-relevant channels gain rejection; the unhardened
 * surface is unaffected. Unknown channels (no schema entry) also pass through —
 * coverage is a separate concern (see `hasSchemaCoverage`).
 */
export const VALIDATION_MODE: 'warn' | 'enforce' = 'enforce';

// V3-W15-005 — Plan tier enum. Mirrors `Tier` in core/plan/capabilities.ts.
// Hardened (not `stub`) because the controller has a single, well-known shape
// and `app.tier` is read from the renderer on every Settings → Appearance
// mount; tightening here is free.
const TIER_ENUM = z.enum(['basic', 'pro', 'ultra']);
const APP_TIER_SCHEMA: ChannelSchema = {
  input: z.undefined().optional(),
  output: TIER_ENUM,
};

// V3-W14-001..006 — Sigma Canvas teardown hook. The design controller exposes
// a `shutdown()` method that `rpc-router.shutdownRouter` calls to tear down
// picker overlays + dev-server watchers. The preload bridge does NOT allow-
// list `design.shutdown`, so the renderer can never invoke it; the schema
// entry exists purely to silence the soft-launch missing-schema warning.
const DESIGN_SHUTDOWN_SCHEMA: ChannelSchema = {
  input: z.undefined().optional(),
  output: z.void(),
};

// BUG-4 — shared input schema for the destructive `cleanup.*` operator
// side-band channels. Shape-checked-but-permissive: `workspaceId` MUST be a
// non-empty bounded string (a wrong-typed value is rejected at the IPC
// boundary), `dryRun` is an optional boolean (the handler's `dryRun !== false`
// safe-default is preserved), and `.passthrough()` tolerates any future extra
// fields the renderer may add without a coordination round. This is NOT the
// `z.any()` stub — it concretely rejects malformed payloads.
const CLEANUP_INPUT_SCHEMA: ChannelSchema = {
  input: z
    .object({
      workspaceId: z.string().min(1).max(200),
      dryRun: z.boolean().optional(),
      stopLiveSessions: z.boolean().optional(),
    })
    .passthrough(),
  output: any,
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
  // H-8 — handler is `create(input: { providerId, cwd, cols, rows, args?, env?,
  // initialPrompt? })`; first arg is the object. `env` is an opaque string map
  // passed straight to the spawn, left permissive.
  'pty.create': {
    input: z.object({
      providerId: z.string().min(1).max(120),
      cwd: PATH_STR,
      cols: z.number().int().positive().max(10_000),
      rows: z.number().int().positive().max(10_000),
      args: z.array(z.string().max(8_192)).max(256).optional(),
      env: z.record(z.string(), z.string()).optional(),
      initialPrompt: z.string().max(64 * 1024).optional(),
    }),
    output: any,
  },
  // H-8 — handler is `write(sessionId, data)`. Validator sees only the first
  // positional arg, so we bound `sessionId`; `data` is 2nd positional and out
  // of reach (it's an opaque keystroke stream by design).
  'pty.write': { input: z.string().min(1).max(512), output: any },
  // H-8 — handler is `resize(sessionId, cols, rows)`; first arg is sessionId.
  'pty.resize': { input: z.string().min(1).max(512), output: any },
  // H-8 — handler is `kill(sessionId: string)`; first arg is sessionId.
  'pty.kill': { input: z.string().min(1).max(512), output: any },
  'pty.snapshot': {
    input: z.string().min(1),
    output: z.object({ buffer: z.string() }),
  },
  'pty.subscribe': stub,
  'pty.processStats': {
    input: z.string().min(1).max(512),
    output: z.object({
      supported: z.boolean(),
      rssBytes: z.number().nonnegative(),
      descendantPids: z.array(z.number().int()),
      processCount: z.number().int().nonnegative(),
    }),
  },
  'pty.list': stub,
  'pty.forget': stub,
  // ── panes ───────────────────────────────────────────────────────────────
  // V3-W12-017 — controller wraps `resumeWorkspacePanes` (see
  // `src/main/core/pty/resume-launcher.ts`). Output mirrors `PaneResumeResult`.
  'panes.resume': {
    input: z.string().min(1), // workspaceId
    output: z.object({
      workspaceId: z.string(),
      resumed: z.array(
        z.object({
          sessionId: z.string(),
          providerId: z.string(),
          providerEffective: z.string(),
          externalSessionId: z.string(),
          pid: z.number().int(),
        }),
      ),
      failed: z.array(
        z.object({
          sessionId: z.string(),
          providerId: z.string(),
          externalSessionId: z.string(),
          error: z.string(),
        }),
      ),
      skipped: z.array(
        z.object({
          sessionId: z.string(),
          providerId: z.string(),
          reason: z.string(),
        }),
      ),
    }),
  },
  // v1.2.8 — Recovery action behind the aggregated resume-failure toast.
  // Wraps `respawnFailedWorkspacePanes`; same input shape as `panes.resume`
  // (the renderer already has `workspaceId` in scope), and the output is a
  // simple count envelope so the follow-up toast can confirm success.
  'panes.respawnFailed': {
    input: z.string().min(1), // workspaceId
    output: z.object({
      workspaceId: z.string(),
      spawned: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  },
  // P6 FEAT-1 — on-demand subset relaunch. Handler is
  // `resumeSelected(workspaceId, sessionIds)`. The validator only sees the
  // FIRST positional arg, so we bound `workspaceId` here (matching the
  // `panes.resume` workspaceId schema); `sessionIds` is the 2nd positional and
  // out of reach of the single-arg validator — the controller filters it to
  // non-empty string ids before passing it to the resume launcher. Output
  // mirrors `PaneResumeResult` (same shape as `panes.resume`).
  'panes.resumeSelected': {
    input: z.string().min(1), // workspaceId
    output: z.object({
      workspaceId: z.string(),
      resumed: z.array(
        z.object({
          sessionId: z.string(),
          providerId: z.string(),
          providerEffective: z.string(),
          externalSessionId: z.string(),
          pid: z.number().int(),
        }),
      ),
      failed: z.array(
        z.object({
          sessionId: z.string(),
          providerId: z.string(),
          externalSessionId: z.string(),
          error: z.string(),
        }),
      ),
      skipped: z.array(
        z.object({
          sessionId: z.string(),
          providerId: z.string(),
          reason: z.string(),
        }),
      ),
    }),
  },
  // v1.3.0 — Session picker: list provider sessions for a cwd.
  'panes.listSessions': {
    input: z.object({
      providerId: z.string().min(1),
      cwd: z.string().min(1),
      // B2 — workspace scoping for codex/kimi/gemini lists (Option-B
      // whitelist). Without it those providers leak sessions from OTHER
      // projects into the picker. Zod strips unknown keys, so it MUST be
      // declared here or the handler never sees it.
      workspaceId: z.string().min(1).optional(),
      opts: z
        .object({
          maxCount: z.number().int().positive().max(200).optional(),
          sinceMs: z.number().int().positive().optional(),
          workspaceId: z.string().min(1).optional(),
        })
        .optional(),
    }),
    output: z.array(
      z.object({
        id: z.string().min(1),
        providerId: z.string(),
        cwd: z.string(),
        createdAt: z.number(),
        updatedAt: z.number(),
        title: z.string().max(80).optional(),
        firstMessagePreview: z.string().max(80).optional(),
      }),
    ),
  },
  // v1.3.0 — Session picker: most recent resume plan for a workspace.
  'panes.lastResumePlan': {
    input: z.string().min(1), // workspaceId
    output: z.array(
      z.object({
        paneIndex: z.number().int().nonnegative(),
        providerId: z.string(),
        sessionId: z.string().nullable(),
      }),
    ),
  },
  // ── providers ────────────────────────────────────────────────────────
  'providers.list': stub,
  'providers.probeAll': stub,
  'providers.probe': stub,
  // ── workspaces ───────────────────────────────────────────────────────
  'workspaces.pickFolder': stub,
  // H-8 — handler is `open(root: string)`; first arg is the absolute repo path.
  'workspaces.open': { input: PATH_STR, output: any },
  'workspaces.list': stub,
  // DEV-W2 — inline rename: { id, name } both bounded.
  'workspaces.rename': {
    input: z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(120) }),
    output: any,
  },
  // H-8 — handler is `remove(id: string)`; first arg is the workspace id
  // (matches the 200-char bound used by OpenWorkspacesChangedEventSchema).
  'workspaces.remove': { input: z.string().min(1).max(200), output: any },
  // DEV-W3a — force-open a DISTINCT workspace on a dir (never reuses existing).
  // Input shape mirrors workspaces.open (a bare path string).
  'workspaces.openNew': { input: PATH_STR, output: any },
  // H-8 — handler is `launch(plan: LaunchPlan)`. LaunchPlan is a deeply nested
  // shape (`panes: PaneAssignment[]`, optional resume plan); modelling it here
  // risks rejecting valid payloads, so it intentionally stays `stub`. See the
  // Lane-SB report for the rationale.
  'workspaces.launch': stub,
  // ── git ──────────────────────────────────────────────────────────────
  // H-8 — `status(cwd)` / `diff(cwd)`: first (and only) arg is a bounded cwd.
  'git.status': { input: PATH_STR, output: GIT_STATUS_OUTPUT },
  'git.diff': { input: PATH_STR, output: GIT_DIFF_OUTPUT },
  // H-8 — handler is `runCommand(cwd, line, timeoutMs?)`. The validator only
  // sees the FIRST positional arg, so we bound `cwd` here; `line` + `timeoutMs`
  // are 2nd/3rd positional and out of reach of a single-arg validator (the
  // shell command itself is sandboxed by git-ops `runShellLine`).
  'git.runCommand': { input: PATH_STR, output: SHELL_RESULT_OUTPUT },
  // H-8 — handler is `commitAndMerge(input: { worktreePath, branch, repoRoot,
  // message })`; first arg is the object. Bound every string field.
  'git.commitAndMerge': {
    input: z.object({
      worktreePath: PATH_STR,
      branch: z.string().min(1).max(512),
      repoRoot: PATH_STR,
      message: z.string().max(16_384),
    }),
    output: SHELL_RESULT_OUTPUT,
  },
  // H-8 — handler is `worktreeRemove(worktreePath: string)`; first arg is the path.
  'git.worktreeRemove': { input: PATH_STR, output: any },
  // BSP-G1 — create a new worktree from a repo root with an optional branch hint and base ref.
  'git.worktreeCreate': {
    input: z.object({
      repoRoot: PATH_STR,
      hint: z.string().min(1).max(256).optional(),
      base: z.string().min(1).max(512).optional(),
    }),
    output: any,
  },
  // BSP-G3 — CWD-swap an IDLE pane to an existing worktree.
  'git.openInPane': {
    input: z.object({
      sessionId: z.string().min(1).max(200),
      worktreePath: PATH_STR,
    }),
    output: any,
  },
  // P6 FEAT-11 — agent undo/rewind. The renderer passes a sessionId (NOT a
  // path); the controller resolves the worktree server-side. `sha` is a git
  // object id — bound to a generous max so a malformed payload can't smuggle an
  // unbounded string into git. The controller additionally validates that the
  // sha is one of THIS session's checkpoints AND an ancestor of HEAD.
  'git.createCheckpoint': {
    input: z.object({
      sessionId: z.string().min(1).max(200),
      label: z.string().max(512).optional(),
    }),
    output: SESSION_CHECKPOINT_OUTPUT,
  },
  // handler is `listCheckpoints(sessionId: string)`; first arg is the id.
  'git.listCheckpoints': { input: z.string().min(1).max(200), output: z.array(SESSION_CHECKPOINT_OUTPUT) },
  'git.restoreCheckpoint': {
    input: z.object({
      sessionId: z.string().min(1).max(200),
      sha: z.string().regex(/^[0-9a-f]{7,64}$/), // review NIT-3 — git oid only
    }),
    output: any,
  },
  // P6 FEAT-8 — git-activity heatmap. args[0] is the worktree path; the real
  // guard is assertAllowedPath in the rpc-router handler (the positional `days`
  // arg is clamped in git-ops.ts and is not args[0], so not validated here).
  'git.activityLog': { input: PATH_STR, output: any },
  // BSP-G2 — Git panel: staged diff, unstaged diff, log, branch list, branch switch.
  'git.diffStaged': { input: PATH_STR, output: GIT_DIFF_OUTPUT },
  'git.diffUnstaged': { input: PATH_STR, output: GIT_DIFF_OUTPUT },
  'git.log': { input: PATH_STR, output: any },
  'git.listBranches': { input: PATH_STR, output: any },
  'git.switchBranch': {
    input: z.object({
      cwd: PATH_STR,
      branch: z.string().min(1).max(512),
    }),
    output: any,
  },
  // ── usage (P6 FEAT-3) ──────────────────────────────────────────────────
  'usage.sessionSummary': {
    input: z.object({ sessionId: z.string().min(1).max(200) }),
    output: USAGE_SUMMARY_OUTPUT,
  },
  'usage.weekSummary': {
    input: z.object({ workspaceId: z.string().min(1).max(200) }),
    output: any,
  },
  // ── mcp diagnostics (P6 FEAT-5) ────────────────────────────────────────
  'mcp.diagnoseWorkspace': {
    input: z.object({
      workspaceId: z.string().min(1).max(200),
      runtimeProfileId: z
        .enum(['ruflo-core', 'browser-tools', 'security-tools', 'full-tools'])
        .optional(),
    }),
    output: any,
  },
  // ── fs ───────────────────────────────────────────────────────────────
  // H-8 — handler is `exists(p: string)`; first arg is the bare path string
  // (NOT an object — verified against the fsCtl.exists signature).
  'fs.exists': { input: PATH_STR, output: any },
  // V3-W14-007 — Editor tab. H-8 tightens these to the real `{ path, ... }`
  // object shapes (fsReadDir / fsReadFile / fsWriteFile in core/fs/controller.ts).
  'fs.readDir': { input: z.object({ path: PATH_STR }), output: FS_READDIR_OUTPUT },
  'fs.readFile': {
    input: z.object({
      path: PATH_STR,
      maxBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
    }),
    output: FS_READFILE_OUTPUT,
  },
  'fs.writeFile': {
    input: z.object({
      path: PATH_STR,
      content: z.string().max(16 * 1024 * 1024),
      // H-2/H-5 — repoRoot is deprecated for the security decision (the
      // authoritative allowed-roots provider replaced it); kept optional for
      // back-compat with the current renderer, which still sends it.
      repoRoot: PATH_STR.optional(),
    }),
    output: any,
  },
  // ── swarms ───────────────────────────────────────────────────────────
  'swarms.create': stub,
  // V3-W12-017 — controller wraps `addAgentToSwarm` (factory.ts).
  // `AgentSession` + `Swarm` are large, nested shapes; defer their deep-tighten
  // to a future wave and use `z.any()` for those two fields only.
  'swarms.addAgent': {
    input: z.object({
      swarmId: z.string().min(1),
      providerId: z.string().min(1),
      role: z.enum(['coordinator', 'builder', 'scout', 'reviewer']).optional(),
      runtimeProfileId: z
        .enum(['ruflo-core', 'browser-tools', 'security-tools', 'full-tools'])
        .optional(),
      forceRamBrake: z.boolean().optional(),
      initialPrompt: z.string().max(8_000).optional(),
      // SF-8 — Yolo/Bypass: when true, the spawn appends the provider's
      // autoApproveFlag (no-op for providers without one).
      autoApprove: z.boolean().optional(),
      // DEV-W5 — per-spawn worktree override. When true → in-place (no worktree);
      // when false → force worktree; when absent → use workspace worktreeMode.
      skipWorktree: z.boolean().optional(),
    }),
    output: z.object({
      sessionId: z.string(),
      paneIndex: z.number().int().nonnegative(),
      agentKey: z.string(),
      session: z.any(),
      swarm: z.any(),
    }),
  },
  'swarms.list': stub,
  'swarms.get': stub,
  'swarms.sendMessage': stub,
  'swarms.broadcast': stub,
  'swarms.rollCall': stub,
  'swarms.tail': stub,
  'swarms.kill': stub,
  // v1.4.3 #06 — Pane Split + Minimise. Tighten the input shape so the
  // renderer can't accidentally send a bogus direction.
  'swarms.splitPane': {
    input: z.object({
      paneId: z.string().min(1),
      direction: z.enum(['horizontal', 'vertical']),
      provider: z.string().min(1),
    }),
    // AgentSession is a large shape; defer the deep-tighten in line with
    // `swarms.addAgent`.
    output: z.any(),
  },
  'swarms.minimisePane': {
    input: z.object({
      paneId: z.string().min(1),
      minimised: z.boolean(),
    }),
    output: z.void(),
  },
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
  // V3-W12-017 — controller wraps `manager.verifyFanoutForWorkspace`.
  // Output mirrors `SkillFanoutVerification` (manager.ts).
  'skills.verifyForWorkspace': {
    input: z.string().min(1), // workspaceId
    output: z.object({
      workspaceId: z.string(),
      verified: z.number().int().nonnegative(),
      refanned: z.number().int().nonnegative(),
      errors: z.array(
        z.object({
          skillId: z.string(),
          skillName: z.string(),
          providerId: z.enum(['claude', 'codex', 'gemini']),
          targetPath: z.string(),
          message: z.string(),
        }),
      ),
    }),
  },
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
  // H-8 — handler is `get(key: string)`; first arg is the kv key.
  'kv.get': { input: z.string().min(1).max(512), output: any },
  // H-8 — handler is `set(key, value)`. Validator sees only the first
  // positional arg, so we bound `key`; `value` is 2nd positional and out of
  // reach (the controller already coerces it to a string).
  'kv.set': { input: z.string().min(1).max(512), output: any },
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
  // ── notifications (v1.4.9 #07) ────────────────────────────────────────
  'notifications.list': stub,
  'notifications.unreadCount': stub,
  'notifications.markRead': stub,
  'notifications.markAllRead': stub,
  'notifications.markUnread': stub,
  'notifications.dismiss': stub,
  'notifications.clearRead': stub,
  // ── V3-W12-017 stubs ────────────────────────────────────────────────
  'assistant.send': stub,
  'assistant.list': stub,
  'assistant.cancel': stub,
  'assistant.dispatchPane': stub,
  'assistant.tools': stub,
  'assistant.invokeTool': stub,
  // P3-S7 — Sigma Assistant cross-session persistence + origin back-link.
  'assistant.conversations.list': stub,
  'assistant.conversations.get': stub,
  'assistant.conversations.delete': stub,
  'swarm.origin.get': stub,
  'design.captureElement': stub,
  'design.dispatch': stub,
  'design.history': stub,
  // V3-W14-001..006 — Sigma Canvas live channels.
  'design.startPick': stub,
  'design.stopPick': stub,
  'design.attachFile': stub,
  'design.listCanvases': stub,
  'design.createCanvas': stub,
  'design.openCanvas': stub,
  'design.setDevServerRoots': stub,
  'design.reloadTab': stub,
  // V3-W14-001..006 — Sigma Canvas teardown hook (main-process internal;
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
  // ── sigmabench (C-12) ──────────────────────────────────────────────────
  // Side-band registered in rpc-router.ts under `sigmabench.<method>`.
  'sigmabench.run': stub,
  'sigmabench.listRuns': stub,
  'sigmabench.getRun': stub,
  // ── cleanup (SF-13) ────────────────────────────────────────────────────
  // BUG-4 — DESTRUCTIVE operator-cleanup side-band (`cleanup.*`) registered in
  // rpc-router.ts. These three were the only side-band channels with NO schema
  // entry, so a malformed renderer payload reached the handler unchecked.
  // Each handler reads `{ workspaceId: string; dryRun?: boolean }` from the
  // first IPC arg. We shape-check those two fields but `.passthrough()` any
  // extra keys (permissive — NOT the `z.any()` stub) so a wrong-typed
  // `workspaceId` is rejected at the boundary, before the cleanup core runs.
  // The handler's `dryRun !== false` safe-default behaviour is unchanged; we
  // only ADD input validation and never alter the response/envelope shape.
  'cleanup.removeWorkspace': CLEANUP_INPUT_SCHEMA,
  'cleanup.clearPanes': CLEANUP_INPUT_SCHEMA,
  'cleanup.pruneWorktrees': CLEANUP_INPUT_SCHEMA,
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
