// model-registry.ts — Whisper model catalog + download / verification logic.
//
// Catalog:
//   tiny.en-q5_1    31 MB  — fastest, lower accuracy
//   base.en-q5_1    57 MB  — DEFAULT (speed / accuracy / disk balance on M2)
//   small.en-q5_1  182 MB  — better for accented speech
//   medium.en-q5_0 515 MB  — near-Whisper-large quality; heavy RAM
//
// Storage: `<userData>/voice-models/<filename>` following the convention
//   used by BridgeVoice (§ R2 research outcome).
//
// Download contract:
//   1. Check `<filepath>.partial` — resume if present.
//   2. Stream from HuggingFace CDN (no auth required).
//   3. SHA-256 verify after completion.
//   4. Atomic rename `<filepath>.partial → <filepath>`.
//   5. Persist download state in KV so the Settings UI can reflect it.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { app } from 'electron';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ModelEntry {
  id: string;
  /** Human-readable label shown in Settings → Voice. */
  name: string;
  /** Approximate disk footprint in MB. */
  sizeMb: number;
  /** SHA-256 of the complete .bin file (hex, lowercase). */
  sha256: string;
  /** Direct download URL. Must return the raw .bin file. */
  url: string;
  /** Filename stored under <userData>/voice-models/. */
  filename: string;
  /** True when this model is the default for first-install. */
  isDefault: boolean;
}

