export type GatewayEnv = {
  UPSTREAM_BASE_URL: string;
  UPSTREAM_API_KEY: string;
  DEFAULT_MODEL?: string;
  DEFAULT_REASONING_EFFORT?: string;
};

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const corsHeaders = {
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-origin': '*',
};

function responseJson(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...jsonHeaders, ...extraHeaders } });
}

function upstreamUrl(env: GatewayEnv, path: string): string {
  return `${env.UPSTREAM_BASE_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function forward(request: Request, env: GatewayEnv, path: string): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > 1_000_000) return responseJson({ error: { code: 'REQUEST_TOO_LARGE' } }, 413, corsHeaders);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 1_000_000) {
    return responseJson({ error: { code: 'REQUEST_TOO_LARGE' } }, 413, corsHeaders);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
    payload = parsed as Record<string, unknown>;
  } catch {
    return responseJson({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } }, 400, corsHeaders);
  }

  payload.model = env.DEFAULT_MODEL || 'gpt-6-astra';
  payload.reasoning = { effort: env.DEFAULT_REASONING_EFFORT || 'low' };

  const headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${env.UPSTREAM_API_KEY}` });
  const upstreamResponse = await fetch(upstreamUrl(env, path), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: { 'content-type': upstreamResponse.headers.get('content-type') || 'application/json' },
  });
}

const worker = {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (url.pathname === '/health' && request.method === 'GET') return responseJson({ ok: true }, 200, corsHeaders);
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      return responseJson({ object: 'list', data: [{ id: env.DEFAULT_MODEL || 'gpt-6-astra', object: 'model' }] }, 200, corsHeaders);
    }
    if (url.pathname === '/v1/responses' && request.method === 'POST') {
      const response = await forward(request, env, 'responses');
      Object.entries(corsHeaders).forEach(([key, value]) => response.headers.set(key, value));
      return response;
    }
    return responseJson({ error: { code: 'NOT_FOUND' } }, 404, corsHeaders);
  },
};

export default worker;
