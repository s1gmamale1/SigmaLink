// src/main/core/control/control-rpc.ts
//
// Operator-facing RPC for the External Control MCP surface: enable/disable,
// freeze (kill-switch), rotate token, the copyable `claude mcp add` command,
// and the escalation response path. All effect via injected deps (no electron
// import) -> unit-testable.

import {
  isControlEnabled,
  isControlFrozen,
  setControlEnabled,
  setControlFrozen,
  rotateBearerToken,
  getBearerToken,
  type KvLike,
  type CredentialStoreLike,
} from './control-config';

export interface ControlRpcDeps {
  kv: KvLike;
  credentials: CredentialStoreLike;
  socketPath: string;
  /** Binary the emitted connect command runs the server entry with. In a
   *  packaged build this is `process.execPath` — i.e. the bundled Electron —
   *  which the command pairs with `ELECTRON_RUN_AS_NODE=1`. Plain `node`
   *  would MODULE_NOT_FOUND because `serverEntry` lives inside `app.asar`
   *  and only Electron's patched fs can read an asar archive. */
  execPath: string;
  serverEntry: string;
  start: () => Promise<void>;
  stop: () => void;
  liveConnections: () => number;
  setBearer: (token: string) => void;
  respondEscalation: (id: string, approved: boolean) => void;
  /** Deny + clear every in-flight escalation (kill-switch authority over pending approvals). */
  cancelEscalations: () => void;
  reportViewport: (patch: import('./app-state-shadow').ViewportPatch) => void;
}

export interface ControlStatus {
  enabled: boolean;
  frozen: boolean;
  liveConnections: number;
  socketPath: string;
  connectCommand: string;
}

/**
 * The operator-copyable `claude mcp add` line.
 *
 * Runs `execPath` (the bundled Electron) rather than `node`, with
 * `ELECTRON_RUN_AS_NODE=1` so it behaves as a plain node interpreter — the
 * same trick as `MemoryMcpSupervisor.getCommandFor` and
 * `writeJorvisHostMcpConfig`. Required because `asar: true` puts
 * `serverEntry` inside `app.asar`, which only Electron's patched fs reads.
 */
function buildConnectCommand(
  socketPath: string,
  execPath: string,
  serverEntry: string,
  token: string | null,
): string {
  const t = token ?? '<token-unavailable>';
  return `claude mcp add sigmalink -e ELECTRON_RUN_AS_NODE=1 -e SIGMA_CONTROL_SOCKET='${socketPath}' -e SIGMA_CONTROL_TOKEN='${t}' -e SIGMA_CONTROL_LABEL='external' -- '${execPath}' '${serverEntry}'`;
}

export function buildControlController(deps: ControlRpcDeps) {
  const statusOf = async (): Promise<ControlStatus> => ({
    enabled: isControlEnabled(deps.kv),
    frozen: isControlFrozen(deps.kv),
    liveConnections: deps.liveConnections(),
    socketPath: deps.socketPath,
    connectCommand: buildConnectCommand(deps.socketPath, deps.execPath, deps.serverEntry, await getBearerToken(deps.credentials)),
  });
  return {
    status: async (): Promise<ControlStatus> => statusOf(),
    enable: async (): Promise<ControlStatus> => { setControlEnabled(deps.kv, true); await deps.start().catch(() => {}); return statusOf(); },
    // disable + freeze are kill-switch paths: cancel in-flight escalations so a
    // dangerous action already awaiting confirmation can't still resolve after the
    // operator pulls the switch (stop() destroys sockets but leaves pending intact).
    disable: async (): Promise<ControlStatus> => { setControlEnabled(deps.kv, false); deps.cancelEscalations(); deps.stop(); return statusOf(); },
    freeze: async (): Promise<ControlStatus> => { setControlFrozen(deps.kv, true); deps.cancelEscalations(); return statusOf(); },
    unfreeze: async (): Promise<ControlStatus> => { setControlFrozen(deps.kv, false); return statusOf(); },
    rotateToken: async (): Promise<ControlStatus> => { const t = await rotateBearerToken(deps.credentials); deps.setBearer(t); return statusOf(); },
    connectCommand: async (): Promise<{ command: string }> => ({ command: buildConnectCommand(deps.socketPath, deps.execPath, deps.serverEntry, await getBearerToken(deps.credentials)) }),
    respondEscalation: async (input: { id: string; approved: boolean }): Promise<{ ok: boolean }> => { deps.respondEscalation(input.id, input.approved); return { ok: true }; },
    reportViewport: async (patch: import('./app-state-shadow').ViewportPatch): Promise<{ ok: boolean }> => {
      deps.reportViewport(patch); return { ok: true };
    },
  };
}
