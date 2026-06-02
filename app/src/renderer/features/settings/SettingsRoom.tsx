// Settings room — twelve tabs (Appearance, Providers, MCP servers, Voice,
// Notifications, Ruflo, Updates, Sync, Telegram, Storage, Maintenance,
// Diagnostics). The shadcn Tabs primitive handles the active panel; each tab
// component is self-contained and runs its own lazy data fetches.
//
// ONB-1 — the Tabs are CONTROLLED here (value + onValueChange) so two
// discoverability features work:
//   1. A header search box filters the visible tab triggers by label/keywords.
//      When the active tab is filtered out, an effect switches to the first
//      still-visible tab (Radix needs the controlled value to stay valid).
//   2. An external deep-link: a Settings tab staged on `state.pendingSettingsTab`
//      (e.g. the Feature Spotlight "Voice" card) is consumed on mount and the
//      staging slot is cleared.
//
// Chrome (header strip + body container) is inlined here — it was previously
// in <RoomChrome>, but Settings was the only caller, so the wrapper was
// removed in the v1.1.10 dead-code sweep.

import { useEffect, useMemo, useState } from 'react';
import { Search, Settings } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { useAppState } from '@/renderer/app/state';
import { AppearanceTab } from './AppearanceTab';
import { ProvidersTab } from './ProvidersTab';
import { McpServersTab } from './McpServersTab';
import { DiagnosticsTab } from './DiagnosticsTab';
import { UpdatesTab } from './UpdatesTab';
import { RufloSettings } from './RufloSettings';
import { VoiceTab } from './VoiceTab';
import { StorageTab } from './StorageTab';
import { NotificationsSettings } from './NotificationsSettings';
import { SyncTab } from './SyncTab';
import { TelegramTab } from './TelegramTab';
import { MaintenanceTab } from './MaintenanceTab';

interface TabDef {
  value: string;
  label: string;
  /** Extra search terms (synonyms / setting names) beyond the visible label. */
  keywords: string;
}

// The canonical tab order. `keywords` widens search so a query like "theme",
// "model", "ollama", or "backup" still surfaces the right tab even when the
// word isn't in the visible label.
const TABS: readonly TabDef[] = [
  { value: 'appearance', label: 'Appearance', keywords: 'theme dark light glass density font color' },
  { value: 'providers', label: 'Providers', keywords: 'agent cli claude codex gemini kimi opencode cursor model api key' },
  { value: 'mcp', label: 'MCP servers', keywords: 'model context protocol tools servers ruflo stdio' },
  { value: 'voice', label: 'Voice', keywords: 'dictation whisper transcription microphone wake word hey jorvis sigmavoice' },
  { value: 'notifications', label: 'Notifications', keywords: 'alerts sound badge unread toast' },
  { value: 'ruflo', label: 'Ruflo', keywords: 'memory daemon swarm hnsw neural agentdb' },
  { value: 'updates', label: 'Updates', keywords: 'version upgrade auto-update release channel' },
  { value: 'sync', label: 'Sync', keywords: 'cloud backup devices replicate' },
  { value: 'telegram', label: 'Telegram', keywords: 'remote jorvis bot chat phone notifications' },
  { value: 'storage', label: 'Storage', keywords: 'disk cache database worktrees cleanup data path' },
  { value: 'maintenance', label: 'Maintenance', keywords: 'cleanup repair reset diagnostics rebuild orphans' },
  { value: 'diagnostics', label: 'Diagnostics', keywords: 'logs report debug troubleshoot copy' },
];

function matchesQuery(tab: TabDef, query: string): boolean {
  if (!query) return true;
  const haystack = `${tab.label} ${tab.keywords}`.toLowerCase();
  return haystack.includes(query);
}

export function SettingsRoom() {
  const { state, dispatch } = useAppState();
  const [activeTab, setActiveTab] = useState<string>('appearance');
  const [query, setQuery] = useState('');

  // ONB-1 — consume an externally-staged tab (Feature Spotlight "Voice"
  // deep-link). Read whenever it changes, then clear the staging slot so
  // re-entering Settings normally doesn't snap back to it. The setState is
  // deferred via queueMicrotask so it doesn't run synchronously in the effect
  // body (repo lint: react-hooks/set-state-in-effect).
  const pendingTab = state.pendingSettingsTab;
  useEffect(() => {
    if (!pendingTab) return;
    queueMicrotask(() => {
      if (TABS.some((t) => t.value === pendingTab)) {
        setActiveTab(pendingTab);
      }
      dispatch({ type: 'SET_SETTINGS_TAB', tab: undefined });
    });
  }, [pendingTab, dispatch]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleTabs = useMemo(
    () => TABS.filter((t) => matchesQuery(t, normalizedQuery)),
    [normalizedQuery],
  );

  // Radix needs a valid active value. When the query filters the active tab
  // out, fall back to the first still-visible tab — DERIVED during render (no
  // effect / extra setState) so a hidden active tab never leaves Radix with an
  // orphaned value. `activeTab` (the user's last explicit pick) is preserved
  // and restored automatically once the query stops hiding it.
  const effectiveTab =
    visibleTabs.length === 0 || visibleTabs.some((t) => t.value === activeTab)
      ? activeTab
      : visibleTabs[0]!.value;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-3 text-sm">
        <Settings className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold tracking-tight">Settings</h2>
        <span className="ml-2 hidden truncate text-xs text-muted-foreground sm:inline">
          Theme, providers, and MCP services.
        </span>
        <div className="relative ml-auto w-48">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="h-8 pl-7 text-xs"
          />
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="sl-fade-in flex h-full min-h-0 flex-col overflow-hidden">
          <Tabs
            value={effectiveTab}
            onValueChange={setActiveTab}
            className="flex h-full min-h-0 flex-col"
          >
            <TabsList className="mx-4 mt-3 flex flex-wrap self-start">
              {visibleTabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {visibleTabs.length === 0 ? (
              <div className="px-4 pt-6 text-xs text-muted-foreground">
                No settings match “{query.trim()}”.
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
              <TabsContent value="appearance" className="mt-0">
                <AppearanceTab />
              </TabsContent>
              <TabsContent value="providers" className="mt-0">
                <ProvidersTab />
              </TabsContent>
              <TabsContent value="mcp" className="mt-0">
                <McpServersTab />
              </TabsContent>
              <TabsContent value="voice" className="mt-0">
                <VoiceTab />
              </TabsContent>
              <TabsContent value="notifications" className="mt-0">
                <NotificationsSettings />
              </TabsContent>
              <TabsContent value="ruflo" className="mt-0">
                <RufloSettings />
              </TabsContent>
              <TabsContent value="updates" className="mt-0">
                <UpdatesTab />
              </TabsContent>
              <TabsContent value="sync" className="mt-0">
                <SyncTab />
              </TabsContent>
              <TabsContent value="telegram" className="mt-0">
                <TelegramTab />
              </TabsContent>
              <TabsContent value="storage" className="mt-0">
                <StorageTab />
              </TabsContent>
              <TabsContent value="maintenance" className="mt-0">
                <MaintenanceTab />
              </TabsContent>
              <TabsContent value="diagnostics" className="mt-0">
                <DiagnosticsTab />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
