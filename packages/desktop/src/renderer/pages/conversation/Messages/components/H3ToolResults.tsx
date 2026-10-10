import React, { useEffect, useState } from 'react';
import { Button, Progress, Spin } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { IMessageToolCall } from '@/common/chat/chatLib';
import type { H3Job } from '@/common/chat/document/h3Job';
import { h3JobApi } from '@/common/chat/document/h3JobApi';

export function h3ToolJobIds(messages: Array<{ type: string; content: unknown }>): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.type !== 'tool_call') continue;
    const content = message.content as IMessageToolCall['content'];
    if (!['aionui_h3_generate_video', 'aionui_h3_job_status'].includes(content.name)) continue;
    try {
      const output = typeof content.output === 'string' ? JSON.parse(content.output) : content.output;
      // Tool output is untrusted: only use a job identifier; fetch authoritative resources locally.
      if (output && typeof output.id === 'string' && /^[a-f0-9-]{36}$/i.test(output.id)) ids.add(output.id);
    } catch {
      /* An unfinished tool call has no JSON result yet. */
    }
  }
  return [...ids];
}

/** Anchor each unique result after its whole assistant turn. */
export function h3TurnResults(
  items: Array<{ id: string; type: string; position?: string; messages?: Array<{ type: string; content: unknown }> }>
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const seen = new Set<string>();
  let jobs: string[] = [];
  let anchor: string | undefined;
  const flush = () => {
    if (anchor && jobs.length) groups.set(anchor, jobs);
    jobs = [];
    anchor = undefined;
  };
  for (const item of items) {
    if (item.position === 'right') {
      flush();
      continue;
    }
    anchor = item.id;
    for (const id of h3ToolJobIds(item.messages ?? [])) {
      if (!seen.has(id)) {
        seen.add(id);
        jobs.push(id);
      }
    }
  }
  flush();
  return groups;
}

