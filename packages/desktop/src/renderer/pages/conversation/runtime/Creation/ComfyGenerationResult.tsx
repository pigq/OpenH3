import React, { useMemo, useState } from 'react';
import useSWR from 'swr';
import { Button, Collapse, Progress } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import type { ComfyGenerationJob } from '@/common/chat/document/creation/comfy';
import { toolResultRecords } from '@/common/chat/document/creation/toolResults';
import ConversationImage from '@/renderer/components/media/ConversationImage';
import { useRegisterRenderedMedia } from '@/renderer/components/Markdown/RenderedMediaContext';

const isActive = (job: ComfyGenerationJob) => ['queued', 'running'].includes(job.status);
type MediaMetadata = { width?: number; height?: number; duration?: number };
const positive = (value: number) => (Number.isFinite(value) && value > 0 ? value : undefined);

export function comfyJobIds(messages: Array<{ type: string; content: unknown }>): string[] {
  return [
    ...new Set(
      messages
        .flatMap(toolResultRecords)
        .map((record) => record.comfyJobId)
        .filter(
          (id): id is string =>
            typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
        )
    ),
  ];
}

export default function ComfyGenerationResult({ id, conversationId }: { id: string; conversationId: string }) {
  return <ComfyGenerationCard key={`${conversationId}:${id}`} id={id} conversationId={conversationId} />;
}

