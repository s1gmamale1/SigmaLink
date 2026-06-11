// v1.5.3-B — CHANNELS vs registered-handler cross-reference sanity check.
// v1.5.4-B — Extended to also enumerate direct ipcMain.handle calls in
//            electron/main.ts (Source C) so they can't slip in un-allowlisted.
//
// Background: v1.5.0 packet 09 shipped 8 `sync.*` controller methods but
// forgot to add them to CHANNELS. The preload bridge hard-rejected all
// `rpc.sync.*` calls for ~14hr until v1.5.2 hotfix. The comment at
// rpc-channels.ts:2-3 claims a test double-checks this, but that test did
// not exist. This file IS that test.
//
// Strategy:
//   1. Forward check — every channel registered by rpc-router.ts must appear
//      in CHANNELS. Drift here means the renderer can never invoke the handler
//      through the bridge.
//   2. Inverse check — every channel in CHANNELS must have a corresponding
//      registered handler. Drift here means the allowlist is stale (dead
//      entries that waste security-review budget).
//   3. Direct-in-main check (v1.5.4-B) — every channel registered via a
//      direct ipcMain.handle call in electron/main.ts must appear in CHANNELS.
//      This closes the gap identified by the v1.5.3 reviewer: the 7
//      voice.globalCapture.* handlers were invisible to checks 1 and 2 and
//      required manual suppression via CHANNELS_REQUIRING_LEAD_REVIEW. Now
//      they are enumerated in DIRECT_IPC_HANDLE_CHANNELS and tested directly.
//
// rpc-router.ts registers channels from THREE sources (after v1.5.4-B):
//   A. The typed router returned by defineRouter() — namespace.method pairs
//      derived from the controller objects (app, pty, panes, providers,
//      workspaces, git, fs, swarms, browser, skills, memory, review, tasks,
//      kv, assistant, design, voice, ruflo, notifications, sync).
//   B. Side-band registrations outside defineRouter():
//        swarm.{console-tab, stop-all, constellation-layout, agent-filter,
//               mission-rename, update-agent}
//        swarm.replay.{list, scrub, bookmark, listBookmarks, deleteBookmark}
//        assistant.conversations.{list, get, delete, resumeHint}
//        swarm.origin.get
//        voice.diagnostics.run
//   C. Direct ipcMain.handle(...) calls in electron/main.ts (v1.5.4-B):
//        voice.globalCapture.{getStatus, setEnabled, setHotkey, setMode,
//                             setModelId, downloadModel, abortDownload}
//
// Both A and B are enumerated statically from the controller source files to
// avoid spawning an Electron process. C is enumerated in DIRECT_IPC_HANDLE_CHANNELS
// below and cross-checked against CHANNELS directly.
//
// NOTE ON KNOWN DRIFT (resolved in v1.5.3):
//   - providers.spawnInstall / setInstallConsent / getInstallConsent: caught by
//     this test on its first run as a v1.4.9-class production regression. Folded
//     into CHANNELS pre-merge.
//   - voice.globalCapture.* channels moved from CHANNELS_REQUIRING_LEAD_REVIEW
//     into DIRECT_IPC_HANDLE_CHANNELS in v1.5.4-B. They are now tested by the
//     dedicated "direct ipcMain.handle channels are in CHANNELS" assertion.
//   Future drift caught by this test must be reviewed by the
//   lead before being added to or removed from CHANNELS.

import { describe, expect, it } from 'vitest';
import { CHANNELS, EVENTS } from './rpc-channels';

// ------------------------------------------------------------------
// SOURCE A: Typed router namespace.method pairs
//
// Derived by reading the `defineRouter({ … })` call at the bottom of
// buildRouter() in src/main/rpc-router.ts and enumerating every method
// in each controller object. These must match the actual runtime shape;
// update this list when controllers grow new methods.
// ------------------------------------------------------------------

