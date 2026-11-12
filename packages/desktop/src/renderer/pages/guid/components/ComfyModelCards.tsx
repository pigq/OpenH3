import type { ContentCatalog } from '@/common/contentCatalog/schema';
import { localize, supportsEntry, CONTENT_CAPABILITIES } from '@/common/contentCatalog/policy';
import { contentAssetUrl } from '@/common/contentCatalog/bridge';
import React, { useEffect, useRef, useState } from 'react';
import { Button, Collapse, Modal, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { Download, Movie, Picture, Play, Pause } from '@icon-park/react';
import {
  comfyFamilySchema,
  type ComfyFamily,
  type ComfyInventory,
  type ComfyProfile,
} from '@/common/chat/document/creation/comfy';
import { workflowTaskSchema } from '@/common/chat/document/creation/workflows/contracts';
import { comfyWorkflowStatus, groupComfyModels } from '@/common/chat/document/creation/workflows/identity';
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

const previewAssets: Partial<
  Record<ComfyFamily, { video?: string; poster: string; official?: { publisher: string; url: string; model: string } }>
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
  workflowPreparations?: ComfyInventory['workflowPreparations'];
  selectedProfileId?: string;
  loading?: boolean;
  unavailable?: boolean;
  incomplete?: boolean;
  onAction: (intent: ComfyDraftIntent) => void;
  onUseProfile: (profile: ComfyProfile) => void;
};

