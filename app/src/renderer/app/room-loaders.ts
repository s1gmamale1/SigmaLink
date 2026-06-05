// FE-4 — single source of truth for the lazy room import factories.
//
// Each entry is the dynamic-import factory for a code-split room module,
// normalized to the `{ default }` shape `React.lazy` expects (the rooms use
// named exports). App.tsx consumes this map twice:
//   1. `lazy(ROOM_LOADERS[id])` to mount the room on demand, and
//   2. an idle-time prefetch loop that warms every room chunk after first
//      paint, so navigating to a room the user hasn't visited yet skips even
//      the Suspense spinner (the chunk is already in the module cache).
//
// `command` is intentionally absent — CommandRoom is eager (the default
// landing room), so it ships in the main chunk and never needs prefetching.

import type { ComponentType } from 'react';
import type { RoomId } from './state.types';

// A lazily-importable room: a factory returning a module whose default export
// is a React component. The props are intentionally `any` here because the
// rooms have heterogeneous prop shapes; App.tsx applies the precise type at
// each `lazy()` call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RoomImport = () => Promise<{ default: ComponentType<any> }>;

// Every lazy room. `command` is eager and deliberately omitted.
export const ROOM_LOADERS: Partial<Record<RoomId, RoomImport>> = {
  workspaces: () =>
    import('@/renderer/features/workspace-launcher/Launcher').then((m) => ({
      default: m.WorkspaceLauncher,
    })),
  swarm: () =>
    import('@/renderer/features/swarm-room/SwarmRoom').then((m) => ({
      default: m.SwarmRoom,
    })),
  operator: () =>
    import('@/renderer/features/operator-console').then((m) => ({
      default: m.OperatorConsole,
    })),
  browser: () =>
    import('@/renderer/features/browser/BrowserRoom').then((m) => ({
      default: m.BrowserRoom,
    })),
  skills: () =>
    import('@/renderer/features/skills/SkillsRoom').then((m) => ({
      default: m.SkillsRoom,
    })),
  memory: () =>
    import('@/renderer/features/memory/MemoryRoom').then((m) => ({
      default: m.MemoryRoom,
    })),
  review: () =>
    import('@/renderer/features/review/ReviewRoom').then((m) => ({
      default: m.ReviewRoom,
    })),
  tasks: () =>
    import('@/renderer/features/tasks/TasksRoom').then((m) => ({
      default: m.TasksRoom,
    })),
  settings: () =>
    import('@/renderer/features/settings/SettingsRoom').then((m) => ({
      default: m.SettingsRoom,
    })),
  jorvis: () =>
    import('@/renderer/features/jorvis-assistant/JorvisRoom').then((m) => ({
      default: m.JorvisRoom,
    })),
  // C-12 SigmaBench — multi-agent conflict benchmark room.
  sigmabench: () =>
    import('@/renderer/features/sigmabench-room/SigmaBenchRoom').then((m) => ({
      default: m.SigmaBenchRoom,
    })),
  // BSP-G2 — repo-level Git panel (Changes, History, Branches).
  git: () =>
    import('@/renderer/features/git/GitRoom').then((m) => ({
      default: m.GitRoom,
    })),
};

/**
 * Prefetch every lazy room chunk during browser idle time. Called once after
 * the app mounts: it warms the module cache so the first navigation to any
 * room renders instantly (no Suspense spinner). Uses `requestIdleCallback`
 * where available and falls back to a `setTimeout` so it never competes with
 * first paint or user input. Returns a cleanup function that cancels the
 * pending idle/timeout callback.
 *
 * Errors are swallowed — a failed prefetch is harmless (the real `lazy()`
 * import will retry and surface any genuine error to the Suspense boundary).
 */
export function prefetchRooms(): () => void {
  const warm = () => {
    for (const load of Object.values(ROOM_LOADERS)) {
      // Fire and forget; ignore rejections (offline, transient).
      void load?.().catch(() => undefined);
    }
  };

  const ric = (
    globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    }
  ).requestIdleCallback;

  if (typeof ric === 'function') {
    const handle = ric(warm, { timeout: 2000 });
    return () => {
      (
        globalThis as unknown as { cancelIdleCallback?: (h: number) => void }
      ).cancelIdleCallback?.(handle);
    };
  }

  // Fallback: defer past first paint without blocking it.
  const timer = setTimeout(warm, 1500);
  return () => clearTimeout(timer);
}
