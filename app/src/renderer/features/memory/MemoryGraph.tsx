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
/* eslint-disable react-hooks/immutability */

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

// PERF-13 — "sleep on settle". Once the layout's total kinetic energy stays
// below ENERGY_EPSILON for SETTLE_FRAMES consecutive ticks we stop the RAF
// loop entirely; it restarts on interaction / data / resize. Avoids burning a
// core at 60fps redrawing a static graph.
const ENERGY_EPSILON = 0.05;
const SETTLE_FRAMES = 30;

// MEM-10 — theme-driven canvas colors. Resolved from CSS custom properties so
// the graph matches whatever theme is active (the FE-4 getComputedStyle
// pattern). Hex fallbacks keep it sane if a var is missing (e.g. in jsdom).
interface GraphColors {
  node: string;
  nodeHover: string;
  nodeStroke: string;
  nodeHoverStroke: string;
  edge: string;
  label: string;
  labelHover: string;
}

const FALLBACK_COLORS: GraphColors = {
  node: '#3b82f6',
  nodeHover: '#f97316',
  nodeStroke: 'rgba(255,255,255,0.4)',
  nodeHoverStroke: '#fff',
  edge: 'rgba(120,140,180,0.45)',
  label: '#cbd5e1',
  labelHover: '#fff',
};

// Theme vars are stored as raw HSL channels ("270 60% 55%") consumed via
// hsl(var(--x)); wrap them for canvas. `alpha` produces hsla(... / a).
function hslVar(root: CSSStyleDeclaration, name: string, fallback: string, alpha = 1): string {
  const raw = root.getPropertyValue(name).trim();
  if (!raw) return fallback;
  return alpha >= 1 ? `hsl(${raw})` : `hsl(${raw} / ${alpha})`;
}

/** Read the active theme's colors off the document root (re-read on change). */
export function resolveThemeColors(rootEl: HTMLElement | null): GraphColors {
  if (!rootEl || typeof getComputedStyle !== 'function') return FALLBACK_COLORS;
  const root = getComputedStyle(rootEl);
  return {
    node: hslVar(root, '--primary', FALLBACK_COLORS.node),
    nodeHover: hslVar(root, '--accent', FALLBACK_COLORS.nodeHover),
    nodeStroke: hslVar(root, '--border', FALLBACK_COLORS.nodeStroke, 0.6),
    nodeHoverStroke: hslVar(root, '--ring', FALLBACK_COLORS.nodeHoverStroke),
    edge: hslVar(root, '--muted-foreground', FALLBACK_COLORS.edge, 0.45),
    label: hslVar(root, '--muted-foreground', FALLBACK_COLORS.label),
    labelHover: hslVar(root, '--ring', FALLBACK_COLORS.labelHover),
  };
}

