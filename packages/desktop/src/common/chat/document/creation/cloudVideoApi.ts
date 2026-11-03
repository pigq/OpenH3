import type { CloudVideoConnectionInput, CloudVideoJob, PublicVideoConnection } from './cloudVideo';

function base(): string {
  const port =
    typeof window !== 'undefined' ? (window as Window & { __mediaServicePort?: number }).__mediaServicePort : undefined;
  return `http://127.0.0.1:${port ?? 33002}/api/cloud-video`;
}
async function request<T>(route: string, payload?: unknown): Promise<T> {
  const token =
    payload !== undefined && typeof window !== 'undefined' && window.electronAPI?.getMediaServiceUiToken
      ? await window.electronAPI.getMediaServiceUiToken()
      : undefined;
  const response = await fetch(base() + route, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-openh3-ui-token': token } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `CLOUD_VIDEO_HTTP_${response.status}`);
  return data as T;
}
export const cloudVideoApi = {
  connections: (): Promise<PublicVideoConnection[]> => request('/connections'),
  save: (input: CloudVideoConnectionInput): Promise<PublicVideoConnection> => request('/connections', input),
  bind: (requestId: string, conversationId: string, connectionId: string): Promise<{ ok: boolean }> =>
    request('/bind', { requestId, conversationId, connectionId }),
  job: (id: string, conversationId: string): Promise<CloudVideoJob> =>
    request(`/jobs/${encodeURIComponent(id)}?${new URLSearchParams({ conversationId })}`),
  artifactUrl: (id: string, conversationId: string): string =>
    `${base()}/jobs/${encodeURIComponent(id)}/content?${new URLSearchParams({ conversationId })}`,
};
