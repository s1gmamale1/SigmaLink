// SIGMA:: thin protocol shared by the swarm watcher and operator helpers.
//
// Wire format: any line on a swarm-agent's PTY stdout that begins with
// `SIGMA::` followed by a verb and a JSON body is parsed as a structured
// envelope. Anything else is normal terminal output and stays in the existing
// PTY ring buffer (we do NOT duplicate it into the mailbox).

import type { SwarmMessage, SwarmMessageKind } from '../../../shared/types';

export const PROTOCOL_PREFIX = 'SIGMA::';

export const PROTOCOL_VERBS = [
  'SAY',
  'ACK',
  'STATUS',
  'DONE',
  'ROLLCALL',
  'ROLLCALL_REPLY',
  'OPERATOR',
  'SYSTEM',
] as const;

export type ProtocolVerb = (typeof PROTOCOL_VERBS)[number];

export interface ProtocolParse {
  verb: ProtocolVerb;
  payload: Record<string, unknown>;
}

const VERB_SET = new Set<string>(PROTOCOL_VERBS);

/**
 * Parse a single line. Returns null if the line does not start with SIGMA::,
 * the verb is not recognised, or the JSON body is invalid. Lines without a
 * JSON body are tolerated and treated as `{}`.
 */
export function parseProtocolLine(raw: string): ProtocolParse | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trimEnd();
  if (!trimmed.startsWith(PROTOCOL_PREFIX)) return null;
  const rest = trimmed.slice(PROTOCOL_PREFIX.length).trimStart();
  // Find the first whitespace that splits VERB from optional JSON.
  const ws = rest.search(/\s/);
  let verbToken: string;
  let jsonBody: string;
  if (ws === -1) {
    verbToken = rest;
    jsonBody = '';
  } else {
    verbToken = rest.slice(0, ws);
    jsonBody = rest.slice(ws + 1).trim();
  }
  const verb = verbToken.toUpperCase();
  if (!VERB_SET.has(verb)) return null;
  if (!jsonBody) {
    return { verb: verb as ProtocolVerb, payload: {} };
  }
  try {
    const parsed = JSON.parse(jsonBody);
    if (!parsed || typeof parsed !== 'object') return null;
    return { verb: verb as ProtocolVerb, payload: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Stateful line buffer. Splits an incoming PTY chunk by newline and forwards
 * complete lines to a callback. The trailing partial line is held until more
 * data arrives.
 */
export class ProtocolLineBuffer {
  private acc = '';

  push(chunk: string, onLine: (line: string) => void): void {
    if (!chunk) return;
    this.acc += chunk;
    let nl = this.acc.indexOf('\n');
    while (nl !== -1) {
      const line = this.acc.slice(0, nl).replace(/\r$/, '');
      this.acc = this.acc.slice(nl + 1);
      onLine(line);
      nl = this.acc.indexOf('\n');
    }
  }

  flush(onLine: (line: string) => void): void {
    if (this.acc.length) {
      onLine(this.acc);
      this.acc = '';
    }
  }
}

export interface OperatorEnvelope {
  kind: SwarmMessageKind;
  toAgent: string;
  body: string;
  payload?: Record<string, unknown>;
}

/** Format the canonical operator broadcast envelope. */
export function formatBroadcast(body: string): OperatorEnvelope {
  return { kind: 'OPERATOR', toAgent: '*', body };
}

/** Format the canonical roll-call envelope. */
export function formatRollCall(deadlineMs = 60_000): OperatorEnvelope {
  return {
    kind: 'ROLLCALL',
    toAgent: '*',
    body: 'ROLL CALL — every agent, report status (current task, blockers, eta).',
    payload: { deadlineAt: Date.now() + deadlineMs },
  };
}

/**
 * Format a SIGMA::SAY line that the agent CLI will see when typed into its
 * stdin. Used for dual delivery: the mailbox stores the durable record while
 * the PTY input is what the LLM actually reads as user input.
 */
export function formatStdinDelivery(message: {
  fromAgent: string;
  toAgent: string;
  body: string;
  kind?: SwarmMessageKind;
}): string {
  const verb = (message.kind ?? 'OPERATOR').toUpperCase();
  const json = JSON.stringify({
    from: message.fromAgent,
    to: message.toAgent,
    body: message.body,
  });
  return `${PROTOCOL_PREFIX}${verb} ${json}\n`;
}

/**
 * Coerce a parsed protocol envelope into a SwarmMessage we can persist. The
 * `to` field falls back to "operator" for STATUS/DONE/ACK so the operator
 * always receives those replies.
 */
export function envelopeToInsert(
  swarmId: string,
  fromAgent: string,
  parsed: ProtocolParse,
): {
  swarmId: string;
  fromAgent: string;
  toAgent: string;
  kind: SwarmMessageKind;
  body: string;
  payload?: Record<string, unknown>;
} {
  const p = parsed.payload;
  const to = typeof p.to === 'string' && p.to.trim().length > 0 ? p.to : 'operator';
  const body = typeof p.body === 'string' ? p.body : JSON.stringify(p);
  const kind = parsed.verb as SwarmMessageKind;
  return { swarmId, fromAgent, toAgent: to, kind, body, payload: p };
}

/** Helper for SwarmMessage projection in tests / debug. */
export function summarise(message: SwarmMessage): string {
  const head = `${message.kind} ${message.fromAgent}→${message.toAgent}`;
  const tail = message.body.length > 80 ? message.body.slice(0, 77) + '...' : message.body;
  return `${head}: ${tail}`;
}
