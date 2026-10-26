import React, { useState } from 'react';
import { Alert, Button, Switch, Modal, Collapse } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useContentCatalog } from './useContentCatalog';
export default function ContentUpdatePanel() {
  const { t } = useTranslation();
  const { status, error, act, current, pending } = useContentCatalog();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  const run = async (action: 'check' | 'cancel' | 'restore' | 'settings', value?: boolean) => {
    setBusy(true);
    setActionError(false);
    try {
      await act(action, value);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };
  const working = status && ['checking', 'downloading', 'verifying', 'activating'].includes(status.phase);
  return (
    <section className='flex flex-col gap-12px p-16px rounded-lg bg-fill-2' aria-label={t('update.content.title')}>
      <h3 className='m-0 text-14px'>{t('update.content.title')}</h3>
      <p className='m-0 text-12px text-t-secondary'>{t('update.content.scope')}</p>
      <span className='text-12px'>{t('update.content.source')}</span>
      {status ? (
        <>
          <div role='status'>
            {t('update.content.version', { sequence: status.activeSequence })} ·{' '}
            {t(`update.content.phases.${status.phase}`)}
          </div>
          {status.lastCheckedAt && (
            <span className='text-12px text-t-secondary'>
              {t('update.content.lastChecked', { time: new Date(status.lastCheckedAt).toLocaleString() })}
            </span>
          )}
          {!status.sourceConfigured && <Alert type='info' content={t('update.content.unconfigured')} />}
          <div className='flex justify-between items-center'>
            <span>{t('update.content.autoSync')}</span>
            <Switch
              checked={status.autoSync}
              disabled={busy || status.canManage === false}
              onChange={(value) => void run('settings', value)}
            />
          </div>
          <div className='flex flex-wrap gap-8px'>
            <Button
              loading={busy}
              disabled={!!working || !status.sourceConfigured || status.canManage === false}
              onClick={() => void run('check')}
            >
              {t('update.content.check')}
            </Button>
            {working && (
              <Button disabled={busy || status.canManage === false} onClick={() => void run('cancel')}>
                {t('update.content.cancel')}
              </Button>
            )}
            <Button
              disabled={busy || !!working || status.canManage === false}
              onClick={() =>
                Modal.confirm({
                  title: t('update.content.restore'),
                  content: t('update.content.restoreConfirm'),
                  onOk: () => run('restore'),
                })
              }
            >
              {t('update.content.restore')}
            </Button>
          </div>
          {current && (
            <span className='text-12px text-t-secondary'>
              {t('update.content.summary', {
                templates: (pending ?? current).entries.filter((e) => e.entryType === 'template').length,
                showcases: (pending ?? current).entries.filter((e) => e.entryType === 'showcase').length,
                models: (pending ?? current).models.length,
              })}
            </span>
          )}
          {status.errorCode && (
            <Alert
              type={status.phase === 'incompatible' ? 'info' : 'warning'}
              content={
                <>
                  {t('update.content.failed')} <code>{status.errorCode}</code>
                </>
              }
            />
          )}
          {status.changes && (
            <Collapse defaultActiveKey={['changes']}>
              <Collapse.Item name='changes' header={t('update.content.changes')}>
                {(['added', 'changed', 'removed'] as const).map((kind) => (
                  <div key={kind}>
                    <strong>
                      {t(`update.content.${kind}`)} ({status.changes![kind].length})
                    </strong>
                    <ul className='max-h-160px overflow-auto'>
                      {status.changes![kind].map((id) => (
                        <li key={id}>{id}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </Collapse.Item>
            </Collapse>
          )}
        </>
      ) : (
        <Alert type='info' content={t(error ? 'update.content.unavailable' : 'update.content.loading')} />
      )}
      {actionError && <Alert type='error' content={t('update.content.actionFailed')} />}
    </section>
  );
}
