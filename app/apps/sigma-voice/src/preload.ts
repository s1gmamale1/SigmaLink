// SigmaVoice — preload script
//
// Exposes a minimal, typed API to the settings renderer via contextBridge.
// All IPC channels are prefixed `bv:` to avoid collision with SigmaLink.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bridgeVoice', {
  getStatus: () => ipcRenderer.invoke('bv:getStatus'),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke('bv:setEnabled', enabled),
  setHotkey: (hotkey: string) => ipcRenderer.invoke('bv:setHotkey', hotkey),
  setModelId: (id: string) => ipcRenderer.invoke('bv:setModelId', id),
  startRecording: () => ipcRenderer.invoke('bv:startRecording'),
  stopAndTranscribe: () => ipcRenderer.invoke('bv:stopAndTranscribe'),
  onStateChange: (cb: (status: unknown) => void) => {
    ipcRenderer.on('voice:global-capture-state', (_e, status) => cb(status));
  },
  onToast: (cb: (msg: { message: string; level: string }) => void) => {
    ipcRenderer.on('voice:global-capture-toast', (_e, msg) => cb(msg));
  },
});
