import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/hooks/useWorkspace';
import type { TerminalSession } from '@/types';
import { AlertCircle, CheckCircle, Circle, Maximize2, Minimize2, Play, Rocket, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TerminalPaneProps {
  terminal: TerminalSession;
  isActive: boolean;
  onActivate: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  layoutSignal?: string;
  density?: 'compact' | 'balanced' | 'expanded';
}

export function TerminalPane({ terminal, isActive, onActivate, isFullscreen, onToggleFullscreen, layoutSignal, density = 'balanced' }: TerminalPaneProps) {
  const { state, closeTerminal, sendToTerminal } = useWorkspace();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenChunksRef = useRef(0);

  const metrics = useMemo(() => ({
    compact: { fontSize: 11, lineHeight: 1.15, padding: 'p-1.5' },
    balanced: { fontSize: 12, lineHeight: 1.2, padding: 'p-2' },
    expanded: { fontSize: 13, lineHeight: 1.28, padding: 'p-2.5' },
  }[density]), [density]);

  const scheduleFit = useCallback(() => {
    const fit = fitRef.current;
    if (!fit) return;

    const runFit = () => {
      try {
        fit.fit();
      } catch {
        // Terminal can briefly be detached while layout changes.
      }
    };

    requestAnimationFrame(runFit);
    window.setTimeout(runFit, 80);
    window.setTimeout(runFit, 220);
  }, []);

  const provider = state.providers.find((p) => p.id === terminal.providerId);

  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: metrics.fontSize,
      lineHeight: metrics.lineHeight,
      scrollback: 6000,
      theme: {
        background: '#0d0f17',
        foreground: '#d7dce8',
        cursor: '#67e8f9',
        selectionBackground: '#0891b255',
        black: '#0a0c12',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#f8fafc',
        brightBlack: '#64748b',
        brightRed: '#fb7185',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    scheduleFit();

    const dataDisposable = term.onData((data) => {
      void sendToTerminal(terminal.id, data);
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void window.electron?.ptyResize({ id: terminal.id, cols, rows });
    });

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });
    resizeObserver.observe(containerRef.current);

    termRef.current = term;

    for (const chunk of terminal.output) term.write(chunk);
    writtenChunksRef.current = terminal.output.length;

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [metrics.fontSize, metrics.lineHeight, scheduleFit, sendToTerminal, terminal.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const chunks = terminal.output.slice(writtenChunksRef.current);
    for (const chunk of chunks) term.write(chunk);
    writtenChunksRef.current = terminal.output.length;
  }, [terminal.output]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = metrics.fontSize;
    term.options.lineHeight = metrics.lineHeight;
    scheduleFit();
  }, [metrics.fontSize, metrics.lineHeight, scheduleFit]);

  useEffect(() => {
    if (!isActive || !termRef.current) return;
    termRef.current.focus();
  }, [isActive]);

  useEffect(() => {
    scheduleFit();
  }, [isActive, isFullscreen, layoutSignal, scheduleFit]);

  const handleClose = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    void closeTerminal(terminal.id);
  }, [closeTerminal, terminal.id]);

  const StatusIcon = terminal.status === 'starting' ? Rocket
    : terminal.status === 'running' ? Play
      : terminal.status === 'completed' ? CheckCircle
        : terminal.status === 'error' ? AlertCircle
          : Circle;

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border transition-all',
        isActive
          ? 'border-cyan-500/40 bg-[#121827] shadow-[0_0_0_1px_rgba(34,211,238,0.08),0_18px_50px_rgba(8,145,178,0.12)]'
          : 'border-white/8 bg-[#101520]'
      )}
      onClick={onActivate}
    >
      <div className="flex items-center gap-2 border-b border-white/5 bg-[#0f1117] px-3 py-2.5">
        <div className="h-3 w-3 rounded-full" style={{ backgroundColor: provider?.color || '#666' }} />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-gray-200">{terminal.title}</span>
          <span className="block truncate text-[10px] text-gray-500">{provider?.description ?? terminal.providerId}</span>
        </div>
        <div className="flex items-center gap-1">
          <StatusIcon className={cn(
            'h-3.5 w-3.5',
            terminal.status === 'starting' ? 'text-amber-400 animate-pulse' :
              terminal.status === 'running' ? 'text-green-400' :
                terminal.status === 'completed' ? 'text-blue-400' :
                  terminal.status === 'error' ? 'text-red-400' : 'text-gray-500'
          )} />
          <span className="hidden text-[10px] uppercase text-gray-500 lg:inline">{terminal.status}</span>
          {onToggleFullscreen && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-gray-500 hover:bg-white/10 hover:text-white"
              onClick={(event) => { event.stopPropagation(); onToggleFullscreen(); }}
            >
              {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-gray-500 hover:bg-red-500/10 hover:text-red-400"
            onClick={handleClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div ref={containerRef} className={cn('flex-1 min-h-0 min-w-0 bg-[#0d0f17]', metrics.padding)} />

      <div className="flex items-center gap-2 border-t border-white/5 bg-[#0a0d14] px-3 py-1.5">
        <span className="truncate rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[10px] text-gray-500">{terminal.branchName}</span>
        <span className="truncate text-[10px] text-gray-600">{terminal.worktreePath}</span>
      </div>
    </div>
  );
}
