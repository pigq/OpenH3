import type { ComfyFamily, ComfyGenerationJob, ComfyIntent, ComfyOperation, ComfyProfile } from './comfy';
import type { TemplateSnapshot } from '@/common/contentCatalog/snapshot';

/** Client for the application-owned local ComfyUI service. */
async function request<T>(route: string, payload?: unknown): Promise<T> {
  const port =
    typeof window !== 'undefined' ? (window as Window & { __mediaServicePort?: number }).__mediaServicePort : undefined;
  const uiToken =
    typeof window !== 'undefined' && window.electronAPI?.getMediaServiceUiToken
      ? await window.electronAPI.getMediaServiceUiToken()
      : null;
  const isConsentAction = route.includes('/authorize');
  const response = await fetch(`http://127.0.0.1:${port ?? 33002}${route}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(isConsentAction && uiToken ? { 'x-openh3-ui-token': uiToken } : {}),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(45_000),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `COMFY_SERVICE_HTTP_${response.status}`);
  return result;
}
export const comfyApi = {
  profiles: (): Promise<ComfyProfile[]> => request('/api/comfy/profiles'),
  operation: (id: string, conversationId: string): Promise<ComfyOperation> =>
    request(`/api/comfy/operations/${encodeURIComponent(id)}?conversationId=${encodeURIComponent(conversationId)}`),
  authorize: (id: string, conversationId: string): Promise<ComfyOperation> =>
    request(`/api/comfy/operations/${encodeURIComponent(id)}/authorize`, { conversationId }),
  cancel: (id: string, conversationId: string): Promise<ComfyOperation> =>
    request(`/api/comfy/operations/${encodeURIComponent(id)}/cancel`, { conversationId }),
  job: (id: string, conversationId: string): Promise<ComfyGenerationJob> =>
    request(`/api/comfy/jobs/${encodeURIComponent(id)}?conversationId=${encodeURIComponent(conversationId)}`),
  jobArtifactUrl: (id: string, index: number, conversationId: string): string => {
    const port =
      typeof window !== 'undefined'
        ? (window as Window & { __mediaServicePort?: number }).__mediaServicePort
        : undefined;
    return `http://127.0.0.1:${port ?? 33002}/api/comfy/jobs/${encodeURIComponent(id)}/artifacts/${index}?conversationId=${encodeURIComponent(conversationId)}`;
  },
  cancelJob: (id: string, conversationId: string): Promise<ComfyGenerationJob> =>
    request(`/api/comfy/jobs/${encodeURIComponent(id)}/cancel`, { conversationId }),
  bind: (
    requestId: string,
    conversationId: string,
    profileId?: string,
    family?: ComfyFamily,
    intent?: ComfyIntent,
    context?: { source: 'local' | 'cloud'; kind: 'image' | 'video'; templateSnapshot?: TemplateSnapshot }
  ): Promise<{ ok: boolean }> =>
    request('/api/comfy/bind', { requestId, conversationId, profileId, family, intent, ...context }),
};
