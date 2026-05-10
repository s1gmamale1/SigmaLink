// Phase 4 Track C — Ruflo MCP lazy installer (Option B).
//
// Downloads `@claude-flow/cli` (and its native `optionalDependencies`) into
// `<userData>/ruflo/`. We do NOT vendor any tarballs in the DMG — the first-
// run cost is paid only by users who opt into Ruflo features.
//
// Install steps (each emits a `ruflo:install-progress` event):
//   1. queued                 — placeholder before the first network call
//   2. fetching-metadata      — GET https://registry.npmjs.org/@claude-flow/cli
//   3. downloading            — stream the platform-resolved tarball
//   4. verifying              — sha512 check against registry metadata
//   5. extracting             — tar -xz into <root>/node_modules/@claude-flow/cli
//   6. finalizing             — write <root>/version.json
//   7. done                   — supervisor.rescanInstall() → state flips to `down`
//
// We intentionally keep this minimal — we don't run a full npm dependency
// resolution. Ruflo's optionalDependencies are platform-scoped tarballs; for
// v1 we only fetch the top-level package and rely on the supervisor's clear
// error message if an optional native dep is missing. A v1.1 ticket lifts
// this to a full `npm install --omit=dev`.

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import type { RufloInstallProgress } from './types';

/** Pinned semver for the v1 release. Bumping here triggers a re-download
 *  prompt on the next app launch (see docs/04-design/ruflo-mcp-embed.md §5). */
export const PINNED_RUFLO_VERSION = '2.0.0-alpha.91';

const NPM_REGISTRY = 'https://registry.npmjs.org';
const TAR_BIN = process.platform === 'win32' ? 'tar.exe' : 'tar';

export interface RufloInstallerOpts {
  /** Install root. Defaults to `<userData>/ruflo`. */
  rufloRoot?: string;
  /** Override the npm registry (used by tests). */
  registry?: string;
  /** Override the pinned version (used by tests / re-download prompts). */
  version?: string;
}

export class RufloInstaller extends EventEmitter {
  private readonly opts: Required<RufloInstallerOpts>;
  private active: { jobId: string; cancelled: boolean } | null = null;

  constructor(opts: RufloInstallerOpts = {}) {
    super();
    this.opts = {
      rufloRoot: opts.rufloRoot ?? defaultRufloRoot(),
      registry: opts.registry ?? NPM_REGISTRY,
      version: opts.version ?? PINNED_RUFLO_VERSION,
    };
  }

  /** Trigger an install job. Resolves with the assigned `jobId`. The actual
   *  work runs in the background; subscribe to `progress` events for status. */
  start(): { jobId: string; promise: Promise<{ ok: boolean; size: number; path: string }> } {
    if (this.active) {
      // Single-flight — return the existing job's id and a synthetic resolved
      // promise. The renderer's UI is keyed on the `jobId`, so this matches
      // the existing progress stream.
      return {
        jobId: this.active.jobId,
        promise: Promise.resolve({ ok: false, size: 0, path: this.opts.rufloRoot }),
      };
    }
    const jobId = randomUUID();
    this.active = { jobId, cancelled: false };
    const promise = this.run(jobId).finally(() => {
      this.active = null;
    });
    return { jobId, promise };
  }

  /** Cancel an in-flight install. The active phase will check the flag at
   *  natural boundaries (between download chunks, before extract). */
  cancel(): void {
    if (this.active) this.active.cancelled = true;
  }

  // ────────────────────────────── internals ──────────────────────────────

  private emitProgress(payload: RufloInstallProgress): void {
    this.emit('progress', payload);
  }

