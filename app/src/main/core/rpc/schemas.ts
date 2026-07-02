// V3-W12-017 / W13-XX — per-channel zod schema registry (soft-launch).
//
// Goal: every IPC channel listed in `app/src/shared/rpc-channels.ts` declares
// at minimum a placeholder zod schema here so future waves can tighten payload
// validation without a coordination round. The rpc-router warns (console.warn)
// when a registered controller method has no entry in this map. NOTE:
// enforcement is now LIVE — `VALIDATION_MODE = 'enforce'` (below) makes
// `validateChannelInput` REJECT on a failed parse, so every schema here is a
// hard runtime gate. Keep `input` permissive against the channel's real first
// arg (mirror `router-shape.ts`; no `.strict()` unless intentional) — an
// over-strict schema rejects valid IPC at runtime.
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
const GIT_STATUS_SUMMARY_OUTPUT = z
  .object({
    uncommitted: z.number().int().nonnegative(),
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

const SESSION_RISK_LEVEL = z.enum(['unknown', 'low', 'medium', 'high', 'critical']);
const SESSION_RISK_OUTPUT = z
  .object({
    providerId: z.string(),
    cwd: z.string(),
    externalSessionId: z.string().nullable(),
    sessionFilePath: z.string().nullable(),
    sessionBytes: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative(),
    ageMs: z.number().nonnegative().nullable(),
    estimatedTextBytes: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative().nullable(),
    riskLevel: SESSION_RISK_LEVEL,
    reasons: z.array(z.string()),
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
  // DEV-6 — no-arg app channels (quit, reveal, shell, userData, banner).
  // v1.2.4 — quitAndInstall: no renderer input (triggers auto-update install).
  'app.quitAndInstall': { input: z.undefined().optional(), output: any },
  // v1.4.2-06 — revealInFolder: first arg is an absolute path string.
  'app.revealInFolder': { input: PATH_STR, output: z.object({ ok: z.boolean() }) },
  // v1.4.2-06 — openShell: first arg is an absolute cwd string.
  'app.openShell': { input: PATH_STR, output: z.object({ ok: z.boolean() }) },
  // v1.4.2-06 — getUserDataPath: no input, returns the userData path string.
  'app.getUserDataPath': { input: z.undefined().optional(), output: any },
  // v1.4.2-06 — dismissedWorktreeBanner: no input, reads/writes a kv flag.
  'app.dismissedWorktreeBanner': { input: z.undefined().optional(), output: any },
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
  // DEV-6 — W-4 Phase 4 ephemeral scratch-shell channels.
  // spawnScratch(input: { cwd: string }) — first arg is the input object.
  'pty.spawnScratch': {
    input: z.object({ cwd: PATH_STR }),
    output: z.object({ scratchId: z.string() }),
  },
  // killScratch(input: { scratchId: string }) — first arg is the input object.
  'pty.killScratch': {
    input: z.object({ scratchId: z.string().min(1).max(512) }),
    output: z.undefined().optional(),
  },
  'pty.processStats': {
    input: z.string().min(1).max(512),
      output: z.object({
        supported: z.boolean(),
        rssBytes: z.number().nonnegative(),
        descendantPids: z.array(z.number().int()),
        processCount: z.number().int().nonnegative(),
        nodes: z.array(z.object({
          pid: z.number().int(),
          ppid: z.number().int(),
          rssBytes: z.number().nonnegative(),
          command: z.string(),
          args: z.string(),
        })),
        mcp: z.object({
          claudeFlowStdioCount: z.number().int().nonnegative(),
          claudeFlowStdioPids: z.array(z.number().int()),
          claudeFlowStdioRssBytes: z.number().nonnegative(),
          duplicateClaudeFlowStdio: z.boolean(),
          topClaudeFlowCommand: z.string().nullable(),
        }),
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
  // Phase 13 — deliberate pane close. Handler is `close(sessionId: string)`;
  // first (only) arg is the session id (mirrors the `pty.kill` arg schema).
  'panes.close': { input: z.string().min(1).max(512), output: any },
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
  // DEV-6 — panes channels missing schemas.
  // listForWorkspace(workspaceId: string) — returns one AgentSession row per slot.
  'panes.listForWorkspace': { input: z.string().min(1), output: any },
  // setDisplayProvider({ sessionId, displayProviderId }) — cosmetic label override.
  'panes.setDisplayProvider': {
    input: z.object({
      sessionId: z.string().min(1).max(200),
      displayProviderId: z.string().max(120).nullable(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  // BSP-O4 — rename({ sessionId, name }) — operator-supplied display name.
  // name: null clears the override (reverts to computed alias).
  'panes.rename': {
    input: z.object({
      sessionId: z.string().min(1).max(200),
      name: z.string().max(200).nullable(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  // Spec 2026-06-10 (B) — stageImage({ bytesBase64, ext }) — stage a
  // dropped/pasted image to a temp file. The base64 max bound is a PRE-DECODE
  // size gate (rejects oversized input before Buffer.from allocates ~40MB);
  // the helper's post-decode allowlist + 20MB byte cap remain as defense in depth.
  'panes.stageImage': {
    input: z.object({
      bytesBase64: z.string().min(1).max(28 * 1024 * 1024), // ~20MB image ≈ 27MB base64
      ext: z.string().max(32),
    }),
    output: z.object({ absPath: z.string() }),
  },
  // brief({ sessionId, worktreePath, capsule }) — inject a plan capsule into PTY.
  'panes.brief': {
    input: z.object({
      sessionId: z.string().min(1).max(200),
      worktreePath: z.string().max(4096).nullable(),
      capsule: z.object({
        goal: z.string().max(8192),
        targetFiles: z.array(z.string().max(4096)),
        successCriteria: z.array(z.string().max(2048)),
        outOfScope: z.array(z.string().max(2048)),
      }),
    }),
    output: any,
  },
  // ── RAM Brake ────────────────────────────────────────────────────────
  'ramBrake.sessionRisk': {
    input: z
      .object({
        providerId: z.string().min(1).max(120),
        cwd: PATH_STR,
        externalSessionId: z.string().min(1).max(200).nullable().optional(),
      })
      .passthrough(),
    output: SESSION_RISK_OUTPUT,
  },
  // ── providers ────────────────────────────────────────────────────────
  'providers.list': stub,
  'providers.probeAll': stub,
  'providers.probe': stub,
  // DEV-6 — v1.4.9-06 install-consent channels.
  // spawnInstall(providerId: string) — first arg is the provider id string.
  'providers.spawnInstall': {
    input: z.string().min(1).max(120),
    output: z.object({ paneId: z.string() }),
  },
  // setInstallConsent(providerId, decision) — validator sees first arg (providerId).
  'providers.setInstallConsent': { input: z.string().min(1).max(120), output: any },
  // getInstallConsent(providerId) — first arg is the provider id string.
  'providers.getInstallConsent': { input: z.string().min(1).max(120), output: any },
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
  // SigmaLink Dev (2026-06-11) — open/create the singleton dev workspace.
  // Zero-arg, same as pickFolder/list.
  'workspaces.openDev': stub,
  // H-8 — handler is `launch(plan: LaunchPlan)`. LaunchPlan is a deeply nested
  // shape (`panes: PaneAssignment[]`, optional resume plan); modelling it here
  // risks rejecting valid payloads, so it intentionally stays `stub`. See the
  // Lane-SB report for the rationale.
  'workspaces.launch': stub,
  // ── windows ───────────────────────────────────────────────────────────
  // Multi-window B2 — detach/redock take a single { workspaceId } bounded the
  // same way as OpenWorkspacesChangedEventSchema's ids.
  'windows.detachWorkspace': {
    input: z.object({ workspaceId: z.string().min(1).max(200) }),
    output: z.object({ windowId: z.number() }),
  },
  'windows.redockWorkspace': {
    input: z.object({ workspaceId: z.string().min(1).max(200) }),
    output: any,
  },
  // ── git ──────────────────────────────────────────────────────────────
  // H-8 — `status(cwd)` / `diff(cwd)`: first (and only) arg is a bounded cwd.
  'git.status': { input: PATH_STR, output: GIT_STATUS_OUTPUT },
  'git.statusSummary': { input: PATH_STR, output: GIT_STATUS_SUMMARY_OUTPUT },
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
  'fs.createFile': { input: z.object({ path: PATH_STR }), output: any },
  'fs.mkdir': { input: z.object({ path: PATH_STR }), output: any },
  'fs.rename': { input: z.object({ from: PATH_STR, to: PATH_STR }), output: any },
  'fs.trash': { input: z.object({ path: PATH_STR }), output: any },
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
  // Spec 2026-06-10 (D) — + Pane auto-resume escape hatch. Mirrors swarms.kill
  // (both take a bare id string).
  'swarms.resume': stub,
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
  // DEV-6 — fs channels missing schemas.
  // getWorktreeSizes() — no input; lists worktree disk usage.
  'fs.getWorktreeSizes': { input: z.undefined().optional(), output: any },
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
  // DEV-6 — browser channels missing schemas (DEV-2/BSP-B4/BSP-B2).
  // listRecents({ workspaceId, limit? }) — recently-closed tab entries.
  'browser.listRecents': {
    input: z.object({
      workspaceId: z.string().min(1).max(200),
      limit: z.number().int().positive().max(200).optional(),
    }),
    output: any,
  },
  // focusView({ workspaceId }) — forward pointer focus to the active tab.
  'browser.focusView': {
    input: z.object({ workspaceId: z.string().min(1).max(200) }),
    output: any,
  },
  // detachToWindow({ workspaceId }) — detach active tab to a second window.
  'browser.detachToWindow': {
    input: z.object({ workspaceId: z.string().min(1).max(200) }),
    output: any,
  },
  // reattach({ workspaceId }) — move detached view back to the main window.
  'browser.reattach': {
    input: z.object({ workspaceId: z.string().min(1).max(200) }),
    output: any,
  },
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
  // DEV-6 — SMK-3 / v1.7.1 W-5 skills channels missing schemas.
  // listInstalled() — discover skills from all providers (no input).
  'skills.listInstalled': { input: z.undefined().optional(), output: any },
  // attach({ workspaceId, paneSessionId?, skillName, skillSource }) — INFORMATIONAL binding.
  'skills.attach': {
    input: z.object({
      workspaceId: z.string().min(1).max(200),
      paneSessionId: z.string().min(1).max(200).nullable().optional(),
      skillName: z.string().min(1).max(512),
      skillSource: z.string().min(1).max(512),
    }),
    output: any,
  },
  // detach({ bindingId }) — remove a skill binding by id.
  'skills.detach': {
    input: z.object({ bindingId: z.string().min(1).max(200) }),
    output: any,
  },
  // listBindings({ workspaceId }) — all bindings for a workspace.
  'skills.listBindings': {
    input: z.object({ workspaceId: z.string().min(1).max(200) }),
    output: any,
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
  // DEV-6 — P4.2 MEM-7 / MEM-3 / DB-2 memory channels missing schemas.
  // find_unlinked_mentions({ workspaceId, name }) — notes mentioning this name as plain text.
  'memory.find_unlinked_mentions': {
    input: z.object({
      workspaceId: z.string().min(1).max(200),
      name: z.string().min(1).max(512),
    }),
    output: any,
  },
  'memory.list_orphans': stub,
  'memory.suggest_connections': stub,
  'memory.init_hub': stub,
  'memory.hub_status': stub,
  'memory.getGraph': stub,
  'memory.getMcpCommand': stub,
  // DEV-6 — P4 MEM-3 tag channels and DB-2 import/export channels.
  // list_tags({ workspaceId }) — distinct tags + note counts.
  'memory.list_tags': {
    input: z.object({ workspaceId: z.string().min(1).max(200) }),
    output: any,
  },
  // list_by_tag({ workspaceId, tag }) — notes carrying a tag.
  'memory.list_by_tag': {
    input: z.object({
      workspaceId: z.string().min(1).max(200),
      tag: z.string().min(1).max(512),
    }),
    output: any,
  },
  // export_db() — no input; main shows save dialog and writes a DB snapshot.
  'memory.export_db': { input: z.undefined().optional(), output: any },
  // import_db() — no input; main shows open dialog and replaces the live DB.
  'memory.import_db': { input: z.undefined().optional(), output: any },
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
  // DEV-6 — V3-W13-013 assistant channels missing schemas.
  // dispatchBulk(items: Array<{...}>) — first arg is the items array.
  // Kept permissive to match the controller's self-clamping contract: it clamps
  // count to 1–8 (`Math.max(1, Math.min(8, …))`) and returns per-item error rows
  // for malformed entries rather than throwing. Enforcement is LIVE, so an
  // over-strict bound here would hard-reject inputs the controller absorbs.
  'assistant.dispatchBulk': {
    input: z.array(
      z.object({
        workspaceId: z.string().min(1).max(200),
        provider: z.string().min(1).max(120),
        count: z.number().optional(),
        initialPrompt: z.string().max(8000).optional(),
        conversationId: z.string().max(200).optional(),
      }),
    ).max(200),
    output: any,
  },
  // refResolve({ workspaceId, atRef }) — resolve an @filename ref.
  'assistant.refResolve': {
    input: z.object({
      workspaceId: z.string().min(1).max(200),
      atRef: z.string().min(1).max(512),
    }),
    output: any,
  },
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
  // DEV-6 — v1.6.1 B2 / P4 MEM-1 ruflo channels missing schemas.
  // entries.list({ query?, limit? }) — sweep Ruflo AgentDB entries as graph nodes.
  'ruflo.entries.list': {
    input: z.object({
      query: z.string().max(2000).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }).optional(),
    output: any,
  },
  // entries.neighbors({ id, text, topK? }) — semantic neighbors of one entry.
  'ruflo.entries.neighbors': {
    input: z.object({
      id: z.string().min(1).max(512),
      text: z.string().min(1).max(8000),
      topK: z.number().int().min(1).max(50).optional(),
    }),
    output: any,
  },
  // daemonStatus(workspaceId?) — list per-workspace HTTP daemon handles.
  // First arg is an optional workspaceId string; when omitted lists all daemons.
  'ruflo.daemonStatus': { input: z.string().min(1).max(200).optional(), output: any },
  // restartDaemon(workspaceId) — stop + re-spawn one workspace's HTTP daemon.
  'ruflo.restartDaemon': {
    input: z.string().min(1).max(200),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  // ── sync (v1.5.0 packet 09) ───────────────────────────────────────────────
  // DEV-6 — all sync.* channels were missing schemas.
  // enable(config: SyncConfig) — first arg is the config object.
  'sync.enable': {
    input: z.object({
      remoteUrl: z.string().min(1).max(2048),
      username: z.string().max(512).optional(),
      password: z.string().max(512).optional(),
    }),
    output: any,
  },
  // disable() — no input; disables sync on this device.
  'sync.disable': { input: z.undefined().optional(), output: any },
  // status() — no input; reads current sync status.
  'sync.status': { input: z.undefined().optional(), output: any },
  // listConflicts() — no input; lists unresolved LWW conflicts.
  'sync.listConflicts': { input: z.undefined().optional(), output: any },
  // resolveConflict({ conflictId, resolution }) — resolve a conflict.
  'sync.resolveConflict': {
    input: z.object({
      conflictId: z.string().min(1).max(200),
      resolution: z.enum(['keep_local', 'keep_remote']),
    }),
    output: any,
  },
  // exportMnemonic() — no input; returns one-shot mnemonic for current device key.
  'sync.exportMnemonic': { input: z.undefined().optional(), output: any },
  // isConfigured() — no input; checks whether sync is configured.
  'sync.isConfigured': { input: z.undefined().optional(), output: any },
  // recoverFromMnemonic(mnemonic) — first arg is the mnemonic string.
  'sync.recoverFromMnemonic': { input: z.string().min(1).max(2048), output: any },
  // ── telegram (R-1) ────────────────────────────────────────────────────────
  // DEV-6 — all telegram.* channels were missing schemas. SECURITY-CRITICAL:
  // token is write-only; getStatus never includes the token value.
  // getStatus() — no input; returns operator-safe status snapshot.
  'telegram.getStatus': { input: z.undefined().optional(), output: any },
  // setToken(token) — first arg is the bot token string (write-only, persisted encrypted).
  'telegram.setToken': { input: z.string().min(1).max(512), output: any },
  // clearToken() — no input; removes the stored token and stops the bridge.
  'telegram.clearToken': { input: z.undefined().optional(), output: any },
  // setEnabled(enabled) — first arg is a boolean.
  'telegram.setEnabled': { input: z.boolean(), output: any },
  // setAllowlist(ids) — first arg is an array of numeric chat ids.
  'telegram.setAllowlist': {
    input: z.array(z.number().int()).max(1000),
    output: any,
  },
  // setIdleLockMinutes(minutes) — first arg is a number (<=0 disables).
  'telegram.setIdleLockMinutes': { input: z.number(), output: any },
  // lock() — no input; manually locks the remote.
  'telegram.lock': { input: z.undefined().optional(), output: any },
  // unlock() — no input; manually unlocks the remote.
  'telegram.unlock': { input: z.undefined().optional(), output: any },
  // auditTail(n) — first arg is a number (tail n most-recent entries).
  'telegram.auditTail': { input: z.number().int().min(1).max(500), output: any },
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
