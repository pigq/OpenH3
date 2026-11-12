import type { ComfyFamily, ComfyIntent } from '@/common/chat/document/creation/comfy';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import { cloudVideoApi } from '@/common/chat/document/creation/cloudVideoApi';
import type { TemplateSnapshot } from '@/common/contentCatalog/snapshot';
import { ipcBridge } from '@/common';
import type { CreationRequest } from '@/common/chat/document/creation/creation';
import type { TChatConversation } from '@/common/config/storage';
import { mutate } from 'swr';

type Entry = {
  id?: string;
  profileId?: string;
  family?: ComfyFamily;
  intent?: ComfyIntent;
  source?: 'local' | 'cloud';
  kind?: 'image' | 'video';
  templateSnapshot?: TemplateSnapshot;
  installationInput?: string;
} & Pick<CreationRequest, 'modelSetId' | 'workflowMode' | 'fixedWorkflowId' | 'modelConstraint' | 'installContext'>;
const pending = new Map<string, Promise<undefined>>();

/** Bind the card selection; the session Agent owns planning and installation tool calls. */
export function prepareCreationEntry(requestId: string, conversationId: string, entry: Entry): Promise<undefined> {
  const key = JSON.stringify([requestId, conversationId, entry]);
  const prior = pending.get(key);
  if (prior) return prior;
  const request = (async (): Promise<undefined> => {
    await mutate(['comfy.preparation-error', conversationId, requestId], null, false);
    if (entry.source === 'cloud' && entry.kind === 'video') {
      if (!entry.id?.startsWith('cloud-video:')) throw new Error('CLOUD_VIDEO_CONNECTION_MISSING');
      const bound = await cloudVideoApi.bind(requestId, conversationId, entry.id.slice('cloud-video:'.length));
      if (!bound.ok) throw new Error('CLOUD_VIDEO_BIND_FAILED');
    }
    const bound = await comfyApi.bind(requestId, conversationId, entry.profileId, entry.family, entry.intent, {
      source: entry.source ?? 'local',
      kind: entry.kind ?? 'image',
      templateSnapshot: entry.templateSnapshot,
      modelSetId: entry.modelConstraint?.modelSetId ?? entry.modelSetId,
      workflowMode: entry.modelConstraint?.workflowMode ?? entry.workflowMode,
      fixedWorkflowId: entry.modelConstraint?.fixedWorkflowId ?? entry.fixedWorkflowId,
      selectionRevision: entry.modelConstraint?.selectionRevision,
      modelConstraint: entry.modelConstraint,
      installContext: entry.installContext,
    });
    if (!bound.ok) throw new Error('COMFY_BIND_FAILED');
    return undefined;
  })().catch(async (error: unknown): Promise<undefined> => {
    await mutate(
      ['comfy.preparation-error', conversationId, requestId],
      error instanceof Error ? error.message : String(error),
      false
    );
    // Binding can fail before the service has persisted a preparation record.
    if (entry.installationInput !== undefined) {
      try {
        const conversation = await ipcBridge.conversation.get.invoke({ id: conversationId });
        const snapshot = (conversation.extra as { creation_request?: CreationRequest }).creation_request;
        if (snapshot?.requestId === requestId) {
          await ipcBridge.conversation.update.invoke({
            id: conversationId,
            updates: {
              extra: {
                creation_request: {
                  ...snapshot,
                  installationError: error instanceof Error ? error.message : String(error),
                },
              } as TChatConversation['extra'],
            },
            merge_extra: true,
          });
          await mutate(`conversation/${conversationId}`);
        }
      } catch {
        // The service's preparation record and the retained draft remain recoverable.
      }
    }
    const localGoal = entry.source !== 'cloud' && Boolean(entry.family);
    const detail = error instanceof Error ? error.message : String(error);
    // Deliver the original goal for diagnosis even when a local profile or
    // optional integration is unavailable. Tool-level selection checks still apply.
    if (
      localGoal &&
      !/COMFY_(?:FAMILY_MISMATCH|PROFILE_ID_MISMATCH|SELECTION_CHANGED|CONVERSATION_MISMATCH|CONVERSATION_UNAVAILABLE|REQUEST_MISMATCH|SCOPE_MISMATCH)/.test(
        detail
      )
    )
      return undefined;
    throw error;
  });
  pending.set(key, request);
  void request.finally(() => pending.delete(key)).catch((): undefined => undefined);
  return request;
}
