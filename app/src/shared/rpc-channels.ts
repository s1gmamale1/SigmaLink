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
  // V3-W15-005 — read the current plan tier (default 'ultra' on SigmaLink).
  'app.tier',
  // pty
  'pty.create',
  'pty.write',
  'pty.resize',
  'pty.kill',
  'pty.subscribe',
  'pty.list',
  'pty.forget',
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
  'browser.getMcpUrl',
  'browser.teardown',
  // skills
  'skills.list',
  'skills.ingestFolder',
  'skills.ingestZip',
  'skills.enableForProvider',
  'skills.disableForProvider',
  'skills.uninstall',
  'skills.getReadme',
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
  'review:changed',
  'review:run-output',
  'tasks:changed',
  // V3-W12-017 — Operator Console + Bridge + Design + Voice events
  'swarm:counters',
  'swarm:ledger',
  'voice:state',
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
]);

export function isAllowedChannel(channel: string): boolean {
  return CHANNELS.has(channel);
}

export function isAllowedEvent(name: string): boolean {
  return EVENTS.has(name);
}
