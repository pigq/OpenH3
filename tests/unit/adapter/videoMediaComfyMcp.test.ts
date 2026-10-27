import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

type Reply = { isError?: boolean; content: Array<{ type: string; text: string }> };
type RegisteredTool = {
  schema: z.ZodRawShape;
  callback: (input: Record<string, unknown>) => Promise<Reply>;
};
const { registered, fetchMock } = vi.hoisted(() => ({
  registered: new Map<string, RegisteredTool>(),
  fetchMock: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(name: string, _description: string, schema: z.ZodRawShape, callback: RegisteredTool['callback']) {
      registered.set(name, { schema, callback });
    }
    connect() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    close() {
      return Promise.resolve();
    }
  },
}));

const requestId = 'session-request-1';
const candidate = {
  id: 'qwen-balanced',
  family: 'qwen-edit',
  name: 'Qwen balanced',
  kind: 'image',
  version: 'abc123',
  quantization: 'BF16',
  capabilities: ['image-edit'],
  state: 'verified',
  environment: { root: 'D:/ComfyUI', python: 'D:/ComfyUI/venv/python.exe', baseUrl: 'http://127.0.0.1:8188' },
  components: [
    {
      role: 'diffusion',
      name: 'qwen.safetensors',
      path: 'D:/ComfyUI/models/qwen.safetensors',
      version: 'def456',
      precision: 'BF16',
    },
  ],
  nodes: [{ id: 'ComfyUI', version: 'abc123' }],
  workflowPath: 'D:/ComfyUI/workflows/qwen.api.json',
  bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
  defaults: {},
  validation: { fingerprint: 'untrusted', checkedAt: '2026-10-14' },
};
const { state: _state, validation: _validation, ...installCandidate } = candidate;
const plan = {
  ...installCandidate,
  targetRoot: 'D:/ComfyUI',
  downloadBytes: 123,
  requiredBytes: 246,
  reason: 'Matched components and runtime',
  evidence: ['CUDA smoke passed'],
  workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } } },
  commands: [],
  smokeInput: { prompt: 'Change the ball to red', imagePaths: ['D:/source.png'] },
  repair: false,
};

function respond(value: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  );
}
async function invoke(name: string, input: Record<string, unknown>): Promise<Reply> {
  const tool = registered.get(name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.callback(z.object(tool.schema).parse(input));
}
function requestBody(index = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[index][1].body) as Record<string, unknown>;
}

