import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  assertSeedSnapshot,
  seedInstalledProfile,
  verifyInstalledProfile,
  installedBackendRequest,
} from './windows-installed-seed.mjs';

const marker = 'upgrade-123-中文';
const workspaceDir = 'D:\\runner\\work';
const conversation = {
  id: 'conversation-1',
  name: marker,
  type: 'acp',
  extra: { workspace: workspaceDir },
  runtime: {
    state: 'idle',
    can_send_message: true,
    has_task: false,
    task_status: null,
    is_processing: false,
    pending_confirmations: 0,
    turn_id: null,
  },
};
const settings = { 'acceptance.upgradeMarker': marker, language: 'zh-CN', 'system.closeToTray': false };
const messages = {
  items: [
    {
      id: 'user-1',
      conversation_id: conversation.id,
      created_at: 1,
      type: 'text',
      position: 'right',
      status: 'finish',
      content: { content: marker },
    },
    {
      id: 'tip-1',
      conversation_id: conversation.id,
      created_at: 2,
      type: 'tips',
      position: 'center',
      status: 'error',
      content: { source: 'send_failed', content: 'No ACP identity' },
    },
  ],
};
const baseline = {
  marker,
  workspaceDir,
  conversationId: conversation.id,
  settings,
  history: 'expected-no-agent-failure',
  send: { msg_id: 'user-1', turn_id: 'turn-1' },
  messages: messages.items,
};

test('snapshot requires actual idle conversation, settings, user row and genuine failed-send tip', () => {
  assert.doesNotThrow(() => assertSeedSnapshot({ conversation, settings, messages }, baseline));
  for (const changed of [
    { conversation: { ...conversation, runtime: { ...conversation.runtime, state: 'running' } } },
    { conversation: { ...conversation, runtime: { ...conversation.runtime, has_task: true } } },
    { conversation: { ...conversation, assistant: { id: 'accidental-agent' } } },
    { settings: { ...settings, language: 'en-US' } },
    { messages: { items: [messages.items[0]] } },
    { messages: { items: [{ ...messages.items[0], id: 'different-row' }, messages.items[1]] } },
  ])
    assert.throws(() => assertSeedSnapshot({ conversation, settings, messages, ...changed }, baseline));
  assert.throws(() =>
    assertSeedSnapshot(
      {
        conversation,
        settings,
        messages: { items: messages.items.map((m) => ({ ...m, conversation_id: 'other-conversation' })) },
      },
      { ...baseline, messages: messages.items.map((m) => ({ ...m, conversation_id: 'other-conversation' })) }
    )
  );
});

test('renderer adapter resolves fresh local backend port, enforces local identity and unwraps success', async () => {
  let local = true;
  const calls = [];
  const context = vm.createContext({
    AbortSignal,
    window: { __backendPort: 43001 },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/current-user')
            ? { success: true, data: { id: local ? 'system_default_user' : 'some-other-user' } }
            : { success: true, data: settings },
      };
    },
  });
  const page = { evaluate: (fn, argument) => vm.runInContext(`(${fn.toString()})`, context)(argument) };
  const request = installedBackendRequest(page);
  assert.deepEqual(await request('GET', '/api/settings/client?keys=language'), settings);
  context.window.__backendPort = 43002;
  await request('PUT', '/api/settings/client', settings);
  assert.ok(calls.at(-1).url.startsWith('http://127.0.0.1:43002/'));
  assert.equal(calls.at(-1).options.body, JSON.stringify(settings));
  local = false;
  const before = calls.length;
  await assert.rejects(request('PUT', '/api/settings/client', settings), /normal local desktop/);
  assert.equal(calls.length, before + 1, 'Identity failure must stop before mutation');
});

test('seed uses only real bounded API calls and verifies after a fresh backend port', async () => {
  const calls = [];
  const request = async (method, route, body) => {
    calls.push({ method, route, body });
    if (route.startsWith('/api/settings/client')) return method === 'PUT' ? undefined : settings;
    if (route === '/api/conversations') return conversation;
    if (route.endsWith('/messages') && method === 'POST') return { msg_id: 'user-1', turn_id: 't' };
    if (route.includes('/messages?')) return messages;
    return conversation;
  };
  const result = await seedInstalledProfile({ request, marker, workspaceDir, history: 'expected-no-agent-failure' });
  assert.equal(result.messages[0].id, 'user-1');
  assert.equal(result.send.msg_id, 'user-1');
  assert.equal(calls.find((x) => x.method === 'POST' && x.route.endsWith('/messages')).body.content, marker);
  assert.equal(calls.filter((x) => /ensure|agent|provider|model/.test(x.route)).length, 0);
  await verifyInstalledProfile({ request, baseline: result });
  await assert.rejects(
    seedInstalledProfile({
      marker,
      workspaceDir,
      timeoutMs: 0,
      request: async (method, route, body) => {
        const value = await request(method, route, body);
        return method === 'POST' && route.endsWith('/messages') ? { msg_id: 'unrelated-old-row', turn_id: 't' } : value;
      },
    }),
    /POST message/
  );
});

test('no-history mode never sends a message and unsafe identities fail before send', async () => {
  let sent = false;
  const request = async (method, route) => {
    if (method === 'POST' && route.endsWith('/messages')) sent = true;
    if (route.startsWith('/api/settings/client')) return method === 'GET' ? settings : undefined;
    return conversation;
  };
  const result = await seedInstalledProfile({ request, marker, workspaceDir, history: false });
  assert.equal(result.history, false);
  assert.equal(sent, false);
  await assert.rejects(
    seedInstalledProfile({
      marker,
      workspaceDir,
      history: 'expected-no-agent-failure',
      request: async (method, route, body) => {
        const result = await request(method, route, body);
        return route === '/api/conversations/conversation-1'
          ? { ...result, extra: { ...result.extra, backend: 'must-not-run' } }
          : result;
      },
    })
  );
  assert.equal(sent, false);
});
