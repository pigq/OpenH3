import React from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalModelRecommendation } from '@/common/chat/document/creation/workflows/localModels';
import { modelPrecisionGuide } from './modelCenterView';
import styles from './LocalModels.module.css';

export default function ModelVariantGuide({ model }: { model: LocalModelRecommendation }) {
  const { t } = useTranslation();
  const guide = modelPrecisionGuide(model);
  if (!guide) return null;
  return (
    <p className={styles.variantGuide}>
      <strong>{guide.label}</strong>
      {' · '}
      {t(`guid.localModels.precisionGuide.${guide.kind}`)}
    </p>
  );
}
