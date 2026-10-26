import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ContentCatalogService } from './service';
import { ContentCatalogError } from './trust';
export async function startContentHost(
  service: ContentCatalogService
): Promise<{ url: string; port: number; token: string; close: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    const given = req.headers['x-openh3-content-token'];
    if (
      typeof given !== 'string' ||
      !/^[a-f0-9]{64}$/.test(given) ||
      given.length !== token.length ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(token))
    ) {
      res.writeHead(401).end();
      return;
    }
    const send = (status: number, data: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify(data));
    };
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const route = url.pathname;
      if (req.method === 'GET' && route === '/api/content-catalog/catalog') {
        send(200, { success: true, data: service.getCatalog() });
        return;
      }
      if (req.method === 'GET' && route === '/api/content-catalog/status') {
        send(200, { success: true, data: service.getStatus() });
        return;
      }
      const match = /^\/api\/content-catalog\/assets\/(\d{1,15})\/([a-f0-9]{64})$/.exec(route);
      if ((req.method === 'GET' || req.method === 'HEAD') && match) {
        const { bytes, asset } = await service.asset(Number(match[1]), match[2], controller.signal);
        let start = 0,
          end = bytes.length - 1;
        let status = 200;
        const range = req.headers.range;
        if (range) {
          const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!parts || (!parts[1] && !parts[2])) {
            res.writeHead(416, { 'content-range': `bytes */${bytes.length}` }).end();
            return;
          }
          if (parts[1]) {
            start = Number(parts[1]);
            end = parts[2] ? Math.min(Number(parts[2]), end) : end;
          } else start = Math.max(0, bytes.length - Number(parts[2]));
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
            res.writeHead(416, { 'content-range': `bytes */${bytes.length}` }).end();
            return;
          }
          status = 206;
        }
        res.writeHead(status, {
          'content-type': asset.mimeType,
          'content-length': String(end - start + 1),
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=31536000, immutable',
          etag: `"${match[2]}"`,
          'x-content-type-options': 'nosniff',
          ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
        });
        res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
        return;
      }
      if (req.method === 'POST' && /^\/api\/content-catalog\/(check|cancel|settings|restore|lease)$/.test(route)) {
        if (!req.headers['content-type']?.startsWith('application/json')) {
          send(415, { success: false, code: 'JSON_REQUIRED' });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          total += chunk.length;
          if (total > 1024) throw new ContentCatalogError('SIZE_LIMIT');
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          autoSync?: boolean;
          sequence?: number;
        };
        const action = route.split('/').at(-1);
        if (action === 'check') void service.check();
        else if (action === 'cancel') service.cancel();
        else if (action === 'restore') await service.restore();
        else if (action === 'settings') {
          if (typeof body.autoSync !== 'boolean') throw new ContentCatalogError('SETTINGS_INVALID');
          await service.setAutoSync(body.autoSync);
        } else if (action === 'lease') {
          if (!Number.isSafeInteger(body.sequence) || body.sequence! < 0)
            throw new ContentCatalogError('SNAPSHOT_UNAVAILABLE');
          await service.lease(body.sequence!);
        }
        send(200, { success: true, data: service.getStatus() });
        return;
      }
      send(404, { success: false, code: 'NOT_FOUND' });
    } catch (e) {
      if (!res.headersSent)
        send(400, {
          success: false,
          error: e instanceof ContentCatalogError ? e.code : 'CONTENT_REQUEST_FAILED',
          code: e instanceof ContentCatalogError ? e.code : 'CONTENT_REQUEST_FAILED',
        });
      else res.destroy();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
