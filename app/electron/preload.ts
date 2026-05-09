// Minimal preload: a single generic invoke + event bridge.
// Per-channel typing is enforced in shared/router-shape.ts; this layer is dumb.

import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  eventOn: (event: string, cb: (payload: unknown) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
  eventSend: (event: string, payload: unknown): void => {
    ipcRenderer.send(event, payload);
  },
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('sigma', api);

export type SigmaPreloadApi = typeof api;
