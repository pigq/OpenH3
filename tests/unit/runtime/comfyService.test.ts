import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComfyService, type ComfyServiceOptions } from '@/process/services/media/comfy/ComfyService';
import { ComfyInstallContinuation } from '@/process/services/media/creation/installContinuation';
import {
  comfyFamilyKind,
  comfyFamilySchema,
  distinctComfyProfiles,
  type ComfyProfile,
  type ComfyInstallPlan,
} from '@/common/chat/document/creation/comfy';
import { createComfyApprovalResolver } from '@/process/services/media/creation/installApproval';

let root: string;
let profile: ComfyProfile;
const requestId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-service-'));
  profile = {
    id: 'z-bf16',
    family: 'z-image',
    name: 'Z',
    kind: 'image',
    version: 'abc123',
    quantization: 'BF16',
    capabilities: ['text-to-image'],
    state: 'verified',
    environment: { root, python: path.join(root, 'python'), baseUrl: 'http://127.0.0.1:8188' },
    components: [{ role: 'diffusion', name: 'z', path: path.join(root, 'z'), version: 'abc123', precision: 'BF16' }],
    nodes: [{ id: 'ComfyUI', version: 'abc123' }],
    workflowPath: path.join(root, 'z.json'),
    bindings: Object.fromEntries(
      ['prompt', 'width', 'height', 'seed', 'durationSeconds', 'negativePrompt', 'batchSize', 'offload'].map((key) => [
        key,
        [{ nodeId: '1', input: key === 'prompt' ? 'text' : key }],
      ])
    ),
    defaults: {},
    validation: {
      fingerprint: 'fingerprint',
      checkedAt: new Date().toISOString(),
      promptId: 'smoke',
      artifacts: [path.join(root, 'out.png')],
    },
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function setup(options: Partial<ComfyServiceOptions> = {}) {
  const engine = {
    validate: vi.fn(async () => ({ fingerprint: 'fingerprint', loadable: true as const })),
    ensureStarted: vi.fn(async () => undefined),
    snapshotFingerprint: vi.fn(async () => 'fingerprint'),
    generate: vi.fn(async () => ({
      promptId: 'prompt',
      artifacts: [{ path: path.join(root, 'out.png'), mimeType: 'image/png' }],
    })),
    resume: vi.fn(),
    cancel: vi.fn(async () => undefined),
    stopOwned: vi.fn(),
    clearMemory: vi.fn(async () => undefined),
  };
  const install = vi.fn(async () => structuredClone(profile));
  const probe = vi.fn(async () => ({
    checkedAt: new Date().toISOString(),
    machine: {
      os: 'win32',
      arch: 'x64',
      totalMemoryBytes: 32e9,
      freeMemoryBytes: 20e9,
      disk: { path: root, totalBytes: 1e12, freeBytes: 5e11 },
      gpuStatus: 'available',
      gpus: [
        {
          vendor: 'nvidia',
          name: 'fixture',
          driver: '600',
          computeCapability: '8.9',
          totalMemoryBytes: 16e9,
          freeMemoryBytes: 14e9,
        },
      ],
    },
    runtime: { status: 'available', packages: { torch: '2.9' }, accelerator: 'cuda' },
    comfy: { root, status: 'installed', customNodes: [], service: 'offline' },
    issues: [],
  }));
  const service = new ComfyService({
    filename: path.join(root, 'state.json'),
    engine,
    install,
    probe,
    verifyArtifact: async (): Promise<void> => undefined,
    ...options,
  });
  service.bind({
    requestId,
    conversationId: 'chat',
    family: 'z-image',
    intent: 'install',
    source: 'local',
    kind: 'image',
  });
  return { service, engine, install, probe };
}
function plan() {
  const { state: _state, validation: _validation, ...recipe } = profile;
  return {
    ...recipe,
    targetRoot: root,
    downloadBytes: 0,
    requiredBytes: 10,
    reason: 'Known compatible complete graph',
    evidence: ['pinned upstream'],
    workflow: { '1': { class_type: 'Text', inputs: { text: '' } } },
    commands: [],
    smokeInput: { prompt: 'red sphere' },
    repair: false,
  };
}

it('returns reference preparation guidance for an Omni creative request without submitting a job', () => {
  const { service, engine } = setup();
  const omni = {
    ...profile,
    id: 'omni',
    family: 'fasth3-omni',
    kind: 'video' as const,
    capabilities: ['reference-to-video'],
  };
  service.register(omni);
  service.bind({
    requestId,
    conversationId: 'chat',
    profileId: omni.id,
    family: omni.family,
    source: 'local',
    kind: 'video',
    intent: 'generate',
  });
  const input = { prompt: 'A cinematic city skyline at dusk', durationSeconds: 6, width: 1280, height: 720 };
  const result = service.resolveWorkflow(requestId, input);
  expect(result).toMatchObject({
    action: 'prepare-reference',
    originalInput: input,
    selectedModel: { id: 'omni' },
    nextAction: { type: 'prepare-reference-and-continue', requiresUserUpload: false },
  });
  expect(engine.generate).not.toHaveBeenCalled();
  expect(() => service.generate(requestId, omni.id, input)).toThrow('COMFY_OMNI_REFERENCE_REQUIRED');
});

it('routes an old generate caller to preparation when explicit dimensions have no binding', () => {
  const { service, engine } = setup();
  delete profile.bindings.width;
  service.register(profile);
  service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
  expect(() => service.generate(requestId, profile.id, { prompt: 'landscape', width: 1280 })).toThrow(
    'COMFY_WORKFLOW_PREPARATION_REQUIRED'
  );
  expect(engine.generate).not.toHaveBeenCalled();
});

it('routes and adopts a legacy directory repair with completed indexed shard metadata', async () => {
  const directory = path.join(root, 'sharded');
  fs.mkdirSync(directory);
  const shard = path.join(directory, 'model-00001-of-00001.safetensors');
  fs.writeFileSync(shard, 'weights');
  fs.writeFileSync(
    path.join(directory, 'model.safetensors.index.json'),
    JSON.stringify({
      weight_map: { layer: path.basename(shard) },
    })
  );
  const legacy = {
    ...profile,
    state: 'downloaded' as const,
    components: [{ ...profile.components[0], path: directory }],
    validation: undefined,
  };
  const { service } = setup();
  service.recordProgressProfile(legacy);
  const repaired = service.register({
    ...legacy,
    id: 'repaired',
    components: [
      {
        ...legacy.components[0],
        path: shard,
        sizeBytes: 7,
        sha256: crypto.createHash('sha256').update('weights').digest('hex'),
      },
    ],
  });
  service.bind({
    requestId,
    conversationId: 'chat',
    profileId: legacy.id,
    family: legacy.family,
    intent: 'generate',
    source: 'local',
    kind: 'image',
    workflowMode: 'auto',
  });
  expect(service.resolveWorkflow(requestId, { prompt: 'test' }).candidates.map((item) => item.profileId)).toContain(
    repaired.id
  );
  expect(service.register({ ...legacy, id: 'directory' }).components.map((item) => item.path)).toEqual([
    shard,
    path.join(directory, 'model.safetensors.index.json'),
  ]);
  expect(service.profiles().find((item) => item.id === legacy.id)?.components[0].path).toBe(directory);
  const validation = service.verify(requestId, repaired.id, { prompt: 'verify repair' });
  await service.idle();
  await expect(service.adoptRepairedProfile(requestId, repaired.id, validation.id)).resolves.toMatchObject({
    profileId: legacy.id,
    workflowMode: 'auto',
  });
});

it.each(['failed', 'completed', 'cancelled'] as const)(
  'persists the exact managed operation %s observation without exposing metadata or repeating continuation',
  async (state) => {
    const { service, install } = setup();
    const pending = await service.request(requestId, plan());
    if (state === 'cancelled') service.cancelOperation(pending.id, { requestId });
    else {
      if (state === 'failed') install.mockRejectedValueOnce(new Error('NETWORK_TIMEOUT'));
      service.authorize(pending.id, 'chat');
      service.start(pending.id, requestId);
      await service.idle();
    }
    const terminal = service.operation(pending.id, { requestId });
    expect(terminal.state).toBe(state);
    if (state !== 'cancelled') expect(service.installationUpdates()).toHaveLength(1);
    expect(service.acknowledgeOperation(pending.id, { requestId }, 'old-version')).toBe(false);
    expect(() =>
      service.acknowledgeOperation(pending.id, { requestId: crypto.randomUUID() }, terminal.updatedAt)
    ).toThrow('COMFY_REQUEST_MISMATCH');
    expect(() =>
      service.acknowledgeOperation(pending.id, { conversationId: 'other-chat' }, terminal.updatedAt)
    ).toThrow('COMFY_CONVERSATION_MISMATCH');
    expect(service.acknowledgeOperation(pending.id, { requestId }, terminal.updatedAt)).toBe(true);
    expect(service.acknowledgeOperation(pending.id, { requestId }, terminal.updatedAt)).toBe(true);
    expect(service.operation(pending.id, { requestId })).toEqual(terminal);
    expect(service.activity('chat').operations).toEqual([terminal]);
    expect(service.installationUpdates()).toEqual([]);
    const restored = setup().service;
    expect(restored.operation(pending.id, { requestId })).toEqual(terminal);
    expect(restored.installationUpdates()).toEqual([]);
    expect(restored.acknowledgeOperation(pending.id, { requestId }, terminal.updatedAt)).toBe(true);
  }
);

it('does not acknowledge active managed operations or turn observation into permission', async () => {
  const { service, install } = setup();
  const pending = await service.request(requestId, plan());
  expect(service.acknowledgeOperation(pending.id, { requestId }, pending.updatedAt)).toBe(false);
  expect(() => service.start(pending.id, requestId)).toThrow('COMFY_USER_CONFIRMATION_REQUIRED');
  expect(install).not.toHaveBeenCalled();
  const authorized = service.authorize(pending.id, 'chat');
  expect(service.acknowledgeOperation(pending.id, { requestId }, authorized.updatedAt)).toBe(false);
  const running = service.start(pending.id, requestId);
  expect(service.acknowledgeOperation(pending.id, { requestId }, running.updatedAt)).toBe(false);
  const restored = setup().service;
  const paused = restored.operation(pending.id, { requestId });
  expect(paused.state).toBe('paused');
  expect(restored.acknowledgeOperation(pending.id, { requestId }, paused.updatedAt)).toBe(false);
  await service.idle();
});

it('emits a later managed operation result after an acknowledged failure is repaired', async () => {
  const { service, install } = setup();
  install.mockRejectedValueOnce(new Error('NETWORK_TIMEOUT'));
  const pending = await service.request(requestId, plan());
  service.authorize(pending.id, 'chat');
  service.start(pending.id, requestId);
  await service.idle();
  const failure = service.operation(pending.id, { requestId });
  expect(failure.state).toBe('failed');
  expect(service.acknowledgeOperation(pending.id, { requestId }, failure.updatedAt)).toBe(true);
  expect(service.installationUpdates()).toEqual([]);
  service.recoverInstallation(pending.id, requestId);
  await service.idle();
  const success = service.operation(pending.id, { requestId });
  expect(success.state).toBe('completed');
  expect(service.installationUpdates()).toEqual([success]);
  expect(setup().service.installationUpdates()).toEqual([success]);
});

it('keeps managed operation observation versions distinct when repair finishes within the same millisecond', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { service, install } = setup();
    install.mockRejectedValueOnce(new Error('NETWORK_TIMEOUT'));
    const pending = await service.request(requestId, plan());
    service.authorize(pending.id, 'chat');
    service.start(pending.id, requestId);
    await service.idle();
    const failure = service.operation(pending.id, { requestId });
    expect(service.acknowledgeOperation(pending.id, { requestId }, failure.updatedAt)).toBe(true);
    service.recoverInstallation(pending.id, requestId);
    await service.idle();
    const success = service.operation(pending.id, { requestId });
    expect(success.state).toBe('completed');
    expect(success.updatedAt).not.toBe(failure.updatedAt);
    expect(service.acknowledgeOperation(pending.id, { requestId }, failure.updatedAt)).toBe(false);
    expect(service.installationUpdates()).toEqual([success]);
  } finally {
    vi.useRealTimers();
  }
});

it('persists explicit terminal observation without mutating the job or waking a duplicate continuation', async () => {
  const { service, engine } = setup();
  service.register(profile);
  engine.generate.mockRejectedValueOnce(new Error('MISSING_NODE'));
  const job = service.verify(requestId, profile.id, { prompt: 'validate' });
  expect(service.acknowledgeJob(job.id, { requestId }, job.updatedAt)).toBe(false);
  await service.idle();
  const terminal = service.job(job.id, { requestId });
  expect(service.installationValidationUpdates()).toHaveLength(1);
  expect(service.acknowledgeJob(job.id, { requestId }, 'old-version')).toBe(false);
  expect(() => service.acknowledgeJob(job.id, { requestId: crypto.randomUUID() }, terminal.updatedAt)).toThrow();
  expect(service.acknowledgeJob(job.id, { requestId }, terminal.updatedAt)).toBe(true);
  expect(service.job(job.id, { requestId })).toEqual(terminal);
  expect(service.installationValidationUpdates()).toEqual([]);
  expect(setup().service.installationValidationUpdates()).toEqual([]);
});

