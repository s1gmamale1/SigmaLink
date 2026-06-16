import fs from 'node:fs';
import path from 'node:path';

export function linuxToolPathCandidates(home: string): string[] {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.npm', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.asdf', 'shims'),
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
