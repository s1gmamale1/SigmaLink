import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

/**
 * Atomic download with redirect following and progress reporting.
 * Streams to a .part file first, renames to destPath on success.
 */
export async function download(
  url: string,
  destPath: string,
  onChunk: (delta: number, total: number) => void,
  headers: Record<string, string> = {},
): Promise<{ bytes: number }> {
  const partPath = `${destPath}.part`;
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let bytes = 0;
  let total = 0;

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partPath);
    let settled = false;

    function removePartFile(): void {
      fs.rmSync(partPath, { force: true });
    }

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      out.close();
      removePartFile();
      reject(err);
    }

    out.on('error', (err) => {
      fail(err);
    });
    
    function requestFollowing(currentUrl: string, depth: number) {
      if (depth > 5) {
        fail(new Error('Too many redirects'));
        return;
      }

      const req = https.get(currentUrl, { headers }, (res) => {
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          requestFollowing(new URL(res.headers.location, currentUrl).href, depth + 1);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`HTTP ${res.statusCode} downloading ${currentUrl}`));
          return;
        }

        if (res.headers['content-length']) {
          const n = Number(res.headers['content-length']);
          if (Number.isFinite(n) && n > 0) total = n;
        }

        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          try {
            onChunk(chunk.length, total);
          } catch {
            /* progress callback should not abort */
          }
        });

        res.on('error', (err) => {
          fail(err);
        });

        res.pipe(out);
        
        out.on('finish', () => {
          if (settled) return;
          out.close();
          try {
            fs.renameSync(partPath, destPath);
            settled = true;
            resolve({ bytes });
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });

      req.on('error', (err) => {
        fail(err);
      });
      
      req.setTimeout(30000, () => {
        req.destroy();
        fail(new Error('Download timeout'));
      });
    }

    requestFollowing(url, 0);
  });
}
