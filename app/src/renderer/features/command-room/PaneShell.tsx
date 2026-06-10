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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import { ClipboardPaste, Copy, FolderOpen, GitBranch, RotateCw, Square, Terminal as TerminalIcon, FolderGit2, LayoutPanelLeft } from 'lucide-react';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { CreateWorktreeModal } from './CreateWorktreeModal';
import { rpc } from '@/renderer/lib/rpc';
import { getCached } from '@/renderer/lib/terminal-cache';
import { SessionTerminal } from './Terminal';
import { PaneHeader } from './PaneHeader';
import { PaneSplash } from './PaneSplash';
import { PaneFooter } from './PaneFooter';
import { insertMention } from './insertMention';
import { insertSkillCommand, isSlashCapableProvider } from './insertSkillCommand';
import { isImageCapableProvider } from '@/shared/providers';
import { pathRelative } from '@/renderer/lib/path-relative';
import type { AgentSession } from '@/shared/types';
import { SKILL_DRAG_MIME, type SkillDragPayload } from '@/renderer/features/skills/SkillsTab';
import { PANE_DRAG_MIME } from '@/renderer/lib/pane-context-builder';
import { SkillBindingChip, type SkillBinding } from '@/renderer/features/skills/SkillBindingChip';
import { PaneTabStrip } from './PaneTabStrip';
import {
  addScratchTab,
  closeScratchTab,
  getScratchTabs,
  subscribeScratchTabs,
} from '@/renderer/lib/scratch-tabs';
import { PaneContextSidebar } from './PaneContextSidebar';
import { useUncommittedCount } from '@/renderer/lib/use-git-status-poll';
import { usePromptCard } from './use-prompt-card';
import { PromptCard } from './PromptCard';

// v1.4.8 — Max number of files allowed in a single Finder multi-drop.
const MAX_DROP_FILES = 10;

