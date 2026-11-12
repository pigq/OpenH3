import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

type Reply = { isError?: boolean; content: Array<{ type: string; text: string }> };
type RegisteredTool = {
  description: string;
  schema: z.ZodRawShape;
  callback: (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<Reply>;
};
const { registered, fetchMock, serverOptions } = vi.hoisted(() => ({
  registered: new Map<string, RegisteredTool>(),
  fetchMock: vi.fn(),
  serverOptions: { instructions: '' },
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    constructor(_identity: unknown, options: { instructions: string }) {
      serverOptions.instructions = options.instructions;
    }
    tool(name: string, description: string, schema: z.ZodRawShape, callback: RegisteredTool['callback']) {
      registered.set(name, { description, schema, callback });
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
async function invoke(
  name: string,
  input: Record<string, unknown>,
  signal = new AbortController().signal
): Promise<Reply> {
  const tool = registered.get(name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.callback(z.object(tool.schema).parse(input), { signal });
}
function requestBody(index = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[index][1].body) as Record<string, unknown>;
}

beforeEach(async () => {
  vi.resetModules();
  registered.clear();
  fetchMock.mockReset();
  serverOptions.instructions = '';
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('AIONUI_CREATION_REQUEST_ID', requestId);
  vi.stubEnv('AIONUI_MEDIA_PORT', '33009');
  await import('@/process/resources/builtinMcp/videoMediaServer');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('generic ComfyUI MCP tools', () => {
  it('forwards ordinary conversation context and the chosen profile through resolve and generation', async () => {
    vi.stubEnv('AIONUI_CREATION_REQUEST_ID', '');
    vi.stubEnv('OPENH3_CONVERSATION_ID', 'story-chat');
    const input = { prompt: 'Morning shot', requirements: { task: 'text-to-video' } };
    respond({ selectedProfileId: 'h3' });
    const resolved = await invoke('openh3_comfy_resolve_workflow', { profileId: 'h3', input });
    expect(resolved.isError).not.toBe(true);
    expect(requestBody()).toEqual({ conversationId: 'story-chat', profileId: 'h3', input });
    respond({ id: 'shot-1', status: 'queued' });
    const generated = await invoke('openh3_comfy_generate', { profileId: 'h3', input });
    expect(generated.isError).not.toBe(true);
    expect(requestBody(1)).toEqual({ conversationId: 'story-chat', profileId: 'h3', input });
  });
  it('turns a missing Omni reference into actionable preparation instead of a user-upload demand', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'COMFY_OMNI_REFERENCE_REQUIRED' }), { status: 400 })
    );
    respond({
      action: 'prepare-reference',
      nextAction: { type: 'prepare-reference-and-continue', requiresUserUpload: false },
    });
    const input = { prompt: 'A new city skyline at dusk', durationSeconds: 6 };
    const reply = await invoke('openh3_comfy_generate', { profileId: 'omni', input });
    expect(reply.isError).not.toBe(true);
    expect(JSON.parse(reply.content[0].text).action).toBe('prepare-reference');
    expect(requestBody(1)).toEqual({ requestId, profileId: 'omni', input });
  });
  describe('Agent follow-through decisions', () => {
    const jobId = '12345678-1234-4234-8234-123456789abc';
    it.each(['z-image', 'moss-image-sft', 'h3', 'fasth3-omni'])(
      'returns an actionable workflow repair for %s without replaying generation',
      async (family) => {
        const input = {
          prompt: 'Use both uploaded references',
          references: [
            { type: 'image', path: 'D:/first.png' },
            { type: 'image', path: 'D:/second.png' },
          ],
        };
        const job = {
          id: jobId,
          status: 'failed',
          error: 'COMFY_IMAGE_BINDINGS_MISSING',
          artifacts: [],
          profile: { ...candidate, family },
          originalInput: input,
        };
        respond(job);
        const reply = await invoke('openh3_comfy_job_status', { jobId });
        const result = JSON.parse(reply.content[0].text);
        expect(result.job).toEqual(job);
        expect(result).toMatchObject({
          automaticRetryAllowed: false,
          stopPolling: true,
          nextAction: { type: 'repair-workflow-and-continue', reason: 'reference-bindings', sameGoal: true },
        });
        expect(result.nextAction.instruction).toMatch(/register.*revalidate.*adopt/is);
        expect(result.nextAction.instruction).toMatch(/original.*input|original.*reference/i);
        expect(result.nextAction.instruction).toMatch(/model.card/i);
        expect(fetchMock).toHaveBeenCalledOnce();
      }
    );

    it.each([
      ['failed', true, 'recover-existing-job'],
      ['cancelled', false, 'respect-cancellation'],
    ])('does not let workflow diagnostics override %s with uncertain=%s', async (status, submissionUncertain, type) => {
      respond({ id: jobId, status, submissionUncertain, error: 'COMFY_IMAGE_BINDINGS_MISSING', artifacts: [] });
      const reply = await invoke('openh3_comfy_job_status', { jobId });
      expect(JSON.parse(reply.content[0].text).nextAction.type).toBe(type);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('distinguishes an input adapter gap from permission to drop non-image inputs', async () => {
      respond({ id: jobId, status: 'failed', error: 'COMFY_MULTIMODAL_WORKFLOW_REQUIRED', artifacts: [] });
      const reply = await invoke('openh3_comfy_job_status', { jobId });
      const action = JSON.parse(reply.content[0].text).nextAction;
      expect(action).toMatchObject({ type: 'repair-workflow-and-continue', reason: 'input-adapter' });
      expect(action.instruction).toMatch(/openh3_comfy_observe_prompt/);
      expect(action.instruction).toMatch(/never.*discard|do not.*drop/i);
    });
    it.each([
      ['queued', false, false, 'monitor-same-job'],
      ['running', false, false, 'monitor-same-job'],
      ['failed', false, true, 'diagnose-and-continue'],
      ['failed', true, true, 'recover-existing-job'],
      ['succeeded', false, true, 'inspect-result-and-continue'],
      ['cancelled', false, true, 'respect-cancellation'],
    ] as const)(
      'keeps the real goal explicit for a %s snapshot uncertain=%s',
      async (status, submissionUncertain, stopPolling, action) => {
        const job = { id: jobId, status, submissionUncertain, artifacts: [] };
        respond(job);
        const reply = await invoke('openh3_comfy_job_status', { jobId });
        expect(JSON.parse(reply.content[0].text)).toMatchObject({
          comfyJobId: jobId,
          job,
          terminal: !['queued', 'running'].includes(status),
          stopPolling,
          automaticRetryAllowed: false,
          nextAction: { type: action, jobId },
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
      }
    );

    it.each(['openh3', 'aionui'])(
      'returns diagnostic repair guidance for the exact %s acceleration failure without retrying generation',
      async (prefix) => {
        const job = {
          id: jobId,
          status: 'failed',
          error: 'H3_ACCELERATION_DEPENDENCIES_MISSING:ACCELERATION_INSTALL_FAILED',
          diagnosticLogPath: 'D:/selected-runtime/job-failure.jsonl',
          artifacts: [],
        };
        respond(job);
        const reply = await invoke(`${prefix}_comfy_job_status`, { jobId });
        const result = JSON.parse(reply.content[0].text);
        expect(result.job).toEqual(job);
        expect(result.nextAction).toMatchObject({ type: 'diagnose-and-continue', sameGoal: true });
        expect(result.nextAction.instruction).toMatch(/actual.*runtime.*interpreter/i);
        expect(result.nextAction.instruction).toMatch(/diagnosticLogPath|diagnostic log/i);
        expect(result.nextAction.instruction).toMatch(/acceleration.*failure|failure.*acceleration/i);
        expect(result.nextAction.instruction).toMatch(/no unchanged|do not.*unchanged|never.*unchanged/i);
        expect(result.nextAction.instruction).toMatch(/continue.*repair/i);
        expect(fetchMock).toHaveBeenCalledOnce();
      }
    );

    it.each(['generate', 'revalidate', 'observe'])(
      'adds the same active monitoring decision to %s while preserving every existing result field',
      async (entry) => {
        const job = { id: jobId, status: 'running', artifacts: [] };
        respond(entry === 'generate' ? job : { comfyJobId: jobId, job, validation: true, retained: 'evidence' });
        const reply =
          entry === 'generate'
            ? await invoke('aionui_comfy_generate', { profileId: candidate.id, input: { prompt: 'A ball' } })
            : entry === 'revalidate'
              ? await invoke('aionui_comfy_profiles', {
                  action: 'revalidate',
                  profileId: candidate.id,
                  smokeInput: { prompt: 'A ball' },
                })
              : await invoke('aionui_comfy_observe_prompt', {
                  promptId: jobId,
                  baseUrl: 'http://127.0.0.1:8188',
                  kind: 'video',
                });
        const result = JSON.parse(reply.content[0].text);
        expect(result).toMatchObject({
          comfyJobId: jobId,
          job,
          terminal: false,
          stopPolling: false,
          automaticRetryAllowed: false,
          nextAction: { type: 'monitor-same-job', jobId, tool: 'openh3_comfy_job_status', waitMs: 30000 },
        });
        if (entry !== 'generate') expect(result).toMatchObject({ validation: true, retained: 'evidence' });
        expect(fetchMock).toHaveBeenCalledOnce();
      }
    );

    it.each(['openh3', 'aionui'])(
      'retains runtime readiness, install paths and acceleration error context in read-only %s inspection',
      async (prefix) => {
        const acceleration = {
          backend: 'dense',
          available: false,
          root: 'D:/bundle/acceleration',
          reason: 'ACCELERATION_INSTALL_FAILED',
          tritonPresent: true,
        };
        const install = { bundleRoot: 'D:/bundle', runtimeRoot: 'D:/runtime', runtimePresent: true };
        respond({ ready: false, error: 'H3_RUNTIME_NOT_RUNNING', readiness: 'ready', install, acceleration }, 503);
        const reply = await invoke(`${prefix}_h3_acceleration_status`, {});
        expect(reply.isError).not.toBe(true);
        expect(JSON.parse(reply.content[0].text)).toMatchObject({
          ...acceleration,
          runtimeReady: false,
          runtimeError: 'H3_RUNTIME_NOT_RUNNING',
          readiness: 'ready',
          install,
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
        const description = registered.get(`${prefix}_h3_acceleration_status`)!.description;
        expect(description).not.toMatch(/safely falls back/i);
        expect(description).toMatch(/read.only/i);
        expect(description).toMatch(/selected.*workflow|workflow.*selected/i);
      }
    );

    it.each(['openh3', 'aionui'])('does not tell the Agent to yield managed %s work', (prefix) => {
      expect(registered.get(`${prefix}_comfy_install`)!.description).not.toMatch(/yield while/i);
      expect(registered.get(`${prefix}_comfy_install`)!.description).toMatch(/status.*spaced checks/i);
      expect(registered.get(`${prefix}_h3_install_video_model`)!.description).not.toMatch(/end your turn after/i);
    });

    it.each([
      ['installing', false, 'monitor-same-operation'],
      ['awaiting-consent', true, 'await-user-consent'],
      ['failed', true, 'diagnose-and-continue'],
      ['cancelled', true, 'respect-cancellation'],
      ['submitted', true, 'monitor-same-job'],
    ] as const)(
      'inspects the same trusted legacy operation at %s without starting another operation',
      async (state, stopPolling, nextAction) => {
        const operationId = '87654321-1234-4234-8234-123456789abc';
        const operation = { id: operationId, requestId, state, ...(state === 'submitted' ? { jobId } : {}) };
        respond(operation);
        const reply = await invoke('openh3_h3_install_video_model', { action: 'status', operationId });
        expect(reply.isError).not.toBe(true);
        expect(JSON.parse(reply.content[0].text)).toMatchObject({
          creationOperationId: operationId,
          state,
          stopPolling,
          nextAction: { type: nextAction },
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0];
        expect(init.method).toBeUndefined();
        expect(new URL(url).pathname).toBe(`/api/creation/operations/${operationId}`);
        expect(new URL(url).searchParams.get('requestId')).toBe(requestId);
      }
    );

    it('rejects a different legacy request without exposing its operation or mutating state', async () => {
      const operationId = '87654321-1234-4234-8234-123456789abc';
      respond({ id: operationId, requestId: 'other-request', state: 'installing', error: 'Private diagnostic' });
      const reply = await invoke('openh3_h3_install_video_model', {
        action: 'status',
        operationId,
        requestId: 'other-request',
      });
      expect(reply.isError).toBe(true);
      expect(reply.content[0].text).toContain('CREATION_REQUEST_MISMATCH');
      expect(reply.content[0].text).not.toContain('Private diagnostic');
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
  it.each(['openh3', 'aionui'])(
    'documents application-managed launch flags in %s profile and install schemas',
    (prefix) => {
      const profileSchema = registered.get(`${prefix}_comfy_profiles`)!.schema.profile as z.ZodOptional<z.AnyZodObject>;
      const planSchema = registered.get(`${prefix}_comfy_install`)!.schema.plan as z.ZodOptional<z.AnyZodObject>;
      for (const schema of [profileSchema, planSchema]) {
        const description = schema.unwrap().shape.environment.shape.launchArgs.description;
        expect(description).toContain('environment.baseUrl');
        for (const flag of ['--listen', '--port', '--base-directory', '--input-directory', '--output-directory'])
          expect(description).toContain(flag);
        expect(description).toMatch(/application.*manages/i);
        expect(description).toMatch(/do not include/i);
      }
    }
  );

  it.each(['openh3', 'aionui'])('explains completion of a %s model-card repair variant', (prefix) => {
    const completion = registered.get(`${prefix}_comfy_installation_complete`)!.description;
    expect(completion).toMatch(/model-card repair.*new profile ID/i);
    expect(completion).toMatch(/original model components and precision/i);
    expect(completion).toMatch(/unchanged.*selection/i);
    expect(completion).toMatch(/successful validation job/i);
  });

  it('requires terminal result inspection before delivering generated work', () => {
    expect(serverOptions.instructions).not.toContain('Yield while background work runs');
    expect(serverOptions.instructions).not.toMatch(/end the turn after the UI handoff|yield after.*handoff/i);
    expect(serverOptions.instructions).toMatch(/even.*single output/i);
    expect(serverOptions.instructions).toMatch(/same job.*terminal result.*inspect outputs/i);
    expect(serverOptions.instructions).toMatch(/waitMs.*30000/i);
  });

  it.each(['openh3', 'aionui'])(
    'exposes %s instructions to monitor generation, validation and observation through completion',
    (prefix) => {
      const generation = registered.get(`${prefix}_comfy_generate`)!.description;
      const status = registered.get(`${prefix}_comfy_job_status`)!.description;
      const observation = registered.get(`${prefix}_comfy_observe_prompt`)!.description;
      const profiles = registered.get(`${prefix}_comfy_profiles`)!.description;

      expect(status).toMatch(/waitMs.*30000/i);
      expect(profiles).toMatch(/revalidation.*openh3_comfy_job_status.*terminal result/i);
      expect(observation).toContain('openh3_comfy_job_status');
      expect(observation).toMatch(/handoff fails.*same prompt.*\/history\/\{promptId\}.*\/view/i);
      for (const description of [generation, status, observation]) {
        expect(description).toMatch(/same job/i);
        expect(description).toMatch(/terminal result/i);
        expect(description).toMatch(/inspect outputs.*continue/i);
        expect(description).toMatch(/never resubmit to monitor/i);
        expect(description).not.toMatch(
          /end the turn after the UI handoff|leave monitoring to the UI|no remaining authorized work/i
        );
      }
    }
  );

  it.each(['openh3', 'aionui'])(
    'requires %s historical H3 and cloud jobs to reach a terminal result before delivery',
    (prefix) => {
      for (const suffix of ['h3_generate_video', 'h3_job_status', 'cloud_video_generate', 'cloud_video_status']) {
        const description = registered.get(`${prefix}_${suffix}`)!.description;
        expect(description).toMatch(/same job/i);
        expect(description).toMatch(/terminal result/i);
        expect(description).toMatch(/inspect outputs.*continue/i);
        expect(description).toMatch(/never resubmit to monitor/i);
        expect(description).not.toMatch(
          /end (?:your|the) turn after|leave monitoring to the UI|no remaining authorized work/i
        );
      }
    }
  );

  describe('bounded status waits', () => {
    const jobId = '12345678-1234-4234-8234-123456789abc';
    const statuses = ['comfy_job_status', 'cloud_video_status', 'h3_job_status'];

    it.each(statuses)('limits %s waitMs to an optional integer from zero to 30000', (suffix) => {
      for (const prefix of ['openh3', 'aionui']) {
        const schema = z.object(registered.get(`${prefix}_${suffix}`)!.schema);
        expect(schema.parse({ jobId, waitMs: 30000 })).toMatchObject({ waitMs: 30000 });
        expect(schema.parse({ jobId, waitMs: 0 })).toMatchObject({ waitMs: 0 });
        for (const waitMs of [-1, 0.5, 30001]) expect(schema.safeParse({ jobId, waitMs }).success).toBe(false);
      }
    });

    it.each([
      ['comfy_job_status', false],
      ['comfy_job_status', true],
      ['cloud_video_status', false],
      ['h3_job_status', false],
    ] as const)(
      'waits for %s observation=%s to finish using only the same scoped GET',
      async (suffix, observationOnly) => {
        vi.useFakeTimers();
        const snapshot = (status: string) => ({ id: jobId, status, observationOnly, artifacts: [] });
        respond(snapshot('queued'));
        respond(snapshot('running'));
        respond(snapshot('succeeded'));
        const result = invoke(`openh3_${suffix}`, { jobId, waitMs: 30000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(2000);
        const reply = JSON.parse((await result).content[0].text);
        expect(reply.job ?? reply).toMatchObject(snapshot('succeeded'));
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(new Set(fetchMock.mock.calls.map(([url]) => url)).size).toBe(1);
        for (const [url, init] of fetchMock.mock.calls) {
          expect(init.method).toBeUndefined();
          expect(new URL(url).pathname).toContain(jobId);
          if (suffix !== 'h3_job_status') expect(new URL(url).searchParams.get('requestId')).toBe(requestId);
        }
        await vi.advanceTimersByTimeAsync(30000);
        expect(fetchMock).toHaveBeenCalledTimes(3);
      }
    );

    it.each(statuses)('returns the latest %s snapshot when its wait budget expires', async (suffix) => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(
        async () =>
          new Response(JSON.stringify({ id: jobId, status: 'running', progress: fetchMock.mock.calls.length }))
      );
      const result = invoke(`openh3_${suffix}`, { jobId, waitMs: 30000 });
      await vi.advanceTimersByTimeAsync(30000);
      const reply = JSON.parse((await result).content[0].text);
      expect(reply.job ?? reply).toMatchObject({ status: 'running', progress: 8 });
      expect(fetchMock).toHaveBeenCalledTimes(8);
      await vi.advanceTimersByTimeAsync(30000);
      expect(fetchMock).toHaveBeenCalledTimes(8);
    });

    it.each(statuses)('cancels a pending %s wait without cancelling or resubmitting generation', async (suffix) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      respond({ id: jobId, status: 'running' });
      const result = invoke(`openh3_${suffix}`, { jobId, waitMs: 30000 }, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new Error('user stopped monitoring'));
      expect((await result).isError).toBe(true);
      await vi.advanceTimersByTimeAsync(30000);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    });

    it('propagates MCP cancellation into an in-flight status fetch', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          })
      );
      const result = invoke('openh3_comfy_job_status', { jobId, waitMs: 30000 }, controller.signal);
      controller.abort(new Error('user stopped monitoring'));
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
      expect((await result).isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('does not start a status request when MCP already cancelled the tool', async () => {
      const controller = new AbortController();
      controller.abort(new Error('already cancelled'));
      const result = await invoke('openh3_comfy_job_status', { jobId, waitMs: 30000 }, controller.signal);
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stops on a scoped status error without submitting a replacement job', async () => {
      vi.useFakeTimers();
      respond({ id: jobId, status: 'running' });
      respond({ error: 'COMFY_REQUEST_MISMATCH' }, 403);
      const result = invoke('openh3_comfy_job_status', { jobId, waitMs: 30000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect((await result).isError).toBe(true);
      expect((await result).content[0].text).toContain('COMFY_REQUEST_MISMATCH');
      await vi.advanceTimersByTimeAsync(30000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.every(([, init]) => !init.method)).toBe(true);
    });

    it('bounds a slow status refresh by the wait deadline and returns its last observed snapshot', async () => {
      vi.useFakeTimers();
      respond({ id: jobId, status: 'running', progress: 10 });
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          })
      );
      const result = invoke('openh3_comfy_job_status', { jobId, waitMs: 1500 });
      await vi.advanceTimersByTimeAsync(1500);
      expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
      expect(JSON.parse((await result).content[0].text).job).toMatchObject({ status: 'running', progress: 10 });
    });

    it.each(['succeeded', 'failed', 'cancelled', 'uncertain'])(
      'returns %s immediately without repeated status reads',
      async (status) => {
        vi.useFakeTimers();
        respond({
          id: jobId,
          status: status === 'uncertain' ? 'running' : status,
          submissionUncertain: status === 'uncertain',
        });
        const result = await invoke('openh3_comfy_job_status', { jobId, waitMs: 30000 });
        expect(result.isError).not.toBe(true);
        await vi.advanceTimersByTimeAsync(30000);
        expect(fetchMock).toHaveBeenCalledOnce();
      }
    );
  });

  describe('terminal observation acknowledgements', () => {
    const jobId = '12345678-1234-4234-8234-123456789abc';
    const updatedAt = '2026-11-09T04:00:00.000Z';

    it.each(['succeeded', 'failed', 'cancelled'])(
      'acknowledges only the exact %s snapshot read by the Agent with trusted scope',
      async (status) => {
        const job = { id: jobId, status, updatedAt, artifacts: [] };
        respond(job);
        respond({ acknowledged: true });
        const result = await invoke('openh3_comfy_job_status', {
          jobId,
          requestId: 'untrusted-request',
          updatedAt: 'untrusted-version',
        });
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          comfyJobId: jobId,
          job,
          acknowledgement: { acknowledged: true },
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(new URL(fetchMock.mock.calls[1][0]).pathname).toBe(`/api/comfy/jobs/${jobId}/acknowledge`);
        expect(requestBody(1)).toEqual({ requestId, updatedAt });
      }
    );

    it.each(['queued', 'running', 'uncertain'])(
      'does not acknowledge %s work or suppress its future continuation',
      async (status) => {
        respond({
          id: jobId,
          status: status === 'uncertain' ? 'failed' : status,
          updatedAt,
          submissionUncertain: status === 'uncertain',
        });
        const result = await invoke('openh3_comfy_job_status', { jobId });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0].text)).not.toHaveProperty('acknowledgement');
        expect(fetchMock).toHaveBeenCalledOnce();
      }
    );

    it('accepts an observer or stale-version acknowledgement returning false without losing terminal output', async () => {
      vi.stubEnv('AIONUI_CREATION_REQUEST_ID', '');
      vi.stubEnv('OPENH3_CONVERSATION_ID', 'observing-chat');
      const job = {
        id: jobId,
        status: 'succeeded',
        updatedAt,
        observationOnly: true,
        artifacts: [{ path: 'D:/output.png', mimeType: 'image/png' }],
      };
      respond(job);
      respond({ acknowledged: false });
      const result = await invoke('openh3_comfy_job_status', { jobId });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ job, acknowledgement: { acknowledged: false } });
      expect(requestBody(1)).toEqual({ conversationId: 'observing-chat', updatedAt });
    });

    it('retains terminal evidence when acknowledgement fails', async () => {
      const job = { id: jobId, status: 'failed', updatedAt, error: 'MISSING_NODE' };
      respond(job);
      respond({ error: 'ACK_SERVICE_UNAVAILABLE' }, 503);
      const result = await invoke('openh3_comfy_job_status', { jobId });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        job,
        acknowledgement: { acknowledged: false, error: expect.stringContaining('ACK_SERVICE_UNAVAILABLE') },
      });
    });

    it('bounds acknowledgement to five seconds while preserving the terminal snapshot', async () => {
      vi.useFakeTimers();
      respond({ id: jobId, status: 'succeeded', updatedAt });
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          })
      );
      const result = invoke('openh3_comfy_job_status', { jobId, waitMs: 30000 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
      expect(JSON.parse((await result).content[0].text)).toMatchObject({
        job: { status: 'succeeded' },
        acknowledgement: { acknowledged: false, error: expect.stringContaining('ACKNOWLEDGEMENT_TIMEOUT') },
      });
    });

    it('does not acknowledge a terminal response after MCP cancellation', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation(async () => {
        controller.abort(new Error('cancelled during response'));
        return new Response(JSON.stringify({ id: jobId, status: 'succeeded', updatedAt }));
      });
      const result = await invoke('openh3_comfy_job_status', { jobId }, controller.signal);
      expect(result.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('terminal installation observations', () => {
    const operationId = 'operation/observed';
    const updatedAt = '2026-11-09T05:00:00.000Z';

    it.each(['completed', 'failed', 'cancelled'])(
      'acknowledges only the explicit %s status snapshot with its trusted request and version',
      async (state) => {
        const operation = { id: operationId, state, updatedAt, plan };
        respond(operation);
        respond({ acknowledged: true });
        const reply = await invoke('openh3_comfy_install', {
          action: 'status',
          operationId,
          requestId: 'untrusted-request',
          updatedAt: 'untrusted-version',
        });
        expect(reply.isError).toBe(state === 'failed' ? true : undefined);
        expect(JSON.parse(reply.content[0].text)).toMatchObject({
          operation,
          acknowledgement: { acknowledged: true },
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(new URL(fetchMock.mock.calls[1][0]).pathname).toBe(
          '/api/comfy/operations/operation%2Fobserved/acknowledge'
        );
        expect(requestBody(1)).toEqual({ requestId, updatedAt });
      }
    );

    it.each(['awaiting-consent', 'authorized', 'running', 'paused'])(
      'does not acknowledge %s installation state',
      async (state) => {
        respond({ id: operationId, state, updatedAt, plan });
        const reply = await invoke('openh3_comfy_install', { action: 'status', operationId });
        expect(JSON.parse(reply.content[0].text)).not.toHaveProperty('acknowledgement');
        expect(fetchMock).toHaveBeenCalledOnce();
      }
    );

    it.each(['request', 'plan', 'start', 'recover', 'cancel'])(
      'does not acknowledge a terminal result returned by %s',
      async (action) => {
        respond({ id: operationId, state: 'completed', updatedAt, plan });
        const reply = await invoke('openh3_comfy_install', { action, operationId, plan });
        expect(JSON.parse(reply.content[0].text)).not.toHaveProperty('acknowledgement');
        expect(fetchMock).toHaveBeenCalledOnce();
      }
    );

    it('does not acknowledge bulk activity status reads', async () => {
      const activities = [{ id: operationId, state: 'completed', updatedAt, plan }];
      respond(activities);
      const reply = await invoke('openh3_comfy_install', { action: 'status' });
      expect(JSON.parse(reply.content[0].text)).toEqual(activities);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it.each([200, 503])('preserves the observed failure when acknowledgement returns HTTP %s', async (status) => {
      const operation = { id: operationId, state: 'failed', updatedAt, plan, error: 'INSTALL_FAILED' };
      respond(operation);
      respond(status === 200 ? { acknowledged: false } : { error: 'ACK_SERVICE_UNAVAILABLE' }, status);
      const reply = await invoke('openh3_comfy_install', { action: 'status', operationId });
      expect(reply.isError).toBe(true);
      expect(JSON.parse(reply.content[0].text)).toMatchObject({
        operation,
        nextAction: { type: 'diagnose-and-continue', sameGoal: true },
        acknowledgement: { acknowledged: false },
      });
    });

    it('bounds operation acknowledgement to five seconds and retains completed evidence', async () => {
      vi.useFakeTimers();
      respond({ id: operationId, state: 'completed', updatedAt, plan });
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          })
      );
      const reply = invoke('openh3_comfy_install', { action: 'status', operationId });
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
      expect(JSON.parse((await reply).content[0].text)).toMatchObject({
        operation: { state: 'completed' },
        acknowledgement: { acknowledged: false, error: expect.stringContaining('ACKNOWLEDGEMENT_TIMEOUT') },
      });
    });

    it('does not acknowledge an operation after MCP cancellation', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation(async () => {
        controller.abort(new Error('cancelled during response'));
        return new Response(JSON.stringify({ id: operationId, state: 'completed', updatedAt, plan }));
      });
      const reply = await invoke('openh3_comfy_install', { action: 'status', operationId }, controller.signal);
      expect(reply.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it('observes an external prompt in the trusted chat even without a creation-card binding', async () => {
    vi.stubEnv('AIONUI_CREATION_REQUEST_ID', '');
    vi.stubEnv('OPENH3_CONVERSATION_ID', 'real-chat');
    const promptId = '12345678-1234-4234-8234-123456789abc';
    respond({ comfyJobId: promptId, job: { id: promptId, status: 'running', observationOnly: true } });
    const reply = await invoke('openh3_comfy_observe_prompt', {
      promptId,
      baseUrl: 'http://127.0.0.1:8188',
      kind: 'image',
      conversationId: 'invented-chat',
    });
    expect(reply.isError).not.toBe(true);
    expect(JSON.parse(reply.content[0].text)).toMatchObject({ comfyJobId: promptId });
    expect(requestBody()).toEqual({
      promptId,
      baseUrl: 'http://127.0.0.1:8188',
      kind: 'image',
      conversationId: 'real-chat',
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/comfy/observe-prompt');
    respond({ id: promptId, status: 'succeeded' });
    await invoke('openh3_comfy_job_status', { jobId: promptId });
    expect(String(fetchMock.mock.calls[1][0])).toContain('conversationId=real-chat');
  });
  it('registers browser-independent research and scopes source discovery to the selected request', async () => {
    expect(registered.has('openh3_web_search')).toBe(true);
    expect(registered.has('openh3_web_fetch')).toBe(true);
    respond({ sources: [], attempts: [] });
    await invoke('openh3_comfy_sources', { component: 'z', repositories: ['Org/Model'] });
    expect(requestBody()).toEqual({ requestId, component: 'z', repositories: ['Org/Model'] });
  });
  it('keeps verified general downloads available and distinguishes raw workflows from page previews', () => {
    const description = registered.get('openh3_web_fetch')!.description;
    expect(description).not.toContain('use the verified installer for artifacts');
    expect(description).toContain('permitted general download tools');
    expect(description).toContain('provenance, fixed revisions and expected hashes');
    expect(description).toContain('raw workflow JSON');
    expect(description).toContain('normalized or truncated');
  });
  it('forwards replacement sources only into the existing recovery operation', async () => {
    respond({ id: 'operation-1', state: 'running' });
    const sourceOverrides = [{ component: 'z', urls: ['https://modelscope.cn/Org/Model/resolve/revision/z'] }];
    await invoke('openh3_comfy_install', { action: 'recover', operationId: 'operation-1', sourceOverrides });
    expect(requestBody()).toEqual({ requestId, sourceOverrides });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/operation-1/recover');
  });
  it('returns structured preparation diagnostics to the Agent without replaying the operation', async () => {
    respond({ error: 'COMFY_DETECTION_INCOMPLETE: driver probe timed out' }, 400);
    const result = await invoke('openh3_comfy_install', { action: 'request', family: 'qwen-edit', intent: 'install' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatchObject({ code: 'COMFY_DETECTION_INCOMPLETE' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('forwards exact source candidates with the bound model-card identity', async () => {
    respond({ id: 'operation-1', state: 'running' }, 201);
    const sourceOverrides = [
      {
        component: 'moss_image_sft_bf16.safetensors',
        urls: ['https://huggingface.co/repo/resolve/revision/file.safetensors'],
      },
    ];
    const result = await invoke('openh3_comfy_install', {
      action: 'request',
      family: 'moss-image-sft',
      intent: 'install',
      sourceOverrides,
    });
    expect(result.isError).not.toBe(true);
    expect(requestBody()).toMatchObject({
      install: { action: 'request', family: 'moss-image-sft', intent: 'install', sourceOverrides },
      requestId,
    });
  });
  it('inspects the bound request after preparation failure even without an operation id', async () => {
    respond({ operations: [], preparations: [{ error: 'NETWORK_TIMEOUT' }] });
    const result = await invoke('openh3_comfy_install', { action: 'status' });
    expect(JSON.parse(result.content[0].text).preparations).toHaveLength(1);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('requestId')).toBe(requestId);
  });
  it('resumes the same authorized operation without an authorization tool', async () => {
    respond({ id: 'operation-1', state: 'running', recoveryAttempts: 1 });
    const result = await invoke('openh3_comfy_install', { action: 'recover', operationId: 'operation-1' });
    expect(result.isError).not.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain('/operations/operation-1/recover');
    expect(requestBody()).toEqual({ requestId });
  });
  it('submits cloud video using the bound request and a stable submission UUID', async () => {
    vi.stubEnv('OPENH3_CREATION_SOURCE', 'cloud');
    vi.stubEnv('OPENH3_CREATION_KIND', 'video');
    const submissionId = '12345678-1234-4234-8234-123456789abc';
    respond({ id: 'cloud-job', status: 'queued' });
    const reply = await invoke('openh3_cloud_video_generate', { submissionId, input: { prompt: 'fox' } });
    expect(reply.isError).not.toBe(true);
    expect(requestBody()).toMatchObject({ requestId, submissionId, input: { prompt: 'fox' } });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:33009/api/cloud-video/jobs');
    expect(JSON.parse(reply.content[0].text)).toMatchObject({
      cloudVideoJobId: 'cloud-job',
      stopPolling: false,
      automaticRetryAllowed: false,
    });
  });

  it.each([
    ['queued', false],
    ['running', false],
    ['succeeded', true],
    ['failed', true],
  ] as const)('returns status-aware cloud monitoring guidance for %s jobs', async (status, stopPolling) => {
    vi.stubEnv('OPENH3_CREATION_SOURCE', 'cloud');
    vi.stubEnv('OPENH3_CREATION_KIND', 'video');
    const jobId = '12345678-1234-4234-8234-123456789abc';
    const job = { id: jobId, status };
    respond(job);
    const submission = await invoke('openh3_cloud_video_generate', {
      submissionId: jobId,
      input: { prompt: 'fox' },
    });
    respond(job);
    const snapshot = await invoke('openh3_cloud_video_status', { jobId });
    for (const reply of [submission, snapshot]) {
      expect(JSON.parse(reply.content[0].text)).toMatchObject({
        cloudVideoJobId: jobId,
        job,
        stopPolling,
        automaticRetryAllowed: false,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0]).pathname).toBe(`/api/cloud-video/jobs/${jobId}`);
    expect(fetchMock.mock.calls[1][1].method).toBeUndefined();
  });

  it('preserves an uncertain cloud submission without retrying or replacing its identity', async () => {
    vi.stubEnv('OPENH3_CREATION_SOURCE', 'cloud');
    vi.stubEnv('OPENH3_CREATION_KIND', 'video');
    const jobId = '12345678-1234-4234-8234-123456789abc';
    respond({ id: jobId, status: 'failed', submissionUncertain: true });
    const reply = await invoke('openh3_cloud_video_generate', {
      submissionId: jobId,
      input: { prompt: 'fox' },
    });
    expect(JSON.parse(reply.content[0].text)).toMatchObject({
      cloudVideoJobId: jobId,
      job: { submissionUncertain: true },
      stopPolling: true,
      automaticRetryAllowed: false,
    });
    expect(requestBody()).toMatchObject({ submissionId: jobId });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('registers OpenH3 tool names and keeps legacy pending calls on the same handlers', () => {
    for (const [name, legacy] of registered) {
      if (!name.startsWith('aionui_')) continue;
      const canonical = registered.get(name.replace(/^aionui_/, 'openh3_'));
      expect(canonical, name).toBeDefined();
      expect(canonical!.schema).toBe(legacy.schema);
      expect(canonical!.callback).toBe(legacy.callback);
    }
  });
  it.each(['register', 'revalidate'] as const)(
    'forwards explicit installation intent through %s without changing the parent request',
    async (action) => {
      respond(
        action === 'revalidate'
          ? { comfyJobId: 'validation-job', job: { id: 'validation-job', status: 'queued' }, validation: true }
          : { id: candidate.id, state: 'downloaded' }
      );
      const reply = await invoke('openh3_comfy_profiles', {
        action,
        profile: candidate,
        profileId: candidate.id,
        installationIntent: 'install-other',
        smokeInput: { prompt: 'test' },
      });
      expect(reply.isError).not.toBe(true);
      expect(requestBody()).toMatchObject({ action, requestId, installationIntent: 'install-other' });
    }
  );
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
    expect(JSON.parse(reply.content[0].text)).toMatchObject(validationJob);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['image', 'video'])(
    'registers and completes a custom %s model in a plain chat without a model-card request',
    async (kind) => {
      vi.stubEnv('AIONUI_CREATION_REQUEST_ID', '');
      vi.stubEnv('OPENH3_CREATION_REQUEST_ID', '');
      vi.stubEnv('OPENH3_CONVERSATION_ID', 'plain-chat');
      const custom = { ...candidate, family: `custom-${kind}`, kind };
      respond({ ...custom, state: 'downloaded' });
      const registeredReply = await invoke('openh3_comfy_profiles', { action: 'register', profile: custom });
      expect(registeredReply.isError).not.toBe(true);
      expect(requestBody()).toMatchObject({
        conversationId: 'plain-chat',
        profile: { family: `custom-${kind}`, kind, state: 'downloaded' },
      });
      expect(requestBody()).not.toHaveProperty('requestId');
      respond(
        {
          comfyJobId: 'validation-job',
          job: { id: 'validation-job', status: 'queued', artifacts: [] },
          validation: true,
        },
        202
      );
      const validation = await invoke('openh3_comfy_profiles', {
        action: 'revalidate',
        profileId: custom.id,
        smokeInput: { prompt: 'Smoke test' },
      });
      expect(validation.isError).not.toBe(true);
      expect(requestBody(1)).toMatchObject({ action: 'revalidate', conversationId: 'plain-chat' });
      respond({ completed: true });
      const complete = await invoke('openh3_comfy_installation_complete', { jobId: 'validation-job' });
      expect(complete.isError).not.toBe(true);
      expect(requestBody(2)).toEqual({ jobId: 'validation-job', conversationId: 'plain-chat' });
    }
  );

  it('preserves the service diagnostic for revalidation without a representative smoke input', async () => {
    respond({ error: 'COMFY_SMOKE_INPUT_REQUIRED' }, 400);
    const reply = await invoke('aionui_comfy_profiles', { action: 'revalidate', profileId: candidate.id });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('COMFY_SMOKE_INPUT_REQUIRED');
    expect(requestBody()).toEqual({ action: 'revalidate', profileId: candidate.id, requestId });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('adopts a genuinely validated workflow repair from the original conversation', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111';
    respond({ selection: { profileId: 'repaired-variant', intent: 'generate' } });
    const result = await invoke('openh3_comfy_profiles', {
      action: 'adopt-repair',
      profileId: 'repaired-variant',
      jobId,
    });
    expect(result.isError).not.toBe(true);
    expect(requestBody()).toEqual({ action: 'adopt-repair', profileId: 'repaired-variant', jobId, requestId });
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

  it('returns a failed installation as an error with the saved operation and an explicit Agent takeover', async () => {
    const operation = {
      id: 'operation-failed',
      state: 'failed',
      plan,
      error: 'COMFY_EXISTING_RUNTIME_INCOMPATIBLE:WORKFLOW_NODE_OR_INPUT_UNSUPPORTED',
    };
    respond(operation);
    const reply = await invoke('openh3_comfy_install', { action: 'status', operationId: operation.id });
    expect(reply.isError).toBe(true);
    expect(JSON.parse(reply.content[0].text)).toMatchObject({
      comfyOperationId: operation.id,
      operation,
      nextAction: {
        type: 'diagnose-and-continue',
        sameGoal: true,
        retryUnchangedPlan: false,
      },
    });
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
    expect(JSON.parse(reply.content[0].text)).toMatchObject({ comfyJobId: job.id, job });
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
    expect(JSON.parse(snapshot.content[0].text)).toMatchObject({ comfyJobId: job.id, job });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/comfy/jobs/job%2F1');
    expect(url.searchParams.get('requestId')).toBe(requestId);
    respond({ ...job, status: 'cancelled' });
    await invoke('aionui_comfy_cancel_job', { jobId: job.id });
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:33009/api/comfy/jobs/job%2F1/cancel');
    expect(requestBody(1)).toEqual({ requestId });
  });

  it('requires an existing conversation or request context and never invents one', async () => {
    vi.stubEnv('AIONUI_CREATION_REQUEST_ID', '');
    const reply = await invoke('aionui_comfy_generate', { profileId: candidate.id, input: { prompt: 'A ball' } });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('COMFY_CONVERSATION_CONTEXT_MISSING');
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

it('reads model knowledge without creating a managed installation, including unbound direct chat', async () => {
  vi.stubEnv('AIONUI_CREATION_REQUEST_ID', '');
  respond({ family: 'moss-image-sft', execution: 'agent', candidates: [{ id: 'moss-bf16' }] });
  const reply = await invoke('openh3_comfy_model_guide', { family: 'moss-image-sft' });
  expect(reply.isError).not.toBe(true);
  const url = new URL(fetchMock.mock.calls[0][0]);
  expect(url.pathname).toBe('/api/comfy/model-guide');
  expect(url.searchParams.get('family')).toBe('moss-image-sft');
  expect(url.searchParams.has('requestId')).toBe(false);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('records Agent completion through the backend validation receipt endpoint', async () => {
  respond({ id: 'receipt-1', state: 'completed', execution: 'agent' });
  const reply = await invoke('openh3_comfy_installation_complete', { jobId: 'real-validation-job' });
  expect(reply.isError).not.toBe(true);
  expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe('/api/comfy/agent-installation-complete');
  expect(requestBody()).toEqual({ requestId, jobId: 'real-validation-job' });
  expect(JSON.parse(reply.content[0].text).comfyOperationId).toBe('receipt-1');
});
