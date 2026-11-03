import React from 'react';
import useSWR from 'swr';
import { Alert, Progress } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { cloudVideoApi } from '@/common/chat/document/creation/cloudVideoApi';
import { toolResultRecords } from '@/common/chat/document/creation/toolResults';
import { creationTurnResults } from './turnResults';

export function cloudVideoJobIds(messages: Array<{ type: string; content: unknown }>): string[] {
  return [
    ...new Set(
      messages
        .flatMap(toolResultRecords)
        .map((record) => record.cloudVideoJobId)
        .filter((id): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id))
    ),
  ];
}
export function cloudVideoTurnResults(items: Parameters<typeof creationTurnResults>[0]): Map<string, string[]> {
  return creationTurnResults(items, cloudVideoJobIds);
}

export default function CloudVideoResult({ id, conversationId }: { id: string; conversationId: string }) {
  const { t } = useTranslation();
  const { data: job, error } = useSWR(
    ['cloud-video.job', conversationId, id],
    () => cloudVideoApi.job(id, conversationId),
    {
      refreshInterval: (data) => (data && ['succeeded', 'failed'].includes(data.status) ? 0 : 2500),
      errorRetryInterval: 2500,
      revalidateOnFocus: false,
    }
  );
  const active = job && ['queued', 'running'].includes(job.status);
  return (
    <div className='mt-12px p-12px rd-12px border border-3 space-y-8px' data-testid='cloud-video-result'>
      <div role='status'>
        {t('guid.creation.cloudVideo')} · {job?.model} ·{' '}
        {job ? t(`guid.comfy.generation.states.${job.status}`) : t('conversation.h3Activity.loading')}
      </div>
      {active && <Progress percent={job.progress} />}
      {job?.submissionUncertain && <Alert type='warning' content={t('guid.creation.cloudVideoSetup.uncertain')} />}
      {(job?.error || error) && !job?.submissionUncertain && (
        <Alert
          type={active ? 'warning' : 'error'}
          content={t(active ? 'guid.creation.cloudVideoSetup.retrying' : 'guid.creation.cloudVideoSetup.failed')}
        />
      )}
      {job?.status === 'succeeded' && (
        <video
          controls
          preload='metadata'
          className='block max-w-full max-h-500px rounded'
          src={cloudVideoApi.artifactUrl(id, conversationId)}
          aria-label={t('guid.creation.cloudVideo')}
        />
      )}
    </div>
  );
}