describe('workflow repair continuation', () => {
  async function failure(options: Partial<ComfyServiceOptions> = {}) {
    const context = setup(options);
    const { service, engine, install, probe } = context;
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    const input = {
      prompt: 'preserve both people',
      width: 512,
      references: [
        { type: 'image' as const, path: path.join(root, 'first.png') },
        { type: 'image' as const, path: path.join(root, 'second.png') },
      ],
    };
    const queued = service.generate(requestId, profile.id, input);
    await service.idle();
    const job = service.job(queued.id, { requestId });
    expect(job.error).toBe('COMFY_IMAGE_BINDINGS_MISSING');
    const reopen = () =>
      new ComfyService({
        filename: path.join(root, 'state.json'),
        engine,
        install,
        probe,
        verifyArtifact: async (): Promise<void> => undefined,
        ...options,
      });
    return { ...context, job, input, reopen };
  }

  it.each([false, true])(
    'retains the original repair context across restart after observation=%s',
    async (observed) => {
      const { service, job, input, reopen } = await failure();
      if (observed) expect(service.acknowledgeJob(job.id, { requestId }, job.updatedAt)).toBe(true);
      const expected = expect.objectContaining({
        id: job.id,
        purpose: 'generation',
        originalInput: input,
        profile: expect.objectContaining({ id: profile.id, quantization: 'BF16', bindings: profile.bindings }),
      });
      expect(service.installationValidationUpdates()).toEqual([expected]);
      expect(reopen().installationValidationUpdates()).toEqual([expected]);
      for (const current of [service, reopen()]) {
        const publicJob = current.job(job.id, { requestId });
        expect(publicJob).toMatchObject({ originalInput: input, profile: expect.objectContaining({ id: profile.id }) });
        expect(publicJob).not.toHaveProperty('requestId');
        expect(publicJob).not.toHaveProperty('selectionAtSubmission');
        expect(publicJob).not.toHaveProperty('input');
        expect(publicJob).not.toHaveProperty('submittedInput');
      }
    }
  );

  it('delivers an observed failure once after the active Agent becomes idle, including restarts and Stop', async () => {
    const { service, job, input, reopen } = await failure();
    service.acknowledgeJob(job.id, { requestId }, job.updatedAt);
    let current = reopen();
    let busy = true;
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(
          JSON.stringify({
            success: true,
            data:
              init?.method === 'POST'
                ? { turn_id: 'repair-turn', msg_id: 'event' }
                : {
                    id: 'chat',
                    runtime: { is_processing: busy, can_send_message: !busy, pending_confirmations: 0 },
                    extra: { creation_request: { requestId, intent: 'generate' } },
                  },
          })
        )
    );
    const worker = () =>
      new ComfyInstallContinuation({
        filename: path.join(root, 'continuations.json'),
        backendPort: () => 12345,
        operations: () => current.installationUpdates(),
        validations: () => current.installationValidationUpdates(),
        fetchImpl,
      });
    await worker().pump();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const paused = worker();
    const control = paused.control('chat', 'pause');
    busy = false;
    await worker().pump();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const resumed = worker();
    resumed.control('chat', 'resume', control.epoch);
    await resumed.pump();
    const sends = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(sends).toHaveLength(1);
    const content = JSON.parse(String(sends[0][1]?.body)).content as string;
    expect(JSON.parse(content.slice(content.indexOf('\n') + 1)).originalInput).toEqual(input);
    expect(content).toContain('"profileId":"z-bf16"');
    expect(content).toContain('adopt-repair');
    current = reopen();
    await worker().pump();
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('adopts a validated same-model reference repair after restart and does not revive its old failure', async () => {
    const { service, job, input, engine, reopen } = await failure();
    service.acknowledgeJob(job.id, { requestId }, job.updatedAt);
    const repaired = {
      ...profile,
      id: 'reference-repair',
      workflowPath: path.join(root, 'repaired.json'),
      bindings: {
        ...profile.bindings,
        image: [
          { nodeId: '2', input: 'image' },
          { nodeId: '3', input: 'image' },
        ],
      },
    };
    service.register(repaired);
    const validation = service.verify(requestId, repaired.id, input);
    expect(service.installationValidationUpdates()).toEqual([]);
    await service.idle();
    expect(engine.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: repaired.id }),
      input,
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      undefined
    );
    const terminal = service.job(validation.id, { requestId });
    service.acknowledgeJob(validation.id, { requestId }, terminal.updatedAt);
    const restarted = reopen();
    expect(restarted.installationValidationUpdates()).toEqual([]);
    await expect(restarted.adoptRepairedProfile(requestId, repaired.id, validation.id)).resolves.toMatchObject({
      profileId: repaired.id,
    });
    expect(restarted.job(job.id, { requestId })).toMatchObject({ recoveredBy: validation.id });
    expect(restarted.installationValidationUpdates()).toEqual([]);
  });

  it.each(['job', 'preparation', 'operation', 'selection'] as const)(
    'suppresses an old observed failure after related %s work',
    async (change) => {
      let resolvePlan!: (value: ComfyInstallPlan) => void;
      const pendingPlan = new Promise<ComfyInstallPlan>((resolve) => {
        resolvePlan = resolve;
      });
      const { service, job } = await failure({ preparePlan: async () => pendingPlan });
      service.acknowledgeJob(job.id, { requestId }, job.updatedAt);
      let requesting: Promise<unknown> | undefined;
      if (change === 'job') {
        const child = service.installationScope(requestId, profile.family, 'install-other');
        service.verify(child, profile.id, { prompt: 'new related work' });
      } else if (change === 'selection') {
        service.register({ ...profile, id: 'other-selection' });
        service.bind({ ...service.selection(requestId), profileId: 'other-selection' });
      } else {
        requesting = service.request(requestId, {
          action: 'request',
          family: profile.family,
          profileId: profile.id,
          intent: 'repair',
        });
        if (change === 'operation') {
          resolvePlan({ ...plan(), repair: true });
          await requesting;
        }
      }
      expect(service.installationValidationUpdates().some((event) => event.id === job.id)).toBe(false);
      resolvePlan({ ...plan(), repair: true });
      await requesting;
      await service.idle();
    }
  );

  it('rechecks actual repair progress before delivering an idle callback', async () => {
    const { service, job, input } = await failure();
    service.acknowledgeJob(job.id, { requestId }, job.updatedAt);
    const repaired = service.register({
      ...profile,
      id: 'already-repairing',
      bindings: {
        ...profile.bindings,
        image: [
          { nodeId: '2', input: 'image' },
          { nodeId: '3', input: 'image' },
        ],
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      service.verify(requestId, repaired.id, input);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'chat',
            runtime: { is_processing: false, can_send_message: true, pending_confirmations: 0 },
            extra: { creation_request: { requestId, intent: 'generate' } },
          },
        })
      );
    });
    const worker = new ComfyInstallContinuation({
      filename: path.join(root, 'continuations.json'),
      backendPort: () => 12345,
      operations: () => [],
      validations: () => service.installationValidationUpdates(),
      fetchImpl,
    });
    await worker.pump();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1]?.method).not.toBe('POST');
    await service.idle();
  });

  it.each(['selection', 'new-request', 'acknowledged', 'new-repair', 'adopted', 'same-binding'] as const)(
    'reconciles a callback accepted during %s without confusing repair progress with user selection',
    async (change) => {
      const { service, job, input } = await failure();
      const repaired = service.register({
        ...profile,
        id: 'reference-repair',
        bindings: {
          ...profile.bindings,
          image: [
            { nodeId: '2', input: 'image' },
            { nodeId: '3', input: 'image' },
          ],
        },
      });
      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        let data: unknown = {
          id: 'chat',
          runtime: { is_processing: false, can_send_message: true, pending_confirmations: 0 },
          extra: { creation_request: { requestId, intent: 'generate' } },
        };
        if (init?.method === 'POST' && String(url).endsWith('/messages')) {
          if (change === 'selection') service.bind({ ...service.selection(requestId), profileId: repaired.id });
          else if (change === 'new-request')
            service.bind({ ...service.selection(requestId), requestId: crypto.randomUUID() });
          else if (change === 'same-binding') service.bind(service.selection(requestId));
          else if (change === 'acknowledged') service.acknowledgeJob(job.id, { requestId }, job.updatedAt);
          else {
            const validation = service.verify(requestId, repaired.id, input);
            if (change === 'adopted') {
              await service.idle();
              await service.adoptRepairedProfile(requestId, repaired.id, validation.id);
            }
          }
          data = { turn_id: 'accepted-repair', msg_id: 'event' };
        }
        return new Response(JSON.stringify({ success: true, data }));
      });
      const worker = new ComfyInstallContinuation({
        filename: path.join(root, 'callback-guard.json'),
        backendPort: () => 12345,
        operations: () => [],
        validations: () => service.installationValidationUpdates(),
        fetchImpl,
        captureSelection: (scope, conversationId) => service.captureContinuationSelection(scope, conversationId),
      });
      await worker.pump();
      const cancellations = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/cancel'));
      expect(cancellations).toHaveLength(change === 'selection' || change === 'new-request' ? 1 : 0);
      if (cancellations.length)
        expect(JSON.parse(String(cancellations[0][1]?.body))).toEqual({ turn_id: 'accepted-repair' });
      expect(
        fetchImpl.mock.calls.filter(([url, init]) => String(url).endsWith('/messages') && init?.method === 'POST')
      ).toHaveLength(1);
      await service.idle();
    }
  );

  it('does not let a stale event choose the authoritative request after restart', async () => {
    const { service, reopen } = await failure();
    const newerRequest = crypto.randomUUID();
    service.bind({ ...service.selection(requestId), requestId: newerRequest });
    const restarted = reopen();
    restarted.captureContinuationSelection(requestId, 'chat');
    const current = restarted.captureContinuationSelection(newerRequest, 'chat');
    expect(current()).toBe(true);
    restarted.bind(restarted.selection(newerRequest));
    expect(current()).toBe(true);
    restarted.bind({ ...restarted.selection(newerRequest), requestId });
    expect(current()).toBe(false);
  });

  it.each(['failed', 'completed', 'cancelled'] as const)(
    'lets a newer linked %s repair result replace the original generation failure',
    async (state) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-11-10T00:00:00.000Z'));
        const { service, job, install, reopen } = await failure({
          preparePlan: async () => ({ ...plan(), repair: true }),
        });
        service.acknowledgeJob(job.id, { requestId }, job.updatedAt);
        vi.setSystemTime(new Date('2026-11-10T00:00:01.000Z'));
        const operation = await service.request(requestId, {
          action: 'request',
          family: profile.family,
          profileId: profile.id,
          intent: 'repair',
        });
        if (state === 'cancelled') service.cancelOperation(operation.id, { requestId });
        else {
          if (state === 'failed') install.mockRejectedValueOnce(new Error('REPAIR_NODE_INSTALL_FAILED'));
          service.authorize(operation.id, 'chat');
          service.start(operation.id, requestId);
          await service.idle();
        }
        expect(service.operation(operation.id, { requestId }).state).toBe(state);
        expect(service.installationValidationUpdates()).toEqual([]);
        expect(reopen().installationValidationUpdates()).toEqual([]);
        if (state !== 'cancelled')
          expect(service.installationUpdates()).toContainEqual(expect.objectContaining({ id: operation.id }));
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each(['older result', 'different selection', 'other installation'] as const)(
    'does not treat a related terminal operation as recovery evidence with %s',
    async (difference) => {
      const { service, job, install, reopen } = await failure({
        preparePlan: async () => ({ ...plan(), repair: true }),
      });
      service.acknowledgeJob(job.id, { requestId }, job.updatedAt);
      const operation = await service.request(requestId, {
        action: 'request',
        family: profile.family,
        profileId: profile.id,
        intent: 'repair',
      });
      install.mockRejectedValueOnce(new Error('REPAIR_NODE_INSTALL_FAILED'));
      service.authorize(operation.id, 'chat');
      service.start(operation.id, requestId);
      await service.idle();
      const filename = path.join(root, 'state.json');
      const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
      const receipt = saved.operations.find((value: { id: string }) => value.id === operation.id);
      if (difference === 'older result') receipt.updatedAt = new Date(Date.parse(job.updatedAt) - 1000).toISOString();
      else if (difference === 'other installation') receipt.plan.repair = false;
      else saved.repairParents.find(([id]: [string]) => id === operation.requestId)[1].profileId = 'another-selection';
      fs.writeFileSync(filename, JSON.stringify(saved));
      expect(reopen().installationValidationUpdates()).toContainEqual(expect.objectContaining({ id: job.id }));
    }
  );

  it.each(['COMFY_INPUT_IMAGE_REQUIRED', 'COMFY_APPROVAL_MODE_UNAVAILABLE', 'NETWORK_TIMEOUT'])(
    'keeps observation dedup for %s without assuming repairable workflow failure',
    async (error) => {
      const { service, engine } = setup();
      service.register(profile);
      service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
      engine.generate.mockRejectedValueOnce(new Error(error));
      const job = service.generate(requestId, profile.id, { prompt: 'request' });
      await service.idle();
      const terminal = service.job(job.id, { requestId });
      expect(terminal.status).toBe('failed');
      expect(terminal).not.toHaveProperty('originalInput');
      expect(terminal).not.toHaveProperty('profile');
      service.acknowledgeJob(job.id, { requestId }, terminal.updatedAt);
      expect(service.installationValidationUpdates()).toEqual([]);
    }
  );

  it('does not turn an uncertain workflow-looking failure into automatic repair', async () => {
    const { service, job, reopen } = await failure();
    service.acknowledgeJob(job.id, { requestId }, job.updatedAt);
    const filename = path.join(root, 'state.json');
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    saved.jobs[0].submissionUncertain = true;
    fs.writeFileSync(filename, JSON.stringify(saved));
    const restarted = reopen();
    expect(restarted.installationValidationUpdates()).toEqual([]);
    expect(restarted.job(job.id, { requestId })).not.toHaveProperty('originalInput');
    expect(restarted.job(job.id, { requestId })).not.toHaveProperty('profile');
  });

  it('keeps the current repair pending when an unrelated request in the same chat finishes', async () => {
    const { service, job } = await failure();
    service.acknowledgeJob(job.id, { requestId }, job.updatedAt);
    const unrelated = crypto.randomUUID();
    service.bind({ ...service.selection(requestId), requestId: unrelated });
    service.verify(unrelated, profile.id, { prompt: 'independent request' });
    await service.idle();
    expect(service.installationValidationUpdates()).toContainEqual(expect.objectContaining({ id: job.id }));
  });
});

it('does not acknowledge uncertain terminal observations', async () => {
  const { service, engine } = setup();
  service.register(profile);
  engine.generate.mockRejectedValueOnce(new Error('MISSING_NODE'));
  const job = service.verify(requestId, profile.id, { prompt: 'validate' });
  await service.idle();
  const filename = path.join(root, 'state.json');
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
  saved.jobs[0].submissionUncertain = true;
  fs.writeFileSync(filename, JSON.stringify(saved));
  const restored = setup().service;
  expect(restored.acknowledgeJob(job.id, { requestId }, saved.jobs[0].updatedAt)).toBe(false);
});

it('associates a failed generation only with a successful retry of the same request and input', async () => {
  const { service, engine } = setup();
  service.register(profile);
  await service.revalidate(profile.id, { prompt: 'smoke' });
  service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
  engine.generate.mockRejectedValueOnce(new Error('COMFY_PROFILE_CHANGED'));
  const failed = service.generate(requestId, profile.id, { prompt: 'original task', seed: 7 });
  await service.idle();
  expect(service.job(failed.id, { requestId })).toMatchObject({ status: 'failed', error: 'COMFY_PROFILE_CHANGED' });
  const other = service.generate(requestId, profile.id, { prompt: 'independent task', seed: 7 });
  await service.idle();
  expect(service.job(other.id, { requestId }).status).toBe('succeeded');
  expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
  const recovered = service.generate(requestId, profile.id, { prompt: 'original task', seed: 7 });
  await service.idle();
  expect(service.job(failed.id, { requestId })).toMatchObject({ status: 'failed', recoveredBy: recovered.id });
  const reopened = setup().service;
  expect(reopened.job(failed.id, { requestId })).toMatchObject({ recoveredBy: recovered.id });
});

describe('same-profile revalidation recovery', () => {
  async function attempts(verified = true) {
    const verifyArtifact = vi.fn(async (): Promise<void> => undefined);
    const { service, engine } = setup({ verifyArtifact });
    profile.bindings.image = ['2', '3', '4'].map((nodeId) => ({ nodeId, input: 'image' }));
    service.register(profile);
    if (verified) await service.revalidate(profile.id, { prompt: 'smoke' });
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    const input = { prompt: '白船穿过静谧的湖面', width: 352, height: 608, durationSeconds: 4 };
    engine.generate.mockRejectedValueOnce(new Error('COMFY_PROFILE_CHANGED'));
    const failed = service.generate(requestId, profile.id, input);
    await service.idle();
    return { service, engine, verifyArtifact, input, failed };
  }

  it.each([true, false])(
    'recovers the exact requested output through same-profile revalidation without adoption (verified=%s)',
    async (verified) => {
      const { service, verifyArtifact, input, failed } = await attempts(verified);
      const before = service.job(failed.id, { requestId });
      expect(before).toMatchObject({ status: 'failed', error: 'COMFY_PROFILE_CHANGED' });
      const success = service.verify(requestId, profile.id, input);
      expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
      await service.idle();
      expect(verifyArtifact).toHaveBeenLastCalledWith(
        expect.anything(),
        'image',
        expect.any(AbortSignal),
        expect.objectContaining({ mode: 'smoke', input })
      );
      expect(service.job(success.id, { requestId }).status).toBe('succeeded');
      expect(service.job(failed.id, { requestId })).toEqual({ ...before, recoveredBy: success.id });
      expect(service.activity('chat').jobs.find((job) => job.id === failed.id)?.recoveredBy).toBe(success.id);
      expect(service.activity('chat').operations).toEqual([]);
      expect(setup().service.job(failed.id, { requestId })).toMatchObject({
        status: 'failed',
        recoveredBy: success.id,
      });
    }
  );

  it.each([
    { prompt: 'unrelated smoke scene' },
    { width: 384 },
    { height: 640 },
    { durationSeconds: 5 },
    { seed: 17 },
    { negativePrompt: 'different constraints' },
    { batchSize: 2 },
  ])('does not recover the requested output from revalidation with changed input %o', async (change) => {
    const { service, input, failed } = await attempts();
    const success = service.verify(requestId, profile.id, { ...input, ...change });
    await service.idle();
    expect(service.job(success.id, { requestId }).status).toBe('succeeded');
    expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
  });

  it.each(['added', 'removed', 'reordered'] as const)('does not recover after references are %s', async (change) => {
    const { service, engine, input } = await attempts();
    const references = [
      { type: 'image' as const, path: path.join(root, 'first.png') },
      { type: 'image' as const, path: path.join(root, 'second.png') },
    ];
    engine.generate.mockRejectedValueOnce(new Error('COMFY_PROFILE_CHANGED'));
    const failed = service.generate(requestId, profile.id, { ...input, references });
    await service.idle();
    const changed =
      change === 'added'
        ? [...references, { type: 'image' as const, path: path.join(root, 'third.png') }]
        : change === 'removed'
          ? references.slice(0, 1)
          : references.toReversed();
    const success = service.verify(requestId, profile.id, { ...input, references: changed });
    await service.idle();
    expect(service.job(success.id, { requestId }).status).toBe('succeeded');
    expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
  });

  it.each(['request', 'selection', 'profile'] as const)('does not recover across a different %s', async (change) => {
    const { service, input, failed } = await attempts();
    service.register({ ...profile, id: 'other-profile' });
    const targetRequest = change === 'request' ? crypto.randomUUID() : requestId;
    service.bind({
      requestId: targetRequest,
      conversationId: 'chat',
      intent: 'generate',
      profileId: change === 'selection' ? 'other-profile' : profile.id,
    });
    const success = service.verify(targetRequest, change === 'profile' ? 'other-profile' : profile.id, input);
    await service.idle();
    expect(service.job(success.id, { requestId: targetRequest }).status).toBe('succeeded');
    expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
  });

  it.each(['quantization', 'component identity', 'uncertain', 'observer', 'artifacts', 'missing selection'] as const)(
    'rejects saved same-profile revalidation recovery with changed %s evidence',
    async (change) => {
      const { service, input, failed } = await attempts();
      const success = service.verify(requestId, profile.id, input);
      await service.idle();
      expect(service.job(failed.id, { requestId }).recoveredBy).toBe(success.id);
      const filename = path.join(root, 'state.json');
      const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
      const candidate = saved.jobs.find((job: { id: string }) => job.id === success.id);
      if (change === 'quantization') {
        candidate.profile.quantization = 'FP8';
        candidate.profile.components[0].precision = 'FP8';
      } else if (change === 'component identity') candidate.profile.components[0].path = path.join(root, 'other-model');
      else if (change === 'uncertain') candidate.submissionUncertain = true;
      else if (change === 'observer') candidate.observationOnly = true;
      else if (change === 'artifacts') candidate.artifacts = [];
      else delete candidate.selectionAtSubmission;
      fs.writeFileSync(filename, JSON.stringify(saved));
      expect(setup().service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
    }
  );
});

it('does not associate identical generations belonging to different requests', async () => {
  const { service, engine } = setup();
  service.register(profile);
  await service.revalidate(profile.id, { prompt: 'smoke' });
  service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
  engine.generate.mockRejectedValueOnce(new Error('COMFY_PROFILE_CHANGED'));
  const failed = service.generate(requestId, profile.id, { prompt: 'same prompt' });
  await service.idle();
  expect(service.job(failed.id, { requestId }).status).toBe('failed');
  const secondRequest = crypto.randomUUID();
  service.bind({ requestId: secondRequest, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
  service.generate(secondRequest, profile.id, { prompt: 'same prompt' });
  await service.idle();
  expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
});

it.each(['quantization', 'component identity'] as const)(
  'does not recover a generation after changing the selected model %s',
  async (change) => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'smoke' });
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    engine.generate.mockRejectedValueOnce(new Error('COMFY_PROFILE_CHANGED'));
    const failed = service.generate(requestId, profile.id, { prompt: 'same prompt', seed: 7 });
    await service.idle();
    const alternate = {
      ...profile,
      id: 'different-model',
      quantization: change === 'quantization' ? 'FP8' : profile.quantization,
      components: profile.components.map((component) => ({
        ...component,
        precision: change === 'quantization' ? 'FP8' : component.precision,
        path: change === 'component identity' ? path.join(root, 'different-weights') : component.path,
      })),
    };
    service.register(alternate);
    await service.revalidate(alternate.id, { prompt: 'smoke' });
    service.bind({ requestId, conversationId: 'chat', profileId: alternate.id, intent: 'generate' });
    const success = service.generate(requestId, alternate.id, { prompt: 'same prompt', seed: 7 });
    await service.idle();
    expect(service.job(success.id, { requestId }).status).toBe('succeeded');
    expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
  }
);

