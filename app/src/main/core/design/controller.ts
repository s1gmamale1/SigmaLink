// V3-W14-001..006 — Sigma Canvas RPC controller. Owns the `design.*`
// namespace. Orchestrates the picker overlay (W14-001), asset staging
// (W14-004), HMR poke (W14-005), and canvas DAO + dispatch fan-out
// (W14-002/003/006). The dispatcher translates a `design.dispatch` call into
// a per-provider `executeLaunchPlan` so each picked provider gets its own
// isolated worktree + PTY.

import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { defineController } from '../../../shared/rpc';
import type { BrowserManagerRegistry } from '../browser/manager';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import type { LaunchPlan } from '../../../shared/types';
import { getDb } from '../db/client';
import { canvases, canvasDispatches, workspaces as workspacesTable } from '../db/schema';
import { executeLaunchPlan } from '../workspaces/launcher';
import { DesignPickerRuntime, type PickerSession } from './picker';
import { DesignStaging } from './staging';
import { HmrPoke } from './hmr-poke';

export interface DesignControllerDeps {
  browserRegistry: BrowserManagerRegistry;
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  userDataDir: string;
  emit: (event: string, payload: unknown) => void;
}

interface CanvasShape {
  id: string;
  workspaceId: string;
  title: string;
  lastProviders: string[];
  createdAt: number;
}

const DEFAULT_PROVIDERS: string[] = ['claude'];
// v1.2.4: provider registry trimmed to the 5 shipping CLIs. `shell` and
// `custom` stay as internal-only sentinels for the workspace launcher's
// skip-agents / custom-command paths.
// prettier-ignore
const VALID_PROVIDERS = new Set(['claude','codex','gemini','kimi','opencode','shell','custom']);