const TYPED_ROUTER_CHANNELS: ReadonlyArray<string> = [
  // app (appCtl)
  'app.getVersion',
  'app.getPlatform',
  'app.diagnostics',
  'app.checkForUpdates',
  'app.quitAndInstall',
  'app.tier',
  'app.revealInFolder',
  'app.openShell',
  'app.getUserDataPath',
  'app.dismissedWorktreeBanner',
  // pty (ptyCtl)
  'pty.create',
  'pty.write',
  'pty.resize',
  'pty.kill',
  'pty.snapshot',
  'pty.subscribe',
  'pty.processStats',
  'pty.list',
  'pty.forget',
  'pty.spawnScratch',   // W-4 Phase 4 — ephemeral scratch-shell sub-tabs
  'pty.killScratch',    // W-4 Phase 4 — ephemeral scratch-shell sub-tabs
  // panes (panesCtl)
  'panes.resume',
  'panes.respawnFailed',
  'panes.resumeSelected',   // P6 FEAT-1 — on-demand subset relaunch
  'panes.listSessions',
  'panes.lastResumePlan',
  'panes.listForWorkspace',
  'panes.brief',            // C-5 — inject plan capsule + write scope block
  'panes.rename',           // BSP-O4 — operator-supplied display name
  'panes.stageImage',       // Spec 2026-06-10 (B) — image staging for pane drop/paste
  // providers (providersCtl)
  'providers.list',
  'providers.probeAll',
  'providers.probe',
  'providers.spawnInstall',     // v1.5.3 hotfix — added to CHANNELS pre-merge
  'providers.setInstallConsent', // v1.5.3 hotfix — added to CHANNELS pre-merge
  'providers.getInstallConsent', // v1.5.3 hotfix — added to CHANNELS pre-merge
  // workspaces (workspacesCtl)
  'workspaces.pickFolder',
  'workspaces.open',
  'workspaces.list',
  'workspaces.remove',
  'workspaces.launch',
  'workspaces.openDev',     // SigmaLink Dev — singleton plain-shell workspace at ~
  'workspaces.rename',      // DEV-W2 — was missing from CHANNELS; Sidebar.tsx:294 rename was bridge-rejected
  'workspaces.openNew',     // DEV-W3a — was missing from CHANNELS
  // git (gitCtl)
  'git.status',
  'git.statusSummary',   // perf-hot-paths Task 3 — count-only pane-header poll
  'git.diff',
  'git.runCommand',
  'git.commitAndMerge',
  'git.worktreeRemove',
  'git.createCheckpoint',   // P6 FEAT-11 — agent undo/rewind
  'git.listCheckpoints',    // P6 FEAT-11 — agent undo/rewind
  'git.restoreCheckpoint',  // P6 FEAT-11 — agent undo/rewind
  'git.activityLog',        // P6 FEAT-8 — git-activity heatmap
  // fs (fsCtl)
  'fs.exists',
  'fs.readDir',
  'fs.readFile',
  'fs.writeFile',
  'fs.getWorktreeSizes',
  // swarms (swarmsCtl — from buildSwarmController)
  'swarms.create',
  'swarms.addAgent',
  'swarms.list',
  'swarms.get',
  'swarms.sendMessage',
  'swarms.broadcast',
  'swarms.rollCall',
  'swarms.tail',
  'swarms.kill',
  'swarms.resume',    // Spec 2026-06-10 (D) — + Pane auto-resume escape hatch
  'swarms.splitPane',
  'swarms.minimisePane',
  // browser (browserCtl — from buildBrowserController)
  'browser.openTab',
  'browser.closeTab',
  'browser.navigate',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.stop',
  'browser.listTabs',
  'browser.getActiveTab',
  'browser.setActiveTab',
  'browser.setBounds',
  'browser.getState',
  'browser.claimDriver',
  'browser.releaseDriver',
  'browser.listRecents',
  'browser.focusView',
  'browser.detachToWindow',
  'browser.reattach',
  'browser.teardown',
  // skills (skillsCtl — from buildSkillsController)
  'skills.list',
  'skills.ingestFolder',
  'skills.ingestZip',
  'skills.installFromUrl',
  'skills.enableForProvider',
  'skills.disableForProvider',
  'skills.uninstall',
  'skills.getReadme',
  'skills.verifyForWorkspace',
  'skills.listInstalled',    // v1.6.1 B3 — Skills tab Phase 1 discovery
  'skills.attach',           // v1.7.1 W-5 Skills Phase 2 — INFORMATIONAL binding
  'skills.detach',           // v1.7.1 W-5 Skills Phase 2 — INFORMATIONAL binding
  'skills.listBindings',     // v1.7.1 W-5 Skills Phase 2 — INFORMATIONAL binding
  // memory (memoryCtl — from buildMemoryController)
  'memory.list_memories',
  'memory.read_memory',
  'memory.create_memory',
  'memory.update_memory',
  'memory.append_to_memory',
  'memory.delete_memory',
  'memory.search_memories',
  'memory.find_backlinks',
  'memory.find_unlinked_mentions', // P4.2 MEM-7
  'memory.list_orphans',
  'memory.suggest_connections',
  'memory.init_hub',
  'memory.hub_status',
  'memory.getGraph',
  'memory.getMcpCommand',
  'memory.list_tags',       // P4 MEM-3
  'memory.list_by_tag',     // P4 MEM-3
  'memory.export_db',       // P4 DB-2
  'memory.import_db',       // P4 DB-2
  // review (reviewCtl — from buildReviewController)
  'review.list',
  'review.getDiff',
  'review.getConflicts',
  'review.runCommand',
  'review.killCommand',
  'review.setNotes',
  'review.markPassed',
  'review.markFailed',
  'review.commitAndMerge',
  'review.dropChanges',
  'review.pruneOrphans',
  'review.batchCommitAndMerge',
  // tasks (tasksCtl — from buildTasksController)
  'tasks.list',
  'tasks.get',
  'tasks.create',
  'tasks.update',
  'tasks.remove',
  'tasks.setStatus',
  'tasks.assign',
  'tasks.assignToSwarmAgent',
  'tasks.listComments',
  'tasks.addComment',
  'tasks.removeComment',
  // kv (kvCtl — from buildKvController)
  'kv.get',
  'kv.set',
  // assistant (assistantCtl — from buildAssistantController)
  'assistant.send',
  'assistant.list',
  'assistant.cancel',
  'assistant.dispatchPane',
  'assistant.dispatchBulk',  // v1.5.3-E (V3-W13-013 partial gap close)
  'assistant.refResolve',    // v1.5.3-E (V3-W13-013 partial gap close)
  'assistant.tools',
  'assistant.invokeTool',
  // design (designCtl — from buildDesignController)
  'design.captureElement',
  'design.dispatch',
  'design.history',
  'design.startPick',
  'design.stopPick',
  'design.attachFile',
  'design.listCanvases',
  'design.createCanvas',
  'design.openCanvas',
  'design.setDevServerRoots',
  'design.reloadTab',
  // voice (voiceCtl — from buildVoiceController)
  'voice.start',
  'voice.stop',
  'voice.dispatch',
  'voice.setMode',
  'voice.permissionRequest',
  // ruflo (rufloCtl — from buildRufloController)
  'ruflo.health',
  'ruflo.embeddings.search',
  'ruflo.embeddings.generate',
  'ruflo.patterns.search',
  'ruflo.patterns.store',
  'ruflo.autopilot.predict',
  'ruflo.entries.list',       // P4 MEM-1 — AgentDB entries as graph nodes
  'ruflo.entries.neighbors',  // P4 MEM-1 — similarity edges between entries
  'ruflo.install.start',
  'ruflo.verifyForWorkspace',
  'ruflo.daemonStatus',       // v1.6.1 B2 — Settings → Ruflo Daemon table
  'ruflo.restartDaemon',      // v1.6.1 B2 — restart a single workspace daemon
  // notifications (notificationsCtl — from buildNotificationsController)
  'notifications.list',
  'notifications.unreadCount',
  'notifications.markRead',
  'notifications.markAllRead',
  'notifications.markUnread',
  'notifications.dismiss',
  'notifications.clearRead',
  // sync (syncCtl — from buildSyncController)
  'sync.enable',
  'sync.disable',
  'sync.status',
  'sync.listConflicts',
  'sync.resolveConflict',
  'sync.exportMnemonic',
  'sync.isConfigured',
  'sync.recoverFromMnemonic',
  // telegram (telegramCtl — from buildTelegramController) — R-1
  'telegram.getStatus',
  'telegram.setToken',
  'telegram.clearToken',
  'telegram.setEnabled',
  'telegram.setAllowlist',
  'telegram.setIdleLockMinutes',
  'telegram.lock',
  'telegram.unlock',
  'telegram.auditTail',
  'usage.sessionSummary',     // P6 FEAT-3 — per-pane usage/cost
  'usage.weekSummary',        // P6 FEAT-3 — per-pane usage/cost
  'mcp.diagnoseWorkspace',    // P6 FEAT-5 — MCP config diagnostics
];

