import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareCreationEntry } from '@/renderer/pages/conversation/runtime/Creation/prepareCreationEntry';
import { comfyFamilySchema } from '@/common/chat/document/creation/comfy';

const mocks = vi.hoisted(() => ({ bind: vi.fn(), requestInstall: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({ comfyApi: mocks }));
vi.mock('@/common', () => ({
  ipcBridge: { conversation: { get: { invoke: mocks.get }, update: { invoke: mocks.update } } },
}));

describe('model-card creation orchestration', () => {
  beforeEach(() => {
    mocks.bind.mockReset().mockResolvedValue({ ok: true });
    mocks.requestInstall.mockReset().mockResolvedValue({ id: 'operation-1', state: 'running' });
    mocks.update.mockReset().mockResolvedValue(true);
  });

  it.each(['install', 'repair', 'install-other'] as const)(
    'binds %s identity without starting preparation before the Agent receives the request',
    async (intent) => {
      const entry = { source: 'local' as const, kind: 'image' as const, family: 'qwen-edit' as const, intent };
      const result = await prepareCreationEntry('request-1', 'conversation-1', entry);
      expect(result).toBeUndefined();
      expect(mocks.bind).toHaveBeenCalledWith('request-1', 'conversation-1', undefined, 'qwen-edit', intent, {
        source: 'local',
        kind: 'image',
      });
      expect(mocks.requestInstall).not.toHaveBeenCalled();
    }
  );

  it.each(comfyFamilySchema.options)('routes %s through the same Agent-first entry', async (family) => {
    await prepareCreationEntry('request-1', 'conversation-1', { family, intent: 'install' });
    expect(mocks.bind).toHaveBeenCalledOnce();
    expect(mocks.requestInstall).not.toHaveBeenCalled();
  });

  it('forwards the selected model revision and fixed workflow to binding', async () => {
    const modelConstraint = {
      modelSetId: 'model:qwen',
      selectionRevision: 3,
      workflowMode: 'fixed' as const,
      fixedWorkflowId: 'qwen-edit',
    };
    await prepareCreationEntry('request-routing', 'conversation-1', {
      source: 'local',
      kind: 'image',
      family: 'qwen-edit',
      profileId: 'qwen-fp8',
      intent: 'generate',
      modelConstraint,
    });
    expect(mocks.bind).toHaveBeenCalledWith(
      'request-routing',
      'conversation-1',
      'qwen-fp8',
      'qwen-edit',
      'generate',
      expect.objectContaining({
        ...modelConstraint,
        modelConstraint,
      })
    );
  });

  it.each(['local', 'cloud'] as const)(
    'only binds %s generation; ordinary Agent execution is preserved',
    async (source) => {
      expect(
        await prepareCreationEntry('request-1', 'conversation-1', { source, intent: 'generate', family: 'qwen-edit' })
      ).toBeUndefined();
      expect(mocks.requestInstall).not.toHaveBeenCalled();
    }
  );

  it('allows an installation goal to reach the Agent when optional binding is unavailable', async () => {
    mocks.bind.mockResolvedValueOnce({ ok: false });
    await expect(
      prepareCreationEntry('request-1', 'conversation-1', { family: 'qwen-edit', intent: 'install' })
    ).resolves.toBeUndefined();
    expect(mocks.requestInstall).not.toHaveBeenCalled();
  });

  it('persists pre-service binding errors on the matching installation for reopening the conversation', async () => {
    const entry = { family: 'qwen-edit' as const, intent: 'install' as const, installationInput: 'Install Qwen' };
    mocks.bind.mockRejectedValueOnce(new Error('service offline'));
    mocks.get.mockResolvedValueOnce({ extra: { creation_request: { ...entry, requestId: 'request-1' } } });
    await expect(prepareCreationEntry('request-1', 'conversation-1', entry)).resolves.toBeUndefined();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: {
          extra: { creation_request: { ...entry, requestId: 'request-1', installationError: 'service offline' } },
        },
      })
    );
  });
  it('still rejects a changed model selection and failed cloud generation binding', async () => {
    mocks.bind.mockRejectedValueOnce(new Error('COMFY_SELECTION_CHANGED'));
    await expect(
      prepareCreationEntry('request-1', 'conversation-1', { family: 'qwen-edit', intent: 'install' })
    ).rejects.toThrow('COMFY_SELECTION_CHANGED');
    mocks.bind.mockResolvedValueOnce({ ok: false });
    await expect(
      prepareCreationEntry('request-1', 'conversation-1', { source: 'cloud', family: 'qwen-edit', intent: 'generate' })
    ).rejects.toThrow('COMFY_BIND_FAILED');
  });

  it('delivers a local generation or legacy model-card goal to the Agent when profile binding is unavailable', async () => {
    mocks.bind.mockRejectedValueOnce(new Error('COMFY_PROFILE_NOT_FOUND'));
    await expect(
      prepareCreationEntry('request-local', 'conversation-local', {
        source: 'local',
        family: 'qwen-edit',
        profileId: 'missing-profile',
        intent: 'generate',
      })
    ).resolves.toBeUndefined();
  });

  it('does not bypass local generation identity conflicts', async () => {
    mocks.bind.mockRejectedValueOnce(new Error('COMFY_FAMILY_MISMATCH'));
    await expect(
      prepareCreationEntry('request-local-conflict', 'conversation-local', {
        source: 'local',
        family: 'qwen-edit',
        intent: 'generate',
      })
    ).rejects.toThrow('COMFY_FAMILY_MISMATCH');
  });

  it('coalesces concurrent mounts of the same request into one submission', async () => {
    let finish!: (value: { ok: boolean }) => void;
    mocks.bind.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const entry = { family: 'qwen-edit' as const, intent: 'install' as const };
    const first = prepareCreationEntry('request-1', 'conversation-1', entry);
    const second = prepareCreationEntry('request-1', 'conversation-1', entry);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(mocks.bind).toHaveBeenCalledOnce());
    finish({ ok: true });
    await expect(first).resolves.toBeUndefined();
    expect(mocks.requestInstall).not.toHaveBeenCalled();
  });
});