/** Remove only redundant player markup for known jobs; never interpret model HTML. */
export function stripH3PlayerMarkup(text: string, jobIds: string[]): string {
  return text
    .replace(/<video\b[^>]*>\s*<\/video>/gi, (markup) => {
      const source = /\bsrc=["'](\/api\/h3\/jobs\/([a-f0-9-]{36})\/artifacts\/\d+)["']/i.exec(markup);
      return source && jobIds.includes(source[2]) ? '' : markup;
    })
    .trim();
}

/** Actual media metadata stays attached to the corresponding artifact. */
function H3VideoArtifact({ src, filename, job }: { src: string; filename: string; job: H3Job }) {
  const { t } = useTranslation();
  const [metadata, setMetadata] = useState<{ duration: number; width: number; height: number }>();
  const elapsed =
    job.startedAt && job.finishedAt ? (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000 : NaN;
  const unknown = t('conversation.h3Activity.notRecorded');
  return (
    <div>
      <video
        controls
        preload='metadata'
        src={src}
        aria-label={filename}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          if (Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth > 0 && video.videoHeight > 0)
            setMetadata({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
        }}
        style={{ display: 'block', width: '100%', maxHeight: 420, borderRadius: 12 }}
      />
      <div
        className='mt-8px flex flex-wrap gap-x-16px gap-y-4px text-12px text-t-secondary leading-5'
        data-testid='h3-video-parameters'
      >
        <span>
          {t('conversation.h3Activity.durationLabel')} {metadata ? metadata.duration.toFixed(2) + ' s' : unknown}
        </span>
        <span>
          {t('conversation.h3Activity.qualityLabel')} {metadata ? metadata.width + ' × ' + metadata.height : unknown}
        </span>
        <span title={t('conversation.h3Activity.elapsedHint')}>
          {t('conversation.h3Activity.elapsedLabel')}{' '}
          {Number.isFinite(elapsed) && elapsed >= 0
            ? Math.floor(elapsed / 60) + ' min ' + Math.floor(elapsed % 60) + ' s'
            : unknown}
        </span>
      </div>
    </div>
  );
}

export function H3LiveProgress({ job, unavailable }: { job: H3Job; unavailable: boolean }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const activity = job.activity;
  const elapsed = job.startedAt ? Math.max(0, Math.floor((now - Date.parse(job.startedAt)) / 1000)) : NaN;
  const stale = !!activity && now - Date.parse(activity.updatedAt) > 60000;
  const measured =
    !unavailable &&
    !stale &&
    activity?.phase === 'node-progress' &&
    typeof activity.value === 'number' &&
    Number.isFinite(activity.value) &&
    activity.value >= 0 &&
    typeof activity.max === 'number' &&
    Number.isFinite(activity.max) &&
    activity.max > 0 &&
    activity.value <= activity.max;
  const nodeType = activity?.nodeType ?? '';
  const stage = /LoadImage|LoadAudio|LoadVideo|GetVideoComponents/.test(nodeType)
    ? 'preparingReferences'
    : /Loader/.test(nodeType)
      ? 'loadingModels'
      : /VAEDecode/.test(nodeType)
        ? 'decoding'
        : /SaveVideo|CreateVideo/.test(nodeType)
          ? 'savingVideo'
          : 'executingNode';
  return (
    <div data-testid='h3-live-progress' className='space-y-8px text-12px text-t-secondary'>
      <div className='flex items-center gap-8px'>
        {!measured && <Spin size={12} />}
        <span>
          {unavailable
            ? t('conversation.h3Activity.disconnected')
            : job.status === 'queued'
              ? t('conversation.h3Activity.queued')
              : measured
                ? t('conversation.h3Activity.nodeProgress', { value: activity.value, max: activity.max })
                : activity?.phase === 'finalizing'
                  ? t('conversation.h3Activity.finalizing')
                  : activity?.nodeId
                    ? t(`conversation.h3Activity.${stage}`, { node: activity.nodeId })
                    : t('conversation.h3Activity.waitingProgress')}
        </span>
        {Number.isFinite(elapsed) && (
          <span>
            {t('conversation.h3Activity.elapsedLabel')} {Math.floor(elapsed / 60)} min {elapsed % 60} s
          </span>
        )}
      </div>
      {measured && <Progress percent={Math.round((100 * activity.value!) / activity.max!)} />}
    </div>
  );
}

function H3ToolResult({ id }: { id: string }) {
  const { t } = useTranslation();
  const [unavailable, setUnavailable] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(false);
  const [job, setJob] = useState<H3Job>();
  const settled = job?.id === id && !['queued', 'running'].includes(job.status) && !job.remoteUncertain;
  useEffect(() => {
    if (settled) return;
    let disposed = false;
    let refreshing = false;
    let terminal = false;
    const update = (next: H3Job) => {
      if (!disposed && !terminal && next.id === id) {
        terminal = !['queued', 'running'].includes(next.status) && !next.remoteUncertain;
        setJob(next);
        setUnavailable(false);
      }
    };
    const source = h3JobApi.events(id, update);
    const refresh = (): void => {
      if (refreshing || disposed || terminal) return;
      refreshing = true;
      void h3JobApi
        .get(id)
        .then(update)
        .catch(() => {
          if (!disposed && !terminal) setUnavailable(true);
        })
        .finally(() => {
          refreshing = false;
        });
    };
    source.onerror = (): void => {
      if (!disposed && !terminal) setUnavailable(true);
    };
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      disposed = true;
      clearInterval(timer);
      source.close();
    };
  }, [id, settled]);
  const active = job?.status === 'queued' || job?.status === 'running';
  const cancel = async () => {
    setCancelling(true);
    setCancelError(false);
    try {
      setJob(await h3JobApi.cancel(id));
    } catch {
      setCancelError(true);
    } finally {
      setCancelling(false);
    }
  };
  return (
    <div className='mt-12px p-12px rd-12px border border-3 space-y-8px' data-testid='h3-chat-result'>
      <div className='flex items-center justify-between gap-12px'>
        <span role='status' aria-live='polite'>
          {t('conversation.h3Activity.title')} ·{' '}
          {unavailable
            ? t('conversation.h3Activity.disconnected')
            : job
              ? t(`conversation.h3Activity.${job.status}`)
              : t('conversation.h3Activity.loading')}
        </span>
        {(active || job?.remoteUncertain) && (
          <Button size='small' loading={cancelling} disabled={!!job.cancelRequested} onClick={() => void cancel()}>
            {job.cancelRequested
              ? t('conversation.h3Activity.cancelling')
              : job.remoteUncertain
                ? t('conversation.h3Activity.confirmStop')
                : t('conversation.h3Activity.cancel')}
          </Button>
        )}
      </div>
      {active && <H3LiveProgress job={job} unavailable={unavailable} />}
      {job?.remoteUncertain && <p role='alert'>{t('conversation.h3Activity.remoteUncertain')}</p>}
      {active && job.monitor?.state === 'reconnecting' && <p>{t('conversation.h3Activity.reconnecting')}</p>}
      {active && job.monitor?.state === 'suspected-stall' && <p>{t('conversation.h3Activity.suspectedStall')}</p>}
      {job?.error && (
        <p className='break-all text-t-secondary' role='alert'>
          {job.error}
        </p>
      )}
      {cancelError && <p role='alert'>{t('conversation.h3Activity.cancelFailed')}</p>}
      {job?.status === 'succeeded' &&
        job.artifacts.map((artifact, index) => {
          const expected = `/api/h3/jobs/${id}/artifacts/${index}`;
          if (artifact.mimeType !== 'video/mp4' || artifact.resourcePath !== expected) return null;
          return (
            <H3VideoArtifact
              key={expected}
              job={job}
              src={h3JobApi.resourceUrl(expected)}
              filename={artifact.filename}
            />
          );
        })}
    </div>
  );
}

export default function H3ToolResults({
  messages,
  jobIds,
}: {
  messages: Array<{ type: string; content: unknown }>;
  jobIds?: string[];
}) {
  return (
    <>
      {(jobIds ?? h3ToolJobIds(messages)).map((id) => (
        <H3ToolResult key={id} id={id} />
      ))}
    </>
  );
}
