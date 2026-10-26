import fs from 'node:fs';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { z } from 'zod';
import { probeComfyEnvironment } from './environment';
import { comfyProfileSchema } from '@/common/chat/document/creation/comfy';
import type { ComfyService } from './ComfyService';

type Ports = {
  json: (response: http.ServerResponse, status: number, data: unknown) => void;
  body: (request: http.IncomingMessage) => Promise<unknown>;
  service: ComfyService;
  uiToken?: string;
  setBackendPort?: (port: number) => void;
};
const envelope = z
  .object({ requestId: z.string().uuid().optional(), conversationId: z.string().min(1).optional() })
  .refine((scope) => Boolean(scope.requestId || scope.conversationId), { message: 'COMFY_REQUEST_REQUIRED' });

/** Handle local ComfyUI APIs; false leaves existing media and historical H3 routes untouched. */
export async function handleComfyRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  ports: Ports
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/comfy/')) return false;
  const { service, json, body } = ports;
  if (request.method === 'POST' && url.pathname === '/api/comfy/runtime-context') {
    if (!hasUiCapability(request, ports.uiToken)) {
      json(response, 403, { error: 'COMFY_UI_AUTH_REQUIRED' });
      return true;
    }
    const payload = z.object({ backendPort: z.number().int().min(1).max(65535) }).parse(await body(request));
    if (!ports.setBackendPort) throw new Error('COMFY_APPROVAL_BACKEND_UNAVAILABLE');
    ports.setBackendPort(payload.backendPort);
    json(response, 200, { ok: true });
    return true;
  }
  const requestId = url.searchParams.get('requestId') ?? undefined;
  if (requestId) service.selection(requestId);
  if (request.method === 'POST' && url.pathname === '/api/comfy/bind') {
    service.bind(await body(request));
    json(response, 200, { ok: true });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/comfy/environment') {
    const input = z
      .object({
        root: comfyProfileSchema.shape.environment.shape.root.optional(),
        python: z.string().min(1).optional(),
        baseUrl: comfyProfileSchema.shape.environment.shape.baseUrl.optional(),
        sources: z.array(z.string().url()).max(12).optional(),
      })
      .parse(
        Object.fromEntries([
          ...['root', 'python', 'baseUrl'].flatMap((key): Array<[string, string]> => {
            const value = url.searchParams.get(key);
            return value ? [[key, value]] : [];
          }),
          ...(url.searchParams.getAll('source').length
            ? [['sources', url.searchParams.getAll('source')] as [string, string[]]]
            : []),
        ])
      );
    json(response, 200, await probeComfyEnvironment(input));
    return true;
  }
  if (url.pathname === '/api/comfy/profiles') {
    if (request.method === 'GET') {
      const profiles = await service.refreshProfiles();
      json(response, 200, requestId ? { profiles, selection: service.selection(requestId) } : profiles);
      return true;
    }
    if (request.method === 'POST') {
      const payload = z
        .object({
          action: z.enum(['register', 'revalidate']),
          requestId: z.string().uuid(),
          profile: z.unknown().optional(),
          profileId: z.string().optional(),
          smokeInput: z.unknown().optional(),
        })
        .parse(await body(request));
      const scope = service.selection(payload.requestId);
      if (payload.action === 'register') {
        const profile = comfyProfileSchema.parse(payload.profile);
        if (scope.source !== 'local' || scope.family !== profile.family) throw new Error('COMFY_FAMILY_MISMATCH');
        json(response, 200, service.register(profile));
      } else {
        if (!payload.profileId) throw new Error('COMFY_PROFILE_REQUIRED');
        if (!payload.smokeInput) throw new Error('COMFY_SMOKE_INPUT_REQUIRED');
        const job = service.verify(payload.requestId, payload.profileId, payload.smokeInput);
        json(response, 202, { comfyJobId: job.id, job, validation: true });
      }
      return true;
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/comfy/operations') {
    const payload = z.object({ requestId: z.string().uuid(), plan: z.unknown() }).parse(await body(request));
    json(response, 201, await service.request(payload.requestId, payload.plan));
    return true;
  }
  const operation = /^\/api\/comfy\/operations\/([a-f\d-]{36})(?:\/(authorize|start|cancel))?$/i.exec(url.pathname);
  if (operation) {
    const [, id, action] = operation;
    if (request.method === 'GET' && !action) {
      const scope = envelope.parse({ requestId, conversationId: url.searchParams.get('conversationId') ?? undefined });
      json(response, 200, service.operation(id, scope));
      return true;
    }
    if (request.method === 'POST') {
      const payload = envelope.parse(await body(request));
      const current = service.operation(id, payload);
      if (action === 'authorize') {
        if (!hasUiCapability(request, ports.uiToken)) {
          json(response, 403, { error: 'COMFY_UI_AUTH_REQUIRED' });
          return true;
        }
        if (!payload.conversationId) throw new Error('COMFY_CONVERSATION_REQUIRED');
        if (current.state === 'running' || current.state === 'completed') {
          json(response, 200, current);
          return true;
        }
        // The UI click authorizes and queues this saved plan without an LLM handoff.
        service.authorize(id, payload.conversationId);
        json(response, 202, service.start(id, current.requestId));
        return true;
      }
      if (action === 'start') {
        if (!payload.requestId) throw new Error('COMFY_REQUEST_REQUIRED');
        json(response, 202, service.start(id, payload.requestId));
        return true;
      }
      if (action === 'cancel') {
        json(response, 200, service.cancelOperation(id, payload));
        return true;
      }
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/comfy/jobs') {
    const payload = z
      .object({ requestId: z.string().uuid(), profileId: z.string().min(1), input: z.unknown() })
      .parse(await body(request));
    json(response, 202, service.generate(payload.requestId, payload.profileId, payload.input));
    return true;
  }
  const job = /^\/api\/comfy\/jobs\/([a-f\d-]{36})(?:\/(cancel|artifacts\/\d+))?$/i.exec(url.pathname);
  if (job) {
    const [, id, action] = job;
    if (request.method === 'GET' && !action) {
      const scope = envelope.parse({ requestId, conversationId: url.searchParams.get('conversationId') ?? undefined });
      json(response, 200, service.job(id, scope));
      return true;
    }
    if (request.method === 'POST' && action === 'cancel') {
      const payload = envelope.parse(await body(request));
      json(response, 200, await service.cancelJob(id, payload));
      return true;
    }
    if (request.method === 'GET' && action?.startsWith('artifacts/')) {
      const scope = envelope.parse({ requestId, conversationId: url.searchParams.get('conversationId') ?? undefined });
      const saved = service.job(id, scope),
        artifact = saved.artifacts[Number(action.split('/')[1])];
      if (!artifact || saved.status !== 'succeeded') throw new Error('COMFY_ARTIFACT_NOT_FOUND');
      const stat = fs.statSync(artifact.path);
      if (!stat.isFile()) throw new Error('COMFY_ARTIFACT_NOT_FOUND');
      const range = request.headers.range;
      let start = 0,
        end = stat.size - 1,
        partial = false;
      if (range) {
        const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!parsed || (!parsed[1] && !parsed[2])) {
          response.writeHead(416, { 'content-range': `bytes */${stat.size}` });
          response.end();
          return true;
        }
        start = parsed[1] ? Number(parsed[1]) : Math.max(0, stat.size - Number(parsed[2]));
        end = parsed[1] && parsed[2] ? Math.min(Number(parsed[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start < 0 || start >= stat.size) {
          response.writeHead(416, { 'content-range': `bytes */${stat.size}` });
          response.end();
          return true;
        }
        partial = true;
      }
      response.writeHead(partial ? 206 : 200, {
        'content-type': artifact.mimeType,
        'content-length': end - start + 1,
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=3600',
        'access-control-allow-origin': 'http://127.0.0.1:33001',
        ...(partial ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
      });
      const stream = fs.createReadStream(artifact.path, { start, end });
      response.once('close', () => stream.destroy());
      stream.once('error', () => response.destroy());
      stream.pipe(response);
      return true;
    }
  }
  json(response, 404, { error: 'NOT_FOUND' });
  return true;
}

function hasUiCapability(request: http.IncomingMessage, token?: string): boolean {
  const provided = request.headers['x-openh3-ui-token'];
  if (!token || typeof provided !== 'string' || provided.length !== token.length) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && cryptoTimingSafeEqual(a, b);
}