it('recovers a generation with an adopted validated repair variant of the same model and precision', async () => {
  const { service, engine } = setup();
  service.register(profile);
  await service.revalidate(profile.id, { prompt: 'smoke' });
  service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
  engine.generate.mockRejectedValueOnce(new Error('COMFY_PROFILE_CHANGED'));
  const failed = service.generate(requestId, profile.id, { prompt: 'original task', seed: 7 });
  await service.idle();
  const variant = { ...profile, id: 'repaired-workflow', nodes: [{ id: 'ComfyUI', version: 'repaired-revision' }] };
  service.register(variant);
  const validation = service.verify(requestId, variant.id, { prompt: 'validate repaired graph' });
  await service.idle();
  expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
  await service.adoptRepairedProfile(requestId, variant.id, validation.id);
  expect(service.job(failed.id, { requestId })).toMatchObject({ status: 'failed', recoveredBy: validation.id });
  const success = service.generate(requestId, variant.id, { prompt: 'original task', seed: 7 });
  await service.idle();
  expect(service.job(failed.id, { requestId })).toMatchObject({ status: 'failed', recoveredBy: success.id });
  expect(setup().service.job(failed.id, { requestId })).toMatchObject({ recoveredBy: success.id });
});

it('records repair adoption for earlier failed generation and validation attempts under the exact original selection', async () => {
  const { service, engine } = setup();
  service.register(profile);
  await service.revalidate(profile.id, { prompt: 'smoke' });
  service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
  const selection = service.selection(requestId);
  engine.generate.mockRejectedValueOnce(new Error('COMFY_PROFILE_CHANGED'));
  const generation = service.generate(requestId, profile.id, { prompt: 'original task', width: 512 });
  await service.idle();
  engine.generate.mockRejectedValueOnce(new Error('COMFY_INPUT_UNSUPPORTED:width'));
  const validation = service.verify(requestId, profile.id, { prompt: 'same task repair', width: 512 });
  await service.idle();
  const variant = service.register({ ...profile, id: 'repaired-portrait-workflow' });
  const success = service.verify(requestId, variant.id, { prompt: 'original task repaired', width: 512 });
  await service.idle();
  const before = [generation, validation].map((job) => service.job(job.id, { requestId }));
  expect(before.every((job) => job.status === 'failed' && !job.recoveredBy)).toBe(true);
  const adopted = await service.adoptRepairedProfile(requestId, variant.id, success.id);
  expect(adopted).toEqual({ ...selection, profileId: variant.id });
  for (const job of before) {
    expect(service.job(job.id, { requestId })).toEqual({ ...job, recoveredBy: success.id });
    expect(service.activity('chat').jobs.find((item) => item.id === job.id)).toEqual({
      ...job,
      recoveredBy: success.id,
    });
    expect(setup().service.job(job.id, { requestId })).toEqual({ ...job, recoveredBy: success.id });
  }
  expect(service.activity('chat').operations).toEqual([]);
});

