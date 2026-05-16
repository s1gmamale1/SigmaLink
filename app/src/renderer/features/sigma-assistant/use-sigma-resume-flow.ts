import { useCallback, useMemo, useState } from 'react';
import type { ChatMessageView } from './ChatTranscript';

const IN_FLIGHT_TOOL_PREFIX = 'sigma-in-flight:';

function isInFlightToolCall(toolCallId?: string | null): boolean {
  return typeof toolCallId === 'string' && toolCallId.startsWith(IN_FLIGHT_TOOL_PREFIX);
}

export interface InterruptedTurn {
  messageId: string;
  previousPrompt: string | null;
  startedAt: number;
}

function findInterruptedTurn(
  messages: ChatMessageView[],
  dismissedIds: Set<string>,
): InterruptedTurn | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isInFlightToolCall(message.toolCallId) || dismissedIds.has(message.id)) continue;
    const resultFollows = messages.slice(i + 1).some((later) => (
      later.role === 'assistant'
      && !isInFlightToolCall(later.toolCallId)
      && later.content.trim().length > 0
    ));
    if (resultFollows) continue;
    const previousUser = messages
      .slice(0, i)
      .reverse()
      .find((row) => row.role === 'user' && row.content.trim().length > 0);
    return {
      messageId: message.id,
      previousPrompt: previousUser?.content ?? null,
      startedAt: message.createdAt,
    };
  }
  return null;
}

export interface UseSigmaResumeFlowReturn {
  interruptedTurn: InterruptedTurn | null;
  dismissInterrupted: (messageId: string) => void;
  resetDismissed: () => void;
}

export function useSigmaResumeFlow(messages: ChatMessageView[]): UseSigmaResumeFlowReturn {
  const [dismissedInterruptedIds, setDismissedInterruptedIds] = useState<Set<string>>(
    () => new Set(),
  );

  const interruptedTurn = useMemo(
    () => findInterruptedTurn(messages, dismissedInterruptedIds),
    [messages, dismissedInterruptedIds],
  );

  const dismissInterrupted = useCallback((messageId: string) => {
    setDismissedInterruptedIds((ids) => {
      const next = new Set(ids);
      next.add(messageId);
      return next;
    });
  }, []);

  const resetDismissed = useCallback(() => {
    setDismissedInterruptedIds(new Set());
  }, []);

  return { interruptedTurn, dismissInterrupted, resetDismissed };
}
