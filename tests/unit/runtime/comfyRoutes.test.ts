import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComfyApprovalResolver } from '@/process/services/media/creation/installApproval';
import { ComfyService } from '@/process/services/media/comfy/ComfyService';
import type { ComfyServiceOptions } from '@/process/services/media/comfy/ComfyService';
import { ComfyPromptObserver } from '@/process/services/media/creation/ComfyPromptObserver';
import { handleComfyRoute } from '@/process/services/media/comfy/routes';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const task of cleanup.reverse()) await task();
  cleanup.length = 0;
});
async function fixture(discover?: ComfyServiceOptions['discover']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-http-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = path.join(root, 'output.png');
  fs.writeFileSync(artifact, Buffer.from([1, 2, 3, 4]));
  const profile: ComfyProfile = {
    id: 'z-1',
    family: 'z-image',
    name: 'Z',
    kind: 'image',
    version: 'abc123',
    quantization: 'bf16',
    capabilities: ['text-to-image'],
    state: 'downloaded',
    environment: { root, python: path.join(root, 'python'), baseUrl: 'http://127.0.0.1:8188' },
    components: [{ role: 'diffusion', name: 'z', path: path.join(root, 'z'), version: 'abc123', precision: 'bf16' }],
    nodes: [{ id: 'ComfyUI', version: 'v1' }],
    workflowPath: path.join(root, 'api.json'),
    bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
    defaults: {},
  };
  const result = { promptId: 'p', artifacts: [{ path: artifact, mimeType: 'image/png' }] };
  const engine = {
    validate: vi.fn(async () => ({ fingerprint: 'f', loadable: true as const })),
    snapshotFingerprint: vi.fn(async () => 'f'),
    generate: vi.fn(async () => result),
    resume: vi.fn(async () => result),
    ensureStarted: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    stopOwned: vi.fn(),
  };
  const service = new ComfyService({
    filename: path.join(root, 'manifest.json'),
    engine,
    install: vi.fn(),
    verifyArtifact: async (): Promise<void> => undefined,
    discover,
  });
  const observer = new ComfyPromptObserver({
    filename: path.join(root, 'observed.json'),
    outputRoot: path.join(root, 'observed-output'),
    verifyArtifact: async (): Promise<void> => undefined,
  });
  const server = http.createServer(async (request, response) => {
    const json = (_response: http.ServerResponse, status: number, value: unknown): void => {
      _response.writeHead(status, { 'content-type': 'application/json' });
      _response.end(JSON.stringify(value));
    };
    const body = async (incoming: http.IncomingMessage): Promise<unknown> => {
      let text = '';
      for await (const chunk of incoming) text += chunk;
      return JSON.parse(text || '{}');
    };
    try {
      if (
        !(await handleComfyRoute(request, response, new URL(request.url ?? '/', 'http://localhost'), {
          service,
          observer,
          uiToken: 'test-ui-token',
          json,
          body,
        }))
      )
        json(response, 404, {});
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    await service.close();
    observer.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (route: string, payload: unknown): Promise<Response> =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  return { service, engine, base, post, profile, observer };
}
describe('ComfyUI media-service routes', () => {
  it('resolves and generates successive image and video shots in a plain conversation', async () => {
    const { service, engine, post, profile, base } = await fixture();
    fs.writeFileSync(
      profile.workflowPath,
      JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } } })
    );
    service.register(profile);
    service.register({
      ...profile,
      id: 'video-1',
      family: 'custom-video',
      kind: 'video',
      capabilities: ['text-to-video'],
    });
    const resolve = await post('/api/comfy/workflows/resolve', {
      conversationId: 'story-chat',
      profileId: profile.id,
      input: { prompt: 'Character reference' },
    });
    expect(resolve.status).toBe(200);
    expect(await resolve.json()).toMatchObject({ selectedProfileId: profile.id });
    expect(service.activity('story-chat').jobs).toHaveLength(0);
    const ids: string[] = [];
    for (const [profileId, prompt] of [
      [profile.id, 'Character reference'],
      ['video-1', 'Morning'],
      ['video-1', 'Evening'],
    ]) {
      if (profileId === 'video-1')
        engine.generate.mockResolvedValueOnce({
          promptId: prompt,
          artifacts: [{ path: profile.workflowPath, mimeType: 'video/mp4' }],
        });
      const response = await post('/api/comfy/jobs', { conversationId: 'story-chat', profileId, input: { prompt } });
      expect(response.status).toBe(202);
      const job = await response.json();
      ids.push(job.id);
      await service.idle();
      const finished = service.job(job.id, { conversationId: 'story-chat' });
      expect(finished.status, finished.error).toBe('succeeded');
    }
    expect(new Set(ids).size).toBe(3);
    expect(engine.generate).toHaveBeenCalledTimes(3);
    const denied = await fetch(`${base}/api/comfy/jobs/${ids[0]}?conversationId=another-chat`);
    expect(denied.status).toBe(400);
  });
  it('offers model choices in plain chat while preserving an explicit model-card selection', async () => {
    const { service, post, profile } = await fixture();
    service.register(profile);
    const choice = await post('/api/comfy/workflows/resolve', { conversationId: 'plain', input: { prompt: 'A cup' } });
    expect(await choice.json()).toMatchObject({ action: 'choose-model', profiles: [{ id: profile.id }] });
    const requestId = crypto.randomUUID();
    service.bind({ requestId, conversationId: 'card', profileId: profile.id, intent: 'generate' });
    service.register({ ...profile, id: 'other', family: 'other-image' });
    const wrongModel = await post('/api/comfy/jobs', { requestId, profileId: 'other', input: { prompt: 'A cup' } });
    expect(wrongModel.status).toBe(400);
    expect(service.selection(requestId).profileId).toBe(profile.id);
  });
  it.each(['image', 'video'] as const)(
    'registers and validates a custom %s model from a general conversation',
    async (kind) => {
      const { service, engine, post, profile, base } = await fixture();
      const custom = {
        ...profile,
        id: `custom-${kind}`,
        name: `Custom ${kind} model`,
        family: `custom-${kind}`,
        kind,
        capabilities: [kind === 'image' ? 'text-to-image' : 'text-to-video'],
        components: profile.components.map((component) => ({ ...component, sha256: 'a'.repeat(64), sizeBytes: 4 })),
      };
      engine.generate.mockResolvedValueOnce({
        promptId: 'custom-prompt',
        artifacts: [{ path: profile.workflowPath, mimeType: `${kind}/${kind === 'image' ? 'png' : 'mp4'}` }],
      });
      fs.writeFileSync(
        profile.workflowPath,
        JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: 'test' } } })
      );
      const registered = await post('/api/comfy/profiles', {
        action: 'register',
        conversationId: 'plain-chat',
        profile: custom,
      });
      expect(registered.status).toBe(200);
      expect(await registered.json()).toMatchObject({ family: custom.family, kind, state: 'downloaded' });
      const validation = await post('/api/comfy/profiles', {
        action: 'revalidate',
        conversationId: 'plain-chat',
        profileId: custom.id,
        smokeInput: { prompt: 'Test output' },
      });
      expect(validation.status).toBe(202);
      const { comfyJobId } = await validation.json();
      await service.idle();
      expect(service.job(comfyJobId, { conversationId: 'plain-chat' })).toMatchObject({ status: 'succeeded', kind });
      const wrongConversation = await post('/api/comfy/agent-installation-complete', {
        conversationId: 'other-chat',
        jobId: comfyJobId,
      });
      expect(wrongConversation.status).toBe(400);
      const complete = await post('/api/comfy/agent-installation-complete', {
        conversationId: 'plain-chat',
        jobId: comfyJobId,
      });
      expect(complete.status).toBe(200);
      const inventory = await (await fetch(`${base}/api/comfy/profiles?inventory=1`)).json();
      expect(inventory.profiles).toContainEqual(
        expect.objectContaining({ id: custom.id, family: custom.family, kind, state: 'verified' })
      );
      const requestId = service.conversationInstallationRequest('plain-chat');
      expect(service.selection(requestId).profileId).toBeUndefined();
    }
  );
  it('requires the desktop UI capability to change continuation stop state', async () => {
    const control = vi.fn(() => ({ epoch: 'saved-stop', paused: true }));
    const json = vi.fn();
    const ports = {
      service: {} as ComfyService,
      continuation: { control },
      uiToken: 'test-ui-token',
      json,
      body: vi.fn(async () => ({ conversationId: 'chat', action: 'pause' })),
    };
    const url = new URL('http://localhost/api/comfy/continuation-control');
    await handleComfyRoute(
      { method: 'POST', headers: {} } as http.IncomingMessage,
      {} as http.ServerResponse,
      url,
      ports
    );
    expect(json).toHaveBeenLastCalledWith({}, 403, { error: 'COMFY_UI_AUTH_REQUIRED' });
    expect(control).not.toHaveBeenCalled();
    await handleComfyRoute(
      { method: 'POST', headers: { 'x-openh3-ui-token': 'test-ui-token' } } as http.IncomingMessage,
      {} as http.ServerResponse,
      url,
      ports
    );
    expect(control).toHaveBeenCalledWith('chat', 'pause', undefined);
    expect(json).toHaveBeenLastCalledWith({}, 200, { epoch: 'saved-stop', paused: true });
  });
  it('forwards explicit managed operation acknowledgements with the exact scope and terminal version', async () => {
    const id = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const updatedAt = '2026-11-09T12:00:00.000Z';
    const service = {
      acknowledgeOperation: vi.fn(() => true),
      selection: vi.fn(),
      operation: vi.fn(() => ({ id, requestId, state: 'completed', updatedAt })),
    };
    const json = vi.fn();
    const ports = {
      service: service as unknown as ComfyService,
      json,
      body: vi.fn(async () => ({ requestId, updatedAt })),
    };
    expect(
      await handleComfyRoute(
        { method: 'POST' } as http.IncomingMessage,
        {} as http.ServerResponse,
        new URL(`http://127.0.0.1/api/comfy/operations/${id}/acknowledge`),
        ports
      )
    ).toBe(true);
    expect(service.acknowledgeOperation).toHaveBeenCalledWith(id, { requestId, updatedAt }, updatedAt);
    expect(json).toHaveBeenLastCalledWith(expect.anything(), 200, { acknowledged: true });
    service.acknowledgeOperation.mockClear();
    await handleComfyRoute(
      { method: 'GET' } as http.IncomingMessage,
      {} as http.ServerResponse,
      new URL(`http://127.0.0.1/api/comfy/operations/${id}?requestId=${requestId}`),
      ports
    );
    expect(service.operation).toHaveBeenCalledWith(id, { requestId, conversationId: undefined });
    expect(service.acknowledgeOperation).not.toHaveBeenCalled();
  });

  it.each([
    { requestId: crypto.randomUUID() },
    { requestId: crypto.randomUUID(), updatedAt: '' },
    { updatedAt: 'now' },
  ])('rejects incomplete managed operation acknowledgement payload %o', async (payload) => {
    const acknowledgeOperation = vi.fn();
    await expect(
      handleComfyRoute(
        { method: 'POST' } as http.IncomingMessage,
        {} as http.ServerResponse,
        new URL(`http://127.0.0.1/api/comfy/operations/${crypto.randomUUID()}/acknowledge`),
        {
          service: { acknowledgeOperation } as unknown as ComfyService,
          json: vi.fn(),
          body: async () => payload,
        }
      )
    ).rejects.toThrow();
    expect(acknowledgeOperation).not.toHaveBeenCalled();
  });

  it('acknowledges only the scoped terminal version explicitly read by an Agent', async () => {
    const { service, profile, base, post } = await fixture();
    const requestId = crypto.randomUUID();
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', family: profile.family, intent: 'install', source: 'local' });
    const job = service.verify(requestId, profile.id, { prompt: 'verify' });
    await service.idle();
    const terminal = await (await fetch(`${base}/api/comfy/jobs/${job.id}?requestId=${requestId}`)).json();
    expect(service.installationValidationUpdates()).toHaveLength(1);
    const wrong = await post(`/api/comfy/jobs/${job.id}/acknowledge`, {
      requestId: crypto.randomUUID(),
      updatedAt: terminal.updatedAt,
    });
    expect(wrong.status).toBe(400);
    expect(service.installationValidationUpdates()).toHaveLength(1);
    expect(
      await (await post(`/api/comfy/jobs/${job.id}/acknowledge`, { requestId, updatedAt: 'old-version' })).json()
    ).toEqual({ acknowledged: false });
    expect(
      await (await post(`/api/comfy/jobs/${job.id}/acknowledge`, { requestId, updatedAt: terminal.updatedAt })).json()
    ).toEqual({ acknowledged: true });
    expect(service.installationValidationUpdates()).toEqual([]);
  });

  it('activates a validated variant through the scoped HTTP API and returns the persisted selection', async () => {
    const { service, profile, base, post } = await fixture();
    const requestId = crypto.randomUUID();
    service.register(profile);
    service.register({ ...profile, id: 'reference-variant' });
    await post('/api/comfy/bind', { requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    const verified = await post('/api/comfy/profiles', {
      action: 'revalidate',
      requestId,
      profileId: 'reference-variant',
      smokeInput: { prompt: 'original goal' },
    });
    expect(verified.status).toBe(202);
    const { comfyJobId } = await verified.json();
    await service.idle();
    const adopted = await post('/api/comfy/profiles', {
      action: 'adopt-repair',
      requestId,
      profileId: 'reference-variant',
      jobId: comfyJobId,
    });
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toMatchObject({
      selection: { requestId, profileId: 'reference-variant', intent: 'generate' },
    });
    const activity = await fetch(`${base}/api/comfy/activity?requestId=${requestId}`);
    expect(await activity.json()).toMatchObject({ selection: { profileId: 'reference-variant' } });
    const otherRequest = crypto.randomUUID();
    service.bind({ requestId: otherRequest, conversationId: 'other-chat', profileId: profile.id, intent: 'generate' });
    const crossed = await post('/api/comfy/profiles', {
      action: 'adopt-repair',
      requestId: otherRequest,
      profileId: 'reference-variant',
      jobId: comfyJobId,
    });
    expect(crossed.status).toBe(400);
    expect(await crossed.json()).toMatchObject({ error: 'COMFY_INSTALL_VALIDATION_REQUIRED' });
  });

  it('returns partial inventory diagnostics with useful profiles when another scan fails', async () => {
    const { service, profile, base } = await fixture(async () => {
      throw new Error('COMFY_INVENTORY_SCAN_INCOMPLETE');
    });
    service.register(profile);
    const response = await fetch(`${base}/api/comfy/profiles?inventory=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      complete: false,
      profiles: [{ id: profile.id }],
      diagnostics: [{ code: 'COMFY_INVENTORY_SCAN_INCOMPLETE' }],
    });
  });

  it('attaches an existing prompt without profile inventory and scopes observation and cancellation', async () => {
    const { post, base, observer } = await fixture(async () => {
      throw new Error('COMFY_INVENTORY_UNAVAILABLE');
    });
    const promptId = crypto.randomUUID();
    const attached = await post('/api/comfy/observe-prompt', {
      conversationId: 'chat',
      baseUrl: 'http://127.0.0.1:1',
      promptId,
      kind: 'image',
    });
    expect(attached.status).toBe(202);
    const { comfyJobId } = (await attached.json()) as { comfyJobId: string };
    expect(observer.has(comfyJobId)).toBe(true);
    expect((await fetch(`${base}/api/comfy/jobs/${comfyJobId}?conversationId=chat`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/comfy/jobs/${comfyJobId}?conversationId=other`)).json()).toMatchObject({
      error: 'COMFY_SCOPE_MISMATCH',
    });
    expect(await (await post(`/api/comfy/jobs/${comfyJobId}/cancel`, { conversationId: 'chat' })).json()).toMatchObject(
      { error: 'COMFY_OBSERVATION_READ_ONLY' }
    );
  });
  it('scopes Agent status to its bound installation request even in a shared conversation', async () => {
    const { service, base } = await fixture();
    const requestId = '11111111-1111-4111-8111-111111111111';
    service.bind({ requestId, conversationId: 'chat', family: 'z-image', intent: 'install', source: 'local' });
    vi.spyOn(service, 'activity').mockReturnValue({
      operations: [],
      jobs: [],
      preparations: [
        { requestId, conversationId: 'chat', family: 'z-image', intent: 'install', status: 'failed', updatedAt: 'now' },
        {
          requestId: 'other',
          conversationId: 'chat',
          family: 'qwen-edit',
          intent: 'install',
          status: 'detecting',
          updatedAt: 'now',
        },
      ],
    });
    const response = await fetch(`${base}/api/comfy/activity?requestId=${requestId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).preparations).toHaveLength(1);
  });
  it.each([0, 65536, 13422.5, '13422', undefined])('rejects an invalid Core port (%s)', async (backendPort) => {
    const setBackendPort = vi.fn();
    await expect(
      handleComfyRoute(
        { method: 'POST', headers: { 'x-openh3-ui-token': 'test-ui-token' } } as http.IncomingMessage,
        {} as http.ServerResponse,
        new URL('http://127.0.0.1/api/comfy/runtime-context'),
        {
          service: {} as never,
          uiToken: 'test-ui-token',
          setBackendPort,
          json: vi.fn(),
          body: vi.fn().mockResolvedValue({ backendPort }),
        }
      )
    ).rejects.toThrow();
    expect(setBackendPort).not.toHaveBeenCalled();
  });
  it.each([undefined, 'wrong', 'test-ui-token'])(
    'allows only the UI capability to refresh the Core connection (%s)',
    async (token) => {
      const setBackendPort = vi.fn();
      const json = vi.fn();
      await handleComfyRoute(
        { method: 'POST', headers: token ? { 'x-openh3-ui-token': token } : {} } as http.IncomingMessage,
        {} as http.ServerResponse,
        new URL('http://127.0.0.1/api/comfy/runtime-context'),
        {
          service: {} as never,
          uiToken: 'test-ui-token',
          setBackendPort,
          json,
          body: vi.fn().mockResolvedValue({ backendPort: 13422 }),
        }
      );
      if (token === 'test-ui-token') {
        expect(setBackendPort).toHaveBeenCalledWith(13422);
        expect(json).toHaveBeenCalledWith(expect.anything(), 200, { ok: true });
      } else {
        expect(setBackendPort).not.toHaveBeenCalled();
        expect(json).toHaveBeenCalledWith(expect.anything(), 403, { error: 'COMFY_UI_AUTH_REQUIRED' });
      }
    }
  );
  it.each(['awaiting-consent', 'running', 'completed'])(
    'starts the exact reviewed operation after UI authorization and safely repeats a %s request',
    async (state) => {
      const id = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const operation = { id, requestId, conversationId: 'chat', state };
      const service = {
        operation: vi.fn(() => operation),
        authorize: vi.fn(() => ({ ...operation, state: 'authorized' })),
        start: vi.fn(() => ({ ...operation, state: 'running' })),
      };
      const json = vi.fn();
      await handleComfyRoute(
        { method: 'POST', headers: { 'x-openh3-ui-token': 'ui-token' } } as http.IncomingMessage,
        {} as http.ServerResponse,
        new URL(`http://127.0.0.1/api/comfy/operations/${id}/authorize`),
        {
          service: service as never,
          uiToken: 'ui-token',
          json,
          body: vi.fn().mockResolvedValue({ conversationId: 'chat' }),
        }
      );
      if (state === 'awaiting-consent') {
        expect(service.authorize).toHaveBeenCalledWith(id, 'chat');
        expect(service.start).toHaveBeenCalledWith(id, requestId);
        expect(service.authorize.mock.invocationCallOrder[0]).toBeLessThan(service.start.mock.invocationCallOrder[0]);
        expect(json).toHaveBeenCalledWith(expect.anything(), 202, { ...operation, state: 'running' });
      } else {
        expect(service.authorize).not.toHaveBeenCalled();
        expect(service.start).not.toHaveBeenCalled();
        expect(json).toHaveBeenCalledWith(expect.anything(), 200, operation);
      }
    }
  );

  it('rejects authorize without the Electron UI capability token', async () => {
    const json = vi.fn();
    const service = {
      operation: vi.fn(() => ({ requestId: crypto.randomUUID(), conversationId: 'chat' })),
      authorize: vi.fn(),
    };
    const handled = await handleComfyRoute(
      { method: 'POST', headers: {} } as http.IncomingMessage,
      {} as http.ServerResponse,
      new URL('http://127.0.0.1/api/comfy/operations/11111111-1111-4111-8111-111111111111/authorize'),
      {
        service: service as never,
        uiToken: 'test-ui-token',
        json,
        body: vi.fn().mockResolvedValue({ requestId: crypto.randomUUID(), conversationId: 'chat' }),
      }
    );

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(expect.anything(), 403, { error: 'COMFY_UI_AUTH_REQUIRED' });
    expect(service.authorize).not.toHaveBeenCalled();
  });

  it('binds a cloud context without a local family and returns authoritative selection', async () => {
    const { post, base } = await fixture();
    const requestId = crypto.randomUUID();
    expect(
      (await post('/api/comfy/bind', { requestId, conversationId: 'chat', source: 'cloud', kind: 'image' })).status
    ).toBe(200);
    expect(await (await fetch(`${base}/api/comfy/profiles?requestId=${requestId}`)).json()).toMatchObject({
      profiles: [],
      selection: { source: 'cloud', kind: 'image' },
    });
    expect(await (await fetch(base + '/api/comfy/profiles')).json()).toEqual([]);
  });
  it('registers without trusting state and executes explicit verification asynchronously', async () => {
    const { post, base, profile, service } = await fixture();
    const requestId = crypto.randomUUID();
    await post('/api/comfy/bind', {
      requestId,
      conversationId: 'chat',
      source: 'local',
      kind: 'image',
      family: 'z-image',
      intent: 'install',
    });
    expect(
      await (
        await post('/api/comfy/profiles', { requestId, action: 'register', profile: { ...profile, state: 'verified' } })
      ).json()
    ).toMatchObject({ state: 'downloaded' });
    const verification = await post('/api/comfy/profiles', {
      requestId,
      action: 'revalidate',
      profileId: profile.id,
      smokeInput: { prompt: 'small red sphere' },
    });
    expect(verification.status).toBe(202);
    const pending = (await verification.json()) as { comfyJobId: string };
    await service.idle();
    expect((await fetch(base + '/api/comfy/jobs/' + pending.comfyJobId)).status).toBe(400);
    expect((await fetch(base + '/api/comfy/jobs/' + pending.comfyJobId + '/artifacts/0')).status).toBe(400);
    expect((await post('/api/comfy/jobs/' + pending.comfyJobId + '/cancel', {})).status).toBe(400);
    expect((await post('/api/comfy/jobs/' + pending.comfyJobId + '/cancel', { conversationId: 'other' })).status).toBe(
      400
    );
    expect(
      await (await fetch(base + '/api/comfy/jobs/' + pending.comfyJobId + '?conversationId=chat')).json()
    ).toMatchObject({ status: 'succeeded' });
    expect(
      await (await fetch(base + '/api/comfy/jobs/' + pending.comfyJobId + '?requestId=' + requestId)).json()
    ).toMatchObject({
      status: 'succeeded',
    });
    expect(
      (
        await fetch(base + '/api/comfy/jobs/' + pending.comfyJobId + '/artifacts/0?requestId=' + requestId, {
          headers: { range: 'bytes=1-2' },
        })
      ).status
    ).toBe(206);
    const output = await fetch(base + '/api/comfy/jobs/' + pending.comfyJobId + '/artifacts/0?requestId=' + requestId, {
      headers: { range: 'bytes=1-2' },
    });
    expect([...new Uint8Array(await output.arrayBuffer())]).toEqual([2, 3]);
    const mismatch = await fetch(base + '/api/comfy/jobs/' + pending.comfyJobId + '?requestId=' + crypto.randomUUID());
    expect(mismatch.status).toBe(400);
  });
  it('rejects generation for a different session profile and rejects an unbound request', async () => {
    const { post, profile } = await fixture();
    const response = await post('/api/comfy/jobs', {
      requestId: crypto.randomUUID(),
      profileId: profile.id,
      input: { prompt: 'test' },
    });
    expect(await response.json()).toEqual({ error: 'COMFY_CONVERSATION_UNAVAILABLE' });
  });
});

