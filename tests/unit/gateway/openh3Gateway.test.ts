import { describe, expect, it, vi } from 'vitest';
import worker from '../../../services/openh3-gateway/src/index';

const env = {
  UPSTREAM_BASE_URL: 'https://ai.realseek.wiki/v1',
  UPSTREAM_API_KEY: 'server-only-key',
  DEFAULT_MODEL: 'gpt-6-astra',
  DEFAULT_REASONING_EFFORT: 'low',
};

describe('OpenH3 Cloudflare gateway', () => {
  it('forwards Responses requests with server credentials and safe defaults', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );

    const response = await worker.fetch(
      new Request('https://gateway.example/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer client-supplied-value' },
        body: JSON.stringify({ input: 'hello' }),
      }),
      env
    );

    expect(response.status).toBe(200);
    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(upstreamUrl).toBe('https://ai.realseek.wiki/v1/responses');
    const upstreamHeaders = new Headers(upstreamInit.headers);
    expect(upstreamHeaders.get('authorization')).toBe('Bearer server-only-key');
    expect(upstreamHeaders.get('x-openh3-client')).toBeNull();
    expect(JSON.parse(String(upstreamInit.body))).toMatchObject({
      model: 'gpt-6-astra',
      reasoning: { effort: 'low' },
      input: 'hello',
    });
    fetchMock.mockRestore();
  });

  it('rejects unsupported paths without contacting the upstream provider', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockClear();
    const response = await worker.fetch(new Request('https://gateway.example/v1/chat/completions', { method: 'POST' }), env);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('forces the configured model and reasoning effort and lists only the supported model', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await worker.fetch(new Request('https://gateway.example/v1/responses', {
      method: 'POST', body: JSON.stringify({ model: 'other', reasoning: { effort: 'high' }, input: 'hello' }),
    }), env);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-6-astra', reasoning: { effort: 'low' } });
    const models = await worker.fetch(new Request('https://gateway.example/v1/models'), env);
    expect(await models.json()).toEqual({ object: 'list', data: [{ id: 'gpt-6-astra', object: 'model' }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it('rejects invalid bodies and oversized requests before forwarding', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockClear();
    const invalid = await worker.fetch(new Request('https://gateway.example/v1/responses', { method: 'POST', body: '[]' }), env);
    const oversized = await worker.fetch(new Request('https://gateway.example/v1/responses', {
      method: 'POST', body: JSON.stringify({ input: 'x'.repeat(1_000_001) }),
    }), env);
    expect(invalid.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
