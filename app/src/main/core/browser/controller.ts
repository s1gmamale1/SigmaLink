// Browser RPC controller. Wraps `BrowserManagerRegistry` for the renderer.
//
// Every method takes a `workspaceId` and routes to the per-workspace manager.
// MCP-driven agent calls are NOT routed through this controller — they go
// over the Playwright MCP HTTP server. The only agent-facing method here is
// `claimDriver`/`releaseDriver`, which the in-app UI uses to surface lock
// state. Future work can expose a CDP-bridge over MCP that flips the lock
// from the agent side, but v1 keeps this read-write at the renderer.

import { defineController } from '../../../shared/rpc';
import type { BrowserState, BrowserTab } from '../../../shared/types';
import type { BrowserManagerRegistry } from './manager';

export interface BrowserControllerDeps {
  registry: BrowserManagerRegistry;
}

export function buildBrowserController(deps: BrowserControllerDeps) {
  const reg = deps.registry;

  return defineController({
    openTab: async (input: { workspaceId: string; url?: string }): Promise<BrowserTab> => {
      return reg.get(input.workspaceId).openTab(input.url);
    },
    closeTab: async (input: { workspaceId: string; tabId: string }): Promise<void> => {
      reg.get(input.workspaceId).closeTab(input.tabId);
    },
    navigate: async (input: { workspaceId: string; tabId: string; url: string }): Promise<void> => {
      await reg.get(input.workspaceId).navigate(input.tabId, input.url);
    },
    back: async (input: { workspaceId: string; tabId: string }): Promise<void> => {
      await reg.get(input.workspaceId).back(input.tabId);
    },
    forward: async (input: { workspaceId: string; tabId: string }): Promise<void> => {
      await reg.get(input.workspaceId).forward(input.tabId);
    },
    reload: async (input: { workspaceId: string; tabId: string }): Promise<void> => {
      await reg.get(input.workspaceId).reload(input.tabId);
    },
    stop: async (input: { workspaceId: string; tabId: string }): Promise<void> => {
      await reg.get(input.workspaceId).stop(input.tabId);
    },
    listTabs: async (workspaceId: string): Promise<BrowserTab[]> => {
      return reg.get(workspaceId).listTabs();
    },
    getActiveTab: async (workspaceId: string): Promise<BrowserTab | null> => {
      return reg.get(workspaceId).getActiveTab();
    },
    setActiveTab: async (input: { workspaceId: string; tabId: string }): Promise<void> => {
      await reg.get(input.workspaceId).setActiveTab(input.tabId);
    },
    setBounds: async (input: {
      workspaceId: string;
      bounds: { x: number; y: number; width: number; height: number } | null;
    }): Promise<void> => {
      reg.get(input.workspaceId).setBounds(input.bounds);
    },
    getState: async (workspaceId: string): Promise<BrowserState> => {
      return reg.get(workspaceId).getState();
    },
    claimDriver: async (input: {
      workspaceId: string;
      agentKey: string;
      label?: string;
    }): Promise<void> => {
      reg.get(input.workspaceId).claimDriver(input.agentKey, input.label);
    },
    releaseDriver: async (input: { workspaceId: string }): Promise<void> => {
      reg.get(input.workspaceId).releaseDriver();
    },

    teardown: async (workspaceId: string): Promise<void> => {
      reg.teardown(workspaceId);
    },
  });
}
