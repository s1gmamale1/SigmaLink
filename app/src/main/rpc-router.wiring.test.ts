// C6 obs (HIGH fix) — production-wiring guard.
//
// The disk-guard CRITICAL notification only reaches the operator if the router
// threads the live `notificationsManager` into BOTH spawn-owning factories:
//   1. executeLaunchPlan(plan, { …, notifications: notificationsManager })
//   2. buildSwarmController({ …, notifications: notificationsManager })
//
// rpc-router.ts is a monolith that boots better-sqlite3 (unloadable under
// vitest's node ABI), so it can't be unit-instantiated. The behavioural proof
// that the sink REACHES the disk-guard catch lives in controller-split.test.ts
// (controller → factory → catch) and launcher.test.ts (deps injected directly).
// What those CAN'T catch is a regression where the router simply stops PASSING
// the sink at the call site. This source-level guard closes that gap: it reads
// the router source and asserts both threading points are present. The regexes
// are whitespace-tolerant so ordinary reformatting doesn't trip them — only an
// actual removal of the `notifications: notificationsManager` thread does.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EVENTS, CHANNELS } from '../shared/rpc-channels';

const ROUTER_SRC = readFileSync(
  path.resolve(__dirname, './rpc-router.ts'),
  'utf8',
);

describe('rpc-router production wiring — notifications sink threaded to spawn factories', () => {
  it('executeLaunchPlan is called with notifications: notificationsManager', () => {
    // Match `executeLaunchPlan(` … `notifications: notificationsManager` before
    // the matching close — tolerant of intervening props/comments/whitespace.
    const launchCall = /executeLaunchPlan\s*\([\s\S]*?notifications\s*:\s*notificationsManager[\s\S]*?\}\s*\)/;
    expect(ROUTER_SRC).toMatch(launchCall);
  });

  it('buildSwarmController is built with notifications: notificationsManager', () => {
    const swarmCall = /buildSwarmController\s*\(\s*\{[\s\S]*?notifications\s*:\s*notificationsManager[\s\S]*?\}\s*\)/;
    expect(ROUTER_SRC).toMatch(swarmCall);
  });

  it('notificationsManager is constructed before those call sites (sanity)', () => {
    const ctorIdx = ROUTER_SRC.indexOf('new NotificationsManager(');
    const launchIdx = ROUTER_SRC.indexOf('executeLaunchPlan(');
    const swarmIdx = ROUTER_SRC.indexOf('buildSwarmController(');
    expect(ctorIdx).toBeGreaterThanOrEqual(0);
    expect(launchIdx).toBeGreaterThan(ctorIdx);
    expect(swarmIdx).toBeGreaterThan(ctorIdx);
  });
});

// RC5 — Guard: every broadcast('literal') in rpc-router.ts must be in EVENTS.
// The preload bridge silently no-ops renderer subscriptions to events not in
// EVENTS, so a missing entry means the renderer never receives the event.
// This test reads the router source (same constant above) and checks every
// literal string passed to broadcast() is allowlisted.
describe('rpc-router broadcast events — every literal is in EVENTS', () => {
  const RE = /\bbroadcast\(\s*(['"])([^'"]+)\1/g;
  const lits: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = RE.exec(ROUTER_SRC)) !== null) lits.push(m[2]);

  it('finds broadcast literals', () => {
    expect(lits.length).toBeGreaterThan(0);
  });

  it('every broadcast literal is in EVENTS', () => {
    const missing = lits.filter((e) => !EVENTS.has(e));
    expect(missing, JSON.stringify(missing)).toEqual([]);
  });

  it('notifications:changed in EVENTS', () => {
    expect(EVENTS.has('notifications:changed')).toBe(true);
  });

  it('notification channels in CHANNELS', () => {
    expect(CHANNELS.has('notifications.list')).toBe(true);
    expect(CHANNELS.has('notifications.unreadCount')).toBe(true);
    expect(CHANNELS.has('notifications.markRead')).toBe(true);
  });
});
