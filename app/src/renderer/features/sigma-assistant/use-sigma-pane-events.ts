import { useEffect, useSyncExternalStore } from 'react';
import { onEvent } from '@/renderer/lib/rpc';
import type { PaneEvent, PaneEventKind } from './PaneEventCard';

interface RawPaneEvent {
  id: string;
  conversationId: string;
  sessionId: string;
  kind: PaneEventKind;
  body?: Record<string, unknown> | null;
  ts: number;
}

class PaneEventStore {
  private events: PaneEvent[] = [];
  private listeners = new Set<() => void>();
  private activeConversationId: string | null = null;

  setActiveConversationId(id: string | null) {
    this.activeConversationId = id;
  }

  getActiveConversationId() {
    return this.activeConversationId;
  }

  add(raw: RawPaneEvent) {
    this.events.push(raw as PaneEvent);
    for (const fn of this.listeners) fn();
  }

  clear() {
    this.events = [];
    for (const fn of this.listeners) fn();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getSnapshot = () => {
    return this.events;
  };
}

const store = new PaneEventStore();

export function useSigmaPaneEvents(conversationId: string | null): PaneEvent[] {
  useEffect(() => {
    store.setActiveConversationId(conversationId);
    store.clear();
    if (!conversationId) return;
    const off = onEvent<RawPaneEvent>('assistant:pane-event', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      if (raw.conversationId !== store.getActiveConversationId()) return;
      store.add(raw);
    });
    return () => {
      off();
      store.clear();
    };
  }, [conversationId]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
