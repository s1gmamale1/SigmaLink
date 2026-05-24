export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_]/g, ''); // single-char escapes
}
export function compactScrollback(raw: string, maxChars = 4000): string {
  const clean = stripAnsi(raw).replace(/\r/g, '');
  if (clean.length <= maxChars) return clean;
  return `[…truncated…]\n${clean.slice(-maxChars)}`;
}
