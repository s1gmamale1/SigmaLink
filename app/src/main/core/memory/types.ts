// Internal types for the Memory subsystem. The renderer-facing shapes live in
// `shared/types.ts`; these are private to main-process code.

import type { Memory } from '../../../shared/types';

export type { Memory };

export interface Wikilink {
  /** Target note name as written (no brackets, no alias). */
  target: string;
  /** Optional alias text after the pipe. */
  alias?: string;
  /** [start, end) byte offsets into the source body. */
  range: [number, number];
}

export interface MemoryFrontmatter {
  name: string;
  tags?: string[];
  created: number;
  updated: number;
}

export interface MemoryFileRecord {
  /** The note name (file basename without extension). */
  name: string;
  /** The plain markdown body (no frontmatter). */
  body: string;
  /** Parsed frontmatter — synthesized when missing. */
  frontmatter: MemoryFrontmatter;
  /** Absolute path to the .md file. */
  filePath: string;
}

export interface MemoryLinkEdge {
  fromMemoryId: string;
  toMemoryName: string;
}

export interface MemoryTagEdge {
  memoryId: string;
  tag: string;
}
