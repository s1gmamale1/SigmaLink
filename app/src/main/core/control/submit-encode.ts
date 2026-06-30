// src/main/core/control/submit-encode.ts
//
// Reliable prompt submit for agent TUIs. A single bulk write of `prompt + '\r'`
// trips the TUI's paste-burst detection (claude/codex buffer it as "[Pasted
// text]" and swallow the trailing CR), so the prompt is typed but never sent.
// We write the body, let it settle into a distinct PTY read, then write the
// submit byte separately. Provider-keyed so a future divergence is one line.

const SUBMIT_BYTE: Record<string, string> = {
  claude: '\r', codex: '\r', gemini: '\r', kimi: '\r', opencode: '\r',
};

export function submitByte(providerId: string): string {
  return SUBMIT_BYTE[providerId] ?? '\r';
}

const DEFAULT_SETTLE_MS = 80;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function submitPrompt(
  write: (s: string) => void,
  providerId: string,
  prompt: string,
  opts?: { settleMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  write(prompt);
  await (opts?.sleep ?? realSleep)(opts?.settleMs ?? DEFAULT_SETTLE_MS);
  write(submitByte(providerId));
}
