import React from 'react';
import { Modal, Button, Alert } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { ContentCatalog, OfficialEntry, OfficialTemplate } from '@/common/contentCatalog/schema';
import { localize, resolveEntryAction, CONTENT_CAPABILITIES } from '@/common/contentCatalog/policy';
import { contentAssetUrl } from '@/common/contentCatalog/bridge';
import { openExternalUrl } from '@/renderer/utils/platform';
export default function OfficialWorkDetails({
  entry,
  catalog,
  onClose,
  onUse,
}: {
  entry: OfficialEntry;
  catalog: ContentCatalog;
  onClose: () => void;
  onUse: (template: OfficialTemplate) => void;
}) {
  const { t, i18n } = useTranslation();
  const title = localize(entry.title, i18n.language, catalog.defaultLocale);
  const action = resolveEntryAction(entry, catalog.entries, {
    version: __APP_VERSION__,
    capabilities: CONTENT_CAPABILITIES,
  });
  return (
    <Modal
      visible
      title={title}
      onCancel={onClose}
      footer={
        action.template ? (
          <Button
            type='primary'
            onClick={() => {
              onUse(action.template!);
              onClose();
            }}
          >
            {t(entry.entryType === 'showcase' ? 'update.content.useLinkedTemplate' : 'guid.templateUse')}
          </Button>
        ) : null
      }
    >
      {entry.kind === 'video' && entry.media ? (
        <video
          className='w-full max-h-420px'
          src={contentAssetUrl(catalog.releaseSequence, entry.media)}
          poster={contentAssetUrl(catalog.releaseSequence, entry.cover)}
          controls
          playsInline
          preload='none'
        />
      ) : (
        <img
          className='w-full max-h-420px object-contain'
          src={contentAssetUrl(catalog.releaseSequence, entry.media ?? entry.cover)}
          alt={title}
        />
      )}
      <p>{localize(entry.description, i18n.language, catalog.defaultLocale)}</p>
      {entry.entryType === 'showcase' && entry.templateRef && !action.template && (
        <Alert type='info' content={t('update.content.linkUnavailable')} />
      )}
      <p>
        {entry.attribution.author} · {entry.attribution.license}
      </p>
      <Button type='text' onClick={() => void openExternalUrl(entry.attribution.sourceUrl)}>
        {t('update.content.attribution')}
      </Button>
    </Modal>
  );
}
