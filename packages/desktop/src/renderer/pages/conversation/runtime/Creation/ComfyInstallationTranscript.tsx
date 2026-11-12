import React, { useState } from 'react';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import useSWR, { mutate } from 'swr';
import type { CreationRequest } from '@/common/chat/document/creation/creation';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import { prepareCreationEntry } from './prepareCreationEntry';
import { beginComfySelectionChange, useComfySelectionPending } from './useComfySelectionPending';
import ComfyOperationResult from './ComfyOperationResult';
import { ipcBridge } from '@/common';
import { useConversationRuntimeView } from '../useConversationRuntimeView';
import { emitter } from '@/renderer/utils/emitter';

/** Render the application-owned request even before an Agent turn exists. */
export function ComfyInstallationTranscript({
  conversationId,
  snapshot,
  showRequest,
}: {
  conversationId: string;
  snapshot: CreationRequest;
  showRequest: boolean;
}) {
  const { t } = useTranslation();
  const pending = useComfySelectionPending(conversationId);
  const runtime = useConversationRuntimeView(conversationId);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string>();
  const { data: localError } = useSWR<string | null>(['comfy.preparation-error', conversationId, snapshot.requestId]);
  const { data, error: unavailable } = useSWR(
    ['comfy.installation-transcript', conversationId],
    () => comfyApi.activity(conversationId),
    {
      refreshInterval: 1500,
    }
  );
  const operation = data?.operations.find(
    (item) => item.requestId === snapshot.requestId && item.conversationId === conversationId
  );
  const preparation = data?.preparations?.find(
    (item) => item.requestId === snapshot.requestId && item.conversationId === conversationId
  );
  const reason = retryError ?? localError ?? preparation?.error ?? snapshot.installationError;
  const failed =
    !pending &&
    !retrying &&
    preparation?.status !== 'detecting' &&
    (reason || unavailable || preparation?.status === 'interrupted');
  const retry = async () => {
    if (!snapshot.requestId || pending || retrying || runtime.isProcessing) return;
    const finish = beginComfySelectionChange(conversationId);
    setRetrying(true);
    setRetryError(undefined);
    let sending = false;
    try {
      await prepareCreationEntry(snapshot.requestId, conversationId, snapshot);
      runtime.markSendStarted();
      sending = true;
      const result = await ipcBridge.conversation.sendMessage.invoke({
        conversation_id: conversationId,
        input: t('guid.comfy.operation.agentRetry', { model: snapshot.name }),
        inject_skills: ['comfyui-local'],
      });
      runtime.markSendAccepted(result.turn_id, result.runtime, result.msg_id);
      emitter.emit('chat.history.refresh');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setRetryError(reason);
      if (sending) runtime.markSendFailed({ kind: 'ordinary', reason });
    } finally {
      await mutate(['comfy.installation-transcript', conversationId]).catch((): undefined => undefined);
      finish();
      setRetrying(false);
    }
  };
  // Ordinary Agent installation progress lives in the conversation. Do not
  // leave a synthetic "waiting for preparation" banner after its request sent.
  if (!showRequest && !operation && !preparation) return null;
  return (
    <section className='py-12px min-w-0' data-testid='comfy-installation-transcript'>
      {showRequest && (
        <div className='flex justify-end mb-16px'>
          <div className='bg-2 rd-8px p-12px max-w-full whitespace-pre-wrap break-words'>
            {snapshot.installationInput ||
              `${snapshot.name} · ${t(`guid.comfy.actions.${snapshot.intent ?? 'install'}`)}`}
          </div>
        </div>
      )}
      {operation ? (
        <ComfyOperationResult id={operation.id} conversationId={conversationId} compact />
      ) : (
        <div className='space-y-8px text-13px break-words'>
          <strong>{snapshot.name}</strong>
          {failed ? (
            <>
              <div role='alert'>
                {t('guid.comfy.operation.preparationFailed', {
                  reason: reason || t('guid.comfy.operation.unavailable'),
                })}
              </div>
              <Button size='small' disabled={runtime.isProcessing || retrying || pending} onClick={() => void retry()}>
                {t('common.retry')}
              </Button>
            </>
          ) : (
            <div role='status'>
              {t(
                preparation?.status === 'detecting'
                  ? 'conversation.workProgress.detecting'
                  : 'guid.comfy.operation.agentPreparing'
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
