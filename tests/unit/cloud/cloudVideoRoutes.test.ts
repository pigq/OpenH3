import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudVideoService } from '@/process/services/media/cloud/CloudVideoService';
import { handleCloudVideoRoute } from '@/process/services/media/cloud/routes';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).toReversed()) await fn();
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-routes-'));
  const service = new CloudVideoService({
    root,
    adapter: () => ({
      submit: async () => ({ id: 'remote', status: 'queued' }),
      retrieve: async () => ({ id: 'remote', status: 'completed' }),
      download: async () => new Response(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])),
    }),
  });
  const server = http.createServer(async (req, res) => {
    const json = (_res: http.ServerResponse, status: number, data: unknown): void => {
      _res.writeHead(status, { 'content-type': 'application/json' });
      _res.end(JSON.stringify(data));
    };
    try {
      await handleCloudVideoRoute(req, res, new URL(req.url!, 'http://localhost'), {
        service,
        uiToken: 'ui-test',
        json,
        body: async (incoming) => {
          let text = '';
          for await (const chunk of incoming) text += chunk;
          return JSON.parse(text);
        },
      });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (route: string, payload: unknown, token?: string) =>
    fetch(base + '/api/cloud-video/' + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-openh3-ui-token': token } : {}) },
      body: JSON.stringify(payload),
    });
  return { service, base, post };
}
describe('cloud video local routes', () => {
  it('requires the UI capability for connection writes and never returns keys', async () => {
    const { base, post } = await fixture();
    const input = { name: 'H3', protocol: 'vllm-h3', baseUrl: 'http://cloud/v1', apiKey: 'never-return-me' };
    expect((await post('connections', input)).status).toBe(403);
    const response = await post('connections', input, 'ui-test');
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('never-return-me');
    expect(await (await fetch(base + '/api/cloud-video/connections')).text()).not.toContain('never-return-me');
  });
  it('binds the session, deduplicates POSTs and serves seekable local artifacts', async () => {
    const { service, base, post } = await fixture();
    const connection = service.saveConnection({ name: 'H3', protocol: 'vllm-h3', baseUrl: 'http://cloud/v1' });
    const requestId = '12345678-1234-4234-8234-123456789abc';
    const bind = { requestId, conversationId: 'conversation', connectionId: connection.id };
    expect((await post('bind', bind)).status).toBe(403);
    expect((await post('bind', bind, 'ui-test')).status).toBe(200);
    const payload = { requestId, submissionId: requestId, input: { prompt: 'fox' } };
    const job = (await (await post('jobs', payload)).json()) as { id: string };
    expect(await (await post('jobs', payload)).json()).toMatchObject({ id: job.id });
    await service.poll();
    expect((await fetch(`${base}/api/cloud-video/jobs/${job.id}?conversationId=wrong`)).status).toBe(400);
    const url = `${base}/api/cloud-video/jobs/${job.id}/content?conversationId=conversation`;
    const response = await fetch(url, { headers: { range: 'bytes=4-7' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('ftyp');
    expect((await fetch(url, { headers: { range: 'bytes=999-' } })).status).toBe(416);
  });
});