it.each(['request', 'selection', 'model'] as const)(
  'does not use repair adoption to hide earlier failures from another %s',
  async (difference) => {
    const { service, engine } = setup();
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    const attempted =
      difference === 'model'
        ? service.register({
            ...profile,
            id: 'different-model',
            quantization: 'FP8',
            components: [{ ...profile.components[0], precision: 'FP8' }],
          })
        : profile;
    engine.generate.mockRejectedValueOnce(new Error('MISSING_NODE'));
    const failed = service.verify(requestId, attempted.id, { prompt: 'earlier failure' });
    await service.idle();
    const otherRequestId = difference === 'request' ? crypto.randomUUID() : requestId;
    const changed = service.register({
      ...profile,
      id: difference === 'selection' ? 'other-selection' : profile.id,
    });
    service.bind({ requestId: otherRequestId, conversationId: 'chat', profileId: changed.id, intent: 'generate' });
    const variant = service.register({ ...changed, id: 'valid-current-repair' });
    const success = service.verify(otherRequestId, variant.id, { prompt: 'current repair' });
    await service.idle();
    await service.adoptRepairedProfile(otherRequestId, variant.id, success.id);
    expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
    expect(setup().service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
  }
);

it.each(['submissionUncertain', 'observationOnly', 'updatedAt'] as const)(
  'does not trust repair-adoption recovery after the failed attempt changes %s',
  async (field) => {
    const { service, engine } = setup();
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    engine.generate.mockRejectedValueOnce(new Error('MISSING_NODE'));
    const failed = service.verify(requestId, profile.id, { prompt: 'failed validation' });
    await service.idle();
    const variant = service.register({ ...profile, id: 'repaired-workflow' });
    const success = service.verify(requestId, variant.id, { prompt: 'repaired validation' });
    await service.idle();
    await service.adoptRepairedProfile(requestId, variant.id, success.id);
    expect(service.job(failed.id, { requestId }).recoveredBy).toBe(success.id);
    const filename = path.join(root, 'state.json');
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const modified = saved.jobs.find((item: { id: string }) => item.id === failed.id);
    modified[field] = field === 'updatedAt' ? 'later-version' : true;
    modified.recoveredBy = success.id;
    fs.writeFileSync(filename, JSON.stringify(saved));
    expect(setup().service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
  }
);

it.each(['submissionUncertain', 'observationOnly', 'updatedAt', 'artifacts'] as const)(
  'does not derive repair-adoption recovery from a validation whose %s changed',
  async (field) => {
    const { service, engine } = setup();
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    engine.generate.mockRejectedValueOnce(new Error('MISSING_NODE'));
    const failed = service.verify(requestId, profile.id, { prompt: 'failed validation' });
    await service.idle();
    const variant = service.register({ ...profile, id: 'repaired-workflow' });
    const success = service.verify(requestId, variant.id, { prompt: 'repaired validation' });
    await service.idle();
    await service.adoptRepairedProfile(requestId, variant.id, success.id);
    expect(service.job(failed.id, { requestId }).recoveredBy).toBe(success.id);
    const filename = path.join(root, 'state.json');
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const modified = saved.jobs.find((item: { id: string }) => item.id === success.id);
    modified[field] = field === 'updatedAt' ? 'later-version' : field === 'artifacts' ? [] : true;
    fs.writeFileSync(filename, JSON.stringify(saved));
    expect(setup().service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
  }
);

it('does not let a repair adoption resolve a failure submitted after its successful validation', async () => {
  const { service, engine } = setup();
  service.register(profile);
  service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
  const variant = service.register({ ...profile, id: 'repaired-workflow' });
  const success = service.verify(requestId, variant.id, { prompt: 'repaired validation' });
  await service.idle();
  engine.generate.mockRejectedValueOnce(new Error('NEW_FAILURE'));
  const later = service.verify(requestId, profile.id, { prompt: 'new attempt' });
  await service.idle();
  await service.adoptRepairedProfile(requestId, variant.id, success.id);
  expect(service.job(later.id, { requestId })).not.toHaveProperty('recoveredBy');
});

it('does not call an uncertain submission recovered when another attempt succeeds', async () => {
  const { service, engine } = setup();
  service.register(profile);
  await service.revalidate(profile.id, { prompt: 'smoke' });
  service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
  engine.generate.mockRejectedValueOnce(new Error('COMFY_PROFILE_CHANGED'));
  const failed = service.generate(requestId, profile.id, { prompt: 'same task' });
  await service.idle();
  service.generate(requestId, profile.id, { prompt: 'same task' });
  await service.idle();
  const filename = path.join(root, 'state.json');
  const state = JSON.parse(fs.readFileSync(filename, 'utf8')) as {
    jobs: Array<{ id: string; submissionUncertain?: boolean; recoveredBy?: string }>;
  };
  const uncertain = state.jobs.find((job) => job.id === failed.id)!;
  uncertain.submissionUncertain = true;
  uncertain.recoveredBy = state.jobs.at(-1)!.id;
  fs.writeFileSync(filename, JSON.stringify(state));
  expect(setup().service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
});

it('reports unavailable inventory when discovery failed instead of reporting an empty installed-model list', async () => {
  const { service } = setup({
    discover: async () => {
      throw new Error('catalog read failed');
    },
  });
  await expect(service.refreshProfiles()).rejects.toThrow('COMFY_INVENTORY_UNAVAILABLE');
});

it('keeps registered profiles visible and exposes incomplete scan diagnostics', async () => {
  const { service } = setup({
    discover: async () => {
      throw new Error('COMFY_INVENTORY_SCAN_INCOMPLETE');
    },
  });
  service.register(profile);
  expect(await service.refreshProfiles()).toHaveLength(1);
  expect(service.inventory()).toMatchObject({
    complete: false,
    diagnostics: [{ code: 'COMFY_INVENTORY_SCAN_INCOMPLETE' }],
  });
});

it('does not list a discovered duplicate of the same runtime, components and workflow twice', async () => {
  const { service } = setup();
  const first = service.register(profile);
  service.register({
    ...profile,
    id: 'found-z-bf16-copy',
    environment: { ...profile.environment, baseUrl: 'http://127.0.0.1:18777' },
  });
  const visible = distinctComfyProfiles(service.profiles());
  expect(visible).toHaveLength(1);
  expect(visible[0].id).toBe(first.id);
  expect(distinctComfyProfiles(service.profiles(), ['found-z-bf16-copy'])[0].id).toBe('found-z-bf16-copy');
  service.bind({
    requestId,
    conversationId: 'chat',
    profileId: 'found-z-bf16-copy',
    family: profile.family,
    source: 'local',
    kind: 'image',
  });
  expect(service.selection(requestId).profileId).toBe('found-z-bf16-copy');
});

it('preserves different H3 recipes, precisions and independent environments in inventory', () => {
  const { service } = setup();
  service.register(profile);
  service.register({ ...profile, id: 'other-workflow', workflowPath: path.join(root, 'other.json') });
  service.register({ ...profile, id: 'other-precision', quantization: 'FP8' });
  service.register({
    ...profile,
    id: 'other-runtime',
    environment: { ...profile.environment, root: path.join(root, 'second') },
  });
  expect(distinctComfyProfiles(service.profiles())).toHaveLength(4);
});

it('does not merge unchecksummed components from different pinned repositories', () => {
  const { service } = setup();
  service.register({
    ...profile,
    components: [{ ...profile.components[0], url: 'https://models.example/org-one/model.safetensors' }],
  });
  service.register({
    ...profile,
    id: 'org-two-copy',
    components: [{ ...profile.components[0], url: 'https://models.example/org-two/model.safetensors' }],
  });
  expect(distinctComfyProfiles(service.profiles())).toHaveLength(2);
});

it('does not merge runtime policies that can rewrite the requested generation dimensions', () => {
  const { service } = setup();
  service.register(profile);
  service.register({
    ...profile,
    id: 'smaller-memory-recipe',
    memoryPolicy: {
      minWidth: 128,
      minHeight: 128,
      dimensionStep: 64,
      minBatchSize: 1,
      evidence: 'separate memory recipe',
    },
  });
  expect(distinctComfyProfiles(service.profiles())).toHaveLength(2);
});

it('does not downgrade an unchanged verified profile when scanning its legacy recipe again', async () => {
  const { service } = setup({ discover: async () => [{ ...profile, state: 'downloaded', validation: undefined }] });
  service.register(profile);
  await service.revalidate(profile.id, { prompt: 'test' });
  expect(service.profiles()[0].state).toBe('verified');
  await service.refreshProfiles();
  expect(service.profiles()[0].state).toBe('verified');
});
describe('Comfy installation and profile service', () => {
  it.each(['automatic', 'manual'] as const)(
    'installs a newly requested family from a generation conversation under %s approval',
    async (mode) => {
      const qwen = { ...profile, id: 'qwen-edit-fp8', family: 'qwen-edit' as const };
      const preparePlan = vi.fn(async () => ({ ...plan(), id: qwen.id, family: qwen.family }));
      const { service, install } = setup({ preparePlan, resolveApproval: async () => ({ mode, runtimeMode: mode }) });
      install.mockResolvedValue(qwen);
      service.register(profile);
      service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
      const selected = service.selection(requestId);
      const input = { action: 'request', family: 'qwen-edit', intent: 'install-other' };
      const [first, duplicate] = await Promise.all([
        service.request(requestId, input),
        service.request(requestId, input),
      ]);
      expect(first.id).toBe(duplicate.id);
      expect(first.requestId).not.toBe(requestId);
      expect(first.installRequest).toMatchObject({ family: 'qwen-edit', intent: 'install-other' });
      expect(first.installRequest?.profileId).toBeUndefined();
      expect(service.selection(first.requestId)).toMatchObject({ family: 'qwen-edit', kind: 'image', source: 'local' });
      expect(service.selection(requestId)).toEqual(selected);
      expect(service.operation(first.id, { requestId }).id).toBe(first.id);
      if (mode === 'manual') {
        expect(first.state).toBe('awaiting-consent');
        expect(install).not.toHaveBeenCalled();
        expect(() => service.start(first.id, requestId)).toThrow('COMFY_USER_CONFIRMATION_REQUIRED');
        service.authorize(first.id, 'chat');
        service.start(first.id, requestId);
      }
      await service.idle();
      expect(install).toHaveBeenCalledOnce();
      expect(service.operation(first.id, { requestId }).state).toBe('completed');
      expect(service.installationUpdates()).toContainEqual(expect.objectContaining({ id: first.id, requestId }));
      expect(service.selection(requestId)).toEqual(selected);
      expect((await service.request(requestId, input)).id).toBe(first.id);
    }
  );

  it.each(['generate', 'install'] as const)(
    'persists an independent explicit install target from a %s conversation and prevents cross-request access',
    async (intent) => {
      const preparePlan = vi.fn(async () => ({ ...plan(), id: 'qwen-new', family: 'qwen-edit' as const }));
      const { service, engine, probe, install } = setup({ preparePlan });
      service.bind({ requestId, conversationId: 'chat', family: 'z-image', intent, source: 'local' });
      const selected = service.selection(requestId);
      const input = { action: 'request', family: 'qwen-edit', intent: 'install' };
      const operation = await service.request(requestId, input);
      const restarted = new ComfyService({
        filename: path.join(root, 'state.json'),
        engine,
        probe,
        install,
        preparePlan,
      });
      expect((await restarted.request(requestId, input)).id).toBe(operation.id);
      expect(restarted.selection(requestId)).toEqual(selected);
      expect(() => restarted.operation(operation.id, { requestId: crypto.randomUUID() })).toThrow(
        'COMFY_REQUEST_MISMATCH'
      );
      await expect(restarted.request(requestId, { ...input, requestId: crypto.randomUUID() })).rejects.toThrow(
        'COMFY_REQUEST_MISMATCH'
      );
      restarted.authorize(operation.id, 'chat');
      restarted.bind({ requestId, conversationId: 'chat', family: 'h3', intent: 'generate', source: 'local' });
      expect(() => restarted.start(operation.id, requestId)).toThrow('COMFY_SELECTION_CHANGED');
      expect(install).not.toHaveBeenCalled();
      expect(restarted.cancelOperation(operation.id, { requestId }).state).toBe('cancelled');
    }
  );

  it('reports missing reference bindings before validating a discovered runtime', async () => {
    const { service, engine } = setup();
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    const job = service.generate(requestId, profile.id, {
      prompt: 'preserve the person',
      imagePaths: [path.join(root, 'person.png')],
    });
    await service.idle();
    expect(service.job(job.id, { requestId })).toMatchObject({
      status: 'failed',
      error: 'COMFY_IMAGE_BINDINGS_MISSING',
    });
    expect(engine.validate).not.toHaveBeenCalled();
    expect(engine.generate).not.toHaveBeenCalled();
    expect(service.installationValidationUpdates()).toContainEqual(
      expect.objectContaining({ id: job.id, purpose: 'generation' })
    );
  });

  it('cannot adopt validation from a superseded selection or while the selected profile changes', async () => {
    const { service, engine } = setup();
    service.register(profile);
    service.register({ ...profile, id: 'variant' });
    service.register({ ...profile, id: 'other' });
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    const job = service.verify(requestId, 'variant', { prompt: 'test' });
    await service.idle();
    service.bind({ requestId, conversationId: 'chat', profileId: 'other', intent: 'generate' });
    await expect(service.adoptRepairedProfile(requestId, 'variant', job.id)).rejects.toThrow('COMFY_SELECTION_CHANGED');
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    engine.snapshotFingerprint.mockImplementationOnce(async () => {
      service.bind({ requestId, conversationId: 'chat', profileId: 'other', intent: 'generate' });
      return 'fingerprint';
    });
    await expect(service.adoptRepairedProfile(requestId, 'variant', job.id)).rejects.toThrow('COMFY_SELECTION_CHANGED');
    expect(service.selection(requestId).profileId).toBe('other');
  });

  it('keeps linked repair bindings internal while allowing parent cancellation', async () => {
    const { service } = setup({ preparePlan: async () => ({ ...plan(), repair: true }) });
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    const repair = await service.request(requestId, { action: 'request', family: profile.family, intent: 'repair' });
    expect(() => service.bind({ ...service.selection(repair.requestId), intent: 'generate' })).toThrow(
      'COMFY_REPAIR_SCOPE_IMMUTABLE'
    );
    expect(service.cancelOperation(repair.id, { requestId }).state).toBe('cancelled');
    expect(service.selection(requestId).intent).toBe('generate');
  });

  it('returns generation failures and workflow variant validation to the original Agent for continued recovery', async () => {
    const { service, engine } = setup();
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    engine.generate.mockRejectedValueOnce(new Error('COMFY_NODE_REVISION_UNCONFIRMED'));
    const failed = service.generate(requestId, profile.id, { prompt: 'original task' });
    await service.idle();
    expect(service.installationValidationUpdates()).toEqual([
      expect.objectContaining({ id: failed.id, purpose: 'generation', requestId, state: 'failed' }),
    ]);
    service.register({ ...profile, id: 'repaired-workflow' });
    const job = service.verify(requestId, 'repaired-workflow', { prompt: 'test repaired graph' });
    await service.idle();
    expect(service.installationValidationUpdates()).toContainEqual(
      expect.objectContaining({ id: job.id, purpose: 'workflow-repair', requestId, state: 'completed' })
    );
  });

  it('adopts a validated workflow repair in the same generation request without replacing the selected model', async () => {
    const { service } = setup();
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    const original = service.selection(requestId);
    const repaired = service.register({
      ...profile,
      id: 'z-reference-workflow',
      workflowPath: path.join(root, 'reference-workflow.json'),
      capabilities: ['image-to-image'],
      bindings: { ...profile.bindings, image: [{ nodeId: '2', input: 'image' }] },
    });
    const job = service.verify(requestId, repaired.id, {
      prompt: 'preserve identity',
      references: [{ type: 'image', path: path.join(root, 'person.jpg') }],
    });
    await service.idle();
    expect(service.selection(requestId)).toEqual(original);
    expect(await service.adoptRepairedProfile(requestId, repaired.id, job.id)).toMatchObject({
      profileId: repaired.id,
      intent: 'generate',
    });
    expect(service.profiles().find((item) => item.id === profile.id)?.workflowPath).toBe(profile.workflowPath);
  });

  it('requires successful validation and preserves model precision and pinned components when adopting a repair', async () => {
    const { service } = setup();
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    service.register({ ...profile, id: 'not-validated' });
    await expect(service.adoptRepairedProfile(requestId, 'not-validated', crypto.randomUUID())).rejects.toThrow(
      'COMFY_INSTALL_VALIDATION_REQUIRED'
    );
    for (const candidate of [
      { ...profile, id: 'changed-precision', quantization: 'FP8' },
      { ...profile, id: 'changed-model', components: [{ ...profile.components[0], version: 'different-model' }] },
    ]) {
      service.register(candidate);
      const job = service.verify(requestId, candidate.id, { prompt: 'test' });
      await service.idle();
      await expect(service.adoptRepairedProfile(requestId, candidate.id, job.id)).rejects.toThrow(
        'COMFY_REPAIR_MODEL_CHANGED'
      );
    }
    expect(service.selection(requestId).profileId).toBe(profile.id);
  });

  it.each(['automatic', 'manual'] as const)(
    'repairs the selected profile from a generation conversation under %s approval',
    async (mode) => {
      const preparePlan = vi.fn(async () => ({ ...plan(), repair: true }));
      const { service, install } = setup({ preparePlan, resolveApproval: async () => ({ mode, runtimeMode: mode }) });
      service.register(profile);
      service.bind({
        requestId,
        conversationId: 'chat',
        profileId: profile.id,
        family: profile.family,
        intent: 'generate',
      });
      const selected = service.selection(requestId);
      const input = { action: 'request', family: profile.family, intent: 'repair' };
      const [first, duplicate] = await Promise.all([
        service.request(requestId, input),
        service.request(requestId, input),
      ]);
      expect(first.id).toBe(duplicate.id);
      expect(first.requestId).not.toBe(requestId);
      expect(first.installRequest).toMatchObject({ profileId: profile.id, intent: 'repair' });
      expect(service.selection(requestId)).toEqual(selected);
      expect(service.operation(first.id, { requestId }).id).toBe(first.id);
      if (mode === 'manual') {
        expect(first.state).toBe('awaiting-consent');
        expect(install).not.toHaveBeenCalled();
        expect(() => service.start(first.id, requestId)).toThrow('COMFY_USER_CONFIRMATION_REQUIRED');
        service.authorize(first.id, 'chat');
        service.start(first.id, requestId);
      }
      await service.idle();
      expect(install).toHaveBeenCalledOnce();
      expect(service.operation(first.id, { requestId }).state).toBe('completed');
      expect(service.selection(requestId)).toEqual(selected);
      expect(service.generate(requestId, profile.id, { prompt: 'original generation' }).profileId).toBe(profile.id);
      await service.idle();
    }
  );

  it('repairs an Agent-chosen model in a plain conversation without requiring a model-card selection', async () => {
    const { service, install } = setup({
      preparePlan: async () => ({ ...plan(), repair: true }),
      resolveApproval: async () => ({ mode: 'automatic', runtimeMode: 'yolo' }),
    });
    service.register(profile);
    const scope = service.conversationInstallationRequest('plain-story');
    const repair = await service.request(scope, {
      action: 'request',
      family: profile.family,
      profileId: profile.id,
      intent: 'repair',
    });
    await service.idle();
    expect(install).toHaveBeenCalledOnce();
    expect(service.operation(repair.id, { conversationId: 'plain-story' }).state).toBe('completed');
    expect(service.selection(scope).profileId).toBeUndefined();
    expect(() => service.operation(repair.id, { conversationId: 'another-story' })).toThrow();
  });

  it('persists the repair relationship and refuses writes after the parent selection changes', async () => {
    const preparePlan = vi.fn(async () => ({ ...plan(), repair: true }));
    const { service, engine, probe, install } = setup({ preparePlan });
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    const repair = await service.request(requestId, { action: 'request', family: profile.family, intent: 'repair' });
    const restarted = new ComfyService({
      filename: path.join(root, 'state.json'),
      engine,
      probe,
      install,
      preparePlan,
    });
    expect(restarted.operation(repair.id, { requestId }).id).toBe(repair.id);
    expect(() => restarted.operation(repair.id, { requestId: crypto.randomUUID() })).toThrow('COMFY_REQUEST_MISMATCH');
    const repeated = await restarted.request(requestId, {
      action: 'request',
      family: profile.family,
      intent: 'repair',
    });
    expect(repeated.id).toBe(repair.id);
    restarted.authorize(repair.id, 'chat');
    restarted.register({ ...profile, id: 'other-profile' });
    restarted.bind({ requestId, conversationId: 'chat', profileId: 'other-profile', intent: 'generate' });
    expect(() => restarted.start(repair.id, requestId)).toThrow('COMFY_SELECTION_CHANGED');
    expect(restarted.operation(repair.id, { requestId }).state).toBe('authorized');
    expect(install).not.toHaveBeenCalled();
  });

  it('does not use same-conversation repair to change family, profile, or a cloud selection', async () => {
    const preparePlan = vi.fn(async () => ({ ...plan(), repair: true }));
    const { service } = setup({ preparePlan });
    service.register(profile);
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    await expect(
      service.request(requestId, { action: 'request', family: 'qwen-edit', intent: 'repair' })
    ).rejects.toThrow('COMFY_FAMILY_MISMATCH');
    await expect(
      service.request(requestId, {
        action: 'request',
        family: profile.family,
        profileId: 'other-profile',
        intent: 'repair',
      })
    ).rejects.toThrow('COMFY_PROFILE_ID_MISMATCH');
    service.bind({ requestId, conversationId: 'chat', family: profile.family, source: 'cloud', intent: 'generate' });
    await expect(
      service.request(requestId, { action: 'request', family: profile.family, intent: 'repair' })
    ).rejects.toThrow('COMFY_FAMILY_MISMATCH');
    expect(preparePlan).not.toHaveBeenCalled();
  });

  it('accepts a new repair intent after a completed installation without confusing the old operation', async () => {
    const preparePlan = vi.fn(async () => plan());
    const { service } = setup({ preparePlan });
    const first = await service.request(requestId, { action: 'request', family: 'z-image', intent: 'install' });
    service.authorize(first.id, 'chat');
    service.start(first.id, requestId);
    await service.idle();
    const repairRequestId = '22222222-2222-4222-8222-222222222222';
    service.bind({
      requestId: repairRequestId,
      conversationId: 'chat',
      family: 'z-image',
      profileId: profile.id,
      intent: 'repair',
      source: 'local',
    });
    preparePlan.mockResolvedValueOnce({ ...plan(), repair: true });
    const repair = await service.request(repairRequestId, {
      action: 'request',
      family: 'z-image',
      profileId: profile.id,
      intent: 'repair',
    });
    expect(repair.id).not.toBe(first.id);
    expect(repair.installRequest?.intent).toBe('repair');
    expect(repair.requestId).not.toBe(first.requestId);
  });
  it('stops recovery after two differing failures and persists that limit', async () => {
    const { service, install, probe, engine } = setup();
    const operation = await service.request(requestId, plan());
    install.mockRejectedValueOnce(new Error('NETWORK_TIMEOUT'));
    service.authorize(operation.id, 'chat');
    service.start(operation.id, requestId);
    await service.idle();
    for (const error of ['DEPENDENCY_MISSING', 'RUNTIME_START_FAILED']) {
      install.mockRejectedValueOnce(new Error(error));
      service.recoverInstallation(operation.id, requestId);
      await service.idle();
    }
    const restarted = new ComfyService({ filename: path.join(root, 'state.json'), engine, install, probe });
    expect(() => restarted.recoverInstallation(operation.id, requestId)).toThrow('COMFY_REPEATED_ERROR_REPLAN');
    expect(install).toHaveBeenCalledTimes(3);
  });
  it('keeps the operation, approval and artifact identity when repairing failed download transports', async () => {
    profile.components[0] = {
      ...profile.components[0],
      sha256: 'a'.repeat(64),
      sizeBytes: 120,
      url: 'https://huggingface.co/Org/Model/resolve/old/z',
    };
    const { service, install } = setup();
    const operation = await service.request(requestId, plan());
    install.mockRejectedValueOnce(new Error('NETWORK_TIMEOUT'));
    service.authorize(operation.id, 'chat');
    service.start(operation.id, requestId);
    await service.idle();
    const before = service.operation(operation.id, { requestId });
    const recovered = service.recoverInstallation(operation.id, requestId, [
      { component: 'z', urls: ['https://modelscope.cn/Org/Model/resolve/new/z'] },
    ]);
    expect(recovered.id).toBe(operation.id);
    expect(recovered.approval).toEqual(before.approval);
    expect(recovered.plan.components[0]).toMatchObject({
      sha256: 'a'.repeat(64),
      sizeBytes: 120,
      path: profile.components[0].path,
      url: 'https://modelscope.cn/Org/Model/resolve/new/z',
    });
    await service.idle();
    expect(service.operation(operation.id, { requestId }).state).toBe('completed');
    expect(service.activity('chat').operations).toHaveLength(1);
  });
  it('allows a materially new source after a repeated preparation error within the two-retry budget', async () => {
    const preparePlan = vi.fn(async () => {
      throw new Error('COMFY_SOURCE_UNREACHABLE:z');
    });
    const { service } = setup({ preparePlan });
    const input = { action: 'request', family: 'z-image', intent: 'install' };
    await expect(service.request(requestId, input)).rejects.toThrow('COMFY_SOURCE_UNREACHABLE');
    await expect(service.request(requestId, input)).rejects.toThrow('COMFY_SOURCE_UNREACHABLE');
    await expect(
      service.request(requestId, {
        ...input,
        sourceOverrides: [{ component: 'z', urls: ['https://modelscope.cn/Org/Model/resolve/new/z'] }],
      })
    ).rejects.toThrow('COMFY_SOURCE_UNREACHABLE');
    await expect(service.request(requestId, input)).rejects.toThrow('COMFY_REPEATED_ERROR_REPLAN');
    expect(service.activity('chat').preparations[0].attempts).toBe(3);
  });
  it('bounds failed preparation across restarts instead of leaving retry control only in the prompt', async () => {
    const preparePlan = vi.fn(async () => {
      throw new Error('NETWORK_TIMEOUT');
    });
    const { service, engine, install, probe } = setup({ preparePlan });
    const input = { action: 'request', family: 'z-image', intent: 'install' };
    await expect(service.request(requestId, input)).rejects.toThrow('NETWORK_TIMEOUT');
    await expect(service.request(requestId, input)).rejects.toThrow('NETWORK_TIMEOUT');
    const restarted = new ComfyService({
      filename: path.join(root, 'state.json'),
      engine,
      install,
      probe,
      preparePlan,
    });
    await expect(restarted.request(requestId, input)).rejects.toThrow('COMFY_REPEATED_ERROR_REPLAN');
    expect(preparePlan).toHaveBeenCalledTimes(2);
  });

  it('recovers an authorized failed install on the same operation with a persisted bounded budget', async () => {
    const { service, install, probe, engine } = setup();
    const operation = await service.request(requestId, plan());
    install.mockRejectedValueOnce(new Error('NETWORK_TIMEOUT'));
    service.authorize(operation.id, 'chat');
    service.start(operation.id, requestId);
    await service.idle();
    expect(service.operation(operation.id, { requestId }).state).toBe('failed');
    const restarted = new ComfyService({ filename: path.join(root, 'state.json'), engine, install, probe });
    expect(restarted.recoverInstallation(operation.id, requestId)).toMatchObject({
      id: operation.id,
      state: 'running',
      recoveryAttempts: 1,
    });
    await restarted.idle();
    expect(restarted.operation(operation.id, { requestId }).state).toBe('completed');
    expect(restarted.activity('chat').operations).toHaveLength(1);
  });

  it('does not let recovery authorize a new plan or bypass integrity failures', async () => {
    const { service, install } = setup();
    const operation = await service.request(requestId, plan());
    expect(() => service.recoverInstallation(operation.id, requestId)).toThrow('COMFY_USER_CONFIRMATION_REQUIRED');
    install.mockRejectedValueOnce(new Error('COMFY_HASH_MISMATCH'));
    service.authorize(operation.id, 'chat');
    service.start(operation.id, requestId);
    await service.idle();
    expect(() => service.recoverInstallation(operation.id, requestId)).toThrow('COMFY_RECOVERY_BLOCKED');
    expect(install).toHaveBeenCalledOnce();
  });

  it('defers app replacement when saved remote activity cannot be recovered', () => {
    fs.writeFileSync(path.join(root, 'state.json'), '{broken');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(setup().service.updateIdle()).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('defers app replacement for a failed job with unconfirmed remote submission', () => {
    const { service } = setup();
    service.register(profile);
    const filename = path.join(root, 'state.json');
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    saved.jobs.push({
      id: '33333333-3333-4333-8333-333333333333',
      requestId,
      profile,
      input: { prompt: 'test' },
      status: 'failed',
      submissionUncertain: true,
    });
    fs.writeFileSync(filename, JSON.stringify(saved));
    expect(setup().service.updateIdle()).toBe(false);
  });
  it('keeps app replacement blocked throughout generation', async () => {
    let finish!: (value: { promptId: string; artifacts: { path: string; mimeType: string }[] }) => void;
    const { service, engine } = setup();
    service.register(profile);
    service.bind({
      requestId,
      conversationId: 'chat',
      family: 'z-image',
      intent: 'generate',
      source: 'local',
      profileId: profile.id,
    });
    expect(service.updateIdle()).toBe(true);
    engine.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    service.generate(requestId, profile.id, { prompt: 'test' });
    expect(service.updateIdle()).toBe(false);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish({ promptId: 'prompt', artifacts: [{ path: path.join(root, 'out.png'), mimeType: 'image/png' }] });
    await service.idle();
    expect(service.updateIdle()).toBe(true);
  });
  it('round-trips the original template revision on each submitted job, independent of later selection and restart', async () => {
    const { service, engine, install, probe } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'smoke' });
    const snapshot = {
      templateId: 'official:test',
      templateRevision: 1,
      releaseSequence: 2,
      locale: 'en-US',
      title: 'Title',
      prompt: 'Original prompt',
      parameters: { width: 768 },
      requiresReference: false,
    };
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: 'z-image',
      intent: 'generate',
      templateSnapshot: snapshot,
    });
    const job = service.generate(requestId, profile.id, { prompt: 'Edited prompt' });
    snapshot.parameters.width = 1;
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: 'z-image',
      intent: 'generate',
      templateSnapshot: { ...snapshot, templateRevision: 2 },
    });
    await service.idle();
    expect(service.job(job.id, { requestId }).templateSnapshot?.templateRevision).toBe(1);
    const restarted = new ComfyService({ filename: path.join(root, 'state.json'), engine, install, probe });
    expect(restarted.job(job.id, { requestId }).templateSnapshot).toEqual({ ...snapshot, parameters: { width: 768 } });
  });

  it('does not recover valid state as corrupt when constructor persistence stays locked', () => {
    const { service, engine, install, probe } = setup();
    service.register(profile);
    const filename = path.join(root, 'state.json');
    const previous = fs.readFileSync(filename, 'utf8');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const failure = Object.assign(new Error('cannot replace valid state'), { code: 'EPERM' });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw failure;
    });
    const recoveryLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(() => new ComfyService({ filename, engine, install, probe })).toThrow(failure);
      expect(rename).toHaveBeenCalledTimes(6);
      expect(recoveryLog).not.toHaveBeenCalled();
      expect(fs.readFileSync(filename, 'utf8')).toBe(previous);
      expect(fs.readdirSync(root)).toEqual(['state.json']);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      rename.mockRestore();
      recoveryLog.mockRestore();
    }
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'persists profiles after a transient Windows %s without deleting prior state',
    (code) => {
      const { service } = setup();
      const filename = path.join(root, 'state.json');
      const previous = fs.readFileSync(filename, 'utf8');
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        expect(fs.readFileSync(filename, 'utf8')).toBe(previous);
        throw Object.assign(new Error('temporarily locked'), { code });
      });
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        service.register(profile);
        expect(rename.mock.calls.length).toBeGreaterThanOrEqual(2);
        const { validation: _validation, ...downloaded } = profile;
        expect(JSON.parse(fs.readFileSync(filename, 'utf8')).profiles).toEqual([
          { ...downloaded, state: 'downloaded' },
        ]);
        expect(fs.readdirSync(root)).toEqual(['state.json']);
      } finally {
        Object.defineProperty(process, 'platform', platform);
        rename.mockRestore();
      }
    }
  );

  it.each([
    ['win32', 'EPERM', 6],
    ['win32', 'ENOSPC', 1],
    ['linux', 'EPERM', 1],
  ] as const)(
    'bounds %s %s replacement retries and leaves committed profiles intact',
    (platformName, code, attempts) => {
      const { service } = setup();
      const filename = path.join(root, 'state.json');
      const previous = fs.readFileSync(filename, 'utf8');
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      const failure = Object.assign(new Error('cannot replace state'), { code });
      const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw failure;
      });
      Object.defineProperty(process, 'platform', { value: platformName, configurable: true });
      try {
        expect(() => service.register(profile)).toThrow(failure);
        expect(rename).toHaveBeenCalledTimes(attempts);
        expect(fs.readFileSync(filename, 'utf8')).toBe(previous);
        expect(fs.readdirSync(root)).toEqual(['state.json']);
      } finally {
        Object.defineProperty(process, 'platform', platform);
        rename.mockRestore();
      }
    }
  );
  it.each(
    comfyFamilySchema.options.flatMap((family) =>
      ['install', 'repair', 'install-other'].map((intent) => ({ family, intent }))
    )
  )(
    'automatically starts the $family $intent plan when the active session approves all operations',
    async ({ family, intent }) => {
      profile.family = family;
      profile.kind = comfyFamilyKind(family);
      const resolveApproval = vi.fn(async () => ({ mode: 'automatic' as const, runtimeMode: 'yolo' }));
      const { service, install } = setup({ resolveApproval });
      service.bind({ requestId, conversationId: 'chat', family, intent, source: 'local', kind: profile.kind });
      const operation = await service.request(requestId, { ...plan(), repair: intent === 'repair' });
      expect(operation.state).toBe('running');
      expect(operation.approval).toMatchObject({ mode: 'automatic', runtimeMode: 'yolo' });
      expect(resolveApproval).toHaveBeenCalledWith('chat');
      await service.idle();
      expect(install).toHaveBeenCalledTimes(1);
      expect(service.operation(operation.id, { requestId }).state).toBe('completed');
      await service.close();
    }
  );

  it('builds the immutable plan in the media service for an identity-only request', async () => {
    const preparePlan = vi.fn(async (_id: string, request: { family: string; intent: string }) => {
      expect(request).toMatchObject({ family: 'z-image', intent: 'install', profileId: 'z-bf16' });
      return plan();
    });
    const { service, install } = setup({
      preparePlan,
      resolveApproval: async () => ({ mode: 'automatic', runtimeMode: 'yolo' }),
    });
    const operation = await service.request(requestId, {
      action: 'request',
      family: 'z-image',
      intent: 'install',
      profileId: 'z-bf16',
    });
    expect(preparePlan).toHaveBeenCalledOnce();
    expect(operation.plan.id).toBe('z-bf16');
    await service.idle();
    expect(install).toHaveBeenCalledOnce();
    await service.close();
  });

  it('coalesces identity requests before planning and reuses the saved operation after restart', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparePlan = vi.fn(async () => {
      await waiting;
      return plan();
    });
    const { service, engine, install, probe } = setup({ preparePlan });
    const identity = { action: 'request', family: 'z-image', intent: 'install', requestId } as const;
    const first = service.request(requestId, identity);
    const second = service.request(requestId, identity);
    await expect(service.request(requestId, { ...identity, profileId: 'other-variant' })).rejects.toThrow(
      'COMFY_INSTALL_REQUEST_ID_CONFLICT'
    );
    await expect(
      service.request(requestId, {
        ...identity,
        sourceOverrides: [{ component: 'weights.safetensors', urls: ['https://hf-mirror.com/repo/file'] }],
      })
    ).rejects.toThrow('COMFY_INSTALL_REQUEST_ID_CONFLICT');
    expect(preparePlan).toHaveBeenCalledOnce();
    expect(service.activity('chat').preparations).toMatchObject([{ requestId, status: 'detecting' }]);
    const interrupted = new ComfyService({ filename: path.join(root, 'state.json'), engine, install, probe });
    expect(interrupted.activity('chat').preparations).toMatchObject([{ requestId, status: 'interrupted' }]);
    expect(install).not.toHaveBeenCalled();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    expect(service.activity('chat').preparations).toEqual([]);
    expect(probe).toHaveBeenCalledOnce();
    service.cancelOperation(a.id, { requestId });
    const restarted = new ComfyService({
      filename: path.join(root, 'state.json'),
      engine,
      install,
      probe,
      preparePlan,
    });
    const recovered = await restarted.request(requestId, identity);
    expect(recovered).toMatchObject({ id: a.id, state: 'cancelled' });
    expect(preparePlan).toHaveBeenCalledOnce();
    await expect(restarted.request(requestId, { ...identity, profileId: 'different' })).rejects.toThrow(
      'COMFY_INSTALL_REQUEST_ID_CONFLICT'
    );
    expect(install).not.toHaveBeenCalled();
    await restarted.close();
    await service.close();
  });

  it('persists the bound install directory and does not reuse an operation for a different directory', async () => {
    const preparePlan = vi.fn(async () => plan());
    const { service, probe } = setup({ preparePlan });
    const installContext = {
      installDirectory: path.join(root, 'selected-models'),
      checkedAt: new Date().toISOString(),
      candidateId: 'z-image-bf16',
    };
    service.bind({ ...service.selection(requestId), installContext });
    const request = { action: 'request', family: 'z-image', intent: 'install' } as const;
    const operation = await service.request(requestId, request);
    expect(preparePlan).toHaveBeenCalledWith(
      requestId,
      expect.objectContaining({ installContext }),
      expect.any(Array),
      undefined
    );
    expect(operation.installRequest?.installContext).toEqual(installContext);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ installDirectory: operation.plan.targetRoot }));
    service.bind({
      ...service.selection(requestId),
      installContext: { ...installContext, installDirectory: path.join(root, 'another-directory') },
    });
    await expect(service.request(requestId, request)).rejects.toThrow('COMFY_INSTALL_REQUEST_ID_CONFLICT');
    expect(preparePlan).toHaveBeenCalledOnce();
    await service.close();
  });

  it('persists precise detection failures before an installation operation can be constructed', async () => {
    const preparePlan = vi.fn(async () => {
      throw new Error('COMFY_DETECTION_INCOMPLETE:gpu-driver');
    });
    const { service, engine, install, probe } = setup({ preparePlan });
    await expect(
      service.request(requestId, { action: 'request', family: 'z-image', intent: 'install' })
    ).rejects.toThrow('COMFY_DETECTION_INCOMPLETE:gpu-driver');
    const restarted = new ComfyService({ filename: path.join(root, 'state.json'), engine, install, probe });
    expect(restarted.activity('chat').preparations).toMatchObject([
      {
        requestId,
        status: 'failed',
        error: 'COMFY_DETECTION_INCOMPLETE:gpu-driver',
      },
    ]);
    expect(restarted.activity('chat').operations).toEqual([]);
    expect(install).not.toHaveBeenCalled();
    await restarted.close();
    await service.close();
  });

  it('does not publish a plan if the selection changes while environment detection is pending', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparePlan = vi.fn(async () => {
      await waiting;
      return plan();
    });
    const { service } = setup({ preparePlan });
    const pending = service.request(requestId, { action: 'request', family: 'z-image', intent: 'install' });
    service.bind({ requestId, conversationId: 'chat', family: 'qwen-edit', intent: 'install', source: 'local' });
    release();
    await expect(pending).rejects.toThrow('COMFY_SELECTION_CHANGED');
    expect(service.activity('chat').operations).toHaveLength(0);
    await service.close();
  });

  it('refreshes discovered profiles once for concurrent readers without granting or erasing verification', async () => {
    const discovery = vi.fn(async () => [profile]);
    const { service } = setup({ discover: discovery });
    const [first, second] = await Promise.all([service.refreshProfiles(), service.refreshProfiles()]);
    expect(discovery).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
    expect(first[0].state).toBe('downloaded');
    await service.revalidate(profile.id, { prompt: 'smoke' });
    expect((await service.refreshProfiles())[0].state).toBe('verified');
    await service.close();
  });

  it('retains scoped completed operations and jobs for the work progress panel', async () => {
    const { service } = setup({ resolveApproval: async () => ({ mode: 'automatic' }) });
    const operation = await service.request(requestId, { action: 'plan', plan: plan() });
    await service.idle();
    expect(service.activity('chat').operations).toMatchObject([{ id: operation.id, state: 'completed' }]);
    expect(service.activity('other')).toEqual({ operations: [], jobs: [], preparations: [] });
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: 'z-image',
      intent: 'generate',
      source: 'local',
    });
    const job = service.generate(requestId, profile.id, { prompt: 'sphere' });
    await service.idle();
    expect(service.activity('chat').jobs).toMatchObject([{ id: job.id, status: 'succeeded' }]);
    await service.close();
  });

  it('does not accept an automatic-approval claim from the model or the request binding', async () => {
    const { service, install } = setup({ resolveApproval: async () => ({ mode: 'manual' }) });
    service.bind({
      requestId,
      conversationId: 'chat',
      family: 'z-image',
      intent: 'install',
      approvalMode: 'automatic',
    });
    const operation = await service.request(requestId, { ...plan(), approvalMode: 'automatic' });
    expect(operation.state).toBe('awaiting-consent');
    expect(install).not.toHaveBeenCalled();
    await service.close();
  });

  it('keeps an unexecutable permission lookup reviewable and reports its diagnostic code', async () => {
    const { service, install } = setup({
      resolveApproval: async () => {
        throw new Error('private response');
      },
    });
    const operation = await service.request(requestId, plan());
    expect(operation.state).toBe('awaiting-consent');
    expect(operation.error).toBe('COMFY_APPROVAL_MODE_UNAVAILABLE');
    expect(install).not.toHaveBeenCalled();
    expect(JSON.stringify(operation)).not.toContain('private response');
    await service.close();
  });

  it('deduplicates concurrent automatic requests before probing or creating an installation', async () => {
    const { service, install, probe } = setup({
      resolveApproval: async () => ({ mode: 'automatic', runtimeMode: 'yolo' }),
    });
    const operations = await Promise.all([service.request(requestId, plan()), service.request(requestId, plan())]);
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(1);
    await service.idle();
    expect(install).toHaveBeenCalledTimes(1);
    // One planning probe and one pre-execution probe.
    expect(probe).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it('uses a newly observed automatic mode to continue the same previously unapproved plan', async () => {
    const resolveApproval = vi.fn(async () => ({ mode: 'manual' as 'manual' | 'automatic', runtimeMode: 'default' }));
    const { service, install } = setup({ resolveApproval });
    const pending = await service.request(requestId, plan());
    resolveApproval.mockResolvedValue({ mode: 'automatic', runtimeMode: 'yolo' });
    const continued = await service.request(requestId, plan());
    expect(continued.id).toBe(pending.id);
    expect(continued.state).toBe('running');
    await service.idle();
    expect(install).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it('does not retry a failed automatic installation just because its request is repeated', async () => {
    const { service, install } = setup({ resolveApproval: async () => ({ mode: 'automatic', runtimeMode: 'yolo' }) });
    install.mockRejectedValueOnce(new Error('COMFY_COMPONENT_HASH_MISMATCH'));
    const initial = await service.request(requestId, plan());
    await service.idle();
    const repeated = await service.request(requestId, plan());
    expect(repeated.id).toBe(initial.id);
    expect(repeated.state).toBe('failed');
    expect(install).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it('drains pending approval lookups when closing and never starts their installations', async () => {
    let reached!: () => void;
    let finish!: (value: { mode: 'automatic'; runtimeMode: string }) => void;
    const lookupStarted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { service, install, engine } = setup({
      resolveApproval: async () => {
        reached();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const pending = service.request(requestId, plan());
    await lookupStarted;
    const closing = service.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.stopOwned).not.toHaveBeenCalled();
    finish({ mode: 'automatic', runtimeMode: 'yolo' });
    await expect(pending).rejects.toThrow('COMFY_SERVICE_STOPPING');
    await closing;
    expect(install).not.toHaveBeenCalled();
    expect(engine.stopOwned).toHaveBeenCalledTimes(1);
  });

  it('keeps planning separate from execution and requires UI consent for this conversation', async () => {
    const { service, install } = setup();
    const operation = await service.request(requestId, plan());
    expect(operation.state).toBe('awaiting-consent');
    expect(install).not.toHaveBeenCalled();
    expect(() => service.start(operation.id, requestId)).toThrow('COMFY_USER_CONFIRMATION_REQUIRED');
    expect(() => service.authorize(operation.id, 'other-chat')).toThrow('COMFY_CONVERSATION_MISMATCH');
    service.authorize(operation.id, 'chat');
    service.start(operation.id, requestId);
    service.start(operation.id, requestId);
    await service.idle();
    expect(install).toHaveBeenCalledTimes(1);
    expect(service.operation(operation.id, { requestId }).state).toBe('completed');
    expect(service.selection(requestId).profileId).toBe(profile.id);
  });
  it('never trusts externally claimed verification and requires load + generation validation', async () => {
    const { service, engine } = setup();
    expect(service.register(profile).state).toBe('downloaded');
    expect(service.profiles()[0].validation).toBeUndefined();
    const verified = await service.revalidate(profile.id, { prompt: 'red sphere' });
    expect(engine.generate).toHaveBeenCalledTimes(1);
    expect(verified.state).toBe('verified');
    engine.snapshotFingerprint.mockResolvedValue('changed');
    await expect(service.refreshProfiles()).resolves.toMatchObject([{ state: 'invalid' }]);
  });
  it('keeps discovered invalid profiles unavailable while dropping any claimed validation proof', () => {
    const { service } = setup();
    expect(
      service.register({
        ...profile,
        state: 'invalid',
        validation: { ...profile.validation, error: 'COMFY_WORKFLOW_HASH_MISMATCH' },
      })
    ).toMatchObject({
      state: 'invalid',
      validation: { fingerprint: '', error: 'COMFY_WORKFLOW_HASH_MISMATCH' },
    });
    expect(service.profiles()[0].validation?.promptId).toBeUndefined();
  });
  it('retains multiple versions and freezes submitted jobs when a selection changes', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'test' });
    const other = { ...profile, id: 'z-int8', quantization: 'INT8' };
    service.register(other);
    await service.revalidate(other.id, { prompt: 'test' });
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, family: 'z-image', intent: 'generate' });
    const job = service.generate(requestId, profile.id, { prompt: 'requested generation' });
    service.bind({ requestId, conversationId: 'chat', profileId: other.id, family: 'z-image', intent: 'generate' });
    await service.idle();
    expect(service.job(job.id, { requestId }).profileId).toBe(profile.id);
    expect(engine.generate.mock.calls.at(-1)?.[0]).toMatchObject({ id: profile.id, quantization: 'BF16' });
    expect(() => service.generate(requestId, profile.id, { prompt: 'next' })).toThrow('COMFY_SELECTION_CHANGED');
    expect(service.profiles()).toHaveLength(2);
  });
  it('rejects incomplete probes, wrong families, empty smoke outputs, and changed profile identities', async () => {
    const { service, probe, engine } = setup();
    probe.mockResolvedValueOnce({
      ...(await probe()),
      machine: { ...(await probe()).machine, gpuStatus: 'unknown', gpus: [] },
    });
    await expect(service.request(requestId, plan())).rejects.toThrow('COMFY_DETECTION_INCOMPLETE');
    await expect(service.request(requestId, { ...plan(), family: 'qwen-edit' })).rejects.toThrow(
      'COMFY_FAMILY_MISMATCH'
    );
    service.register(profile);
    expect(() => service.register({ ...profile, version: 'new' })).toThrow('COMFY_PROFILE_ID_CONFLICT');
    engine.generate.mockResolvedValueOnce({ promptId: 'empty', artifacts: [] });
    await expect(service.revalidate(profile.id, { prompt: 'test' })).rejects.toThrow('COMFY_SMOKE_OUTPUT_MISSING');
    expect(service.profiles()[0].state).toBe('invalid');
  });
  it('persists consent and completed profiles across restarts without executing at startup', async () => {
    const { service, engine, install, probe } = setup();
    const operation = await service.request(requestId, plan());
    service.authorize(operation.id, 'chat');
    const restored = new ComfyService({ filename: path.join(root, 'state.json'), engine, install, probe });
    expect(restored.operation(operation.id, { requestId }).state).toBe('authorized');
    expect(install).not.toHaveBeenCalled();
    restored.start(operation.id, requestId);
    await restored.idle();
    const again = new ComfyService({ filename: path.join(root, 'state.json'), engine, install, probe });
    expect(again.profiles()[0].state).toBe('verified');
    expect(install).toHaveBeenCalledTimes(1);
  });
  it('stops cancelled plans before a queued executor runs and keeps consent scoped', async () => {
    const { service, install } = setup();
    const operation = await service.request(requestId, plan());
    service.authorize(operation.id, 'chat');
    service.start(operation.id, requestId);
    service.cancelOperation(operation.id, { requestId });
    await service.idle();
    expect(install).not.toHaveBeenCalled();
    expect(service.operation(operation.id, { requestId }).state).toBe('cancelled');
    expect(() => service.bind({ requestId, conversationId: 'another', family: 'h3' })).toThrow(
      'COMFY_CONVERSATION_MISMATCH'
    );
  });
  it('does not invalidate a verified profile solely because its service is stopped', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'test' });
    engine.snapshotFingerprint.mockRejectedValueOnce(new Error('COMFY_SERVER_UNAVAILABLE'));
    expect((await service.refreshProfiles())[0].state).toBe('verified');
  });
  it.each([
    { family: 'z-image', kind: 'image', extension: 'png' },
    { family: 'h3', kind: 'video', extension: 'mp4' },
  ] as const)(
    'validates every generated $kind even after the profile is verified',
    async ({ family, kind, extension }) => {
      const verifyArtifact = vi.fn(async (): Promise<void> => undefined);
      const { service, engine } = setup({ verifyArtifact });
      profile.family = family;
      profile.kind = kind;
      profile.capabilities = [`text-to-${kind}`];
      const artifact = { path: path.join(root, `out.${extension}`), mimeType: `${kind}/${extension}` };
      engine.generate.mockResolvedValue({ promptId: 'prompt', artifacts: [artifact] });
      service.register(profile);
      await service.revalidate(profile.id, { prompt: 'smoke' });
      expect(service.profiles()[0].state).toBe('verified');
      verifyArtifact.mockClear();
      service.bind({ requestId, conversationId: 'chat', profileId: profile.id, family, intent: 'generate' });
      const input = { prompt: 'A deliberately still black frame', width: 96, height: 64 };
      const job = service.generate(requestId, profile.id, input);
      await service.idle();
      expect(verifyArtifact).toHaveBeenCalledExactlyOnceWith(
        artifact,
        kind,
        expect.any(AbortSignal),
        expect.objectContaining({ input, mode: 'generation' })
      );
      expect(service.job(job.id, { requestId })).toMatchObject({ status: 'succeeded', artifacts: [artifact] });
    }
  );
  it.each([
    { family: 'z-image', kind: 'image', extension: 'png' },
    { family: 'h3', kind: 'video', extension: 'mp4' },
  ] as const)(
    'does not report an invalid later $kind as successful for a verified profile',
    async ({ family, kind, extension }) => {
      const verifyArtifact = vi.fn(async (): Promise<void> => undefined);
      const { service, engine, install } = setup({ verifyArtifact });
      profile.family = family;
      profile.kind = kind;
      profile.capabilities = [`text-to-${kind}`];
      engine.generate.mockResolvedValue({
        promptId: 'prompt',
        artifacts: [{ path: path.join(root, `out.${extension}`), mimeType: `${kind}/${extension}` }],
      });
      service.register(profile);
      await service.revalidate(profile.id, { prompt: 'smoke' });
      verifyArtifact.mockClear();
      engine.generate.mockClear();
      const failure = `COMFY_SMOKE_${kind.toUpperCase()}_INVALID`;
      verifyArtifact.mockRejectedValueOnce(new Error(failure));
      service.bind({ requestId, conversationId: 'chat', profileId: profile.id, family, intent: 'generate' });
      const job = service.generate(requestId, profile.id, { prompt: 'A new requested result' });
      await service.idle();
      expect(verifyArtifact).toHaveBeenCalledOnce();
      expect(service.job(job.id, { requestId })).toMatchObject({
        status: 'failed',
        error: failure,
        submissionUncertain: false,
        artifacts: [],
      });
      expect(engine.generate).toHaveBeenCalledOnce();
      expect(install).not.toHaveBeenCalled();
    }
  );
  it('validates an existing downloaded model with the requested generation instead of installing it', async () => {
    const verifyArtifact = vi.fn(async () => undefined);
    const { service, engine, install } = setup({ verifyArtifact });
    service.register(profile);
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: profile.family,
      intent: 'generate',
    });
    const input = { prompt: 'A cup on a wooden table', seed: 42 };
    const job = service.generate(requestId, profile.id, input);
    expect(service.generate(requestId, profile.id, input).id).toBe(job.id);
    expect(service.profiles()[0].state).not.toBe('verified');
    await service.idle();
    expect(install).not.toHaveBeenCalled();
    expect(engine.validate).toHaveBeenCalledOnce();
    expect(engine.generate).toHaveBeenCalledOnce();
    expect(engine.generate.mock.calls[0][1]).toEqual(input);
    expect(verifyArtifact).toHaveBeenCalledWith(
      expect.anything(),
      'image',
      expect.any(AbortSignal),
      expect.objectContaining({ mode: 'generation', input })
    );
    expect(service.job(job.id, { requestId })).not.toHaveProperty('validationMode');
    expect(service.job(job.id, { requestId })).toMatchObject({
      status: 'succeeded',
      artifacts: [{ mimeType: 'image/png' }],
    });
    expect(service.profiles()[0].state).toBe('verified');
  });
  it('keeps a failed generation validation unavailable without creating an installation', async () => {
    const { service, engine, install } = setup();
    service.register(profile);
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: profile.family,
      intent: 'generate',
    });
    engine.validate.mockRejectedValueOnce(new Error('COMFY_SERVER_ENVIRONMENT_MISMATCH'));
    const job = service.generate(requestId, profile.id, { prompt: 'test' });
    await service.idle();
    expect(service.job(job.id, { requestId })).toMatchObject({
      status: 'failed',
      error: 'COMFY_SERVER_ENVIRONMENT_MISMATCH',
    });
    expect(engine.generate).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(service.profiles()[0].state).not.toBe('verified');
  });
  it('does not mark first generation verified when its returned media cannot be validated', async () => {
    const { service, engine, install } = setup({
      verifyArtifact: async () => {
        throw new Error('COMFY_SMOKE_OUTPUT_INVALID');
      },
    });
    engine.generate.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as (id: string) => void)('invalid-media-prompt');
      return {
        promptId: 'invalid-media-prompt',
        artifacts: [{ path: path.join(root, 'out.png'), mimeType: 'image/png' }],
      };
    });
    service.register(profile);
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: profile.family,
      intent: 'generate',
    });
    const job = service.generate(requestId, profile.id, { prompt: 'test' });
    await service.idle();
    expect(service.job(job.id, { requestId })).toMatchObject({
      status: 'failed',
      error: 'COMFY_SMOKE_OUTPUT_INVALID',
      submissionUncertain: false,
    });
    expect(service.profiles()[0].state).not.toBe('verified');
    expect(install).not.toHaveBeenCalled();
    expect(service.generate(requestId, profile.id, { prompt: 'test' }).id).not.toBe(job.id);
    await service.idle();
  });
  it('resumes a first-generation validation after restart without submitting or installing again', async () => {
    const { service, engine, install, probe } = setup();
    service.register(profile);
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: profile.family,
      intent: 'generate',
    });
    engine.generate.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as (id: string) => void)('first-prompt');
      throw new Error('COMFY_HISTORY_UNAVAILABLE');
    });
    const input = { prompt: 'keep the original request', seed: 99 };
    const job = service.generate(requestId, profile.id, input);
    await service.idle();
    expect(service.generate(requestId, profile.id, input).id).toBe(job.id);
    expect(service.job(job.id, { requestId })).toMatchObject({ status: 'running', promptId: 'first-prompt' });
    await service.close();
    engine.resume.mockResolvedValueOnce({
      promptId: 'first-prompt',
      artifacts: [{ path: path.join(root, 'out.png'), mimeType: 'image/png' }],
    });
    const verifyArtifact = vi.fn(async () => undefined);
    const restarted = new ComfyService({
      filename: path.join(root, 'state.json'),
      engine,
      install,
      probe,
      verifyArtifact,
    });
    restarted.recoverJobs();
    await restarted.idle();
    expect(engine.generate).toHaveBeenCalledOnce();
    expect(engine.resume).toHaveBeenCalledOnce();
    expect(restarted.job(job.id, { requestId }).status).toBe('succeeded');
    expect(restarted.profiles()[0].state).toBe('verified');
    expect(verifyArtifact).toHaveBeenCalledWith(
      expect.anything(),
      'image',
      expect.any(AbortSignal),
      expect.objectContaining({ mode: 'generation', input })
    );
    expect(install).not.toHaveBeenCalled();
    await restarted.close();
  });
  it('stores a submitted prompt and resumes it without duplicating generation after restart', async () => {
    const { service, engine, install, probe } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'test' });
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: profile.family,
      intent: 'generate',
    });
    let submitted: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    engine.generate.mockImplementationOnce(async (_profile, _input, _signal, _progress, onSubmitted) => {
      onSubmitted?.('durable-prompt');
      submitted?.();
      return new Promise(() => undefined);
    });
    const job = service.generate(requestId, profile.id, { prompt: 'test' });
    await reached;
    engine.resume.mockResolvedValue({
      promptId: 'durable-prompt',
      artifacts: [{ path: path.join(root, 'resume.png'), mimeType: 'image/png' }],
    });
    const verifyArtifact = vi.fn(async (): Promise<void> => undefined);
    const restored = new ComfyService({
      filename: path.join(root, 'state.json'),
      engine,
      install,
      probe,
      verifyArtifact,
    });
    restored.recoverJobs();
    await restored.idle();
    expect(engine.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: profile.id }),
      'durable-prompt',
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect(restored.job(job.id, { requestId }).status).toBe('succeeded');
    expect(engine.generate).toHaveBeenCalledTimes(2);
    expect(verifyArtifact).toHaveBeenCalledExactlyOnceWith(
      { path: path.join(root, 'resume.png'), mimeType: 'image/png' },
      'image',
      expect.any(AbortSignal),
      expect.objectContaining({ mode: 'generation' })
    );
  });
  it('runs explicit validation jobs in the same queue and never generates during installation intent', async () => {
    const verifyArtifact = vi.fn(async () => undefined);
    const { service } = setup({ verifyArtifact });
    service.register(profile);
    const job = service.verify(requestId, profile.id, { prompt: 'smoke' });
    expect(service.verify(requestId, profile.id, { prompt: 'smoke' }).id).toBe(job.id);
    await service.idle();
    expect(service.job(job.id, { requestId }).status).toBe('succeeded');
    expect(service.profiles()[0].state).toBe('verified');
    expect(verifyArtifact).toHaveBeenCalledWith(
      expect.anything(),
      'image',
      expect.any(AbortSignal),
      expect.objectContaining({ mode: 'smoke' })
    );
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: profile.family,
      intent: 'install',
    });
    expect(() => service.generate(requestId, profile.id, { prompt: 'test' })).toThrow(
      'COMFY_GENERATION_INTENT_REQUIRED'
    );
  });
  it('clears memory after terminal OOM then retries once with the original profile and input', async () => {
    const { service, engine } = setup();
    profile = {
      ...profile,
      bindings: {
        ...profile.bindings,
        width: [{ nodeId: '2', input: 'width' }],
        height: [{ nodeId: '2', input: 'height' }],
      },
      defaults: { width: 1024, height: 1024 },
      memoryPolicy: {
        minWidth: 512,
        minHeight: 512,
        dimensionStep: 64,
        evidence: 'Small canvas validated with this component set',
      },
    };
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'test' });
    engine.generate.mockClear();
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: profile.family,
      intent: 'generate',
    });
    engine.generate.mockImplementationOnce(async (_profile, _input, _signal, _progress, onSubmitted) => {
      onSubmitted?.('terminal-oom-prompt');
      throw Object.assign(new Error('terminal OOM'), {
        diagnosis: { category: 'OOM', retryable: false, action: 'REVIEW_MEMORY_BUDGET' },
      });
    });
    const job = service.generate(requestId, profile.id, { prompt: 'test' });
    await service.idle();
    expect(engine.clearMemory).toHaveBeenCalledOnce();
    expect(engine.clearMemory).toHaveBeenCalledWith(
      expect.objectContaining({ id: profile.id }),
      'oom',
      expect.any(AbortSignal)
    );
    expect(engine.generate.mock.calls.at(-1)?.[1]).toEqual({ prompt: 'test' });
    expect(engine.generate.mock.calls.at(-1)?.[0]).toMatchObject({ id: profile.id, quantization: 'BF16' });
    expect(service.job(job.id, { requestId })).toMatchObject({
      status: 'succeeded',
    });
    expect(service.job(job.id, { requestId }).adjustments).toBeUndefined();
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
    expect(saved.jobs[0].oomRetryCount).toBe(1);
    const restored = new ComfyService({
      filename: path.join(root, 'state.json'),
      engine,
      install: vi.fn(),
      probe: vi.fn(),
    });
    expect(restored.job(job.id, { requestId })).toMatchObject({ status: 'succeeded' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).jobs[0].oomRetryCount).toBe(1);
  });
  it('does not retry an OOM if memory clearing cannot be confirmed', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'test' });
    engine.generate.mockClear();
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: profile.family,
      intent: 'generate',
    });
    engine.clearMemory.mockRejectedValueOnce(new Error('COMFY_MEMORY_CLEAR_UNCONFIRMED'));
    engine.generate.mockRejectedValueOnce(
      Object.assign(new Error('terminal OOM'), {
        diagnosis: { category: 'OOM', retryable: false, action: 'REVIEW_MEMORY_BUDGET' },
      })
    );
    const job = service.generate(requestId, profile.id, { prompt: 'test' });
    await service.idle();
    expect(engine.generate).toHaveBeenCalledOnce();
    expect(service.job(job.id, { requestId })).toMatchObject({ status: 'failed' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).jobs[0].oomRetryCount).toBe(1);
  });
  it('uses no second OOM retry for the same job', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'test' });
    engine.generate.mockClear();
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: profile.family,
      intent: 'generate',
    });
    const oom = Object.assign(new Error('terminal OOM'), {
      diagnosis: { category: 'OOM', retryable: false, action: 'REVIEW_MEMORY_BUDGET' },
    });
    engine.generate.mockRejectedValueOnce(oom).mockRejectedValueOnce(oom);
    const job = service.generate(requestId, profile.id, { prompt: 'test' });
    await service.idle();
    expect(engine.clearMemory).toHaveBeenCalledOnce();
    expect(engine.generate).toHaveBeenCalledTimes(2); // original + one retry
    expect(service.job(job.id, { requestId })).toMatchObject({ status: 'failed', diagnosis: { category: 'OOM' } });
  });
  it('does not retry unknown submission outcomes or repeatedly replay the same terminal failure', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'test' });
    service.bind({
      requestId,
      conversationId: 'chat',
      profileId: profile.id,
      family: profile.family,
      intent: 'generate',
    });
    engine.generate.mockRejectedValueOnce(new Error('COMFY_SUBMISSION_STATE_UNKNOWN'));
    const job = service.generate(requestId, profile.id, { prompt: 'test' });
    await service.idle();
    expect(service.job(job.id, { requestId })).toMatchObject({ status: 'failed', submissionUncertain: true });
    expect(engine.generate).toHaveBeenCalledTimes(2);
  });
  it('rejects a plan after switching to cloud and requires replanning repeated failed installs', async () => {
    const { service, install } = setup();
    const operation = await service.request(requestId, plan());
    service.authorize(operation.id, 'chat');
    service.bind({ requestId, conversationId: 'chat', source: 'cloud', kind: 'image', intent: 'generate' });
    expect(() => service.start(operation.id, requestId)).toThrow('COMFY_SELECTION_CHANGED');
    service.bind({
      requestId,
      conversationId: 'chat',
      family: 'z-image',
      source: 'local',
      kind: 'image',
      intent: 'install',
    });
    install.mockRejectedValue(new Error('fixed failure'));
    service.start(operation.id, requestId);
    await service.idle();
    service.authorize(operation.id, 'chat');
    service.start(operation.id, requestId);
    await service.idle();
    expect(() => service.authorize(operation.id, 'chat')).toThrow('COMFY_REPEATED_ERROR_REPLAN');
    expect(install).toHaveBeenCalledTimes(2);
  });
  it('requires a matching request or conversation scope for all operation and job access', async () => {
    const { service } = setup();
    const operation = await service.request(requestId, plan());
    expect(() => service.operation(operation.id, {})).toThrow('COMFY_REQUEST_REQUIRED');
    expect(() => service.cancelOperation(operation.id, { conversationId: 'different' })).toThrow(
      'COMFY_CONVERSATION_MISMATCH'
    );
    expect(service.operation(operation.id, { conversationId: 'chat' }).state).toBe('awaiting-consent');
    service.register(profile);
    const job = service.verify(requestId, profile.id, { prompt: 'smoke' });
    expect(() => service.job(job.id, {})).toThrow('COMFY_REQUEST_REQUIRED');
    await expect(service.cancelJob(job.id, { requestId: crypto.randomUUID() })).rejects.toThrow(
      'COMFY_REQUEST_MISMATCH'
    );
    await service.idle();
    expect(service.job(job.id, { conversationId: 'chat' }).status).toBe('succeeded');
  });
  it('blocks incomplete AMD detection and insufficient space while permitting an explicitly probed CPU runtime', async () => {
    const { service, probe } = setup();
    const complete = await probe();
    probe.mockResolvedValueOnce({
      ...complete,
      machine: {
        ...complete.machine,
        gpus: [{ ...complete.machine.gpus[0], vendor: 'amd', driver: '' }],
      },
    });
    await expect(service.request(requestId, plan())).rejects.toThrow('COMFY_DETECTION_INCOMPLETE');
    probe.mockResolvedValueOnce({
      ...complete,
      machine: { ...complete.machine, disk: { ...complete.machine.disk, freeBytes: 5 } },
    });
    await expect(service.request(requestId, plan())).rejects.toThrow('COMFY_DISK_SPACE_INSUFFICIENT');
    probe.mockResolvedValueOnce({
      ...complete,
      machine: { ...complete.machine, gpuStatus: 'unknown', gpus: [] },
      runtime: { ...complete.runtime, accelerator: 'cpu' },
    });
    const input = plan();
    await expect(
      service.request(requestId, { ...input, environment: { ...input.environment, launchArgs: ['--cpu'] } })
    ).resolves.toMatchObject({ state: 'awaiting-consent' });
  });

  it.each(['fasth3-omni', 'flux-3-image-klein', 'krea2'] as const)(
    'rejects %s NVFP4 on a known non-Blackwell GPU before planning a download',
    async (family) => {
      const { service, install, probe } = setup();
      service.bind({
        requestId,
        conversationId: 'chat',
        family,
        intent: 'install',
        source: 'local',
        kind: family === 'fasth3-omni' ? 'video' : 'image',
      });
      const input = { ...plan(), family, kind: family === 'fasth3-omni' ? 'video' : 'image', quantization: 'NVFP4' };
      await expect(service.request(requestId, input)).rejects.toThrow(
        'COMFY_DEVICE_CONDITIONS_INSUFFICIENT:NVFP4_REQUIRES_BLACKWELL'
      );
      expect(install).not.toHaveBeenCalled();
      const complete = await probe();
      probe.mockResolvedValueOnce({
        ...complete,
        machine: { ...complete.machine, gpus: [{ ...complete.machine.gpus[0], computeCapability: '' }] },
      });
      await expect(service.request(requestId, input)).rejects.toThrow('COMFY_DETECTION_INCOMPLETE');
      probe.mockResolvedValueOnce({
        ...complete,
        machine: { ...complete.machine, gpus: [{ ...complete.machine.gpus[0], computeCapability: '12.0' }] },
      });
      await expect(service.request(requestId, input)).resolves.toMatchObject({ state: 'awaiting-consent' });
    }
  );

  it('preserves corrupt state for recovery and never executes its content', () => {
    const { engine, install, probe } = setup();
    const filename = path.join(root, 'state.json');
    fs.writeFileSync(filename, '{invalid');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const recovered = new ComfyService({ filename, engine, install, probe });
      expect(recovered.profiles()).toEqual([]);
      const backup = fs.readdirSync(root).find((name) => name.startsWith('state.json.corrupt-'));
      expect(backup).toBeDefined();
      expect(fs.readFileSync(path.join(root, backup!), 'utf8')).toBe('{invalid');
      expect(install).not.toHaveBeenCalled();
      expect(engine.generate).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it('rejects a queued install when selection changes before its executor starts', async () => {
    const { service, install } = setup();
    const operation = await service.request(requestId, plan());
    service.authorize(operation.id, 'chat');
    service.start(operation.id, requestId);
    service.bind({ requestId, conversationId: 'chat', family: 'qwen-edit', intent: 'install' });
    await service.idle();
    expect(service.operation(operation.id, { requestId })).toMatchObject({
      state: 'failed',
      error: 'COMFY_SELECTION_CHANGED',
    });
    expect(install).not.toHaveBeenCalled();
  });
  it('reuses identical active requests and leaves unconfirmed cancellation running', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'smoke' });
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    let reached: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const submitted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    engine.generate.mockImplementationOnce(async (_profile, _input, _signal, _progress, onSubmitted) => {
      onSubmitted?.('busy-prompt');
      reached?.();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { promptId: 'busy-prompt', artifacts: [{ path: path.join(root, 'out.png'), mimeType: 'image/png' }] };
    });
    const job = service.generate(requestId, profile.id, { prompt: 'same prompt' });
    expect(service.generate(requestId, profile.id, { prompt: 'same prompt' }).id).toBe(job.id);
    await submitted;
    engine.cancel.mockRejectedValueOnce(new Error('another prompt active'));
    await expect(service.cancelJob(job.id, { requestId })).rejects.toThrow('another prompt active');
    expect(service.job(job.id, { requestId })).toMatchObject({
      status: 'running',
      error: 'COMFY_CANCEL_UNCONFIRMED:another prompt active',
    });
    finish?.();
    await service.idle();
  });
  it('settles externally interrupted prompts without retaining a device uncertainty fence', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'smoke' });
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    engine.generate.mockImplementationOnce(async (_profile, _input, _signal, _progress, onSubmitted) => {
      onSubmitted?.('externally-cancelled');
      throw Object.assign(new Error('COMFY_JOB_CANCELLED'), { remoteTerminal: true });
    });
    const job = service.generate(requestId, profile.id, { prompt: 'interrupted' });
    await service.idle();
    expect(service.job(job.id, { requestId })).toMatchObject({
      status: 'failed',
      submissionUncertain: false,
      error: 'COMFY_JOB_CANCELLED',
    });
    const next = service.generate(requestId, profile.id, { prompt: 'next task' });
    await service.idle();
    expect(service.job(next.id, { requestId }).status).toBe('succeeded');
    await service.close();
  });

  it('recovers completed output retrieval without treating the GPU execution as unknown', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'smoke' });
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    engine.generate.mockImplementationOnce(async (_profile, _input, _signal, _progress, onSubmitted) => {
      onSubmitted?.('completed-prompt');
      throw Object.assign(new Error('COMFY_OUTPUT_RETRIEVAL_FAILED'), { remoteTerminal: true });
    });
    const job = service.generate(requestId, profile.id, { prompt: 'recover output' });
    await service.idle();
    expect(service.job(job.id, { requestId })).toMatchObject({
      status: 'running',
      promptId: 'completed-prompt',
      submissionUncertain: false,
    });
    engine.resume.mockResolvedValueOnce({
      promptId: 'completed-prompt',
      artifacts: [{ path: path.join(root, 'out.png'), mimeType: 'image/png' }],
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    try {
      service.job(job.id, { requestId });
      await service.idle();
      expect(service.job(job.id, { requestId }).status).toBe('succeeded');
      expect(engine.resume).toHaveBeenCalledOnce();
      expect(engine.generate).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
    await service.close();
  });

  it('never labels a prompt being submitted as cancelled before a prompt ID is known', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'smoke' });
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    let reached: (() => void) | undefined;
    let release: (() => void) | undefined;
    const submitting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    engine.generate.mockImplementationOnce(async (_profile, _input, _signal, _progress, onSubmitted, onSubmitting) => {
      onSubmitting?.();
      reached?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      onSubmitted?.('confirmed-prompt');
      return { promptId: 'confirmed-prompt', artifacts: [{ path: path.join(root, 'out.png'), mimeType: 'image/png' }] };
    });
    const job = service.generate(requestId, profile.id, { prompt: 'one submission' });
    await submitting;
    await expect(service.cancelJob(job.id, { requestId })).rejects.toThrow('COMFY_SUBMISSION_PENDING');
    expect(service.job(job.id, { requestId })).toMatchObject({ status: 'running', submissionUncertain: true });
    expect(engine.cancel).not.toHaveBeenCalled();
    release?.();
    await service.idle();
    expect(service.job(job.id, { requestId })).toMatchObject({ status: 'succeeded', submissionUncertain: false });
    expect(service.job(job.id, { requestId }).error).toBeUndefined();
  });
  it('retains local diagnostic evidence through wrapped installation errors and restart', async () => {
    const { service, install, engine, probe } = setup();
    const logPath = path.join(root, 'runtime-diagnostic.log');
    fs.writeFileSync(logPath, 'ModuleNotFoundError: missing_attention');
    const detail = Object.assign(new Error('COMFY_STARTUP_FAILED'), {
      diagnosticLogPath: logPath,
      diagnosis: { category: 'EXECUTION_FAILED', retryable: false, action: 'INSPECT_RUNTIME_LOG' },
    });
    install.mockRejectedValueOnce(new Error('COMFY_INSTALL_FAILED', { cause: detail }));
    const operation = await service.request(requestId, plan());
    service.authorize(operation.id, 'chat');
    service.start(operation.id, requestId);
    await service.idle();
    expect(service.operation(operation.id, { conversationId: 'chat' })).toMatchObject({
      state: 'failed',
      diagnosticLogPath: logPath,
      diagnosis: { action: 'INSPECT_RUNTIME_LOG' },
    });
    const restored = new ComfyService({ filename: path.join(root, 'state.json'), install, engine, probe });
    expect(restored.operation(operation.id, { conversationId: 'chat' }).diagnosticLogPath).toBe(logPath);
    expect(restored.operation(operation.id, { conversationId: 'chat' }).error).not.toContain('missing_attention');
  });
  it('returns runtime diagnostic paths for failed validation jobs without copying raw logs into errors', async () => {
    const { service, engine } = setup();
    service.register(profile);
    const logPath = path.join(root, 'validation.log');
    engine.validate.mockRejectedValueOnce(
      Object.assign(new Error('COMFY_STARTUP_FAILED'), { diagnosticLogPath: logPath })
    );
    const job = service.verify(requestId, profile.id, { prompt: 'smoke' });
    await service.idle();
    expect(service.job(job.id, { conversationId: 'chat' })).toMatchObject({
      status: 'failed',
      error: 'COMFY_STARTUP_FAILED',
      diagnosticLogPath: logPath,
    });
  });
  it('resumes a known prompt after monitoring loss and never submits a replacement for the same input', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'smoke' });
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    engine.generate.mockImplementationOnce(async (_profile, _input, _signal, _progress, onSubmitted) => {
      onSubmitted?.('still-running');
      throw new Error('COMFY_HISTORY_UNAVAILABLE');
    });
    const job = service.generate(requestId, profile.id, { prompt: 'recover once' });
    await service.idle();
    expect(service.job(job.id, { requestId })).toMatchObject({
      status: 'running',
      promptId: 'still-running',
      submissionUncertain: true,
    });
    expect(service.generate(requestId, profile.id, { prompt: 'recover once' }).id).toBe(job.id);
    expect(engine.generate).toHaveBeenCalledTimes(2);
    engine.resume.mockResolvedValueOnce({
      promptId: 'still-running',
      artifacts: [{ path: path.join(root, 'recovered.png'), mimeType: 'image/png' }],
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    try {
      service.job(job.id, { conversationId: 'chat' });
      await service.idle();
      expect(service.job(job.id, { conversationId: 'chat' })).toMatchObject({
        status: 'succeeded',
        promptId: 'still-running',
        submissionUncertain: false,
      });
      expect(engine.resume).toHaveBeenCalledOnce();
      expect(engine.resume.mock.calls[0][1]).toBe('still-running');
      expect(engine.generate).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
  it('blocks duplicate submission after an unknown response even when the original job is marked failed', async () => {
    const { service, engine } = setup();
    service.register(profile);
    await service.revalidate(profile.id, { prompt: 'smoke' });
    service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'generate' });
    engine.generate.mockRejectedValueOnce(new Error('COMFY_SUBMISSION_STATE_UNKNOWN'));
    const job = service.generate(requestId, profile.id, { prompt: 'uncertain submission' });
    await service.idle();
    expect(service.job(job.id, { requestId })).toMatchObject({ status: 'failed', submissionUncertain: true });
    expect(() => service.generate(requestId, profile.id, { prompt: 'uncertain submission' })).toThrow(
      'COMFY_SUBMISSION_STATE_UNKNOWN'
    );
    expect(engine.generate).toHaveBeenCalledTimes(2);
  });
});

