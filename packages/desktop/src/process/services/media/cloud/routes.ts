import fs from 'node:fs';
import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { cloudVideoInputSchema } from '@/common/chat/document/creation/cloudVideo';
import type { CloudVideoService } from './CloudVideoService';

type Ports = {
  service: CloudVideoService;
  uiToken?: string;
  body: (request: http.IncomingMessage) => Promise<unknown>;
  json: (response: http.ServerResponse, status: number, data: unknown) => void;
};
const binding = z.object({
  requestId: z.string().uuid(),
  conversationId: z.string().min(1),
  connectionId: z.string().uuid(),
});

/** Application-owned cloud endpoints; credentials can only be configured with the UI capability. */
export async function handleCloudVideoRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  ports: Ports
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/cloud-video/')) return false;
  const { service, json, body } = ports;
  if (request.method === 'POST' && ['/api/cloud-video/connections', '/api/cloud-video/bind'].includes(url.pathname)) {
    const provided = request.headers['x-openh3-ui-token'];
    const a = Buffer.from(typeof provided === 'string' ? provided : '');
    const b = Buffer.from(ports.uiToken ?? '');
    if (!b.length || a.length !== b.length || !timingSafeEqual(a, b)) {
      json(response, 403, { error: 'CLOUD_VIDEO_UI_AUTH_REQUIRED' });
      return true;
    }
    if (url.pathname.endsWith('/bind')) {
      const input = binding.parse(await body(request));
      service.bind(input.requestId, input.conversationId, input.connectionId);
      json(response, 200, { ok: true });
    } else
      json(
        response,
        200,
        service.saveConnection((await body(request)) as Parameters<CloudVideoService['saveConnection']>[0])
      );
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/cloud-video/connections') {
    json(response, 200, service.connections());
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/cloud-video/jobs') {
    const input = z
      .object({ requestId: z.string().uuid(), submissionId: z.string().uuid(), input: cloudVideoInputSchema })
      .parse(await body(request));
    json(response, 202, await service.submit(input.requestId, input.input, input.submissionId));
    return true;
  }
  const match = /^\/api\/cloud-video\/jobs\/([a-f0-9-]{36})(\/content)?$/.exec(url.pathname);
  if (request.method === 'GET' && match) {
    const scope = z
      .string()
      .min(1)
      .parse(url.searchParams.get('conversationId') ?? url.searchParams.get('requestId'));
    if (!match[2]) {
      json(response, 200, service.job(match[1], scope));
      return true;
    }
    const filename = service.artifact(match[1], scope);
    const size = fs.statSync(filename).size;
    const range = request.headers.range;
    const parsed = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    let start = 0;
    let end = size - 1;
    if (range) {
      if (!parsed || (!parsed[1] && !parsed[2])) {
        response.writeHead(416, { 'content-range': `bytes */${size}` });
        response.end();
        return true;
      }
      start = parsed[1] ? Number(parsed[1]) : Math.max(0, size - Number(parsed[2]));
      end = parsed[1] && parsed[2] ? Math.min(Number(parsed[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        response.writeHead(416, { 'content-range': `bytes */${size}` });
        response.end();
        return true;
      }
    }
    response.writeHead(range ? 206 : 200, {
      'content-type': 'video/mp4',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    const stream = fs.createReadStream(filename, { start, end });
    response.once('close', () => stream.destroy());
    stream.once('error', () => response.destroy());
    stream.pipe(response);
    return true;
  }
  json(response, 404, { error: 'NOT_FOUND' });
  return true;
}
