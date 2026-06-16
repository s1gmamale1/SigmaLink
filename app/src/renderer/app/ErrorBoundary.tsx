// ERR-1 — App-resilience layer.
//
// Before this, the ONLY React error boundary lived in the editor tab
// (features/editor/EditorTab.tsx), so a single render throw anywhere in the
// pane/room/graph/settings tree would unmount the whole React root and blank
// the window. This file adds:
//
//   • <RootErrorBoundary> — wraps the entire app body. Its fallback is an
//     Apple-grade "content unavailable" view (built from the shared EmptyState
//     + ErrorBanner + Button primitives + theme tokens) with two recovery
//     actions: "Reload this view" (resets boundary state to re-render the
//     subtree) and "Copy diagnostics" (copies error message + component stack
//     to the clipboard). Motion is honored globally via the reduce-motion
//     safety-net in index.css — the `sl-fade-in` utility self-disables under
//     `prefers-reduced-motion: reduce`.
//
//   • <RoomErrorBoundary> — a thin wrapper used per-room so one room crashing
//     keeps the shell + sidebar + other navigation alive (it renders a compact
//     inline fallback rather than taking over the window).
//
// Both share one class implementation (ErrorBoundary) and differ only by the
// `fallback` render-prop they receive. Class component (not hooks) because
// React error boundaries require getDerivedStateFromError / componentDidCatch,
// which have no hook equivalent. Parameter-property shorthand is avoided so the
// file stays within `erasableSyntaxOnly`.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, ClipboardCopy, RefreshCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/renderer/components/EmptyState';

export interface BoundaryRenderState {
  error: Error;
  componentStack: string | null;
  /** Resets boundary state so the wrapped subtree re-mounts and re-renders. */
  reset: () => void;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Renders the fallback UI from the captured error + a reset callback. */
  fallback: (state: BoundaryRenderState) => ReactNode;
  /** Optional human label for the guarded region — surfaced in console logs. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/**
 * Generic React error boundary. Catches render/lifecycle throws in its subtree,
 * logs them to the console (the renderer dev surface), and renders a caller-
 * supplied fallback. Never re-throws — the whole point is to contain the blast
 * radius so the rest of the app keeps running.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, componentStack: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console so the captured component stack is inspectable in
    // DevTools even after the fallback renders. Kept renderer-only. The label
    // is passed as a discrete argument (not interpolated into the first
    // string) so it can never be treated as a console format specifier.
    console.error(
      '[ErrorBoundary]',
      this.props.label ?? 'unlabeled',
      error,
      info.componentStack,
    );
    this.setState({ componentStack: info.componentStack ?? null });
  }

  reset(): void {
    this.setState({ error: null, componentStack: null });
  }

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error) {
      return this.props.fallback({ error, componentStack, reset: this.reset });
    }
    return this.props.children;
  }
}

/** Builds a copyable diagnostics blob from the captured error. */
function diagnosticsText(error: Error, componentStack: string | null): string {
  const lines = [
    `Message: ${error.message || '(no message)'}`,
    error.name ? `Name: ${error.name}` : null,
    error.stack ? `\nStack:\n${error.stack}` : null,
    componentStack ? `\nComponent stack:${componentStack}` : null,
  ].filter((l): l is string => l !== null);
  return lines.join('\n');
}

/** Copy-diagnostics handler shared by both fallbacks. Best-effort clipboard. */
async function copyDiagnostics(error: Error, componentStack: string | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(diagnosticsText(error, componentStack));
    toast.success('Diagnostics copied to clipboard');
  } catch {
    toast.error('Could not access clipboard — open DevTools to copy the error');
  }
}

/**
 * Root fallback — a full-surface, Apple-grade content-unavailable view.
 * Calm typography on the theme background, a single restrained icon, the error
 * message in a dismissible-style banner, and two clearly-ranked actions.
 */
