import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareCreationEntry } from '@/renderer/pages/conversation/runtime/Creation/prepareCreationEntry';

const mocks = vi.hoisted(() => ({ bind: vi.fn(), requestInstall: vi.fn() }));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({ comfyApi: mocks }));

describe('model-card creation orchestration', () => {
  beforeEach(() => {
    mocks.bind.mockReset().mockResolvedValue({ ok: true });
    mocks.requestInstall.mockReset().mockResolvedValue({ id: 'operation-1', state: 'running' });
  });

  it.each(['install', 'repair', 'install-other'] as const)(
    'submits %s directly after binding without asking an Agent to call a tool',
    async (intent) => {
      const entry = { source: 'local' as const, kind: 'image' as const, family: 'qwen-edit' as const, intent };
      const result = await prepareCreationEntry('request-1', 'conversation-1', entry);
      expect(result).toMatchObject({ id: 'operation-1' });
      expect(mocks.bind).toHaveBeenCalledWith('request-1', 'conversation-1', undefined, 'qwen-edit', intent, {
        source: 'local',
        kind: 'image',
      });
      expect(mocks.requestInstall).toHaveBeenCalledWith('request-1', 'conversation-1', {
        action: 'request',
        family: 'qwen-edit',
        intent,
        profileId: undefined,
        requestId: 'request-1',
      });
      expect(mocks.bind.mock.invocationCallOrder[0]).toBeLessThan(mocks.requestInstall.mock.invocationCallOrder[0]);
    }
  );

  it.each(['local', 'cloud'] as const)(
    'only binds %s generation; ordinary Agent execution is preserved',
    async (source) => {
      expect(
        await prepareCreationEntry('request-1', 'conversation-1', { source, intent: 'generate', family: 'qwen-edit' })
      ).toBeUndefined();
      expect(mocks.requestInstall).not.toHaveBeenCalled();
    }
  );

  it('does not submit after rejected binding', async () => {
    mocks.bind.mockResolvedValueOnce({ ok: false });
    await expect(
      prepareCreationEntry('request-1', 'conversation-1', { family: 'qwen-edit', intent: 'install' })
    ).rejects.toThrow('COMFY_BIND_FAILED');
    expect(mocks.requestInstall).not.toHaveBeenCalled();
  });

  it('coalesces concurrent mounts of the same request into one submission', async () => {
    let finish!: (value: { id: string }) => void;
    mocks.requestInstall.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const entry = { family: 'qwen-edit' as const, intent: 'install' as const };
    const first = prepareCreationEntry('request-1', 'conversation-1', entry);
    const second = prepareCreationEntry('request-1', 'conversation-1', entry);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(mocks.requestInstall).toHaveBeenCalledOnce());
    finish({ id: 'operation-1' });
    await expect(first).resolves.toEqual({ id: 'operation-1' });
  });
});
