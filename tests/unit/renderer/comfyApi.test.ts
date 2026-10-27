import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import type { ComfyInstallIdentityRequest, ComfyOperation } from '@/common/chat/document/creation/comfy';

const fetchMock = vi.fn();
const conversationId = 'conv /+';
const install: ComfyInstallIdentityRequest = { action: 'request', family: 'qwen-edit', intent: 'install' };
const operation = {
  id: 'operation-1',
  requestId: 'request-1',
  installRequest: install,
  state: 'running',
} as ComfyOperation;
const response = (value: unknown) => ({ ok: true, json: async () => value });

describe('ComfyUI conversation-scoped client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('scopes operation and job reads to the current conversation', async () => {
    await comfyApi.operation('operation /+', conversationId);
    await comfyApi.job('job /+', conversationId);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:33002/api/comfy/operations/operation%20%2F%2B?conversationId=conv%20%2F%2B',
      'http://127.0.0.1:33002/api/comfy/jobs/job%20%2F%2B?conversationId=conv%20%2F%2B',
    ]);
  });

  it('scopes cancellations and authorization in their request bodies', async () => {
    await comfyApi.cancel('operation', conversationId);
    await comfyApi.cancelJob('job', conversationId);
    await comfyApi.authorize('operation', conversationId);
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      { conversationId },
      { conversationId },
      { conversationId },
    ]);
    expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(['POST', 'POST', 'POST']);
  });

  it('scopes every artifact preview URL to the current conversation', () => {
    expect(comfyApi.jobArtifactUrl('job /+', 2, conversationId)).toBe(
      'http://127.0.0.1:33002/api/comfy/jobs/job%20%2F%2B/artifacts/2?conversationId=conv%20%2F%2B'
    );
  });

  it('submits an identity-only installation and reads activity in the current conversation', async () => {
    fetchMock.mockResolvedValueOnce(response({ operations: [], jobs: [] })).mockResolvedValueOnce(response(operation));
    expect(await comfyApi.requestInstall('request-1', conversationId, install)).toEqual(operation);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:33002/api/comfy/activity?conversationId=conv%20%2F%2B');
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:33002/api/comfy/operations');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      requestId: 'request-1',
      install: { ...install, requestId: 'request-1' },
    });
  });

  it('recovers an existing installation without posting a replacement', async () => {
    fetchMock.mockResolvedValueOnce(response({ operations: [operation], jobs: [] }));
    expect(await comfyApi.requestInstall('request-1', conversationId, install)).toEqual(operation);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a saved request identity that belongs to another model', async () => {
    fetchMock.mockResolvedValueOnce(response({ operations: [operation], jobs: [] }));
    await expect(
      comfyApi.requestInstall('request-1', conversationId, { ...install, family: 'z-image' })
    ).rejects.toThrow('COMFY_INSTALL_REQUEST_ID_CONFLICT');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('recovers a lost submission response by request identity without another POST', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ operations: [], jobs: [] }))
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(response({ operations: [operation], jobs: [] }));
    expect(await comfyApi.requestInstall('request-1', conversationId, install)).toEqual(operation);
    expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('preserves a failed submission when no existing operation can be confirmed', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ operations: [], jobs: [] }))
      .mockRejectedValueOnce(new Error('submission uncertain'))
      .mockResolvedValueOnce(response({ operations: [], jobs: [] }));
    await expect(comfyApi.requestInstall('request-1', conversationId, install)).rejects.toThrow('submission uncertain');
    expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  });
});
