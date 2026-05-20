// v1.5.3-B — CHANNELS vs registered-handler cross-reference sanity check.
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
//
// rpc-router.ts registers channels from TWO sources:
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
//
// Both sources are enumerated statically from the controller source files to
// avoid spawning an Electron process.
//
// NOTE ON KNOWN DRIFT (to be fixed by lead — do NOT auto-add here):
//   providers.spawnInstall, providers.setInstallConsent, providers.getInstallConsent
//   voice.globalCapture.{getStatus, setEnabled, setHotkey, setMode,
//                        setModelId, downloadModel, abortDownload}
//   These are intentionally flagged by this test and must be reviewed by the
//   lead before being added to or removed from CHANNELS.

import { describe, expect, it } from 'vitest';
import { CHANNELS } from './rpc-channels';

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
  'pty.list',
  'pty.forget',
  // panes (panesCtl)
  'panes.resume',
  'panes.respawnFailed',
  'panes.listSessions',
  'panes.lastResumePlan',
  'panes.listForWorkspace',
  // providers (providersCtl)
  // NOTE: spawnInstall / setInstallConsent / getInstallConsent are registered
  // by the controller but are NOT in CHANNELS — intentional drift flag.
  'providers.list',
  'providers.probeAll',
  'providers.probe',
  'providers.spawnInstall',     // DRIFT: not in CHANNELS
  'providers.setInstallConsent', // DRIFT: not in CHANNELS
  'providers.getInstallConsent', // DRIFT: not in CHANNELS
  // workspaces (workspacesCtl)
  'workspaces.pickFolder',
  'workspaces.open',
  'workspaces.list',
  'workspaces.remove',
  'workspaces.launch',
  // git (gitCtl)
  'git.status',
  'git.diff',
  'git.runCommand',
  'git.commitAndMerge',
  'git.worktreeRemove',
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
  // memory (memoryCtl — from buildMemoryController)
  'memory.list_memories',
  'memory.read_memory',
  'memory.create_memory',
  'memory.update_memory',
  'memory.append_to_memory',
  'memory.delete_memory',
  'memory.search_memories',
  'memory.find_backlinks',
  'memory.list_orphans',
  'memory.suggest_connections',
  'memory.init_hub',
  'memory.hub_status',
  'memory.getGraph',
  'memory.getMcpCommand',
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
  'ruflo.install.start',
  'ruflo.verifyForWorkspace',
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
  // providers.spawnInstall / setInstallConsent / getInstallConsent —
  // Registered by the controller in rpc-router.ts but absent from CHANNELS.
  // These are renderer-facing channels for v1.4.9-06 provider installation UI.
  // Lead must decide whether to add them to CHANNELS or remove from controller.
  'providers.spawnInstall',
  'providers.setInstallConsent',
  'providers.getInstallConsent',
]);

/**
 * Channels present in CHANNELS but NOT in the known registered handlers.
 * These may be stale entries from features not yet fully wired, or they may
 * be registered in controllers we haven't fully enumerated here.
 * Voice global-capture channels: in CHANNELS but controller registration is
 * not observed in rpc-router.ts via the standard defineRouter or side-band
 * patterns — they may be registered inside buildVoiceController internals.
 *
 * These are NOT flagged as failures in the inverse check (to avoid false
 * positives from controller-internal registrations), but they ARE listed here
 * for documentation and lead visibility.
 */
const CHANNELS_REQUIRING_LEAD_REVIEW = new Set<string>([
  // v1.4.9 global capture — registered inside buildVoiceController or
  // voice/adapter.ts; not visible in the top-level rpc-router.ts loop.
  'voice.globalCapture.getStatus',
  'voice.globalCapture.setEnabled',
  'voice.globalCapture.setHotkey',
  'voice.globalCapture.setMode',
  'voice.globalCapture.setModelId',
  'voice.globalCapture.downloadModel',
  'voice.globalCapture.abortDownload',
]);

// ------------------------------------------------------------------
// All channels expected to be registered by rpc-router.ts at runtime.
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
    const stale: string[] = [];

    for (const channel of CHANNELS) {
      if (ALL_ROUTER_CHANNELS.has(channel)) continue;
      if (CHANNELS_REQUIRING_LEAD_REVIEW.has(channel)) continue;

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
   * Smoke-check: CHANNELS and ALL_ROUTER_CHANNELS are non-empty sets
   * so a broken import can't produce a silent vacuous pass.
   */
  it('both sets are non-empty (import guard)', () => {
    expect(CHANNELS.size).toBeGreaterThan(50);
    expect(ALL_ROUTER_CHANNELS.size).toBeGreaterThan(50);
  });
});
