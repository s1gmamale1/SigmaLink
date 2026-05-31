import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { download } from './http-download';

interface FakeResponseOptions {
  statusCode: number;
  headers?: Record<string, string>;
  body?: Buffer;
}

class FakeResponse extends EventEmitter {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  private readonly body: Buffer;

  constructor(opts: FakeResponseOptions) {
    super();
    this.statusCode = opts.statusCode;
    this.headers = opts.headers ?? {};
    this.body = opts.body ?? Buffer.alloc(0);
  }

  resume(): void {
    // Redirect/error responses are intentionally discarded in the downloader.
  }

  pipe(out: fs.WriteStream): fs.WriteStream {
    if (this.body.length > 0) {
      this.emit('data', this.body);
      out.write(this.body);
    }
    out.end();
    return out;
  }
}

class FakeRequest extends EventEmitter {
  setTimeout(): void {
    // Timeouts are not exercised by this suite.
  }

  destroy(): void {
    // No-op for scripted test transport.
  }
}

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempFile(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-http-download-'));
  tempRoots.push(root);
  return path.join(root, name);
}

function mockHttpsGet(responses: FakeResponseOptions[]): string[] {
  const seenUrls: string[] = [];
  const implementation = (
    url: URL | string | RequestOptions,
    optsOrCb?: RequestOptions | ((res: IncomingMessage) => void),
    maybeCb?: (res: IncomingMessage) => void,
  ) => {
    const response = responses.shift();
    if (!response) throw new Error('missing scripted response');
    const request = new FakeRequest();
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    if (!cb) throw new Error('missing response callback');
    seenUrls.push(String(url));
    queueMicrotask(() => cb(new FakeResponse(response) as never));
    return request as never;
  };
  vi.spyOn(https, 'get').mockImplementation(implementation as unknown as typeof https.get);
  return seenUrls;
}

describe('http-download', () => {
  it('streams to a .part file, reports progress, then atomically renames on success', async () => {
    const destPath = tempFile('SigmaLink.dmg');
    const body = Buffer.from('payload');
    const progress: Array<{ delta: number; total: number }> = [];
    mockHttpsGet([
      {
        statusCode: 200,
        headers: { 'content-length': String(body.length) },
        body,
      },
    ]);

    await expect(
      download('https://example.test/SigmaLink.dmg', destPath, (delta, total) => {
        progress.push({ delta, total });
      }),
    ).resolves.toEqual({ bytes: body.length });

    expect(fs.readFileSync(destPath, 'utf8')).toBe('payload');
    expect(fs.existsSync(`${destPath}.part`)).toBe(false);
    expect(progress).toEqual([{ delta: body.length, total: body.length }]);
  });

  it('follows relative redirects against the current URL', async () => {
    const destPath = tempFile('redirected.dmg');
    const seenUrls = mockHttpsGet([
      {
        statusCode: 302,
        headers: { location: '/assets/SigmaLink.dmg' },
      },
      {
        statusCode: 200,
        body: Buffer.from('redirected'),
      },
    ]);

    await download('https://example.test/releases/latest.yml', destPath, () => undefined);

    expect(seenUrls).toEqual([
      'https://example.test/releases/latest.yml',
      'https://example.test/assets/SigmaLink.dmg',
    ]);
    expect(fs.readFileSync(destPath, 'utf8')).toBe('redirected');
  });

  it('cleans up a missing or partial .part file without throwing on HTTP errors', async () => {
    const destPath = tempFile('failed.dmg');
    mockHttpsGet([{ statusCode: 500 }]);

    await expect(
      download('https://example.test/fail.dmg', destPath, () => undefined),
    ).rejects.toThrow('HTTP 500 downloading https://example.test/fail.dmg');

    expect(fs.existsSync(destPath)).toBe(false);
    expect(fs.existsSync(`${destPath}.part`)).toBe(false);
  });

  // BUG-7 regression: a clean-FIN truncation (bytes < content-length) must
  // reject and NOT promote the .part file to destPath.
  it('rejects and removes .part file when bytes received are less than Content-Length', async () => {
    const destPath = tempFile('truncated.dmg');
    const fullBody = Buffer.from('full-payload-12-bytes');
    // Only deliver a prefix — simulate clean-FIN truncation.
    const partialBody = fullBody.subarray(0, 5);
    mockHttpsGet([
      {
        statusCode: 200,
        headers: { 'content-length': String(fullBody.length) },
        body: partialBody,
      },
    ]);

    await expect(
      download('https://example.test/truncated.dmg', destPath, () => undefined),
    ).rejects.toThrow('truncated download');

    expect(fs.existsSync(destPath)).toBe(false);
    expect(fs.existsSync(`${destPath}.part`)).toBe(false);
  });

  // BUG-7: no Content-Length header → total stays 0 → accept any byte count.
  it('accepts a download with no Content-Length header', async () => {
    const destPath = tempFile('no-length.dmg');
    const body = Buffer.from('no-length-body');
    mockHttpsGet([
      {
        statusCode: 200,
        // no content-length header
        body,
      },
    ]);

    await expect(
      download('https://example.test/no-length.dmg', destPath, () => undefined),
    ).resolves.toEqual({ bytes: body.length });

    expect(fs.readFileSync(destPath, 'utf8')).toBe('no-length-body');
    expect(fs.existsSync(`${destPath}.part`)).toBe(false);
  });
});
