// model-registry.ts — Whisper model catalog + download / verification logic.
//
// Extracted from app/src/main/core/voice/model-registry.ts into @sigmalink/voice-core
// as part of the v1.4.8 Cluster B voice-core extraction.
//
// The only SigmaLink-specific dependency that was removed is the direct
// `app.getPath('userData')` call. Callers must supply `getModelsDir` so this
// module can run inside BridgeVoice (standalone Electron app) or SigmaLink
// without importing SigmaLink's db/client.
//
// All other logic is identical to the original.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';

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
  /** Filename stored under <modelsDir>/. */
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

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const MODEL_CATALOG: ReadonlyArray<ModelEntry> = [
  {
    id: 'tiny.en-q5_1',
    name: 'Tiny (English, 31 MB) — fastest, lower accuracy',
    sizeMb: 31,
    sha256: 'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b',
    url: `${HF_BASE}/ggml-tiny.en-q5_1.bin`,
    filename: 'ggml-tiny.en-q5_1.bin',
    isDefault: false,
  },
  {
    id: 'base.en-q5_1',
    name: 'Base (English, 57 MB) — recommended',
    sizeMb: 57,
    sha256: '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f',
    url: `${HF_BASE}/ggml-base.en-q5_1.bin`,
    filename: 'ggml-base.en-q5_1.bin',
    isDefault: true,
  },
  {
    id: 'small.en-q5_1',
    name: 'Small (English, 182 MB) — better for accented speech',
    sizeMb: 182,
    sha256: 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30',
    url: `${HF_BASE}/ggml-small.en-q5_1.bin`,
    filename: 'ggml-small.en-q5_1.bin',
    isDefault: false,
  },
  {
    id: 'medium.en-q5_0',
    name: 'Medium (English, 515 MB) — near-large quality; uses ~2 GB RAM',
    sizeMb: 515,
    sha256: '76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0',
    url: `${HF_BASE}/ggml-medium.en-q5_0.bin`,
    filename: 'ggml-medium.en-q5_0.bin',
    isDefault: false,
  },
];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getModelPath(entry: ModelEntry, modelsDir: string): string {
  return path.join(modelsDir, entry.filename);
}

function getPartialPath(entry: ModelEntry, modelsDir: string): string {
  return getModelPath(entry, modelsDir) + '.partial';
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

export function isModelDownloaded(entry: ModelEntry, modelsDir: string): boolean {
  return fs.existsSync(getModelPath(entry, modelsDir));
}

/**
 * Return the absolute path to the model .bin file IF it is already
 * downloaded, otherwise null.
 */
export function getDownloadedModelPath(entry: ModelEntry, modelsDir: string): string | null {
  const p = getModelPath(entry, modelsDir);
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
 * Download `entry` to `<modelsDir>/<filename>`.
 * Supports resume on partial download and verifies SHA-256 before
 * atomically renaming the `.partial` file to the final path.
 *
 * @param entry      Model catalog entry to download.
 * @param modelsDir  Absolute path to the models storage directory.
 * @param onProgress Called frequently during download.
 */
export async function downloadModel(
  entry: ModelEntry,
  modelsDir: string,
  onProgress: ProgressCallback,
): Promise<void> {
  if (isModelDownloaded(entry, modelsDir)) {
    onProgress({ modelId: entry.id, bytesDone: entry.sizeMb * 1024 * 1024,
                 bytesTotal: entry.sizeMb * 1024 * 1024, fraction: 1, done: true });
    return;
  }

  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  const finalPath   = getModelPath(entry, modelsDir);
  const partialPath = getPartialPath(entry, modelsDir);

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
    let bytesTotal = entry.sizeMb * 1024 * 1024;

    function doRequest(requestUrl: string, redirectCount = 0): void {
      const parsedUrl = new URL(requestUrl);
      req = https.get(
        {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          headers,
        },
        (res) => {
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
            const ok = await verifyFile(partialPath, entry.sha256);
            if (!ok) {
              try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
              const err = new Error(`whisper model download: SHA-256 mismatch for ${entry.filename}`);
              onProgress({ modelId: entry.id, bytesDone, bytesTotal, fraction: 1, done: false, error: err.message });
              reject(err);
              return;
            }
            try {
              fs.renameSync(partialPath, finalPath);
            } catch {
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
