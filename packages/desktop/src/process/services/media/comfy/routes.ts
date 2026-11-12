import fs from 'node:fs';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { z } from 'zod';
import { generationAttemptRequestSchema } from '@/common/chat/document/creation/workflows/contracts';
import { probeComfyEnvironment } from './discovery/environment';
import { discoverComfySources } from './discovery/sourceDiscovery';
import { loadComfyInstallCatalog, records } from './planning/catalog';
import { readComfyModelGuide } from './planning/modelGuide';
import {
  comfyInstallRequestSchema,
  comfyModelFamilySchema,
  comfyProfileSchema,
  type ComfyInstallIdentityRequest,
} from '@/common/chat/document/creation/comfy';
import type { ComfyService } from './ComfyService';
import type { ComfyPromptObserver } from '../creation/ComfyPromptObserver';
import type { ComfyInstallContinuation } from '../creation/installContinuation';

type Ports = {
  json: (response: http.ServerResponse, status: number, data: unknown) => void;
  body: (request: http.IncomingMessage) => Promise<unknown>;
  service: ComfyService;
  observer?: ComfyPromptObserver;
  uiToken?: string;
  setBackendPort?: (port: number) => void;
  continuation?: Pick<ComfyInstallContinuation, 'control'>;
};
const envelope = z
  .object({
    requestId: z.string().uuid().optional(),
    conversationId: z.string().min(1).optional(),
    sourceOverrides: z
      .array(z.object({ component: z.string().min(1), urls: z.array(z.string().url()).min(1).max(4) }))
      .max(64)
      .optional(),
  })
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
  if (request.method === 'POST' && url.pathname === '/api/comfy/continuation-control') {
    if (!hasUiCapability(request, ports.uiToken)) {
      json(response, 403, { error: 'COMFY_UI_AUTH_REQUIRED' });
      return true;
    }
    const payload = z
      .object({
        conversationId: z.string().trim().min(1),
        action: z.enum(['status', 'pause', 'resume']),
        epoch: z.string().optional(),
      })
      .parse(await body(request));
    if (!ports.continuation) throw new Error('COMFY_CONTINUATION_UNAVAILABLE');
    json(response, 200, ports.continuation.control(payload.conversationId, payload.action, payload.epoch));
    return true;
  }
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
  if (request.method === 'GET' && url.pathname === '/api/comfy/model-center') {
    json(response, 200, await service.modelCenter(url.searchParams.get('directory') ?? undefined));
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/comfy/workflows/resolve') {
    const payload = envelope
      .and(z.object({ profileId: z.string().min(1).optional(), input: z.unknown() }))
      .parse(await body(request));
    const result = payload.requestId
      ? service.resolveWorkflow(payload.requestId, payload.input)
      : payload.profileId
        ? service.resolveConversationWorkflow(payload.conversationId!, payload.profileId, payload.input)
        : {
            action: 'choose-model',
            profiles: service.profiles(),
            nextAction:
              'Choose a registered profile matching the user goal, then resolve with its profileId. No model-card visit is required.',
          };
    json(response, 200, result);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/comfy/workflows/prepare') {
    const payload = envelope.and(z.object({ profileId: z.string().min(1) })).parse(await body(request));
    const selection = payload.requestId ? service.selection(payload.requestId) : undefined;
    const profile = service.profiles().find((item) => item.id === payload.profileId);
    if (!profile || (selection && (selection.source !== 'local' || profile.family !== selection.family)))
      throw new Error('COMFY_FAMILY_MISMATCH');
    json(response, 200, service.prepareWorkflows(payload.profileId));
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/comfy/observe-prompt') {
    const payload = z
      .object({
        requestId: z.string().uuid().optional(),
        conversationId: z.string().min(1).optional(),
        baseUrl: z.string().url(),
        promptId: z.string().uuid(),
        kind: z.enum(['image', 'video']),
      })
      .parse(await body(request));
    const selection = payload.requestId ? service.selection(payload.requestId) : undefined;
    if (
      selection &&
      (selection.source !== 'local' ||
        selection.kind !== payload.kind ||
        (payload.conversationId && payload.conversationId !== selection.conversationId))
    )
      throw new Error('COMFY_SCOPE_MISMATCH');
    const conversationId = z
      .string()
      .min(1)
      .parse(selection?.conversationId ?? payload.conversationId);
    if (!ports.observer) throw new Error('COMFY_OBSERVER_UNAVAILABLE');
    const job = ports.observer.observe({ ...payload, conversationId });
    void ports.observer.tick().catch(() => console.warn('[comfy] COMFY_OBSERVER_UNAVAILABLE'));
    json(response, 202, { comfyJobId: job.id, job });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/comfy/model-guide') {
    const selection = requestId ? service.selection(requestId) : undefined;
    const family = comfyModelFamilySchema.parse(url.searchParams.get('family') ?? selection?.family);
    // Reading model knowledge does not alter or authorize the selected generation target.
    json(response, 200, readComfyModelGuide(family, url.searchParams.get('candidateId') ?? undefined));
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/comfy/agent-installation-complete') {
    const input = envelope.and(z.object({ jobId: z.string().min(1) })).parse(await body(request));
    const installationRequestId = input.requestId ?? service.conversationInstallationRequest(input.conversationId!);
    json(response, 200, await service.completeAgentInstallation(installationRequestId, input.jobId));
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/comfy/sources') {
    const input = z
      .object({
        requestId: z.string().uuid(),
        component: z.string().min(1),
        repositories: z
          .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
          .max(4)
          .optional(),
      })
      .parse(await body(request));
    const selection = service.selection(input.requestId);
    const components = loadComfyInstallCatalog()
      .candidates.filter((item) => item.family === selection.family)
      .flatMap((item) => records(item.components));
    const component = components.find((item) => item.name === input.component);
    if (!component) throw new Error('COMFY_SOURCE_COMPONENT_UNKNOWN');
    json(response, 200, await discoverComfySources(component, { repositories: input.repositories }));
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/comfy/bind') {
    service.bind(await body(request));
    json(response, 200, { ok: true });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/comfy/activity') {
    const conversationId = requestId
      ? service.selection(requestId).conversationId
      : z.string().min(1).parse(url.searchParams.get('conversationId'));
    const activity = service.activity(conversationId);
    json(
      response,
      200,
      requestId
        ? {
            selection: service.selection(requestId),
            operations: activity.operations.filter((item) => service.isRequestRelated(item.requestId, requestId)),
            preparations: activity.preparations.filter((item) => service.isRequestRelated(item.requestId, requestId)),
            jobs: [],
          }
        : activity
    );
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
      if (url.searchParams.get('inventory') === '1') {
        await service.refreshProfiles().catch((): undefined => undefined);
        json(response, 200, {
          ...service.inventory(),
          ...(requestId ? { selection: service.selection(requestId) } : {}),
        });
        return true;
      }
      const profiles = await service.refreshProfiles();
      json(response, 200, requestId ? { profiles, selection: service.selection(requestId) } : profiles);
      return true;
    }
    if (request.method === 'POST') {
      const payload = envelope
        .and(
          z.object({
            action: z.enum(['register', 'revalidate', 'adopt-repair']),
            profile: z.unknown().optional(),
            profileId: z.string().optional(),
            smokeInput: z.unknown().optional(),
            jobId: z.string().uuid().optional(),
            installationIntent: z.enum(['install', 'install-other']).optional(),
            attempt: generationAttemptRequestSchema.optional(),
          })
        )
        .parse(await body(request));
      if (!payload.requestId && payload.action === 'adopt-repair') throw new Error('COMFY_GENERATION_INTENT_REQUIRED');
      const profileRequestId = payload.requestId ?? service.conversationInstallationRequest(payload.conversationId!);
      const installationIntent = payload.installationIntent ?? (!payload.requestId ? 'install' : undefined);
      const scope = service.selection(profileRequestId);
      if (payload.action === 'register') {
        const profile = comfyProfileSchema.parse(payload.profile);
        if (installationIntent)
          service.installationScope(profileRequestId, profile.family, installationIntent, profile.kind);
        else if (scope.source !== 'local' || scope.family !== profile.family) throw new Error('COMFY_FAMILY_MISMATCH');
        json(response, 200, service.register(profile));
      } else if (payload.action === 'adopt-repair') {
        if (!payload.profileId || !payload.jobId) throw new Error('COMFY_INSTALL_VALIDATION_REQUIRED');
        json(response, 200, {
          selection: await service.adoptRepairedProfile(profileRequestId, payload.profileId, payload.jobId),
        });
      } else {
        if (!payload.profileId) throw new Error('COMFY_PROFILE_REQUIRED');
        if (!payload.smokeInput) throw new Error('COMFY_SMOKE_INPUT_REQUIRED');
        const job = service.verify(
          profileRequestId,
          payload.profileId,
          payload.smokeInput,
          'smoke',
          installationIntent,
          payload.attempt
        );
        json(response, 202, { comfyJobId: job.id, job, validation: true });
      }
      return true;
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/comfy/operations') {
    const payload = envelope
      .and(z.object({ plan: z.unknown().optional(), install: z.unknown().optional() }))
      .refine((value) => value.plan !== undefined || value.install !== undefined, {
        message: 'COMFY_INSTALL_REQUEST_REQUIRED',
      })
      .parse(await body(request));
    const installRequest = comfyInstallRequestSchema.parse(
      payload.install ?? { action: 'request', plan: payload.plan }
    );
    const installRequestId = payload.requestId ?? service.conversationInstallationRequest(payload.conversationId!);
    json(response, 201, await service.request(installRequestId, installRequest));
    return true;
  }
  const operation =
    /^\/api\/comfy\/operations\/([a-f\d-]{36})(?:\/(authorize|start|recover|cancel|acknowledge))?$/i.exec(url.pathname);
  if (operation) {
    const [, id, action] = operation;
    if (request.method === 'POST' && action === 'acknowledge') {
      const payload = envelope.and(z.object({ updatedAt: z.string().min(1) })).parse(await body(request));
      json(response, 200, { acknowledged: service.acknowledgeOperation(id, payload, payload.updatedAt) });
      return true;
    }
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
        json(response, 202, service.start(id, current.requestId));
        return true;
      }
      if (action === 'recover') {
        json(
          response,
          202,
          await service.recoverOrReplanInstallation(
            id,
            current.requestId,
            payload.sourceOverrides as ComfyInstallIdentityRequest['sourceOverrides']
          )
        );
        return true;
      }
      if (action === 'cancel') {
        json(response, 200, service.cancelOperation(id, payload));
        return true;
      }
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/comfy/jobs') {
    const payload = envelope
      .and(
        z.object({
          profileId: z.string().min(1),
          input: z.unknown(),
          attempt: generationAttemptRequestSchema.optional(),
        })
      )
      .parse(await body(request));
    const generationRequestId =
      payload.requestId ?? service.conversationGenerationRequest(payload.conversationId!, payload.profileId);
    json(response, 202, service.generate(generationRequestId, payload.profileId, payload.input, payload.attempt));
    return true;
  }
  const job = /^\/api\/comfy\/jobs\/([a-f\d-]{36})(?:\/(cancel|acknowledge|artifacts\/\d+))?$/i.exec(url.pathname);
  if (job) {
    const [, id, action] = job;
    const observed = ports.observer?.has(id);
    const readJob = (scope: { requestId?: string; conversationId?: string }) =>
      observed ? ports.observer!.job(id, scope) : service.job(id, scope);
    if (request.method === 'POST' && action === 'acknowledge') {
      const payload = envelope.and(z.object({ updatedAt: z.string().min(1) })).parse(await body(request));
      readJob(payload);
      json(response, 200, { acknowledged: observed ? false : service.acknowledgeJob(id, payload, payload.updatedAt) });
      return true;
    }
    if (request.method === 'GET' && !action) {
      const scope = envelope.parse({ requestId, conversationId: url.searchParams.get('conversationId') ?? undefined });
      json(response, 200, readJob(scope));
      return true;
    }
    if (request.method === 'POST' && action === 'cancel') {
      const payload = envelope.parse(await body(request));
      if (observed) {
        readJob(payload);
        throw new Error('COMFY_OBSERVATION_READ_ONLY');
      }
      json(response, 200, await service.cancelJob(id, payload));
      return true;
    }
    if (request.method === 'GET' && action?.startsWith('artifacts/')) {
      const scope = envelope.parse({ requestId, conversationId: url.searchParams.get('conversationId') ?? undefined });
      const saved = readJob(scope),
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
