import type {
  ComfyGenerationJob,
  ComfyInstallPreparation,
  ComfyOperation,
} from '@/common/chat/document/creation/comfy';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import { creationOperationIds, h3ToolJobIds } from '@/common/chat/document/creation/toolResults';
import { h3JobApi } from '@/common/chat/document/h3JobApi';
import type { CreationOperation } from '@/common/chat/document/creation/operation';
import { useMessageList } from '@/renderer/pages/conversation/Messages/hooks';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useH3Jobs } from '@/renderer/pages/conversation/runtime/Creation/useH3Jobs';
import { useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { projectWorkProgress, publishWorkProgress, workComfyIds } from './workProgress';

/** Mounted inside each chat's message provider; publishes to both right-panel hosts above that provider. */
export default function WorkProgressBridge({ conversationId }: { conversationId: string }): null {
  const messages = useMessageList();
  const runtime = useConversationRuntimeView(conversationId);
  const activeConversation = useCurrentConversation();
  const ids = useMemo(() => workComfyIds(messages), [messages]);
  const creationIds = useMemo(() => creationOperationIds(messages), [messages]);
  const { data: creationData } = useSWR(
    activeConversation === conversationId && creationIds.length ? ['work.creation', conversationId, creationIds] : null,
    async () => {
      const operations: CreationOperation[] = [];
      const unavailable: string[] = [];
      await Promise.all(
        creationIds.map(async (id) => {
          try {
            const operation = await h3JobApi.creationOperation(id);
            if (operation.id === id && operation.conversationId === conversationId) operations.push(operation);
            else unavailable.push(id);
          } catch {
            unavailable.push(id);
          }
        })
      );
      return { operations, unavailable };
    },
    {
      refreshInterval: (current) =>
        !current ||
        current.unavailable.length ||
        current.operations.some(
          (operation) => !['submitted', 'failed', 'paused', 'cancelled'].includes(operation.state)
        )
          ? 1500
          : 5000,
    }
  );
  const h3Ids = useMemo(
    () => [
      ...new Set([
        ...h3ToolJobIds(messages),
        ...(creationData?.operations ?? []).flatMap((operation) => (operation.jobId ? [operation.jobId] : [])),
      ]),
    ],
    [messages, creationData]
  );
  const h3Snapshots = useH3Jobs(activeConversation === conversationId ? h3Ids : []);
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
        data?.preparations,
        {
          jobs: h3Snapshots.flatMap((snapshot) => (snapshot.job ? [snapshot.job] : [])),
          unavailable: h3Ids.filter((_id, index) => h3Snapshots[index]?.unavailable),
          operations: creationData?.operations,
          unavailableOperations: creationData?.unavailable,
        }
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
    h3Snapshots,
    h3Ids,
    creationData,
  ]);
  return null;
}
