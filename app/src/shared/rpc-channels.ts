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
]);

export function isAllowedChannel(channel: string): boolean {
  return CHANNELS.has(channel);
}

export function isAllowedEvent(name: string): boolean {
  return EVENTS.has(name);
}