function ComfyGenerationCard({ id, conversationId }: { id: string; conversationId: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [metadata, setMetadata] = useState<Record<string, MediaMetadata>>({});
  const {
    data: job,
    error: unavailable,
    mutate,
  } = useSWR<ComfyGenerationJob>(['comfy.job', conversationId, id], () => comfyApi.job(id, conversationId), {
    refreshInterval: (data) => (data && !isActive(data) ? 0 : 1500),
    errorRetryInterval: 1500,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  const completed = job?.status === 'succeeded' && !job.submissionUncertain && job.artifacts.length > 0;
  const renderedSources = useMemo(
    () =>
      completed && !unavailable
        ? job.artifacts.flatMap((artifact, index) =>
            /^(image|video)\//.test(artifact.mimeType)
              ? [encodeURIComponent(artifact.path), comfyApi.jobArtifactUrl(id, index, conversationId)]
              : []
          )
        : [],
    [completed, unavailable, job, id, conversationId]
  );
  useRegisterRenderedMedia(id, renderedSources);
  const cancel = async () => {
    setBusy(true);
    setError('');
    try {
      await mutate(await comfyApi.cancelJob(id, conversationId), { revalidate: false });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  // Terminal attempts remain in tool history/work progress; cards show active work and deliverables.
  if (job?.status === 'failed' && !job.submissionUncertain) return null;
  const active = job && isActive(job);
  const diagnosticLogPath = (job as (ComfyGenerationJob & { diagnosticLogPath?: string }) | undefined)
    ?.diagnosticLogPath;
  const diagnostics = (
    <>
      {job?.error && <p role='alert'>{job.error}</p>}
      {job?.diagnosis && (
        <p className='text-12px text-t-secondary break-words'>
          {job.diagnosis.category}
          {job.diagnosis.nodeId ? ` · ${job.diagnosis.nodeId}` : ''} · {job.diagnosis.action}
        </p>
      )}
      {diagnosticLogPath && (
        <Collapse bordered={false} className='bg-transparent'>
          <Collapse.Item name='diagnostic-log' header={t('guid.comfy.diagnosticLog')}>
            <code className='break-all'>{diagnosticLogPath}</code>
          </Collapse.Item>
        </Collapse>
      )}
    </>
  );
  const mediaWidths = (job?.artifacts ?? []).flatMap((artifact, index) => {
    const size = metadata[`${index}:${artifact.path}`];
    if (!size?.width || !size.height) return [];
    const ratio = size.width / size.height;
    return [`min(${Math.min(size.width, 640, 420 * ratio)}px, ${52 * ratio}dvh)`];
  });
  const elapsed = job?.status === 'succeeded' ? (Date.parse(job.updatedAt) - Date.parse(job.createdAt)) / 1000 : NaN;
  const unknown = t('conversation.h3Activity.notRecorded');
  return (
    <div
      className='mt-12px p-12px rd-12px border border-3 space-y-8px'
      data-testid='comfy-generation-result'
      style={
        {
          '--comfy-media-width': mediaWidths.length ? `max(${mediaWidths.join(', ')})` : undefined,
          boxSizing: 'border-box',
          width: mediaWidths.length ? 'calc(var(--comfy-media-width) + 26px)' : 'fit-content',
          maxWidth: '100%',
          overflowWrap: 'anywhere',
        } as React.CSSProperties
      }
    >
      <div className='flex items-center justify-between gap-12px'>
        <span role='status'>
          {t('guid.comfy.generation.title')} ·{' '}
          {unavailable
            ? t('guid.comfy.generation.unavailable')
            : job
              ? t(`guid.comfy.generation.states.${job.submissionUncertain ? 'running' : job.status}`)
              : t('conversation.h3Activity.loading')}
        </span>
        {active && !job.observationOnly && (
          <Button size='small' loading={busy} onClick={() => void cancel()}>
            {t('guid.comfy.generation.cancel')}
          </Button>
        )}
      </div>
      {active && !job.observationOnly && <Progress percent={job.progress} />}
      {diagnostics}
      {job?.submissionUncertain && <p role='alert'>{t('guid.comfy.generation.submissionUncertain')}</p>}
      {job?.adjustments?.map((adjustment, index) => (
        <div key={index} className='text-12px text-t-secondary'>
          <p>{t('guid.comfy.generation.adjusted')}</p>
          <p>{adjustment.reason}</p>
          <Collapse bordered={false} className='bg-transparent'>
            <Collapse.Item name='actual-input' header={t('guid.comfy.generation.actualInput')}>
              <pre className='whitespace-pre-wrap break-words'>{JSON.stringify(adjustment.input, null, 2)}</pre>
            </Collapse.Item>
          </Collapse>
        </div>
      ))}
      {(error || unavailable) && <p role='alert'>{error || t('guid.comfy.generation.unavailable')}</p>}
      {job?.artifacts.map((artifact, index) => {
        const src = comfyApi.jobArtifactUrl(id, index, conversationId);
        const key = `${index}:${artifact.path}`;
        const media = metadata[key];
        if (artifact.mimeType.startsWith('image/'))
          return (
            <div
              key={key}
              onLoadCapture={(event) => {
                if (!(event.target instanceof HTMLImageElement)) return;
                const { naturalWidth, naturalHeight } = event.target;
                setMetadata((current) => ({
                  ...current,
                  [key]: { width: positive(naturalWidth), height: positive(naturalHeight) },
                }));
              }}
            >
              <ConversationImage src={src} alt={t('guid.comfy.generation.artifact', { index: index + 1 })} />
            </div>
          );
        if (artifact.mimeType.startsWith('video/'))
          return (
            <div key={key}>
              <video
                controls
                preload='metadata'
                src={src}
                aria-label={t('guid.comfy.generation.artifact', { index: index + 1 })}
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  setMetadata((current) => ({
                    ...current,
                    [key]: {
                      width: positive(video.videoWidth),
                      height: positive(video.videoHeight),
                      duration: positive(video.duration),
                    },
                  }));
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  height: 'auto',
                  maxHeight: 'min(420px, 52dvh)',
                  aspectRatio: media?.width && media.height ? `${media.width} / ${media.height}` : undefined,
                  objectFit: 'contain',
                  borderRadius: 8,
                }}
              />
              <div
                className='mt-8px flex flex-wrap gap-x-12px gap-y-4px text-12px text-t-secondary leading-5'
                data-testid='comfy-video-metadata'
              >
                <span>
                  {t('conversation.h3Activity.qualityLabel')}{' '}
                  {media?.width && media.height ? `${media.width} × ${media.height}` : unknown}
                </span>
                <span>
                  {t('conversation.h3Activity.durationLabel')}{' '}
                  {media?.duration ? `${Number(media.duration.toFixed(2))} s` : unknown}
                </span>
                <span>
                  {Number.isFinite(elapsed) && elapsed >= 0
                    ? t('guid.comfy.generation.elapsed', { seconds: Math.round(elapsed) })
                    : `${t('conversation.h3Activity.elapsedLabel')} ${unknown}`}
                </span>
              </div>
            </div>
          );
        return null;
      })}
    </div>
  );
}

export function comfyGenerationTurnResults(
  items: Array<{ id: string; type: string; position?: string; messages?: Array<{ type: string; content: unknown }> }>
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const seen = new Set<string>();
  let ids: string[] = [];
  let anchor: string | undefined;
  const flush = () => {
    if (anchor && ids.length) groups.set(anchor, ids);
    ids = [];
    anchor = undefined;
  };
  for (const item of items) {
    if (item.position === 'right') {
      flush();
      continue;
    }
    anchor = item.id;
    for (const id of comfyJobIds(item.messages ?? []))
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
  }
  flush();
  return groups;
}
