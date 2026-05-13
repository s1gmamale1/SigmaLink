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
  // pty
  'pty.create',
  'pty.write',
  'pty.resize',
  'pty.kill',
  'pty.snapshot',
  'pty.subscribe',
  'pty.list',
  'pty.forget',
  // panes
  'panes.resume',
  // v1.2.8 — Recovery action behind the aggregated resume-failure toast.
  'panes.respawnFailed',
  // providers
  'providers.list',
  'providers.probeAll',
  'providers.probe',
  // workspaces
  'workspaces.pickFolder',
  'workspaces.open',
  'workspaces.list',
  'workspaces.remove',
  'workspaces.launch',
  // git
  'git.status',
  'git.diff',
  'git.runCommand',
  'git.commitAndMerge',
  'git.worktreeRemove',
  // fs
  'fs.exists',
  // V3-W14-007 — Editor tab file tree + Monaco source loader.
  'fs.readDir',
  'fs.readFile',
  'fs.writeFile',
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
  // V3-W12-017 — Bridge Assistant (W13 fills bodies)
  'assistant.send',
  'assistant.list',
  'assistant.cancel',
  'assistant.dispatchPane',
  'assistant.tools',
  'assistant.invokeTool',
  // P3-S7 — Bridge Assistant cross-session persistence: Conversations panel
  // backing + Operator Console origin link. Channels register side-band in
  // `rpc-router.ts`; the typed AppRouter shape declares them under
  // `assistant.conversations` and `swarm.origin` for documentation.
  'assistant.conversations.list',
  'assistant.conversations.get',
  'assistant.conversations.delete',
  'swarm.origin.get',
  // V3-W12-017 — Design Mode / Bridge Canvas (W14 fills bodies)
  'design.captureElement',
  'design.dispatch',
  'design.history',
  // V3-W14-001..006 — Bridge Canvas live channels.
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
  // V3-W12-017 — BridgeVoice (W15 fills bodies)
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
  // Phase 4 Track C — Ruflo MCP embed (lazy-downloaded `@claude-flow/cli`).
  // The supervisor lives in main; renderer features (Memory semantic search,
  // Bridge pattern surfacing, Command-Palette autopilot, Settings → Ruflo)
  // exercise these channels. When the supervisor is `absent`/`down`, calls
  // resolve with `{ ok: false, code: 'ruflo-unavailable' }` rather than
  // throw, so renderer fall-back paths stay quiet.
  'ruflo.health',
  'ruflo.embeddings.search',
  'ruflo.embeddings.generate',
  'ruflo.patterns.search',
  'ruflo.patterns.store',
  'ruflo.autopilot.predict',
  'ruflo.install.start',
  'ruflo.verifyForWorkspace',
]);

/**
 * Allowlist of one-way events the main process is permitted to emit and the
 * renderer is permitted to subscribe to via `eventOn`.
 */
export const EVENTS: ReadonlySet<string> = new Set<string>([
  'pty:data',
  'pty:exit',
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
  // V3-W13-013 — Bridge Assistant streaming + tool tracer events. The
  // assistant.* RPC namespace is already declared above; these one-way
  // events drive the renderer's orb state machine + ToolCallInspector.
  'assistant:state',
  'assistant:tool-trace',
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
  // supervisor state transition (Settings + Memory chip + Bridge ribbon
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

]);

export function isAllowedChannel(channel: string): boolean {
  return CHANNELS.has(channel);
}

export function isAllowedEvent(name: string): boolean {
  return EVENTS.has(name);
}
