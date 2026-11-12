import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Select, Skeleton, Tabs } from '@arco-design/web-react';
import { Search } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { ipcBridge } from '@/common';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import type {
  LocalModelCenterSnapshot,
  LocalModelRecommendation,
} from '@/common/chat/document/creation/workflows/localModels';
import { startModelCenterInstallation, useModelCenterProfile } from '@/renderer/pages/guid/Creation/modelCenterEntry';
import HardwareOverview from './HardwareOverview';
import ModelDetails from './ModelDetails';
import ModelRow from './ModelRow';
import { filterModels, modelAction, type ModelKind, type ModelTab } from './modelCenterView';
import styles from './LocalModels.module.css';

export default function LocalModelsPage() {
  const { user } = useAuth();
  return <ModelCenterContent key={user?.id ?? 'desktop'} owner={user?.id ?? 'desktop'} />;
}

function ModelCenterContent({ owner }: { owner: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { search } = useLocation();
  const storageKey = `local-models.install-directory:${owner}`;
  const [directory, setDirectory] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [snapshot, setSnapshot] = useState<LocalModelCenterSnapshot>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<ModelTab>('recommended');
  const [kind, setKind] = useState<ModelKind>(() => {
    const requested = new URLSearchParams(search).get('kind');
    return requested === 'image' || requested === 'video' ? requested : 'all';
  });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<'load' | 'action' | 'directory'>();
  const sequence = useRef(0);
  const lastRequest = useRef(0);
  const load = useCallback(async (nextDirectory?: string, refresh = false) => {
    const request = ++sequence.current;
    lastRequest.current = Date.now();
    setLoading(!refresh);
    setRefreshing(refresh);
    setError(undefined);
    if (!refresh) setSnapshot(undefined);
    try {
      const next = await comfyApi.modelCenter(nextDirectory);
      if (request === sequence.current) setSnapshot(next);
    } catch {
      if (request === sequence.current) setError('load');
    } finally {
      if (request === sequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);
  useEffect(() => {
    void load(directory);
    return () => {
      ++sequence.current;
    };
  }, [directory, load]);
  useEffect(() => {
    const requested = new URLSearchParams(search).get('kind');
    setKind(requested === 'image' || requested === 'video' ? requested : 'all');
  }, [search]);
  useEffect(() => {
    const refresh = () => {
      if (snapshot && !document.hidden && Date.now() - lastRequest.current > 5000) void load(directory, true);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [directory, load, snapshot]);
  const chooseDirectory = useCallback(() => {
    void ipcBridge.dialog.showOpen
      .invoke({ properties: ['openDirectory', 'createDirectory'] })
      .then((dirs) => {
        const next = dirs?.[0];
        if (!next) return;
        try {
          localStorage.setItem(storageKey, next);
        } catch {
          /* Storage is optional. */
        }
        setDirectory(next);
      })
      .catch(() => setError('directory'));
  }, [storageKey]);
  const models = useMemo(() => {
    if (!snapshot) return [];
    const source =
      tab === 'installed'
        ? snapshot.models.filter((model) => model.installed)
        : tab === 'recommended'
          ? snapshot.recommendations
          : snapshot.models;
    return filterModels(source, kind, query);
  }, [kind, query, snapshot, tab]);
  const action = useCallback(
    (model: LocalModelRecommendation) => {
      if (!snapshot || busy || loading || refreshing) return;
      if (error === 'load' && modelAction(model) === 'install') return;
      setBusy(model.id);
      setError(undefined);
      void Promise.resolve()
        .then(() => {
          const next = modelAction(model);
          if (next === 'progress' && model.activity)
            return navigate(`/conversation/${encodeURIComponent(model.activity.conversationId)}`);
          if (next === 'use') return useModelCenterProfile(model, navigate);
          return startModelCenterInstallation(model, snapshot.device, navigate, 'install');
        })
        .catch(() => setError('action'))
        .finally(() => setBusy(undefined));
    },
    [navigate, snapshot, busy, loading, refreshing, error]
  );
  const recommendation = models[0];
  const detailModel =
    snapshot?.models.find((model) => model.id === selected) ??
    snapshot?.recommendations.find((model) => model.id === selected);
  const actionDisabled = (model: LocalModelRecommendation) =>
    refreshing || !!busy || (error === 'load' && modelAction(model) === 'install');
  const compact = models.slice(tab === 'recommended' ? 1 : 0, tab === 'recommended' ? 3 : undefined);
  return (
    <main className={styles.page} aria-busy={loading}>
      <div className={styles.content}>
        <header className={styles.header}>
          <div>
            <h1>{t('guid.localModels.title')}</h1>
            <p className={styles.subtitle}>{t('guid.localModels.subtitle')}</p>
          </div>
        </header>
        <ol className={styles.journey} aria-label={t('guid.localModels.journey.label')}>
          {(['device', 'choose', 'create'] as const).map((step, index) => (
            <li key={step}>
              <span className={styles.stepNumber} aria-hidden='true'>
                {index + 1}
              </span>
              <div>
                <strong>{t(`guid.localModels.journey.${step}`)}</strong>
                <span>{t(`guid.localModels.journey.${step}Hint`)}</span>
              </div>
            </li>
          ))}
        </ol>
        {error && (
          <Alert
            type='warning'
            content={t(`guid.localModels.errors.${error}`)}
            action={
              <Button size='small' onClick={() => void load(directory, !!snapshot)}>
                {t('guid.localModels.retry')}
              </Button>
            }
          />
        )}
        {snapshot && !loading ? (
          <HardwareOverview
            snapshot={snapshot}
            refreshing={refreshing}
            onRefresh={() => void load(directory, true)}
            onDirectory={chooseDirectory}
          />
        ) : loading ? (
          <section className={styles.skeleton} aria-label={t('guid.localModels.loading')}>
            <Skeleton text={{ rows: 4 }} />
            <Button type='text' onClick={chooseDirectory}>
              {t('guid.localModels.changeDirectory')}
            </Button>
          </section>
        ) : (
          <section className={styles.empty}>
            <Empty description={t('guid.localModels.unavailable')} />
            <Button onClick={() => void load(directory)}>{t('guid.localModels.retry')}</Button>
            <Button type='text' onClick={chooseDirectory}>
              {t('guid.localModels.changeDirectory')}
            </Button>
          </section>
        )}
        <section className={styles.catalog} aria-labelledby='models-heading'>
          <div className={styles.catalogHeading}>
            <div>
              <h2 id='models-heading'>
                {t(tab === 'recommended' ? 'guid.localModels.recommendedHeading' : 'guid.localModels.models')}
              </h2>
            </div>
            <Input
              className={styles.search}
              allowClear
              prefix={<Search size={15} />}
              value={query}
              onChange={setQuery}
              placeholder={t('guid.localModels.search')}
              aria-label={t('guid.localModels.search')}
            />
          </div>
          <div className={styles.controls}>
            <Tabs activeTab={tab} onChange={(value) => setTab(value as ModelTab)}>
              <Tabs.TabPane key='recommended' title={t('guid.localModels.tabs.recommended')} />
              <Tabs.TabPane key='all' title={t('guid.localModels.tabs.all')} />
              <Tabs.TabPane key='installed' title={t('guid.localModels.tabs.installed')} />
            </Tabs>
            <Select
              value={kind}
              onChange={(value) => setKind(value as ModelKind)}
              aria-label={t('guid.localModels.filter')}
              options={[
                { value: 'all', label: t('guid.localModels.filters.all') },
                { value: 'image', label: t('guid.localModels.filters.image') },
                { value: 'video', label: t('guid.localModels.filters.video') },
              ]}
            />
          </div>
          {loading && (
            <div className={styles.skeleton}>
              <Skeleton image text={{ rows: 3 }} />
            </div>
          )}
          {tab === 'recommended' && recommendation && (
            <ModelRow
              model={recommendation}
              featured
              busy={busy === recommendation.id}
              disabled={actionDisabled(recommendation)}
              onAction={action}
              onDetails={(model) => setSelected(model.id)}
            />
          )}
          <div className={tab === 'recommended' ? styles.compactList : styles.modelList}>
            {compact.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                busy={busy === model.id}
                disabled={actionDisabled(model)}
                onAction={action}
                onDetails={(item) => setSelected(item.id)}
              />
            ))}
          </div>
          {!models.length && !loading && <Empty description={t('guid.localModels.noModels')} />}
        </section>
      </div>
      <ModelDetails
        model={detailModel}
        busy={!!selected && busy === selected}
        disabled={detailModel && actionDisabled(detailModel)}
        onClose={() => setSelected(undefined)}
        onAction={(model) => {
          setSelected(undefined);
          action(model);
        }}
      />
    </main>
  );
}
