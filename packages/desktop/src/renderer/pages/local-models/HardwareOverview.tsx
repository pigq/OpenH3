import React from 'react';
import { Button, Collapse, Progress } from '@arco-design/web-react';
import { FolderOpen, Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { LocalModelCenterSnapshot } from '@/common/chat/document/creation/workflows/localModels';
import { formatBytes, usedPercent } from './modelCenterView';
import styles from './LocalModels.module.css';

export default function HardwareOverview({
  snapshot,
  refreshing,
  onRefresh,
  onDirectory,
}: {
  snapshot: LocalModelCenterSnapshot;
  refreshing: boolean;
  onRefresh: () => void;
  onDirectory: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { device } = snapshot;
  const unknown = t('guid.localModels.unknown');
  const bytes = (value?: number) => formatBytes(value, i18n.language, unknown);
  const available = (value?: number) =>
    value === undefined || !Number.isFinite(value) || value < 0
      ? unknown
      : t('guid.localModels.available', { value: bytes(value) });
  const gpu = device.gpus[snapshot.recommendations[0]?.selectedGpuIndex ?? 0] ?? device.gpus[0];
  const checked = new Date(snapshot.checkedAt);
  const memory = (label: string, total?: number, free?: number, system = false) => {
    const percent = usedPercent(total, free);
    return (
      <div className={`${styles.memory} ${system ? styles.systemMemory : ''}`}>
        <div className={styles.metricLabel}>
          <span>{label}</span>
          <strong>{bytes(total)}</strong>
        </div>
        {percent !== undefined ? (
          <Progress percent={Math.round(percent)} showText={false} size='small' aria-label={label} />
        ) : (
          <div className={styles.unknownBar} />
        )}
        <span className={styles.secondary}>{available(free)}</span>
      </div>
    );
  };
  const environments = [
    ...new Map(snapshot.inventory.profiles.map((p) => [p.environment.root, p.environment])).values(),
  ];
  return (
    <section className={styles.hardware} aria-labelledby='local-device-heading'>
      <div className={styles.hardwareGrid}>
        <div className={styles.hardwarePrimary}>
          <span className={styles.secondary}>{t('guid.localModels.device')}</span>
          <h2 id='local-device-heading'>{gpu?.name || unknown}</h2>
          <p className={styles.hardwareHint}>{t('guid.localModels.resourceHint')}</p>
          <div className={styles.memoryGrid}>
            {memory(
              t(gpu?.sharedMemory ? 'guid.localModels.sharedMemory' : 'guid.localModels.vram'),
              gpu?.totalMemoryBytes,
              gpu?.freeMemoryBytes
            )}
            {!gpu?.sharedMemory &&
              memory(t('guid.localModels.ram'), device.totalMemoryBytes, device.freeMemoryBytes, true)}
          </div>
        </div>
        <dl className={styles.specs}>
          <dt>{t('guid.localModels.cpu')}</dt>
          <dd>{device.cpu || unknown}</dd>
          <dt>{t('guid.localModels.system')}</dt>
          <dd>{[device.os, device.osRelease, device.arch].filter(Boolean).join(' · ') || unknown}</dd>
          <dt>{t('guid.localModels.driver')}</dt>
          <dd>{gpu?.driver || unknown}</dd>
          <dt>{t('guid.localModels.disk')}</dt>
          <dd>{available(device.disk?.freeBytes)}</dd>
          <dt title={t('guid.localModels.newFilesOnly')}>{t('guid.localModels.newInstallLocation')}</dt>
          <dd className={styles.directory}>
            <span title={device.installDirectory}>{device.installDirectory}</span>
            <Button
              type='text'
              size='mini'
              icon={<FolderOpen size={16} />}
              aria-label={t('guid.localModels.changeDirectory')}
              onClick={onDirectory}
            >
              {t('guid.localModels.changeDirectory')}
            </Button>
          </dd>
        </dl>
      </div>
      <div className={styles.hardwareFooter}>
        <Collapse className={styles.environment} bordered={false}>
          <Collapse.Item name='environment' header={t('guid.localModels.environment')}>
            <p className={styles.secondary}>{t('guid.localModels.environmentHint')}</p>
            {environments.map((environment) => (
              <dl className={styles.environmentRow} key={environment.root}>
                <dt>{t('guid.localModels.directory')}</dt>
                <dd>{environment.root}</dd>
                <dt>{t('guid.localModels.python')}</dt>
                <dd>{environment.python}</dd>
              </dl>
            ))}
            {device.gpus.length > 1 &&
              device.gpus.map((item, index) => (
                <p key={`${item.name}:${index}`}>
                  {item.name} · {bytes(item.totalMemoryBytes)}
                </p>
              ))}
          </Collapse.Item>
        </Collapse>
        <div className={styles.checked}>
          <span>
            {t('guid.localModels.checkedAt', {
              time: Number.isNaN(checked.getTime())
                ? unknown
                : checked.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }),
            })}
          </span>
          <Button size='small' type='text' loading={refreshing} icon={<Refresh size={14} />} onClick={onRefresh}>
            {t('guid.localModels.refresh')}
          </Button>
        </div>
      </div>
    </section>
  );
}
