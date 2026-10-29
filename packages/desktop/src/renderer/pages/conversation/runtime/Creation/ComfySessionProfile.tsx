import React, { useEffect, useRef, useState } from 'react';
import { Button, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import useSWR, { mutate } from 'swr';
import { ipcBridge } from '@/common';
import { isBuiltinVideoMediaName, type ISessionMcpServer, type TChatConversation } from '@/common/config/storage';
import { creationSessionServers, type CreationRequest } from '@/common/chat/document/creation/creation';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { useConversationRuntimeView } from '../useConversationRuntimeView';
import { beginComfySelectionChange, useComfySelectionPending } from './useComfySelectionPending';

type Snapshot = CreationRequest & { requestId?: string };
type CreationExtra = { creation_request?: Snapshot; session_mcp_servers?: ISessionMcpServer[]; skills?: string[] };

function LocalProfileSelector({ conversation, snapshot }: { conversation: TChatConversation; snapshot: Snapshot }) {
  const { t } = useTranslation();
  const runtime = useConversationRuntimeView(conversation.id);
  const pending = useComfySelectionPending(conversation.id);
  const { data: profiles = [], isLoading } = useSWR('creation.comfy-profiles', () => comfyApi.profiles(), {
    refreshInterval: 30_000,
    shouldRetryOnError: false,
  });
  const [selected, setSelected] = useState(snapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changing = useRef(false);
  useEffect(() => setSelected(snapshot), [snapshot]);

  const change = async (profileId: string) => {
    const profile = profiles.find((item) => item.id === profileId);
    if (
      !profile ||
      changing.current ||
      pending ||
      runtime.isProcessing ||
      (selected.profileId === profileId && selected.intent === 'generate')
    )
      return;
    changing.current = true;
    const finishSelection = beginComfySelectionChange(conversation.id);
    setBusy(true);
    setError('');
    const legacy = !selected.requestId;
    const next: Snapshot = {
      ...selected,
      requestId: selected.requestId ?? crypto.randomUUID(),
      id: profile.id,
      name: profile.name,
      source: 'local',
      kind: profile.kind,
      family: profile.family,
      profileId: profile.id,
      state: profile.state,
      intent: 'generate',
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
      });
      if (!bound.ok) throw new Error(t('guid.comfy.session.saveFailed'));
      if (legacy) {
        runtime.markRestartStarted();
        restarted = true;
        const response = await ipcBridge.conversation.restartRuntime.invoke({ conversation_id: conversation.id });
        runtime.markRestartSucceeded(response.runtime);
      }
      setSelected(next);
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
              { source: selected.source, kind: selected.kind }
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
    label: `${profile.name} · ${t(`guid.templateFilters.${profile.kind}`)} · ${profile.version} · ${profile.quantization} · ${t(`guid.creation.states.${profile.state}`)}`,
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
        <span className='text-12px text-t-secondary'>{t('guid.comfy.session.title')}</span>
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
      <div className='mt-4px text-12px text-t-secondary'>{t('guid.comfy.session.hint')}</div>
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