// ------------------------------------------------------------------
// SOURCE B: Side-band channels (registered outside defineRouter)
//
// These are manually constructed in registerRouter() using Map-based loops.
// See rpc-router.ts lines 1343–1416.
// ------------------------------------------------------------------

const SIDE_BAND_CHANNELS: ReadonlyArray<string> = [
  // consoleHandlers (buildConsoleController → .handlers)
  'swarm.console-tab',
  'swarm.stop-all',
  'swarm.constellation-layout',
  'swarm.agent-filter',
  'swarm.mission-rename',
  'swarm.update-agent',
  // replayHandlers (ReplayManager methods)
  'swarm.replay.list',
  'swarm.replay.scrub',
  'swarm.replay.bookmark',
  'swarm.replay.listBookmarks',
  'swarm.replay.deleteBookmark',
  // conversationsHandlers (buildConversationsHandlers)
  'assistant.conversations.list',
  'assistant.conversations.get',
  'assistant.conversations.delete',
  'assistant.conversations.resumeHint',
  // swarmOriginHandlers (buildSwarmOriginHandlers)
  'swarm.origin.get',
  // voiceDiagnosticsHandlers
  'voice.diagnostics.run',
  // sigmabenchHandlers (C-12 — conflict-bench harness + store)
  'sigmabench.run',
  'sigmabench.listRuns',
  'sigmabench.getRun',
  // cleanupHandlers (SF-13 — operator workspace/pane/worktree cleanup)
  'cleanup.removeWorkspace',
  'cleanup.clearPanes',
  'cleanup.pruneWorktrees',
];