// FEAT-4 — opt-in gate for interactive in-terminal prompt cards. Default OFF
// ('1' = on) to avoid false positives on untrusted PTY output. Mirrors the
// off-by-default pty.spawnMode / pty.scrollbackPersistence reads.
const KV_PROMPT_CARDS = 'pty.promptCards';

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
  // C-1 data — git-status count for the pane's worktree. PERF-6: backed by a
  // shared refcounted per-repo poller so multiple panes on the same worktree
  // share ONE 15 s poll (and it pauses while the window is hidden). The
  // consumed `uncommitted: number | null` shape is unchanged.
  const uncommitted = useUncommittedCount(session.worktreePath);

  // FEAT-4 — opt-in interactive prompt cards. Read the KV gate ONCE on mount
  // (off-by-default; '1' = on). The hook watches this pane's PTY for a valid
  // SIGMA::PROMPT line and exposes the active prompt + an answer writer.
  const [promptCardsEnabled, setPromptCardsEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void rpc.kv
      .get(KV_PROMPT_CARDS)
      .then((v) => {
        if (!cancelled) setPromptCardsEnabled(v === '1');
      })
      .catch(() => {
        /* default OFF on read failure */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const {
    prompt: activePrompt,
    answer: answerPrompt,
    dismiss: dismissPrompt,
  } = usePromptCard(session.id, promptCardsEnabled);

  // W-4 Phase 4 + 2026-06-10 finding 1 — scratch tabs live in a MODULE-SCOPE
  // store keyed by this pane's sessionId, so they survive room/workspace
  // switches exactly like the cached terminal does. Only the active-tab
  // SELECTION is per-mount (a remount lands back on the main tab — fine).
  // INVARIANT: with zero scratch tabs, no tab-strip renders and the pane body
  // is byte-for-byte identical to the pre-Phase-4 render.
  const scratchSubscribe = useCallback(
    (cb: () => void) => subscribeScratchTabs(session.id, cb),
    [session.id],
  );
  const scratchSnapshot = useCallback(() => getScratchTabs(session.id), [session.id]);
  const scratchTabs = useSyncExternalStore(scratchSubscribe, scratchSnapshot);
  const [activeTabId, setActiveTabId] = useState<string>(session.id);
  // Ref used by the keydown handler to check if THIS pane container is focused.
  const paneContainerRef = useRef<HTMLDivElement>(null);

  // Keep activeTabId readable from stable callbacks without re-subscribing.
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // Spawn a scratch shell PTY and register its tab in the module store.
  const spawnScratch = useCallback(async () => {
    const cwd = session.worktreePath ?? '.';
    try {
      const result = await rpc.pty.spawnScratch({ cwd });
      addScratchTab(session.id, result.scratchId);
      setActiveTabId(result.scratchId);
    } catch {
      // Silent — toast from the rpc layer if applicable.
    }
  }, [session.id, session.worktreePath]);

  // Close a scratch tab. The store kills the PTY AND destroys the cached
  // xterm (finding 1c); we only manage the local active-tab selection here.
  const closeScratch = useCallback(
    (scratchId: string) => {
      const tabs = getScratchTabs(session.id);
      if (activeTabIdRef.current === scratchId) {
        const idx = tabs.findIndex((t) => t.scratchId === scratchId);
        const remaining = tabs.filter((t) => t.scratchId !== scratchId);
        const next = remaining[idx] ?? remaining[idx - 1] ?? null;
        setActiveTabId(next ? next.scratchId : session.id);
      }
      closeScratchTab(session.id, scratchId);
    },
    [session.id],
  );

  // Spec 2026-06-10 (B) — stage image bytes via panes.stageImage and inject the
  // ABSOLUTE @path (insertMention prefixes '@'). Absolute (not workspace-
  // relative) because screenshots live outside the workspace (/var/folders/…)
  // and the CLI must open the file from the prompt path alone. Shared by the
  // drop branch and (Task 6) the paste interceptor.
  const stageAndInsertImages = useCallback(
    async (imageFiles: File[]): Promise<void> => {
      for (const file of imageFiles) {
        try {
          const buf = await file.arrayBuffer();
          const ext = (file.type.split('/')[1] ?? 'png').toLowerCase();
          const { absPath } = await rpc.panes.stageImage({ bytesBase64: arrayBufferToBase64(buf), ext });
          await insertMention(session.id, absPath, session.status);
          toast.success('Screenshot staged for the agent', { description: absPath });
        } catch (err) {
          toast.error('Could not stage image', { description: err instanceof Error ? err.message : String(err) });
        }
      }
    },
    [session.id, session.status],
  );

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

  // Spec 2026-06-10 (B) — intercept image PASTE before xterm. xterm's paste
  // handler reads only text/plain, so an image clipboard (macOS screenshot)
  // produced "" and was silently swallowed. Capture phase on window +
  // containment check, mirroring the Cmd+T handler above. Text pastes fall
  // through untouched (no preventDefault) so xterm still handles them.
  useEffect(() => {
    const container = paneContainerRef.current;
    if (!container) return;

    function handlePaste(e: ClipboardEvent): void {
      if (!container!.contains(e.target as Node)) return;
      if (!isImageCapableProvider(session.providerId)) return;
      if (session.status !== 'running') return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
      if (!imageItem) return; // text paste — let xterm handle it
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void stageAndInsertImages([file]);
    }

    window.addEventListener('paste', handlePaste, true);
    return () => window.removeEventListener('paste', handlePaste, true);
  }, [session.providerId, session.status, stageAndInsertImages]);

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
    if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
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
    if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
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
            // Inject "<prefix><skillName> " into the pane's input line. The user
            // presses Enter to invoke. Also create the chip binding as before.
            // SMK-3b: pass providerId so codex gets '$' prefix instead of '/'.
            void insertSkillCommand(session.id, payload.name, session.status, session.providerId);
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
    // Spec 2026-06-10 (B) — image files on an image-capable pane are staged
    // (bytes → temp file → absolute @path) so the CLI can READ the image;
    // previously they degraded to a fragile relative path-mention with the
    // bytes never read. Everything else keeps the mention behaviour.
    const imageFiles = isImageCapableProvider(session.providerId)
      ? capped.filter((f) => f.type.startsWith('image/'))
      : [];
    if (imageFiles.length > 0) void stageAndInsertImages(imageFiles);
    const pathFiles = capped.filter((f) => !imageFiles.includes(f));
    const paths: string[] = [];
    for (const file of pathFiles) {
      const absPath = window.sigma.getPathForFile(file);
      if (!absPath) continue;
      const rel = pathRelative(absPath, workspaceRootPath);
      paths.push(rel);
    }
    if (paths.length === 0) return;
    const mention = paths.join(' @');
    void insertMention(session.id, mention, session.status);
  }

  // BSP-G1 — Create Worktree modal state.
  const [createWorktreeOpen, setCreateWorktreeOpen] = useState(false);

  // BSP-G3 — "Open worktree in this pane" — only enabled on idle panes.
  const isRunning = session.status === 'running';

  function handleCreateWorktree() {
    setCreateWorktreeOpen(true);
  }

  function handleOpenInPane() {
    // Minimal implementation: prompt for a worktree path. A richer file-picker
    // can be wired in a follow-up. The gate (disabled when running) is the
    // primary safety invariant; the prompt satisfies the BSP-G3 affordance.
    const worktreePath = window.prompt('Worktree path to open in this pane:');
    if (!worktreePath) return;
    void rpc.git
      .openInPane({ sessionId: session.id, worktreePath })
      .then((result) => {
        if (result.ok) {
          toast.success('Worktree opened in pane', { description: worktreePath });
        }
      })
      .catch((err) =>
        toast.error('Failed to open worktree in pane', {
          description: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  function handleOpenNewWorkspace() {
    void rpc.workspaces
      .openNew(workspaceRootPath)
      .then(() => toast.success('New workspace opened', { description: workspaceRootPath }))
      .catch((err) =>
        toast.error('Failed to open workspace', {
          description: err instanceof Error ? err.message : String(err),
        }),
      );
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
  // Repo root for the CreateWorktreeModal = the workspace root (the repo a new
  // worktree is cut from). The session's own worktreePath is a CHILD worktree,
  // not the repo, so it is deliberately NOT used here.
  const repoRoot = workspaceRootPath;
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
        uncommitted={uncommitted}
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
            {/* FEAT-2 — terminal area + (when fullscreen) a context sidebar. */}
            <div className="flex min-h-0 flex-1">
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
              {/* FEAT-4 — opt-in interactive prompt card. Overlays the live
                  terminal (absolute inset-x-0 bottom-0 z-20 inside this
                  `relative min-h-0 flex-1` container, like CrashBanner does at
                  the top). Only rendered when the agent emitted a valid
                  SIGMA::PROMPT line AND the KV gate is on; never over the
                  "Failed to launch" surface (no PTY/stdin to answer into). */}
              {activePrompt && !launchFailed ? (
                <PromptCard
                  prompt={activePrompt}
                  onSubmit={answerPrompt}
                  onDismiss={dismissPrompt}
                />
              ) : null}
              </div>
              <PaneContextSidebar session={session} open={isFullscreen} />
            </div>
            <PaneFooter session={session} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {/* Spec 2026-06-10 (C) — terminal Copy/Paste. The Radix trigger
              intercepts right-click (xterm's native copy never fires), so the
              menu must own clipboard access. Keyed on activeTabId so scratch
              tabs work. */}
          <ContextMenuItem
            data-testid="ctx-copy"
            disabled={!getCached(activeTabId)?.terminal.hasSelection()}
            onSelect={() => {
              const sel = getCached(activeTabId)?.terminal.getSelection();
              if (sel) void navigator.clipboard?.writeText(sel).catch(() => undefined);
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Copy</span>
          </ContextMenuItem>
          <ContextMenuItem
            data-testid="ctx-paste"
            disabled={exited || errored}
            onSelect={() => {
              void navigator.clipboard
                ?.readText()
                .then((text) => {
                  if (text) void rpc.pty.write(activeTabId, text);
                })
                .catch(() => undefined);
            }}
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>Paste</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={handleReveal} disabled={!hasWorktree}>
            <FolderOpen className="h-3.5 w-3.5" />
            <span>Reveal worktree in Finder</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleOpenShell} disabled={!hasWorktree}>
            <TerminalIcon className="h-3.5 w-3.5" />
            <span>Open shell here</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* BSP-G1 — Create worktree from this pane's repo root. */}
          <ContextMenuItem
            data-testid="ctx-create-worktree"
            onSelect={handleCreateWorktree}
          >
            <GitBranch className="h-3.5 w-3.5" />
            <span>Create worktree…</span>
          </ContextMenuItem>
          {/* BSP-G3 — Swap this IDLE pane to an existing worktree. */}
          <ContextMenuItem
            data-testid="ctx-open-in-pane"
            onSelect={handleOpenInPane}
            disabled={isRunning}
          >
            <FolderGit2 className="h-3.5 w-3.5" />
            <span>Open worktree in this pane…</span>
          </ContextMenuItem>
          {/* DEV-W3a — Force-open a distinct workspace on the same dir. */}
          <ContextMenuItem
            data-testid="ctx-open-new-workspace"
            onSelect={handleOpenNewWorkspace}
          >
            <LayoutPanelLeft className="h-3.5 w-3.5" />
            <span>Open another workspace here</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
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
      {/* BSP-G1 — Modal rendered outside the ContextMenu so it is not
          unmounted when the context menu closes. */}
      <CreateWorktreeModal
        open={createWorktreeOpen}
        onOpenChange={setCreateWorktreeOpen}
        repoRoot={repoRoot}
      />
    </div>
  );
}

// Spec 2026-06-10 (B) — renderer-side ArrayBuffer→base64 (no Buffer in the
// renderer). Chunked to stay under the fromCharCode argument-count limit.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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
