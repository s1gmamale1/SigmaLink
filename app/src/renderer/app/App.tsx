import { Suspense, lazy, useEffect, useState, type ReactElement } from 'react';
// UX-1 — themed toast surface. The wrapper reads SigmaLink's OWN `useTheme()`
// and maps the active theme onto sonner's light/dark axis (and applies the
// glass material on the Glass theme) instead of a hardcoded `theme="dark"`,
// which slabbed every toast dark on the light Parchment theme.
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { Sidebar } from '@/renderer/features/sidebar/Sidebar';
import { Breadcrumb } from '@/renderer/features/top-bar/Breadcrumb';
import { VoicePill } from '@/renderer/features/voice/VoicePill';
// CommandRoom stays eager — it's the default landing room, so lazy-loading
// it would add a Suspense flash on cold boot. Every other room is code-split
// via React.lazy below so the main bundle ships ~30 KB gzip lighter
// (rooms are only fetched when the user navigates to them).
import { CommandRoom } from '@/renderer/features/command-room/CommandRoom';
import { CommandPalette } from '@/renderer/features/command-palette/CommandPalette';
import { MemoryQuickSwitcher } from '@/renderer/features/memory/MemoryQuickSwitcher';
import { OnboardingModal } from '@/renderer/features/onboarding/OnboardingModal';
import { FeatureSpotlightModal } from '@/renderer/features/onboarding/FeatureSpotlightModal';
import { useWhatsNew } from '@/renderer/features/onboarding/use-whats-new';
import { bindShortcut } from '@/renderer/lib/shortcuts';
import type { RufloEntry } from '@/shared/types';
import { NativeRebuildModal } from '@/renderer/components/NativeRebuildModal';
import { RightRail } from '@/renderer/features/right-rail/RightRail';
import { RightRailProvider } from '@/renderer/features/right-rail/RightRailContext';
import { useRightRailEnabled } from '@/renderer/features/right-rail/use-right-rail-enabled';
import { ThemeProvider } from '@/renderer/app/ThemeProvider';
import { AppStateProvider, useAppState } from '@/renderer/app/state';
import { ROOM_LOADERS, prefetchRooms } from '@/renderer/app/room-loaders';
// ERR-1 — app-resilience layer: a root boundary so a render throw anywhere
// no longer blanks the window, plus per-room boundaries so one crashing room
// keeps the shell + other navigation alive.
import { RootErrorBoundary, RoomErrorBoundary } from '@/renderer/app/ErrorBoundary';

// --- Lazy rooms ----------------------------------------------------------
// Each room is wrapped in `React.lazy` so its module (and the heavy feature
// subtrees it pulls in — operator-console, jorvis-assistant, memory, skills,
// browser, etc.) stays out of the main chunk until the user actually
// navigates there. The import factories live in `room-loaders.ts` as the
// single source of truth — App.tsx consumes them here for `lazy()` and the
// idle-prefetch loop reuses the same map to warm chunks after first paint.
// The `!` asserts presence (every key below exists in ROOM_LOADERS; `command`
// is the only omitted room and it stays eager).
const WorkspaceLauncher = lazy(ROOM_LOADERS.workspaces!);
const SwarmRoom = lazy(ROOM_LOADERS.swarm!);
const OperatorConsole = lazy(ROOM_LOADERS.operator!);
const BrowserRoom = lazy(ROOM_LOADERS.browser!);
const SkillsRoom = lazy(ROOM_LOADERS.skills!);
const MemoryRoom = lazy(ROOM_LOADERS.memory!);
const ReviewRoom = lazy(ROOM_LOADERS.review!);
const TasksRoom = lazy(ROOM_LOADERS.tasks!);
const SettingsRoom = lazy(ROOM_LOADERS.settings!);
const JorvisRoom = lazy(ROOM_LOADERS.jorvis!);
// C-12 SigmaBench — multi-agent conflict benchmark room.
const SigmaBenchRoom = lazy(ROOM_LOADERS.sigmabench!);

// Lightweight placeholder rendered while a lazy room module is downloading.
// A calm centered spinner on the theme surface — NOT a full-bleed `bg-accent`
// Skeleton, which painted the whole outlet a saturated brand-purple for the
// duration of the chunk fetch (the "purple flash on page change"). Kept inline
// so it adds zero bytes to the main chunk beyond the markup itself.
function RoomSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading room"
      className="flex min-h-0 flex-1 items-center justify-center bg-background"
    >
      <Spinner aria-hidden className="size-6 text-muted-foreground" />
    </div>
  );
}