// ------------------------------------------------------------------
// SOURCE C: Direct ipcMain.handle calls in electron/main.ts (v1.5.4-B)
//
// Enumerated by reading registerGlobalCaptureIpc() in electron/main.ts
// (lines ~167-222). These handlers are registered with `ipcMain.handle`
// directly rather than through the typed AppRouter or side-band maps.
// They MUST appear in CHANNELS for the preload bridge to allow them through.
//
// When new direct ipcMain.handle calls are added to electron/main.ts,
// add the corresponding channel string here. This list IS the enumeration —
// if a channel is listed here but absent from CHANNELS, the test fails.
// ------------------------------------------------------------------

const DIRECT_IPC_HANDLE_CHANNELS: ReadonlyArray<string> = [
  // registerGlobalCaptureIpc() in electron/main.ts — prefix: 'voice.globalCapture.'
  'voice.globalCapture.getStatus',
  'voice.globalCapture.setEnabled',
  'voice.globalCapture.setHotkey',
  'voice.globalCapture.setMode',
  'voice.globalCapture.setModelId',
  'voice.globalCapture.downloadModel',
  'voice.globalCapture.abortDownload',
  'voice.globalCapture.setListeningMode', // C-11 — wake-word listening toggle
];

// ------------------------------------------------------------------
// KNOWN DRIFT (informational — reported but not blocking)
//
// Channels present in CHANNELS but NOT backed by any registered handler.
// These are stale allowlist entries. The test reports them without failing
// so the lead can review and remove them in a dedicated cleanup PR.
//
// Also: channels registered by controllers but absent from CHANNELS.
// These are blocking the renderer from invoking the handler through the bridge.
// The test fails for these — they represent a real regression risk.
// ------------------------------------------------------------------

