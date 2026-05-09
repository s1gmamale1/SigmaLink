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

export const CHANNEL_SCHEMAS: Record<string, ChannelSchema> = {
  // ── app ──────────────────────────────────────────────────────────────
  'app.getVersion': stub,
  'app.getPlatform': stub,
  'app.diagnostics': stub,
  // V3-W14-008 — manual electron-updater trigger.
  'app.checkForUpdates': stub,
  // ── pty ──────────────────────────────────────────────────────────────
  'pty.create': stub,
  'pty.write': stub,
  'pty.resize': stub,
  'pty.kill': stub,
  'pty.subscribe': stub,
  'pty.list': stub,
  'pty.forget': stub,
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
  'skills.enableForProvider': stub,
  'skills.disableForProvider': stub,
  'skills.uninstall': stub,
  'skills.getReadme': stub,
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
