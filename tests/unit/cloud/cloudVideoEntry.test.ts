import { describe, expect, it, vi } from 'vitest';
import { prepareCreationEntry } from '@/renderer/pages/conversation/runtime/Creation/prepareCreationEntry';
import { cloudVideoApi } from '@/common/chat/document/creation/cloudVideoApi';
vi.mock('@/common/chat/document/creation/cloudVideoApi', () => ({
  cloudVideoApi: { bind: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({
  comfyApi: { bind: vi.fn().mockResolvedValue({ ok: true }) },
}));
describe('cloud video session entry', () => {
  it('binds the exact selected cloud connection before the first agent message', async () => {
    await prepareCreationEntry('request', 'conversation', {
      id: 'cloud-video:connection-1',
      source: 'cloud',
      kind: 'video',
      intent: 'generate',
    });
    expect(cloudVideoApi.bind).toHaveBeenCalledWith('request', 'conversation', 'connection-1');
  });
});
