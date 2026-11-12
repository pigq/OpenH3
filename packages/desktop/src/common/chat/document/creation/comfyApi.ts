import type {
  ComfyFamily,
  ComfyGenerationJob,
  ComfyInstallIdentityRequest,
  ComfyInstallPreparation,
  ComfyIntent,
  ComfyOperation,
  ComfyProfile,
  ComfyInventory,
} from './comfy';
import type { TemplateSnapshot } from '@/common/contentCatalog/snapshot';
import type { LocalModelCenterSnapshot, LocalModelInstallContext } from './workflows/localModels';
import type { ModelConstraint, WorkflowSelectionMode } from './workflows/contracts';

// The inventory envelope and the historical profile array are different cache
// contracts. Never share their keys: both consumers can stay mounted in a chat.
export const COMFY_INVENTORY_CACHE_KEY = 'creation.comfy-inventory';

/** Client for the application-owned local ComfyUI service. */
async function request<T>(route: string, payload?: unknown, timeout = 45_000): Promise<T> {
  const port =
    typeof window !== 'undefined' ? (window as Window & { __mediaServicePort?: number }).__mediaServicePort : undefined;
  const uiToken =
    typeof window !== 'undefined' && window.electronAPI?.getMediaServiceUiToken
      ? await window.electronAPI.getMediaServiceUiToken()
      : null;
  const isConsentAction = route.includes('/authorize') || route === '/api/comfy/continuation-control';
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
    saved.profileId !== install.profileId ||
    (install.installContext !== undefined &&
      saved.installContext?.installDirectory !== install.installContext.installDirectory)
  )
    throw new Error('COMFY_INSTALL_REQUEST_ID_CONFLICT');
  return operation;
}
export const comfyApi = {
  modelCenter: (directory?: string): Promise<LocalModelCenterSnapshot> =>
    request(`/api/comfy/model-center${directory ? `?directory=${encodeURIComponent(directory)}` : ''}`),
  continuationControl: (
    conversationId: string,
    action: 'status' | 'pause' | 'resume',
    epoch?: string
  ): Promise<{ epoch: string; paused: boolean }> =>
    request('/api/comfy/continuation-control', { conversationId, action, epoch }, action === 'status' ? 500 : 2000),
  selection: async (
    requestId: string
  ): Promise<{
    requestId: string;
    conversationId: string;
    profileId?: string;
    family?: ComfyFamily;
    source?: 'local' | 'cloud';
    kind?: 'image' | 'video';
    intent: ComfyIntent;
    modelSetId?: string;
    workflowMode?: WorkflowSelectionMode;
    fixedWorkflowId?: string;
    selectionRevision?: number;
    modelConstraint?: ModelConstraint;
  }> => {
    const result = await request<{ selection: Awaited<ReturnType<typeof comfyApi.selection>> }>(
      `/api/comfy/activity?requestId=${encodeURIComponent(requestId)}`
    );
    return result.selection;
  },
  profiles: (): Promise<ComfyProfile[]> => request('/api/comfy/profiles'),
  inventory: (): Promise<ComfyInventory> => request('/api/comfy/profiles?inventory=1'),
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
  operation: (id: string, conversationId: string, requestId?: string): Promise<ComfyOperation> =>
    request(
      `/api/comfy/operations/${encodeURIComponent(id)}?conversationId=${encodeURIComponent(conversationId)}${requestId ? `&requestId=${encodeURIComponent(requestId)}` : ''}`
    ),
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
    context?: {
      source: 'local' | 'cloud';
      kind: 'image' | 'video';
      templateSnapshot?: TemplateSnapshot;
      modelSetId?: string;
      workflowMode?: WorkflowSelectionMode;
      fixedWorkflowId?: string;
      selectionRevision?: number;
      modelConstraint?: ModelConstraint;
      installContext?: LocalModelInstallContext;
    }
  ): Promise<{ ok: boolean }> =>
    request('/api/comfy/bind', { requestId, conversationId, profileId, family, intent, ...context }),
};
