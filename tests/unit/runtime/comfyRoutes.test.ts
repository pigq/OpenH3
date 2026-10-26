import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComfyApprovalResolver } from '@/process/services/media/creation/installApproval';
import { ComfyService } from '@/process/services/media/comfy/ComfyService';
import { handleComfyRoute } from '@/process/services/media/comfy/routes';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const task of cleanup.reverse()) await task();
  cleanup.length = 0;
});
async function fixture() {
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
  return { service, engine, base, post, profile };
}
describe('ComfyUI media-service routes', () => {
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