function ModelPreview({
  family,
  name,
  kind,
  coverUrl,
  children,
}: {
  family: ComfyFamily;
  name: string;
  kind: 'image' | 'video';
  coverUrl?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const assets = previewAssets[family];
  // Catalog covers can update image cards; video cards retain their bundled model sample.
  const isVideo = Boolean(assets?.video);
  const play = () => {
    const video = videoRef.current;
    if (video) void video.play().catch(() => setPlaying(false));
  };
  const pause = () => videoRef.current?.pause();

  useEffect(() => {
    setPlaying(false);
    const video = videoRef.current;
    if (!video) return;
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
  }, [failed, isVideo, assets?.video]);

  return (
    <div className={styles.familyCover} onMouseEnter={play} onMouseLeave={pause}>
      {!assets && !coverUrl ? (
        <div className='flex h-full items-center justify-center text-t-tertiary' aria-hidden='true'>
          {kind === 'video' ? <Movie size={64} /> : <Picture size={64} />}
        </div>
      ) : failed || !isVideo ? (
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
      <div className={styles.familyBody}>
        {children}
        {(!coverUrl || isVideo) && assets?.official ? (
          <div className={styles.previewAttribution}>
            <a
              href={assets.official.url}
              target='_blank'
              rel='noreferrer'
              title={t('guid.comfy.preview.sampleVersion', { version: assets.official.model })}
            >
              {family === 'fasth3-omni'
                ? t('guid.comfy.preview.officialSample')
                : t('guid.comfy.preview.officialImageSample', { publisher: assets.official.publisher })}
            </a>
          </div>
        ) : (
          assets &&
          (!coverUrl || isVideo) && <span className={styles.previewBadge}>{t('guid.comfy.preview.projectDemo')}</span>
        )}
      </div>
      {assets?.video && !failed && (
        <Button
          type='text'
          shape='circle'
          className={styles.previewPlay}
          aria-label={t(playing ? 'guid.comfy.preview.pause' : 'guid.comfy.preview.play')}
          aria-pressed={playing}
          icon={playing ? <Pause size='16' /> : <Play size='16' />}
          onClick={() => (playing ? pause() : play())}
        />
      )}
    </div>
  );
}

export default function ComfyModelCards({
  catalog,
  profiles,
  workflowPreparations = [],
  selectedProfileId,
  loading,
  unavailable,
  incomplete,
  onAction,
  onUseProfile,
}: Props) {
  const { t, i18n } = useTranslation();
  const [details, setDetails] = useState<string>();
  const [displayed, setDisplayed] = useState<Record<string, string>>({});
  const customModels = [
    ...new Map(
      profiles
        .filter((profile) => !comfyFamilySchema.safeParse(profile.family).success)
        .map((profile) => [profile.family, { family: profile.family, name: profile.name, kind: profile.kind }])
    ).values(),
  ];
  const cards = [...COMFY_FAMILIES, ...customModels].map((base) => {
    const official = catalog?.models.find((model) => model.family === base.family);
    return { official, card: official ? { ...base, ...official } : base };
  });
  return (
    <div className={styles.familySection}>
      <div className={styles.familyHeading}>{t('guid.comfy.title')}</div>
      <div className={styles.familyGrid}>
        {cards.map(({ official, card }) => {
          const { family, name, kind } = card;
          const builtin = comfyFamilySchema.safeParse(family);
          const description =
            official && catalog
              ? localize(official.description, i18n.language, catalog.defaultLocale)
              : builtin.success
                ? t(`guid.comfy.families.${builtin.data}`)
                : t(`guid.creation.local${kind === 'video' ? 'Video' : 'Image'}`);
          const compatible =
            !official || supportsEntry(official, { version: __APP_VERSION__, capabilities: CONTENT_CAPABILITIES });
          const groups = groupComfyModels(profiles.filter((profile) => profile.family === family));
          const versions = groups.map(
            (group) =>
              group.profiles.find((item) => item.id === selectedProfileId) ??
              group.profiles.find((item) => comfyWorkflowStatus(item) === 'verified') ??
              group.profiles[0]
          );
          const profile =
            versions.find((item) => item.id === displayed[family]) ??
            versions.find((item) => item.id === selectedProfileId) ??
            versions.find((item) => item.state === 'verified') ??
            versions[0];
          const group = groups.find((item) => item.profiles.includes(profile));
          const routes = group?.profiles ?? [];
          const pendingRoutes = workflowPreparations.filter((route) => route.modelSetId === group?.modelSetId);
          const selectedModel = routes.some((route) => route.id === selectedProfileId);
          const usableProfile = routes.find((route) => comfyWorkflowStatus(route) === 'verified') ?? profile;
          const state = loading
            ? 'checking'
            : unavailable
              ? 'unavailable'
              : routes.some((route) => comfyWorkflowStatus(route) === 'verified')
                ? 'verified'
                : profile
                  ? 'installed'
                  : incomplete
                    ? 'unavailable'
                    : 'not-installed';
          const action = (intent: ComfyDraftIntent['intent'], target?: ComfyProfile) => {
            onAction({ family, intent, profileId: target?.id, ...(!builtin.success ? { name, kind } : {}) });
            setDetails(undefined);
          };
          return (
            <section key={family} role='region' aria-label={name} className={styles.familyCard}>
              <ModelPreview
                key={`${catalog?.releaseSequence ?? 0}:${official?.cover ?? family}`}
                family={family}
                name={name}
                kind={kind}
                coverUrl={
                  official && catalog && catalog.releaseSequence > 0
                    ? contentAssetUrl(catalog.releaseSequence, official.cover)
                    : undefined
                }
              >
                <div className={styles.familyTop}>
                  <span className={styles.familyIcon}>
                    {kind === 'video' ? <Movie size={17} /> : <Picture size={17} />}
                  </span>
                  <div className={styles.familySummary}>
                    <div className={styles.familyName}>{name}</div>
                    <div className={styles.familyDescription} title={description}>
                      {description}
                    </div>
                  </div>
                </div>
                <div className={styles.familyFooter}>
                  <span
                    className={`${styles.profileStatus} ${state === 'verified' ? styles.verified : styles.state}`}
                    role='status'
                  >
                    {t(`guid.creation.states.${state}`)}
                  </span>
                  <div className={styles.familyActions}>
                    {profile && (
                      <Button size='small' type='text' onClick={() => setDetails(family)}>
                        {t('guid.comfy.workflows.details')}
                      </Button>
                    )}
                    {!compatible ? (
                      <span>{t('update.content.requiresClientUpdate')}</span>
                    ) : usableProfile ? (
                      <Button
                        size='small'
                        type={selectedModel ? 'secondary' : 'primary'}
                        aria-pressed={selectedModel}
                        disabled={loading || unavailable}
                        onClick={() => onUseProfile(usableProfile)}
                      >
                        {t(selectedModel ? 'guid.comfy.selected' : 'guid.comfy.use')}
                      </Button>
                    ) : (
                      <Button
                        size='small'
                        type='primary'
                        icon={<Download size='14' />}
                        onClick={() => action('install')}
                      >
                        {t('guid.comfy.actions.install')}
                      </Button>
                    )}
                  </div>
                </div>
              </ModelPreview>
              <Modal visible={details === family} title={name} footer={null} onCancel={() => setDetails(undefined)}>
                {details === family && profile && (
                  <div className='flex flex-col gap-12px text-12px select-text break-words'>
                    {versions.length > 1 ? (
                      <Select
                        aria-label={t('guid.comfy.version', { family: name })}
                        value={profile.id}
                        onChange={(id: string) => setDisplayed((previous) => ({ ...previous, [family]: id }))}
                        options={versions.map((version) => ({
                          value: version.id,
                          label: `${version.name} · ${version.version} · ${version.quantization}`,
                        }))}
                      />
                    ) : (
                      <span>
                        {profile.version} · {profile.quantization}
                      </span>
                    )}
                    <Collapse>
                      {routes.map((route) => (
                        <Collapse.Item
                          key={route.id}
                          name={route.id}
                          header={
                            <span>
                              {(route.workflowMetadata?.tasks ?? route.capabilities ?? [])
                                .map((task) => {
                                  const known = workflowTaskSchema.safeParse(task);
                                  return known.success ? t(`guid.comfy.workflows.tasks.${known.data}`) : task;
                                })
                                .join(' · ')}{' '}
                              · {t(`guid.comfy.workflows.states.${comfyWorkflowStatus(route)}`)}
                            </span>
                          }
                        >
                          <div className='flex flex-col gap-8px break-all'>
                            <strong>{route.name}</strong>
                            <span>
                              {t('guid.comfy.workflows.environment')}: {route.environment?.root}
                            </span>
                            <span>{route.environment?.python}</span>
                            <span>{route.environment?.baseUrl}</span>
                            <span>
                              {t('guid.comfy.workflows.workflow')}: {route.workflowPath}
                            </span>
                            {route.validation?.error && <span role='alert'>{route.validation.error}</span>}
                            <Button size='small' onClick={() => action('repair', route)}>
                              {t('guid.comfy.actions.repair')}
                            </Button>
                          </div>
                        </Collapse.Item>
                      ))}
                      {pendingRoutes.map((route) => (
                        <Collapse.Item
                          key={`${route.profileId}:${route.workflowId}`}
                          name={`pending:${route.profileId}:${route.workflowId}`}
                          header={`${route.tasks
                            .map((task) => {
                              const known = workflowTaskSchema.safeParse(task);
                              return known.success ? t(`guid.comfy.workflows.tasks.${known.data}`) : task;
                            })
                            .join(' · ')} · ${t('guid.comfy.workflows.states.needs-preparation')}`}
                        >
                          <div className='flex flex-col gap-8px break-all'>
                            <strong>{route.workflowId}</strong>
                            <span>{route.reason}</span>
                            <span>
                              {t('guid.comfy.operation.download')}:{' '}
                              {new Intl.NumberFormat(i18n.language, {
                                style: 'unit',
                                unit: 'megabyte',
                                maximumFractionDigits: 1,
                              }).format(route.additionalBytes / 1_000_000)}
                            </span>
                          </div>
                        </Collapse.Item>
                      ))}
                    </Collapse>
                    <div className='flex gap-8px'>
                      <Button size='small' onClick={() => action('repair', profile)}>
                        {t('guid.comfy.actions.repair')}
                      </Button>
                      <Button size='small' type='text' onClick={() => action('install-other')}>
                        {t('guid.comfy.actions.install-other')}
                      </Button>
                    </div>
                  </div>
                )}
              </Modal>
            </section>
          );
        })}
      </div>
      <p className={styles.familyHint}>{t('guid.comfy.draftHint')}</p>
    </div>
  );
}