function RootFallback({ error, componentStack, reset }: BoundaryRenderState) {
  return (
    <div className="sl-fade-in flex h-full min-h-0 w-full flex-col items-center justify-center bg-background p-6">
      <EmptyState
        icon={AlertTriangle}
        title="This view ran into a problem"
        description="The rest of the app is still running. Reload this view to try again, or copy the diagnostics to share what went wrong."
        className="h-auto"
        action={
          <div className="flex flex-col items-center gap-3">
            <div className="max-w-md">
              <ErrorMessage message={error.message || 'Unknown error'} />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button type="button" size="sm" variant="default" onClick={reset}>
                <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
                Reload this view
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copyDiagnostics(error, componentStack)}
              >
                <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
                Copy diagnostics
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}

/** A read-only, non-dismissible rendering of the error text (theme tokens). */
function ErrorMessage({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-left text-xs text-destructive"
      role="alert"
    >
      <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</div>
    </div>
  );
}

/**
 * Root boundary — wrap the app body so any uncaught render throw shows the
 * full content-unavailable view instead of a blank window.
 */
export function RootErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary label="app-root" fallback={(s) => <RootFallback {...s} />}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * Per-room fallback — compact, lives inside the room outlet. Keeps the shell,
 * sidebar, breadcrumb and all other navigation interactive while surfacing the
 * crash + the same two recovery actions for just this room.
 */
function RoomFallback({ error, componentStack, reset }: BoundaryRenderState) {
  return (
    <div className="sl-fade-in flex min-h-0 flex-1 flex-col bg-background">
      <EmptyState
        icon={AlertTriangle}
        title="This room couldn’t load"
        description={error.message || 'An unexpected error occurred while rendering this room.'}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" size="sm" variant="default" onClick={reset}>
              <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
              Reload this view
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copyDiagnostics(error, componentStack)}
            >
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
              Copy diagnostics
            </Button>
          </div>
        }
      />
    </div>
  );
}

/**
 * Wrap each room body so one crashing room can't take down the shell. A `key`
 * (set by callers to the room id) makes React remount the boundary on room
 * change, so navigating away from a crashed room and back gives it a clean
 * slate without the user pressing "Reload this view".
 */
export function RoomErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary label="room" fallback={(s) => <RoomFallback {...s} />}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * Per-pane fallback — compact, fills the pane cell. A single pane's render throw
 * is contained here instead of bubbling to the room boundary and taking down the
 * whole command room. Offers Relaunch (re-spawn the pane), Close pane (soft-delete
 * so it does NOT resurrect on restart), and Copy diagnostics.
 */
function PaneFallback({
  error,
  componentStack,
  reset,
  onRelaunch,
  onClose,
}: BoundaryRenderState & { onRelaunch?: () => void; onClose?: () => void }) {
  return (
    <div className="sl-fade-in flex h-full min-h-0 w-full flex-col items-center justify-center bg-card p-4">
      <EmptyState
        icon={AlertTriangle}
        title="This pane couldn’t render"
        description={error.message || 'An unexpected error occurred while rendering this pane.'}
        className="h-auto"
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onRelaunch ? (
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={() => {
                  reset();
                  onRelaunch();
                }}
              >
                <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
                Relaunch
              </Button>
            ) : null}
            {onClose ? (
              <Button type="button" size="sm" variant="outline" onClick={onClose}>
                <X className="h-3.5 w-3.5" aria-hidden />
                Close pane
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void copyDiagnostics(error, componentStack)}
            >
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
              Copy diagnostics
            </Button>
          </div>
        }
      />
    </div>
  );
}

/**
 * Wrap each command-room pane so one pane's render throw is contained to its own
 * cell — the room, the sidebar, and every sibling pane keep working. `onRelaunch`
 * / `onClose` are the same handlers the pane chrome uses.
 */
export function PaneErrorBoundary({
  children,
  onRelaunch,
  onClose,
}: {
  children: ReactNode;
  onRelaunch?: () => void;
  onClose?: () => void;
}) {
  return (
    <ErrorBoundary
      label="pane"
      fallback={(s) => <PaneFallback {...s} onRelaunch={onRelaunch} onClose={onClose} />}
    >
      {children}
    </ErrorBoundary>
  );
}
