import { Button } from '@arco-design/web-react';
import { CheckOne, CloseOne, PauseOne } from '@icon-park/react';
import { requestConversationSendBoxPrefill } from '@/renderer/hooks/chat/useSendBoxDraft';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ComfyOperationResult from '@/renderer/pages/conversation/runtime/Creation/ComfyOperationResult';
import { useWorkProgress, type WorkTask } from './workProgress';

export default function ConversationWorkProgress({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const snapshot = useWorkProgress(conversationId);
  const [openedOperations, setOpenedOperations] = useState<Set<string>>(() => new Set());
  const entries = snapshot.tasks.flatMap((task) => task.children ?? [task]);
  const completed = entries.filter((entry) => entry.status === 'completed').length;
  const toggleOperation = (id: string) =>
    setOpenedOperations((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const row = (task: WorkTask): React.ReactNode => (
    <div key={task.id} data-work-task={task.kind} data-status={task.status} className='flex flex-col gap-6px'>
      <div className='flex items-start gap-8px text-13px'>
        {task.status === 'completed' ? (
          <CheckOne size={16} theme='filled' className='text-success shrink-0 mt-1px' />
        ) : task.status === 'failed' ? (
          <CloseOne size={16} className='text-danger shrink-0 mt-1px' />
        ) : task.status === 'interrupted' || task.status === 'cancelled' ? (
          <PauseOne size={16} className='text-t-secondary shrink-0 mt-1px' />
        ) : (
          <span
            className={`size-14px rd-full b-2px b-solid shrink-0 mt-1px ${task.status === 'running' ? 'border-primary animate-pulse' : 'border-3'}`}
            aria-hidden='true'
          />
        )}
        <div className='min-w-0 flex-1'>
          <div className='break-words text-t-primary'>
            {task.title || t(`conversation.workProgress.kinds.${task.kind}`)}
          </div>
          <div className='text-11px text-t-secondary'>
            {task.preparing
              ? t('conversation.workProgress.detecting')
              : t(`conversation.workProgress.statuses.${task.status}`)}
          </div>
          {task.diagnosis && (
            <div className='text-12px text-t-secondary'>{t(`conversation.workProgress.${task.diagnosis}`)}</div>
          )}
          {task.detail && (
            <div className='text-12px text-t-secondary whitespace-pre-wrap break-words'>{task.detail}</div>
          )}
          {task.operationId && (
            <Button
              size='mini'
              type='text'
              aria-expanded={openedOperations.has(task.operationId)}
              onClick={() => {
                if (task.operationId) toggleOperation(task.operationId);
              }}
            >
              {t('guid.comfy.operation.details')}
            </Button>
          )}
          {task.operationId && openedOperations.has(task.operationId) && (
            <ComfyOperationResult id={task.operationId} conversationId={conversationId} />
          )}
        </div>
      </div>
      {task.children && <div className='pl-22px flex flex-col gap-10px'>{task.children.map(row)}</div>}
    </div>
  );
  return (
    <div data-testid='conversation-work-progress' className='h-full overflow-y-auto px-16px py-12px'>
      <div className='flex items-center justify-between gap-8px mb-12px'>
        <span className='text-14px font-semibold text-t-primary'>{t('conversation.workProgress.title')}</span>
        {!!entries.length && (
          <span className='text-12px text-t-secondary'>
            {t('conversation.planBar.progress', { completed, total: entries.length })}
          </span>
        )}
      </div>
      {snapshot.pendingConfirmations > 0 && (
        <p role='status' className='text-12px text-t-secondary'>
          {t('conversation.workProgress.waitingHint')}
        </p>
      )}
      {!entries.length ? (
        <div className='text-13px text-t-secondary'>{t('conversation.workProgress.empty')}</div>
      ) : (
        <div className='flex flex-col gap-16px'>{snapshot.tasks.map(row)}</div>
      )}
      {!snapshot.isProcessing &&
        snapshot.tasks.some(
          (task) => ['interrupted', 'failed'].includes(task.status) && task.kind !== 'generation' && !task.operationId
        ) && (
          <Button
            className='mt-12px'
            size='small'
            onClick={() =>
              requestConversationSendBoxPrefill(conversationId, t('conversation.workProgress.resumePrompt'))
            }
          >
            {t('conversation.workProgress.prepareResume')}
          </Button>
        )}
    </div>
  );
}
