import React from 'react';
import { Button, Collapse, Drawer } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { LocalModelRecommendation } from '@/common/chat/document/creation/workflows/localModels';
import { workflowTaskSchema } from '@/common/chat/document/creation/workflows/contracts';
import { formatBytes, modelAction, modelDescription } from './modelCenterView';
import styles from './LocalModels.module.css';
import ModelVariantGuide from './ModelVariantGuide';

export default function ModelDetails({
  model,
  onClose,
  onAction,
  busy,
  disabled,
}: {
  model?: LocalModelRecommendation;
  onClose: () => void;
  onAction: (model: LocalModelRecommendation) => void;
  busy: boolean;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const bytes = (value?: number) => formatBytes(value, i18n.language, t('guid.localModels.unknown'));
  const tasks = [
    ...new Set(model?.profiles.flatMap((profile) => profile.workflowMetadata?.tasks ?? profile.capabilities) ?? []),
  ].flatMap((task) => {
    const parsed = workflowTaskSchema.safeParse(task);
    return parsed.success ? [parsed.data] : [];
  });
  return (
    <Drawer
      visible={!!model}
      title={model?.name}
      width='min(540px, 100vw)'
      onCancel={onClose}
      escToExit
      footer={
        model ? (
          <Button type='primary' loading={busy} disabled={disabled} onClick={() => onAction(model)}>
            {t(`guid.localModels.actions.${modelAction(model)}`)}
          </Button>
        ) : null
      }
    >
      {model && (
        <div className={styles.details}>
          <p className={styles.modelIntroduction}>{t(`guid.localModels.descriptions.${modelDescription(model)}`)}</p>
          <ModelVariantGuide model={model} />
          <p className={styles.secondary}>{t('guid.localModels.precisionGuide.hint')}</p>
          <p className={styles.secondary}>{t('guid.localModels.agentHandlesSetup')}</p>
          {tasks.length > 0 && (
            <div className={styles.taskSummary}>
              {tasks.map((task) => (
                <span key={task}>{t(`guid.comfy.workflows.tasks.${task}`)}</span>
              ))}
            </div>
          )}
          <Collapse bordered={false}>
            <Collapse.Item name='technical' header={t('guid.localModels.technicalDetails')}>
              <dl className={styles.environmentRow}>
                <dt>{t('guid.localModels.totalSize')}</dt>
                <dd>{bytes(model.totalBytes)}</dd>
                <dt>{t('guid.localModels.download')}</dt>
                <dd>{bytes(model.downloadBytes)}</dd>
                <dt>{t('guid.localModels.reused')}</dt>
                <dd>{bytes(model.reusedBytes)}</dd>
                <dt>{t('guid.localModels.newInstallLocation')}</dt>
                <dd>{model.installContext.installDirectory}</dd>
              </dl>
              <h3>{t('guid.localModels.assessment')}</h3>
              <ul>
                {model.reasons.map((reason) => (
                  <li key={reason}>{t(`guid.localModels.reasons.${reason}`)}</li>
                ))}
              </ul>
              <p className={styles.secondary}>{t('guid.localModels.assessmentHint')}</p>
              <h3>{t('guid.localModels.versions')}</h3>
              {model.quantization && <p className={styles.secondary}>{model.quantization}</p>}
              {!model.profiles.length && <p className={styles.secondary}>{t('guid.localModels.noVersions')}</p>}
              <Collapse bordered={false}>
                {model.profiles.map((profile) => (
                  <Collapse.Item name={profile.id} key={profile.id} header={<span>{profile.name}</span>}>
                    <dl className={styles.environmentRow}>
                      <dt>{t('guid.localModels.versions')}</dt>
                      <dd>
                        {profile.version} · {profile.quantization}
                      </dd>
                      <dt>{t('guid.localModels.directory')}</dt>
                      <dd>{profile.environment.root}</dd>
                      <dt>{t('guid.localModels.python')}</dt>
                      <dd>{profile.environment.python}</dd>
                      <dt>{t('guid.localModels.workflow')}</dt>
                      <dd>{profile.workflowPath}</dd>
                    </dl>
                    <h4>{t('guid.localModels.components')}</h4>
                    {profile.components.map((component) => (
                      <div className={styles.component} key={`${component.role}:${component.path}`}>
                        <strong>{component.name}</strong>
                        <span>
                          {component.version} · {component.precision} · {bytes(component.sizeBytes)}
                        </span>
                        <code>{component.path}</code>
                      </div>
                    ))}
                    <h4>{t('guid.localModels.evidence')}</h4>
                    {profile.validation ? (
                      <div className={styles.component}>
                        <span>{new Date(profile.validation.checkedAt).toLocaleString(i18n.language)}</span>
                        {profile.validation.error && <p role='alert'>{profile.validation.error}</p>}
                        {profile.validation.artifacts?.map((path) => (
                          <code key={path}>{path}</code>
                        ))}
                      </div>
                    ) : (
                      <p className={styles.secondary}>{t('guid.localModels.noEvidence')}</p>
                    )}
                  </Collapse.Item>
                ))}
              </Collapse>
            </Collapse.Item>
          </Collapse>
        </div>
      )}
    </Drawer>
  );
}
