// P3-S6 — Persistent Swarm Replay manager.
//
// The mailbox is already event-sourced on disk: every `MailboxEnvelope` lands
// as a row in `swarm_messages` with a chronological timestamp. This module
// turns that durable log into a scrubbable timeline so an operator can replay
// any past swarm session frame-by-frame.
//
// Frame indexing:
//   - `frameIdx === 0`  → empty state (no messages yet, agent roster as it
//                          existed when the swarm was created).
//   - `frameIdx === N`  → cumulative state right after the Nth message
//                          (1-indexed, ordered by `swarm_messages.ts ASC`).
//   - `totalFrames`     → total row count for the swarm.
//
// Memoization: `scrub` results are deterministic for a given (swarmId,
// frameIdx) pair, so we cache the last 32 frames keyed by `${swarmId}:${idx}`
// to keep the slider responsive while dragging.

import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  swarmAgents,
  swarmMessages,
  swarmReplaySnapshots,
  swarms,
} from '../db/schema';

export interface ReplaySwarmSummary {
  swarmId: string;
  name: string;
  missionExcerpt: string;
  agentCount: number;
  messageCount: number;
  firstAt: number | null;
  lastAt: number | null;
  status: string;
}

export interface ReplayAgent {
  id: string;
  agentKey: string;
  role: string;
  roleIndex: number;
  providerId: string;
  addedAt: number;
}

export interface ReplayMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  kind: string;
  body: string;
  ts: number;
  payload?: Record<string, unknown>;
}

export interface ReplayCounters {
  escalations: number;
  review: number;
  quiet: number;
  errors: number;
}

export interface ReplayFrame {
  swarmId: string;
  swarmName: string;
  missionText: string;
  frameIdx: number;
  totalFrames: number;
  agents: ReplayAgent[];
  messages: ReplayMessage[];
  counters: ReplayCounters;
}

export interface ReplayBookmark {
  id: string;
  label: string;
  frameIdx: number;
  createdAt: number;
}

const CACHE_MAX = 32;
const MISSION_EXCERPT_LEN = 100;

export class ReplayManager {
  /** LRU cache of computed frames. Insertion order = recency; oldest evicted. */
  private readonly frameCache = new Map<string, ReplayFrame>();

  /**
   * List every swarm in a workspace alongside replay-relevant counters. This
   * is the "swarm picker" feed for the Replays tab — it does not project
   * frames, just enough to render rows.
   */
  async list(workspaceId: string): Promise<ReplaySwarmSummary[]> {
    const db = getDb();
    const swarmRows = db
      .select()
      .from(swarms)
      .where(eq(swarms.workspaceId, workspaceId))
      .all();
    const out: ReplaySwarmSummary[] = [];
    for (const sw of swarmRows) {
      const messages = db
        .select({ ts: swarmMessages.ts })
        .from(swarmMessages)
        .where(eq(swarmMessages.swarmId, sw.id))
        .orderBy(asc(swarmMessages.ts))
        .all();
      const agents = db
        .select({ id: swarmAgents.id })
        .from(swarmAgents)
        .where(eq(swarmAgents.swarmId, sw.id))
        .all();
      const firstAt = messages.length ? messages[0].ts : null;
      const lastAt = messages.length ? messages[messages.length - 1].ts : null;
      const excerpt =
        sw.mission.length > MISSION_EXCERPT_LEN
          ? sw.mission.slice(0, MISSION_EXCERPT_LEN - 1) + '…'
          : sw.mission;
      out.push({
        swarmId: sw.id,
        name: sw.name,
        missionExcerpt: excerpt,
        agentCount: agents.length,
        messageCount: messages.length,
        firstAt,
        lastAt,
        status: sw.status,
      });
    }
    // Newest-first so the operator sees the most recent swarm at the top.
    out.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    return out;
  }

