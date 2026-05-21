// v1.5.1-A — PaneShell extracted from CommandRoom.tsx.
// v1.7.1 W-5 Phase 2 — Skill drop target + binding chip strip.
// W-4 Phase 4 — Cmd+T / Ctrl+Shift+T ephemeral scratch-shell sub-tabs.
//
// Renders a single pane cell: PaneHeader strip on top, then a drag-aware body
// (with ring-2 visual + 200 ms flash on drop) that hosts PaneSplash,
// SessionTerminal, PaneFooter, and (Phase 2) a skill-chip strip.
//
// INVARIANT (W-4 Phase 4): with zero scratch sub-tabs the pane body renders
// EXACTLY as before — the tab strip is hidden and no extra DOM nodes appear.
//
// Previously this was the inline `PaneCell` function in CommandRoom.tsx.
// Extracted to keep CommandRoom.tsx under 500 LOC (v1.5.1-A caveat 1).

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { FolderOpen, RotateCw, Square, Terminal as TerminalIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { rpc } from '@/renderer/lib/rpc';
import { SessionTerminal } from './Terminal';
import { PaneHeader } from './PaneHeader';
import { PaneSplash } from './PaneSplash';
import { PaneFooter } from './PaneFooter';
import { insertMention } from './insertMention';
import { insertSkillCommand, isSlashCapableProvider } from './insertSkillCommand';
import { pathRelative } from '@/renderer/lib/path-relative';
import type { AgentSession } from '@/shared/types';
import { SKILL_DRAG_MIME, type SkillDragPayload } from '@/renderer/features/skills/SkillsTab';
import { SkillBindingChip, type SkillBinding } from '@/renderer/features/skills/SkillBindingChip';
import { PaneTabStrip, type ScratchTab } from './PaneTabStrip';

// v1.4.8 — Max number of files allowed in a single Finder multi-drop.
const MAX_DROP_FILES = 10;

export function PaneShell({
  session,
  paneIndex,
  providers,
  workspaceRootPath,
  onFocus,
  onRemove,
  onStop,
  onSplit,
  onToggleMinimise,
  isFullscreen,
  onToggleFullscreen,
  /**
   * v1.4.3 #06 — When the pane is in a split group, the Split-H/V icons are
   * disabled (max 2-level deep in v1.4.x). The CommandRoom passes this true
   * for sub-panes via `SplitGroupCell`. Defaults to false for the standalone
   * pane case.
   */
  inSplitGroup = false,
  // v1.7.1 W-5 Phase 2 — INFORMATIONAL skill binding chips for this pane.
  skillBindings = [],
  onSkillDrop,
  onSkillDetach,
  // v1.13.2 — Relaunch affordance for a crashed pane (status:'error' with a
  // numeric exitCode). When omitted the crash banner shows no Relaunch button.
  onRelaunch,
}: {
  session: AgentSession;
  paneIndex: number;
  providers: { id: string; name: string }[];
  /** v1.4.8 — workspace root used to compute relative paths for Finder drops. */
  workspaceRootPath: string;
  onFocus: () => void;
  onRemove: () => void;
  onStop: () => void;
  onSplit: (direction: 'horizontal' | 'vertical', providerId: string) => void;
  onToggleMinimise: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  inSplitGroup?: boolean;
  /**
   * v1.13.2 — Called when the user clicks "Relaunch" on a crashed pane. The
   * parent (CommandRoom) re-adds an agent of the same provider to the swarm
   * and removes the crashed session. Optional — split sub-panes omit it.
   */
  onRelaunch?: () => void;
  /**
   * v1.7.1 W-5 Phase 2 — INFORMATIONAL bindings for this pane session.
   * These are purely visual chips; no behavioral activation.
   */
  skillBindings?: SkillBinding[];
  /** Called when a skill is dropped on this pane. */
  onSkillDrop?: (skillName: string, skillSource: string) => void;
  /** Called when a chip's X button is clicked. */
  onSkillDetach?: (bindingId: string) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [flashDrop, setFlashDrop] = useState(false);

  // W-4 Phase 4 — Ephemeral scratch-shell sub-tabs.
  // scratchTabs: ordered list of open scratch PTY ids.
  // activeTabId: either session.id (main) or a scratchId.
  // INVARIANT: with zero scratch tabs, no tab-strip renders and the pane body
  // is byte-for-byte identical to the pre-Phase-4 render.
  const [scratchTabs, setScratchTabs] = useState<ScratchTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>(session.id);
  // Ref used by the keydown handler to check if THIS pane container is focused.
  const paneContainerRef = useRef<HTMLDivElement>(null);

  // Keep activeTabId in sync if the session id changes (shouldn't in normal
  // use, but guard against stale closure).
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // Spawn a scratch shell PTY and add its tab.
  const spawnScratch = useCallback(async () => {
    const cwd = session.worktreePath ?? '.';
    try {
      const result = await rpc.pty.spawnScratch({ cwd });
      setScratchTabs((prev) => [...prev, { scratchId: result.scratchId }]);
      setActiveTabId(result.scratchId);
    } catch {
      // Silent — toast from the rpc layer if applicable.
    }
  }, [session.worktreePath]);

  // Close a scratch tab: kill the PTY and remove from state.
  const closeScratch = useCallback(async (scratchId: string) => {
    setScratchTabs((prev) => {
      const remaining = prev.filter((t) => t.scratchId !== scratchId);
      // Switch active tab if we're closing the active one.
      if (activeTabIdRef.current === scratchId) {
        const idx = prev.findIndex((t) => t.scratchId === scratchId);
        const next = remaining[idx] ?? remaining[idx - 1] ?? null;
        setActiveTabId(next ? next.scratchId : session.id);
      }
      return remaining;
    });
    try {
      await rpc.pty.killScratch({ scratchId });
    } catch {
      /* PTY may already be gone */
    }
  }, [session.id]);

  // Cmd+T (macOS) / Ctrl+Shift+T (other) — open a scratch tab when this pane
  // container (or any element inside it) holds keyboard focus.
  // Scope guard: only fires when the event target is INSIDE our container, so
  // pressing Cmd+T in a different pane does not spawn a tab here.
  useEffect(() => {
    const container = paneContainerRef.current;
    if (!container) return;

    function handleKeyDown(e: KeyboardEvent): void {
      // Check that the event originates inside THIS pane container.
      if (!container!.contains(e.target as Node)) return;

      // Cmd+T on macOS (Meta+t, no Ctrl, no Shift).
      // Ctrl+Shift+T elsewhere (key is 'T' uppercase or lowercase).
      const isCmdT = e.metaKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't';
      const isCtrlShiftT = !e.metaKey && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't';
      if (!isCmdT && !isCtrlShiftT) return;

      e.preventDefault();
      e.stopPropagation();
      void spawnScratch();
    }

    // Capture phase so we see the event before xterm's own keydown handlers
    // consume it (xterm calls e.preventDefault() on most keystrokes).
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [spawnScratch]);

  const errored = session.status === 'error';
  // v1.13.2 — distinguish the TWO error shapes a pane can land in:
  //   • launch failure (ENOENT / pre-flight): `session.error` string set at
  //     launch time. The PTY never started, so there is no scrollback. →
  //     "Failed to launch" full-screen surface.
  //   • runtime crash (pty:error → MARK_SESSION_ERROR): the PTY started then
  //     died, so a `session.error` string is NEVER set; `exitCode` may be a
  //     number (exit code) or undefined (signal-only death). → "Pane crashed"
  //     banner OVER the live scrollback, plus a Relaunch button.
  // The discriminator is the presence of `session.error`, NOT the exitCode —
  // a signal-only death has no exit code but is still a crash with scrollback.
  const crashed = errored && !session.error;
  const launchFailed = errored && !crashed;
  const exited = session.status === 'exited';
  const hasWorktree = !!session.worktreePath;

  // v1.4.8 — Accept drags from the IDE file-tree (custom MIME) or Finder (Files).
  // v1.7.1 W-5 Phase 2 — Also accept skill drags (INFORMATIONAL binding).
  function handleDragOver(e: DragEvent<HTMLDivElement>): void {
    const hasSigmaFile = e.dataTransfer.types.includes('application/sigmalink-file');
    const hasFiles = e.dataTransfer.types.includes('Files');
    const hasSkill = e.dataTransfer.types.includes(SKILL_DRAG_MIME);
    if (hasSigmaFile || hasFiles || hasSkill) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!isDragOver) setIsDragOver(true);
    }
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>): void {
    // Only clear when the pointer leaves the pane body entirely, not just a child.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragOver(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setIsDragOver(false);
    setFlashDrop(true);
    setTimeout(() => setFlashDrop(false), 200);

    // W-5 Phase 3 — skill drop: visual chip binding + slash-command injection.
    const skillRaw = e.dataTransfer.getData(SKILL_DRAG_MIME);
    if (skillRaw) {
      try {
        const payload = JSON.parse(skillRaw) as SkillDragPayload;
        if (payload.kind === 'skill' && payload.name) {
          if (isSlashCapableProvider(session.providerId)) {
            // Inject "/<skillName> " into the pane's input line. The user presses
            // Enter to invoke. Also create the chip binding as before.
            void insertSkillCommand(session.id, payload.name, session.status);
            if (onSkillDrop) onSkillDrop(payload.name, payload.source);
          } else {
            // Provider does not support slash-command injection — chip-only + toast.
            toast.warning(`Slash-command activation isn't supported for ${session.providerId}`, {
              description: 'The skill chip has been attached but will not be injected automatically.',
            });
            if (onSkillDrop) onSkillDrop(payload.name, payload.source);
          }
        }
      } catch {
        /* malformed payload — ignore */
      }
      return;
    }

    const sigmaRaw = e.dataTransfer.getData('application/sigmalink-file');
    if (sigmaRaw) {
      try {
        const payload = JSON.parse(sigmaRaw) as { absolutePath?: string; relativePath?: string };
        const path = payload.relativePath ?? payload.absolutePath ?? '';
        if (path) {
          void insertMention(session.id, path, session.status);
        }
      } catch {
        /* malformed payload — ignore */
      }
      return;
    }

    // Finder / external drop — use window.sigma.getPathForFile for each File.
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (files.length > MAX_DROP_FILES) {
      toast.warning(`Dropping ${files.length} files — capped at ${MAX_DROP_FILES}`, {
        description: 'Only the first 10 files were inserted.',
      });
    }
    const capped = files.slice(0, MAX_DROP_FILES);
    const paths: string[] = [];
    for (const file of capped) {
      const absPath = window.sigma.getPathForFile(file);
      if (!absPath) continue;
      const rel = pathRelative(absPath, workspaceRootPath);
      paths.push(rel);
    }
    if (paths.length === 0) return;
    const mention = paths.join(' @');
    void insertMention(session.id, mention, session.status);
  }

  function handleReveal() {
    if (!session.worktreePath) return;
    void rpc.app.revealInFolder(session.worktreePath).catch(() => undefined);
  }

  function handleOpenShell() {
    if (!session.worktreePath) return;
    void rpc.app.openShell(session.worktreePath)
      .then(() => toast.success('Terminal opened', { description: session.worktreePath! }))
      .catch((err) =>
        toast.error('Failed to open terminal', {
          description: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  // V1.1.4 Step 4 — Stop functionality lives in the right-click context menu
  // now that PaneStatusStrip is gone and the header only carries Close. The
  // ContextMenu wraps just the body so right-clicks on the header chrome
  // (with its own buttons) don't fight Radix for the event.
  //
  // v1.4.3 #06 — A minimised pane collapses to its header strip only (the
  // body is hidden via display:none). The SessionTerminal stays mounted so
  // the terminal-cache (v1.4.2 #03) preserves scrollback and the PTY keeps
  // emitting bytes — clicking the header restores the body view.
  const minimised = !!session.minimised;
  return (
    <div
      ref={paneContainerRef}
      className="sl-pane-enter flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <PaneHeader
        session={session}
        paneIndex={paneIndex}
        providers={providers}
        onFocus={onFocus}
        onClose={onRemove}
        onSplit={onSplit}
        onToggleMinimise={onToggleMinimise}
        canSplit={!inSplitGroup}
        isMinimised={minimised}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
      {/* v1.7.1 W-5 Phase 2 — INFORMATIONAL skill binding chips. Only render
          the strip when there are pane-scoped bindings for this session. */}
      {skillBindings.length > 0 && onSkillDetach ? (
        <div
          className="flex flex-wrap gap-1 border-b border-border/60 bg-card/60 px-2 py-1"
          data-testid="pane-skill-chips"
          aria-label="Attached skills (informational)"
        >
          {skillBindings.map((binding) => (
            <SkillBindingChip
              key={binding.id}
              binding={binding}
              onDetach={onSkillDetach}
            />
          ))}
        </div>
      ) : null}
      {/* W-4 Phase 4 — Scratch sub-tab strip. Hidden when there are no scratch
          tabs (invariant: zero-subtab pane renders exactly as before). */}
      {scratchTabs.length > 0 ? (
        <PaneTabStrip
          mainSessionId={session.id}
          activeTabId={activeTabId}
          scratchTabs={scratchTabs}
          onSwitchTab={setActiveTabId}
          onCloseTab={closeScratch}
        />
      ) : null}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* v1.5.1-A caveat 5: data-testid="pane-body" for stable test selection. */}
          <div
            data-testid="pane-body"
            className={[
              'relative flex min-h-0 flex-1 flex-col',
              isDragOver && 'ring-2 ring-inset ring-[hsl(var(--ring))]',
              flashDrop && 'bg-[hsl(var(--ring)/0.08)]',
            ]
              .filter(Boolean)
              .join(' ')}
            style={minimised ? { display: 'none' } : undefined}
            data-pane-minimised={minimised ? 'true' : undefined}
            data-dragover={isDragOver ? 'true' : undefined}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="relative min-h-0 flex-1">
              {launchFailed ? (
                // ENOENT / pre-flight failure: no PTY ever started, so there is
                // no scrollback to surface — show the launch error full-screen.
                <div className="flex h-full flex-col items-start justify-start gap-2 p-3 text-xs">
                  <div className="font-medium text-destructive">Failed to launch</div>
                  <div className="whitespace-pre-wrap break-words text-muted-foreground">
                    {session.error ?? 'unknown error'}
                  </div>
                </div>
              ) : crashed ? (
                // v1.13.2 — Runtime crash. Keep the SessionTerminal mounted so
                // the crash scrollback stays readable, and float a banner above
                // it with the exit code + a Relaunch affordance. Distinct from
                // the ENOENT "Failed to launch" surface above.
                <>
                  <CrashBanner
                    exitCode={session.exitCode}
                    onRelaunch={onRelaunch}
                  />
                  <SessionTerminal sessionId={session.id} />
                </>
              ) : scratchTabs.length === 0 ? (
                // W-4 Phase 4 — Zero-subtab FAST PATH: byte-for-byte the
                // pre-Phase-4 render. PaneSplash + SessionTerminal are direct
                // children of `relative min-h-0 flex-1`, so the terminal's
                // 100%×100% fill resolves correctly. No wrapper div — an
                // auto-height wrapper would collapse the terminal (empty pane).
                <>
                  <PaneSplash session={session} />
                  <SessionTerminal sessionId={session.id} />
                </>
              ) : (
                // Multi-tab path (user opened a scratch sub-tab). The active
                // main wrapper uses `display:contents` so it generates no box —
                // SessionTerminal still fills the grandparent `flex-1`. Inactive
                // tabs are `hidden` (display:none) but stay mounted so PTY data
                // + scrollback survive switches (mirrors the minimise pattern).
                <>
                  <div className={activeTabId === session.id ? 'contents' : 'hidden'}>
                    <PaneSplash session={session} />
                    <SessionTerminal sessionId={session.id} />
                  </div>
                  {scratchTabs.map((tab) => (
                    <SessionTerminal
                      key={tab.scratchId}
                      sessionId={tab.scratchId}
                      className={activeTabId === tab.scratchId ? undefined : 'hidden'}
                    />
                  ))}
                </>
              )}
            </div>
            <PaneFooter session={session} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={handleReveal} disabled={!hasWorktree}>
            <FolderOpen className="h-3.5 w-3.5" />
            <span>Reveal worktree in Finder</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleOpenShell} disabled={!hasWorktree}>
            <TerminalIcon className="h-3.5 w-3.5" />
            <span>Open shell here</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={onStop}
            disabled={exited || errored}
            variant="destructive"
          >
            <Square className="h-3.5 w-3.5" />
            <span>Stop</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={onRemove} variant="destructive">
            <span>Close pane</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

/**
 * v1.13.2 — Runtime-crash banner. Floats over the top of the (still-mounted)
 * SessionTerminal so the crash scrollback below stays readable. Distinct from
 * the ENOENT "Failed to launch" surface — this is for a CLI that started and
 * then died. Shows the exit code and a Relaunch button when a handler is wired.
 */
function CrashBanner({
  exitCode,
  onRelaunch,
}: {
  exitCode: number | undefined;
  onRelaunch?: () => void;
}) {
  const codeLabel = typeof exitCode === 'number' ? exitCode : 'unknown';
  return (
    <div
      data-testid="pane-crash-banner"
      role="alert"
      className="absolute inset-x-0 top-0 z-20 flex items-center gap-2 border-b border-destructive/40 bg-destructive/15 px-3 py-1.5 text-[11px] text-destructive"
    >
      <span className="font-medium">Pane crashed (exit {codeLabel})</span>
      <span className="text-destructive/80">Scrollback preserved below.</span>
      {onRelaunch ? (
        <button
          type="button"
          data-testid="pane-relaunch-button"
          onClick={onRelaunch}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-destructive/40 px-1.5 py-0.5 font-medium hover:bg-destructive/20"
        >
          <RotateCw className="h-3 w-3" />
          Relaunch
        </button>
      ) : null}
    </div>
  );
}