function RoomSwitch() {
  const { state } = useAppState();
  // BUG-W7-014: expose the active room id on `<body>` so end-to-end tests can
  // verify which room actually rendered (rather than relying on screenshot
  // filenames that lie when sidebar gating routes the click elsewhere).
  useEffect(() => {
    document.body.setAttribute('data-room', state.room);
    return () => document.body.removeAttribute('data-room');
  }, [state.room]);
  // CommandRoom stays eager (default landing room → no Suspense flash on
  // cold boot). Every other room is lazy-mounted, so wrap them in a single
  // Suspense boundary keyed by room id — that way re-entering the same room
  // doesn't re-trigger the fallback once the chunk is cached.
  //
  // `eager` rooms (command) render without Suspense; lazy rooms render inside
  // one Suspense boundary. Either way the result is wrapped in a per-room
  // ErrorBoundary keyed by room id (ERR-1) so a render throw in one room shows
  // a contained fallback instead of unmounting the whole app — and navigating
  // away then back to a crashed room remounts the boundary with a clean slate.
  let body: ReactElement | null;
  let eager = false;
  switch (state.room) {
    case 'command':
      body = <CommandRoom />;
      eager = true;
      break;
    case 'workspaces':
      body = <WorkspaceLauncher />;
      break;
    case 'swarm':
      body = <SwarmRoom />;
      break;
    case 'operator':
      body = <OperatorConsole />;
      break;
    case 'review':
      body = <ReviewRoom />;
      break;
    case 'tasks':
      body = <TasksRoom />;
      break;
    case 'memory':
      body = <MemoryRoom />;
      break;
    case 'browser':
      body = <BrowserRoom />;
      break;
    case 'skills':
      body = <SkillsRoom />;
      break;
    case 'sigmabench':
      body = <SigmaBenchRoom />;
      break;
    case 'jorvis':
      body = <JorvisRoom variant="standalone" />;
      break;
    case 'settings':
      body = <SettingsRoom />;
      break;
    default:
      body = null;
  }
  if (body === null) return null;
  const inner = eager ? body : <Suspense fallback={<RoomSkeleton />}>{body}</Suspense>;
  // UX-5 — one consistent enter transition for EVERY room. Previously only a
  // couple of rooms applied a one-shot `sl-fade-in` on their own root, so room
  // switches felt inconsistent (some faded, most hard-cut). Keying the wrapper
  // by `state.room` re-fires the fade on each switch; the global
  // prefers-reduced-motion reset in index.css neutralizes `.sl-fade-in` to a
  // no-op for users who ask for less motion.
  //
  // The key is the room id, NOT a fresh value per render, so an eager room
  // (CommandRoom) keeps its element identity for the whole time it is the
  // active room — its terminal grid is mounted once on entry and is never
  // remounted by unrelated re-renders.
  return (
    <RoomErrorBoundary key={state.room}>
      <div key={state.room} className="sl-fade-in flex min-h-0 flex-1 flex-col">
        {inner}
      </div>
    </RoomErrorBoundary>
  );
}

/**
 * Body wrapper that conditionally hosts the right-rail dock. When the
 * `rightRail.enabled` kv flag is on (the default) the room contents render in
 * the left column and the dock occupies the right column; when disabled we
 * fall back to the legacy single-column layout. The kv read is async, so until
 * it resolves we render the body alone — preventing a rail-flash on cold boot.
 *
 * Special-case: while the user is in the dedicated `browser` room, we hide
 * the rail entirely. The Browser surface is the rail's own first tab, so
 * mounting it twice would fight over the WebContentsView bounds.
 */
function MainBody() {
  const { state } = useAppState();
  const { enabled, ready } = useRightRailEnabled();
  // Hide the rail when the user is in a room whose body already lives in the
  // rail (Browser tab → 'browser', Jorvis tab → 'jorvis') so we don't double-
  // mount the WebContentsView (browser) or the chat surface (bridge).
  const showRail =
    ready && enabled && state.room !== 'browser' && state.room !== 'jorvis';
  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <RoomSwitch />
    </div>
  );
  if (!showRail) return body;
  return <RightRail>{body}</RightRail>;
}

/**
 * global-⌘O — the Memory Quick Switcher, lifted out of MemoryRoom so ⌘O works
 * from ANY room (like the CommandPalette's global mod+k). Reads the active
 * workspace's notes from state; selecting a note jumps to the Memory room with
 * that note active, and selecting a Ruflo agent-memory entry stages it on
 * `state.pendingRufloView` (the Memory room consumes it on mount — it's the
 * only surface that can render a read-only Ruflo view) and routes there.
 *
 * The note list comes from `state.memories[activeWs]`, kept live by the
 * app-level `use-live-events` memory hydration (keyed on the active workspace),
 * so there's no need for a dedicated fetch here. When no workspace is active
 * the binding is inert (nothing to switch to).
 */
