// Force-directed memory graph rendered to a canvas. We avoid `react-force-
// graph-2d` (~80kb gzip + d3 transitive deps) and roll a tiny spring layout:
//   • Hooke-spring attraction along edges (rest length = REST)
//   • Coulomb repulsion between every node pair (O(n^2); fine for ≤500
//     nodes — 1000+ should switch to Barnes-Hut, see follow-up note in
//     `W6-MEMORY-report.md`)
//   • Soft pull toward the canvas center to keep clusters on-screen
//
// Drag-to-move + click-to-select. Coordinates are stored independently
// from React state because every frame mutates them; we only call setState
// for the lightweight selection / hover overlay.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryGraph } from '@/shared/types';

interface Props {
  graph: MemoryGraph;
  onSelect(name: string): void;
}

interface Node {
  id: string;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  refCount: number;
  tagCount: number;
  fx?: number; // pinned x while dragging
  fy?: number;
}

const REST_LENGTH = 90;
const SPRING_K = 0.02;
const REPULSION = 1200;
const DAMPING = 0.85;
const CENTER_PULL = 0.005;

export function MemoryGraphView({ graph, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef<Node[]>([]);
  const idIndex = useMemo(() => {
    const m = new Map<string, number>();
    return m;
  }, []);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; offX: number; offY: number } | null>(null);
  const sizeRef = useRef({ w: 600, h: 400 });

  // Initialize / reconcile nodes when graph identity changes.
  useEffect(() => {
    const oldById = new Map(nodesRef.current.map((n) => [n.id, n]));
    const next: Node[] = [];
    idIndex.clear();
    const cx = sizeRef.current.w / 2;
    const cy = sizeRef.current.h / 2;
    graph.nodes.forEach((n, i) => {
      const prev = oldById.get(n.id);
      const node: Node = prev ?? {
        id: n.id,
        label: n.label,
        x: cx + Math.cos(i) * 80 + (Math.random() - 0.5) * 20,
        y: cy + Math.sin(i) * 80 + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
        refCount: n.refCount,
        tagCount: n.tagCount,
      };
      node.label = n.label;
      node.refCount = n.refCount;
      node.tagCount = n.tagCount;
      idIndex.set(n.id, next.length);
      next.push(node);
    });
    nodesRef.current = next;
  }, [graph, idIndex]);

  // ResizeObserver -> keep canvas matching its parent.
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
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Animation loop.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  const step = useCallback(() => {
    const nodes = nodesRef.current;
    const { w, h } = sizeRef.current;
    const cx = w / 2;
    const cy = h / 2;

    // Repulsion
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

    // Spring (edges)
    for (const e of graph.edges) {
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

    // Center pull + integrate
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
      // Clamp inside bounds (with margin).
      const m = 24;
      if (n.x < m) n.x = m;
      if (n.x > w - m) n.x = w - m;
      if (n.y < m) n.y = m;
      if (n.y > h - m) n.y = h - m;
    }
  }, [graph, idIndex]);

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);
      const nodes = nodesRef.current;
      // Edges
      ctx.strokeStyle = 'rgba(120,140,180,0.45)';
      ctx.lineWidth = 1;
      for (const e of graph.edges) {
        const ai = idIndex.get(e.from);
        const bi = idIndex.get(e.to);
        if (ai === undefined || bi === undefined) continue;
        const a = nodes[ai];
        const b = nodes[bi];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // Nodes
      for (const n of nodes) {
        const r = nodeRadius(n);
        const isHover = hoverId === n.id;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isHover ? '#f97316' : '#3b82f6';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isHover ? '#fff' : 'rgba(255,255,255,0.4)';
        ctx.stroke();

        if (isHover || r >= 8) {
          ctx.fillStyle = isHover ? '#fff' : '#cbd5e1';
          ctx.font = `${isHover ? '12px' : '10px'} ui-sans-serif, system-ui`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(n.label.length > 24 ? n.label.slice(0, 22) + '…' : n.label, n.x, n.y + r + 2);
        }
      }
    },
    [graph, hoverId, idIndex],
  );

  const hitTest = useCallback((x: number, y: number): Node | null => {
    const nodes = nodesRef.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const r = nodeRadius(n);
      const dx = x - n.x;
      const dy = y - n.y;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const node = hitTest(x, y);
      if (!node) return;
      cv.setPointerCapture(e.pointerId);
      dragRef.current = { id: node.id, offX: x - node.x, offY: y - node.y };
      node.fx = node.x;
      node.fy = node.y;
    },
    [hitTest],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const drag = dragRef.current;
      if (drag) {
        const idx = idIndex.get(drag.id);
        if (idx !== undefined) {
          const n = nodesRef.current[idx];
          n.fx = x - drag.offX;
          n.fy = y - drag.offY;
        }
      } else {
        const hit = hitTest(x, y);
        setHoverId(hit?.id ?? null);
      }
    },
    [hitTest, idIndex],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const drag = dragRef.current;
      if (drag) {
        const idx = idIndex.get(drag.id);
        if (idx !== undefined) {
          const n = nodesRef.current[idx];
          n.fx = undefined;
          n.fy = undefined;
        }
        const moved = Math.abs(x - (drag.offX + (idx !== undefined ? nodesRef.current[idx].x : 0))) > 4;
        dragRef.current = null;
        if (!moved) {
          const hit = hitTest(x, y);
          if (hit) onSelect(hit.label);
        }
      } else {
        const hit = hitTest(x, y);
        if (hit) onSelect(hit.label);
      }
    },
    [hitTest, idIndex, onSelect],
  );

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverId(null)}
        style={{ touchAction: 'none' }}
      />
      <div className="pointer-events-none absolute left-3 top-3 rounded bg-card/80 px-2 py-1 text-[11px] text-muted-foreground">
        {graph.nodes.length} notes · {graph.edges.length} links
      </div>
    </div>
  );
}

function nodeRadius(n: Node): number {
  return 6 + Math.min(8, n.refCount * 0.8);
}