it.each(['automatic', 'manual'] as const)(
  'replans an incompatible runtime on the same operation with fresh %s approval',
  async (mode) => {
    const preparePlan = vi.fn(async () => plan());
    const resolveApproval = vi.fn(async () => ({ mode }));
    const { service, install } = setup({ preparePlan, resolveApproval });
    install.mockRejectedValueOnce(new Error('COMFY_EXISTING_RUNTIME_INCOMPATIBLE:WORKFLOW_NODE_OR_INPUT_UNSUPPORTED'));
    const operation = await service.request(requestId, { action: 'request', family: 'z-image', intent: 'install' });
    if (mode === 'manual') {
      service.authorize(operation.id, 'chat');
      service.start(operation.id, requestId);
    }
    await service.idle();
    const changed = plan();
    changed.environment = { ...changed.environment, root: path.join(root, 'isolated') };
    preparePlan.mockResolvedValueOnce(changed);
    const result = await service.recoverOrReplanInstallation(operation.id, requestId);
    expect(preparePlan).toHaveBeenLastCalledWith(
      requestId,
      expect.objectContaining({ family: 'z-image', intent: 'install' }),
      expect.any(Array),
      { excludedEnvironmentRoots: [operation.plan.environment.root] }
    );
    expect(result.id).toBe(operation.id);
    expect(result.recoveryAttempts).toBe(1);
    expect(result.state).toBe(mode === 'automatic' ? 'running' : 'awaiting-consent');
    expect(result.plan.environment.root).toBe(changed.environment.root);
    expect(resolveApproval).toHaveBeenCalledTimes(2);
    await service.idle();
    expect(install).toHaveBeenCalledTimes(mode === 'automatic' ? 2 : 1);
  }
);

