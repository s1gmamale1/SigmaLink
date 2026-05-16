// V1.1 — SigmaVoice intent dispatcher.
//
// Classifies a finalised transcript into one of five intents (4 regex rules +
// free-text fallback) and routes it to the matching controller. The classifier
// is pure — it never throws and never mutates state, so it can be unit tested
// without spinning up the IPC stack. Side-effects happen in `dispatch()`.
//
// Source: docs/04-design/sigmavoice-native-mac.md §5.

export type IntentKind =
  | 'create_swarm'
  | 'app.navigate'
  | 'swarms.broadcast'
  | 'swarms.rollCall'
  | 'assistant.freeform';

export interface ClassifiedIntent {
  intent: IntentKind;
  /** Raw transcript as classified — useful for telemetry. */
  raw: string;
  /** Args object handed to the controller. Shape varies per intent. */
  args: Record<string, unknown>;
  /** Stable label used for the dispatch-echo toast ("Routing → swarm…"). */
  controller: string;
}

const SWARM_ROLES = [
  'coder',
  'tester',
  'reviewer',
  'coordinator',
  'builder',
  'scout',
] as const;

const NAVIGATE_TARGETS = [
  'swarm',
  'browser',
  'review',
  'tasks',
  'memory',
  'operator',
  'workspaces',
  'command',
  'sigma',
  'skills',
  'settings',
] as const;

// Word-number map for "spawn three coders" style utterances. Speech.framework
// commonly returns digits ("3 coders") but Web Speech and on-device 13+ also
// emit the word form, so we accept both.
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  a: 1, an: 1, // "spawn a coder"
};

const RE_CREATE_SWARM =
  /^(?:please\s+)?(?:spawn|launch|create|start)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an)?\s*(coder|tester|reviewer|coordinator|builder|scout)s?\b/i;

const RE_NAVIGATE =
  /^(?:open|navigate to|switch to|go to|show)\s+(?:the\s+)?(swarm|browser|review|tasks|memory|operator|workspaces|command|sigma|skills|settings)\b/i;

