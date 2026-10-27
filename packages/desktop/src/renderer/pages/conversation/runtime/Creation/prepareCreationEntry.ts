import type { ComfyFamily, ComfyIntent, ComfyOperation } from '@/common/chat/document/creation/comfy';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import type { TemplateSnapshot } from '@/common/contentCatalog/snapshot';

type Entry = {
  profileId?: string;
  family?: ComfyFamily;
  intent?: ComfyIntent;
  source?: 'local' | 'cloud';
  kind?: 'image' | 'video';
  templateSnapshot?: TemplateSnapshot;
};
const pending = new Map<string, Promise<ComfyOperation | undefined>>();

/** Bind the explicit card selection and submit installations without an LLM tool decision. */
export function prepareCreationEntry(
  requestId: string,
  conversationId: string,
  entry: Entry
): Promise<ComfyOperation | undefined> {
  const key = JSON.stringify([requestId, conversationId, entry]);
  const prior = pending.get(key);
  if (prior) return prior;
  const request = (async () => {
    const bound = await comfyApi.bind(requestId, conversationId, entry.profileId, entry.family, entry.intent, {
      source: entry.source ?? 'local',
      kind: entry.kind ?? 'image',
      templateSnapshot: entry.templateSnapshot,
    });
    if (!bound.ok) throw new Error('COMFY_BIND_FAILED');
    if (entry.source === 'cloud' || !entry.intent || entry.intent === 'generate') return undefined;
    if (!entry.family) throw new Error('COMFY_FAMILY_REQUIRED');
    return comfyApi.requestInstall(requestId, conversationId, {
      action: 'request',
      family: entry.family,
      intent: entry.intent,
      profileId: entry.profileId,
      requestId,
    });
  })();
  pending.set(key, request);
  void request.finally(() => pending.delete(key)).catch((): undefined => undefined);
  return request;
}