function normalizeProviders(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const p of input) {
    if (typeof p !== 'string') continue;
    const id = p.trim().toLowerCase();
    if (!id || !VALID_PROVIDERS.has(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function rowToCanvas(row: {
  id: string;
  workspaceId: string;
  title: string;
  lastProviders: string;
  createdAt: number;
}): CanvasShape {
  let providers: string[] = [];
  try {
    const parsed = JSON.parse(row.lastProviders) as unknown;
    providers = normalizeProviders(parsed);
  } catch {
    /* malformed json — drop silently */
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    lastProviders: providers,
    createdAt: row.createdAt,
  };
}

export function buildDesignController(deps: DesignControllerDeps) {
  const picker = new DesignPickerRuntime({
    capture: (s) => emitCapture(s),
    state: (active, workspaceId, tabId) =>
      deps.emit('design:picker-state', { workspaceId, tabId, active }),
  });
  const staging = new DesignStaging({ userDataDir: deps.userDataDir });
  const hmr = new HmrPoke({
    browserRegistry: deps.browserRegistry,
    emit: {
      patchApplied: (p) => deps.emit('design:patch-applied', p),
    },
  });

  function emitCapture(s: PickerSession): void {
    deps.emit('design:capture', {
      pickerToken: s.token,
      workspaceId: s.workspaceId,
      tabId: s.tabId,
      selector: s.selector,
      outerHTML: s.outerHTML,
      computedStyles: s.computedStyles,
      screenshotPng: s.screenshotPng,
      pageUrl: s.pageUrl,
    });
  }

  function getCanvas(canvasId: string): CanvasShape | null {
    const row = getDb()
      .select()
      .from(canvases)
      .where(eq(canvases.id, canvasId))
      .get();
    return row ? rowToCanvas(row) : null;
  }

  function ensureWorkspace(workspaceId: string): { rootPath: string } {
    const ws = getDb()
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.id, workspaceId))
      .get();
    if (!ws) throw new Error(`design: workspace not found: ${workspaceId}`);
    return { rootPath: ws.rootPath };
  }

  async function pickerView(workspaceId: string, tabId: string) {
    const reg = deps.browserRegistry;
    if (!reg.has(workspaceId)) {
      throw new Error(`design: no browser manager for workspace: ${workspaceId}`);
    }
    const mgr = reg.get(workspaceId);
    const tab = mgr.listTabs().find((t) => t.id === tabId);
    if (!tab) throw new Error(`design: tab not found: ${tabId}`);
    const view = await mgr.getViewForTab(tabId);
    if (!view) {
      throw new Error(`design: tab view not initialized: ${tabId}`);
    }
    return view;
  }

  const ctl = defineController({
    // ─────────────────────────────────────────── element picker ──

    startPick: async (input: {
      workspaceId: string;
      tabId: string;
    }): Promise<{ pickerToken: string }> => {
      if (!input?.workspaceId || !input?.tabId) {
        throw new Error('design.startPick: workspaceId and tabId required');
      }
      const view = await pickerView(input.workspaceId, input.tabId);
      return picker.start({ workspaceId: input.workspaceId, tabId: input.tabId, view });
    },

    stopPick: async (input: { workspaceId: string; tabId: string }): Promise<void> => {
      if (!input?.tabId) return;
      picker.stop(input.tabId);
    },

    /** Legacy single-shot capture for the W12 stub. Returns the LAST captured
     *  selection, or throws when picker is off. The renderer prefers the
     *  `design:capture` event stream — this is only kept for backwards
     *  compatibility with the W12 placeholder schema. */
    captureElement: async (): Promise<{
      pickerToken: string;
      selector: string;
      outerHTML: string;
      computedStyles: Record<string, string>;
      screenshotPng: string;
    }> => {
      throw new Error(
        'design.captureElement: use design.startPick + design:capture event stream',
      );
    },

    // ─────────────────────────────────────────── staging ──

    attachFile: async (input: {
      canvasId: string;
      filePath?: string;
      bytesBase64?: string;
      filename?: string;
    }): Promise<{ stagingPath: string }> => {
      return staging.attach(input);
    },

    // ─────────────────────────────────────────── canvases CRUD ──

    listCanvases: async (input: { workspaceId: string }): Promise<CanvasShape[]> => {
      if (!input?.workspaceId) throw new Error('design.listCanvases: workspaceId required');
      const rows = getDb()
        .select()
        .from(canvases)
        .where(eq(canvases.workspaceId, input.workspaceId))
        .all();
      return rows
        .map(rowToCanvas)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    createCanvas: async (input: {
      workspaceId: string;
      title?: string;
      lastProviders?: string[];
    }): Promise<CanvasShape> => {
      if (!input?.workspaceId) throw new Error('design.createCanvas: workspaceId required');
      ensureWorkspace(input.workspaceId);
      const id = randomUUID();
      const title = (input.title || 'Untitled Canvas').slice(0, 200);
      const providers = normalizeProviders(input.lastProviders ?? DEFAULT_PROVIDERS);
      const createdAt = Date.now();
      getDb()
        .insert(canvases)
        .values({
          id,
          workspaceId: input.workspaceId,
          title,
          lastProviders: JSON.stringify(providers.length ? providers : DEFAULT_PROVIDERS),
          createdAt,
        })
        .run();
      // Seed the staging directory so the renderer's first drag-and-drop has
      // a valid landing zone without a round-trip.
      staging.ensureCanvasDir(id);
      return {
        id,
        workspaceId: input.workspaceId,
        title,
        lastProviders: providers.length ? providers : DEFAULT_PROVIDERS,
        createdAt,
      };
    },

    openCanvas: async (input: {
      canvasId: string;
      lastProviders?: string[];
    }): Promise<void> => {
      if (!input?.canvasId) throw new Error('design.openCanvas: canvasId required');
      const cv = getCanvas(input.canvasId);
      if (!cv) throw new Error(`design.openCanvas: canvas not found: ${input.canvasId}`);
      // Touch lastProviders if the renderer surfaced a fresh selection.
      if (Array.isArray(input.lastProviders)) {
        const providers = normalizeProviders(input.lastProviders);
        getDb()
          .update(canvases)
          .set({
            lastProviders: JSON.stringify(providers.length ? providers : DEFAULT_PROVIDERS),
          })
          .where(eq(canvases.id, input.canvasId))
          .run();
      }
    },

    // ─────────────────────────────────────────── dispatch ──

    dispatch: async (input: {
      pickerToken: string;
      prompt: string;
      providers: string[];
      modifiers?: { shift?: boolean; alt?: boolean };
      attachments?: string[];
      canvasId?: string;
      workspaceId?: string;
    }): Promise<{ dispatched: number; sessionIds: string[] }> => {
      if (!input?.prompt || typeof input.prompt !== 'string') {
        throw new Error('design.dispatch: prompt required');
      }
      const providers = normalizeProviders(input.providers);
      if (providers.length === 0) {
        throw new Error('design.dispatch: at least one provider required');
      }

      // Resolve workspace from token (preferred) or canvas id (fallback).
      let workspaceId = input.workspaceId ?? null;
      if (!workspaceId && input.pickerToken) {
        workspaceId = picker.getSessionByToken(input.pickerToken)?.workspaceId ?? null;
      }
      if (!workspaceId && input.canvasId) {
        const cv = getCanvas(input.canvasId);
        workspaceId = cv?.workspaceId ?? null;
      }
      if (!workspaceId) {
        throw new Error('design.dispatch: workspace cannot be resolved (no token / canvasId)');
      }
      const ws = ensureWorkspace(workspaceId);

      const attachments = Array.isArray(input.attachments)
        ? input.attachments.filter((p): p is string => typeof p === 'string' && p.length > 0)
        : [];
      const promptBody = composePrompt(input.prompt, attachments);

      const plan: LaunchPlan = {
        workspaceRoot: ws.rootPath,
        preset: providers.length <= 1 ? 1 : providers.length <= 2 ? 2 : 4,
        panes: providers.map((providerId, paneIndex) => ({
          paneIndex,
          providerId,
          initialPrompt: promptBody,
        })),
      };

      const out = await executeLaunchPlan(plan, {
        pty: deps.pty,
        worktreePool: deps.worktreePool,
      });
      const sessionIds = out.sessions
        .filter((s) => s.status !== 'error')
        .map((s) => s.id);

      // Persist into history when a canvas is in the loop. Token-only
      // dispatches skip the history table — the assistant.dispatchPane echo
      // is sufficient for ad-hoc captures.
      if (input.canvasId) {
        try {
          getDb()
            .insert(canvasDispatches)
            .values({
              id: randomUUID(),
              canvasId: input.canvasId,
              prompt: promptBody,
              providers: JSON.stringify(providers),
              ts: Date.now(),
            })
            .run();
          // Mirror the providers selection back onto the canvas row.
          getDb()
            .update(canvases)
            .set({ lastProviders: JSON.stringify(providers) })
            .where(eq(canvases.id, input.canvasId))
            .run();
        } catch {
          /* non-fatal: dispatch fan-out already succeeded */
        }
      }

      return { dispatched: sessionIds.length, sessionIds };
    },

    history: async (input: { canvasId: string }) => {
      if (!input?.canvasId) throw new Error('design.history: canvasId required');
      const rows = getDb()
        .select()
        .from(canvasDispatches)
        .where(eq(canvasDispatches.canvasId, input.canvasId))
        .orderBy(desc(canvasDispatches.ts))
        .all();
      return rows.map((r) => {
        let providers: string[] = [];
        try {
          providers = normalizeProviders(JSON.parse(r.providers));
        } catch {
          /* drop */
        }
        return {
          id: r.id,
          canvasId: r.canvasId,
          prompt: r.prompt,
          providers,
          ts: r.ts,
        };
      });
    },

    // ─────────────────────────────────────────── HMR poke ──

    setDevServerRoots: async (input: {
      workspaceId: string;
      roots: string[];
    }): Promise<void> => {
      if (!input?.workspaceId) throw new Error('design.setDevServerRoots: workspaceId required');
      const roots = Array.isArray(input.roots)
        ? input.roots.filter((r): r is string => typeof r === 'string')
        : [];
      hmr.setRoots(input.workspaceId, roots);
    },

    reloadTab: async (input: { workspaceId: string; tabId: string }): Promise<void> => {
      if (!input?.workspaceId || !input?.tabId) return;
      await hmr.reloadTab(input.workspaceId, input.tabId);
    },
  });

  // Tear down picker + watches when rpc-router.shutdownRouter is invoked.
  (ctl as unknown as { shutdown: () => void }).shutdown = () => {
    picker.stopAll();
    hmr.shutdown();
  };

  return ctl;
}

function composePrompt(prompt: string, attachments: string[]): string {
  if (attachments.length === 0) return prompt;
  const attachLines = attachments.map((p) => `  - ${p}`).join('\n');
  return `${prompt}\n\nAttached assets:\n${attachLines}`;
}