/** Total kinetic energy (Σ vx²+vy²). Used to decide when the layout settled. */
export function kineticEnergy(nodes: ReadonlyArray<{ vx: number; vy: number }>): number {
  let e = 0;
  for (const n of nodes) e += n.vx * n.vx + n.vy * n.vy;
  return e;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function MemoryGraphView({ graph, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef<Node[]>([]);
  const idIndex = useMemo(() => {
    const m = new Map<string, number>();
    return m;
  }, []);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Mirror hover into a ref so the (possibly slept) RAF loop / static draw can
  // read it without the effect re-subscribing on every hover change.
  const hoverIdRef = useRef<string | null>(null);
  hoverIdRef.current = hoverId;
  const dragRef = useRef<{ id: string; offX: number; offY: number } | null>(null);
  const sizeRef = useRef({ w: 600, h: 400 });

  // MEM-10 — cached theme colors, refreshed on the resize tick + theme change.
  const colorsRef = useRef<GraphColors>(FALLBACK_COLORS);
  // PERF-13 — RAF handle + "wake" trigger. `wakeRef` is filled by the
  // animation effect so pointer/resize/data handlers can restart a slept loop
  // without depending on render order.
  const rafRef = useRef(0);
  const wakeRef = useRef<() => void>(() => undefined);

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
      // MEM-10: re-read theme colors on the resize tick (also catches the
      // common "resize fires after ThemeProvider hydrates" timing).
      colorsRef.current = resolveThemeColors(document.documentElement);
      // PERF-13: a resize changes bounds → wake the layout to re-settle.
      wakeRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // MEM-10 — re-read colors when the theme changes (data-theme on <html>).
  useEffect(() => {
    const root = document.documentElement;
    colorsRef.current = resolveThemeColors(root);
    const mo = new MutationObserver(() => {
      colorsRef.current = resolveThemeColors(root);
      wakeRef.current(); // repaint with new colors even if layout is asleep
    });
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => mo.disconnect();
  }, []);

  // Animation loop (PERF-13: sleeps on settle, wakes on interaction/data/resize).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    // (b) prefers-reduced-motion: no loop at all. Settle once synchronously so
    // the static layout isn't a random scatter, then draw a single frame. A
    // JS/canvas RAF can't be stopped by the global CSS reduced-motion reset, so
    // we guard it here.
    if (prefersReducedMotion()) {
      for (let i = 0; i < 300 && kineticEnergy(nodesRef.current) > ENERGY_EPSILON; i++) {
        step();
      }
      // Ensure at least one settling pass even for an already-zero-velocity graph.
      step();
      draw(ctx);
      // Static mode still needs to react to interaction/data/theme: a wake
      // re-settles synchronously and redraws (no continuous animation).
      wakeRef.current = () => {
        if (rafRef.current) return; // a wake is already scheduled
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          step();
          draw(ctx);
        });
      };
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        wakeRef.current = () => undefined;
      };
    }

    let idleFrames = 0;
    const tick = () => {
      step();
      draw(ctx);
      // Energy-based settle detection.
      if (kineticEnergy(nodesRef.current) < ENERGY_EPSILON && !dragRef.current) {
        idleFrames += 1;
      } else {
        idleFrames = 0;
      }
      if (idleFrames >= SETTLE_FRAMES) {
        rafRef.current = 0; // sleep — wake() restarts us
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const start = () => {
      if (rafRef.current) return; // already running
      idleFrames = 0;
      rafRef.current = requestAnimationFrame(tick);
    };

    // Wake = nudge a little energy + (re)start the loop. Used by pointer,
    // resize and theme handlers so a slept layout reanimates on interaction.
    wakeRef.current = start;

    start();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      wakeRef.current = () => undefined;
    };
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
      const colors = colorsRef.current;
      // Edges
      ctx.strokeStyle = colors.edge;
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
      const activeHover = hoverIdRef.current;
      for (const n of nodes) {
        const r = nodeRadius(n);
        const isHover = activeHover === n.id;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isHover ? colors.nodeHover : colors.node;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isHover ? colors.nodeHoverStroke : colors.nodeStroke;
        ctx.stroke();

        if (isHover || r >= 8) {
          ctx.fillStyle = isHover ? colors.labelHover : colors.label;
          ctx.font = `${isHover ? '12px' : '10px'} ui-sans-serif, system-ui`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(n.label.length > 24 ? n.label.slice(0, 22) + '…' : n.label, n.x, n.y + r + 2);
        }
      }
    },
    [graph, idIndex],
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
      wakeRef.current(); // PERF-13: dragging restarts a slept layout
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
        wakeRef.current(); // PERF-13: keep simulating while dragging
      } else {
        const hit = hitTest(x, y);
        const next = hit?.id ?? null;
        if (next !== hoverIdRef.current) {
          setHoverId(next);
          wakeRef.current(); // repaint hover highlight even if layout is asleep
        }
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
        wakeRef.current(); // PERF-13: re-settle after the node is released
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
        onPointerLeave={() => {
          if (hoverIdRef.current !== null) {
            setHoverId(null);
            wakeRef.current(); // repaint to drop the hover highlight
          }
        }}
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
