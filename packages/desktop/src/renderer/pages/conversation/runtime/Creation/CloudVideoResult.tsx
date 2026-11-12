import React, { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Alert, Progress, Spin } from '@arco-design/web-react';
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
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const [now, setNow] = useState(Date.now);
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
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => setDimensions(undefined), [id]);
  const ratio = job?.aspectRatio?.split(':').map(Number);
  const width = dimensions?.width ?? job?.width ?? (ratio?.length === 2 ? ratio[0] * 100 : 0);
  const height = dimensions?.height ?? job?.height ?? (ratio?.length === 2 ? ratio[1] * 100 : 0);
  const mediaWidth = width > 0 && height > 0 ? Math.min(width, (500 * width) / height) : undefined;
  const elapsed = Math.max(0, Math.floor((now - Date.parse(job?.createdAt ?? '')) / 1000)) || 0;
  const stage =
    job?.stage ?? (job?.status === 'running' ? 'generating' : job?.status === 'succeeded' ? 'completed' : job?.status);
  const download = stage === 'downloading';
  const known = download ? Boolean(job?.downloadTotalBytes) : job?.progressKnown === true && job.progress > 0;
  const percent =
    download && job?.downloadTotalBytes
      ? Math.min(99, (100 * (job.downloadBytes ?? 0)) / job.downloadTotalBytes)
      : active
        ? Math.min(99, job?.progress ?? 0)
        : (job?.progress ?? 0);
  return (
    <div
      className='mt-12px p-12px rd-12px border border-3 space-y-8px max-w-full'
      style={{
        boxSizing: 'border-box',
        width: job?.status === 'succeeded' ? (mediaWidth ? mediaWidth + 26 : 'fit-content') : undefined,
      }}
      data-testid='cloud-video-result'
      aria-busy={Boolean(active)}
    >
      <div role='status'>
        {t('guid.creation.cloudVideo')} · {job?.model} ·{' '}
        {stage ? t(`guid.creation.cloudVideoSetup.stages.${stage}`) : t('conversation.h3Activity.loading')}
      </div>
      {active && (
        <>
          <div className='flex items-center gap-8px'>
            <Spin size={16} />
            <span>{t('guid.creation.cloudVideoSetup.background')}</span>
          </div>
          <div className='text-12px text-t-secondary'>
            {t('guid.creation.cloudVideoSetup.elapsed', { seconds: elapsed })}
          </div>
          {known ? (
            <Progress percent={Math.round(percent)} />
          ) : (
            <div className='text-12px text-t-secondary'>{t('guid.creation.cloudVideoSetup.progressUnknown')}</div>
          )}
          {job?.lastCheckedAt && (
            <div className='text-12px text-t-secondary'>
              {t('guid.creation.cloudVideoSetup.lastChecked', {
                seconds: Math.max(0, Math.floor((now - Date.parse(job.lastCheckedAt)) / 1000)),
              })}
            </div>
          )}
        </>
      )}
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
          style={{
            width: '100%',
            height: 'auto',
            objectFit: 'contain',
            aspectRatio: width > 0 && height > 0 ? `${width} / ${height}` : undefined,
          }}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (video.videoWidth > 0 && video.videoHeight > 0)
              setDimensions({ width: video.videoWidth, height: video.videoHeight });
          }}
          src={cloudVideoApi.artifactUrl(id, conversationId)}
          aria-label={t('guid.creation.cloudVideo')}
        />
      )}
    </div>
  );
}
