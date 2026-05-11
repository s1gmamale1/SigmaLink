// React context + `useAppState` hook for the global renderer AppState.
// Extracted from `state.tsx` so the hook (a non-component export) can live
// outside the TSX file and satisfy the react-refresh "only export
// components" rule. The Context object is consumed by `state.tsx`'s
// `AppStateProvider` and by every `useAppState` caller via this module.

import { createContext, useContext, type Dispatch } from 'react';
import type { Action, AppState } from './state.types';

export const AppStateContext = createContext<{
  state: AppState;
  dispatch: Dispatch<Action>;
} | null>(null);

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState outside provider');
  return ctx;
}
