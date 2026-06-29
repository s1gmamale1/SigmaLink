import { describe, it, expect } from 'vitest';
import { PendingEscalationStore } from './pending-escalations';

describe('PendingEscalationStore', () => {
  it('register → checkEscalation = pending', () => {
    const store = new PendingEscalationStore({ now: () => 1000 });
    const { id } = store.registerEscalation({
      toolName: 'close_pane', argsHash: 'h1', summary: 'close pane s1', clientLabel: 'bot',
    });
    expect(store.checkEscalation(id)).toBe('pending');
  });

  it('listPending returns pending entries', () => {
    const store = new PendingEscalationStore({ now: () => 1000 });
    store.registerEscalation({ toolName: 'close_pane', argsHash: 'h1', summary: 's', clientLabel: 'bot' });
    store.registerEscalation({ toolName: 'kill_swarm', argsHash: 'h2', summary: 's2', clientLabel: 'bot' });
    const pending = store.listPending();
    expect(pending).toHaveLength(2);
    expect(pending.map((e) => e.toolName).sort()).toEqual(['close_pane', 'kill_swarm']);
  });

  it('approve → approved; consumeGrant true ONCE then false', () => {
    const store = new PendingEscalationStore({ now: () => 1000 });
    const { id } = store.registerEscalation({
      toolName: 'close_pane', argsHash: 'h1', summary: 's', clientLabel: 'bot',
    });
    store.resolveEscalation(id, true);
    expect(store.checkEscalation(id)).toBe('approved');
    // First consume: true
    expect(store.consumeGrant('close_pane', 'h1', 'bot')).toBe(true);
    // Second consume: false (already consumed)
    expect(store.consumeGrant('close_pane', 'h1', 'bot')).toBe(false);
    // Third: still false
    expect(store.consumeGrant('close_pane', 'h1', 'bot')).toBe(false);
  });

  it('approved escalation is removed from listPending', () => {
    const store = new PendingEscalationStore({ now: () => 1000 });
    const { id } = store.registerEscalation({
      toolName: 'close_pane', argsHash: 'h1', summary: 's', clientLabel: 'bot',
    });
    store.resolveEscalation(id, true);
    expect(store.listPending()).toHaveLength(0);
  });

  it('deny → denied; consumeGrant returns false', () => {
    const store = new PendingEscalationStore({ now: () => 1000 });
    const { id } = store.registerEscalation({
      toolName: 'kill_swarm', argsHash: 'h2', summary: 'kill it', clientLabel: 'bot',
    });
    store.resolveEscalation(id, false);
    expect(store.checkEscalation(id)).toBe('denied');
    expect(store.consumeGrant('kill_swarm', 'h2', 'bot')).toBe(false);
  });

  it('TTL expiry via fake clock → expired (checkEscalation)', () => {
    let t = 1000;
    const store = new PendingEscalationStore({ now: () => t, ttlMs: 5000 });
    const { id } = store.registerEscalation({
      toolName: 'browser_navigate', argsHash: 'h3', summary: 'nav', clientLabel: 'bot',
    });
    // Before expiry
    expect(store.checkEscalation(id)).toBe('pending');
    t = 1000 + 5001; // past TTL
    expect(store.checkEscalation(id)).toBe('expired');
  });

  it('TTL expiry prunes from listPending', () => {
    let t = 1000;
    const store = new PendingEscalationStore({ now: () => t, ttlMs: 5000 });
    store.registerEscalation({ toolName: 'close_pane', argsHash: 'h1', summary: 's', clientLabel: 'bot' });
    expect(store.listPending()).toHaveLength(1);
    t = 1000 + 5001;
    expect(store.listPending()).toHaveLength(0);
  });

  it('TTL expiry also kills the grant', () => {
    let t = 1000;
    const store = new PendingEscalationStore({ now: () => t, ttlMs: 5000 });
    const { id } = store.registerEscalation({
      toolName: 'close_pane', argsHash: 'h4', summary: 's', clientLabel: 'bot',
    });
    store.resolveEscalation(id, true); // grant recorded at t=1000, expiresAt=6000
    t = 1000 + 5001;                   // past TTL
    expect(store.consumeGrant('close_pane', 'h4', 'bot')).toBe(false);
  });

  it('unknown id → expired', () => {
    const store = new PendingEscalationStore();
    expect(store.checkEscalation('nonexistent')).toBe('expired');
  });

  it('resolveEscalation is idempotent — second call no-ops', () => {
    const store = new PendingEscalationStore({ now: () => 1000 });
    const { id } = store.registerEscalation({
      toolName: 'close_pane', argsHash: 'h5', summary: 's', clientLabel: 'bot',
    });
    store.resolveEscalation(id, true);
    store.resolveEscalation(id, false); // no-op (status is now 'approved', not 'pending')
    expect(store.checkEscalation(id)).toBe('approved');
  });

  it('grant is keyed per (toolName, argsHash, clientLabel) — different key misses', () => {
    const store = new PendingEscalationStore({ now: () => 1000 });
    const { id } = store.registerEscalation({
      toolName: 'close_pane', argsHash: 'h1', summary: 's', clientLabel: 'bot',
    });
    store.resolveEscalation(id, true);
    // Wrong argsHash
    expect(store.consumeGrant('close_pane', 'WRONG', 'bot')).toBe(false);
    // Wrong clientLabel
    expect(store.consumeGrant('close_pane', 'h1', 'other')).toBe(false);
    // Correct key
    expect(store.consumeGrant('close_pane', 'h1', 'bot')).toBe(true);
  });

  it('notify callback is called on registration', () => {
    const notified: string[] = [];
    const store = new PendingEscalationStore({
      now: () => 1000,
      notify: (req) => { notified.push(req.toolName); },
    });
    store.registerEscalation({ toolName: 'close_pane', argsHash: 'h1', summary: 's', clientLabel: 'bot' });
    expect(notified).toEqual(['close_pane']);
  });
});
