import { Button } from '@arco-design/web-react';
import { ArrowRightUp, Picture, Video, Play, Pause } from '@icon-park/react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContentCatalog, OfficialEntry, OfficialTemplate } from '@/common/contentCatalog/schema';
import { localize, resolveEntryAction, CONTENT_CAPABILITIES } from '@/common/contentCatalog/policy';
import { contentAssetUrl } from '@/common/contentCatalog/bridge';
import styles from '../index.module.css';

type CreationTemplateCardProps = {
  template: OfficialEntry;
  catalog: ContentCatalog;
  onDetails: (entry: OfficialEntry) => void;
  onUseTemplate: (prompt: string, template: OfficialTemplate) => void;
  style?: React.CSSProperties;
};

const CreationTemplateCard: React.FC<CreationTemplateCardProps> = ({
  template,
  catalog,
  onDetails,
  onUseTemplate,
  style,
}) => {
  const { t, i18n } = useTranslation();
  const [previewFailed, setPreviewFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const play = () => {
    void videoRef.current?.play()?.catch(() => {});
  };
  const pause = () => {
    videoRef.current?.pause();
  };
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) video.pause();
    });
    observer.observe(video);
    return () => observer.disconnect();
  }, []);
  const title = localize(template.title, i18n.language, catalog.defaultLocale);
  const authoredPrompt =
    template.entryType === 'template'
      ? localize(template.prompt, i18n.language, catalog.defaultLocale)
      : localize(template.description, i18n.language, catalog.defaultLocale);
  const requiresReference = template.entryType === 'template' && template.requiresReference;
  const prompt = requiresReference
    ? t('guid.templateReferencePrompt', {
        ratio: template.ratio,
        prompt: authoredPrompt,
        interpolation: { escapeValue: false },
      })
    : authoredPrompt;
  const action = resolveEntryAction(template, catalog.entries, {
    version: __APP_VERSION__,
    capabilities: CONTENT_CAPABILITIES,
  });
  const cover = contentAssetUrl(catalog.releaseSequence, template.cover);

  return (
    <article
      className={styles.creationTemplate}
      aria-label={title}
      style={style}
      onMouseEnter={play}
      onMouseLeave={pause}
    >
      <div className={styles.creationTemplateArtwork} style={{ aspectRatio: template.ratio.replace(':', ' / ') }}>
        {previewFailed ? (
          <div className={styles.creationTemplateUnavailable}>
            <Picture theme='outline' size='28' />
            <span>{t('guid.templatePreviewUnavailable')}</span>
          </div>
        ) : template.kind === 'video' ? (
          <video
            ref={videoRef}
            className={styles.creationTemplateMedia}
            aria-label={title}
            src={template.media ? contentAssetUrl(catalog.releaseSequence, template.media) : undefined}
            poster={cover}
            muted
            loop
            playsInline
            preload='none'
            onError={() => setPreviewFailed(true)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        ) : (
          <img
            className={styles.creationTemplateMedia}
            src={cover}
            alt={title}
            loading='lazy'
            decoding='async'
            onError={() => setPreviewFailed(true)}
          />
        )}
        <span className={styles.creationTemplateBadge}>
          {template.kind === 'video' ? <Video theme='outline' size='12' /> : <Picture theme='outline' size='12' />}
          {t(`guid.templateFilters.${template.kind}`)}
          {requiresReference && (
            <>
              · <span title={t('guid.templateReferenceHint')}>{t('guid.templateReferenceRequired')}</span>
            </>
          )}
          {template.kind === 'video' && <span>0:{String(template.duration).padStart(2, '0')}</span>}
        </span>
        {template.kind === 'video' && !previewFailed && (
          <Button
            type='text'
            shape='circle'
            className={styles.creationTemplatePlay}
            aria-label={t(playing ? 'guid.templatePause' : 'guid.templatePlay', { title })}
            icon={playing ? <Pause size='16' /> : <Play size='16' />}
            onClick={() => (playing ? pause() : play())}
          />
        )}
      </div>
      <div className={styles.creationTemplateDetails}>
        <div className='flex items-center justify-between gap-8px'>
          <h3 className='m-0 text-14px font-medium text-t-primary truncate' title={title}>
            {title}
          </h3>
          <span className='text-11px text-t-secondary shrink-0'>{template.ratio}</span>
        </div>
        <p className={styles.creationTemplatePrompt} title={prompt}>
          {prompt}
        </p>
        <Button
          type='secondary'
          long
          size='small'
          disabled={action.primary === 'requires-client-update'}
          onClick={() =>
            template.entryType === 'showcase'
              ? onDetails(template)
              : action.template && onUseTemplate(prompt, action.template)
          }
        >
          {t(
            action.primary === 'requires-client-update'
              ? 'update.content.requiresClientUpdate'
              : template.entryType === 'showcase'
                ? 'update.content.viewWork'
                : 'guid.templateUse'
          )}
          <ArrowRightUp theme='outline' size='14' className='ms-4px' />
        </Button>
      </div>
    </article>
  );
};

export default CreationTemplateCard;