it('does not replan while a failed runtime preflight has unconfirmed process cleanup', async () => {
  const preparePlan = vi.fn(async () => plan());
  const { service, install } = setup({ preparePlan, resolveApproval: async () => ({ mode: 'automatic' }) });
  install.mockRejectedValueOnce(
    new Error(
      'COMFY_EXISTING_RUNTIME_INCOMPATIBLE:WORKFLOW_NODE_OR_INPUT_UNSUPPORTED; COMFY_PREFLIGHT_CLEANUP_FAILED:COMFY_OWNED_SERVER_STOP_TIMEOUT'
    )
  );
  const operation = await service.request(requestId, { action: 'request', family: 'z-image', intent: 'install' });
  await service.idle();
  expect(preparePlan).toHaveBeenCalledOnce();
  await expect(service.recoverOrReplanInstallation(operation.id, requestId)).rejects.toThrow(
    'COMFY_RUNTIME_CLEANUP_REQUIRED'
  );
  expect(preparePlan).toHaveBeenCalledOnce();
});

it('refreshes discovered H3 and other profiles before identity-only installation planning', async () => {
  const discovered = { ...profile, family: 'h3' as const, id: 'existing-h3', kind: 'video' as const };
  const discover = vi.fn(async () => [discovered]);
  const preparePlan = vi.fn(async (_id: string, _request: unknown, _profiles: readonly ComfyProfile[]) => plan());
  const { service } = setup({ discover, preparePlan });
  await service.request(requestId, { action: 'request', family: 'z-image', intent: 'install' });
  expect(preparePlan.mock.calls[0][2]).toContainEqual(expect.objectContaining({ id: 'existing-h3' }));
});

