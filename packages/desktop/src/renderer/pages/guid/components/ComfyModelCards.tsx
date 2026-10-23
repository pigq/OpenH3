import type { ContentCatalog } from '@/common/contentCatalog/schema';
import { localize, supportsEntry, CONTENT_CAPABILITIES } from '@/common/contentCatalog/policy';
import { contentAssetUrl } from '@/common/contentCatalog/bridge';
import React, { useState } from 'react';
import { Button, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { Movie, Picture } from '@icon-park/react';
import type { ComfyFamily, ComfyProfile } from '@/common/chat/document/creation/comfy';
import { COMFY_FAMILIES, type ComfyDraftIntent } from '../Creation/comfyDraft';
import styles from '../Creation/creation.module.css';
import h3Cover from '@/renderer/assets/creation/previews/coast.webp?url';
import qwenCover from '@/renderer/assets/creation/style/women-hair-grid.webp?url';
import zImageCover from '@/renderer/assets/creation/images/landscape.webp?url';

const covers = { h3: h3Cover, 'qwen-edit': qwenCover, 'z-image': zImageCover };

type Props = {
  catalog?: ContentCatalog;
  profiles: ComfyProfile[];
  selectedProfileId?: string;
  loading?: boolean;
  unavailable?: boolean;
  onAction: (intent: ComfyDraftIntent) => void;
  onUseProfile: (profile: ComfyProfile) => void;
};

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
  return (
    <div className={styles.familySection}>
      <div className={styles.familyHeading}>{t('guid.comfy.title')}</div>
      <div className={styles.familyGrid}>
        {(catalog?.models ?? COMFY_FAMILIES).map((card) => {
          const { family, name, kind } = card;
          const official = 'cover' in card ? card : undefined;
          const known = COMFY_FAMILIES.some((item) => item.family === family);
          const compatible =
            known &&
            (!official || supportsEntry(official, { version: __APP_VERSION__, capabilities: CONTENT_CAPABILITIES }));
          const versions = profiles.filter((profile) => profile.family === family);
          const profile =
            versions.find((item) => item.id === displayed[family as ComfyFamily]) ??
            versions.find((item) => item.id === selectedProfileId) ??
            versions.find((item) => item.state === 'verified') ??
            versions[0];
          const state = loading ? 'checking' : unavailable ? 'unavailable' : (profile?.state ?? 'not-installed');
          return (
            <section key={official?.id ?? family} role='region' aria-label={name} className={styles.familyCard}>
              <div className={styles.familyCover}>
                <img
                  src={
                    official && catalog
                      ? contentAssetUrl(catalog.releaseSequence, official.cover)
                      : covers[family as ComfyFamily]
                  }
                  alt=''
                  loading='lazy'
                />
                <span>{t('guid.comfy.illustrativeCover')}</span>
              </div>
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