function createFetch(rows: Record<string, { data: unknown; status?: number }>) {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const result = rows[`${url.pathname}${url.search}`] ?? rows[url.pathname];
    if (!result) return new Response(JSON.stringify({ success: false, error: 'not found' }), { status: 404 });
    return new Response(JSON.stringify({ success: true, data: result.data }), { status: result.status ?? 200 });
  }) as typeof fetch;
  return fetchImpl;
}

const conversation = (extra: Record<string, string>, backend = 'codex') => ({
  id: 'conversation-1',
  type: 'acp',
  extra,
  assistant: { backend },
});
const modes = (current_value: string, options: string[]) => ({
  config_options: [
    {
      id: 'mode',
      category: 'mode',
      type: 'select',
      current_value,
      options: options.map((value) => ({ value })),
    },
  ],
});
const envelope = (data: unknown) => data;

describe('Comfy install approval mode', () => {
  it('reads the recovered Core port once per lookup and keeps each lookup on that Core instance', async () => {
    let port: number | undefined;
    const calls: string[] = [];
    const rows = createFetch({
      '/api/conversations/conversation-1': { data: { id: 'conversation-1', type: 'aionrs', extra: {} } },
      '/api/conversations/conversation-1/runtime/ensure': { data: modes('yolo', ['default', 'yolo']) },
    });
    const resolver = createComfyApprovalResolver({
      backendPort: () => port,
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        port = 13423;
        return rows(input, init);
      },
    });
    await expect(resolver('conversation-1')).rejects.toThrow('COMFY_APPROVAL_BACKEND_UNAVAILABLE');
    expect(calls).toEqual([]);
    port = 13422;
    await expect(resolver('conversation-1')).resolves.toEqual({ mode: 'automatic', runtimeMode: 'yolo' });
    expect(calls).toHaveLength(2);
    expect(calls.every((url) => new URL(url).port === '13422')).toBe(true);
    calls.length = 0;
    await resolver('conversation-1');
    expect(calls.every((url) => new URL(url).port === '13423')).toBe(true);
  });

  it.each([
    ['claude', 'bypassPermissions', 'bypassPermissions', 'automatic'],
    ['codex', 'agent-full-access', 'full-access', 'automatic'],
    ['codex', 'full-access', 'agent-full-access', 'automatic'],
    ['claude', 'default', 'bypassPermissions', 'manual'],
    ['codex', 'auto', 'agent-full-access', 'manual'],
    ['codex', undefined, 'agent-full-access', 'manual'],
  ])('compares %s runtime mode %s with its native full-auto mapping', async (backend, yolo, mode, expected) => {
    const fetchImpl = createFetch({
      '/api/conversations/conversation-1': { data: envelope(conversation({ agent_id: 'agent-1' }, backend)) },
      '/api/conversations/conversation-1/runtime/ensure': {
        data: envelope(modes(mode ?? 'agent-full-access', [mode ?? 'agent-full-access'])),
      },
      '/api/agents/management': { data: envelope([{ id: 'agent-1', backend, yolo_id: yolo }]) },
    });
    const resolver = createComfyApprovalResolver({ backendPort: 13400, fetchImpl });
    await expect(resolver('conversation-1')).resolves.toMatchObject({
      mode: expected,
      runtimeMode: mode ?? 'agent-full-access',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/api/conversations/conversation-1/runtime/ensure'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('identifies Aionrs auto-approval from its runtime mode without consulting ACP metadata', async () => {
    const fetchImpl = createFetch({
      '/api/conversations/conversation-1': {
        data: envelope({ ...conversation({ backend: 'aionrs' }, 'aionrs'), type: 'aionrs' }),
      },
      '/api/conversations/conversation-1/runtime/ensure': {
        data: envelope(modes('yolo', ['default', 'auto_edit', 'yolo'])),
      },
    });
    const resolver = createComfyApprovalResolver({ backendPort: 13400, fetchImpl });
    await expect(resolver('conversation-1')).resolves.toEqual({ mode: 'automatic', runtimeMode: 'yolo' });
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('/api/agents/management'), expect.anything());
  });

  it.each(['default', 'auto_edit'])(
    'does not treat Aionrs %s as full approval despite stale saved YOLO settings',
    async (mode) => {
      const fetchImpl = createFetch({
        '/api/conversations/conversation-1': {
          data: { id: 'conversation-1', type: 'aionrs', extra: { session_mode: 'yolo' } },
        },
        '/api/conversations/conversation-1/runtime/ensure': { data: modes(mode, ['default', 'auto_edit', 'yolo']) },
      });
      await expect(createComfyApprovalResolver({ backendPort: 13400, fetchImpl })('conversation-1')).resolves.toEqual({
        mode: 'manual',
        runtimeMode: mode,
      });
    }
  );

  it('honors the selected custom agent native full-auto mode even without a vendor backend label', async () => {
    const fetchImpl = createFetch({
      '/api/conversations/conversation-1': {
        data: { id: 'conversation-1', type: 'acp', extra: { agent_id: 'custom-1', agent_source: 'custom' } },
      },
      '/api/conversations/conversation-1/runtime/ensure': { data: modes('custom-auto', ['ask', 'custom-auto']) },
      '/api/agents/management': { data: [{ id: 'custom-1', backend: null, yolo_id: 'custom-auto' }] },
    });
    await expect(createComfyApprovalResolver({ backendPort: 13400, fetchImpl })('conversation-1')).resolves.toEqual({
      mode: 'automatic',
      runtimeMode: 'custom-auto',
    });
  });

  it('never approves when runtime, conversation or active agent metadata cannot be resolved unambiguously', async () => {
    const rows = {
      '/api/conversations/conversation-1': { data: envelope(conversation({ agent_id: 'agent-1' })) },
      '/api/conversations/conversation-1/runtime/ensure': {
        data: envelope(modes('bypassPermissions', ['default', 'bypassPermissions'])),
      },
      '/api/agents/management': {
        data: envelope([
          { id: 'agent-1', backend: 'claude', yolo_id: 'bypassPermissions' },
          { id: 'agent-2', backend: 'claude', yolo_id: 'bypassPermissions' },
        ]),
      },
    };
    const resolver = createComfyApprovalResolver({ backendPort: 13400, fetchImpl: createFetch(rows) });
    await expect(resolver('conversation-1')).resolves.toMatchObject({ mode: 'manual' });
    const unavailable = createComfyApprovalResolver({ backendPort: 0, fetchImpl: vi.fn() as typeof fetch });
    await expect(unavailable('conversation-1')).rejects.toThrow('COMFY_APPROVAL_BACKEND_UNAVAILABLE');
  });

  it('does not call conversation create or send-message APIs while reading observed approval mode', async () => {
    const fetchImpl = createFetch({
      '/api/conversations/conversation-1': { data: envelope(conversation({ agent_id: 'agent-1' })) },
      '/api/conversations/conversation-1/runtime/ensure': {
        data: envelope(modes('bypassPermissions', ['default', 'bypassPermissions'])),
      },
      '/api/agents/management': {
        data: envelope([{ id: 'agent-1', backend: 'claude', yolo_id: 'bypassPermissions' }]),
      },
    });
    await createComfyApprovalResolver({ backendPort: 13400, fetchImpl })('conversation-1');
    expect(fetchImpl).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/conversations$|\/messages/),
      expect.anything()
    );
  });
});