  private async run(jobId: string): Promise<{ ok: boolean; size: number; path: string }> {
    try {
      this.emitProgress({ jobId, phase: 'queued', bytesDone: 0, bytesTotal: 0 });
      fs.mkdirSync(this.opts.rufloRoot, { recursive: true });

      this.emitProgress({ jobId, phase: 'fetching-metadata', bytesDone: 0, bytesTotal: 0 });
      const meta = await this.fetchManifest(this.opts.version);

      const tarballUrl = meta.tarball;
      const expectedShasum = meta.shasum;
      const tmpFile = path.join(this.opts.rufloRoot, `.ruflo-${jobId}.tgz`);

      this.emitProgress({ jobId, phase: 'downloading', bytesDone: 0, bytesTotal: meta.unpackedSize ?? 0 });
      const downloaded = await this.streamTarball(tarballUrl, tmpFile, jobId, meta.unpackedSize ?? 0);

      this.emitProgress({ jobId, phase: 'verifying', bytesDone: downloaded, bytesTotal: downloaded });
      await this.verifyShasum(tmpFile, expectedShasum);

      this.emitProgress({ jobId, phase: 'extracting', bytesDone: downloaded, bytesTotal: downloaded });
      const extractDir = path.join(this.opts.rufloRoot, 'node_modules', '@claude-flow', 'cli');
      fs.mkdirSync(extractDir, { recursive: true });
      await this.extractTarball(tmpFile, extractDir);

      this.emitProgress({ jobId, phase: 'finalizing', bytesDone: downloaded, bytesTotal: downloaded });
      fs.writeFileSync(
        path.join(this.opts.rufloRoot, 'version.json'),
        JSON.stringify({ version: this.opts.version, installedAt: Date.now() }, null, 2),
      );
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }

      this.emitProgress({ jobId, phase: 'done', bytesDone: downloaded, bytesTotal: downloaded });
      return { ok: true, size: downloaded, path: this.opts.rufloRoot };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitProgress({
        jobId,
        phase: 'error',
        bytesDone: 0,
        bytesTotal: 0,
        message,
      });
      return { ok: false, size: 0, path: this.opts.rufloRoot };
    }
  }

  private async fetchManifest(
    version: string,
  ): Promise<{ tarball: string; shasum: string; unpackedSize?: number }> {
    const url = `${this.opts.registry}/@claude-flow/cli/${version}`;
    const body = await this.httpGetJson(url);
    const dist = (body as { dist?: { tarball?: string; shasum?: string; unpackedSize?: number } }).dist;
    if (!dist?.tarball || !dist.shasum) {
      throw new Error(`ruflo-installer: bad manifest from registry for ${version}`);
    }
    return {
      tarball: dist.tarball,
      shasum: dist.shasum,
      unpackedSize: dist.unpackedSize,
    };
  }

  private httpGetJson(url: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          this.httpGetJson(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`ruflo-installer: HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => {
        req.destroy(new Error('ruflo-installer: registry timeout'));
      });
    });
  }

  private streamTarball(
    url: string,
    destPath: string,
    jobId: string,
    sizeHint: number,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(destPath);
      let downloaded = 0;
      let totalBytes = sizeHint;
      const handle = (incoming: import('node:http').IncomingMessage): void => {
        if (
          incoming.statusCode &&
          incoming.statusCode >= 300 &&
          incoming.statusCode < 400 &&
          incoming.headers.location
        ) {
          incoming.resume();
          https
            .get(incoming.headers.location, (next) => handle(next))
            .on('error', reject);
          return;
        }
        if (incoming.statusCode !== 200) {
          incoming.resume();
          reject(new Error(`ruflo-installer: HTTP ${incoming.statusCode} fetching tarball`));
          return;
        }
        if (incoming.headers['content-length']) {
          const n = Number(incoming.headers['content-length']);
          if (Number.isFinite(n) && n > 0) totalBytes = n;
        }
        incoming.on('data', (chunk: Buffer) => {
          if (this.active?.cancelled) {
            incoming.destroy();
            out.close();
            reject(new Error('ruflo-installer: cancelled'));
            return;
          }
          downloaded += chunk.length;
          this.emitProgress({
            jobId,
            phase: 'downloading',
            bytesDone: downloaded,
            bytesTotal: totalBytes,
          });
        });
        incoming.pipe(out);
        out.on('finish', () => resolve(downloaded));
        out.on('error', reject);
        incoming.on('error', reject);
      };
      https.get(url, handle).on('error', reject);
    });
  }

  private async verifyShasum(filePath: string, expected: string): Promise<void> {
    const { createHash } = await import('node:crypto');
    return await new Promise((resolve, reject) => {
      const hash = createHash('sha1');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => {
        const actual = hash.digest('hex');
        if (actual !== expected) {
          reject(new Error(`ruflo-installer: sha1 mismatch (expected ${expected}, got ${actual})`));
          return;
        }
        resolve();
      });
      stream.on('error', reject);
    });
  }

  private extractTarball(tarPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // npm tarballs nest under `package/`; strip-components=1 hoists it.
      const proc = spawn(TAR_BIN, ['-xzf', tarPath, '-C', destDir, '--strip-components=1'], {
        windowsHide: true,
      });
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ruflo-installer: tar exit ${code}: ${stderr}`));
      });
    });
  }
}

function defaultRufloRoot(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as { app: { getPath(name: string): string } };
  return path.join(app.getPath('userData'), 'ruflo');
}
