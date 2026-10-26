import React, { useEffect, useState } from 'react';
import useSWR, { mutate as swrMutate } from 'swr';
import { Button, Collapse } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import type { ComfyIntent, ComfyOperation, ComfyProfile } from '@/common/chat/document/creation/comfy';
import type { CreationRequest } from '@/common/chat/document/creation/creation';
import type { TChatConversation } from '@/common/config/storage';
import { requestConversationSendBoxPrefill } from '@/renderer/hooks/chat/useSendBoxDraft';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { toolResultRecords } from '@/common/chat/document/creation/toolResults';
import { beginComfySelectionChange, useComfySelectionPending } from './useComfySelectionPending';

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function comfyOperationIds(messages: Array<{ type: string; content: unknown }>): string[] {
  return [
    ...new Set(
      messages
        .flatMap(toolResultRecords)
        .map((record) => record.comfyOperationId)
        .filter(isUuid)
    ),
  ];
}
export function comfyTurnResults(
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
    for (const id of comfyOperationIds(item.messages ?? []))
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
  }
  flush();
  return groups;
}
function bytes(value: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index++;
  }
  return `${amount.toFixed(index ? 2 : 0)} ${units[index]}`;
}

export default function ComfyOperationResult({ id, conversationId }: { id: string; conversationId: string }) {
  const { t } = useTranslation();
  const runtime = useConversationRuntimeView(conversationId);
  const selectionPending = useComfySelectionPending(conversationId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const {
    data: operation,
    error: unavailable,
    mutate,
  } = useSWR<ComfyOperation>(['comfy.operation', conversationId, id], () => comfyApi.operation(id, conversationId), {
    refreshInterval: (data) => (data && ['completed', 'cancelled'].includes(data.state) ? 0 : 1500),
  });
  const { data: profiles, error: inventoryUnavailable } = useSWR<ComfyProfile[]>(
    operation?.state === 'completed' && operation.conversationId === conversationId ? 'creation.comfy-profiles' : null,
    () => comfyApi.profiles(),
    { refreshInterval: 30_000 }
  );
  const completedProfile = profiles?.find((profile) => profile.id === operation?.profileId);
  const verified = completedProfile?.state === 'verified' && !inventoryUnavailable;
  const diagnosticLogPath = (operation as (ComfyOperation & { diagnosticLogPath?: string }) | undefined)
    ?.diagnosticLogPath;
  useEffect(() => {
    if (operation?.state === 'completed') void swrMutate('creation.comfy-profiles');
  }, [operation?.state]);
  if (operation && operation.conversationId !== conversationId) return null;
  const authorize = async () => {
    setBusy(true);
    setError('');
    try {
      await comfyApi.authorize(id, conversationId);
      await mutate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await comfyApi.cancel(id, conversationId);
      await mutate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const chooseCompletedProfile = async (intent: ComfyIntent) => {
    if (!operation?.profileId || runtime.isProcessing || busy || selectionPending) return;
    const finishSelection = beginComfySelectionChange(conversationId);
    setBusy(true);
    setError('');
    try {
      const conversation = await ipcBridge.conversation.get.invoke({ id: conversationId });
      const profile = (await comfyApi.profiles()).find((item) => item.id === operation.profileId);
      if (!profile || (intent === 'generate' && profile.state !== 'verified'))
        throw new Error(t('guid.comfy.operation.unavailable'));
      const previous = (conversation.extra as { creation_request?: CreationRequest & { requestId?: string } })
        .creation_request;
      const next = {
        ...previous,
        requestId: previous?.requestId ?? operation.requestId,
        id: intent === 'install-other' ? profile.family : profile.id,
        name: profile.name,
        kind: profile.kind,
        source: 'local' as const,
        state: profile.state,
        family: profile.family,
        profileId: intent === 'install-other' ? undefined : profile.id,
        intent,
      };
      const update = (snapshot: typeof previous) =>
        ipcBridge.conversation.update.invoke({
          id: conversationId,
          updates: { extra: { creation_request: snapshot } as TChatConversation['extra'] },
          merge_extra: true,
        });
      if (!(await update(next))) throw new Error(t('guid.comfy.session.saveFailed'));
      try {
        const bound = await comfyApi.bind(next.requestId, conversationId, next.profileId, next.family, next.intent, {
          source: next.source,
          kind: next.kind,
        });
        if (!bound.ok) throw new Error(t('guid.comfy.session.saveFailed'));
      } catch (cause) {
        if (!(await update(previous))) throw new Error(t('guid.comfy.session.saveFailed'), { cause });
        if (previous?.requestId) {
          const rebound = await comfyApi.bind(
            previous.requestId,
            conversationId,
            previous.profileId,
            previous.family,
            previous.intent,
            { source: previous.source, kind: previous.kind }
          );
          if (!rebound.ok) throw new Error(t('guid.comfy.session.saveFailed'), { cause });
        }
        throw cause;
      }
      if (intent !== 'generate') {
        requestConversationSendBoxPrefill(
          conversationId,
          `${t(`guid.comfy.prompts.${intent}`, { family: profile.name, profile: profile.id })}\n\n${t('guid.comfy.intentSummary', { model: profile.name, intent: t(`guid.comfy.actions.${intent}`), profile: next.profileId ?? '' })}`
        );
      }
      await swrMutate(`conversation/${conversationId}`).catch((): void => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      finishSelection();
      setBusy(false);
    }
  };
  const plan = operation?.plan;
  return (
    <div className='mt-12px p-12px rd-12px border border-3 space-y-8px' data-testid='comfy-operation-result'>
      <div className='flex items-center justify-between gap-12px'>
        <span role='status'>
          {t('guid.comfy.operation.title')} ·{' '}
          {operation?.state === 'completed'
            ? verified
              ? t('guid.comfy.operation.states.completed')
              : inventoryUnavailable || (profiles && !completedProfile)
                ? t('guid.comfy.operation.unavailable')
                : completedProfile
                  ? t(`guid.creation.states.${completedProfile.state}`)
                  : t('conversation.h3Activity.loading')
            : operation
              ? t(`guid.comfy.operation.states.${operation.state}`)
              : t('conversation.h3Activity.loading')}
        </span>
        {operation && !['completed', 'cancelled'].includes(operation.state) && (
          <Button size='small' loading={busy} onClick={() => void cancel()}>
            {t('guid.comfy.operation.cancel')}
          </Button>
        )}
      </div>
      {plan && (
        <>
          <div className='font-semibold'>
            <span>{plan.name}</span> · {plan.version} · {plan.quantization}
          </div>
          <div className='text-t-secondary break-words'>{plan.reason}</div>
          <dl className='m-0 text-12px text-t-secondary space-y-4px'>
            <div>
              <dt>{t('guid.comfy.operation.target')}</dt>
              <dd className='m-0 break-all'>{plan.targetRoot}</dd>
            </div>
            <div className='flex flex-wrap gap-16px'>
              <div>
                <dt>{t('guid.comfy.operation.download')}</dt>
                <dd className='m-0'>{bytes(plan.downloadBytes)}</dd>
              </div>
              <div>
                <dt>{t('guid.comfy.operation.disk')}</dt>
                <dd className='m-0'>{bytes(plan.requiredBytes)}</dd>
              </div>
            </div>
          </dl>
          {plan.evidence?.map((evidence) => (
            <div key={evidence} className='text-12px text-t-secondary break-words'>
              {evidence}
            </div>
          ))}
          <Collapse bordered={false} className='bg-transparent text-12px text-t-secondary'>
            <Collapse.Item name='plan' header={t('guid.comfy.operation.details')}>
              <dl className='m-0 space-y-4px'>
                {Object.entries({
                  'environment.root': plan.environment.root,
                  'environment.python': plan.environment.python,
                  'environment.baseUrl': plan.environment.baseUrl,
                  'environment.launchArgs': JSON.stringify(plan.environment.launchArgs ?? []),
                  workflowPath: plan.workflowPath,
                  workflowSha256: plan.workflowSha256,
                }).map(
                  ([field, value]) =>
                    value !== undefined && (
                      <div key={field}>
                        <dt>
                          <code>{field}</code>
                        </dt>
                        <dd className='m-0 break-all'>{value}</dd>
                      </div>
                    )
                )}
              </dl>
              <ul>
                {plan.components?.map((component) => (
                  <li key={component.name}>
                    {component.name} · {component.version} · {component.precision}{' '}
                    {component.url && /^https?:\/\//i.test(component.url) && (
                      <a href={component.url} target='_blank' rel='noreferrer'>
                        {t('guid.comfy.operation.source')}
                      </a>
                    )}
                    {component.sourceUrls && (
                      <ol className='m-0 break-all'>
                        {component.sourceUrls.map((url) => (
                          <li key={url}>
                            <a href={url} target='_blank' rel='noreferrer'>
                              {url}
                            </a>
                          </li>
                        ))}
                      </ol>
                    )}
                    <dl className='m-0 space-y-4px'>
                      {Object.entries({
                        path: component.path,
                        sha256: component.sha256,
                        sizeBytes: component.sizeBytes === undefined ? undefined : bytes(component.sizeBytes),
                      }).map(
                        ([field, value]) =>
                          value !== undefined && (
                            <div key={field}>
                              <dt>
                                <code>{field}</code>
                              </dt>
                              <dd className='m-0 break-all'>{value}</dd>
                            </div>
                          )
                      )}
                    </dl>
                  </li>
                ))}
                {plan.nodes?.map((node) => (
                  <li key={node.id}>
                    {node.id} · {node.version}
                  </li>
                ))}
              </ul>
              {plan.commands?.map((command, index) => (
                <div key={index} className='mb-4px break-all'>
                  {command.label} · {command.revision}
                  <div>
                    {command.executable} {command.args.join(' ')}
                  </div>
                  <dl className='m-0 space-y-4px'>
                    <div>
                      <dt>
                        <code>cwd</code>
                      </dt>
                      <dd className='m-0 break-all'>{command.cwd}</dd>
                    </div>
                    <div>
                      <dt>
                        <code>stage</code>
                      </dt>
                      <dd className='m-0'>{command.stage}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </Collapse.Item>
          </Collapse>
          {operation.progress && (
            <div role='status' className='text-12px text-t-secondary'>
              {operation.progress}
            </div>
          )}
        </>
      )}
      {(error || operation?.error || unavailable) && (
        <p role='alert'>{error || operation?.error || t('guid.comfy.operation.unavailable')}</p>
      )}
      {operation?.diagnosis && (
        <p className='text-12px text-t-secondary break-words'>
          {operation.diagnosis.category}
          {operation.diagnosis.nodeId ? ` · ${operation.diagnosis.nodeId}` : ''} · {operation.diagnosis.action}
        </p>
      )}
      {operation?.snapshotDirectory && (
        <Collapse bordered={false} className='bg-transparent text-12px text-t-secondary'>
          <Collapse.Item name='snapshot' header={t('guid.comfy.operation.snapshotDirectory')}>
            <code className='break-all'>{operation.snapshotDirectory}</code>
          </Collapse.Item>
        </Collapse>
      )}
      {diagnosticLogPath && (
        <Collapse bordered={false} className='bg-transparent text-12px text-t-secondary'>
          <Collapse.Item name='diagnostic-log' header={t('guid.comfy.diagnosticLog')}>
            <code className='break-all'>{diagnosticLogPath}</code>
          </Collapse.Item>
        </Collapse>
      )}
      {operation && ['awaiting-consent', 'paused', 'failed'].includes(operation.state) && (
        <Button type='primary' loading={busy} disabled={runtime.isProcessing} onClick={() => void authorize()}>
          {t('guid.comfy.operation.authorize')}
        </Button>
      )}
      {operation?.state === 'authorized' && (
        <Button type='primary' loading={busy} disabled={runtime.isProcessing} onClick={() => void authorize()}>
          {t('guid.comfy.operation.continue')}
        </Button>
      )}
      {operation?.state === 'completed' && (
        <>
          {verified && <div className='text-12px text-t-secondary'>{t('guid.comfy.operation.completedHint')}</div>}
          {operation.profileId && (
            <div className='flex flex-wrap gap-8px'>
              <Button
                type='primary'
                size='small'
                loading={busy}
                disabled={!verified || busy || selectionPending || runtime.isProcessing}
                onClick={() => void chooseCompletedProfile('generate')}
              >
                {t('guid.comfy.use')}
              </Button>
              <Button
                type='text'
                size='small'
                disabled={busy || runtime.isProcessing}
                onClick={() => void chooseCompletedProfile('repair')}
              >
                {t('guid.comfy.actions.repair')}
              </Button>
              <Button
                type='text'
                size='small'
                disabled={busy || runtime.isProcessing}
                onClick={() => void chooseCompletedProfile('install-other')}
              >
                {t('guid.comfy.actions.install-other')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
