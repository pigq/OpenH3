import useSWR from 'swr';
import { useRef } from 'react';
import { useOptionalCloudAccount } from '@/renderer/components/settings/SettingsModal/CloudAccount/Provider';
import { MODEL_CATALOG_REFRESH_SPACING } from '@/renderer/components/settings/SettingsModal/CloudAccount/Panels/freshness';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { cloudVideoApi } from '@/common/chat/document/creation/cloudVideoApi';
import { accountMediaCatalog, accountMediaRef } from '@/common/chat/document/creation/accountMedia';
import type { CreationKind } from '@/common/chat/document/creation/creation';

/** Keep account creation choices separate from the Agent's text catalog and manual API connections. */
export function useAccountMedia(enabled: boolean, cloudMenu: boolean, kind: CreationKind) {
  const account = useOptionalCloudAccount();
  const accountId = account?.session?.state === 'connected' ? account.session.account.id : undefined;
  const desktop = enabled && isElectronDesktop();
  const active = desktop && !!accountId;
  const lastRead = useRef<{ scope: string; nextAt: number; pending: boolean } | undefined>(undefined);
  const models = useSWR(
    active && cloudMenu ? ['creation.account-media', account.scope] : null,
    async () => {
      if (!account) throw new Error('CLOUD_MEDIA_CATALOG_UNAVAILABLE');
      const read = { scope: account.scope, nextAt: Date.now() + MODEL_CATALOG_REFRESH_SPACING, pending: true };
      lastRead.current = read;
      try {
        const result = await account.readOwned({ operation: 'mediaModels' });
        if (result?.success === false && result.code === 'CLOUD_RATE_LIMITED')
          read.nextAt = Math.max(
            read.nextAt,
            Date.now() + (result.retry_after ?? result.details?.retry_after ?? 60) * 1000
          );
        const parsed = result?.success && accountMediaCatalog.safeParse(result.data);
        if (!parsed || !parsed.success || parsed.data.account_id !== accountId)
          throw new Error('CLOUD_MEDIA_CATALOG_UNAVAILABLE');
        return { catalog: parsed.data, nextAt: read.nextAt };
      } catch {
        // Cache a failed observation too, so new-chat navigation keeps the same retry boundary.
        return { catalog: undefined, nextAt: read.nextAt };
      } finally {
        read.pending = false;
      }
    },
    {
      shouldRetryOnError: false,
      keepPreviousData: false,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: MODEL_CATALOG_REFRESH_SPACING,
    }
  );
  const defaults = useSWR(
    desktop ? ['creation.account-media-defaults', account?.scope] : null,
    cloudVideoApi.accountDefaults,
    {
      shouldRetryOnError: false,
      keepPreviousData: false,
    }
  );
  const unavailable = !!models.error || (!!models.data && !models.data.catalog);
  const catalog =
    active && !unavailable && models.data?.catalog?.account_id === accountId ? models.data.catalog : undefined;
  const catalogState =
    !active || !cloudMenu
      ? undefined
      : unavailable
        ? 'unavailable'
        : !catalog
          ? 'checking'
          : catalog.models.some((model) => model.kind === kind)
            ? 'available'
            : 'empty';
  const setDefault = async (selectedKind: CreationKind, id: string): Promise<void> => {
    if (!desktop) return;
    const reference = accountMediaRef(id);
    if (
      reference &&
      (reference.accountId !== catalog?.account_key ||
        !catalog?.models.some((model) => model.kind === selectedKind && model.model_id === reference.modelId))
    ) {
      throw new Error('CLOUD_MEDIA_SELECTION_UNAVAILABLE');
    }
    if (!reference && !defaults.data?.[selectedKind] && (!active || defaults.data)) return;
    const stillCurrent = account?.captureScope();
    const result = await cloudVideoApi.setAccountDefault(selectedKind, reference);
    if (!result.ok || (stillCurrent && !stillCurrent())) throw new Error('CLOUD_MEDIA_SELECTION_CHANGED');
    void defaults.mutate();
  };
  return {
    accountId: catalog?.account_key,
    catalog,
    catalogState,
    setDefault,
    defaultModel: defaults.data?.[kind]?.accountId === catalog?.account_key ? defaults.data?.[kind] : undefined,
    refresh: (deliberate = true): void => {
      if (!active || !cloudMenu || models.isValidating) return;
      const read = lastRead.current;
      if (read?.scope === account.scope && read.pending) return;
      if (
        !deliberate &&
        Date.now() < Math.max(read?.scope === account.scope ? read.nextAt : 0, models.data?.nextAt ?? 0)
      )
        return;
      void models.mutate();
    },
  };
}
