// V3-W13-005 — Operator Console constellation graph (canvas, hand-rolled).
// Reuses the spring + Coulomb-repulsion + centre-pull loop from
// MemoryGraph.tsx; nodes are agents, edges go coordinator→assignee. Pan via
// canvas drag, zoom via wheel (0.3x..3x), positions persist through
// `swarm.constellation-layout`. When `swarm_agents.coordinatorId` is missing
// (pre-W13-014), every non-coord falls back to the first coordinator hub.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Role, SwarmAgent } from '@/shared/types';
import { rpc } from '@/renderer/lib/rpc';
import type { AgentFilter } from './TopBar';
import type { ReplayFrame } from './ReplayScrubber';

interface Props {
  swarmId: string;
  agents: SwarmAgent[];
  filter: AgentFilter;
  /**
   * P3-S6 — when provided, render the historical agent roster from the replay
   * frame instead of the live state. Live behavior is unchanged when absent.
   */
  replayFrame?: ReplayFrame | null;
}

interface Node {
  id: string; // agentKey
  label: string;
  role: Role;
  status: SwarmAgent['status'];
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
}

interface Viewport {
  x: number; // pan offset in world units
  y: number;
  zoom: number;
}

interface PersistedLayout {
  positions: Record<string, { x: number; y: number }>;
  viewport?: Viewport;
}

const REST_LENGTH = 130;
const SPRING_K = 0.018;
const REPULSION = 4200;
const DAMPING = 0.82;
const CENTER_PULL = 0.0035;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;

// Role colour stripes — keep in sync with `--role-*` tokens in src/index.css
// (HSL approximations baked here so canvas paint doesn't read the DOM).
const ROLE_COLOR: Record<Role, string> = {
  coordinator: '#3b82f6',
  builder: '#a855f7',
  scout: '#22c55e',
  reviewer: '#f59e0b',
};

const STATUS_HALO: Record<SwarmAgent['status'], string> = {
  idle: 'rgba(160,160,170,0.45)',
  busy: 'rgba(99,179,237,0.65)',
  blocked: 'rgba(248,113,113,0.7)',
  done: 'rgba(74,222,128,0.7)',
  error: 'rgba(239,68,68,0.85)',
};

