import type {
  ComfyGenerationJob,
  ComfyInstallPreparation,
  ComfyOperation,
} from '@/common/chat/document/creation/comfy';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import { useMessageList } from '@/renderer/pages/conversation/Messages/hooks';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { projectWorkProgress, publishWorkProgress, workComfyIds } from './workProgress';

/** Mounted inside each chat's message provider; publishes to both right-panel hosts above that provider. */
export default function WorkProgressBridge({ conversationId }: { conversationId: string }): null {
  const messages = useMessageList();
  const runtime = useConversationRuntimeView(conversationId);
  const activeConversation = useCurrentConversation();
  const ids = useMemo(() => workComfyIds(messages), [messages]);
  const { data } = useSWR(
    activeConversation === conversationId ? ['comfy.activity', conversationId] : null,
    async () => {
      try {
        const activity = await comfyApi.activity(conversationId);
        return {
          operations: activity.operations.filter((operation) => operation.conversationId === conversationId),
          jobs: activity.jobs,
          preparations: (activity.preparations ?? []).filter((item) => item.conversationId === conversationId),
          unavailable: [] as string[],
        };
      } catch (error) {
        // Older hosts may only support lookup by ids persisted in tool cards.
        if (!ids.operations.length && !ids.jobs.length) throw error;
      }
      const operations: ComfyOperation[] = [];
      const jobs: ComfyGenerationJob[] = [];
      const unavailable: string[] = [];
      await Promise.all([
        ...ids.operations.map(async (id) => {
          try {
            const operation = await comfyApi.operation(id, conversationId);
            if (operation.conversationId === conversationId) operations.push(operation);
            else unavailable.push(id);
          } catch {
            unavailable.push(id);
          }
        }),
        ...ids.jobs.map(async (id) => {
          try {
            jobs.push(await comfyApi.job(id, conversationId));
          } catch {
            unavailable.push(id);
          }
        }),
      ]);
      return { operations, jobs, unavailable, preparations: [] as ComfyInstallPreparation[] };
    },
    {
      refreshInterval: (current) =>
        !current ||
        current.unavailable.length ||
        current.preparations.some((item) => item.status === 'detecting') ||
        current.operations.some((item) => !['completed', 'cancelled', 'failed', 'paused'].includes(item.state)) ||
        current.jobs.some((item) => ['queued', 'running'].includes(item.status))
          ? 1500
          : 5000,
      revalidateOnFocus: true,
    }
  );
  useEffect(() => {
    publishWorkProgress(
      conversationId,
      projectWorkProgress(
        messages,
        {
          isProcessing: runtime.isProcessing,
          pendingConfirmations: runtime.view.pendingConfirmations,
          hydrated: runtime.hydrated,
          activeTurnId: runtime.activeTurnId,
        },
        data?.operations,
        data?.jobs,
        data?.unavailable,
        data?.preparations
      )
    );
  }, [
    conversationId,
    messages,
    runtime.isProcessing,
    runtime.view.pendingConfirmations,
    runtime.hydrated,
    runtime.activeTurnId,
    data,
  ]);
  return null;
}
