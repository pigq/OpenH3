import React, { useEffect, useState } from 'react';
import { Button, Modal } from '@arco-design/web-react';
import { Movie, Picture, Play, ZoomIn } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import h3Video from '@/renderer/assets/creation/model-previews/h3-openh3-demo.mp4?url';
import h3Poster from '@/renderer/assets/creation/model-previews/h3-openh3-demo.webp?url';
import omniVideo from '@/renderer/assets/creation/model-previews/fasth3-omni-official.mp4?url';
import omniPoster from '@/renderer/assets/creation/model-previews/fasth3-omni-official.webp?url';
import qwenCover from '@/renderer/assets/creation/model-previews/qwen-edit-2509-official.webp?url';
import zImageCover from '@/renderer/assets/creation/model-previews/z-image-official.webp?url';
import fluxCover from '@/renderer/assets/creation/model-previews/flux-3-image-klein-official.webp?url';
import mossBaseCover from '@/renderer/assets/creation/model-previews/moss/moss-image-base-official.webp?url';
import mossSftCover from '@/renderer/assets/creation/model-previews/moss/moss-image-sft-official.webp?url';
import kreaCover from '@/renderer/assets/creation/model-previews/krea2-official.webp?url';
import styles from './LocalModels.module.css';

// Bundled publisher/project samples, shared with the AI creation model directory.
const assets: Record<string, { poster: string; video?: string }> = {
  h3: { poster: h3Poster, video: h3Video },
  'fasth3-omni': { poster: omniPoster, video: omniVideo },
  'qwen-edit': { poster: qwenCover },
  'z-image': { poster: zImageCover },
  'flux-3-image-klein': { poster: fluxCover },
  'moss-image-base': { poster: mossBaseCover },
  'moss-image-sft': { poster: mossSftCover },
  krea2: { poster: kreaCover },
};

export default function ModelPreview({
  family,
  name,
  kind,
  artifact,
}: {
  family: string;
  name: string;
  kind: 'image' | 'video';
  artifact?: string;
}) {
  const { t } = useTranslation();
  const sample = assets[family];
  const [open, setOpen] = useState(false);
  const [localImage, setLocalImage] = useState<{ path: string; url: string }>();
  useEffect(() => {
    if (sample || !artifact) return;
    let cancelled = false;
    // Use the existing sandboxed image IPC. Denied or missing files retain the fallback.
    void ipcBridge.fs.getImageBase64
      .invoke({ path: artifact })
      .then((url) => {
        if (!cancelled && url && /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,/i.test(url)) {
          setLocalImage({ path: artifact, url });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [artifact, sample]);
  const poster = sample?.poster ?? (localImage?.path === artifact ? localImage?.url : undefined);
  const label = t('guid.localModels.preview', { name });
  return (
    <>
      {poster ? (
        <Button type='text' className={styles.preview} aria-label={label} onClick={() => setOpen(true)}>
          <img src={poster} alt={label} loading='lazy' decoding='async' />
          <span className={styles.previewZoom} aria-hidden='true'>
            {sample?.video ? <Play size={18} /> : <ZoomIn size={16} />}
          </span>
        </Button>
      ) : (
        <div className={styles.previewFallback} aria-label={t('guid.localModels.noPreview')}>
          {kind === 'video' ? <Movie size={28} /> : <Picture size={28} />}
        </div>
      )}
      <Modal
        visible={open}
        title={label}
        footer={null}
        onCancel={() => setOpen(false)}
        style={{ width: 'min(1040px, calc(100vw - 40px))' }}
        className={styles.previewModal}
        unmountOnExit
        escToExit
      >
        {open &&
          (sample?.video ? (
            <video src={sample.video} poster={poster} controls autoPlay playsInline aria-label={label} />
          ) : (
            <img src={poster} alt={label} />
          ))}
      </Modal>
    </>
  );
}
