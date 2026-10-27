import type {
  ComfyFamily,
  ComfyGenerationJob,
  ComfyInstallIdentityRequest,
  ComfyInstallPreparation,
  ComfyIntent,
  ComfyOperation,
  ComfyProfile,
} from './comfy';
import type { TemplateSnapshot } from '@/common/contentCatalog/snapshot';

/** Client for the application-owned local ComfyUI service. */
async function request<T>(route: string, payload?: unknown, timeout = 45_000): Promise<T> {
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
    signal: AbortSignal.timeout(timeout),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `COMFY_SERVICE_HTTP_${response.status}`);
  return result;
}
function matchingInstallation(operation: ComfyOperation, install: ComfyInstallIdentityRequest): ComfyOperation {
  const saved = operation.installRequest;
  if (
    !saved ||
    saved.family !== install.family ||
    saved.intent !== install.intent ||
    saved.profileId !== install.profileId
  )
    throw new Error('COMFY_INSTALL_REQUEST_ID_CONFLICT');
  return operation;
}
export const comfyApi = {
  profiles: (): Promise<ComfyProfile[]> => request('/api/comfy/profiles'),
  activity: (
    conversationId: string
  ): Promise<{ operations: ComfyOperation[]; jobs: ComfyGenerationJob[]; preparations: ComfyInstallPreparation[] }> =>
    request(`/api/comfy/activity?conversationId=${encodeURIComponent(conversationId)}`),
  requestInstall: async (
    requestId: string,
    conversationId: string,
    install: ComfyInstallIdentityRequest
  ): Promise<ComfyOperation> => {
    // Recover the existing operation before submitting, including after a lost response.
    const activity = await comfyApi.activity(conversationId);
    const existing = activity.operations.find((operation) => operation.requestId === requestId);
    if (existing) return matchingInstallation(existing, install);
    try {
      return await request('/api/comfy/operations', { requestId, install: { ...install, requestId } }, 300_000);
    } catch (cause) {
      // A timeout is not evidence that the backend rejected the request. Read it
      // back by identity; never POST a replacement operation automatically.
      const recovered = await comfyApi.activity(conversationId).catch((): undefined => undefined);
      const operation = recovered?.operations.find((item) => item.requestId === requestId);
      if (operation) return matchingInstallation(operation, install);
      throw cause;
    }
  },
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
