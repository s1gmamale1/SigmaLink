import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';

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
    
    function requestFollowing(currentUrl: string, depth: number) {
      if (depth > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const req = https.get(currentUrl, { headers }, (res) => {
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          requestFollowing(res.headers.location, depth + 1);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          out.close();
          fs.unlinkSync(partPath);
          reject(new Error(`HTTP ${res.statusCode} downloading ${currentUrl}`));
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
          out.close();
          fs.unlinkSync(partPath);
          reject(err);
        });

        res.pipe(out);
        
        out.on('finish', () => {
          out.close();
          try {
            fs.renameSync(partPath, destPath);
            resolve({ bytes });
          } catch (err) {
            reject(err);
          }
        });

        out.on('error', (err) => {
          out.close();
          fs.unlinkSync(partPath);
          reject(err);
        });
      });

      req.on('error', (err) => {
        out.close();
        fs.unlinkSync(partPath);
        reject(err);
      });
      
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Download timeout'));
      });
    }

    requestFollowing(url, 0);
  });
}
