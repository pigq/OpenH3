import type { ContentCatalog } from '@/common/contentCatalog/schema';
import { localize, supportsEntry, CONTENT_CAPABILITIES } from '@/common/contentCatalog/policy';
import { contentAssetUrl } from '@/common/contentCatalog/bridge';
import React, { useEffect, useRef, useState } from 'react';
import { Button, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { Movie, Picture, Play, Pause } from '@icon-park/react';
import type { ComfyFamily, ComfyProfile } from '@/common/chat/document/creation/comfy';
import { COMFY_FAMILIES, type ComfyDraftIntent } from '../Creation/comfyDraft';
import styles from '../Creation/creation.module.css';
// Maintainer-provided real H3/ComfyUI result demo (source: docs/assets/openh3-demo.gif).
import h3Video from '@/renderer/assets/creation/model-previews/h3-openh3-demo.mp4?url';
import h3Poster from '@/renderer/assets/creation/model-previews/h3-openh3-demo.webp?url';
// Official Nuva Lab sample. Sample media/model version is shown separately from the installed profile version below.
// Source: https://nuvalab.ai/fasth3/ (sample clip: https://nuvalab.ai/blog/fasth3-omni-open-weights-release/samples/pink-suit-lamb-5s.mp4)
import omniVideo from '@/renderer/assets/creation/model-previews/fasth3-omni-official.mp4?url';
import omniPoster from '@/renderer/assets/creation/model-previews/fasth3-omni-official.webp?url';
import qwenCover from '@/renderer/assets/creation/model-previews/qwen-edit-2509-official.webp?url';
import zImageCover from '@/renderer/assets/creation/model-previews/z-image-official.webp?url';
import fluxCover from '@/renderer/assets/creation/model-previews/flux-3-image-klein-official.webp?url';
import mossBaseCover from '@/renderer/assets/creation/model-previews/moss/moss-image-base-official.webp?url';
import mossSftCover from '@/renderer/assets/creation/model-previews/moss/moss-image-sft-official.webp?url';
import kreaCover from '@/renderer/assets/creation/model-previews/krea2-official.webp?url';

const previewAssets: Record<
  ComfyFamily,
  { video?: string; poster: string; official?: { publisher: string; url: string; model: string } }
> = {
  h3: { video: h3Video, poster: h3Poster },
  'fasth3-omni': {
    video: omniVideo,
    poster: omniPoster,
    official: { publisher: 'Nuva Lab', url: 'https://nuvalab.ai/fasth3/', model: 'FastH3-Omni-8-Step-V1' },
  },
  'qwen-edit': {
    poster: qwenCover,
    official: {
      publisher: 'Qwen',
      url: 'https://github.com/QwenLM/Qwen-Image/blob/6b5e1f5cec987d404be5ac6657db3b9aacb56a89/Qwen-Image-Edit-2509.md',
      model: 'Qwen-Image-Edit-2509',
    },
  },
  'z-image': {
    poster: zImageCover,
    official: {
      publisher: 'Tongyi-MAI',
      url: 'https://github.com/Tongyi-MAI/Z-Image/blob/26f23eda626ffadda020b04ff79488e1d72004cd/README.md#%EF%B8%8F-showcase',
      model: 'Z-Image-Turbo',
    },
  },
  'flux-3-image-klein': {
    poster: fluxCover,
    official: {
      publisher: 'Comfy Org / Black Forest Labs',
      url: 'https://github.com/Comfy-Org/workflow_templates/blob/447747bf37b7e2f6d5fab3f15288e03bf889b82f/templates/image_flux3_klein_distilled_t2i.json',
      model: 'FLUX 3 Image Klein (distilled)',
    },
  },
  'moss-image-base': {
    poster: mossBaseCover,
    official: {
      publisher: 'Comfy Org / OpenMOSS',
      url: 'https://github.com/Comfy-Org/workflow_templates/blob/447747bf37b7e2f6d5fab3f15288e03bf889b82f/templates/image_moss_image_base_t2i.json',
      model: 'MOSS-Image-Base',
    },
  },
  'moss-image-sft': {
    poster: mossSftCover,
    official: {
      publisher: 'OpenMOSS',
      url: 'https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT',
      model: 'MOSS-Image-SFT',
    },
  },
  krea2: {
    poster: kreaCover,
    official: {
      publisher: 'Comfy Org / Krea',
      url: 'https://github.com/Comfy-Org/workflow_templates/blob/447747bf37b7e2f6d5fab3f15288e03bf889b82f/templates/image_krea2_turbo_t2i.json',
      model: 'Krea 2 Turbo',
    },
  },
};

type Props = {
  catalog?: ContentCatalog;
  profiles: ComfyProfile[];
  selectedProfileId?: string;
  loading?: boolean;
  unavailable?: boolean;
  onAction: (intent: ComfyDraftIntent) => void;
  onUseProfile: (profile: ComfyProfile) => void;
};

function ModelPreview({
  family,
  name,
  runtimeVersion,
  coverUrl,
}: {
  family: ComfyFamily;
  name: string;
  runtimeVersion?: string;
  coverUrl?: string;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [requestedVideo, setRequestedVideo] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const assets = previewAssets[family];
  const isVideo = Boolean(assets?.video) && (!coverUrl || requestedVideo);
  const sampleLabel = t(assets?.official ? 'guid.comfy.preview.officialSample' : 'guid.comfy.preview.projectDemo');
  const play = () => {
    const video = videoRef.current;
    if (video) void video.play().catch(() => setPlaying(false));
  };
  const pause = () => videoRef.current?.pause();

  useEffect(() => {
    setPlaying(false);
    const video = videoRef.current;
    if (!video) return;
    if (coverUrl && requestedVideo) void video.play().catch(() => setPlaying(false));
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) video.pause();
    });
    observer.observe(video);
    const onVisibilityChange = () => {
      if (document.hidden) video.pause();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (!video.paused) video.pause();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [failed, isVideo, assets?.video, coverUrl, requestedVideo]);

  return (
    <div className={styles.familyCover} onMouseEnter={play} onMouseLeave={pause}>
      {failed || !isVideo ? (
        <img
          src={isVideo ? assets?.poster : (coverUrl ?? assets?.poster)}
          alt={t(isVideo ? 'guid.comfy.preview.poster' : 'guid.comfy.preview.image', { family: name })}
          loading='lazy'
          decoding='async'
        />
      ) : (
        <video
          ref={videoRef}
          src={assets?.video}
          poster={assets?.poster}
          aria-label={t('guid.comfy.preview.video', { family: name })}
          muted
          loop
          playsInline
          preload='none'
          onError={() => setFailed(true)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      )}
      {(!coverUrl || isVideo) && assets?.official ? (
        <div className={styles.previewAttribution}>
          <a href={assets.official.url} target='_blank' rel='noreferrer'>
            {family === 'fasth3-omni'
              ? t('guid.comfy.preview.officialSample')
              : t('guid.comfy.preview.officialImageSample', { publisher: assets.official.publisher })}
          </a>
          <span>{t('guid.comfy.preview.sampleVersion', { version: assets.official.model })}</span>
          {isVideo && (
            <span>
              {t('guid.comfy.preview.runtimeVersion', {
                version: runtimeVersion || t('guid.comfy.preview.notInstalled'),
              })}
            </span>
          )}
        </div>
      ) : (
        (!coverUrl || isVideo) && <span className={styles.previewBadge}>{t('guid.comfy.preview.projectDemo')}</span>
      )}
      {assets?.video && !failed && (
        <Button
          type='text'
          shape='circle'
          className={styles.previewPlay}
          aria-label={
            coverUrl && !requestedVideo
              ? `${t('guid.comfy.preview.play')}: ${sampleLabel}`
              : t(playing ? 'guid.comfy.preview.pause' : 'guid.comfy.preview.play')
          }
          title={coverUrl && !requestedVideo ? sampleLabel : undefined}
          aria-pressed={playing}
          icon={playing ? <Pause size='16' /> : <Play size='16' />}
          onClick={() => (coverUrl && !requestedVideo ? setRequestedVideo(true) : playing ? pause() : play())}
        />
      )}
    </div>
  );
}

export default function ComfyModelCards({
  catalog,
  profiles,
  selectedProfileId,
  loading,
  unavailable,
  onAction,
  onUseProfile,
}: Props) {
  const { t, i18n } = useTranslation();
  const [displayed, setDisplayed] = useState<Partial<Record<ComfyFamily, string>>>({});
  const cards = COMFY_FAMILIES.map((base) => {
    const official = catalog?.models.find((model) => model.family === base.family);
    return {
      base,
      official,
      card: official ? { ...base, ...official } : base,
    };
  });
  return (
    <div className={styles.familySection}>
      <div className={styles.familyHeading}>{t('guid.comfy.title')}</div>
      <div className={styles.familyGrid}>
        {cards.map(({ official, card }) => {
          const { family, name, kind } = card;
          const compatible =
            !official || supportsEntry(official, { version: __APP_VERSION__, capabilities: CONTENT_CAPABILITIES });
          const versions = profiles.filter((profile) => profile.family === family);
          const profile =
            versions.find((item) => item.id === displayed[family as ComfyFamily]) ??
            versions.find((item) => item.id === selectedProfileId) ??
            versions.find((item) => item.state === 'verified') ??
            versions[0];
          const state = loading ? 'checking' : unavailable ? 'unavailable' : (profile?.state ?? 'not-installed');
          return (
            <section key={official?.id ?? family} role='region' aria-label={name} className={styles.familyCard}>
              <ModelPreview
                key={`${catalog?.releaseSequence ?? 0}:${official?.cover ?? family}`}
                family={family as ComfyFamily}
                name={name}
                runtimeVersion={profile?.version}
                coverUrl={
                  official && catalog && catalog.releaseSequence > 0
                    ? contentAssetUrl(catalog.releaseSequence, official.cover)
                    : undefined
                }
              />
              <div className={styles.familyTop}>
                <span className={styles.familyIcon}>
                  {kind === 'video' ? <Movie size={20} /> : <Picture size={20} />}
                </span>
                <div>
                  <div className={styles.familyName}>{name}</div>
                  <div className={styles.familyDescription}>
                    {official && catalog
                      ? localize(official.description, i18n.language, catalog.defaultLocale)
                      : t(`guid.comfy.families.${family as ComfyFamily}`)}
                  </div>
                </div>
              </div>
              <div className={styles.profileDetails}>
                {versions.length > 1 ? (
                  <Select
                    className={styles.profileSelect}
                    aria-label={t('guid.comfy.version', { family: name })}
                    size='small'
                    value={profile?.id}
                    onChange={(id: string) => setDisplayed((previous) => ({ ...previous, [family]: id }))}
                    options={versions.map((version) => ({
                      value: version.id,
                      label: `${version.name} · ${version.version} · ${version.quantization} · ${t(`guid.creation.states.${version.state}`)}`,
                    }))}
                  />
                ) : profile ? (
                  <span className={styles.profileName}>
                    {profile.name} · {profile.version} · {profile.quantization}
                  </span>
                ) : (
                  <span>{t('guid.comfy.noProfile')}</span>
                )}
                <span className={state === 'verified' ? styles.verified : styles.state} role='status'>
                  {t(`guid.creation.states.${state}`)}
                </span>
              </div>
              {profile?.validation?.error && <div className={styles.profileError}>{profile.validation.error}</div>}
              <div className={styles.familyActions}>
                {!compatible && <span>{t('update.content.requiresClientUpdate')}</span>}
                {compatible && (
                  <>
                    {profile?.state === 'verified' && (
                      <Button
                        size='small'
                        type={selectedProfileId === profile.id ? 'secondary' : 'primary'}
                        aria-pressed={selectedProfileId === profile.id}
                        disabled={loading || unavailable}
                        onClick={() => onUseProfile(profile)}
                      >
                        {t(selectedProfileId === profile.id ? 'guid.comfy.selected' : 'guid.comfy.use')}
                      </Button>
                    )}
                    <Button
                      size='small'
                      type={profile ? 'text' : 'primary'}
                      onClick={() =>
                        onAction({
                          family: family as ComfyFamily,
                          intent: profile ? 'repair' : 'install',
                          profileId: profile?.id,
                        })
                      }
                    >
                      {t(profile ? 'guid.comfy.actions.repair' : 'guid.comfy.actions.install')}
                    </Button>
                    {profile && (
                      <Button
                        size='small'
                        type='text'
                        onClick={() => onAction({ family: family as ComfyFamily, intent: 'install-other' })}
                      >
                        {t('guid.comfy.actions.install-other')}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <p className={styles.familyHint}>{t('guid.comfy.draftHint')}</p>
    </div>
  );
}
