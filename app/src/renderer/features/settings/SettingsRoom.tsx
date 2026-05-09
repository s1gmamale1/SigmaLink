// Settings room — three tabs (Appearance, Providers, MCP servers). Replaces
// the Phase 1 placeholder. The shadcn Tabs primitive handles state; each tab
// component is self-contained and runs its own lazy data fetches.

import { Settings } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RoomChrome } from '@/renderer/components/RoomChrome';
import { AppearanceTab } from './AppearanceTab';
import { ProvidersTab } from './ProvidersTab';
import { McpServersTab } from './McpServersTab';
import { DiagnosticsTab } from './DiagnosticsTab';
import { UpdatesTab } from './UpdatesTab';

export function SettingsRoom() {
  return (
    <RoomChrome icon={Settings} title="Settings" subtitle="Theme, providers, and MCP services.">
      <div className="sl-fade-in flex h-full min-h-0 flex-col overflow-hidden">
        <Tabs defaultValue="appearance" className="flex h-full min-h-0 flex-col">
          <TabsList className="mx-4 mt-3 self-start">
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="mcp">MCP servers</TabsTrigger>
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
            <TabsContent value="updates" className="mt-0">
              <UpdatesTab />
            </TabsContent>
            <TabsContent value="diagnostics" className="mt-0">
              <DiagnosticsTab />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </RoomChrome>
  );
}