it('automatically resumes a legacy missing-Git task with the bundled Git runtime', async () => {
  const previous: ComfyInstallPlan = {
    ...plan(),
    commands: [
      {
        executable: 'git',
        args: ['clone', '--no-checkout', 'https://github.com/Comfy-Org/ComfyUI.git', root],
        cwd: root,
        label: 'bootstrap:comfy-clone',
        revision: 'a'.repeat(40),
        stage: 'prepare',
      },
    ],
  };
  const preparePlan = vi.fn(async (): Promise<ComfyInstallPlan> => previous);
  const { service, install } = setup({ preparePlan, resolveApproval: async () => ({ mode: 'automatic' as const }) });
  install.mockRejectedValueOnce(new Error('spawn git ENOENT'));
  const operation = await service.request(requestId, { action: 'request', family: 'z-image', intent: 'install' });
  await service.idle();
  await service.idle();
  const resumed = service.operation(operation.id, { requestId });
  expect(resumed.id).toBe(operation.id);
  expect(resumed.plan.environment.root).toBe(previous.environment.root);
  expect(resumed.plan.commands).toEqual(previous.commands);
  expect(preparePlan).toHaveBeenCalledTimes(2);
  expect(resumed.state).toBe('completed');
  expect(install).toHaveBeenCalledTimes(2);
});