/**
 * Channels registered by controllers but intentionally absent from CHANNELS
 * because the renderers never call them directly (internal only) OR they
 * require lead review before being added to the security allowlist.
 *
 * Add channels here ONLY after lead review. Presence in this set suppresses
 * the forward-check failure — it does NOT add them to CHANNELS.
 */
const KNOWN_CONTROLLER_NOT_IN_CHANNELS = new Set<string>([
  // Empty after v1.5.3 — providers.spawnInstall/setInstallConsent/getInstallConsent
  // were the v1.4.9 production regression this test caught; folded into CHANNELS
  // pre-merge per lead decision. If a future drift surfaces here, add an entry
  // with a comment explaining why the controller method is intentionally NOT
  // renderer-callable.
]);

/**
 * Channels present in CHANNELS but NOT in the known registered handlers.
 * These may be stale entries from features not yet fully wired, or they may
 * be registered in controllers we haven't fully enumerated here.
 *
 * v1.5.4-B: voice.globalCapture.* channels removed from this set — they are
 * now properly enumerated in DIRECT_IPC_HANDLE_CHANNELS (Source C) and tested
 * by the dedicated direct-in-main assertion below.
 */
const CHANNELS_REQUIRING_LEAD_REVIEW = new Set<string>([
  // Empty after v1.5.4-B. If a new direct-in-main handler is added to
  // electron/main.ts without updating DIRECT_IPC_HANDLE_CHANNELS, the
  // inverse check will surface it here. Update DIRECT_IPC_HANDLE_CHANNELS
  // instead of adding entries to this suppression set.
]);

// ------------------------------------------------------------------
// All channels expected to be registered by rpc-router.ts at runtime.
// Does NOT include DIRECT_IPC_HANDLE_CHANNELS — those are checked
// by the separate "direct ipcMain.handle" test below.
// ------------------------------------------------------------------

const ALL_ROUTER_CHANNELS: ReadonlySet<string> = new Set([
  ...TYPED_ROUTER_CHANNELS,
  ...SIDE_BAND_CHANNELS,
]);

// ------------------------------------------------------------------
// Test suite
// ------------------------------------------------------------------