beforeEach(async () => {
  vi.resetModules();
  registered.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('AIONUI_CREATION_REQUEST_ID', requestId);
  vi.stubEnv('AIONUI_MEDIA_PORT', '33009');
  await import('@/process/resources/builtinMcp/videoMediaServer');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('generic ComfyUI MCP tools', () => {
  it('registers OpenH3 tool names and keeps legacy pending calls on the same handlers', () => {
    for (const [name, legacy] of registered) {
      if (!name.startsWith('aionui_')) continue;
      const canonical = registered.get(name.replace(/^aionui_/, 'openh3_'));
      expect(canonical, name).toBeDefined();
      expect(canonical!.schema).toBe(legacy.schema);
      expect(canonical!.callback).toBe(legacy.callback);
    }
  });
  it('exposes inspection, profile, installation and job tools without an authorization action', () => {
    expect([...registered.keys()]).toEqual(
      expect.arrayContaining([
        'aionui_comfy_environment',
        'aionui_comfy_profiles',
        'aionui_comfy_install',
        'aionui_comfy_generate',
        'aionui_comfy_job_status',
        'aionui_comfy_cancel_job',
        'aionui_h3_job_status',
      ])
    );
    const schema = registered.get('aionui_comfy_install')!.schema;
    expect(z.object(schema).safeParse({ action: 'authorize', operationId: 'operation-1' }).success).toBe(false);
  });

  it('keeps the explicit legacy plan action compatible with the installation endpoint', async () => {
    respond({ id: 'operation-legacy', state: 'awaiting-consent', plan });
    const reply = await invoke('openh3_comfy_install', { action: 'plan', plan });
    expect(reply.isError).not.toBe(true);
    expect(requestBody()).toMatchObject({ requestId, plan });
    expect(JSON.parse(reply.content[0].text).comfyOperationId).toBe('operation-legacy');
  });

  it('encodes the actual probe runtime and sends the bound request ID on read-only tools', async () => {
    respond({ accelerator: 'cuda', probeComplete: true });
    const reply = await invoke('aionui_comfy_environment', {
      root: 'D:/Comfy UI',
      python: 'D:/venv/python.exe',
      baseUrl: 'http://127.0.0.1:8189',
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/comfy/environment');
    expect(url.searchParams.get('root')).toBe('D:/Comfy UI');
    expect(url.searchParams.get('python')).toBe('D:/venv/python.exe');
    expect(url.searchParams.get('baseUrl')).toBe('http://127.0.0.1:8189');
    expect(url.searchParams.get('requestId')).toBe(requestId);
    expect(reply.isError).not.toBe(true);
    respond({ profiles: [candidate], selection: { profileId: candidate.id, intent: 'generate' } });
    const profiles = await invoke('aionui_comfy_profiles', { action: 'list' });
    expect(JSON.parse(profiles.content[0].text)).toMatchObject({
      profiles: [{ id: candidate.id }],
      selection: { profileId: candidate.id },
    });
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('requestId')).toBe(requestId);
  });

  it('lists registered profiles without requiring a creation request context', async () => {
    vi.stubEnv('AIONUI_CREATION_REQUEST_ID', '');
    respond({ profiles: [candidate] });

    const reply = await invoke('aionui_comfy_profiles', { action: 'list' });

    expect(reply.isError).not.toBe(true);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/comfy/profiles');
    expect(url.searchParams.has('requestId')).toBe(false);
    expect(JSON.parse(reply.content[0].text)).toMatchObject({ profiles: [{ id: candidate.id }] });
  });

  it('registers without trusting client verification and returns the background smoke validation job', async () => {
    respond({ ...candidate, state: 'downloaded', validation: undefined });
    await invoke('aionui_comfy_profiles', { action: 'register', profile: candidate });
    const body = requestBody();
    expect(body).toMatchObject({ action: 'register', requestId, profile: { state: 'downloaded' } });
    expect((body.profile as Record<string, unknown>).validation).toBeUndefined();
    const validationJob = {
      comfyJobId: 'validation-job-1',
      job: { id: 'validation-job-1', status: 'queued', artifacts: [] },
      validation: true,
    };
    respond(validationJob, 202);
    const reply = await invoke('aionui_comfy_profiles', {
      action: 'revalidate',
      profileId: candidate.id,
      smokeInput: plan.smokeInput,
    });
    expect(requestBody(1)).toEqual({
      action: 'revalidate',
      profileId: candidate.id,
      smokeInput: plan.smokeInput,
      requestId,
    });
    expect(JSON.parse(reply.content[0].text)).toEqual(validationJob);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves the service diagnostic for revalidation without a representative smoke input', async () => {
    respond({ error: 'COMFY_SMOKE_INPUT_REQUIRED' }, 400);
    const reply = await invoke('aionui_comfy_profiles', { action: 'revalidate', profileId: candidate.id });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('COMFY_SMOKE_INPUT_REQUIRED');
    expect(requestBody()).toEqual({ action: 'revalidate', profileId: candidate.id, requestId });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('requests a complete plan independently of generation and returns a renderer operation reference', async () => {
    const operation = { id: 'operation-1', state: 'awaiting-consent', plan };
    respond(operation);
    const reply = await invoke('aionui_comfy_install', { action: 'request', plan });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:33009/api/comfy/operations');
    expect(requestBody()).toEqual({ plan, requestId });
    expect(JSON.parse(reply.content[0].text)).toEqual({ comfyOperationId: operation.id, operation });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('submits a short identity-only install request for model cards', async () => {
    const operation = { id: 'operation-qwen', state: 'running', plan };
    respond(operation, 202);
    const reply = await invoke('aionui_comfy_install', {
      action: 'request',
      family: 'qwen-edit',
      intent: 'install',
      profileId: 'qwen-balanced',
    });
    expect(requestBody()).toEqual({
      install: {
        action: 'request',
        family: 'qwen-edit',
        intent: 'install',
        profileId: 'qwen-balanced',
      },
      requestId,
    });
    expect(JSON.parse(reply.content[0].text)).toMatchObject({ comfyOperationId: operation.id });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('passes UI consent rejection through without retrying, authorizing, downloading or generating', async () => {
    respond({ error: 'COMFY_UI_CONSENT_REQUIRED' }, 409);
    const reply = await invoke('aionui_comfy_install', { action: 'start', operationId: 'operation-1' });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('COMFY_UI_CONSENT_REQUIRED');
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:33009/api/comfy/operations/operation-1/start');
    expect(requestBody()).toEqual({ requestId });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('queries and cancels only the specified operation with its request context', async () => {
    respond({ id: 'operation/1', state: 'running' });
    await invoke('aionui_comfy_install', { action: 'status', operationId: 'operation/1' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/comfy/operations/operation%2F1');
    expect(url.searchParams.get('requestId')).toBe(requestId);
    respond({ id: 'operation/1', state: 'cancelled' });
    await invoke('aionui_comfy_install', { action: 'cancel', operationId: 'operation/1' });
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:33009/api/comfy/operations/operation%2F1/cancel');
    expect(requestBody(1)).toEqual({ requestId });
  });

  it('submits the selected profile hot path without a new inventory, probe or install plan', async () => {
    const input = { prompt: 'A red ball', width: 512, height: 512 };
    const job = { id: 'job-1', profileId: candidate.id, status: 'queued', kind: 'image', artifacts: [] };
    respond(job);
    const reply = await invoke('aionui_comfy_generate', { profileId: candidate.id, input });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:33009/api/comfy/jobs');
    expect(requestBody()).toEqual({ profileId: candidate.id, input, requestId });
    expect(JSON.parse(reply.content[0].text)).toEqual({ comfyJobId: job.id, job });
  });

  it('preserves mixed Omni references in attachment order and rejects legacy/new reference conflicts', async () => {
    const input = {
      prompt: 'Animate <Picture 1> with <Video 1> and <Audio 1>',
      references: [
        { type: 'video', path: 'D:/clips/motion.mp4' },
        { type: 'image', path: 'D:/clips/subject.png' },
        { type: 'audio', path: 'D:/clips/voice.wav' },
      ],
    };
    respond({ id: 'omni-job', status: 'queued', kind: 'video', artifacts: [] });
    await invoke('aionui_comfy_generate', { profileId: 'fasth3-omni', input });
    expect(requestBody()).toEqual({ profileId: 'fasth3-omni', input, requestId });
    const schema = z.object(registered.get('aionui_comfy_generate')!.schema);
    expect(schema.safeParse({ profileId: 'fasth3-omni', input: { ...input, imagePaths: [] } }).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('surfaces stale-selection and unverified-profile rejection without choosing another model', async () => {
    respond({ error: 'COMFY_SELECTION_CHANGED' }, 409);
    const reply = await invoke('aionui_comfy_generate', { profileId: 'stale-profile', input: { prompt: 'A ball' } });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('COMFY_SELECTION_CHANGED');
    expect(fetchMock).toHaveBeenCalledOnce();
    respond({ error: 'COMFY_PROFILE_NOT_VERIFIED' }, 409);
    const unverified = await invoke('aionui_comfy_generate', { profileId: candidate.id, input: { prompt: 'A ball' } });
    expect(unverified.isError).toBe(true);
    expect(unverified.content[0].text).toContain('COMFY_PROFILE_NOT_VERIFIED');
  });

  it('returns renderer job references for snapshots and cancellation', async () => {
    const job = { id: 'job/1', status: 'running', artifacts: [] };
    respond(job);
    const snapshot = await invoke('aionui_comfy_job_status', { jobId: job.id });
    expect(JSON.parse(snapshot.content[0].text)).toEqual({ comfyJobId: job.id, job });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/comfy/jobs/job%2F1');
    expect(url.searchParams.get('requestId')).toBe(requestId);
    respond({ ...job, status: 'cancelled' });
    await invoke('aionui_comfy_cancel_job', { jobId: job.id });
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:33009/api/comfy/jobs/job%2F1/cancel');
    expect(requestBody(1)).toEqual({ requestId });
  });

  it('requires an existing request context and never invents one', async () => {
    vi.stubEnv('AIONUI_CREATION_REQUEST_ID', '');
    const reply = await invoke('aionui_comfy_generate', { profileId: candidate.id, input: { prompt: 'A ball' } });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('CREATION_REQUEST_CONTEXT_MISSING');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prevents legacy fixed-H3 generation and installation from bypassing a registered session selection', async () => {
    vi.stubEnv('AIONUI_CREATION_SOURCE', 'local');
    vi.stubEnv('AIONUI_CREATION_KIND', 'video');
    respond({
      profiles: [candidate],
      selection: { profileId: candidate.id, family: candidate.family, intent: 'generate' },
    });
    const generated = await invoke('aionui_h3_generate_video', { prompt: 'A ball' });
    expect(generated.isError).toBe(true);
    expect(generated.content[0].text).toContain('openh3_comfy_generate');
    expect(fetchMock).toHaveBeenCalledOnce();
    respond({ profiles: [candidate], selection: { family: 'h3', intent: 'install' } });
    const installed = await invoke('aionui_h3_install_video_model', { action: 'request' });
    expect(installed.isError).toBe(true);
    expect(installed.content[0].text).toContain('openh3_comfy_install');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).pathname === '/api/comfy/profiles')).toBe(true);
  });
});
