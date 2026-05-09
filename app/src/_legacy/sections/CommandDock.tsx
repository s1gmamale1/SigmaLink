import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import type { TerminalSession } from '@/types';
import { cn } from '@/lib/utils';
import {
  Bot, Compass, FileCode2, Globe, LayoutTemplate, RefreshCcw, Rocket,
  SendHorizontal, Sparkles, Wand2
} from 'lucide-react';

interface CommandDockProps {
  activeTerminal?: TerminalSession | null;
}

type DockTab = 'browser' | 'editor' | 'jarvis';

interface JarvisMessage {
  id: string;
  role: 'assistant' | 'user';
  content: string;
}

const STARTER_MESSAGES: JarvisMessage[] = [
  {
    id: 'j-1',
    role: 'assistant',
    content: 'Hey, I\'m Jarvis. I can help you launch agents, switch rooms, and summarize the active session. Try: "launch kimi", "launch 2 claude", or "open review room".',
  },
];

function extractProviderId(text: string): string | null {
  const normalized = text.toLowerCase();
  if (normalized.includes('claude')) return 'claude';
  if (normalized.includes('codex')) return 'codex';
  if (normalized.includes('gemini')) return 'gemini';
  if (normalized.includes('kimi')) return 'kimi';
  if (normalized.includes('continue')) return 'continue';
  if (normalized.includes('custom')) return 'custom';
  return null;
}

function extractLaunchCount(text: string): number {
  const match = text.match(/\b(\d{1,2})\b/);
  const parsed = match ? Number(match[1]) : 1;
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 12) : 1;
}

