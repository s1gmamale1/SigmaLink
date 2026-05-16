import { Bot, ChevronDown, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ConversationListRow } from './use-sigma-conversations';

interface Props {
  conversations: ConversationListRow[];
  activeConversation: ConversationListRow | null;
  conversationId: string | null;
  onPick: (id: string) => void;
}

export function SigmaRailDropdown({ conversations, activeConversation, conversationId, onPick }: Props) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-2">
      <Bot className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 rounded px-1.5 py-1 text-left text-xs transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Conversation menu"
            title="Conversation menu"
          >
            <span className="min-w-0 flex-1 truncate font-medium">
              {activeConversation?.title ?? 'New conversation'}
            </span>
            {activeConversation?.claudeSessionId ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                <RotateCcw className="h-2.5 w-2.5" aria-hidden />
                Resumable
              </span>
            ) : null}
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="w-72">
          {conversations.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              No saved conversations
            </DropdownMenuItem>
          ) : null}
          {conversations.map((row) => (
            <DropdownMenuItem
              key={row.id}
              onSelect={() => onPick(row.id)}
              className={cn(
                'flex items-center gap-2 text-xs',
                row.id === conversationId && 'bg-accent/40 text-accent-foreground',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              {row.claudeSessionId ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  <RotateCcw className="h-2.5 w-2.5" aria-hidden />
                  Resumable
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