export function Constellation({
  swarmId,
  agents: liveAgents,
  filter,
  replayFrame,
}: Props) {
  // P3-S6 — historical replay mode. The replay manager returns a synthetic
  // agent roster (no live status); project it back into the SwarmAgent shape
  // so the existing physics + draw paths keep working unchanged.
  const agents: SwarmAgent[] = useMemo(() => {
    if (!replayFrame) return liveAgents;
    return replayFrame.agents.map((a) => ({
      id: a.id,
      swarmId: replayFrame.swarmId,
      role: (a.role as Role) ?? 'builder',
      roleIndex: a.roleIndex,
      providerId: a.providerId,
      sessionId: null,
      status: 'idle',
      inboxPath: '',
      agentKey: a.agentKey,
    }));
  }, [liveAgents, replayFrame]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef<Node[]>([]);
  const idIndex = useMemo(() => new Map<string, number>(), []);
  const sizeRef = useRef({ w: 600, h: 400 });
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const dragNodeRef = useRef<{ id: string; offX: number; offY: number } | null>(
    null,
  );
  const dragPanRef = useRef<{ startX: number; startY: number; vx: number; vy: number } | null>(
    null,
  );
  const dirtyRef = useRef<boolean>(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // ── Edges (Coordinator → assignees) ─────────────────────────────────────
  // Read `coordinatorId` defensively: it lands in a forthcoming wave; if
  // missing, fall back to the first coordinator (lexically lowest agentKey
  // by role-index). Coordinators among themselves are linked queen-bee
  // style so multi-coord presets still form a connected graph.
  const edges = useMemo(() => {
    const coords = agents
      .filter((a) => a.role === 'coordinator')
      .sort((a, b) => a.roleIndex - b.roleIndex);
    const queen = coords[0];
    const fallback = queen?.agentKey ?? null;
    const out: { from: string; to: string }[] = [];
    for (const a of agents) {
      const coordId = readCoordinatorId(a);
      const to = coordId ?? fallback;
      if (!to || to === a.agentKey) continue;
      out.push({ from: to, to: a.agentKey });
    }
    return out;
  }, [agents]);

  // ── Reconcile nodes when the agent roster changes ───────────────────────
  useEffect(() => {
    const oldById = new Map(nodesRef.current.map((n) => [n.id, n]));
    const next: Node[] = [];
    idIndex.clear();
    const cx = sizeRef.current.w / 2;
    const cy = sizeRef.current.h / 2;
    agents.forEach((a, i) => {
      const prev = oldById.get(a.agentKey);
      // Place coordinators near the centre, others on a ring around them so
      // the layout converges quickly.
      const angle = (i / Math.max(1, agents.length)) * Math.PI * 2;
      const r = a.role === 'coordinator' ? 30 : 160;
      const node: Node =
        prev ?? {
          id: a.agentKey,
          label: `${a.role.charAt(0).toUpperCase()}${a.role.slice(1)} ${a.roleIndex}`,
          role: a.role,
          status: a.status,
          x: cx + Math.cos(angle) * r + (Math.random() - 0.5) * 20,
          y: cy + Math.sin(angle) * r + (Math.random() - 0.5) * 20,
          vx: 0,
          vy: 0,
        };
      node.role = a.role;
      node.status = a.status;
      node.label = `${a.role.charAt(0).toUpperCase()}${a.role.slice(1)} ${a.roleIndex}`;
      idIndex.set(a.agentKey, next.length);
      next.push(node);
    });
    nodesRef.current = next;
  }, [agents, idIndex]);

  // ── Hydrate persisted layout (positions + viewport) on mount/swarm ─────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Side-band invoke — kv read isn't on the typed AppRouter, but the
        // controller exposes it. We tolerate failure silently.
        const raw = await rpc.kv.get(`swarm.constellation.${swarmId}`);
        if (cancelled || !raw || typeof raw !== 'string') return;
        const parsed = JSON.parse(raw) as PersistedLayout | Record<string, { x: number; y: number }>;
        const layout: PersistedLayout =
          'positions' in (parsed as Record<string, unknown>)
            ? (parsed as PersistedLayout)
            : { positions: parsed as Record<string, { x: number; y: number }> };
        for (const n of nodesRef.current) {
          const p = layout.positions[n.id];
          if (p && typeof p.x === 'number' && typeof p.y === 'number') {
            n.x = p.x;
            n.y = p.y;
            n.vx = 0;
            n.vy = 0;
          }
        }
        if (layout.viewport) viewportRef.current = layout.viewport;
      } catch {
        /* no layout yet — physics seeds from defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [swarmId]);

  // ── Resize observer keeps canvas matched to container ──────────────────
  useEffect(() => {
    const el = containerRef.current;
    const cv = canvasRef.current;
    if (!el || !cv) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.floor(rect.width * dpr);
      cv.height = Math.floor(rect.height * dpr);
      cv.style.width = rect.width + 'px';
      cv.style.height = rect.height + 'px';
      sizeRef.current = { w: rect.width, h: rect.height };
      const ctx = cv.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Animation loop ─────────────────────────────────────────────────────
  // Hooks lint complains about `step`/`draw` accessed before declaration —
  // they're declared via useCallback below and only invoked from within the
  // RAF callback after the component is mounted, so the runtime ordering is
  // fine. Disable the false-positive rule locally.
  /* eslint-disable react-hooks/immutability, react-hooks/exhaustive-deps */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const tick = () => {
      step();
      draw(ctx);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [agents, edges, filter]);
  /* eslint-enable react-hooks/immutability, react-hooks/exhaustive-deps */

  const step = useCallback(() => {
    const nodes = nodesRef.current;
    const { w, h } = sizeRef.current;
    const cx = w / 2;
    const cy = h / 2;

    // Repulsion (every pair).
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = Math.max(dx * dx + dy * dy, 1);
        const force = REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Spring (edges).
    for (const e of edges) {
      const ai = idIndex.get(e.from);
      const bi = idIndex.get(e.to);
      if (ai === undefined || bi === undefined) continue;
      const a = nodes[ai];
      const b = nodes[bi];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const diff = dist - REST_LENGTH;
      const fx = (dx / dist) * diff * SPRING_K;
      const fy = (dy / dist) * diff * SPRING_K;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Centre pull + integrate.
    for (const n of nodes) {
      n.vx += (cx - n.x) * CENTER_PULL;
      n.vy += (cy - n.y) * CENTER_PULL;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      if (n.fx !== undefined && n.fy !== undefined) {
        n.x = n.fx;
        n.y = n.fy;
        n.vx = 0;
        n.vy = 0;
      } else {
        n.x += n.vx;
        n.y += n.vy;
      }
    }
  }, [edges, idIndex]);

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);
      const vp = viewportRef.current;
      ctx.save();
      ctx.translate(vp.x, vp.y);
      ctx.scale(vp.zoom, vp.zoom);

      const nodes = nodesRef.current;

      // Edges with a soft glow.
      ctx.strokeStyle = 'rgba(120,140,200,0.4)';
      ctx.lineWidth = 1.2 / vp.zoom;
      for (const e of edges) {
        const ai = idIndex.get(e.from);
        const bi = idIndex.get(e.to);
        if (ai === undefined || bi === undefined) continue;
        const a = nodes[ai];
        const b = nodes[bi];
        if (!visibleByFilter(filter, a.role) && !visibleByFilter(filter, b.role)) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // Nodes.
      for (const n of nodes) {
        const muted = !visibleByFilter(filter, n.role);
        const r = n.role === 'coordinator' ? 14 : 10;
        // Status halo.
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = muted ? 'rgba(120,120,120,0.15)' : STATUS_HALO[n.status];
        ctx.fill();
        // Role-coloured fill.
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = muted ? '#222' : ROLE_COLOR[n.role];
        ctx.fill();
        // Role stripe — narrow ring above the node.
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, Math.PI, 2 * Math.PI);
        ctx.lineWidth = 3 / vp.zoom;
        ctx.strokeStyle = muted ? '#444' : '#fff';
        ctx.stroke();

        const isHover = hoverId === n.id;
        if (isHover || n.role === 'coordinator') {
          ctx.fillStyle = muted ? '#888' : '#f8fafc';
          ctx.font = `${isHover ? '12px' : '10px'} ui-sans-serif, system-ui`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(n.label, n.x, n.y + r + 4);
        }
      }

      ctx.restore();
    },
    [edges, filter, hoverId, idIndex],
  );

  // ── Hit testing in world coordinates ───────────────────────────────────
  const screenToWorld = useCallback(
    (x: number, y: number): { x: number; y: number } => {
      const vp = viewportRef.current;
      return { x: (x - vp.x) / vp.zoom, y: (y - vp.y) / vp.zoom };
    },
    [],
  );

  const hitTest = useCallback(
    (x: number, y: number): Node | null => {
      const wpt = screenToWorld(x, y);
      const nodes = nodesRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const r = n.role === 'coordinator' ? 14 : 10;
        const dx = wpt.x - n.x;
        const dy = wpt.y - n.y;
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    },
    [screenToWorld],
  );

  // ── Persistence (debounced) ─────────────────────────────────────────────
  const schedulePersist = useCallback(() => {
    dirtyRef.current = true;
    if (persistTimerRef.current) return;
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      const positions: Record<string, { x: number; y: number }> = {};
      for (const n of nodesRef.current) {
        positions[n.id] = { x: n.x, y: n.y };
      }
      const payload: PersistedLayout = { positions, viewport: viewportRef.current };
      // Side-band invoke (swarm.* not on AppRouter). Viewport rides as
      // `__viewport` so the existing console-controller schema stays valid;
      // the kv blob is what we re-read on hydrate.
      try {
        void window.sigma
          .invoke('swarm.constellation-layout', {
            swarmId,
            nodePositions: positions,
            __viewport: payload.viewport,
          })
          .catch(() => undefined);
      } catch {
        /* no preload — swallow */
      }
    }, 600);
  }, [swarmId]);

  // ── Pointer handlers ───────────────────────────────────────────────────
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const rect = cv.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const node = hitTest(sx, sy);
      cv.setPointerCapture(e.pointerId);
      if (node) {
        const wpt = screenToWorld(sx, sy);
        dragNodeRef.current = { id: node.id, offX: wpt.x - node.x, offY: wpt.y - node.y };
        node.fx = node.x;
        node.fy = node.y;
      } else {
        const vp = viewportRef.current;
        dragPanRef.current = { startX: sx, startY: sy, vx: vp.x, vy: vp.y };
      }
    },
    [hitTest, screenToWorld],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const rect = cv.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const dragNode = dragNodeRef.current;
      if (dragNode) {
        const wpt = screenToWorld(sx, sy);
        const idx = idIndex.get(dragNode.id);
        if (idx !== undefined) {
          const n = nodesRef.current[idx];
          n.fx = wpt.x - dragNode.offX;
          n.fy = wpt.y - dragNode.offY;
        }
        return;
      }
      const dragPan = dragPanRef.current;
      if (dragPan) {
        const vp = viewportRef.current;
        vp.x = dragPan.vx + (sx - dragPan.startX);
        vp.y = dragPan.vy + (sy - dragPan.startY);
        return;
      }
      const hit = hitTest(sx, sy);
      setHoverId(hit?.id ?? null);
    },
    [hitTest, idIndex, screenToWorld],
  );

  const onPointerUp = useCallback(
    () => {
      const dragNode = dragNodeRef.current;
      if (dragNode) {
        const idx = idIndex.get(dragNode.id);
        if (idx !== undefined) {
          const n = nodesRef.current[idx];
          n.fx = undefined;
          n.fy = undefined;
        }
        dragNodeRef.current = null;
        schedulePersist();
        return;
      }
      if (dragPanRef.current) {
        dragPanRef.current = null;
        schedulePersist();
      }
    },
    [idIndex, schedulePersist],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const cv = canvasRef.current;
      if (!cv) return;
      const rect = cv.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const vp = viewportRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = clamp(vp.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      // Zoom anchored on cursor: keep the world point under the cursor fixed.
      const before = { x: (sx - vp.x) / vp.zoom, y: (sy - vp.y) / vp.zoom };
      vp.zoom = next;
      vp.x = sx - before.x * vp.zoom;
      vp.y = sy - before.y * vp.zoom;
      schedulePersist();
    },
    [schedulePersist],
  );

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverId(null)}
        onWheel={onWheel}
        style={{ touchAction: 'none' }}
      />
      <div className="pointer-events-none absolute left-3 top-3 rounded bg-card/80 px-2 py-1 text-[11px] text-muted-foreground">
        {agents.length} agents · {edges.length} links
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function visibleByFilter(filter: AgentFilter, role: Role): boolean {
  if (filter === 'all') return true;
  if (filter === 'coordinators') return role === 'coordinator';
  if (filter === 'builders') return role === 'builder';
  if (filter === 'scouts') return role === 'scout';
  if (filter === 'reviewers') return role === 'reviewer';
  return true;
}

/**
 * Pull the optional `coordinatorId` field off a SwarmAgent without forcing
 * the shared type to declare it. The W13 migration adds the column on the
 * main side; the renderer-side `SwarmAgent` type is widened naturally
 * once the typed boundary catches up. Until then we read it defensively.
 */
function readCoordinatorId(agent: SwarmAgent): string | null {
  const a = agent as unknown as { coordinatorId?: unknown };
  if (typeof a.coordinatorId === 'string' && a.coordinatorId) return a.coordinatorId;
  return null;
}
