// V3-W14-004 — Asset staging for Bridge Canvas drag-and-drop. Copies dropped
// files into <userData>/canvases/<canvasId>/staging/<ulid>.<ext> and returns
// the absolute path so the renderer can quote it into the prompt buffer.
// Accepts either an on-disk path (preferred via webUtils.getPathForFile) or
// raw base64 bytes (clipboard-image paste fallback).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AttachInput {
  /** Caller-provided id of the canvas the file is staged under. */
  canvasId: string;
  /** Absolute path on disk; preferred. */
  filePath?: string;
  /** Raw bytes encoded as base64. Used when no path is available. */
  bytesBase64?: string;
  /** Used to derive the extension when bytesBase64 is provided. */
  filename?: string;
}

export interface StagingDeps {
  userDataDir: string;
}

export class DesignStaging {
  private readonly deps: StagingDeps;
  constructor(deps: StagingDeps) {
    this.deps = deps;
  }

  /** Stage one file, returning its absolute on-disk path inside the canvas. */
  attach(input: AttachInput): { stagingPath: string } {
    if (!input.canvasId || typeof input.canvasId !== 'string') {
      throw new Error('design.attachFile: canvasId required');
    }
    const dir = this.ensureCanvasDir(input.canvasId);
    const ulid = randomUUID().replace(/-/g, '').slice(0, 16);
    if (input.filePath) {
      const src = path.resolve(input.filePath);
      if (!fs.existsSync(src)) {
        throw new Error(`design.attachFile: source missing: ${src}`);
      }
      const ext = path.extname(src);
      const dest = path.join(dir, `${ulid}${ext}`);
      fs.copyFileSync(src, dest);
      return { stagingPath: dest };
    }
    if (input.bytesBase64) {
      const ext = input.filename ? path.extname(input.filename) : '';
      const dest = path.join(dir, `${ulid}${ext}`);
      fs.writeFileSync(dest, Buffer.from(input.bytesBase64, 'base64'));
      return { stagingPath: dest };
    }
    throw new Error('design.attachFile: filePath or bytesBase64 required');
  }

  /** Returns the staging dir for a canvas (no-op when it already exists). */
  ensureCanvasDir(canvasId: string): string {
    const dir = path.join(this.deps.userDataDir, 'canvases', canvasId, 'staging');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
