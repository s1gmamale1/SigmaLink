// Settings room — three tabs (Appearance, Providers, MCP servers). Replaces
// the Phase 1 placeholder. The shadcn Tabs primitive handles state; each tab
// component is self-contained and runs its own lazy data fetches.
//
// Chrome (header strip + body container) is inlined here — it was previously
// in <RoomChrome>, but Settings was the only caller, so the wrapper was
// removed in the v1.1.10 dead-code sweep.

import { Settings } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AppearanceTab } from './AppearanceTab';
import { ProvidersTab } from './ProvidersTab';
import { McpServersTab } from './McpServersTab';
import { DiagnosticsTab } from './DiagnosticsTab';
import { UpdatesTab } from './UpdatesTab';
import { RufloSettings } from './RufloSettings';
import { VoiceTab } from './VoiceTab';

export function SettingsRoom() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-3 text-sm">
        <Settings className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold tracking-tight">Settings</h2>
        <span className="ml-2 truncate text-xs text-muted-foreground">
          Theme, providers, and MCP services.
        </span>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="sl-fade-in flex h-full min-h-0 flex-col overflow-hidden">
          <Tabs defaultValue="appearance" className="flex h-full min-h-0 flex-col">
            <TabsList className="mx-4 mt-3 self-start">
              <TabsTrigger value="appearance">Appearance</TabsTrigger>
              <TabsTrigger value="providers">Providers</TabsTrigger>
              <TabsTrigger value="mcp">MCP servers</TabsTrigger>
              <TabsTrigger value="voice">Voice</TabsTrigger>
              <TabsTrigger value="ruflo">Ruflo</TabsTrigger>
              <TabsTrigger value="updates">Updates</TabsTrigger>
              <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
            </TabsList>
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
              <TabsContent value="ruflo" className="mt-0">
                <RufloSettings />
              </TabsContent>
              <TabsContent value="updates" className="mt-0">
                <UpdatesTab />
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