function GlobalMemorySwitcher() {
  const { state, dispatch } = useAppState();
  const [open, setOpen] = useState(false);
  const wsId = state.activeWorkspaceId;
  const memories = wsId ? state.memories[wsId] ?? [] : [];

  useEffect(
    () =>
      bindShortcut('mod+o', (e) => {
        if (!wsId) return; // no active workspace → nothing to switch to
        e.preventDefault();
        setOpen(true);
      }),
    [wsId],
  );

  const onSelectNote = (name: string) => {
    if (!wsId) return;
    dispatch({ type: 'SET_ACTIVE_MEMORY', workspaceId: wsId, name });
    dispatch({ type: 'SET_ROOM', room: 'memory' });
    setOpen(false);
  };
  const onSelectRuflo = (entry: RufloEntry) => {
    dispatch({ type: 'SET_PENDING_RUFLO_VIEW', entry });
    dispatch({ type: 'SET_ROOM', room: 'memory' });
    setOpen(false);
  };

  // Mount the switcher (and run its Ruflo-health/entries effects) only while
  // it's open — at rest it's a no-op, so cold App boot never fires the
  // switcher's rpc probes. The ⌘O binding above always stays installed; the
  // re-mount on open re-runs the cheap health probe.
  if (!open) return null;

  return (
    <MemoryQuickSwitcher
      open={open}
      onOpenChange={setOpen}
      memories={memories}
      onSelectNote={onSelectNote}
      onSelectRuflo={onSelectRuflo}
    />
  );
}

/**
 * ONB-1 — runs the "What's new" upgrade-toast hook. The hook reads global app
 * state (`useAppState`), so it must live inside `AppStateProvider`. This
 * component renders nothing — it exists only to host the effect within the
 * provider tree.
 */
function WhatsNewMount() {
  useWhatsNew();
  return null;
}

export default function App() {
  // FE-4 — prefetch every lazy room chunk during idle time after mount, so the
  // first navigation to a not-yet-visited room skips even the Suspense spinner.
  // Runs once; cleanup cancels any pending idle callback if we unmount first.
  useEffect(() => prefetchRooms(), []);

  return (
    <AppStateProvider>
      <ThemeProvider>
        {/* UX-7 — single root TooltipProvider. Per-cluster providers elsewhere
            in the tree are harmless and left in place, but mounting one here
            gives a consistent open/close delay app-wide (300ms hover-in;
            150ms grace window so moving between adjacent tooltips skips the
            re-delay). Wraps the shell so every tooltip inherits it. */}
        <TooltipProvider delayDuration={300} skipDelayDuration={150}>
        {/* ERR-1 — root resilience boundary. Wraps the entire app shell so an
            uncaught render throw anywhere below shows an Apple-grade content-
            unavailable fallback instead of a blank window. The Toaster +
            modals below stay OUTSIDE the boundary so "Copy diagnostics" toasts
            still surface even if the shell itself crashed. */}
        <RootErrorBoundary>
        {/* v1.1.4 Step 3 — the right-rail's active-tab state lives in
            `RightRailContext` so both the top-bar `RightRailSwitcher`
            (inside Breadcrumb) and the rail itself (`RightRail`) share
            one source of truth. The provider wraps both. */}
        <RightRailProvider>
          {/* Skip-link: visually hidden until focused; allows keyboard users to
              jump past the sidebar directly into the main content area. */}
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[9999] focus:rounded focus:bg-background focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
          >
            Skip to main content
          </a>
          <div className="flex h-full w-full">
            <Sidebar />
            <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col">
              {/* V3-W15-001 — title-bar SigmaVoice pill overlays the breadcrumb
                  while a voice session is active. The pill auto-hides 200ms
                  after capture stops so we don't reserve layout space. */}
              <div className="relative">
                <Breadcrumb />
                <div className="pointer-events-none absolute inset-x-0 top-0 flex h-8 items-center justify-center">
                  <VoicePill />
                </div>
              </div>
              <MainBody />
            </main>
          </div>
        </RightRailProvider>
        </RootErrorBoundary>
        </TooltipProvider>
        <CommandPalette />
        {/* global-⌘O — Memory Quick Switcher, global like the CommandPalette. */}
        <GlobalMemorySwitcher />
        <OnboardingModal />
        {/* ONB-1 — Feature Spotlight: shown once after onboarding completes.
            Self-gates on the coachmark "seen" flag + `state.onboarded`. */}
        <FeatureSpotlightModal />
        {/* ONB-1 — "What's new" upgrade toast (effect-only; renders null). */}
        <WhatsNewMount />
        <NativeRebuildModal />
        {/* UX-1 — themed toast surface (see import above). Stays OUTSIDE the
            RootErrorBoundary (ERR-1) so toasts survive a shell-body crash.
            `theme`/`richColors` are intentionally omitted: the wrapper derives
            light/dark from the active app theme and styles toasts from the
            popover tokens (richColors would override that). */}
        <Toaster position="bottom-right" closeButton />
      </ThemeProvider>
    </AppStateProvider>
  );
}