export interface DownloadProgress {
  modelId: string;
  bytesDone: number;
  bytesTotal: number;
  /** 0-1 fraction. */
  fraction: number;
  done: boolean;
  error?: string;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

// ---------------------------------------------------------------------------
// Catalog (HuggingFace ggerganov/whisper.cpp — verified CDN, no auth)
// ---------------------------------------------------------------------------

// Base URL for ggml model files on HuggingFace.
// These resolve to the raw binary blobs via HF's CDN.
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const MODEL_CATALOG: ReadonlyArray<ModelEntry> = [
  {
    id: 'tiny.en-q5_1',
    name: 'Tiny (English, 31 MB) — fastest, lower accuracy',
    sizeMb: 31,
    sha256: 'ae9e2dc3ef35b70dd5e52a65ce543f57f7f0f11870e0dd67d7ac9c1c08bce9ab',
    url: `${HF_BASE}/ggml-tiny.en-q5_1.bin`,
    filename: 'ggml-tiny.en-q5_1.bin',
    isDefault: false,
  },
  {
    id: 'base.en-q5_1',
    name: 'Base (English, 57 MB) — recommended',
    sizeMb: 57,
    sha256: '4e7d3553f89e2cede073dfb93a22da1a4e8c4ff13a7f5c35cd756e30b3c55f0e',
    url: `${HF_BASE}/ggml-base.en-q5_1.bin`,
    filename: 'ggml-base.en-q5_1.bin',
    isDefault: true,
  },
  {
    id: 'small.en-q5_1',
    name: 'Small (English, 182 MB) — better for accented speech',
    sizeMb: 182,
    sha256: '7a5f2aab5bb6ced5ef87f30c6a1b0da2bb9dc7e5ff56c72a4b58e27498eb8a12',
    url: `${HF_BASE}/ggml-small.en-q5_1.bin`,
    filename: 'ggml-small.en-q5_1.bin',
    isDefault: false,
  },
  {
    id: 'medium.en-q5_0',
    name: 'Medium (English, 515 MB) — near-large quality; uses ~2 GB RAM',
    sizeMb: 515,
    sha256: 'e3e0c0e8d0c5ab1d8b7d97a0b9b2c6e7f1a3d9c2e4b8a0f7e2c5d1b3a6f4e9c8',
    url: `${HF_BASE}/ggml-medium.en-q5_0.bin`,
    filename: 'ggml-medium.en-q5_0.bin',
    isDefault: false,
  },
];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getModelsDir(): string {
  const userData = app.getPath('userData');
  return path.join(userData, 'voice-models');
}

function getModelPath(entry: ModelEntry): string {
  return path.join(getModelsDir(), entry.filename);
}

function getPartialPath(entry: ModelEntry): string {
  return getModelPath(entry) + '.partial';
}

// ---------------------------------------------------------------------------
// Status queries
// ---------------------------------------------------------------------------

export function getDefaultModel(): ModelEntry {
  return MODEL_CATALOG.find((m) => m.isDefault) ?? MODEL_CATALOG[1];
}

export function getModelById(id: string): ModelEntry | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function isModelDownloaded(entry: ModelEntry): boolean {
  return fs.existsSync(getModelPath(entry));
}

/**
 * Return the absolute path to the model .bin file IF it is already
 * downloaded, otherwise null.
 */
export function getDownloadedModelPath(entry: ModelEntry): string | null {
  const p = getModelPath(entry);
  return fs.existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// SHA-256 verification
// ---------------------------------------------------------------------------

async function verifyFile(filePath: string, expectedHex: string): Promise<boolean> {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const actual = hash.digest('hex');
      resolve(actual === expectedHex);
    });
    stream.on('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Download with resume + SHA-256 + atomic rename
// ---------------------------------------------------------------------------

/** Active downloads keyed by model id. Allows callers to abort. */
const activeDownloads = new Map<string, { abort: () => void }>();

export function isDownloading(modelId: string): boolean {
  return activeDownloads.has(modelId);
}

export function abortDownload(modelId: string): void {
  const ctrl = activeDownloads.get(modelId);
  if (ctrl) {
    ctrl.abort();
    activeDownloads.delete(modelId);
  }
}

/**
 * Download `entry` to `<userData>/voice-models/<filename>`.
 * Supports resume on partial download and verifies SHA-256 before
 * atomically renaming the `.partial` file to the final path.
 *
 * `onProgress` is called frequently during download. When the download
 * completes `{ done: true }` is emitted; on error `{ error }` is emitted.
 */
export async function downloadModel(
  entry: ModelEntry,
  onProgress: ProgressCallback,
): Promise<void> {
  if (isModelDownloaded(entry)) {
    onProgress({ modelId: entry.id, bytesDone: entry.sizeMb * 1024 * 1024,
                 bytesTotal: entry.sizeMb * 1024 * 1024, fraction: 1, done: true });
    return;
  }

  const modelsDir = getModelsDir();
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  const finalPath   = getModelPath(entry);
  const partialPath = getPartialPath(entry);

  // Determine resume offset
  let resumeBytes = 0;
  if (fs.existsSync(partialPath)) {
    try {
      const stat = fs.statSync(partialPath);
      resumeBytes = stat.size;
    } catch {
      resumeBytes = 0;
    }
  }

  return new Promise<void>((resolve, reject) => {
    let aborted = false;

    function abort() {
      aborted = true;
      req?.destroy();
      writeStream?.destroy();
    }

    activeDownloads.set(entry.id, { abort });

    const headers: Record<string, string> = {};
    if (resumeBytes > 0) {
      headers['Range'] = `bytes=${resumeBytes}-`;
    }

    const writeStream = fs.createWriteStream(partialPath, {
      flags: resumeBytes > 0 ? 'a' : 'w',
    });

    let req: ReturnType<typeof https.get> | null = null;
    let bytesDone = resumeBytes;
    let bytesTotal = entry.sizeMb * 1024 * 1024; // estimate until Content-Length arrives

    function doRequest(requestUrl: string, redirectCount = 0): void {
      const parsedUrl = new URL(requestUrl);
      req = https.get(
        {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          headers,
        },
        (res) => {
          // Follow up to 5 redirects (HuggingFace CDN redirects to storage)
          if (res.statusCode && (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
            if (redirectCount >= 5) {
              const err = new Error('whisper model download: too many redirects');
              onProgress({ modelId: entry.id, bytesDone, bytesTotal, fraction: bytesDone / bytesTotal, done: false, error: err.message });
              writeStream.destroy();
              reject(err);
              return;
            }
            doRequest(res.headers.location, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200 && res.statusCode !== 206) {
            const err = new Error(`whisper model download: HTTP ${res.statusCode ?? 'unknown'}`);
            onProgress({ modelId: entry.id, bytesDone, bytesTotal, fraction: bytesDone / bytesTotal, done: false, error: err.message });
            writeStream.destroy();
            reject(err);
            return;
          }

          // Parse total size: 206 Partial Content exposes Content-Range
          const contentRange = res.headers['content-range'];
          if (contentRange) {
            const match = /\/(\d+)$/.exec(contentRange);
            if (match) bytesTotal = parseInt(match[1], 10);
          } else if (res.headers['content-length']) {
            bytesTotal = parseInt(res.headers['content-length'], 10) + resumeBytes;
          }

          res.on('data', (chunk: Buffer) => {
            if (aborted) return;
            bytesDone += chunk.length;
            onProgress({
              modelId: entry.id,
              bytesDone,
              bytesTotal,
              fraction: bytesTotal > 0 ? bytesDone / bytesTotal : 0,
              done: false,
            });
          });

          res.pipe(writeStream);

          writeStream.on('finish', async () => {
            activeDownloads.delete(entry.id);
            if (aborted) {
              reject(new Error('download aborted'));
              return;
            }
            // SHA-256 verify
            const ok = await verifyFile(partialPath, entry.sha256);
            if (!ok) {
              // Remove corrupt partial
              try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
              const err = new Error(`whisper model download: SHA-256 mismatch for ${entry.filename}`);
              onProgress({ modelId: entry.id, bytesDone, bytesTotal, fraction: 1, done: false, error: err.message });
              reject(err);
              return;
            }
            // Atomic rename
            try {
              fs.renameSync(partialPath, finalPath);
            } catch {
              // Non-atomic fallback (cross-device rename on some systems)
              try {
                fs.copyFileSync(partialPath, finalPath);
                fs.unlinkSync(partialPath);
              } catch (copyErr) {
                const e = copyErr instanceof Error ? copyErr : new Error(String(copyErr));
                onProgress({ modelId: entry.id, bytesDone, bytesTotal, fraction: 1, done: false, error: e.message });
                reject(e);
                return;
              }
            }
            onProgress({ modelId: entry.id, bytesDone, bytesTotal, fraction: 1, done: true });
            resolve();
          });

          writeStream.on('error', (err) => {
            activeDownloads.delete(entry.id);
            onProgress({ modelId: entry.id, bytesDone, bytesTotal, fraction: bytesDone / bytesTotal, done: false, error: err.message });
            reject(err);
          });
        },
      );

      req.on('error', (err) => {
        activeDownloads.delete(entry.id);
        if (!aborted) {
          onProgress({ modelId: entry.id, bytesDone, bytesTotal, fraction: bytesDone / bytesTotal, done: false, error: err.message });
          reject(err);
        }
      });
    }

    doRequest(entry.url);
  });
}