it('supports an Agent-installed profile from knowledge lookup through validation and application completion without the fixed installer', async () => {
  const { service, engine, base, post, profile } = await fixture();
  fs.writeFileSync(profile.components[0].path, 'weights');
  profile.components[0].sha256 = crypto.createHash('sha256').update('weights').digest('hex');
  profile.components[0].sizeBytes = 7;
  const requestId = '11111111-1111-4111-8111-111111111111';
  const managed = vi.spyOn(service, 'request');
  const unbound = await fetch(base + '/api/comfy/model-guide?family=moss-image-sft');
  expect(unbound.status).toBe(200);
  expect(await unbound.json()).toMatchObject({ family: 'moss-image-sft', execution: 'agent' });
  service.bind({ requestId, conversationId: 'chat', family: 'z-image', intent: 'install', source: 'local' });
  const selected = service.selection(requestId);
  const otherGuide = await fetch(`${base}/api/comfy/model-guide?family=qwen-edit&requestId=${requestId}`);
  expect(otherGuide.status).toBe(200);
  expect(await otherGuide.json()).toMatchObject({ family: 'qwen-edit', execution: 'agent' });
  expect(service.selection(requestId)).toEqual(selected);
  fs.writeFileSync(profile.workflowPath, JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '' } } }));
  const registered = await post('/api/comfy/profiles', { action: 'register', requestId, profile });
  expect(registered.status).toBe(200);
  expect(await registered.json()).toMatchObject({ state: 'downloaded' });
  const validation = await post('/api/comfy/profiles', {
    action: 'revalidate',
    requestId,
    profileId: profile.id,
    smokeInput: { prompt: 'red cup' },
  });
  const result = await validation.json();
  expect(validation.status).toBe(202);
  expect(result.validation).toBe(true);
  await service.idle();
  const complete = await post('/api/comfy/agent-installation-complete', { requestId, jobId: result.comfyJobId });
  expect(complete.status).toBe(200);
  expect(await complete.json()).toMatchObject({ execution: 'agent', state: 'completed', profileId: profile.id });
  expect(engine.generate).toHaveBeenCalledOnce();
  expect(managed).not.toHaveBeenCalled();
});

