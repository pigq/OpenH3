/**
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const continuationControl = vi.hoisted(() => vi.fn());
vi.mock('@/common/chat/document/creation/comfyApi', () => ({ comfyApi: { continuationControl } }));

type HttpCall = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
};

const httpBridgeMocks = vi.hoisted(() => {
  const calls: HttpCall[] = [];
  const results = new Map<string, () => Promise<unknown>>();
  const provider =
    (method: HttpCall['method']) =>
    <Data, Params = undefined>(path: string | ((params: Params) => string), mapBody?: (params: Params) => unknown) => ({
      provider: vi.fn(),
      invoke: vi.fn(async (params?: Params) => {
        const resolvedPath = typeof path === 'function' ? path(params as Params) : path;
        calls.push({
          method,
          path: resolvedPath,
          body: mapBody && params !== undefined ? mapBody(params as Params) : undefined,
        });
        return (results.has(resolvedPath) ? await results.get(resolvedPath)!() : true) as Data;
      }),
    });
  const emitter = () => ({ on: vi.fn(() => vi.fn()), emit: vi.fn() });

  return {
    calls,
    results,
    httpGet: provider('GET'),
    httpPost: provider('POST'),
    httpPut: provider('PUT'),
    httpPatch: provider('PATCH'),
    httpDelete: provider('DELETE'),
    httpRequest: vi.fn(),
    stubProvider: vi.fn((name: string, defaultValue: unknown) => ({
      provider: vi.fn(),
      invoke: vi.fn(async () => defaultValue),
    })),
    withResponseMap: vi.fn(
      (
        inner: { provider: unknown; invoke: (params?: unknown) => Promise<unknown> },
        map: (raw: unknown) => unknown
      ) => ({
        provider: inner.provider,
        invoke: vi.fn(async (params?: unknown) => map(await inner.invoke(params))),
      })
    ),
    wsEmitter: vi.fn(emitter),
    wsMappedEmitter: vi.fn(emitter),
    stubEmitter: vi.fn(emitter),
  };
});

vi.mock('@/common/adapter/httpBridge', () => httpBridgeMocks);

vi.mock('@/common/platform/bridge', () => ({
  bridge: {
    buildProvider: vi.fn(() => ({
      provider: vi.fn(),
      invoke: vi.fn(),
    })),
    buildEmitter: vi.fn(() => ({
      on: vi.fn(() => vi.fn()),
      emit: vi.fn(),
    })),
  },
}));

describe('ipcBridge conversation adapter', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    httpBridgeMocks.calls.length = 0;
    httpBridgeMocks.results.clear();
    continuationControl.mockReset();
  });

  it('persists Stop before cancelling Core and still cancels when media is unavailable', async () => {
    const { conversation } = await import('@/common/adapter/ipcBridge');
    vi.stubGlobal('window', { electronAPI: { getMediaServiceUiToken: vi.fn() } });
    continuationControl.mockImplementationOnce(async () => {
      expect(httpBridgeMocks.calls).toHaveLength(0);
      return { paused: true, epoch: 'stop' };
    });
    await conversation.stop.invoke({ conversation_id: 'stop-chat', turn_id: 'turn' });
    expect(continuationControl).toHaveBeenCalledWith('stop-chat', 'pause');
    expect(httpBridgeMocks.calls[0].path).toBe('/api/conversations/stop-chat/cancel');
    continuationControl.mockRejectedValueOnce(new Error('media unavailable'));
    await expect(conversation.stop.invoke({ conversation_id: 'stop-chat', turn_id: 'turn2' })).resolves.toBe(true);
    expect(httpBridgeMocks.calls[1].path).toBe('/api/conversations/stop-chat/cancel');
  });

  it('keeps ordinary WebUI sends independent of media and empty sends cannot resume', async () => {
    const { conversation } = await import('@/common/adapter/ipcBridge');
    vi.stubGlobal('window', {});
    await conversation.sendMessage.invoke({ conversation_id: 'web', input: 'hello' });
    vi.stubGlobal('window', { electronAPI: { getMediaServiceUiToken: vi.fn() } });
    await conversation.sendMessage.invoke({ conversation_id: 'empty', input: '  ' });
    expect(continuationControl).not.toHaveBeenCalled();
  });

  it('does not fail an ordinary user send when media control is unavailable', async () => {
    const { conversation } = await import('@/common/adapter/ipcBridge');
    vi.stubGlobal('window', { electronAPI: { getMediaServiceUiToken: vi.fn() } });
    continuationControl.mockRejectedValueOnce(new Error('offline'));
    await expect(conversation.sendMessage.invoke({ conversation_id: 'ordinary', input: 'hi' })).resolves.toBe(true);
    expect(httpBridgeMocks.calls[0].path).toBe('/api/conversations/ordinary/messages');
  });

  it('resumes only after Core accepts explicit user work, preserving failed sends', async () => {
    const { conversation } = await import('@/common/adapter/ipcBridge');
    vi.stubGlobal('window', { electronAPI: { getMediaServiceUiToken: vi.fn() } });
    continuationControl.mockResolvedValue({ paused: true, epoch: 'saved-stop' });
    httpBridgeMocks.results.set('/api/conversations/resume/messages', async () => {
      expect(continuationControl.mock.calls).toEqual([['resume', 'status']]);
      return { turn_id: 'accepted', msg_id: 'user-message' };
    });
    await conversation.sendMessage.invoke({ conversation_id: 'resume', input: 'continue' });
    expect(continuationControl.mock.calls).toEqual([
      ['resume', 'status'],
      ['resume', 'resume', 'saved-stop'],
    ]);
    continuationControl.mockClear();
    httpBridgeMocks.results.set('/api/conversations/resume/messages', async () => {
      throw new Error('rejected');
    });
    await expect(conversation.sendMessage.invoke({ conversation_id: 'resume', input: 'continue' })).rejects.toThrow(
      'rejected'
    );
    expect(continuationControl.mock.calls).toEqual([['resume', 'status']]);
  });

  it('never lets an in-flight user send undo a newer Stop', async () => {
    const { conversation } = await import('@/common/adapter/ipcBridge');
    vi.stubGlobal('window', { electronAPI: { getMediaServiceUiToken: vi.fn() } });
    continuationControl.mockResolvedValue({ paused: true, epoch: 'old-stop' });
    httpBridgeMocks.results.set('/api/conversations/racing/messages', async () => {
      await conversation.stop.invoke({ conversation_id: 'racing', turn_id: 'new-stop' });
      return { turn_id: 'accepted', msg_id: 'user-message' };
    });
    await conversation.sendMessage.invoke({ conversation_id: 'racing', input: 'continue' });
    expect(continuationControl.mock.calls).toEqual([
      ['racing', 'status'],
      ['racing', 'pause'],
    ]);
  });

  it('deletes conversations through the standard conversation endpoint', async () => {
    const { conversation } = await import('@/common/adapter/ipcBridge');

    await conversation.remove.invoke({ id: 'conv-1' });

    expect(httpBridgeMocks.calls).toContainEqual({
      method: 'DELETE',
      path: '/api/conversations/conv-1',
      body: undefined,
    });
  });

  // Not formality: when the body mapping drops `sessions`, NEITHER side errors.
  // The user picks a target with `@@`, the message sends fine, and the agent
  // simply never sees the session block — the most likely silent failure in the
  // whole feature.
  it('puts `@@` session references on the wire', async () => {
    const { conversation } = await import('@/common/adapter/ipcBridge');

    await conversation.sendMessage.invoke({
      input: 'ask them',
      conversation_id: 'conv-1',
      sessions: [{ id: 'conv-target' }],
    });

    const call = httpBridgeMocks.calls.find((entry) => entry.path === '/api/conversations/conv-1/messages');
    expect(call).toBeDefined();
    expect(call?.body).toMatchObject({ content: 'ask them', sessions: [{ id: 'conv-target' }] });
  });

  it('omits `sessions` entirely when the user referenced nothing', async () => {
    const { conversation } = await import('@/common/adapter/ipcBridge');

    await conversation.sendMessage.invoke({ input: 'plain', conversation_id: 'conv-2' });

    const call = httpBridgeMocks.calls.find((entry) => entry.path === '/api/conversations/conv-2/messages');
    expect(call).toBeDefined();
    expect((call?.body as { sessions?: unknown } | undefined)?.sessions).toBeUndefined();
  });

  it('reads the cross-session master switch off the typed settings endpoint, not the client KV', async () => {
    // Channel matters: this switch is a typed column (migration 040), so it must
    // NOT go through `/api/settings/client`.
    const { systemSettings } = await import('@/common/adapter/ipcBridge');

    await systemSettings.setCrossSessionMessageEnabled.invoke({ enabled: false });

    expect(httpBridgeMocks.calls).toContainEqual({
      method: 'PATCH',
      path: '/api/settings',
      body: { cross_session_message_enabled: false },
    });
  });

  it('builds the mentionable query with the current conversation excluded', async () => {
    const { sessionMention } = await import('@/common/adapter/ipcBridge');

    await sessionMention.list.invoke({ current_conversation_id: 'conv-here', q: 'auth', limit: 20 });

    const call = httpBridgeMocks.calls.find((entry) => entry.path.startsWith('/api/session-messages/mentionable'));
    expect(call?.path).toContain('current_conversation_id=conv-here');
    expect(call?.path).toContain('q=auth');
    expect(call?.path).toContain('limit=20');
  });
});
