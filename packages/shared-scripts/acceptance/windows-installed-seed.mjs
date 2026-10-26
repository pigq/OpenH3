import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

function assertNoIdentity(c, baseline) {
  assert.equal(c.id, baseline.conversationId);
  assert.equal(c.name, baseline.marker);
  assert.equal(c.type, 'acp');
  assert.equal(c.assistant == null, true, 'Unexpected assistant; do not send');
  assert.equal(!!c.extra && typeof c.extra === 'object' && !Array.isArray(c.extra), true);
  for (const key of ['backend', 'agent_id', 'preset_assistant_id'])
    assert.equal(key in c.extra, false, `Unexpected ${key}; do not send`);
  assert.equal(!('agent_source' in c.extra) || c.extra.agent_source === 'builtin', true);
  assert.equal(c.extra.workspace, baseline.workspaceDir);
}

function assertIdle(runtime) {
  assert.equal(runtime?.state, 'idle');
  assert.equal(runtime.can_send_message, true);
  assert.equal(runtime.has_task, false);
  assert.equal(runtime.task_status, null);
  assert.equal(runtime.is_processing, false);
  assert.equal(runtime.pending_confirmations, 0);
  assert.equal(runtime.turn_id, null);
}

function historyRows(messages, marker, conversationId, send) {
  assert.equal(Array.isArray(messages?.items), true);
  const user = messages.items.find(
    (m) => m.type === 'text' && m.position === 'right' && m.status === 'finish' && m.content?.content === marker
  );
  const tip = messages.items.find(
    (m) => m.type === 'tips' && m.position === 'center' && m.status === 'error' && m.content?.source === 'send_failed'
  );
  assert.ok(user && tip, 'Real persisted user row and failed-send tip are required');
  assert.equal(user.id, send?.msg_id, 'Persisted user row must match this POST message');
  for (const row of [user, tip]) {
    assert.equal(typeof row.id, 'string');
    assert.ok(row.id);
    assert.equal(row.conversation_id, conversationId);
    assert.equal(Number.isFinite(row.created_at) && row.created_at > 0, true);
  }
  return [user, tip];
}

export function assertSeedSnapshot({ conversation, settings, messages }, baseline) {
  assertNoIdentity(conversation, baseline);
  assertIdle(conversation.runtime);
  for (const [key, value] of Object.entries(baseline.settings)) assert.deepEqual(settings[key], value);
  if (baseline.history) {
    historyRows(messages, baseline.marker, baseline.conversationId, baseline.send);
    for (const expected of baseline.messages) {
      const actual = messages.items.find((m) => m.id === expected.id);
      assert.ok(actual, `Missing persisted message ${expected.id}`);
      for (const key of ['id', 'conversation_id', 'type', 'content', 'position', 'status', 'hidden', 'created_at'])
        assert.deepEqual(actual[key], expected[key], `Changed message ${expected.id}.${key}`);
    }
  }
}

// request is the ordinary local backend HTTP adapter, not a synthetic DB writer.
export async function seedInstalledProfile({
  request,
  marker,
  workspaceDir,
  history = 'expected-no-agent-failure',
  timeoutMs = 30_000,
}) {
  if (!marker || !/^[a-z]:\\/i.test(workspaceDir) || ![false, 'expected-no-agent-failure'].includes(history))
    throw Error('Invalid seed inputs');
  const settings = { 'acceptance.upgradeMarker': marker, language: 'zh-CN', 'system.closeToTray': false };
  await request('PUT', '/api/settings/client', settings);
  const created = await request('POST', '/api/conversations', {
    type: 'acp',
    name: marker,
    extra: { workspace: workspaceDir },
  });
  if (typeof created?.id !== 'string' || !created.id) throw Error('Conversation create returned no ID');
  const route = `/api/conversations/${encodeURIComponent(created.id)}`;
  const baseline = { marker, workspaceDir, conversationId: created.id, settings, history, messages: [] };
  // GET the newly-created row before send. Missing identity is intentional and
  // statically verified to error before CLI/provider spawn in both real versions.
  assertNoIdentity(await request('GET', route), baseline);
  if (history) {
    const sent = await request('POST', `${route}/messages`, { content: marker });
    for (const key of ['msg_id', 'turn_id'])
      assert.ok(typeof sent?.[key] === 'string' && sent[key], `POST message missing ${key}`);
    assert.notEqual(sent.delivered_midturn, true, 'New conversation must not inject an existing turn');
    baseline.send = { msg_id: sent.msg_id, turn_id: sent.turn_id };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const conversation = await request('GET', route);
      const messages = await request('GET', `${route}/messages?limit=100`);
      try {
        assertNoIdentity(conversation, baseline);
        assertIdle(conversation.runtime);
        baseline.messages = historyRows(messages, marker, baseline.conversationId, baseline.send);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await sleep(100);
      }
    }
  }
  await verifyInstalledProfile({ request, baseline });
  return baseline;
}

export async function verifyInstalledProfile({ request, baseline }) {
  const route = `/api/conversations/${encodeURIComponent(baseline.conversationId)}`;
  const conversation = await request('GET', route);
  const settings = await request(
    'GET',
    `/api/settings/client?keys=${Object.keys(baseline.settings).map(encodeURIComponent).join(',')}`
  );
  const messages = baseline.history ? await request('GET', `${route}/messages?limit=100`) : undefined;
  assertSeedSnapshot({ conversation, settings, messages }, baseline);
  return { conversation, settings, messages };
}

export function installedBackendRequest(page) {
  return (method, route, body) =>
    page.evaluate(
      async ({ method, route, body }) => {
        const port = window.__backendPort;
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !route.startsWith('/api/') || route.startsWith('//'))
          throw Error('Normal local backend is not ready');
        const current = await fetch(`http://127.0.0.1:${port}/api/system/current-user`, {
          signal: AbortSignal.timeout(10_000),
        });
        const identity = await current.json();
        if (!current.ok || identity?.success !== true || identity.data?.id !== 'system_default_user')
          throw Error('Expected normal local desktop backend');
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
        const result = await response.json();
        if (!response.ok || result?.success !== true)
          throw Error(`Backend ${method} ${route} failed (${response.status})`);
        return result.data;
      },
      { method, route, body }
    );
}
