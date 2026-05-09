// Typed pub/sub events that flow main -> renderer.
// One ipcMain.send / ipcRenderer.on per topic; in-process fan-out via Set<callback>.

export type EventMap = {
  'pty:data': { sessionId: string; data: string };
  'pty:exit': { sessionId: string; exitCode: number; signal?: number };
  'workspace:launched': { workspaceId: string };
  'swarm:message': { swarmId: string; from: string; to: string; body: string; ts: number };
  'memory:changed': { id: string; kind: 'create' | 'update' | 'delete' };
  'browser:state': { tabId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean };
};

export type EventName = keyof EventMap;
export type EventPayload<E extends EventName> = EventMap[E];
export type Listener<E extends EventName> = (payload: EventPayload<E>) => void;
