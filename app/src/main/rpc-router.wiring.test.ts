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
