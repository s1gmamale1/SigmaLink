// React context + `useAppState` hook for the global renderer AppState.
// Extracted from `state.tsx` so the hook (a non-component export) can live
// outside the TSX file and satisfy the react-refresh "only export
// components" rule. The Context object is consumed by `state.tsx`'s
// `AppStateProvider` and by every `useAppState` caller via this module.

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type Dispatch,
} from 'react';
import { initialAppState, type Action, type AppState } from './state.types';

export const AppStateContext = createContext<{
  state: AppState;
  dispatch: Dispatch<Action>;
} | null>(null);

export const AppDispatchContext = createContext<Dispatch<Action> | null>(null);

type Listener = () => void;

class AppStateStore {
  private state = initialAppState;
  private readonly listeners = new Set<Listener>();

  getSnapshot = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setState(next: AppState): void {
    if (Object.is(this.state, next)) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export const appStateStore = new AppStateStore();

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState outside provider');
  return ctx;
}

export function useAppDispatch(): Dispatch<Action> {
  const dispatch = useContext(AppDispatchContext);
  if (!dispatch) throw new Error('useAppDispatch outside provider');
  return dispatch;
}

export function useAppStateSelector<T>(
  selector: (state: AppState) => T,
): T {
  return useSyncExternalStore(
    appStateStore.subscribe,
    () => selector(appStateStore.getSnapshot()),
    () => selector(appStateStore.getSnapshot()),
  );
}
