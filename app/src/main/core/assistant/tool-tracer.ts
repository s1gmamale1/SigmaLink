// V3-W13-013 — Bridge Assistant tool-trace bus. Each call records a small
// JSON-serialisable record + emits an `assistant:tool-trace` event so the
// renderer's ToolCallInspector can stream the trace. Ring buffer caps memory.

export interface ToolTrace {
  id: string;
  conversationId: string | null;
  name: string;
  startedAt: number;
  finishedAt: number;
  args: Record<string, unknown>;
  ok: boolean;
  result: unknown;
  error?: string;
}

const MAX_TRACES = 200;

type Emit = (event: string, payload: unknown) => void;

export class ToolTracer {
  private readonly buffer: ToolTrace[] = [];
  private emit: Emit = () => undefined;

  setEmitter(fn: Emit): void {
    this.emit = fn;
  }

  record(trace: ToolTrace): void {
    this.buffer.push(trace);
    if (this.buffer.length > MAX_TRACES) {
      this.buffer.splice(0, this.buffer.length - MAX_TRACES);
    }
    try {
      this.emit('assistant:tool-trace', trace);
    } catch {
      /* best-effort */
    }
  }

  list(): ToolTrace[] {
    return [...this.buffer];
  }
}

/** Coerce arbitrary values into a JSON-safe representation for tracing. */
export function safeSerialize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-cutoff]';
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => safeSerialize(v, depth + 1));
  }
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (i++ >= 50) {
        out['…truncated'] = true;
        break;
      }
      out[k] = safeSerialize(v, depth + 1);
    }
    return out;
  }
  return `[${t}]`;
}
