// Minimal preload: a single channel-allowlisted invoke + event bridge.
// Per-channel typing is enforced in shared/router-shape.ts; this layer enforces
// a runtime allowlist so a compromised renderer cannot invoke arbitrary IPC
// channels (e.g. `git.runCommand` with attacker-controlled cwd).

import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron';
import { release } from 'node:os';
import { isAllowedChannel, isAllowedEvent } from '../src/shared/rpc-channels';

// Windows ConPTY build number (e.g. 26100 on Win11 24H2), parsed once at
// preload time from `os.release()` ("10.0.26100"). `undefined` off-Windows or
// when unparseable. Consumed by `src/renderer/lib/platform.ts` to configure
// xterm's `windowsPty` reflow heuristics without an IPC round-trip.
const WINDOWS_OS_BUILD: number | undefined =
  process.platform === 'win32' ? Number(release().split('.')[2]) || undefined : undefined;

// Multi-window (2026-06-12) — window identity injected by main via
// webPreferences.additionalArguments. Absent args = legacy single window.
function argValue(prefix: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
const windowContext = {
  windowId: (() => {
    const v = argValue('--sigma-window-id=');
    const n = v ? Number(v) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  })(),
  isMain: argValue('--sigma-window-main=') !== '0',
  workspaceScope: argValue('--sigma-workspace-scope=') || null,
};

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (typeof channel !== 'string' || !isAllowedChannel(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  eventOn: (event: string, cb: (payload: unknown) => void): (() => void) => {
    if (typeof event !== 'string' || !isAllowedEvent(event)) {
      // Return a noop unsubscribe; refusing silently keeps existing renderer
      // teardown code simple while still preventing arbitrary subscriptions.
      return () => undefined;
    }
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
  eventSend: (event: string, payload: unknown): void => {
    if (typeof event !== 'string' || !isAllowedEvent(event)) return;
    ipcRenderer.send(event, payload);
  },
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  // Static `process.platform` snapshot baked into the preload bundle at build
  // time. The renderer cannot read `process.platform` itself because
  // contextIsolation strips Node globals; exposing it here avoids a round-trip
  // IPC for what is, by definition, a constant for the lifetime of the
  // process. Consumed by `src/renderer/lib/platform.ts`.
  platform: process.platform as NodeJS.Platform,
  // Windows ConPTY build number (see WINDOWS_OS_BUILD above). `undefined`
  // off-Windows. Lets the renderer pick the correct xterm `windowsPty` reflow
  // behavior for the host's ConPTY generation.
  osBuild: WINDOWS_OS_BUILD,
  // Renderer-side native zoom. webFrame is a renderer-process module; exposing
  // get/set here lets the renderer drive whole-window zoom (React DOM + xterm
  // canvas + Monaco) with no per-event IPC round-trip. factor 1.0 = 100%.
  getZoomFactor: (): number => webFrame.getZoomFactor(),
  setZoomFactor: (factor: number): void => {
    webFrame.setZoomFactor(factor);
  },
  windowContext,
};

contextBridge.exposeInMainWorld('sigma', api);

export type SigmaPreloadApi = typeof api;
