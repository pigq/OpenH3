import React, { useEffect, useRef, useState } from 'react';
import { Button, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import useSWR, { mutate } from 'swr';
import { ipcBridge } from '@/common';
import { isBuiltinVideoMediaName, type ISessionMcpServer, type TChatConversation } from '@/common/config/storage';
import { creationSessionServers, type CreationRequest } from '@/common/chat/document/creation/creation';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import {
  comfyWorkflowStatus,
  getComfyModelSetId,
  groupComfyModels,
} from '@/common/chat/document/creation/workflows/identity';
import type { WorkflowSelectionMode } from '@/common/chat/document/creation/workflows/contracts';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { useConversationRuntimeView } from '../useConversationRuntimeView';
import { beginComfySelectionChange, useComfySelectionPending } from './useComfySelectionPending';

type Snapshot = CreationRequest & { requestId?: string };
type CreationExtra = { creation_request?: Snapshot; session_mcp_servers?: ISessionMcpServer[]; skills?: string[] };

function LocalProfileSelector({ conversation, snapshot }: { conversation: TChatConversation; snapshot: Snapshot }) {
  const { t } = useTranslation();
  const runtime = useConversationRuntimeView(conversation.id);
  const pending = useComfySelectionPending(conversation.id);
  const { data: allProfiles = [], isLoading } = useSWR('creation.comfy-profiles', () => comfyApi.profiles(), {
    refreshInterval: 30_000,
    shouldRetryOnError: false,
  });
  const [selected, setSelected] = useState(snapshot);
  const groups = groupComfyModels(allProfiles);
  const profiles = groups.map(
    ({ profiles: routes }) =>
      routes.find((profile) => profile.id === selected.profileId) ??
      routes.find((profile) => comfyWorkflowStatus(profile) === 'verified') ??
      routes[0]
  );
  const selectedGroup = groups.find((group) => group.profiles.some((profile) => profile.id === selected.profileId));
  const workflowMode = selected.modelConstraint?.workflowMode ?? selected.workflowMode ?? 'auto';
  const fixedWorkflowId = selected.modelConstraint?.fixedWorkflowId ?? selected.fixedWorkflowId;
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changing = useRef(false);
  const requestedMissingProfile = useRef<string | undefined>(undefined);
  const saveFailedMessage = t('guid.comfy.session.saveFailed');
  useEffect(() => setSelected(snapshot), [snapshot]);
  const { data: authoritative } = useSWR(
    snapshot.requestId ? ['comfy.selection', conversation.id, snapshot.requestId, snapshot.profileId] : null,
    () => comfyApi.selection(snapshot.requestId!),
    { refreshInterval: 3_000, shouldRetryOnError: false }
  );
  useEffect(() => {
    if (
      !authoritative ||
      changing.current ||
      authoritative.requestId !== snapshot.requestId ||
      authoritative.conversationId !== conversation.id ||
      authoritative.source !== 'local' ||
      authoritative.intent !== 'generate' ||
      !authoritative.profileId ||
      (authoritative.modelConstraint?.selectionRevision ?? authoritative.selectionRevision ?? 0) <
        (selected.modelConstraint?.selectionRevision ?? 0) ||
      (authoritative.profileId === snapshot.profileId &&
        (authoritative.workflowMode ?? authoritative.modelConstraint?.workflowMode ?? 'auto') ===
          (snapshot.modelConstraint?.workflowMode ?? snapshot.workflowMode ?? 'auto') &&
        (authoritative.fixedWorkflowId ?? authoritative.modelConstraint?.fixedWorkflowId) ===
          (snapshot.modelConstraint?.fixedWorkflowId ?? snapshot.fixedWorkflowId) &&
        (authoritative.modelConstraint?.selectionRevision ?? authoritative.selectionRevision ?? 0) ===
          (snapshot.modelConstraint?.selectionRevision ?? 0))
    )
      return;
    const profile = allProfiles.find((item) => item.id === authoritative.profileId);
    if (!profile) {
      if (requestedMissingProfile.current !== authoritative.profileId) {
        requestedMissingProfile.current = authoritative.profileId;
        void mutate('creation.comfy-profiles').catch((): void => undefined);
      }
      return;
    }
    requestedMissingProfile.current = undefined;
    let disposed = false;
    changing.current = true;
    setBusy(true);
    const sync = async () => {
      const current = await ipcBridge.conversation.get.invoke({ id: conversation.id });
      const saved = (current.extra as CreationExtra).creation_request;
      if (disposed || saved?.requestId !== snapshot.requestId || saved.profileId !== snapshot.profileId) return;
      const next: Snapshot = {
        ...saved,
        id: selectedGroup?.modelSetId === getComfyModelSetId(profile) ? saved.id : profile.id,
        profileId: profile.id,
        name: selectedGroup?.modelSetId === getComfyModelSetId(profile) ? saved.name : profile.name,
        family: profile.family,
        kind: profile.kind,
        state: profile.state,
        intent: 'generate',
        modelSetId:
          authoritative.modelSetId ?? authoritative.modelConstraint?.modelSetId ?? getComfyModelSetId(profile),
        workflowMode: authoritative.workflowMode ?? authoritative.modelConstraint?.workflowMode ?? 'auto',
        fixedWorkflowId: authoritative.fixedWorkflowId ?? authoritative.modelConstraint?.fixedWorkflowId,
        modelConstraint: authoritative.modelConstraint ?? {
          modelSetId: authoritative.modelSetId ?? getComfyModelSetId(profile),
          selectionRevision: authoritative.selectionRevision ?? saved.modelConstraint?.selectionRevision ?? 0,
          workflowMode: authoritative.workflowMode ?? 'auto',
          fixedWorkflowId: authoritative.fixedWorkflowId,
        },
      };
      // The service already persisted the validated adoption. Never bind a stale UI snapshot back to it.
      if (
        !(await ipcBridge.conversation.update.invoke({
          id: conversation.id,
          updates: { extra: { creation_request: next } as TChatConversation['extra'] },
          merge_extra: true,
        }))
      )
        throw new Error(saveFailedMessage);
      if (!disposed) setSelected(next);
      await mutate(`conversation/${conversation.id}`).catch((): void => undefined);
    };
    void sync()
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        changing.current = false;
        setBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [authoritative, snapshot, allProfiles, conversation.id, saveFailedMessage]);

  const change = async (profileId: string, mode: WorkflowSelectionMode = 'auto') => {
    const profile = allProfiles.find((item) => item.id === profileId);
    const fixedId = mode === 'fixed' ? (profile?.workflowMetadata?.id ?? profileId) : undefined;
    if (
      !profile ||
      changing.current ||
      pending ||
      runtime.isProcessing ||
      (selected.profileId === profileId &&
        selected.intent === 'generate' &&
        workflowMode === mode &&
        fixedWorkflowId === fixedId)
    )
      return;
    changing.current = true;
    const finishSelection = beginComfySelectionChange(conversation.id);
    setBusy(true);
    setError('');
    const legacy = !selected.requestId;
    const modelSetId = getComfyModelSetId(profile);
    const sameModel = selectedGroup?.modelSetId === modelSetId;
    const next: Snapshot = {
      ...selected,
      requestId: selected.requestId ?? crypto.randomUUID(),
      id: sameModel ? selected.id : profile.id,
      name: sameModel ? selected.name : profile.name,
      source: 'local',
      kind: profile.kind,
      family: profile.family,
      profileId: profile.id,
      state: profile.state,
      intent: 'generate',
      modelSetId,
      workflowMode: mode,
      fixedWorkflowId: fixedId,
      modelConstraint: {
        modelSetId,
        selectionRevision: (selected.modelConstraint?.selectionRevision ?? 0) + 1,
        workflowMode: mode,
        fixedWorkflowId: fixedId,
      },
    };
    const extra = conversation.extra as CreationExtra;
    let patch: CreationExtra = { creation_request: next };
    let saved = false;
    let restarted = false;
    const update = (value: CreationExtra) =>
      ipcBridge.conversation.update.invoke({
        id: conversation.id,
        updates: { extra: value as TChatConversation['extra'] },
        merge_extra: true,
      });
    try {
      if (legacy) {
        let servers = extra.session_mcp_servers ?? [];
        if (!servers.some((server) => isBuiltinVideoMediaName(server.name))) {
          const required = (await ensureBackendMcpCatalog()).allServers.find(
            (server) => server.builtin && isBuiltinVideoMediaName(server.name)
          );
          if (!required) throw new Error(t('guid.creation.toolsUnavailable'));
          servers = [...servers, toSessionMcpServer(required)];
        }
        patch = {
          ...patch,
          session_mcp_servers: creationSessionServers(servers, next, undefined, next.requestId),
          skills: [...new Set([...(extra.skills ?? []), 'comfyui-local'])],
        };
      }
      if (!(await update(patch))) throw new Error(t('guid.comfy.session.saveFailed'));
      saved = true;
      const bound = await comfyApi.bind(next.requestId!, conversation.id, next.profileId, next.family, next.intent, {
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
      if (legacy) {
        runtime.markRestartStarted();
        restarted = true;
        const response = await ipcBridge.conversation.restartRuntime.invoke({ conversation_id: conversation.id });
        runtime.markRestartSucceeded(response.runtime);
      }
      setSelected(next);
      // Replace the read cache too, so an older poll cannot undo an explicit selection.
      await mutate(
        ['comfy.selection', conversation.id, next.requestId, next.profileId],
        {
          ...next,
          conversationId: conversation.id,
        },
        false
      ).catch((): void => undefined);
      // The selected binding is already saved; a cache read cannot undo it.
      await mutate(`conversation/${conversation.id}`).catch((): void => undefined);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (restarted) runtime.markRestartFailed(conversation.runtime ?? null, reason);
      if (saved) {
        try {
          const restored = await update(
            legacy
              ? {
                  creation_request: selected,
                  session_mcp_servers: extra.session_mcp_servers ?? [],
                  skills: extra.skills ?? [],
                }
              : { creation_request: selected }
          );
          if (!restored) throw new Error(t('guid.comfy.session.saveFailed'), { cause });
          if (selected.requestId) {
            const rebound = await comfyApi.bind(
              selected.requestId,
              conversation.id,
              selected.profileId,
              selected.family,
              selected.intent,
              {
                source: selected.source,
                kind: selected.kind,
                modelSetId: selected.modelSetId,
                workflowMode: selected.workflowMode,
                fixedWorkflowId: selected.fixedWorkflowId,
                selectionRevision: selected.modelConstraint?.selectionRevision,
                modelConstraint: selected.modelConstraint,
                installContext: selected.installContext,
              }
            );
            if (!rebound.ok) throw new Error(t('guid.comfy.session.saveFailed'), { cause });
          }
        } catch {
          setError(`${reason} · ${t('guid.comfy.session.saveFailed')}`);
          return;
        }
      }
      setError(reason);
    } finally {
      finishSelection();
      changing.current = false;
      setBusy(false);
    }
  };
  const options = profiles.map((profile) => ({
    value: profile.id,
    label: `${profile.id === selected.profileId ? selected.name : profile.name} · ${t(`guid.templateFilters.${profile.kind}`)} · ${profile.version} · ${profile.quantization}`,
    disabled: false,
  }));
  if (!options.some((option) => option.value === (selected.profileId ?? selected.id)))
    options.unshift({
      value: selected.profileId ?? selected.id,
      label: `${selected.name} · ${t(`guid.creation.states.${selected.state}`)}`,
      disabled: true,
    });
  return (
    <div className='shrink-0 px-20px py-8px border-b border-3' data-testid='comfy-session-profile'>
      <div className='flex items-center flex-wrap gap-8px'>
        <span className='text-12px text-t-secondary'>
          {t(
            selected.intent && selected.intent !== 'generate'
              ? `guid.comfy.actions.${selected.intent}`
              : 'guid.comfy.session.title'
          )}
        </span>
        {selected.intent && selected.intent !== 'generate' ? (
          <strong className='text-13px'>{selected.name}</strong>
        ) : (
          <Select
            aria-label={t('guid.comfy.session.title')}
            size='small'
            className='min-w-200px max-w-500px flex-1'
            value={selected.profileId ?? selected.id}
            options={options}
            loading={busy || isLoading}
            disabled={busy || pending || runtime.isProcessing}
            onChange={(id: string) => void change(id)}
          />
        )}
        {(!selected.intent || selected.intent === 'generate') && (
          <>
            <span className='text-12px text-t-secondary'>{t(`guid.comfy.workflows.${workflowMode}`)}</span>
            <Button type='text' size='small' onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}>
              {t('guid.comfy.workflows.advanced')}
            </Button>
          </>
        )}
        {selected.intent !== 'generate' &&
          profiles.some((profile) => profile.id === selected.profileId && profile.state === 'verified') && (
            <Button
              size='small'
              type='primary'
              loading={busy}
              disabled={busy || pending || runtime.isProcessing}
              onClick={() => void change(selected.profileId!)}
            >
              {t('guid.comfy.use')}
            </Button>
          )}
      </div>
      {(!selected.intent || selected.intent === 'generate') && (
        <div className='mt-4px text-12px text-t-secondary'>{t('guid.comfy.session.hint')}</div>
      )}
      {advanced && selectedGroup && (
        <div className='mt-8px flex flex-col gap-8px text-12px'>
          <Select
            aria-label={t('guid.comfy.workflows.mode')}
            size='small'
            value={workflowMode === 'auto' ? 'auto' : `fixed:${selected.profileId}`}
            disabled={busy || pending || runtime.isProcessing}
            options={[
              { value: 'auto', label: t('guid.comfy.workflows.auto') },
              ...selectedGroup.profiles.map((profile) => ({
                value: `fixed:${profile.id}`,
                label: `${t('guid.comfy.workflows.fixed')} · ${profile.workflowMetadata?.id ?? profile.id} · ${t(`guid.comfy.workflows.states.${comfyWorkflowStatus(profile)}`)}`,
              })),
            ]}
            onChange={(value: string) =>
              void change(value === 'auto' ? selected.profileId! : value.slice(6), value === 'auto' ? 'auto' : 'fixed')
            }
          />
          <span className='text-t-secondary'>{t('guid.comfy.workflows.autoHint')}</span>
          {selectedGroup.profiles.map((profile) => (
            <div key={profile.id} className='break-all'>
              <span>
                {profile.workflowMetadata?.id ?? profile.id} ·{' '}
                {t(`guid.comfy.workflows.states.${comfyWorkflowStatus(profile)}`)}
              </span>
              {profile.workflowMetadata && (
                <span>
                  {' '}
                  · {profile.workflowMetadata.tasks.map((task) => t(`guid.comfy.workflows.tasks.${task}`)).join(' · ')}
                </span>
              )}
              <div className='text-t-secondary'>
                {t('guid.comfy.workflows.environment')}: {profile.environment?.root}
              </div>
              {profile.validation?.error && <div role='alert'>{profile.validation.error}</div>}
            </div>
          ))}
        </div>
      )}
      {error && (
        <div role='alert' className='mt-4px text-12px text-t-secondary'>
          {error}
        </div>
      )}
    </div>
  );
}

/** Keep the next local generation tied to a concrete conversation-owned profile. */
export default function ComfySessionProfile({ conversation }: { conversation: TChatConversation }) {
  const snapshot = (conversation.extra as CreationExtra | undefined)?.creation_request;
  if (!snapshot || snapshot.source !== 'local') return null;
  return <LocalProfileSelector key={conversation.id} conversation={conversation} snapshot={snapshot} />;
}
