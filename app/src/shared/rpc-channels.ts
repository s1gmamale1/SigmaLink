// Allowlist of every IPC channel the renderer is permitted to invoke through
// the preload bridge. The set is derived by hand from `router-shape.ts`'s
// `AppRouter` interface; the unit-test sanity check below double-checks that
// every namespace.method declared here matches the registered router. Keeping
// this list explicit avoids the renderer (or any compromised package executing
// in the renderer) from invoking arbitrary IPC channels.
//
// When adding a controller method to `AppRouter`, append the channel here.

export const CHANNELS: ReadonlySet<string> = new Set<string>([
  // app
  'app.getVersion',
  'app.getPlatform',
  'app.diagnostics',
  // V3-W14-008 — manual electron-updater trigger from Settings → Updates.
  'app.checkForUpdates',
  // v1.2.4 — trigger update install/quit
  'app.quitAndInstall',
  // V3-W15-005 — read the current plan tier (default 'ultra' on SigmaLink).
  'app.tier',
  // v1.4.2-06 — Worktree location UX.
  'app.revealInFolder',
  'app.openShell',
  'app.getUserDataPath',
  'app.dismissedWorktreeBanner',
  // pty
  'pty.create',
  'pty.write',
  'pty.resize',
  'pty.kill',
  'pty.snapshot',
  'pty.subscribe',
  'pty.processStats',
  'pty.list',
  'pty.forget',
  // W-4 Phase 4 — Ephemeral scratch-shell sub-tabs. No DB row; kills on close.
  'pty.spawnScratch',
  'pty.killScratch',
  // panes
  'panes.resume',
  // v1.2.8 — Recovery action behind the aggregated resume-failure toast.
  'panes.respawnFailed',
  // P6 FEAT-1 — on-demand subset relaunch from the "Resume agents…" command.
  // ADDITIVE to the boot auto-resume (`panes.resume`); resumes only the
  // operator-chosen session ids.
  'panes.resumeSelected',
  // v1.3.0 — Session picker: list provider sessions for a cwd.
  'panes.listSessions',
  // v1.3.0 — Session picker: most recent resume plan for a workspace.
  'panes.lastResumePlan',
  // v1.4.3 (#02) — Pane rehydration. Returns full AgentSession rows for the
  // workspace so the renderer can dispatch ADD_SESSIONS on workspace reopen.
  // The RPC was added in v1.4.3 PR #28 but the channel was never added to
  // this allowlist — three call sites (useSessionRestore.ts, Sidebar.tsx,
  // Launcher.tsx) were silently failing via try/catch since v1.4.3 and pane
  // state was effectively NOT restoring on workspace reopen. Discovered while
  // adding the v1.4.7 test reload-sessions hook. (v1.4.7 packet 02 byproduct)
  'panes.listForWorkspace',
  // C-5 — inject a structured plan capsule into a pane's PTY + write a
  // per-worktree CLAUDE.md scope guidance block (idempotent marker-delimited).
  'panes.brief',
  // BSP-O4 — operator-supplied display name for a pane session. Pass
  // name: null to clear the override (reverts to computed alias).
  'panes.rename',
  // Spec 2026-06-10 (B) — image staging for pane drop/paste.
  'panes.stageImage',
  // providers
  'providers.list',
  'providers.probeAll',
  'providers.probe',
  // v1.4.9-06 provider installation UI (ProvidersTab + ProviderInstallModal).
  // The handlers shipped in v1.4.9 #49 but were never added here, so the preload
  // bridge has been rejecting these calls with "IPC channel not allowed" toasts
  // since v1.4.9. Caught by the v1.5.3 CHANNELS-vs-AppRouter defensive test.
  'providers.spawnInstall',
  'providers.setInstallConsent',
  'providers.getInstallConsent',
  // workspaces
  'workspaces.pickFolder',
  'workspaces.open',
  'workspaces.list',
  'workspaces.remove',
  'workspaces.launch',
  // SigmaLink Dev (2026-06-11) — open/create the singleton dev workspace.
  'workspaces.openDev',
  // DEV-W2 — rename a workspace's display label; was missing from CHANNELS (Sidebar.tsx:294
  // rename was bridge-rejected since the handler shipped without an allowlist entry).
  'workspaces.rename',
  // DEV-W3a — force-open a distinct workspace (never reuses existing); same omission.
  'workspaces.openNew',
  // git
  'git.status',
  'git.statusSummary',
  'git.diff',
  'git.runCommand',
  'git.commitAndMerge',
  'git.worktreeRemove',
  // P6 FEAT-11 — agent undo/rewind via worktree git checkpoints
  'git.createCheckpoint',
  'git.listCheckpoints',
  'git.restoreCheckpoint',
  // P6 FEAT-8 — per-worktree git-activity heatmap
  'git.activityLog',
  // fs
  'fs.exists',
  // V3-W14-007 — Editor tab file tree + Monaco source loader.
  'fs.readDir',
  'fs.readFile',
  'fs.writeFile',
  // v1.4.2-06 — Storage panel: list worktrees with sizes.
  'fs.getWorktreeSizes',
  // swarms
  'swarms.create',
  'swarms.addAgent',
  'swarms.list',
  'swarms.get',
  'swarms.sendMessage',
  'swarms.broadcast',
  'swarms.rollCall',
  'swarms.tail',
  'swarms.kill',
  // Spec 2026-06-10 (D) — + Pane auto-resume escape hatch.
  'swarms.resume',
  // v1.4.3 #06 — Pane Split + Minimise.
  'swarms.splitPane',
  'swarms.minimisePane',
  // browser
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
  // DEV-2 — recently-closed tabs (was absent from the allowlist; recon found gap).
  'browser.listRecents',
  // BSP-B4 — forward focus to the embedded WebContentsView.
  'browser.focusView',
  // BSP-B2 — detach/reattach the browser to a second window.
  'browser.detachToWindow',
  'browser.reattach',

  'browser.teardown',
  // skills
  'skills.list',
  'skills.ingestFolder',
  'skills.ingestZip',
  // Phase 4 Step 5 — live install from a public GitHub URL. The renderer
  // subscribes to `skills:install-progress` (one-way event) to drive a
  // progress bar between fetch / extract / validate / ingest / fanout
  // phases.
  'skills.installFromUrl',
  'skills.enableForProvider',
  'skills.disableForProvider',
  'skills.uninstall',
  'skills.getReadme',
  'skills.verifyForWorkspace',
  // v1.6.1 B3 — Skills tab Phase 1: read-only discovery of superpowers +
  // Ruflo skills from the on-disk plugin cache. Returns InstalledSkillEntry[].
  'skills.listInstalled',
  // v1.7.1 W-5 Skills Phase 2 — INFORMATIONAL binding CRUD (visual chip
  // association only; no behavioral activation; see 0021_skill_bindings).
  'skills.attach',
  'skills.detach',
  'skills.listBindings',
  // memory
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
  'memory.find_unlinked_mentions', // P4.2 MEM-7 — unlinked mentions
  'memory.list_tags',       // P4 MEM-3 — tag facets
  'memory.list_by_tag',     // P4 MEM-3 — notes for a tag
  'memory.export_db',       // P4 DB-2 — backup
  'memory.import_db',       // P4 DB-2 — restore (destructive)
  // review
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
  // kv
  'kv.get',
  'kv.set',
  // tasks
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
  // V3-W12-017 — Sigma Assistant (W13 fills bodies)
  'assistant.send',
  'assistant.list',
  'assistant.cancel',
  'assistant.dispatchPane',
  // V3-W13-013 (SHIPPED-PARTIAL) — bulk pane dispatch + @ref resolution
  'assistant.dispatchBulk',
  'assistant.refResolve',
  'assistant.tools',
  'assistant.invokeTool',
  // P3-S7 — Sigma Assistant cross-session persistence: Conversations panel
  // backing + Operator Console origin link. Channels register side-band in
  // `rpc-router.ts`; the typed AppRouter shape declares them under
  // `assistant.conversations` and `swarm.origin` for documentation.
  'assistant.conversations.list',
  'assistant.conversations.get',
  'assistant.conversations.delete',
  'assistant.conversations.resumeHint',
  'swarm.origin.get',
  // V3-W12-017 — Design Mode / Sigma Canvas (W14 fills bodies)
  'design.captureElement',
  'design.dispatch',
  'design.history',
  // V3-W14-001..006 — Sigma Canvas live channels.
  'design.startPick',
  'design.stopPick',
  'design.attachFile',
  'design.listCanvases',
  'design.createCanvas',
  'design.openCanvas',
  'design.setDevServerRoots',
  'design.reloadTab',
  // V3-W12-017 — Operator Console RPC additions (W12-W13 fill bodies)
  'swarm.console-tab',
  'swarm.stop-all',
  'swarm.constellation-layout',
  'swarm.agent-filter',
  'swarm.mission-rename',
  'swarm.update-agent',
  // P3-S6 — Persistent Swarm Replay. Scrub past sessions frame-by-frame.
  'swarm.replay.list',
  'swarm.replay.scrub',
  'swarm.replay.bookmark',
  'swarm.replay.listBookmarks',
  'swarm.replay.deleteBookmark',
  // V3-W12-017 — SigmaVoice (W15 fills bodies)
  'voice.start',
  'voice.stop',
  // V1.1 — SigmaVoice native macOS dispatcher hooks. `dispatch` runs the
  // intent classifier on an arbitrary transcript (used for accessibility
  // bypass + dev tests); `setMode` flips the routing strategy at runtime
  // (`auto` | `web-speech` | `native-mac` | `off`).
  'voice.dispatch',
  'voice.setMode',
  // V1.1.1 — Settings → Voice diagnostics. Re-runs the four-stage probe
  // (native module / mic permission / dispatcher reachability / persisted
  // mode) so support can pinpoint why "voice not enabled" surfaces.
  'voice.diagnostics.run',
  // V1.1.1 — Re-prompt the OS microphone permission dialog from Settings
  // without faking a capture session. macOS-only; on other platforms the
  // call resolves with `{ status: 'unsupported' }`.
  'voice.permissionRequest',
  // v1.4.9 — Global voice capture (macOS only for v1.4.9).
  'voice.globalCapture.getStatus',
  'voice.globalCapture.setEnabled',
  'voice.globalCapture.setHotkey',
  'voice.globalCapture.setMode',
  'voice.globalCapture.setModelId',
  'voice.globalCapture.downloadModel',
  'voice.globalCapture.abortDownload',
  // C-11 — "Hey Jorvis" always-on listening mode toggle. Persists
  // `voice.listeningMode` and arms/disarms the energy-gated wake loop.
  'voice.globalCapture.setListeningMode',
  // Phase 4 Track C — Ruflo MCP embed (lazy-downloaded `@claude-flow/cli`).
  // The supervisor lives in main; renderer features (Memory semantic search,
  // Sigma pattern surfacing, Command-Palette autopilot, Settings → Ruflo)
  // exercise these channels. When the supervisor is `absent`/`down`, calls
  // resolve with `{ ok: false, code: 'ruflo-unavailable' }` rather than
  // throw, so renderer fall-back paths stay quiet.
  'ruflo.health',
  'ruflo.embeddings.search',
  'ruflo.embeddings.generate',
  'ruflo.patterns.search',
  'ruflo.patterns.store',
  'ruflo.autopilot.predict',
  // P4 MEM-1 — surface the AgentDB the Obsidian way (graph nodes + similarity edges).
  'ruflo.entries.list',
  'ruflo.entries.neighbors',
  'ruflo.install.start',
  'ruflo.verifyForWorkspace',
  // v1.6.1 B2 — Settings → Ruflo Daemon table: list + restart per-workspace
  // HTTP daemons. Request/response (not one-way events), so they live here.
  'ruflo.daemonStatus',
  'ruflo.restartDaemon',
  // v1.4.9 #07 — Notifications + top-right bell. The manager is the single
  // owner of all reads/writes; renderer exclusively goes through these
  // channels. Live updates arrive on the `notifications:changed` one-way
  // event registered in EVENTS below.
  'notifications.list',
  'notifications.unreadCount',
  'notifications.markRead',
  'notifications.markAllRead',
  'notifications.markUnread',
  'notifications.dismiss',
  'notifications.clearRead',
  // C-12 SigmaBench — multi-agent conflict benchmark. `run` kicks the harness
  // fire-and-forget and returns the new run id; `listRuns` / `getRun` read the
  // benchmark store so the SigmaBench room can render the provider
  // leaderboard. Registered side-band under `sigmabench.<method>` in
  // rpc-router.ts (not in the typed AppRouter shape).
  'sigmabench.run',
  'sigmabench.listRuns',
  'sigmabench.getRun',
  // v1.5.0 packet 09 — Cross-machine sync.
  'sync.enable',
  'sync.disable',
  'sync.status',
  'sync.listConflicts',
  'sync.resolveConflict',
  'sync.exportMnemonic',
  'sync.isConfigured',
  'sync.recoverFromMnemonic',
  // SF-13 — Operator cleanup actions. Destructive; always dry-run first.
  // Registered side-band under `cleanup.*` in rpc-router.ts (not in the
  // typed AppRouter shape) so the lead's rpc-router.ts registration is the
  // single point of control.
  'cleanup.removeWorkspace',
  'cleanup.clearPanes',
  'cleanup.pruneWorktrees',
  // R-1 — Jorvis Telegram remote. SECURITY-CRITICAL: `setToken` is write-only;
  // the token value never crosses IPC in a response (getStatus reports only a
  // `tokenSet` boolean).
  'telegram.getStatus',
  'telegram.setToken',
  'telegram.clearToken',
  'telegram.setEnabled',
  'telegram.setAllowlist',
  'telegram.setIdleLockMinutes',
  'telegram.lock',
  'telegram.unlock',
  'telegram.auditTail',
  // P6 FEAT-3 — per-pane usage / cost
  'usage.sessionSummary',
  'usage.weekSummary',
  // P6 FEAT-5 — MCP config diagnostics
  'mcp.diagnoseWorkspace',
]);

