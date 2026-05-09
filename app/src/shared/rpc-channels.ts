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
]);

/**
 * Allowlist of one-way events the main process is permitted to emit and the
 * renderer is permitted to subscribe to via `eventOn`.
 */
export const EVENTS: ReadonlySet<string> = new Set<string>([
  'pty:data',
  'pty:exit',
  'workspace:launched',
  'swarm:message',
  'memory:changed',
  'browser:state',
  'skills:changed',
  'review:changed',
  'review:run-output',
  'tasks:changed',
]);

export function isAllowedChannel(channel: string): boolean {
  return CHANNELS.has(channel);
}

export function isAllowedEvent(name: string): boolean {
  return EVENTS.has(name);
}
