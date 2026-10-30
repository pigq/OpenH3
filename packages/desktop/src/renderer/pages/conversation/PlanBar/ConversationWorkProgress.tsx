import { Button } from '@arco-design/web-react';
import { Check, CloseOne, Down, PauseOne, Time } from '@icon-park/react';
import { requestConversationSendBoxPrefill } from '@/renderer/hooks/chat/useSendBoxDraft';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ComfyOperationResult from '@/renderer/pages/conversation/runtime/Creation/ComfyOperationResult';
import { useWorkProgress, type WorkStatus, type WorkTask } from './workProgress';
import styles from './WorkProgress.module.css';

const leafTasks = (tasks: WorkTask[]): WorkTask[] =>
  tasks.flatMap((task) => (task.children?.length ? leafTasks(task.children) : [task]));

export default function ConversationWorkProgress({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const snapshot = useWorkProgress(conversationId);
  const [openedOperations, setOpenedOperations] = useState<Set<string>>(() => new Set());
  const entries = leafTasks(snapshot.tasks);
  // A plan is already a checklist. Keep the wrapper in the projection for
  // identity/status aggregation, but render its entries directly like the
  // sketch instead of adding an extra "Plan" row above the checklist.
  const visibleTasks = snapshot.tasks.flatMap((task) =>
    task.kind === 'plan' && task.children ? task.children : [task]
  );
  const completed = entries.filter((entry) => entry.status === 'completed').length;
  const overallStatus: WorkStatus =
    snapshot.pendingConfirmations > 0
      ? 'waiting'
      : ((['failed', 'waiting', 'running', 'interrupted', 'pending', 'cancelled'] as const).find((status) =>
          entries.some((entry) => entry.status === status)
        ) ?? 'completed');
  const toggleOperation = (id: string) =>
    setOpenedOperations((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const row = (task: WorkTask): React.ReactNode => (
    <li key={task.id} data-work-task={task.kind} data-status={task.status} className={styles.task}>
      <div className={styles.taskRow} aria-current={task.status === 'running' ? 'step' : undefined}>
        <span
          className={styles.statusIcon}
          data-status={task.status}
          role='img'
          aria-label={t(`conversation.workProgress.statuses.${task.status}`)}
        >
          {task.status === 'completed' ? (
            <Check size={12} strokeWidth={4} fill='var(--text-white)' />
          ) : task.status === 'failed' ? (
            <CloseOne size={18} fill='var(--danger)' />
          ) : task.status === 'waiting' ? (
            <Time size={18} fill='var(--warning)' />
          ) : task.status === 'interrupted' || task.status === 'cancelled' ? (
            <PauseOne size={18} fill='var(--text-secondary)' />
          ) : (
            <span className={task.status === 'running' ? styles.spinner : styles.pendingIcon} aria-hidden='true' />
          )}
        </span>
        <div className='min-w-0 flex-1'>
          <div className={styles.taskTitle}>
            {task.summaryKey
              ? t(`conversation.workProgress.summaries.${task.summaryKey}`)
              : task.title || t(`conversation.workProgress.kinds.${task.kind}`)}
          </div>
          {task.preparing && <div className={styles.detail}>{t('conversation.workProgress.detecting')}</div>}
          {['failed', 'interrupted', 'waiting', 'cancelled'].includes(task.status) && (
            <div className={styles.detail}>{t(`conversation.workProgress.statuses.${task.status}`)}</div>
          )}
          {task.diagnosis && <div className={styles.detail}>{t(`conversation.workProgress.${task.diagnosis}`)}</div>}
          {task.generationWarning && (
            <div className={styles.detail}>{t(`conversation.h3Activity.${task.generationWarning}`)}</div>
          )}
          {task.detail && <div className={styles.detail}>{task.detail}</div>}
          {task.operationId && (
            <Button
              size='mini'
              type='text'
              className={styles.detailsButton}
              aria-expanded={openedOperations.has(task.operationId)}
              icon={<Down size={12} className={openedOperations.has(task.operationId) ? styles.expanded : undefined} />}
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
      {!!task.children?.length && <ol className={styles.subtasks}>{task.children.map(row)}</ol>}
    </li>
  );
  return (
    <section data-testid='conversation-work-progress' className={styles.panel}>
      <h3 className={styles.heading}>{t('conversation.workProgress.title')}</h3>
      {!!entries.length && (
        <div className={styles.overview}>
          <div className={styles.summary}>
            <span className={styles.count}>
              {t('conversation.planBar.progress', { completed, total: entries.length })}
            </span>
            <span
              role='status'
              aria-live='polite'
              aria-atomic='true'
              className={styles.overallStatus}
              data-status={overallStatus}
            >
              {t(`conversation.workProgress.statuses.${overallStatus}`)}
            </span>
          </div>
          <div
            className={styles.progressTrack}
            role='progressbar'
            aria-label={t('conversation.workProgress.title')}
            aria-valuemin={0}
            aria-valuemax={entries.length}
            aria-valuenow={completed}
            aria-valuetext={t('conversation.planBar.progress', { completed, total: entries.length })}
          >
            <div className={styles.progressFill} style={{ width: `${(completed / entries.length) * 100}%` }} />
          </div>
        </div>
      )}
      {snapshot.pendingConfirmations > 0 && (
        <p className={styles.waitingHint}>{t('conversation.workProgress.waitingHint')}</p>
      )}
      {!entries.length ? (
        <p className={styles.empty}>{t('conversation.workProgress.empty')}</p>
      ) : (
        <ol className={styles.tasks} aria-label={t('conversation.workProgress.title')}>
          {visibleTasks.map(row)}
        </ol>
      )}
      {!snapshot.isProcessing &&
        snapshot.tasks.some(
          (task) => ['interrupted', 'failed'].includes(task.status) && task.kind !== 'generation' && !task.operationId
        ) && (
          <Button
            className={styles.resumeButton}
            size='small'
            onClick={() =>
              requestConversationSendBoxPrefill(conversationId, t('conversation.workProgress.resumePrompt'))
            }
          >
            {t('conversation.workProgress.prepareResume')}
          </Button>
        )}
    </section>
  );
}