describe('CHANNELS vs AppRouter cross-reference (v1.5.3-B)', () => {
  /**
   * Forward check: every channel registered by rpc-router.ts must appear
   * in the CHANNELS allowlist. Drift means the renderer bridge rejects the
   * call with "IPC channel not allowed" — the v1.5.0 regression class.
   */
  it('every registered handler channel is present in CHANNELS allowlist', () => {
    const missing: string[] = [];

    for (const channel of ALL_ROUTER_CHANNELS) {
      // Skip channels that require separate lead review (won't be in CHANNELS yet).
      if (KNOWN_CONTROLLER_NOT_IN_CHANNELS.has(channel)) continue;

      if (!CHANNELS.has(channel)) {
        missing.push(channel);
      }
    }

    if (missing.length > 0) {
      const lines = [
        `${missing.length} registered handler channel(s) are MISSING from CHANNELS allowlist.`,
        'The preload bridge will hard-reject renderer calls to these channels.',
        'This is the same class of regression that broke sync for 14hr in v1.5.0.',
        '',
        'Missing channels (add these to rpc-channels.ts after lead security review):',
        ...missing.map((c) => `  - '${c}',`),
        '',
        'If any of these channels are intentionally renderer-inaccessible,',
        'add them to KNOWN_CONTROLLER_NOT_IN_CHANNELS in rpc-channels.test.ts.',
      ];
      expect.fail(lines.join('\n'));
    }
  });

  /**
   * Inverse check: every CHANNELS entry should have a corresponding
   * registered handler, OR be explicitly acknowledged as needing lead review.
   * Stale entries waste security-review budget and indicate dead code paths.
   *
   * NOTE: this is a soft warning, not a hard failure, because some channels
   * may be registered inside controller internals not enumerated here. The
   * CHANNELS_REQUIRING_LEAD_REVIEW set captures known cases.
   */
  it('every CHANNELS entry maps to a known registered handler (stale-entry detector)', () => {
    const directHandleSet = new Set(DIRECT_IPC_HANDLE_CHANNELS);
    const stale: string[] = [];

    for (const channel of CHANNELS) {
      if (ALL_ROUTER_CHANNELS.has(channel)) continue;
      if (CHANNELS_REQUIRING_LEAD_REVIEW.has(channel)) continue;
      // v1.5.4-B: channels enumerated in DIRECT_IPC_HANDLE_CHANNELS are
      // tested separately by the direct-in-main assertion; exclude them here
      // to avoid a false-positive stale-entry warning.
      if (directHandleSet.has(channel)) continue;

      stale.push(channel);
    }

    if (stale.length > 0) {
      const lines = [
        `${stale.length} CHANNELS allowlist entrie(s) have no corresponding registered handler.`,
        'These may be stale entries from removed features or unregistered handlers.',
        '',
        'Stale-or-unverified CHANNELS entries (review and remove if truly orphaned):',
        ...stale.map((c) => `  - '${c}'`),
        '',
        'If a channel is registered inside a controller\'s internal ipcMain.handle call',
        'rather than via the standard defineRouter / side-band patterns, add it to',
        'CHANNELS_REQUIRING_LEAD_REVIEW in rpc-channels.test.ts to suppress this warning.',
      ];
      // Report as an informational failure so the lead sees it without
      // blocking unrelated CI. Change to expect.fail() once the list is clean.
      expect.fail(lines.join('\n'));
    }
  });

  /**
   * Direct-in-main check (v1.5.4-B): every channel registered via a direct
   * ipcMain.handle call in electron/main.ts must appear in CHANNELS. These
   * handlers live outside the typed AppRouter and were previously invisible
   * to the forward/inverse checks above — they only worked because the
   * globalCapture channels were manually suppressed in CHANNELS_REQUIRING_LEAD_REVIEW.
   *
   * Now that they're explicitly enumerated in DIRECT_IPC_HANDLE_CHANNELS, any
   * new direct-in-main handler that isn't allowlisted will fail here instead
   * of silently bypassing the IPC bridge (or producing a confusing false positive
   * in the inverse check).
   */
  it('every direct ipcMain.handle channel in electron/main.ts is present in CHANNELS allowlist', () => {
    const missing: string[] = [];

    for (const channel of DIRECT_IPC_HANDLE_CHANNELS) {
      if (!CHANNELS.has(channel)) {
        missing.push(channel);
      }
    }

    if (missing.length > 0) {
      const lines = [
        `${missing.length} direct ipcMain.handle channel(s) from electron/main.ts are MISSING from CHANNELS allowlist.`,
        'The preload bridge will hard-reject renderer calls to these channels.',
        'Add them to rpc-channels.ts (after lead security review) OR update',
        'DIRECT_IPC_HANDLE_CHANNELS in this file if a handler was removed.',
        '',
        'Missing channels:',
        ...missing.map((c) => `  - '${c}',`),
      ];
      expect.fail(lines.join('\n'));
    }
  });

  /**
   * Smoke-check: CHANNELS, ALL_ROUTER_CHANNELS, and DIRECT_IPC_HANDLE_CHANNELS
   * are non-empty so a broken import can't produce a silent vacuous pass.
   */
  it('all sets are non-empty (import guard)', () => {
    expect(CHANNELS.size).toBeGreaterThan(50);
    expect(ALL_ROUTER_CHANNELS.size).toBeGreaterThan(50);
    expect(DIRECT_IPC_HANDLE_CHANNELS.length).toBeGreaterThan(0);
  });

  /**
   * crash-classification IPC — pty:error must be in EVENTS so the renderer
   * can subscribe to it via the preload bridge. It must NOT be in CHANNELS
   * (it is a one-way event from main → renderer, not an invocable RPC method).
   */
  it('pty:error is in EVENTS allowlist (crash-classification IPC)', () => {
    expect(EVENTS.has('pty:error')).toBe(true);
  });

  it('pty:error is NOT in CHANNELS (it is a one-way event, not an RPC method)', () => {
    expect(CHANNELS.has('pty:error')).toBe(false);
  });
});
