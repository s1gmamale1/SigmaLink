// Spec 2026-06-10 (B) — stage a dropped/pasted image to a temp file so a pane
// can inject an absolute @path that image-capable CLIs (claude/codex) read
// from the prompt. Clipboard-write is upstream-broken for Claude Code (it reads
// legacy «class PNGf»; Electron writes public.png — anthropics/claude-code#30936),
// so the FILE PATH is the only path that works for both CLIs today. Boundary
// validation lives HERE (renderer input is untrusted): extension allowlist +
// size cap; the filename is fully server-generated so no path traversal is
// possible. Extracted as a pure DI-style helper (baseDir injected) because
// rpc-router itself cannot be loaded under vitest (Electron imports).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

export function stageImage(
  input: { bytesBase64: string; ext: string },
  opts: { baseDir: string },
): { absPath: string } {
  const cleanExt = String(input.ext ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ALLOWED_EXTENSIONS.has(cleanExt)) {
    throw new Error(`stageImage: unsupported extension "${input.ext}"`);
  }
  if (typeof input.bytesBase64 !== 'string' || input.bytesBase64.length === 0) {
    throw new Error('stageImage: empty payload');
  }
  const buf = Buffer.from(input.bytesBase64, 'base64');
  if (buf.byteLength === 0) throw new Error('stageImage: empty payload');
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error('stageImage: image exceeds 20MB cap');
  const dir = path.join(opts.baseDir, 'staged-images');
  fs.mkdirSync(dir, { recursive: true });
  const absPath = path.join(dir, `sigmalink-img-${Date.now()}-${randomUUID().slice(0, 8)}.${cleanExt}`);
  fs.writeFileSync(absPath, buf);
  return { absPath };
}
