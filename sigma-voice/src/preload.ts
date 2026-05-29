// SigmaVoice — preload script
//
// Exposes a minimal, typed API to the settings renderer via contextBridge.
// All IPC channels are prefixed `bv:` to avoid collision with SigmaLink.

import { contextBridge, ipcRenderer } from 'electron';

interface DictionaryEntry {
  pattern: string;
  replacement: string;
  type: 'phrase' | 'macro';
}

contextBridge.exposeInMainWorld('bridgeVoice', {
  getStatus: () => ipcRenderer.invoke('bv:getStatus'),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke('bv:setEnabled', enabled),
  setHotkey: (hotkey: string) => ipcRenderer.invoke('bv:setHotkey', hotkey),
  setMode: (mode: 'toggle' | 'push-to-talk') => ipcRenderer.invoke('bv:setMode', mode),
  setModelId: (id: string) => ipcRenderer.invoke('bv:setModelId', id),
  startRecording: () => ipcRenderer.invoke('bv:startRecording'),
  stopAndTranscribe: () => ipcRenderer.invoke('bv:stopAndTranscribe'),
  getDictionary: () => ipcRenderer.invoke('bv:getDictionary'),
  setDictionary: (entries: DictionaryEntry[]) => ipcRenderer.invoke('bv:setDictionary', entries),
  getStats: () => ipcRenderer.invoke('bv:getStats'),
  listModels: () => ipcRenderer.invoke('bv:listModels'),
  downloadModel: (id: string) => ipcRenderer.invoke('bv:downloadModel', id),
  abortDownload: (id: string) => ipcRenderer.invoke('bv:abortDownload', id),
  onModelDownload: (cb: (p: unknown) => void) => {
    ipcRenderer.on('voice:model-download', (_e, p) => cb(p));
  },
  onStateChange: (cb: (status: unknown) => void) => {
    ipcRenderer.on('voice:global-capture-state', (_e, status) => cb(status));
  },
  onToast: (cb: (msg: { message: string; level: string }) => void) => {
    ipcRenderer.on('voice:global-capture-toast', (_e, msg) => cb(msg));
  },
});