it('replans Python and binary wheels on the same operation after a venv bootstrap failure', async () => {
  const previous: ComfyInstallPlan = {
    ...plan(),
    commands: [
      {
        executable: path.join(root, 'portable-python.exe'),
        args: ['-m', 'venv', path.join(root, '.venv')],
        cwd: root,
        label: 'bootstrap:python-venv',
        revision: 'python-venv-v1',
        stage: 'prepare',
      },
    ],
  };
  const preparePlan = vi.fn(async (): Promise<ComfyInstallPlan> => previous);
  const { service, install } = setup({ preparePlan, resolveApproval: async () => ({ mode: 'automatic' as const }) });
  install.mockImplementationOnce(async (_plan, _signal, progress) => {
    progress?.('bootstrap:python-venv');
    throw new Error('COMFY_COMMAND_FAILED:bootstrap:python-venv:exit=1');
  });
  const operation = await service.request(requestId, { action: 'request', family: 'z-image', intent: 'install' });
  await service.idle();
  const replacement = {
    ...plan(),
    environment: { ...plan().environment, python: path.join(root, '.venv-py312', 'Scripts', 'python.exe') },
  };
  preparePlan.mockResolvedValueOnce(replacement);
  const resumed = await service.recoverOrReplanInstallation(operation.id, requestId);
  expect(resumed.id).toBe(operation.id);
  expect(resumed.plan.environment.python).toBe(replacement.environment.python);
  expect(resumed.recoveryAttempts).toBe(1);
  await service.idle();
  expect(install).toHaveBeenCalledTimes(2);
});

it('keeps later-stage recovery available after earlier stages consumed attempts', async () => {
  const { service, install } = setup();
  const operation = await service.request(requestId, plan());
  let attempt = 0;
  install.mockImplementation(async (_plan, _signal, progress) => {
    progress?.(['bootstrap:comfy-clone', 'bootstrap:python-venv', 'download:weights'][attempt]);
    throw new Error(['GIT_TIMEOUT', 'VENV_MISSING', 'SOURCE_TIMEOUT'][attempt++]);
  });
  service.authorize(operation.id, 'chat');
  service.start(operation.id, requestId);
  await service.idle();
  service.recoverInstallation(operation.id, requestId);
  await service.idle();
  service.recoverInstallation(operation.id, requestId);
  await service.idle();
  install.mockImplementationOnce(async () => structuredClone(profile));
  const next = service.recoverInstallation(operation.id, requestId);
  expect(next.recoveryAttempts).toBe(3);
  expect(next.recoveryStageAttempts).toEqual({
    'bootstrap:comfy-clone': 1,
    'bootstrap:python-venv': 1,
    'download:weights': 1,
  });
  await service.idle();
  expect(service.operation(operation.id, { requestId }).state).toBe('completed');
});

it('automatically replans a known venv bootstrap failure for an auto-approved installation', async () => {
  const previous = {
    ...plan(),
    environment: { ...profile.environment, python: path.join(root, '.venv-py313', 'Scripts', 'python.exe') },
    commands: [
      {
        executable: path.join(root, 'python-embed.exe'),
        args: ['-m', 'venv', path.join(root, '.venv-py313')],
        cwd: root,
        label: 'bootstrap:python-venv',
        revision: 'python-venv-v1',
        stage: 'prepare' as const,
      },
    ],
  };
  const next = {
    ...plan(),
    environment: { ...profile.environment, python: path.join(root, '.venv-py312', 'Scripts', 'python.exe') },
  };
  const preparePlan = vi.fn().mockResolvedValueOnce(previous).mockResolvedValueOnce(next);
  const resolveApproval = vi.fn(async () => ({ mode: 'automatic' as const }));
  const { service, install } = setup({ preparePlan, resolveApproval });
  install.mockImplementationOnce(async (_plan, _signal, progress) => {
    progress?.('bootstrap:python-venv');
    throw new Error('COMFY_COMMAND_FAILED:bootstrap:python-venv:exit=1');
  });
  const first = await service.request(requestId, { action: 'request', family: 'z-image', intent: 'install' });
  await service.idle();
  await service.idle();
  const recovered = service.operation(first.id, { requestId });
  expect(recovered.id).toBe(first.id);
  expect(recovered.plan.environment.python).toBe(next.environment.python);
  expect(recovered.recoveryAttempts).toBe(1);
  expect(recovered.state).toBe('completed');
  expect(preparePlan).toHaveBeenCalledTimes(2);
  expect(resolveApproval).toHaveBeenCalledTimes(2);
});

it('records an Agent-installed model only after the bound real validation job succeeds', async () => {
  fs.writeFileSync(profile.components[0].path, 'weights');
  profile.components[0].sha256 = crypto.createHash('sha256').update('weights').digest('hex');
  profile.components[0].sizeBytes = 7;
  fs.writeFileSync(profile.workflowPath, JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '' } } }));
  fs.writeFileSync(path.join(root, 'out.png'), 'image');
  const { service } = setup();
  service.register(profile);
  const job = service.verify(requestId, profile.id, { prompt: 'a red cup' });
  await service.idle();
  expect(service.job(job.id, { requestId }).status).toBe('succeeded');
  const receipt = await service.completeAgentInstallation(requestId, job.id);
  expect(receipt).toMatchObject({
    requestId,
    conversationId: 'chat',
    state: 'completed',
    execution: 'agent',
    profileId: profile.id,
  });
  expect(receipt.plan.environment).toEqual(profile.environment);
  expect(receipt.plan.commands).toEqual([]);
  expect((await service.completeAgentInstallation(requestId, job.id)).id).toBe(receipt.id);
  expect(service.activity('chat').operations).toHaveLength(1);
});

describe('Agent model-card repair variants', () => {
  function repairFixture() {
    fs.writeFileSync(profile.components[0].path, 'weights');
    profile.components[0].sha256 = crypto.createHash('sha256').update('weights').digest('hex');
    profile.components[0].sizeBytes = 7;
    const context = setup();
    context.service.register(profile);
    context.service.bind({ requestId, conversationId: 'chat', profileId: profile.id, intent: 'repair' });
    const variant = {
      ...profile,
      id: 'z-repaired-workflow',
      workflowPath: path.join(root, 'repaired.json'),
      nodes: [{ id: 'ComfyUI', version: 'repaired-revision' }],
    };
    fs.writeFileSync(variant.workflowPath, JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '' } } }));
    return { ...context, variant };
  }

  it('returns a new workflow variant validation to the bound repair conversation', async () => {
    const { service, variant } = repairFixture();
    service.register(variant);
    const job = service.verify(requestId, variant.id, { prompt: 'validate repair' });
    await service.idle();
    expect(service.installationValidationUpdates()).toEqual([
      expect.objectContaining({ id: job.id, requestId, profileId: variant.id, state: 'completed' }),
    ]);
    expect(service.selection(requestId).profileId).toBe(profile.id);
  });

  it('completes a validated workflow variant once and keeps the original model profile', async () => {
    const { service, variant } = repairFixture();
    const original = service.profiles().find((item) => item.id === profile.id);
    service.register(variant);
    const job = service.verify(requestId, variant.id, { prompt: 'validate repair' });
    await service.idle();
    const receipt = await service.completeAgentInstallation(requestId, job.id);
    expect(receipt).toMatchObject({
      state: 'completed',
      execution: 'agent',
      profileId: variant.id,
      validationJobId: job.id,
      plan: { repair: true, commands: [] },
    });
    expect(service.selection(requestId)).toMatchObject({ profileId: variant.id, intent: 'repair' });
    expect(service.profiles().find((item) => item.id === profile.id)).toEqual(original);
    expect((await service.completeAgentInstallation(requestId, job.id)).id).toBe(receipt.id);
    expect(service.activity('chat').operations).toHaveLength(1);
    expect(service.installationValidationUpdates()).toEqual([]);
  });

  it('associates failed smoke validations with the successful completion receipt for that repair request', async () => {
    const { service, engine, variant } = repairFixture();
    service.register(variant);
    engine.generate.mockRejectedValueOnce(new Error('MISSING_NODE'));
    const failed = service.verify(requestId, variant.id, { prompt: 'first validation' });
    await service.idle();
    const success = service.verify(requestId, variant.id, { prompt: 'repaired validation' });
    await service.idle();
    expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
    const receipt = await service.completeAgentInstallation(requestId, success.id);
    expect(service.job(failed.id, { requestId })).toMatchObject({ status: 'failed', recoveredBy: success.id });
    expect(receipt.validationJobId).toBe(success.id);
    expect(service.job(failed.id, { requestId })).not.toHaveProperty('input');
    expect(service.job(failed.id, { requestId })).not.toHaveProperty('requestId');
  });

  it('recovers later smoke failures using a later completion receipt in the same repair request', async () => {
    const { service, engine, variant } = repairFixture();
    service.register(variant);
    const first = service.verify(requestId, variant.id, { prompt: 'first repair' });
    await service.idle();
    await service.completeAgentInstallation(requestId, first.id);
    engine.generate.mockRejectedValueOnce(new Error('MISSING_NODE'));
    const failed = service.verify(requestId, variant.id, { prompt: 'next repair' });
    await service.idle();
    const success = service.verify(requestId, variant.id, { prompt: 'next repair fixed' });
    await service.idle();
    expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
    await service.completeAgentInstallation(requestId, success.id);
    expect(service.job(failed.id, { requestId })).toMatchObject({ status: 'failed', recoveredBy: success.id });
    expect(setup().service.job(failed.id, { requestId })).toMatchObject({ recoveredBy: success.id });
  });

  it('does not recover validation failures from an earlier selection using a later repair receipt', async () => {
    const { service, engine, variant } = repairFixture();
    service.register(variant);
    engine.generate.mockRejectedValueOnce(new Error('MISSING_NODE'));
    const failed = service.verify(requestId, variant.id, { prompt: 'first selection' });
    await service.idle();
    service.bind({ ...service.selection(requestId), profileId: variant.id });
    const success = service.verify(requestId, variant.id, { prompt: 'new selection' });
    await service.idle();
    await service.completeAgentInstallation(requestId, success.id);
    expect(service.job(failed.id, { requestId })).not.toHaveProperty('recoveredBy');
  });

  it('returns failed variant validation for continued repair without completing it', async () => {
    const { service, engine, variant } = repairFixture();
    service.register(variant);
    engine.generate.mockRejectedValueOnce(new Error('MISSING_NODE'));
    const job = service.verify(requestId, variant.id, { prompt: 'validate repair' });
    await service.idle();
    expect(service.installationValidationUpdates()).toEqual([
      expect.objectContaining({ id: job.id, profileId: variant.id, state: 'failed', error: 'MISSING_NODE' }),
    ]);
    await expect(service.completeAgentInstallation(requestId, job.id)).rejects.toThrow(
      'COMFY_INSTALL_VALIDATION_REQUIRED'
    );
    expect(service.activity('chat').operations).toHaveLength(0);
  });

  it.each(['quantization', 'precision', 'hash', 'size', 'role'] as const)(
    'rejects a validated repair variant with changed model %s',
    async (field) => {
      const { service, variant } = repairFixture();
      const changed = structuredClone(variant);
      if (field === 'quantization') changed.quantization = 'FP8';
      if (field === 'precision') changed.components[0].precision = 'FP8';
      if (field === 'hash') changed.components[0].sha256 = 'a'.repeat(64);
      if (field === 'size') changed.components[0].sizeBytes = 8;
      if (field === 'role') changed.components[0].role = 'vae';
      service.register(changed);
      const job = service.verify(requestId, changed.id, { prompt: 'validate repair' });
      await service.idle();
      await expect(service.completeAgentInstallation(requestId, job.id)).rejects.toThrow('COMFY_REPAIR_MODEL_CHANGED');
      expect(service.selection(requestId).profileId).toBe(profile.id);
      expect(service.activity('chat').operations).toHaveLength(0);
    }
  );

  it.each(['repair', 'install'] as const)(
    'rejects an old repair validation after selection changes to %s',
    async (intent) => {
      const { service, variant } = repairFixture();
      service.register(variant);
      const job = service.verify(requestId, variant.id, { prompt: 'validate repair' });
      await service.idle();
      service.bind({ ...service.selection(requestId), profileId: variant.id, intent });
      expect(service.installationValidationUpdates()).toEqual([]);
      await expect(service.completeAgentInstallation(requestId, job.id)).rejects.toThrow('COMFY_SELECTION_CHANGED');
      expect(service.activity('chat').operations).toHaveLength(0);
    }
  );

  it.each(['selection', 'original-profile'] as const)(
    'rejects a repair %s change during the completion fingerprint check',
    async (change) => {
      const { service, engine, variant } = repairFixture();
      service.register(variant);
      const job = service.verify(requestId, variant.id, { prompt: 'validate repair' });
      await service.idle();
      let finish!: (value: string) => void;
      engine.snapshotFingerprint.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          })
      );
      const completing = service.completeAgentInstallation(requestId, job.id);
      if (change === 'selection') service.bind({ ...service.selection(requestId), profileId: variant.id });
      else
        service.recordProgressProfile({
          ...profile,
          state: 'downloaded',
          nodes: [{ id: 'ComfyUI', version: 'other-revision' }],
        });
      finish?.('fingerprint');
      await expect(completing).rejects.toThrow('COMFY_SELECTION_CHANGED');
      expect(service.activity('chat').operations).toHaveLength(0);
    }
  );
});

it('does not accept failed validation or an altered profile as Agent installation completion', async () => {
  fs.writeFileSync(profile.components[0].path, 'weights');
  profile.components[0].sha256 = crypto.createHash('sha256').update('weights').digest('hex');
  profile.components[0].sizeBytes = 7;
  fs.writeFileSync(profile.workflowPath, JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '' } } }));
  const { service, engine } = setup();
  service.register(profile);
  engine.generate.mockRejectedValueOnce(new Error('MISSING_NODE'));
  const failed = service.verify(requestId, profile.id, { prompt: 'a red cup' });
  await service.idle();
  await expect(service.completeAgentInstallation(requestId, failed.id)).rejects.toThrow(
    'COMFY_INSTALL_VALIDATION_REQUIRED'
  );
  const job = service.verify(requestId, profile.id, { prompt: 'a red cup' });
  await service.idle();
  engine.snapshotFingerprint.mockResolvedValueOnce('changed');
  await expect(service.completeAgentInstallation(requestId, job.id)).rejects.toThrow('COMFY_PROFILE_CHANGED');
  expect(service.activity('chat').operations).toHaveLength(0);
});

it('rejects a managed operation that appears while Agent completion checks the fingerprint', async () => {
  fs.writeFileSync(profile.workflowPath, JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '' } } }));
  fs.writeFileSync(profile.components[0].path, 'weights');
  profile.components[0].sha256 = crypto.createHash('sha256').update('weights').digest('hex');
  profile.components[0].sizeBytes = 7;
  const { service, engine } = setup();
  service.register(profile);
  const job = service.verify(requestId, profile.id, { prompt: 'a red cup' });
  await service.idle();
  let finish!: (value: string) => void;
  engine.snapshotFingerprint.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  const completing = service.completeAgentInstallation(requestId, job.id);
  await service.request(requestId, { ...plan(), id: 'another-installation' });
  finish('fingerprint');
  await expect(completing).rejects.toThrow('COMFY_EXISTING_OPERATION_ACTIVE');
  expect(service.activity('chat').operations.some((operation) => operation.execution === 'agent')).toBe(false);
});
