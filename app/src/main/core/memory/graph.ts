// Build a {nodes, edges} payload for the Memory graph view. Edges are
// resolved by NAME — a wikilink to a non-existent note is dropped here so
// the graph only shows real connections. Backlink counts are precomputed so
// the renderer can size nodes without re-scanning.

import type { Memory, MemoryGraph } from '../../../shared/types';

export function buildGraph(memories: Memory[]): MemoryGraph {
  const byName = new Map<string, Memory>();
  // Index every note by its canonical name AND each of its MEM-5 aliases so a
  // `[[Alias]]` wikilink resolves to the aliased note. The canonical name is
  // inserted LAST so a real note never loses out to another note's alias on a
  // collision (canonical identity wins).
  for (const m of memories) {
    for (const alias of m.aliases ?? []) {
      const key = alias.toLowerCase();
      if (!byName.has(key)) byName.set(key, m);
    }
  }
  for (const m of memories) byName.set(m.name.toLowerCase(), m);
  const incoming = new Map<string, number>();
  const edges: MemoryGraph['edges'] = [];
  for (const m of memories) {
    for (const target of m.links) {
      const dest = byName.get(target.toLowerCase());
      if (!dest) continue;
      if (dest.id === m.id) continue;
      edges.push({ from: m.id, to: dest.id });
      incoming.set(dest.id, (incoming.get(dest.id) ?? 0) + 1);
    }
  }
  const nodes: MemoryGraph['nodes'] = memories.map((m) => ({
    id: m.id,
    label: m.name,
    tagCount: m.tags.length,
    refCount: incoming.get(m.id) ?? 0,
  }));
  return { nodes, edges };
}
