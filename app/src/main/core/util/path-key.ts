import path from 'node:path';

function looksWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export function canonicalPathKey(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32' || looksWindowsPath(value)) {
    return path.win32.normalize(value).replace(/\//g, '\\').toLowerCase();
  }
  return path.normalize(value);
}

export function pathKeyIsWithin(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const childKey = canonicalPathKey(child, platform);
  const parentKey = canonicalPathKey(parent, platform);
  if (childKey === parentKey) return true;
  const sep = platform === 'win32' || looksWindowsPath(child) || looksWindowsPath(parent) ? '\\' : path.sep;
  return childKey.startsWith(parentKey.endsWith(sep) ? parentKey : parentKey + sep);
}
