// Minimal preload: a single channel-allowlisted invoke + event bridge.
// Per-channel typing is enforced in shared/router-shape.ts; this layer enforces
// a runtime allowlist so a compromised renderer cannot invoke arbitrary IPC
// channels (e.g. `git.runCommand` with attacker-controlled cwd).

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { isAllowedChannel, isAllowedEvent } from '../src/shared/rpc-channels';

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
};

contextBridge.exposeInMainWorld('sigma', api);

export type SigmaPreloadApi = typeof api;