export function CommandDock({ activeTerminal }: CommandDockProps) {
  const { state, createTerminal, setRoom } = useWorkspace();
  const [tab, setTab] = useState<DockTab>('jarvis');
  const [browserUrl, setBrowserUrl] = useState('https://openai.com');
  const [browserFrameUrl, setBrowserFrameUrl] = useState('https://openai.com');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<JarvisMessage[]>(STARTER_MESSAGES);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, tab]);

  const provider = useMemo(
    () => state.providers.find((item) => item.id === activeTerminal?.providerId),
    [activeTerminal?.providerId, state.providers],
  );

  const activeOutputPreview = useMemo(() => {
    if (!activeTerminal) return 'Select an agent card to inspect live output, metadata, and notes here.';
    const joined = activeTerminal.output.join('');
    return joined.slice(-4000) || 'No terminal output yet.';
  }, [activeTerminal]);

  async function handleJarvisSubmit(customText?: string) {
    const content = (customText ?? input).trim();
    if (!content) return;

    const userMessage: JarvisMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');

    const normalized = content.toLowerCase();
    const providerId = extractProviderId(content);
    const launchRequested = /(launch|open|start|spawn)/i.test(content) && providerId;
    const reviewRequested = /review/.test(normalized);
    const swarmRequested = /swarm/.test(normalized);
    const commandRequested = /command/.test(normalized);
    const summarizeRequested = /(summari[sz]e|status|what\'?s active|active session|focus)/.test(normalized);

    let assistantReply = '';

    if (launchRequested && providerId) {
      const count = extractLaunchCount(content);
      for (let i = 0; i < count; i += 1) {
        await createTerminal(providerId);
      }
      assistantReply = `Launched ${count} ${providerId.toUpperCase()} session${count > 1 ? 's' : ''}. They should appear in the command mosaic now.`;
    } else if (reviewRequested) {
      setRoom('review');
      assistantReply = 'Switched you to Review Room. Use it to inspect git status, diff, and run verification commands.';
    } else if (swarmRequested) {
      setRoom('swarm');
      assistantReply = 'Switched to Swarm Room. You can define a parent task, break it into subtasks, and delegate each one to specific providers.';
    } else if (commandRequested) {
      setRoom('command');
      assistantReply = 'Back in Command Room. This is your live command deck and multi-agent terminal mosaic.';
    } else if (summarizeRequested) {
      if (!activeTerminal) {
        assistantReply = `There are ${state.terminals.length} active agents right now. Select one to get a focused summary.`;
      } else {
        assistantReply = [
          `Focused agent: ${activeTerminal.title}`,
          `Provider: ${provider?.name ?? activeTerminal.providerId}`,
          `Status: ${activeTerminal.status}`,
          `Branch: ${activeTerminal.branchName}`,
          `Workspace: ${activeTerminal.worktreePath}`,
        ].join('\n');
      }
    } else {
      assistantReply = [
        'I can help with a few built-in actions right now:',
        '- launch kimi / launch 2 claude / open codex',
        '- open review room / open swarm room / open command room',
        '- summarize active session',
        '',
        'For everything else, use the live terminals in the mosaic.',
      ].join('\n');
    }

    setMessages((prev) => [
      ...prev,
      { id: `a-${Date.now()}`, role: 'assistant', content: assistantReply },
    ]);
  }

  const terminalNote = activeTerminal ? (notes[activeTerminal.id] ?? '') : '';

  return (
    <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-[#0b0f17] shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.28em] text-cyan-400/80">Mission Dock</p>
          <h3 className="text-sm font-semibold text-white">Browser · Editor · Jarvis</h3>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 p-1">
          {[
            { id: 'browser', label: 'Browser', icon: Globe },
            { id: 'editor', label: 'Editor', icon: FileCode2 },
            { id: 'jarvis', label: 'Jarvis', icon: Bot },
          ].map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id as DockTab)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] transition-all',
                  active ? 'bg-cyan-500/15 text-cyan-300' : 'text-gray-400 hover:bg-white/5 hover:text-white',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'browser' && (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <div className="flex h-9 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-[#111626] px-3">
                <Compass className="h-4 w-4 text-gray-500" />
                <input
                  value={browserUrl}
                  onChange={(event) => setBrowserUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') setBrowserFrameUrl(browserUrl.startsWith('http') ? browserUrl : `https://${browserUrl}`);
                  }}
                  className="w-full bg-transparent text-sm text-gray-200 outline-none placeholder:text-gray-600"
                  placeholder="Paste a docs URL or local dashboard URL"
                />
              </div>
              <button
                onClick={() => setBrowserFrameUrl(browserUrl.startsWith('http') ? browserUrl : `https://${browserUrl}`)}
                className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-300 transition hover:bg-cyan-500/20"
              >
                Open
              </button>
              <button
                onClick={() => setBrowserFrameUrl((prev) => prev)}
                className="rounded-xl border border-white/10 p-2 text-gray-400 transition hover:bg-white/5 hover:text-white"
                title="Reload current page"
              >
                <RefreshCcw className="h-4 w-4" />
              </button>
            </div>

            <div className="grid flex-1 min-h-0 grid-rows-[auto_1fr] gap-3 p-4">
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Active agents', value: state.terminals.length },
                  { label: 'Tasks', value: state.tasks.length },
                  { label: 'Focused branch', value: activeTerminal?.branchName?.split('/').slice(-1)[0] ?? 'none' },
                ].map((item) => (
                  <div key={item.label} className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-gray-500">{item.label}</p>
                    <p className="mt-2 truncate text-sm font-semibold text-white">{item.value}</p>
                  </div>
                ))}
              </div>

              <div className="min-h-0 overflow-hidden rounded-2xl border border-white/10 bg-[#0f1320]">
                <iframe title="SigmaLink browser" src={browserFrameUrl} className="h-full w-full bg-[#0f1320]" />
              </div>
            </div>
          </div>
        )}

        {tab === 'editor' && (
          <div className="grid h-full min-h-0 grid-rows-[auto_auto_1fr_auto] gap-3 overflow-hidden p-4">
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {[
                { label: 'Agent', value: activeTerminal?.title ?? 'No selection' },
                { label: 'Provider', value: provider?.name ?? '-' },
                { label: 'Status', value: activeTerminal?.status ?? '-' },
                { label: 'Branch', value: activeTerminal?.branchName ?? '-' },
              ].map((item) => (
                <div key={item.label} className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-gray-500">{item.label}</p>
                  <p className="mt-2 truncate text-sm font-semibold text-white">{item.value}</p>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#101522] p-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500">Workspace</p>
              <p className="mt-2 break-all font-mono text-xs text-cyan-200">{activeTerminal?.worktreePath ?? 'Select an agent in the mosaic to inspect its workspace.'}</p>
            </div>

            <div className="min-h-0 overflow-auto rounded-2xl border border-white/10 bg-[#0f1320] p-4">
              <div className="mb-3 flex items-center gap-2">
                <LayoutTemplate className="h-4 w-4 text-cyan-300" />
                <h4 className="text-sm font-semibold text-white">Live output preview</h4>
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-gray-300">
                {activeOutputPreview}
              </pre>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#101522] p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500">Operator notes</p>
                <span className="text-[10px] text-gray-600">Saved in-browser</span>
              </div>
              <textarea
                value={terminalNote}
                onChange={(event) => {
                  if (!activeTerminal) return;
                  setNotes((prev) => ({ ...prev, [activeTerminal.id]: event.target.value }));
                }}
                className="h-24 w-full resize-none rounded-xl border border-white/10 bg-[#0c1019] p-3 text-sm text-gray-200 outline-none placeholder:text-gray-600"
                placeholder="Write inspection notes, TODOs, or review observations here..."
              />
            </div>
          </div>
        )}

        {tab === 'jarvis' && (
          <div className="grid h-full min-h-0 grid-rows-[auto_auto_1fr_auto] gap-3 p-4">
            <div className="rounded-2xl border border-cyan-500/10 bg-[radial-gradient(circle_at_top_left,rgba(6,182,212,0.12),transparent_55%),#101522] p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10">
                  <Sparkles className="h-5 w-5 text-cyan-300" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">Jarvis sidecar</h4>
                  <p className="text-xs text-gray-400">Mission routing, session summaries, and quick terminal launch helpers.</p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {[
                'launch kimi',
                'launch 2 claude',
                'open review room',
                'summarize active session',
              ].map((chip) => (
                <button
                  key={chip}
                  onClick={() => void handleJarvisSubmit(chip)}
                  className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-gray-300 transition hover:bg-white/10 hover:text-white"
                >
                  {chip}
                </button>
              ))}
            </div>

            <div className="min-h-0 overflow-auto rounded-2xl border border-white/10 bg-[#0f1320] p-3">
              <div className="space-y-3">
                {messages.map((message) => (
                  <div key={message.id} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div className={cn(
                      'max-w-[90%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap',
                      message.role === 'user'
                        ? 'bg-cyan-500/15 text-cyan-50 border border-cyan-500/20'
                        : 'bg-white/[0.04] text-gray-200 border border-white/10'
                    )}>
                      {message.content}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            </div>

            <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-[#101522] p-3">
              <div className="flex-1">
                <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-gray-500">Command Jarvis</p>
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void handleJarvisSubmit();
                    }
                  }}
                  placeholder="Ask Jarvis to launch agents, switch rooms, or summarize the active session..."
                  className="h-20 w-full resize-none rounded-xl border border-white/10 bg-[#0b0f17] p-3 text-sm text-gray-200 outline-none placeholder:text-gray-600"
                />
              </div>
              <button
                onClick={() => void handleJarvisSubmit()}
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-4 text-sm text-cyan-300 transition hover:bg-cyan-500/20"
              >
                <SendHorizontal className="h-4 w-4" />
                Send
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-white/10 px-4 py-2 text-[11px] text-gray-500">
        <div className="flex items-center gap-2">
          <Rocket className="h-3.5 w-3.5 text-cyan-300" />
          <span>{activeTerminal ? `Focused on ${activeTerminal.title}` : 'No focused agent selected'}</span>
        </div>
        <button
          onClick={() => void handleJarvisSubmit('summarize active session')}
          className="inline-flex items-center gap-1 text-cyan-300 transition hover:text-cyan-200"
        >
          <Wand2 className="h-3.5 w-3.5" />
          Quick summary
        </button>
      </div>
    </div>
  );
}