it('completes a model-card repair variant through register, validation and the existing completion API', async () => {
  const { service, engine, base, post, profile } = await fixture();
  fs.writeFileSync(profile.components[0].path, 'weights');
  profile.components[0].sha256 = crypto.createHash('sha256').update('weights').digest('hex');
  profile.components[0].sizeBytes = 7;
  const original = service.register(profile);
  const requestId = crypto.randomUUID();
  const bound = await post('/api/comfy/bind', {
    requestId,
    conversationId: 'chat',
    profileId: profile.id,
    intent: 'repair',
  });
  expect(bound.status).toBe(200);
  const variant = {
    ...profile,
    id: 'model-card-repair-variant',
    workflowPath: path.join(profile.environment.root, 'repaired.json'),
    nodes: [{ id: 'ComfyUI', version: 'actual-repaired-revision' }],
  };
  fs.writeFileSync(variant.workflowPath, JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '' } } }));
  const registered = await post('/api/comfy/profiles', { action: 'register', requestId, profile: variant });
  expect(registered.status).toBe(200);
  expect(await registered.json()).toMatchObject({ id: variant.id, state: 'downloaded' });
  const validation = await post('/api/comfy/profiles', {
    action: 'revalidate',
    requestId,
    profileId: variant.id,
    smokeInput: { prompt: 'red cup' },
  });
  expect(validation.status).toBe(202);
  const { comfyJobId } = await validation.json();
  await service.idle();
  expect(service.installationValidationUpdates()).toContainEqual(
    expect.objectContaining({ id: comfyJobId, requestId, profileId: variant.id, state: 'completed' })
  );
  const complete = await post('/api/comfy/agent-installation-complete', { requestId, jobId: comfyJobId });
  expect(complete.status).toBe(200);
  expect(await complete.json()).toMatchObject({
    state: 'completed',
    execution: 'agent',
    profileId: variant.id,
    validationJobId: comfyJobId,
    plan: { repair: true, commands: [] },
  });
  const activity = await fetch(`${base}/api/comfy/activity?requestId=${requestId}`);
  expect(await activity.json()).toMatchObject({ selection: { profileId: variant.id, intent: 'repair' } });
  expect(service.profiles().find((item) => item.id === original.id)).toEqual(original);
  expect(engine.generate).toHaveBeenCalledOnce();
});

