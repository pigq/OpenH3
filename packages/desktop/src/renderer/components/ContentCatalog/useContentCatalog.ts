import { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { contentCatalog } from '@/common/contentCatalog/bridge';
import { parseCatalog, type ContentStatus } from '@/common/contentCatalog/schema';
import { catalogPageState, type CatalogPageState } from './contentCatalogState';

export function useContentCatalog(enabled = true) {
  const [page, setPage] = useState<CatalogPageState>({});
  const status = useSWR<ContentStatus>(
    enabled ? 'official-content.status' : null,
    () => contentCatalog.status.invoke(),
    { refreshInterval: 5000, shouldRetryOnError: false }
  );
  const latest = useSWR(
    enabled ? ['official-content.catalog', status.data?.activeSequence] : null,
    async () => parseCatalog(await contentCatalog.catalog.invoke()),
    { shouldRetryOnError: false }
  );
  useEffect(() => {
    if (latest.data) setPage((previous) => catalogPageState(previous, latest.data));
  }, [latest.data]);
  const sequence = page.current?.releaseSequence;
  useEffect(() => {
    if (!enabled || sequence === undefined) return;
    const renew = () => {
      void contentCatalog.lease.invoke({ sequence }).catch(() => {});
    };
    renew();
    const timer = setInterval(renew, 60000);
    return () => clearInterval(timer);
  }, [enabled, sequence]);
  const accept = useCallback(() => {
    if (page.pending) setPage({ current: page.pending });
  }, [page.pending]);
  const act = useCallback(
    async (action: 'check' | 'cancel' | 'restore' | 'settings', autoSync?: boolean) => {
      const next =
        action === 'settings'
          ? await contentCatalog.settings.invoke({ autoSync: !!autoSync })
          : await contentCatalog[action].invoke({});
      await status.mutate({ ...next, canManage: status.data?.canManage });
      await latest.mutate();
    },
    [status.mutate, latest.mutate, status.data?.canManage]
  );
  return {
    ...page,
    status: status.data,
    error: status.error || latest.error,
    loading: !page.current && !latest.error,
    accept,
    act,
  };
}
