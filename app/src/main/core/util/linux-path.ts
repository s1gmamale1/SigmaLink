import fs from 'node:fs';
import path from 'node:path';

export function linuxToolPathCandidates(home: string): string[] {
  // Always POSIX-join: these are Linux PATH entries and must use '/' regardless
  // of the host OS this code (or its tests) runs on. Plain path.join emits '\'
  // on a Windows host, which breaks the cross-platform vitest leg.
  return [
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(home, '.npm-global', 'bin'),
    path.posix.join(home, '.npm', 'bin'),
    path.posix.join(home, '.bun', 'bin'),
    path.posix.join(home, '.cargo', 'bin'),
    path.posix.join(home, '.asdf', 'shims'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
}

export function mergePathEntries(
  candidates: string[],
  currentPath: string,
  opts: {
    delimiter?: string;
    exists?: (candidate: string) => boolean;
  } = {},
): string {
  const delimiter = opts.delimiter ?? path.delimiter;
  const exists = opts.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of [...candidates.filter(exists), ...currentPath.split(delimiter)]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }

  return out.join(delimiter);
}