/**
 * Allowlist of one-way events the main process is permitted to emit and the
 * renderer is permitted to subscribe to via `eventOn`.
 */
export const EVENTS: ReadonlySet<string> = new Set<string>([
  'pty:data',
  'pty:exit',
  // crash-classification IPC — emitted instead of (or in addition to) pty:exit
  // when the process exit is classified as a crash: earlyDeath (<1.5s) OR
  // non-zero exitCode/signal. Payload: { sessionId, exitCode, signal? }.
  // The renderer subscribes to keep crashed panes visible instead of GC-removing them.
  'pty:error',
  // V3-W13-002 — emitted when the PTY data stream contains a URL (plain or
  // OSC8 hyperlink). The renderer routes the click into the in-app browser
  // when `kv['browser.captureLinks']` is on.
  'pty:link-detected',
  'workspace:launched',
  'swarm:message',
  'memory:changed',
  'browser:state',
  'skills:changed',
  // Phase 4 Step 5 — live install progress for a marketplace install.
  // Payload: `{ ownerRepo, phase, bytesDone, bytesTotal, message? }` where
  // `phase` is one of resolve|fetch|extract|validate|ingest|fanout|done|error.
  'skills:install-progress',
  'skills:workspace-verified',
  'review:changed',
  // P6 FEAT-11 — emitted after a checkpoint is created or restored so the
  // rewind panel can refresh its list. Payload: { sessionId }.
  'git:checkpoints-changed',
  'review:run-output',
  'tasks:changed',
  // V3-W12-017 — Operator Console + Bridge + Design + Voice events
  'swarm:counters',
  'swarm:ledger',
  'voice:state',
  // V1.1 — SigmaVoice dispatcher echoes the resolved intent so VoicePill can
  // toast "Routing → coordinator..." between final-transcript and controller
  // resolution. Payload mirrors `ClassifiedIntent` from voice/dispatcher.ts.
  'voice:dispatch-echo',
  // v1.4.9 — Global capture state transitions emitted by the main process.
  // Payload: `GlobalCaptureStatus` from voice/global-capture.ts.
  'voice:global-capture-state',
  // v1.4.9 — Toast messages from the global capture pipeline.
  // Payload: `{ message: string; level: 'info' | 'warn' | 'error' }`.
  'voice:global-capture-toast',
  // V1.1 — Result envelope for the most recent dispatch ({ ok, reason }).
  // Used by telemetry + future Voice History panel; renderer subscribes
  // optionally.
  'voice:dispatch-result',
  // V1.1 — Native voice errors (no-permission, audio-engine-failure, etc).
  // Renderer surfaces these as toasts with a "Open Settings" action when
  // `code === 'no-permission'`.
  'voice:error',
  // V1.1.1 — Fired once at controller boot when SigmaVoice cannot run on
  // the current host (non-darwin platform or native module missing). Lets
  // the renderer render an explanatory tooltip instead of a silent disable.
  // Payload: `{ reason: 'no-native' | 'no-permission' | 'platform' }`.
  'voice:unavailable',
  // V1.1 — main → renderer navigation hint. SigmaVoice's `app.navigate`
  // intent fires this so the active window's router can switch panes
  // without round-tripping through the renderer voice adapter.
  'app:navigate',
  'assistant:dispatch-echo',
  // V3-W13-013 — Sigma Assistant streaming + tool tracer events. The
  // assistant.* RPC namespace is already declared above; these one-way
  // events drive the renderer's orb state machine + ToolCallInspector.
  'assistant:state',
  'assistant:tool-trace',
  'assistant:pane-event',
  'design:capture',
  // V3-W14-001..005 — picker lifecycle + HMR poke notifications.
  'design:picker-state',
  'design:patch-applied',
  // P3-S6 — broadcast when a replay scrub completes; useful for keeping
  // multiple inspectors in sync on the same session.
  'swarm:replay-frame',
  // V3-W14-009 — main → renderer signal that `better-sqlite3` (or another
  // required native module) failed its ABI check. Renderer surfaces the
  // NativeRebuildModal when this fires.
  'app:native-rebuild-needed',
  // Phase 4 Track C — Ruflo lifecycle events. `ruflo:health` fires on every
  // supervisor state transition (Settings + Memory chip + Jorvis assistant
  // subscribe to render state-aware affordances). `ruflo:install-progress`
  // streams the lazy-installer's phase / bytes so Settings can render a
  // progress bar without polling.
  'ruflo:health',
  'ruflo:install-progress',
  'ruflo:workspace-verified',
  // BUG-V1.1.2-02 — Session restore. `app:session-snapshot` is a renderer →
  // main fire-and-forget (via `eventSend`) that caches the active workspace
  // + room so the next boot can resume them. `app:session-restore` is the
  // main → renderer event the boot path emits once the renderer signals it
  // has finished loading. Both flow through the existing event allowlist;
  // the snapshot side rides on the `eventSend` API in the preload so we
  // don't have to expose an RPC channel for a one-shot push.
  'app:session-snapshot',
  'app:session-restore',
  // v1.1.3 Step 2 — runtime-open workspace id list. Main broadcasts it after
  // workspace open/close lifecycle changes; the renderer can also push its
  // local close/open list back through eventSend so main has the same source
  // of truth for later session persistence.
  'app:open-workspaces-changed',
  // v1.2.4 — auto-update one-way events from main → renderer
  'app:update-available',
  'app:update-mac-dmg-progress',
  'app:update-mac-dmg-ready',
  'app:update-win-progress',
  'app:update-win-ready',
  'app:update-error',
  // v1.4.9 #07 — Notification delta stream. Payload shape:
  // `{ added: Notification[], removed: string[], unreadCount: number }`.
  // The renderer reconciles via the reducer's `NOTIFICATIONS_DELTA` action;
  // NEVER push the full list on every change (the original v1.4.7 brief's
  // approach would saturate IPC under broadcast flood).
  'notifications:changed',
  // v1.5.0 (v1.5.2 reviewer DEFER) — sync controller emits this on every
  // status transition; adding to the allowlist here for forward-compat even
  // though no renderer subscriber exists yet (SyncTab uses polling).
  'sync:status',
  // C-10b — renderer → main fire-and-forget: the renderer's useVoiceFocusSync
  // hook pushes the currently active PTY session id whenever it changes so the
  // global-capture pipeline can pty.write() into the focused pane.
  'voice:focused-session',
  // BSP-O4 — emitted after a pane is renamed so PaneHeader title pills
  // refresh without a full rehydration. Payload: { sessionId, name }.
  'panes:session-renamed',
]);

export function isAllowedChannel(channel: string): boolean {
  return CHANNELS.has(channel);
}

export function isAllowedEvent(name: string): boolean {
  return EVENTS.has(name);
}
