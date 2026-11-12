import React, { useEffect, useState } from 'react';
import useSWR, { unstable_serialize, useSWRConfig } from 'swr';
import { Button, Collapse } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { comfyApi, COMFY_INVENTORY_CACHE_KEY } from '@/common/chat/document/creation/comfyApi';
import type {
  ComfyGenerationJob,
  ComfyIntent,
  ComfyOperation,
  ComfyProfile,
} from '@/common/chat/document/creation/comfy';
import { creationSessionServers, type CreationRequest } from '@/common/chat/document/creation/creation';
import type { ISessionMcpServer, TChatConversation } from '@/common/config/storage';
import { requestConversationSendBoxPrefill } from '@/renderer/hooks/chat/useSendBoxDraft';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { toolResultRecords } from '@/common/chat/document/creation/toolResults';
import { beginComfySelectionChange, useComfySelectionPending } from './useComfySelectionPending';
import { comfyWorkflowStatus, getComfyModelSetId } from '@/common/chat/document/creation/workflows/identity';

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

export default function ComfyOperationResult({
  id,
  conversationId,
  compact = false,
}: {
  id: string;
  conversationId: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { cache, mutate: swrMutate } = useSWRConfig();
  const runtime = useConversationRuntimeView(conversationId);
  const selectionPending = useComfySelectionPending(conversationId);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
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
  const verified = completedProfile && comfyWorkflowStatus(completedProfile) === 'verified' && !inventoryUnavailable;
  const diagnosticLogPath = (operation as (ComfyOperation & { diagnosticLogPath?: string }) | undefined)
    ?.diagnosticLogPath;
  useEffect(() => {
    if (operation?.state === 'completed' && operation.id === id && operation.conversationId === conversationId) {
      void swrMutate('creation.comfy-profiles');
      void swrMutate(COMFY_INVENTORY_CACHE_KEY);
      // Validation can succeed before its receipt establishes the authoritative recovery association.
      void swrMutate(
        (key) => {
          if (!Array.isArray(key) || key[0] !== 'comfy.job' || key[1] !== conversationId) return false;
          const previous = cache.get(unstable_serialize(key))?.data as ComfyGenerationJob | undefined;
          return previous?.status === 'failed' && !previous.submissionUncertain && !previous.observationOnly;
        },
        undefined,
        { populateCache: false }
      ).catch((): undefined => undefined);
    }
  }, [operation?.state, operation?.id, operation?.conversationId, conversationId, id, cache, swrMutate]);
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
  const diagnose = async () => {
    if (!operation || busy || runtime.isProcessing || selectionPending) return;
    const finishSelection = beginComfySelectionChange(conversationId);
    setBusy(true);
    setError('');
    let sending = false;
    try {
      const conversation = await ipcBridge.conversation.get.invoke({ id: conversationId });
      const snapshot = (conversation.extra as { creation_request?: CreationRequest }).creation_request;
      if (!snapshot?.requestId) throw new Error('COMFY_SELECTION_CHANGED');
      // The service proves the operation belongs to this request, including a linked repair child.
      const current = await comfyApi.operation(id, conversationId, snapshot.requestId);
      if (
        current.id !== id ||
        current.requestId !== operation.requestId ||
        current.conversationId !== conversationId ||
        !['failed', 'paused'].includes(current.state)
      )
        throw new Error('COMFY_SELECTION_CHANGED');
      // Reading the child also checks that its original parent selection is still current.
      const child = await comfyApi.selection(current.requestId);
      const selected = current.requestId === snapshot.requestId ? child : await comfyApi.selection(snapshot.requestId);
      if (
        child.requestId !== current.requestId ||
        child.conversationId !== conversationId ||
        child.source !== 'local' ||
        child.intent === 'generate' ||
        child.family !== current.plan.family ||
        selected.requestId !== snapshot.requestId ||
        selected.conversationId !== conversationId ||
        selected.source !== snapshot.source ||
        selected.kind !== snapshot.kind ||
        selected.family !== snapshot.family ||
        selected.profileId !== snapshot.profileId ||
        selected.intent !== (snapshot.intent ?? 'generate')
      )
        throw new Error('COMFY_SELECTION_CHANGED');
      runtime.markSendStarted();
      sending = true;
      const result = await ipcBridge.conversation.sendMessage.invoke({
        conversation_id: conversationId,
        input: t('guid.comfy.operation.agentRetry', { model: operation.plan.name }),
        inject_skills: ['comfyui-local'],
      });
      runtime.markSendAccepted(result.turn_id, result.runtime, result.msg_id);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      setError(reason);
      if (sending) runtime.markSendFailed({ kind: 'ordinary', reason });
    } finally {
      finishSelection();
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
      if (!profile || (intent === 'generate' && comfyWorkflowStatus(profile) !== 'verified'))
        throw new Error(t('guid.comfy.operation.unavailable'));
      const previous = (conversation.extra as { creation_request?: CreationRequest & { requestId?: string } })
        .creation_request;
      const modelSetId = getComfyModelSetId(profile);
      const sameModel =
        (previous?.modelConstraint?.modelSetId ?? previous?.modelSetId) === modelSetId ||
        previous?.profileId === profile.id;
      const fixedWorkflowId = previous?.modelConstraint?.fixedWorkflowId ?? previous?.fixedWorkflowId;
      const workflowMode =
        sameModel && fixedWorkflowId === (profile.workflowMetadata?.id ?? profile.id)
          ? (previous?.modelConstraint?.workflowMode ?? previous?.workflowMode ?? 'auto')
          : 'auto';
      const modelConstraint =
        intent === 'install-other'
          ? undefined
          : {
              modelSetId,
              workflowMode,
              fixedWorkflowId: workflowMode === 'fixed' ? fixedWorkflowId : undefined,
              selectionRevision:
                (previous?.modelConstraint?.selectionRevision ?? 0) +
                (sameModel &&
                workflowMode === (previous?.modelConstraint?.workflowMode ?? previous?.workflowMode ?? 'auto')
                  ? 0
                  : 1),
            };
      const servers = (conversation.extra as { session_mcp_servers?: ISessionMcpServer[] }).session_mcp_servers ?? [];
      const installationInput =
        intent === 'generate'
          ? undefined
          : t(`guid.comfy.prompts.${intent}`, {
              family: profile.name,
              profile: intent === 'repair' ? profile.id : '',
            });
      const next: CreationRequest & { requestId: string } = {
        ...previous,
        requestId: intent === 'generate' ? (previous?.requestId ?? operation.requestId) : crypto.randomUUID(),
        installationMode: intent === 'generate' ? undefined : ('agent' as const),
        installationInput,
        installationError: undefined,
        id: intent === 'install-other' ? profile.family : sameModel ? previous!.id : profile.id,
        name: sameModel ? previous!.name : profile.name,
        kind: profile.kind,
        source: 'local' as const,
        state: profile.state,
        family: profile.family,
        profileId: intent === 'install-other' ? undefined : profile.id,
        intent,
        modelSetId: modelConstraint?.modelSetId,
        workflowMode: modelConstraint?.workflowMode,
        fixedWorkflowId: modelConstraint?.fixedWorkflowId,
        modelConstraint,
      };
      const update = (snapshot: typeof previous) =>
        ipcBridge.conversation.update.invoke({
          id: conversationId,
          updates: {
            extra: {
              creation_request: snapshot,
              ...(intent !== 'generate'
                ? { session_mcp_servers: snapshot ? creationSessionServers(servers, snapshot) : servers }
                : {}),
            } as TChatConversation['extra'],
          },
          merge_extra: true,
        });
      if (!(await update(next))) throw new Error(t('guid.comfy.session.saveFailed'));
      try {
        const bound = await comfyApi.bind(next.requestId, conversationId, next.profileId, next.family, next.intent, {
          source: next.source,
          kind: next.kind,
          modelSetId: next.modelSetId,
          workflowMode: next.workflowMode,
          fixedWorkflowId: next.fixedWorkflowId,
          selectionRevision: next.modelConstraint?.selectionRevision,
          modelConstraint: next.modelConstraint,
          installContext: next.installContext,
        });
        if (!bound.ok) throw new Error(t('guid.comfy.session.saveFailed'));
        if (intent !== 'generate') {
          await ipcBridge.conversation.restartRuntime.invoke({ conversation_id: conversationId });
        }
      } catch (cause) {
        if (!(await update(previous))) throw new Error(t('guid.comfy.session.saveFailed'), { cause });
        if (previous?.requestId) {
          const rebound = await comfyApi.bind(
            previous.requestId,
            conversationId,
            previous.profileId,
            previous.family,
            previous.intent,
            {
              source: previous.source,
              kind: previous.kind,
              modelSetId: previous.modelSetId,
              workflowMode: previous.workflowMode,
              fixedWorkflowId: previous.fixedWorkflowId,
              selectionRevision: previous.modelConstraint?.selectionRevision,
              modelConstraint: previous.modelConstraint,
              installContext: previous.installContext,
            }
          );
          if (!rebound.ok) throw new Error(t('guid.comfy.session.saveFailed'), { cause });
        }
        if (intent !== 'generate') {
          await ipcBridge.conversation.restartRuntime.invoke({ conversation_id: conversationId });
        }
        throw cause;
      }
      if (intent !== 'generate') {
        requestConversationSendBoxPrefill(conversationId, installationInput!);
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
  if (compact && operation && operation.state !== 'awaiting-consent')
    return (
      <section className='mt-8px text-13px space-y-4px' data-testid='comfy-operation-summary'>
        <div role='status'>
          {operation.plan.name} ·{' '}
          {t(
            operation.state === 'failed' && runtime.isProcessing
              ? 'guid.comfy.operation.recovering'
              : `guid.comfy.operation.states.${operation.state}`
          )}
        </div>
        <Button type='text' size='mini' onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {t('guid.comfy.operation.details')}
        </Button>
        {expanded && <ComfyOperationResult id={id} conversationId={conversationId} />}
      </section>
    );
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
      {operation?.state === 'awaiting-consent' && (
        <Button type='primary' loading={busy} disabled={runtime.isProcessing} onClick={() => void authorize()}>
          {t('guid.comfy.operation.authorize')}
        </Button>
      )}
      {operation && ['paused', 'failed'].includes(operation.state) && (
        <Button
          type='primary'
          loading={busy}
          disabled={runtime.isProcessing || selectionPending}
          onClick={() => void diagnose()}
        >
          {t('guid.comfy.operation.continue')}
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
