// SigmaVoice — HUD overlay preload.
//
// Minimal, isolated bridge for the recording-HUD renderer (renderer/hud.html).
// Exposes only a one-way state subscription; the HUD never talks back.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sigmaHud', {
  onState: (cb: (payload: { state: 'recording' | 'transcribing' }) => void) => {
    ipcRenderer.on('hud:state', (_e, payload) => cb(payload));
  },
});
