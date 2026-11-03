import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import type { CreationModel, CreationSelection } from '@/common/chat/document/creation/creation';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import { cloudCreationModels } from '@/common/chat/document/creation/cloudModels';
import { cloudVideoApi } from '@/common/chat/document/creation/cloudVideoApi';
import { getClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import useConfigModelListWithImage from '@/renderer/hooks/agent/useConfigModelListWithImage';
import { COMFY_FAMILIES } from './comfyDraft';
import type { ComfyFamily } from '@/common/chat/document/creation/comfy';

let draftSelection: CreationSelection = { kind: 'video', source: 'local', modelIds: {} };

function savedProfileDetails(id: string | undefined): { name: string; family: ComfyFamily } | undefined {
  if (!id) return;
  try {
    const details = JSON.parse(localStorage.getItem('creation.profile-details') ?? '{}') as Record<
      string,
      { name: string; family: ComfyFamily }
    >;
    const saved = details[id];
    if (saved && typeof saved.name === 'string' && COMFY_FAMILIES.some((family) => family.family === saved.family))
      return saved;
  } catch {
    /* A damaged preference must not change the model family. */
  }
}

function storedSelection(): CreationSelection {
  try {
    const stored = JSON.parse(localStorage.getItem('creation.selection') ?? 'null') as CreationSelection | null;
    if (
      stored &&
      ['image', 'video'].includes(stored.kind) &&
      ['local', 'cloud'].includes(stored.source) &&
      stored.modelIds &&
      typeof stored.modelIds === 'object'
    ) {
      draftSelection = stored;
    }
  } catch {
    /* A damaged preference must not block the composer. */
  }
  return draftSelection;
}

/** Keep creation preferences with the unsent draft, including repeated new-chat navigation. */
export function useCreationModels(enabled: boolean) {
  const { modelListWithImage: providers } = useConfigModelListWithImage();
  const [selection, setState] = useState(storedSelection);
  const setSelection = useCallback((update: React.SetStateAction<CreationSelection>) => {
    draftSelection = typeof update === 'function' ? update(draftSelection) : update;
    try {
      localStorage.setItem('creation.selection', JSON.stringify(draftSelection));
    } catch {
      /* Keep an in-memory draft when storage is unavailable. */
    }
    setState(draftSelection);
  }, []);
  const {
    data: profiles,
    error,
    isLoading,
    mutate,
  } = useSWR(enabled ? 'creation.comfy-profiles' : null, () => comfyApi.profiles(), {
    refreshInterval: 30_000,
    shouldRetryOnError: false,
  });
  const { data: configuredImage } = useSWR(
    enabled && selection.source === 'cloud' ? 'creation.cloud-image-default' : null,
    () => getClientBusinessSetting('tools.imageGenerationModel')
  );
  const { data: videoConnections } = useSWR(
    enabled && selection.source === 'cloud' && selection.kind === 'video' ? 'creation.cloud-video-connections' : null,
    () => cloudVideoApi.connections(),
    { shouldRetryOnError: false }
  );
  useEffect(() => {
    if (!Array.isArray(profiles)) return;
    const slot = `${selection.source}-${selection.kind}` as const;
    const profile = profiles.find((item) => item.id === selection.modelIds[slot]);
    if (!profile) return;
    try {
      const details = JSON.parse(localStorage.getItem('creation.profile-details') ?? '{}') as Record<string, unknown>;
      details[profile.id] = { name: profile.name, family: profile.family };
      localStorage.setItem('creation.profile-details', JSON.stringify(details));
    } catch {
      /* Keep the current inventory when storage is unavailable. */
    }
  }, [profiles, selection]);
  const models = useMemo<CreationModel[]>(() => {
    const { kind, source } = selection;
    if (source === 'local') {
      const matching = (Array.isArray(profiles) ? profiles : []).filter((profile) => profile.kind === kind);
      return matching.map(
        (profile): CreationModel => ({
          id: profile.id,
          name: profile.name,
          profileId: profile.id,
          family: profile.family,
          kind,
          source,
          state: profile.state,
          available: profile.state === 'verified',
          intent: 'generate',
        })
      );
    }
    return cloudCreationModels(providers, kind, videoConnections);
  }, [selection.kind, selection.source, providers, profiles, error, isLoading, videoConnections]);
  const slot = `${selection.source}-${selection.kind}` as const;
  const savedModelId = selection.modelIds[slot];
  const unavailableSelection: CreationModel | undefined =
    savedModelId &&
    !models.some((item) => item.id === savedModelId) &&
    !(selection.source === 'local' && COMFY_FAMILIES.some((item) => item.family === savedModelId))
      ? {
          id: savedModelId,
          name: savedModelId,
          kind: selection.kind,
          source: selection.source,
          state: 'unavailable',
          available: false,
          ...(selection.source === 'local' ? { profileId: savedModelId, ...savedProfileDetails(savedModelId) } : {}),
        }
      : undefined;
  const model =
    models.find((item) => item.id === savedModelId) ??
    unavailableSelection ??
    models.find(
      (item) => item.provider?.id === configuredImage?.id && item.provider?.use_model === configuredImage?.use_model
    ) ??
    models[0] ??
    ({
      id: `empty:${slot}`,
      name: '',
      kind: selection.kind,
      source: selection.source,
      state: isLoading ? 'checking' : error ? 'unavailable' : 'not-installed',
      available: false,
    } satisfies CreationModel);
  return {
    selection,
    setSelection,
    models: unavailableSelection ? [...models, unavailableSelection] : models,
    model,
    profiles: Array.isArray(profiles) ? profiles : [],
    isLoading,
    error,
    refresh: mutate,
  };
}