it('registers, validates and completes a newly requested model through general tools in the original chat', async () => {
  const { service, engine, base, post, profile } = await fixture();
  const requestId = crypto.randomUUID();
  service.bind({ requestId, conversationId: 'chat', family: 'moss-image-sft', source: 'local', intent: 'generate' });
  const selected = service.selection(requestId);
  const managed = vi.spyOn(service, 'request');
  fs.writeFileSync(profile.components[0].path, 'weights');
  profile.components[0].sha256 = crypto.createHash('sha256').update('weights').digest('hex');
  profile.components[0].sizeBytes = 7;
  fs.writeFileSync(profile.workflowPath, JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '' } } }));
  const registered = await post('/api/comfy/profiles', {
    action: 'register',
    requestId,
    profile,
    installationIntent: 'install-other',
  });
  expect(registered.status).toBe(200);
  const verified = await post('/api/comfy/profiles', {
    action: 'revalidate',
    requestId,
    profileId: profile.id,
    smokeInput: { prompt: 'red cup' },
    installationIntent: 'install-other',
  });
  expect(verified.status).toBe(202);
  const { comfyJobId } = await verified.json();
  await service.idle();
  expect(service.installationValidationUpdates()).toContainEqual(
    expect.objectContaining({ id: comfyJobId, requestId, purpose: 'installation' })
  );
  expect((await fetch(`${base}/api/comfy/jobs/${comfyJobId}?requestId=${requestId}`)).status).toBe(200);
  const completed = await post('/api/comfy/agent-installation-complete', { requestId, jobId: comfyJobId });
  expect(completed.status).toBe(200);
  expect(await completed.json()).toMatchObject({ state: 'completed', execution: 'agent', profileId: profile.id });
  expect(service.selection(requestId)).toEqual(selected);
  expect(engine.generate).toHaveBeenCalledOnce();
  expect(managed).not.toHaveBeenCalled();
});
