import React from 'react';
import { Button } from '@arco-design/web-react';
import { ArrowRight, Download } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { LocalModelRecommendation } from '@/common/chat/document/creation/workflows/localModels';
import { formatBytes, modelAction, modelDescription, verifiedPreviewArtifact } from './modelCenterView';
import ModelPreview from './ModelPreview';
import ModelVariantGuide from './ModelVariantGuide';
import styles from './LocalModels.module.css';

export default function ModelRow({
  model,
  featured,
  busy,
  disabled,
  onAction,
  onDetails,
}: {
  model: LocalModelRecommendation;
  featured?: boolean;
  busy: boolean;
  disabled?: boolean;
  onAction: (model: LocalModelRecommendation) => void;
  onDetails: (model: LocalModelRecommendation) => void;
}) {
  const { t, i18n } = useTranslation();
  const action = modelAction(model);
  const bytes = (value?: number) => formatBytes(value, i18n.language, t('guid.localModels.unknown'));
  return (
    <article className={`${styles.modelRow} ${featured ? styles.featured : ''}`} aria-label={model.name}>
      <ModelPreview
        family={model.family}
        name={model.name}
        kind={model.kind}
        artifact={verifiedPreviewArtifact(model)}
      />
      <div className={styles.modelBody}>
        <div className={styles.modelHeading}>
          <h3>{model.name}</h3>
        </div>
        <div className={styles.modelMeta}>
          {model.purposes.map((purpose) => t(`guid.localModels.purpose.${purpose}`)).join(' · ')}
        </div>
        <p className={styles.reason}>{t(`guid.localModels.descriptions.${modelDescription(model)}`)}</p>
        <ModelVariantGuide model={model} />
        <div className={styles.modelFacts}>
          {!model.installed && <span>{t('guid.localModels.downloadSize', { value: bytes(model.downloadBytes) })}</span>}
          {model.reusedBytes > 0 && (
            <span>{t('guid.localModels.reusedSize', { value: bytes(model.reusedBytes) })}</span>
          )}
        </div>
      </div>
      <div className={styles.modelActions}>
        <Button
          type='primary'
          loading={busy}
          disabled={disabled}
          icon={action === 'install' ? <Download size={15} /> : <ArrowRight size={15} />}
          onClick={() => onAction(model)}
        >
          {t(`guid.localModels.actions.${action}`)}
        </Button>
        <Button type='text' onClick={() => onDetails(model)}>
          {t('guid.localModels.details')}
        </Button>
      </div>
    </article>
  );
}
