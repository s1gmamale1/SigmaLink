// Telegram Bot API client for R-1 Jorvis Remote.
//
// Outbound-only to api.telegram.org — no inbound HTTP server.
// Uses node `fetch` (or an injected stand-in for tests) to:
//   - Long-poll `getUpdates` (timeout=50s) with offset tracking.
//   - Parse `message` and `callback_query` updates and route them.
//   - Answer callback queries so Telegram removes the loading spinner.
//   - Send text messages and confirm-dialogs with inline keyboards.
//
// Dependency-injected so the unit tests never touch the real network.

const API_BASE = 'https://api.telegram.org';

/** Back-off configuration for the long-poll loop. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

// ─── Public interfaces ───────────────────────────────────────────────────────

export interface TelegramUpdateHandlers {
  onMessage: (m: { chatId: number; text: string }) => void;
  onCallback: (c: { chatId: number; data: string; messageId: number }) => void;
}

export interface TelegramClient {
  /** Begins the getUpdates long-poll loop. Idempotent if already running. */
  start(handlers: TelegramUpdateHandlers): void;
  /** Aborts the loop. Safe to call before start(). */
  stop(): void;
  /**
   * Sends a text message. Returns the Telegram message_id of the sent message.
   * @param parseMode Defaults to 'HTML' if omitted.
   */
  sendMessage(
    chatId: number,
    text: string,
    opts?: { parseMode?: 'HTML' },
  ): Promise<number>;
  /**
   * Sends a message with an inline keyboard [✅ Confirm][✖ Cancel].
   * callback_data: 'confirm' or 'cancel'.
   */
  sendConfirm(
    chatId: number,
    prompt: string,
  ): Promise<{ messageId: number }>;
}

export interface TelegramClientDeps {
  fetch: typeof fetch;
  getToken: () => string;
}

// ─── Telegram API response shapes (minimal subset we use) ───────────────────

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TgMessage {
  message_id: number;
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

// ─── Implementation ──────────────────────────────────────────────────────────

export function createTelegramClient(deps: TelegramClientDeps): TelegramClient {
  const { fetch: fetchFn, getToken } = deps;

  let running = false;
  let abortController: AbortController | null = null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function apiUrl(method: string): string {
    return `${API_BASE}/bot${getToken()}/${method}`;
  }

  async function callApi<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetchFn(apiUrl(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as TgResponse<T>;
    if (!json.ok) {
      throw new Error(`Telegram API error [${method}]: ${json.description ?? 'unknown'}`);
    }
    return json.result as T;
  }

  // ── Public methods ─────────────────────────────────────────────────────────

  function start(handlers: TelegramUpdateHandlers): void {
    if (running) return;
    running = true;
    abortController = new AbortController();
    void pollLoop(handlers, abortController.signal);
  }

  function stop(): void {
    running = false;
    abortController?.abort();
    abortController = null;
  }

  async function sendMessage(
    chatId: number,
    text: string,
    opts: { parseMode?: 'HTML' } = {},
  ): Promise<number> {
    const result = await callApi<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode ?? 'HTML',
    });
    return result.message_id;
  }

  async function sendConfirm(
    chatId: number,
    prompt: string,
  ): Promise<{ messageId: number }> {
    const result = await callApi<TgMessage>('sendMessage', {
      chat_id: chatId,
      text: prompt,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Confirm', callback_data: 'confirm' },
            { text: '✖ Cancel',  callback_data: 'cancel' },
          ],
        ],
      },
    });
    return { messageId: result.message_id };
  }

  // ── Long-poll loop ─────────────────────────────────────────────────────────

  async function pollLoop(
    handlers: TelegramUpdateHandlers,
    signal: AbortSignal,
  ): Promise<void> {
    let offset = 0;
    let backoff = BACKOFF_BASE_MS;

    while (running && !signal.aborted) {
      try {
        const updates = await callApi<TgUpdate[]>(
          'getUpdates',
          { timeout: 50, offset, allowed_updates: ['message', 'callback_query'] },
          signal,
        );

        if (signal.aborted) break;

        for (const update of updates) {
          // Advance offset past this update regardless of how we handle it.
          if (update.update_id >= offset) {
            offset = update.update_id + 1;
          }

          if (update.message) {
            const { message } = update;
            const text = message.text ?? '';
            handlers.onMessage({ chatId: message.chat.id, text });
          } else if (update.callback_query) {
            const cq = update.callback_query;
            const chatId = cq.message?.chat.id ?? 0;
            const messageId = cq.message?.message_id ?? 0;
            const data = cq.data ?? '';

            // Answer the callback query to clear Telegram's loading indicator.
            // Best-effort — we don't await so a failure here can't block the loop.
            void callApi('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {
              /* ignore */
            });

            handlers.onCallback({ chatId, data, messageId });
          }
        }

        // Successful poll — reset backoff.
        backoff = BACKOFF_BASE_MS;
      } catch (err) {
        if (signal.aborted) break;

        // Abort errors are expected on stop() — exit cleanly.
        if (err instanceof Error && err.name === 'AbortError') break;

        // Any other error: wait with exponential backoff then retry.
        console.error('[telegram-client] poll error, retrying after', backoff, 'ms:', err);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
      }
    }
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  return { start, stop, sendMessage, sendConfirm };
}
