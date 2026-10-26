import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComfyService } from '@/process/services/media/comfy/ComfyService';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';

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
    bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
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
function setup() {
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
describe('Comfy installation and profile service', () => {
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
    const restored = new ComfyService({ filename: path.join(root, 'state.json'), engine, install, probe });
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
  });
  it('runs explicit validation jobs in the same queue and never generates during installation intent', async () => {
    const { service } = setup();
    service.register(profile);
    const job = service.verify(requestId, profile.id, { prompt: 'smoke' });
    expect(service.verify(requestId, profile.id, { prompt: 'smoke' }).id).toBe(job.id);
    await service.idle();
    expect(service.job(job.id, { requestId }).status).toBe('succeeded');
    expect(service.profiles()[0].state).toBe('verified');
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