  /**
   * Return the cumulative replay state at `frameIdx`. Cached LRU per-swarm so
   * scrub-drag is responsive. Frame 0 is the empty state.
   */
  async scrub(swarmId: string, frameIdx: number): Promise<ReplayFrame> {
    const db = getDb();
    const swarmRow = db
      .select()
      .from(swarms)
      .where(eq(swarms.id, swarmId))
      .get();
    if (!swarmRow) {
      throw new Error(`Swarm not found: ${swarmId}`);
    }

    // Tail every message in chronological order. We keep the full list in
    // memory so we can slice cheaply per scrub; swarms with millions of
    // messages will need a different strategy, but the cap is bounded by the
    // mailbox throughput (1s tick × envelope cost).
    const allMessages = db
      .select()
      .from(swarmMessages)
      .where(eq(swarmMessages.swarmId, swarmId))
      .orderBy(asc(swarmMessages.ts))
      .all();
    const totalFrames = allMessages.length;
    const clamped = Math.max(0, Math.min(frameIdx, totalFrames));

    const cacheKey = `${swarmId}:${clamped}`;
    const cached = this.frameCache.get(cacheKey);
    if (cached) {
      // Touch for LRU recency.
      this.frameCache.delete(cacheKey);
      this.frameCache.set(cacheKey, cached);
      return cached;
    }

    const allAgents = db
      .select()
      .from(swarmAgents)
      .where(eq(swarmAgents.swarmId, swarmId))
      .all();

    const sliceMessages = allMessages.slice(0, clamped);
    // Cut-off ts: the last visible frame's timestamp. Agents whose
    // `createdAt` is later than this ts haven't joined yet at this point in
    // the timeline.
    const cutoffTs =
      clamped === 0 ? swarmRow.createdAt : sliceMessages[clamped - 1].ts;
    const visibleAgents: ReplayAgent[] = allAgents
      .filter((a) => a.createdAt <= cutoffTs)
      .map((a) => ({
        id: a.id,
        agentKey: a.agentKey,
        role: a.role,
        roleIndex: a.roleIndex,
        providerId: a.providerId,
        addedAt: a.createdAt,
      }));

    const messages: ReplayMessage[] = sliceMessages.map((row) => ({
      id: row.id,
      fromAgent: row.fromAgent,
      toAgent: row.toAgent,
      kind: row.kind,
      body: row.body,
      ts: row.ts,
      payload: parsePayload(row.payloadJson),
    }));

    const counters: ReplayCounters = projectCounters(messages);

    const frame: ReplayFrame = {
      swarmId,
      swarmName: swarmRow.name,
      missionText: swarmRow.mission,
      frameIdx: clamped,
      totalFrames,
      agents: visibleAgents,
      messages,
      counters,
    };

    this.cachePut(cacheKey, frame);
    return frame;
  }

  /** Persist a labelled bookmark at the given frame. */
  async bookmark(
    swarmId: string,
    frameIdx: number,
    label: string,
  ): Promise<{ snapshotId: string }> {
    const trimmed = (label ?? '').trim();
    if (!trimmed) throw new Error('Bookmark label must not be empty.');
    const db = getDb();
    const id = randomUUID();
    db.insert(swarmReplaySnapshots)
      .values({
        id,
        swarmId,
        label: trimmed,
        frameIdx: Math.max(0, Math.floor(frameIdx)),
        createdAt: Date.now(),
      })
      .run();
    return { snapshotId: id };
  }

  /** List all bookmarks for a swarm in frame-index order. */
  async listBookmarks(swarmId: string): Promise<ReplayBookmark[]> {
    const db = getDb();
    const rows = db
      .select()
      .from(swarmReplaySnapshots)
      .where(eq(swarmReplaySnapshots.swarmId, swarmId))
      .orderBy(asc(swarmReplaySnapshots.frameIdx))
      .all();
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      frameIdx: r.frameIdx,
      createdAt: r.createdAt,
    }));
  }

  /** Drop a bookmark. Best-effort — no error if the row was already gone. */
  async deleteBookmark(snapshotId: string): Promise<void> {
    const db = getDb();
    db.delete(swarmReplaySnapshots)
      .where(eq(swarmReplaySnapshots.id, snapshotId))
      .run();
  }

  /** Insert into the LRU map, evicting the oldest entry on overflow. */
  private cachePut(key: string, frame: ReplayFrame): void {
    if (this.frameCache.size >= CACHE_MAX) {
      const oldest = this.frameCache.keys().next().value;
      if (oldest !== undefined) this.frameCache.delete(oldest);
    }
    this.frameCache.set(key, frame);
  }
}

function parsePayload(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore — payload column is best-effort JSON */
  }
  return undefined;
}

function projectCounters(messages: ReplayMessage[]): ReplayCounters {
  let escalations = 0;
  let review = 0;
  let quiet = 0;
  let errors = 0;
  for (const m of messages) {
    switch (m.kind) {
      case 'escalation':
        escalations += 1;
        break;
      case 'review_request':
        review += 1;
        break;
      case 'quiet_tick':
        quiet += 1;
        break;
      case 'error_report':
        errors += 1;
        break;
      default:
        break;
    }
  }
  return { escalations, review, quiet, errors };
}