const RE_BROADCAST =
  /^(?:send|broadcast|tell)\s+["'](.+?)["'](?:\s+to\s+(\w+))?\s*$/i;

const RE_ROLL_CALL =
  /^(?:roll\s+call|status\s+check|who'?s\s+running|who\s+is\s+running)\b/i;

/**
 * Classify a transcript without invoking any side-effects. Returns
 * `assistant.freeform` for empty input as well — the caller can choose to
 * suppress the dispatch when the body is blank.
 */
export function classify(transcript: string): ClassifiedIntent {
  const raw = (transcript ?? '').trim();
  if (raw.length === 0) {
    return {
      intent: 'assistant.freeform',
      raw,
      args: { text: '' },
      controller: 'assistant.send',
    };
  }

  const create = RE_CREATE_SWARM.exec(raw);
  if (create) {
    const countToken = (create[1] ?? '').toLowerCase();
    const role = create[2].toLowerCase();
    const numeric = Number.parseInt(countToken, 10);
    const count = Number.isFinite(numeric) && numeric > 0
      ? numeric
      : NUMBER_WORDS[countToken] ?? 1;
    return {
      intent: 'create_swarm',
      raw,
      args: { count, role },
      controller: 'swarms.create',
    };
  }

  const navigate = RE_NAVIGATE.exec(raw);
  if (navigate) {
    const pane = navigate[1].toLowerCase();
    return {
      intent: 'app.navigate',
      raw,
      args: { pane },
      controller: 'app.navigate',
    };
  }

  const broadcast = RE_BROADCAST.exec(raw);
  if (broadcast) {
    const message = broadcast[1];
    const target = broadcast[2]?.toLowerCase();
    return {
      intent: 'swarms.broadcast',
      raw,
      args: target ? { message, target } : { message },
      controller: 'swarms.broadcast',
    };
  }

  if (RE_ROLL_CALL.test(raw)) {
    return {
      intent: 'swarms.rollCall',
      raw,
      args: {},
      controller: 'swarms.rollCall',
    };
  }

  return {
    intent: 'assistant.freeform',
    raw,
    args: { text: raw },
    controller: 'assistant.send',
  };
}

/**
 * Helper: flatten the role list for tests + future autocomplete UIs.
 * Exported so the test file does not have to duplicate the literal.
 */
export function listSwarmRoles(): readonly string[] {
  return SWARM_ROLES;
}

export function listNavigateTargets(): readonly string[] {
  return NAVIGATE_TARGETS;
}

// ─── Routing ────────────────────────────────────────────────────────────────

export interface DispatchDeps {
  /** Broadcast `voice:dispatch-echo` so VoicePill can show a routing toast. */
  emit: (event: string, payload: unknown) => void;
  /** Optional active workspaceId for free-text turns; passed to assistant.send. */
  resolveWorkspaceId?: () => string | null;
  /** Optional active swarmId so broadcast / roll-call resolve a target. */
  resolveSwarmId?: () => string | null;
  /**
   * Controllers — supplied by the adapter. Each is called only for the
   * intent that matches its row in the table; missing handlers degrade
   * gracefully (free-text fallback ALWAYS resolves so unrecognised speech
   * still surfaces in the assistant pane).
   */
  controllers: {
    swarmCreate?: (args: { count: number; role: string }) => Promise<unknown>;
    swarmBroadcast?: (args: { swarmId: string; body: string }) => Promise<unknown>;
    swarmRollCall?: (args: { swarmId: string }) => Promise<unknown>;
    assistantSend?: (args: { workspaceId: string; prompt: string }) => Promise<unknown>;
    /** Renderer-side navigation: emits an `app:navigate` event. */
    appNavigate?: (args: { pane: string }) => void;
  };
}

export interface DispatchResult {
  intent: IntentKind;
  controller: string;
  ok: boolean;
  /** Human-readable reason when `ok=false`. Empty string on success. */
  reason: string;
}

/**
 * Run the classifier and route the resolved intent. The function NEVER
 * throws — every failure mode resolves to `{ ok: false, reason }` so the
 * adapter can finish the dispatch state machine cleanly.
 */
export async function dispatch(
  transcript: string,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const classified = classify(transcript);
  // Always emit the echo so the renderer can toast even when routing fails.
  try {
    deps.emit('voice:dispatch-echo', {
      intent: classified.intent,
      controller: classified.controller,
      args: classified.args,
      raw: classified.raw,
    });
  } catch {
    /* fire-and-forget */
  }

  switch (classified.intent) {
    case 'create_swarm': {
      const fn = deps.controllers.swarmCreate;
      if (!fn) {
        return notRouted(classified, 'swarms.create handler not wired');
      }
      try {
        await fn(classified.args as { count: number; role: string });
        return ok(classified);
      } catch (err) {
        return failed(classified, err);
      }
    }
    case 'swarms.broadcast': {
      const fn = deps.controllers.swarmBroadcast;
      const swarmId = deps.resolveSwarmId?.() ?? null;
      if (!fn || !swarmId) {
        return notRouted(
          classified,
          !swarmId ? 'no active swarm' : 'swarms.broadcast not wired',
        );
      }
      try {
        await fn({ swarmId, body: String(classified.args.message ?? '') });
        return ok(classified);
      } catch (err) {
        return failed(classified, err);
      }
    }
    case 'swarms.rollCall': {
      const fn = deps.controllers.swarmRollCall;
      const swarmId = deps.resolveSwarmId?.() ?? null;
      if (!fn || !swarmId) {
        return notRouted(
          classified,
          !swarmId ? 'no active swarm' : 'swarms.rollCall not wired',
        );
      }
      try {
        await fn({ swarmId });
        return ok(classified);
      } catch (err) {
        return failed(classified, err);
      }
    }
    case 'app.navigate': {
      const fn = deps.controllers.appNavigate;
      if (!fn) return notRouted(classified, 'app.navigate not wired');
      try {
        fn({ pane: String(classified.args.pane ?? '') });
        return ok(classified);
      } catch (err) {
        return failed(classified, err);
      }
    }
    case 'assistant.freeform':
    default: {
      const fn = deps.controllers.assistantSend;
      const workspaceId = deps.resolveWorkspaceId?.() ?? null;
      if (!fn || !workspaceId) {
        return notRouted(
          classified,
          !workspaceId ? 'no active workspace' : 'assistant.send not wired',
        );
      }
      try {
        await fn({ workspaceId, prompt: classified.raw });
        return ok(classified);
      } catch (err) {
        return failed(classified, err);
      }
    }
  }
}

function ok(c: ClassifiedIntent): DispatchResult {
  return { intent: c.intent, controller: c.controller, ok: true, reason: '' };
}

function notRouted(c: ClassifiedIntent, reason: string): DispatchResult {
  return { intent: c.intent, controller: c.controller, ok: false, reason };
}

function failed(c: ClassifiedIntent, err: unknown): DispatchResult {
  const message = err instanceof Error ? err.message : String(err);
  return { intent: c.intent, controller: c.controller, ok: false, reason: message };
}
